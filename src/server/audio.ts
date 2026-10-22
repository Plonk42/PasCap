import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { audioAssetSchema, type AudioAsset } from '../shared/audio.js';
import type { MediaJob, SourceFingerprint } from '../shared/media.js';
import { idSchema } from '../shared/model.js';
import { MUSIC_ANALYSIS_VERSION, musicAnalysisSchema, type MusicAnalysis } from '../shared/music-analysis.js';
import { MUSIC_BYTES_PER_SAMPLE, MUSIC_SAMPLE_RATE, MUSIC_SAMPLES_PER_FRAME } from '../shared/music-stream.js';
import { forEachSerial, whileSerial } from '../shared/serial.js';
import { parseRate, PROJECT_FPS } from '../shared/timing.js';
import { WAVEFORM_BUCKET, WAVEFORM_VERSION, waveformCacheSchema, type DetailWaveform } from '../shared/waveform.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import {
  assertCacheOutsideSource,
  assertNoSymlinks,
  assertSourceIdentity,
  fingerprintFile,
  hashFile,
  verifyMovedOriginal,
} from './files.js';
import { JobQueue, type JobContext } from './jobs.js';
import { measureMusic } from './music-analysis.js';
import { runProcess } from './process.js';
import type { RelinkCandidate } from './relink.js';
import { atomicWrite, ensurePrivateDirectory, SerialWriter } from './storage.js';

export const AUDIO_PROFILE = 'pcm16-48k-stereo-mono-unity-v3' as const;
/** Registry v2; the earlier audio.json is no longer read. */
export const MUSIC_REGISTRY = 'music.json';
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const MAX_PEAKS = 2048;
const registrySchema = z
  .object({ version: z.literal(2), assets: z.array(audioAssetSchema) })
  .strict()
  .refine((registry) => new Set(registry.assets.map((asset) => asset.id)).size === registry.assets.length, {
    message: 'Audio IDs must be unique.',
  });
const sourcePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((filename) => !filename.includes('\0'), { message: 'Source paths cannot contain NUL characters.' });
const probeSchema = z.looseObject({
  streams: z.array(
    z.looseObject({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      sample_rate: z.string().optional(),
      channels: z.number().optional(),
      duration: z.string().optional(),
      duration_ts: z.number().optional(),
      time_base: z.string().optional(),
      disposition: z.looseObject({ attached_pic: z.union([z.literal(0), z.literal(1)]) }).optional(),
    }),
  ),
  format: z.looseObject({ duration: z.string().optional() }).optional(),
});

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ServiceError('Job cancelled.', 499);
}

/** Probe only headers, never packet dumps or a source-video soundtrack. */
export async function probeAudio(
  config: ServiceConfig,
  filename: string,
  signal?: AbortSignal,
): Promise<AudioAsset['metadata']> {
  const output = await runProcess(
    config.ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,sample_rate,channels,duration,duration_ts,time_base:stream_disposition=attached_pic:format=duration',
      '-of',
      'json',
      filename,
    ],
    { maxBytes: 1_048_576, ...(signal ? { signal } : {}) },
  );
  const probe = probeSchema.parse(JSON.parse(output.toString('utf8')));
  const streams = probe.streams.filter((stream) => stream.codec_type === 'audio');
  if (
    streams.length !== 1 ||
    probe.streams.some((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  ) {
    throw new ServiceError(
      'Register a standalone music file with exactly one audio stream and no video footage. Embedded cover artwork is allowed; source-video soundtracks are not used.',
      422,
    );
  }
  const stream = streams[0]!;
  const timeBase = stream.time_base ? parseRate(stream.time_base) : null;
  const durationSeconds =
    stream.duration_ts !== undefined && timeBase
      ? (stream.duration_ts * timeBase.numerator) / timeBase.denominator
      : Number(stream.duration ?? probe.format?.duration);
  const metadata = audioAssetSchema.shape.metadata.safeParse({
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    durationSeconds,
    frameCount: Math.floor((durationSeconds * PROJECT_FPS.numerator) / PROJECT_FPS.denominator),
  });
  if (!metadata.success)
    throw new ServiceError(
      'Music must expose a codec, sample rate, channel count and a finite duration of at least one project frame.',
      422,
    );
  return metadata.data;
}

/** A fixed-size reducer for interleaved stereo PCM16 at 48 kHz, including split bytes. */
export class PcmPeakReducer {
  readonly #peaks: Float64Array;
  readonly #expectedSamples: number;
  #samples = 0;
  #pendingByte: number | null = null;
  constructor(durationSeconds: number) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
      throw new ServiceError('Waveform duration must be finite and positive.', 422);
    this.#peaks = new Float64Array(Math.min(MAX_PEAKS, Math.max(1, Math.ceil(durationSeconds * 100))));
    this.#expectedSamples = durationSeconds * SAMPLE_RATE * CHANNELS;
  }
  #consume(sample: number): void {
    const index = Math.min(
      this.#peaks.length - 1,
      Math.floor((this.#samples / this.#expectedSamples) * this.#peaks.length),
    );
    this.#peaks[index] = Math.max(this.#peaks[index]!, Math.min(1, Math.abs(sample) / 32_768));
    this.#samples++;
  }
  add(chunk: Buffer): void {
    if (chunk.length === 0) return;
    let offset = 0;
    if (this.#pendingByte !== null) {
      const unsigned = this.#pendingByte | (chunk[0]! << 8);
      this.#consume(unsigned >= 32_768 ? unsigned - 65_536 : unsigned);
      this.#pendingByte = null;
      offset = 1;
    }
    for (; offset + 1 < chunk.length; offset += 2) this.#consume(chunk.readInt16LE(offset));
    if (offset < chunk.length) this.#pendingByte = chunk[offset]!;
  }
  finish(): number[] {
    if (this.#samples === 0) throw new ServiceError('Decoded music contains no audio samples.', 422);
    if (this.#pendingByte !== null || this.#samples % CHANNELS !== 0)
      throw new ServiceError('Decoded music ended with an incomplete PCM sample frame.', 422);
    return Array.from(this.#peaks);
  }
}

/** Reduce the prepared PCM with a single bounded file reader, not a second decoder. */
async function sampleWaveform(filename: string, durationSeconds: number, signal: AbortSignal): Promise<number[]> {
  const reducer = new PcmPeakReducer(durationSeconds);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = file.createReadStream({ highWaterMark: 65_536, signal, autoClose: false });
  const iterator = stream[Symbol.asyncIterator]();
  let ended = false;
  try {
    await whileSerial(
      () => !ended,
      async () => {
        const next = await iterator.next();
        if (next.done) {
          ended = true;
          return;
        }
        if (!Buffer.isBuffer(next.value)) throw new Error('Music waveform requires raw PCM bytes.');
        reducer.add(next.value);
      },
    );
    return reducer.finish();
  } finally {
    stream.destroy();
    await file.close();
  }
}

/**
 * The lowest and highest level of either channel for every 480 samples of the PCM cache, as signed bytes
 * (minimum, then maximum, -127…127), read in 120 KiB blocks: 200 bytes per second of music, whatever its length.
 */
export async function detailWaveformLevels(filename: string): Promise<Int8Array> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const frames = Math.floor((await file.stat()).size / MUSIC_BYTES_PER_SAMPLE);
    const levels = new Int8Array(2 * Math.ceil(frames / WAVEFORM_BUCKET));
    const block = Buffer.alloc(WAVEFORM_BUCKET * MUSIC_BYTES_PER_SAMPLE * 64);
    // The cache is little-endian PCM16, as are the supported hosts.
    const samples = new Int16Array(block.buffer, block.byteOffset, block.length / 2);
    let done = 0;
    await whileSerial(
      () => done < frames,
      async () => {
        const wanted = Math.min(block.length, (frames - done) * MUSIC_BYTES_PER_SAMPLE);
        let got = 0;
        await whileSerial(
          () => got < wanted,
          async () => {
            const { bytesRead } = await file.read(block, got, wanted - got, done * MUSIC_BYTES_PER_SAMPLE + got);
            if (bytesRead === 0) throw new ServiceError('The music cache ended while its waveform was drawn.', 422);
            got += bytesRead;
          },
        );
        const complete = wanted / MUSIC_BYTES_PER_SAMPLE;
        for (let first = 0; first < complete; first += WAVEFORM_BUCKET) {
          let low = 0;
          let high = 0;
          const end = Math.min(complete, first + WAVEFORM_BUCKET) * 2;
          for (let index = first * 2; index < end; index++) {
            const sample = samples[index]!;
            if (sample < low) low = sample;
            else if (sample > high) high = sample;
          }
          const bucket = (done + first) / WAVEFORM_BUCKET;
          levels[bucket * 2] = Math.floor((low * 127) / 32_768);
          levels[bucket * 2 + 1] = Math.ceil((high * 127) / 32_768);
        }
        done += complete;
      },
    );
    return levels;
  } finally {
    await file.close();
  }
}

async function verifyPlayback(filename: string, original: AudioAsset['metadata']): Promise<void> {
  const info = await assertNoSymlinks(filename);
  const samples = info.size / MUSIC_BYTES_PER_SAMPLE;
  if (
    !info.isFile() ||
    !Number.isInteger(samples) ||
    samples < Math.round(original.frameCount * MUSIC_SAMPLES_PER_FRAME) ||
    Math.abs(samples / MUSIC_SAMPLE_RATE - original.durationSeconds) > 0.1
  ) {
    throw new ServiceError(
      'Prepared music differs from the required complete PCM16 48 kHz stereo source duration.',
      422,
    );
  }
}

export class AudioLibrary {
  readonly #assets = new Map<string, AudioAsset>();
  readonly #writer = new SerialWriter();
  readonly #operations = new SerialWriter();
  readonly #preparing = new Map<string, string>();
  readonly #relinking = new Map<string, string>();
  readonly #analysing = new Map<string, string>();
  readonly #waveforms = new Map<string, Promise<DetailWaveform>>();
  readonly #waveformQueue = new SerialWriter();
  constructor(
    readonly config: ServiceConfig,
    readonly jobs: JobQueue,
  ) {}

  async initialise(): Promise<void> {
    await this.#operations.run(async () => {
      const filename = path.join(this.config.dataDir, MUSIC_REGISTRY);
      let saved: z.infer<typeof registrySchema>;
      let changed = false;
      try {
        if (!(await assertNoSymlinks(filename)).isFile())
          throw new ServiceError('The audio registry must be a regular file.', 422);
        saved = registrySchema.parse(JSON.parse(await readFile(filename, 'utf8')));
      } catch (error) {
        if (!isNotFound(error))
          throw new ServiceError(
            `Cannot read the audio registry: ${errorMessage(error)} Restore the registry or choose a new cache directory; the existing file was not changed.`,
            422,
          );
        saved = { version: 2, assets: [] };
        changed = true;
      }
      for (const asset of saved.assets) {
        if (asset.status === 'queued' || asset.status === 'preparing') {
          asset.status = 'error';
          asset.error = 'Audio preparation interrupted. Retry preparation explicitly.';
          asset.waveform = [];
          changed = true;
        }
        this.#assets.set(asset.id, asset);
      }
      if (changed) await this.#save();
    });
  }
  list(): AudioAsset[] {
    return [...this.#assets.values()].map((asset) => audioAssetSchema.parse(asset));
  }
  /** Metadata-only availability: never rewrite a registry or prepare legacy/missing caches. */
  async availableList(): Promise<AudioAsset[]> {
    const assets = this.list();
    await forEachSerial(assets, async (asset) => {
      if (asset.status !== 'ready') return;
      try {
        await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
        await verifyPlayback(this.playbackPath(asset), asset.metadata);
      } catch (error) {
        asset.status = 'error';
        asset.error = isNotFound(error)
          ? 'The current PCM16 music cache is missing. Prepare this recording explicitly; older caches remain unchanged.'
          : errorMessage(error);
      }
    });
    return assets;
  }
  /** Music whose original is not at its registered path (metadata check only). */
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
  get(id: string): AudioAsset {
    const asset = this.#assets.get(idSchema.parse(id));
    if (!asset) throw new ServiceError('Registered music not found.', 404);
    return audioAssetSchema.parse(asset);
  }
  assetDir(asset: AudioAsset): string {
    return path.join(this.config.dataDir, 'audio-assets', idSchema.parse(asset.id), AUDIO_PROFILE);
  }
  playbackPath(asset: AudioAsset): string {
    return path.join(this.assetDir(asset), 'playback.pcm');
  }
  analysisPath(asset: AudioAsset): string {
    return path.join(this.assetDir(asset), `music-v${MUSIC_ANALYSIS_VERSION}.json`);
  }
  waveformPath(asset: AudioAsset): string {
    return path.join(this.assetDir(asset), `waveform-v${WAVEFORM_VERSION}.json`);
  }
  /** The PCM cache an analysis describes: re-preparing it or a changed original makes the analysis stale. */
  async #cacheIdentity(asset: AudioAsset): Promise<MusicAnalysis['source'] | null> {
    if (asset.status !== 'ready' || !asset.content) return null;
    try {
      const info = await stat(this.playbackPath(asset));
      return { content: asset.content.digest, bytes: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  /** The analysis of the current PCM cache, or null when it is missing, stale or unreadable. */
  async analysis(id: string): Promise<MusicAnalysis | null> {
    const asset = this.get(id);
    const source = await this.#cacheIdentity(asset);
    if (!source) return null;
    let text: string;
    try {
      text = await readFile(this.analysisPath(asset), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    // It is only a cache: an unreadable one is analysed again like a missing one.
    const parsed = musicAnalysisSchema.safeParse(value);
    if (!parsed.success) return null;
    const saved = parsed.data.source;
    return saved.content === source.content && saved.bytes === source.bytes && saved.mtimeMs === source.mtimeMs
      ? parsed.data
      : null;
  }
  /**
   * The detail waveform of the current PCM cache: read from its cache file, or drawn from the PCM once, serially,
   * and saved. A missing, stale or unreadable file is only a cache miss.
   */
  detailWaveform(id: string): Promise<DetailWaveform> {
    const running = this.#waveforms.get(id);
    if (running) return running;
    const work = this.#waveformQueue.run(() => this.#readOrDrawWaveform(id)).finally(() => this.#waveforms.delete(id));
    this.#waveforms.set(id, work);
    return work;
  }
  async #readOrDrawWaveform(id: string): Promise<DetailWaveform> {
    const asset = this.get(id);
    const source = await this.#cacheIdentity(asset);
    if (!source) throw new ServiceError('Prepare the music before drawing its waveform.', 409);
    await verifyPlayback(this.playbackPath(asset), asset.metadata);
    const cached = await this.#cachedDetailWaveform(asset, source);
    if (cached) return cached;
    const levels = await detailWaveformLevels(this.playbackPath(asset));
    const after = await this.#cacheIdentity(this.get(id));
    if (after?.mtimeMs !== source.mtimeMs || after.bytes !== source.bytes || after.content !== source.content)
      throw new ServiceError('The music cache changed while its waveform was drawn. Try again.', 409);
    const data = Buffer.from(levels.buffer, levels.byteOffset, levels.byteLength).toString('base64');
    const cache = waveformCacheSchema.parse({
      version: WAVEFORM_VERSION,
      source,
      bucketSamples: WAVEFORM_BUCKET,
      data,
    });
    await atomicWrite(this.waveformPath(asset), JSON.stringify(cache));
    return { bucketSamples: cache.bucketSamples, data };
  }
  async #cachedDetailWaveform(asset: AudioAsset, source: MusicAnalysis['source']): Promise<DetailWaveform | null> {
    let text: string;
    try {
      text = await readFile(this.waveformPath(asset), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    try {
      const cache = waveformCacheSchema.parse(JSON.parse(text));
      const saved = cache.source;
      return saved.content === source.content && saved.bytes === source.bytes && saved.mtimeMs === source.mtimeMs
        ? { bucketSamples: cache.bucketSamples, data: cache.data }
        : null;
    } catch {
      return null;
    }
  }
  /** The queued or running analysis of this music, if any. */
  analysisJob(id: string): MediaJob | null {
    const active = this.#analysing.get(id);
    return active === undefined ? null : this.jobs.get(active);
  }
  /** Queues the tempo, beat and section analysis of prepared music. */
  analyse(id: string): MediaJob {
    const active = this.#analysing.get(id);
    if (active !== undefined) return this.jobs.get(active);
    const asset = this.get(id);
    if (asset.status !== 'ready' || !asset.content)
      throw new ServiceError('Prepare the music before analysing it.', 409);
    if (this.#preparing.has(id) || this.#relinking.has(id))
      throw new ServiceError(`${asset.name} is busy. Analyse it once its current job finishes.`, 409);
    return this.#submitAnalysis(asset);
  }
  #submitAnalysis(asset: AudioAsset): MediaJob {
    const { id } = asset;
    const message = 'Finding the tempo, beats and sections';
    const job = this.jobs.submit(
      'music-analysis',
      asset.name,
      async (context) => {
        const current = await this.assertReady(id);
        const source = await this.#cacheIdentity(current);
        if (!source) throw new ServiceError('The music cache is missing. Prepare the music again.', 409);
        context.update(0.01, message);
        const measurement = await measureMusic(this.playbackPath(current), context.signal, (fraction) =>
          context.update(0.01 + 0.97 * fraction, message),
        );
        const after = await this.#cacheIdentity(this.get(id));
        if (after?.mtimeMs !== source.mtimeMs || after.bytes !== source.bytes || after.content !== source.content)
          throw new ServiceError('The music cache changed while it was analysed. Analyse the music again.', 409);
        const analysis = musicAnalysisSchema.parse({ version: MUSIC_ANALYSIS_VERSION, source, ...measurement });
        await atomicWrite(this.analysisPath(current), JSON.stringify(analysis));
        return analysis.tempo
          ? `${Math.round(analysis.tempo.bpm)} BPM, ${analysis.beats.length} beats`
          : 'No steady beat found';
      },
      () => {
        if (this.#analysing.get(id) === job.id) this.#analysing.delete(id);
        return Promise.resolve();
      },
    );
    this.#analysing.set(id, job.id);
    return job;
  }
  /** Music becomes ready first; its analysis follows as a background job. */
  async #queueAnalysis(id: string): Promise<void> {
    try {
      if (!this.#analysing.has(id) && !(await this.analysis(id))) this.#submitAnalysis(this.get(id));
    } catch {
      // The music is ready either way; Audio then offers Analyse music.
    }
  }
  async assertReady(id: string): Promise<AudioAsset> {
    const asset = this.get(id);
    const reason = asset.error ? ' ' + asset.error : '';
    if (asset.status !== 'ready' || asset.waveform.length === 0)
      throw new ServiceError(`Music is not prepared and ready. Retry preparation explicitly.${reason}`, 409);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
    try {
      await verifyPlayback(this.playbackPath(asset), asset.metadata);
    } catch (error) {
      if (isNotFound(error))
        throw new ServiceError('The prepared music cache is missing. Retry preparation explicitly.', 409);
      throw error;
    }
    return asset;
  }
  async #save(): Promise<void> {
    await this.#writer.run(() =>
      atomicWrite(
        path.join(this.config.dataDir, MUSIC_REGISTRY),
        `${JSON.stringify({ version: 2, assets: this.list() }, null, 2)}\n`,
      ),
    );
  }
  async register(filename: string): Promise<{ asset: AudioAsset; job: MediaJob }> {
    const sourcePath = path.resolve(sourcePathSchema.parse(filename));
    return this.#operations.run(async () => {
      assertCacheOutsideSource(path.dirname(sourcePath), this.config.dataDir);
      const fingerprint = await fingerprintFile(sourcePath);
      // An explicit new location is a new source, never an implicit relink.
      let id: string | undefined;
      for (const asset of this.#assets.values()) {
        if (asset.sourcePath === sourcePath && asset.fingerprint.digest === fingerprint.digest) {
          id = asset.id;
          break;
        }
      }
      if (!id) {
        id = `audio-${randomUUID()}`;
        const metadata = await probeAudio(this.config, sourcePath);
        await assertSourceIdentity(sourcePath, fingerprint, true);
        this.#assets.set(
          id,
          audioAssetSchema.parse({
            id,
            name: path.basename(sourcePath),
            sourcePath,
            fingerprint,
            content: null,
            metadata,
            status: 'registered',
            error: null,
            waveform: [],
          }),
        );
        try {
          await this.#save();
        } catch (error) {
          this.#assets.delete(id);
          throw error;
        }
      }
      const job = await this.#enqueue(id);
      return { asset: this.get(id), job };
    });
  }
  async prepare(id: string): Promise<MediaJob> {
    idSchema.parse(id);
    return this.#operations.run(() => this.#enqueue(id));
  }
  async #enqueue(id: string): Promise<MediaJob> {
    const active = this.#preparing.get(id);
    if (active) return this.jobs.get(active);
    if (this.#relinking.has(id))
      throw new ServiceError('This music is being relinked. Prepare it once the relink finishes.', 409);
    const snapshot = this.get(id);
    assertCacheOutsideSource(path.dirname(snapshot.sourcePath), this.config.dataDir);
    await assertSourceIdentity(snapshot.sourcePath, snapshot.fingerprint, true);
    // Preparing may replace the cache an analysis would read.
    const analysing = this.#analysing.get(id);
    if (analysing !== undefined) {
      this.jobs.cancel(analysing);
      this.#analysing.delete(id);
    }
    const current = this.#assets.get(id)!;
    current.status = 'queued';
    current.error = null;
    current.waveform = [];
    try {
      await this.#save();
    } catch (error) {
      current.status = snapshot.status;
      current.error = snapshot.error;
      current.waveform = snapshot.waveform;
      throw error;
    }
    const job = this.jobs.submit(
      'audio',
      snapshot.name,
      async (context) => {
        assertNotCancelled(context.signal);
        current.status = 'preparing';
        await this.#save();
        if (current.content === null) {
          context.update(0.01, 'Checksumming the original');
          const content = await hashFile(snapshot.sourcePath, context.signal);
          await assertSourceIdentity(snapshot.sourcePath, snapshot.fingerprint, true);
          current.content = content;
        }
        const waveform = await this.#prepareAsset(snapshot, context);
        assertNotCancelled(context.signal);
        current.waveform = waveform;
      },
      async (finished) =>
        this.#operations.run(async () => {
          current.status = finished.state === 'completed' ? 'ready' : 'error';
          current.error = finished.state === 'completed' ? null : finished.message;
          if (finished.state !== 'completed') current.waveform = [];
          try {
            await this.#save();
          } catch (error) {
            current.status = 'error';
            current.error = `Cannot persist audio preparation: ${errorMessage(error)}`;
            current.waveform = [];
            throw error;
          } finally {
            this.#preparing.delete(id);
          }
          if (finished.state === 'completed') await this.#queueAnalysis(id);
        }),
    );
    this.#preparing.set(id, job.id);
    return job;
  }
  /** Points music at a verified byte-identical copy; its ID, cache and music tracks stay. */
  async relink(id: string, filename: string): Promise<MediaJob> {
    const sourcePath = path.resolve(sourcePathSchema.parse(filename));
    return this.#operations.run(() => {
      const asset = this.get(id);
      const content = asset.content;
      if (content === null)
        throw new ServiceError(
          `${asset.name} was never prepared, so PasCap has no checksum to verify a moved copy against. Import the music from its new location instead.`,
          409,
        );
      if (this.#relinking.has(id) || this.#preparing.has(id))
        throw new ServiceError(`${asset.name} is busy. Relink it once its current job finishes.`, 409);
      assertCacheOutsideSource(path.dirname(sourcePath), this.config.dataDir);
      const job = this.jobs.submit(
        'relink',
        asset.name,
        async (context) => {
          context.update(0.01, `Checking every byte of ${sourcePath}`);
          const fingerprint = await verifyMovedOriginal(sourcePath, content, context.signal, (fraction) =>
            context.update(0.01 + fraction * 0.97, `Checking every byte of ${sourcePath}`),
          );
          assertNotCancelled(context.signal);
          await this.commitRelink(id, sourcePath, fingerprint);
          return `Relinked to ${sourcePath}`;
        },
        () => {
          this.#relinking.delete(id);
          return Promise.resolve();
        },
      );
      this.#relinking.set(id, job.id);
      return Promise.resolve(job);
    });
  }
  /** Missing music with a recorded checksum and no queued work of its own. */
  async relinkCandidates(): Promise<RelinkCandidate[]> {
    const missing = new Set(await this.missing());
    return this.list().flatMap((asset) =>
      missing.has(asset.id) && asset.content && !this.#relinking.has(asset.id) && !this.#preparing.has(asset.id)
        ? [{ id: asset.id, name: asset.name, content: asset.content }]
        : [],
    );
  }
  /** Publishes a location already verified against the recorded checksum. */
  async commitRelink(id: string, sourcePath: string, fingerprint: SourceFingerprint): Promise<void> {
    await this.#operations.run(async () => {
      const current = this.#assets.get(id)!;
      const previous = { name: current.name, sourcePath: current.sourcePath, fingerprint: current.fingerprint };
      Object.assign(current, { name: path.basename(sourcePath), sourcePath, fingerprint });
      try {
        await this.#save();
      } catch (error) {
        Object.assign(current, previous);
        throw error;
      }
    });
  }
  async #cachedWaveform(asset: AudioAsset, context: JobContext): Promise<number[] | null> {
    try {
      context.update(0.1, 'Verifying cached music');
      await verifyPlayback(this.playbackPath(asset), asset.metadata);
      return await sampleWaveform(this.playbackPath(asset), asset.metadata.durationSeconds, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      // This explicit retry may replace a damaged regular cache, never a symlink.
      return null;
    }
  }
  async #prepareAsset(asset: AudioAsset, context: JobContext): Promise<number[]> {
    assertNotCancelled(context.signal);
    assertCacheOutsideSource(path.dirname(asset.sourcePath), this.config.dataDir);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
    const directory = this.assetDir(asset);
    await ensurePrivateDirectory(directory);
    const playback = this.playbackPath(asset);
    let cached = false;
    try {
      if (!(await assertNoSymlinks(playback)).isFile())
        throw new ServiceError('Prepared music must be a regular cache file.', 422);
      cached = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (cached) {
      const waveform = await this.#cachedWaveform(asset, context);
      if (waveform) {
        await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
        assertNotCancelled(context.signal);
        context.update(0.99, 'Cached playback and waveform verified');
        return waveform;
      }
    }
    const temporary = path.join(directory, `playback-${idSchema.parse(context.id)}.partial.pcm`);
    let published = false;
    try {
      context.update(0.02, 'Preparing PCM16 48 kHz stereo music');
      // Match Web Audio mono duplication and the native export mixer; FFmpeg's
      // implicit upmix would attenuate each channel by 3 dB.
      const upmix = asset.metadata.channels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
      await runProcess(
        this.config.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-xerror',
          '-n',
          '-threads',
          '2',
          '-i',
          asset.sourcePath,
          '-map',
          '0:a:0',
          '-vn',
          '-sn',
          '-dn',
          '-map_metadata',
          '-1',
          '-map_chapters',
          '-1',
          '-af',
          `${upmix}asetpts=PTS-STARTPTS`,
          '-ar',
          String(SAMPLE_RATE),
          '-ac',
          String(CHANNELS),
          '-c:a',
          'pcm_s16le',
          '-threads',
          '2',
          '-filter_threads',
          '2',
          '-f',
          's16le',
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
                'Encoding music playback',
              );
          },
        },
      );
      context.update(0.78, 'Verifying audio profile and sampling waveform peaks');
      await verifyPlayback(temporary, asset.metadata);
      const waveform = await sampleWaveform(temporary, asset.metadata.durationSeconds, context.signal);
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
      assertNotCancelled(context.signal);
      await chmod(temporary, 0o600);
      await rename(temporary, playback);
      published = true;
      assertNotCancelled(context.signal);
      context.update(0.99, 'Music playback and bounded waveform verified');
      return waveform;
    } catch (error) {
      if (published) await rm(playback, { force: true });
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
