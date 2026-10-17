import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  mediaAssetSchema,
  registrySchema,
  type MediaAsset,
  type MediaJob,
  type SourceFingerprint,
} from '../shared/media.js';
import { framesToSeconds } from '../shared/timing.js';
import { MOTION_ANALYSIS_VERSION, motionAnalysisSchema, type MotionAnalysis } from '../shared/motion-analysis.js';
import { forEachSerial } from '../shared/serial.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import {
  assertCacheOutsideSource,
  assertNoSymlinks,
  assertSourceIdentity,
  discoverVideos,
  fingerprintFile,
  hashFile,
  verifyMovedOriginal,
} from './files.js';
import { JobQueue, type JobContext } from './jobs.js';
import { analyseProxy, readTelemetry } from './motion.js';
import type { RelinkCandidate } from './relink.js';
import { NATIVE_THREADS } from './native-threads.js';
import { probeVideo } from './probe.js';
import { runProcess } from './process.js';
import { atomicWrite, ensurePrivateDirectory, SerialWriter } from './storage.js';

export const PROXY_PROFILE = 'h264-720p-bt709-gop15-v1' as const;
export const FRAME_SAMPLE_MAE_LIMIT = 6;
/** Registry v2; the earlier library.json is no longer read. */
export const VIDEO_REGISTRY = 'videos.json';

export interface ImportForEditingResult {
  assets: MediaAsset[];
  errors: { path: string; message: string }[];
  ignored: number;
  added: number;
  existing: number;
  jobs: MediaJob[];
  queueErrors: { mediaId: string; message: string }[];
}
export interface AddForEditingResult {
  asset: MediaAsset;
  job: MediaJob | null;
}
interface Registration {
  asset: MediaAsset;
  added: boolean;
}

/** Registration succeeded even though admission to the preparation queue failed. */
export class MediaQueueError extends ServiceError {
  constructor(
    readonly asset: MediaAsset,
    cause: unknown,
  ) {
    super(
      `Video "${asset.name}" (${asset.id}) is registered, but proxy preparation could not be queued: ${errorMessage(cause)} Retry preparation explicitly.`,
      cause instanceof ServiceError ? cause.statusCode : 503,
    );
    this.name = 'MediaQueueError';
  }
}

async function assertCacheOutput(filename: string): Promise<void> {
  try {
    if (!(await assertNoSymlinks(filename)).isFile())
      throw new ServiceError('Proxy outputs must be regular cache files.', 422);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export class MediaLibrary {
  readonly #assets = new Map<string, MediaAsset>();
  readonly #writer = new SerialWriter();
  readonly #registering = new Map<string, Promise<MediaAsset>>();
  readonly #prepareRequests = new Map<string, Promise<MediaJob>>();
  readonly #preparing = new Map<string, string>();
  readonly #relinking = new Map<string, string>();
  readonly #analysing = new Map<string, string>();
  constructor(
    readonly config: ServiceConfig,
    readonly jobs: JobQueue,
  ) {}
  async initialise(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = registrySchema.parse(
        JSON.parse(await readFile(path.join(this.config.dataDir, VIDEO_REGISTRY), 'utf8')),
      );
      for (const asset of saved.assets) {
        // A terminated process cannot leave an active preparation job behind.
        if (asset.status === 'queued' || asset.status === 'preparing') {
          asset.status = 'error';
          asset.error = 'Preparation interrupted. Retry explicitly.';
          asset.prepared = null;
        }
        this.#assets.set(asset.id, asset);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  list(): MediaAsset[] {
    return [...this.#assets.values()].map((asset) => mediaAssetSchema.parse(asset));
  }
  get(id: string): MediaAsset {
    const asset = this.#assets.get(id);
    if (!asset) throw new ServiceError('Registered media not found.', 404);
    return mediaAssetSchema.parse(asset);
  }
  /** Recordings whose original is not at its registered path (metadata check only). */
  async missing(): Promise<string[]> {
    const missing: string[] = [];
    await forEachSerial([...this.#assets.values()], async (asset) => {
      try {
        await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
      } catch {
        missing.push(asset.id);
      }
    });
    return missing;
  }
  assetDir(asset: MediaAsset): string {
    return path.join(this.config.dataDir, 'assets', asset.id, PROXY_PROFILE);
  }
  proxyPath(asset: MediaAsset): string {
    return path.join(this.assetDir(asset), 'proxy.mp4');
  }
  thumbnailPath(asset: MediaAsset, frame: number): string {
    return path.join(this.assetDir(asset), `frame-${frame}.jpg`);
  }
  motionPath(asset: MediaAsset): string {
    return path.join(this.assetDir(asset), `motion-v${MOTION_ANALYSIS_VERSION}.json`);
  }
  /** The cached analysis of the current verified proxy, or null when it has not been analysed. */
  async motion(id: string): Promise<MotionAnalysis | null> {
    const asset = this.get(id);
    if (asset.status !== 'ready' || !asset.prepared) return null;
    let text: string;
    try {
      text = await readFile(this.motionPath(asset), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const analysis = motionAnalysisSchema.parse(JSON.parse(text));
    // An analysis of an earlier proxy no longer describes the current one.
    return analysis.verifiedAt === asset.prepared.verification.verifiedAt &&
      analysis.frameCount === asset.prepared.verification.frameCount
      ? analysis
      : null;
  }
  /** Measures camera motion in the verified proxy for smooth-range suggestions. */
  analyseMotion(id: string): MediaJob {
    const active = this.#analysing.get(id);
    if (active !== undefined) return this.jobs.get(active);
    const asset = this.get(id);
    if (asset.status !== 'ready' || !asset.prepared)
      throw new ServiceError('Prepare the recording before looking for its smooth part.', 409);
    if (this.#preparing.has(id) || this.#prepareRequests.has(id) || this.#relinking.has(id))
      throw new ServiceError(`${asset.name} is busy. Try again once its current job finishes.`, 409);
    const { verifiedAt } = asset.prepared.verification;
    const job = this.jobs.submit(
      'motion',
      asset.name,
      async (context) => {
        const current = this.get(id);
        if (current.prepared?.verification.verifiedAt !== verifiedAt)
          throw new ServiceError('The proxy changed while waiting. Look for the smooth part again.', 409);
        await assertSourceIdentity(current.sourcePath, current.fingerprint);
        await this.#measureMotion(current, context, 0.01, 0.98);
        return 'Camera motion measured';
      },
      () => {
        this.#analysing.delete(id);
        return Promise.resolve();
      },
    );
    this.#analysing.set(id, job.id);
    return job;
  }
  async #save(): Promise<void> {
    await this.#writer.run(() => this.#writeRegistry());
  }
  async #writeRegistry(): Promise<void> {
    const contents = `${JSON.stringify({ version: 2, assets: this.list() }, null, 2)}\n`;
    await atomicWrite(path.join(this.config.dataDir, VIDEO_REGISTRY), contents);
  }
  /** Raw read-only registration for fixtures and explicit preparation scripts. */
  async register(filename: string): Promise<MediaAsset> {
    assertCacheOutsideSource(path.dirname(path.resolve(filename)), this.config.dataDir);
    return (await this.#registerSource(filename)).asset;
  }
  async #registerSource(filename: string): Promise<Registration> {
    const sourcePath = path.resolve(filename);
    const fingerprint = await fingerprintFile(sourcePath);
    const id = `media-${fingerprint.digest.slice(0, 32)}`;
    const pending = this.#registering.get(id);
    if (pending !== undefined) return { asset: await pending, added: false };
    // A relinked recording keeps its first ID while living at another location.
    const located = [...this.#assets.values()].find((asset) => asset.fingerprint.digest === fingerprint.digest);
    if (located) return { asset: this.get(located.id), added: false };
    const existing = this.#assets.get(id);
    if (existing)
      throw new ServiceError(
        `This recording was registered before and relinked to ${existing.sourcePath}. Use that location, or relink it back here.`,
        409,
      );
    // Install the request before probing or saving. A repeat cannot overwrite
    // an asset already queued by another import, or observe an uncommitted save.
    const request = Promise.resolve()
      .then(async () => {
        const metadata = await probeVideo(this.config, sourcePath);
        await assertSourceIdentity(sourcePath, fingerprint, true);
        const asset = mediaAssetSchema.parse({
          id,
          name: path.basename(sourcePath),
          sourcePath,
          fingerprint,
          content: null,
          metadata,
          status: 'registered',
          error: null,
          prepared: null,
        });
        // Roll back inside the writer operation, before another save can snapshot
        // an entry whose registration was rejected by persistence.
        await this.#writer.run(async () => {
          this.#assets.set(id, asset);
          try {
            await this.#writeRegistry();
          } catch (error) {
            this.#assets.delete(id);
            throw error;
          }
        });
        return this.get(id);
      })
      .finally(() => {
        this.#registering.delete(id);
      });
    this.#registering.set(id, request);
    return { asset: await request, added: true };
  }
  async importFolder(
    directory: string,
  ): Promise<{ assets: MediaAsset[]; errors: { path: string; message: string }[]; ignored: number }> {
    assertCacheOutsideSource(directory, this.config.dataDir);
    const discovery = await discoverVideos(directory);
    const result = { assets: [] as MediaAsset[], errors: discovery.errors, ignored: discovery.ignored };
    // Registration probes are serial. Import does not start expensive encodes implicitly.
    await forEachSerial(discovery.files, async (filename) => {
      try {
        result.assets.push(await this.register(filename));
      } catch (error) {
        result.errors.push({ path: filename, message: errorMessage(error) });
      }
    });
    return result;
  }
  /** User-initiated imports admit eligible videos without waiting for encodes. */
  async importForEditing(directory: string): Promise<ImportForEditingResult> {
    assertCacheOutsideSource(directory, this.config.dataDir);
    const discovery = await discoverVideos(directory);
    return this.#addFilesForEditing(discovery.files, discovery.errors, discovery.ignored);
  }
  /** Browser-selected paths have already passed the whole-batch scope guard.
   * Unlike recursive folder imports, their parent may contain the cache branch.
   */
  async addFilesForEditing(filenames: readonly string[]): Promise<ImportForEditingResult> {
    return this.#addFilesForEditing(filenames, [], 0);
  }
  async #addFilesForEditing(
    filenames: readonly string[],
    errors: ImportForEditingResult['errors'],
    ignored: number,
  ): Promise<ImportForEditingResult> {
    const result: ImportForEditingResult = {
      assets: [],
      errors: [...errors],
      ignored,
      added: 0,
      existing: 0,
      jobs: [],
      queueErrors: [],
    };
    const accepted = new Set<string>();
    // Keep source probes serial; only the shared heavy worker performs encodes.
    await forEachSerial(filenames, async (filename) => {
      let registration: Registration;
      try {
        registration = await this.#registerSource(filename);
      } catch (error) {
        result.errors.push({ path: filename, message: errorMessage(error) });
        return;
      }
      result.assets.push(registration.asset);
      if (registration.added) result.added++;
      else result.existing++;
      try {
        const job = await this.#queueForEditing(registration.asset.id);
        if (job) accepted.add(job.id);
      } catch (error) {
        result.queueErrors.push({ mediaId: registration.asset.id, message: errorMessage(error) });
      }
    });
    // Earlier jobs may have finished while later sources were being probed.
    result.assets = result.assets.map((asset) => this.get(asset.id));
    result.jobs = [...accepted]
      .map((id) => this.jobs.get(id))
      .filter((job) => job.state === 'queued' || job.state === 'running');
    return result;
  }
  async addForEditing(filename: string): Promise<AddForEditingResult> {
    assertCacheOutsideSource(path.dirname(path.resolve(filename)), this.config.dataDir);
    const { asset } = await this.#registerSource(filename);
    const job = await this.#queueForEditing(asset.id);
    const current = job ? this.jobs.get(job.id) : null;
    return {
      asset: this.get(asset.id),
      job: current && (current.state === 'queued' || current.state === 'running') ? current : null,
    };
  }
  async #queueForEditing(id: string): Promise<MediaJob | null> {
    // Reuse pending/active admissions. Ready, failed and cancelled preparations
    // are never automatically retried by another import.
    if (!this.#prepareRequests.has(id) && !this.#preparing.has(id) && this.get(id).status !== 'registered') return null;
    try {
      const job = this.jobs.get((await this.prepare(id)).id);
      return job.state === 'queued' || job.state === 'running' ? job : null;
    } catch (error) {
      throw new MediaQueueError(this.get(id), error);
    }
  }
  prepare(id: string): Promise<MediaJob> {
    const pending = this.#prepareRequests.get(id);
    if (pending !== undefined) return pending;
    // The Promise is visible before validation/save can yield to another caller.
    const request = Promise.resolve()
      .then(() => this.#enqueue(id))
      .finally(() => {
        this.#prepareRequests.delete(id);
      });
    this.#prepareRequests.set(id, request);
    return request;
  }
  async #enqueue(id: string): Promise<MediaJob> {
    const active = this.#preparing.get(id);
    if (active) return this.jobs.get(active);
    if (this.#relinking.has(id))
      throw new ServiceError('This recording is being relinked. Prepare it once the relink finishes.', 409);
    const registration = this.#registering.get(id);
    if (registration !== undefined) await registration;
    const asset = this.get(id);
    const current = this.#assets.get(id)!;
    try {
      // Registration validates the import flow. Preparation reads only this
      // registered original, never recursively discovers its parent folder.
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
      current.status = 'queued';
      current.error = null;
      await this.#save();
      const job = this.jobs.submit(
        'prepare',
        asset.name,
        async (context) => {
          if (context.signal.aborted) throw new ServiceError('Job cancelled.', 499);
          current.status = 'preparing';
          await this.#save();
          // A queued source may have disappeared or changed before its turn.
          await assertSourceIdentity(current.sourcePath, current.fingerprint, true);
          if (current.content === null) {
            context.update(0.01, 'Checksumming the original');
            const content = await hashFile(current.sourcePath, context.signal);
            await assertSourceIdentity(current.sourcePath, current.fingerprint, true);
            current.content = content;
          }
          const note = await this.#prepareAsset(current, context);
          if (context.signal.aborted) throw new ServiceError('Job cancelled.', 499);
          return note;
        },
        async (finished) => {
          current.status = finished.state === 'completed' ? 'ready' : 'error';
          current.error = finished.state === 'completed' ? null : finished.message;
          if (finished.state !== 'completed') current.prepared = null;
          try {
            await this.#save();
          } catch (error) {
            current.status = 'error';
            current.error = `Cannot persist proxy preparation: ${errorMessage(error)}`;
            current.prepared = null;
            throw error;
          } finally {
            this.#preparing.delete(id);
          }
        },
      );
      this.#preparing.set(id, job.id);
      return job;
    } catch (error) {
      current.status = 'error';
      current.error = `Cannot queue proxy preparation: ${errorMessage(error)} Retry preparation explicitly.`;
      try {
        await this.#save();
      } catch (saveError) {
        current.error += ` Cannot persist media status: ${errorMessage(saveError)}`;
        throw new ServiceError(current.error, 503);
      }
      throw error;
    }
  }
  /** Points a recording at a verified byte-identical copy; its ID, proxy and clips stay. */
  relink(id: string, filename: string): MediaJob {
    const asset = this.get(id);
    const content = asset.content;
    if (content === null)
      throw new ServiceError(
        `${asset.name} was never prepared, so PasCap has no checksum to verify a moved copy against. Import the recording from its new location instead.`,
        409,
      );
    if (this.#relinking.has(id) || this.#preparing.has(id) || this.#prepareRequests.has(id))
      throw new ServiceError(`${asset.name} is busy. Relink it once its current job finishes.`, 409);
    const sourcePath = path.resolve(filename);
    assertCacheOutsideSource(path.dirname(sourcePath), this.config.dataDir);
    const job = this.jobs.submit(
      'relink',
      asset.name,
      async (context) => {
        context.update(0.01, `Checking every byte of ${sourcePath}`);
        const fingerprint = await verifyMovedOriginal(sourcePath, content, context.signal, (fraction) =>
          context.update(0.01 + fraction * 0.97, `Checking every byte of ${sourcePath}`),
        );
        if (context.signal.aborted) throw new ServiceError('Job cancelled.', 499);
        await this.commitRelink(id, sourcePath, fingerprint);
        return `Relinked to ${sourcePath}`;
      },
      () => {
        this.#relinking.delete(id);
        return Promise.resolve();
      },
    );
    this.#relinking.set(id, job.id);
    return job;
  }
  /** Missing recordings with a recorded checksum and no queued work of their own. */
  async relinkCandidates(): Promise<RelinkCandidate[]> {
    const missing = new Set(await this.missing());
    return this.list().flatMap((asset) =>
      missing.has(asset.id) &&
      asset.content &&
      !this.#relinking.has(asset.id) &&
      !this.#preparing.has(asset.id) &&
      !this.#prepareRequests.has(asset.id)
        ? [{ id: asset.id, name: asset.name, content: asset.content }]
        : [],
    );
  }
  /** Publishes a location already verified against the recorded checksum. */
  async commitRelink(id: string, sourcePath: string, fingerprint: SourceFingerprint): Promise<void> {
    await this.#writer.run(async () => {
      const current = this.#assets.get(id)!;
      const previous = { name: current.name, sourcePath: current.sourcePath, fingerprint: current.fingerprint };
      Object.assign(current, { name: path.basename(sourcePath), sourcePath, fingerprint });
      try {
        await this.#writeRegistry();
      } catch (error) {
        Object.assign(current, previous);
        throw error;
      }
    });
  }
  async #prepareAsset(asset: MediaAsset, context: JobContext): Promise<string | undefined> {
    const directory = this.assetDir(asset);
    const thumbnailFrames = [
      ...new Set([
        0,
        Math.floor(asset.metadata.frameCount / 4),
        Math.floor(asset.metadata.frameCount / 2),
        Math.floor((asset.metadata.frameCount * 3) / 4),
        asset.metadata.frameCount - 1,
      ]),
    ];
    await ensurePrivateDirectory(directory);
    await Promise.all(
      [this.proxyPath(asset), ...thumbnailFrames.map((frame) => this.thumbnailPath(asset, frame))].map(
        assertCacheOutput,
      ),
    );
    if (asset.prepared?.profile === PROXY_PROFILE) {
      let cached = false;
      try {
        await probeVideo(this.config, this.proxyPath(asset), context.signal);
        cached = true;
      } catch (error) {
        if (context.signal.aborted) throw error;
      }
      if (cached) {
        await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
        // Proxies prepared before smooth-part analysis existed gain it here.
        if (!(await this.#hasMotion(asset))) return this.#measureAfterPreparation(asset, context);
        context.update(0.99, 'Verified cached proxy');
        return;
      }
    }
    const temporary = path.join(directory, `proxy-${context.id}.partial.mp4`);
    try {
      context.update(0.01, 'Encoding a read-only 720p proxy');
      const inputRange = asset.metadata.colourRange === 'tv' ? 'tv' : 'pc';
      await runProcess(
        this.config.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-n',
          '-threads',
          NATIVE_THREADS,
          '-i',
          asset.sourcePath,
          '-map',
          '0:v:0',
          '-an',
          '-sn',
          '-dn',
          '-vf',
          `scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:in_range=${inputRange}:out_range=tv,setsar=1`,
          '-fps_mode',
          'passthrough',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-g',
          '15',
          '-keyint_min',
          '15',
          '-sc_threshold',
          '0',
          '-bf',
          '0',
          '-flags',
          '+cgop',
          '-threads',
          NATIVE_THREADS,
          '-filter_threads',
          NATIVE_THREADS,
          '-color_primaries',
          'bt709',
          '-color_trc',
          'bt709',
          '-colorspace',
          'bt709',
          '-color_range',
          'tv',
          '-movflags',
          '+faststart',
          '-video_track_timescale',
          '30000',
          '-progress',
          'pipe:1',
          temporary,
        ],
        {
          signal: context.signal,
          onProgress: (fields) => {
            const microseconds = Number(fields['out_time_us']);
            if (Number.isFinite(microseconds))
              context.update(
                0.05 + Math.min(0.7, (microseconds / 1e6 / asset.metadata.durationSeconds) * 0.7),
                'Encoding proxy',
              );
          },
        },
      );
      context.update(0.77, 'Checking beginning, middle and end frame correspondence');
      const metadata = await probeVideo(this.config, temporary, context.signal);
      if (metadata.frameCount !== asset.metadata.frameCount)
        throw new ServiceError('Proxy frame count differs from the original. Editing disabled.', 422);
      const frames = [0, Math.floor((metadata.frameCount - 1) / 2), metadata.frameCount - 1];
      const samples: { frame: number; meanAbsoluteError8Bit: number }[] = [];
      await forEachSerial(frames, async (frame) => {
        const original = await extractComparisonFrame(
          this.config,
          asset.sourcePath,
          frame,
          asset.metadata.colourRange,
          context.signal,
        );
        const proxy = await extractComparisonFrame(this.config, temporary, frame, 'tv', context.signal);
        const mae = meanAbsoluteError(original, proxy);
        if (mae > FRAME_SAMPLE_MAE_LIMIT)
          throw new ServiceError(
            `Proxy/source frame ${frame} differs by ${mae.toFixed(2)} / 255. Correspondence unverified.`,
            422,
          );
        samples.push({ frame, meanAbsoluteError8Bit: mae });
      });
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
      if (context.signal.aborted) throw new ServiceError('Job cancelled.', 499);
      await rename(temporary, this.proxyPath(asset));
      await forEachSerial(thumbnailFrames, async (frame) => {
        await runProcess(
          this.config.ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-y',
            '-threads',
            '2',
            '-ss',
            framesToSeconds(frame).toFixed(9),
            '-i',
            this.proxyPath(asset),
            '-frames:v',
            '1',
            '-vf',
            'scale=320:-2',
            '-q:v',
            '3',
            '-threads',
            '2',
            '-filter_threads',
            '2',
            this.thumbnailPath(asset, frame),
          ],
          { signal: context.signal },
        );
      });
      asset.prepared = {
        profile: PROXY_PROFILE,
        width: metadata.width,
        height: metadata.height,
        thumbnailFrames,
        verification: { frameCount: metadata.frameCount, samples, verifiedAt: new Date().toISOString() },
      };
      return await this.#measureAfterPreparation(asset, context);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async #measureMotion(asset: MediaAsset, context: JobContext, from: number, to: number): Promise<void> {
    const { verifiedAt, frameCount } = asset.prepared!.verification;
    context.update(from, 'Measuring camera motion for smooth-part suggestions');
    const motion = await analyseProxy(
      this.config.ffmpeg,
      this.proxyPath(asset),
      frameCount,
      verifiedAt,
      context.signal,
      (fraction) =>
        context.update(from + fraction * (to - from), 'Measuring camera motion for smooth-part suggestions'),
    );
    const telemetry = await readTelemetry(this.config, asset.sourcePath, context.signal);
    await atomicWrite(this.motionPath(asset), JSON.stringify({ ...motion, telemetry }));
  }
  /** Smooth-part analysis is a convenience: its failure leaves a usable, verified proxy. */
  async #measureAfterPreparation(asset: MediaAsset, context: JobContext): Promise<string | undefined> {
    try {
      await this.#measureMotion(asset, context, 0.84, 0.99);
      return undefined;
    } catch (error) {
      if (context.signal.aborted) throw error;
      return `Proxy ready; smooth-part analysis failed: ${errorMessage(error)} Use Find smooth part to retry.`;
    }
  }
  async #hasMotion(asset: MediaAsset): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.motionPath(asset), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    // An unreadable analysis is regenerated like a missing one; it is only a cache.
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return false;
    }
    const parsed = motionAnalysisSchema.safeParse(value);
    return parsed.success && parsed.data.verifiedAt === asset.prepared?.verification.verifiedAt;
  }
}

export async function extractComparisonFrame(
  config: ServiceConfig,
  filename: string,
  frame: number,
  range: 'tv' | 'pc',
  signal?: AbortSignal,
): Promise<Buffer> {
  return runProcess(
    config.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-ss',
      framesToSeconds(frame).toFixed(9),
      '-i',
      filename,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-an',
      '-vf',
      `scale=160:90:flags=area:in_color_matrix=bt709:in_range=${range}:out_range=pc,format=rgb24`,
      '-f',
      'rawvideo',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      'pipe:1',
    ],
    signal ? { signal } : {},
  );
}

export function meanAbsoluteError(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) throw new Error('Comparison frames must have equal non-zero sizes.');
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference += Math.abs(a[index]! - b[index]!);
  return difference / a.length;
}
