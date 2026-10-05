import { spawn } from 'node:child_process';
import { chmod, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { audioAssetSchema, type AudioAsset } from '../shared/audio.js';
import type { MediaJob } from '../shared/media.js';
import { idSchema } from '../shared/model.js';
import { parseRate, PROJECT_FPS } from '../shared/timing.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertCacheOutsideSource, assertNoSymlinks, assertSourceIdentity, fingerprintFile } from './files.js';
import { JobQueue, type JobContext } from './jobs.js';
import { runProcess } from './process.js';
import { atomicWrite, ensurePrivateDirectory, SerialWriter } from './storage.js';

export const AUDIO_PROFILE = 'aac-48k-stereo-mono-unity-v2' as const;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const MAX_PEAKS = 2048;
const registrySchema = z.object({ version: z.literal(1), assets: z.array(audioAssetSchema) }).strict()
  .refine((registry) => new Set(registry.assets.map((asset) => asset.id)).size === registry.assets.length, { message: 'Audio IDs must be unique.' });
const sourcePathSchema = z.string().min(1).max(4096).refine((filename) => !filename.includes('\0'), { message: 'Source paths cannot contain NUL characters.' });
const probeSchema = z.looseObject({
  streams: z.array(z.looseObject({
    codec_type: z.string(), codec_name: z.string().optional(), sample_rate: z.string().optional(),
    channels: z.number().optional(), duration: z.string().optional(), duration_ts: z.number().optional(), time_base: z.string().optional(),
    disposition: z.looseObject({ attached_pic: z.union([z.literal(0), z.literal(1)]) }).optional(),
  })),
  format: z.looseObject({ duration: z.string().optional() }).optional(),
});

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ServiceError('Job cancelled.', 499);
}

/** Probe only headers, never packet dumps or a source-video soundtrack. */
export async function probeAudio(config: ServiceConfig, filename: string, signal?: AbortSignal): Promise<AudioAsset['metadata']> {
  const output = await runProcess(config.ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,duration,duration_ts,time_base:stream_disposition=attached_pic:format=duration', '-of', 'json', filename,
  ], { maxBytes: 1_048_576, ...(signal ? { signal } : {}) });
  const probe = probeSchema.parse(JSON.parse(output.toString('utf8')));
  const streams = probe.streams.filter((stream) => stream.codec_type === 'audio');
  if (streams.length !== 1 || probe.streams.some((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)) {
    throw new ServiceError('Register a standalone music file with exactly one audio stream and no video footage. Embedded cover artwork is allowed; source-video soundtracks are not used.', 422);
  }
  const stream = streams[0]!;
  const timeBase = stream.time_base ? parseRate(stream.time_base) : null;
  const durationSeconds = stream.duration_ts !== undefined && timeBase ? stream.duration_ts * timeBase.numerator / timeBase.denominator : Number(stream.duration ?? probe.format?.duration);
  const metadata = audioAssetSchema.shape.metadata.safeParse({
    codec: stream.codec_name, sampleRate: Number(stream.sample_rate), channels: stream.channels, durationSeconds,
    frameCount: Math.floor(durationSeconds * PROJECT_FPS.numerator / PROJECT_FPS.denominator),
  });
  if (!metadata.success) throw new ServiceError('Music must expose a codec, sample rate, channel count and a finite duration of at least one project frame.', 422);
  return metadata.data;
}

/** A fixed-size reducer for interleaved stereo PCM16 at 48 kHz, including split bytes. */
export class PcmPeakReducer {
  readonly #peaks: Float64Array;
  readonly #expectedSamples: number;
  #samples = 0;
  #pendingByte: number | null = null;
  constructor(durationSeconds: number) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new ServiceError('Waveform duration must be finite and positive.', 422);
    this.#peaks = new Float64Array(Math.min(MAX_PEAKS, Math.max(1, Math.ceil(durationSeconds * 100))));
    this.#expectedSamples = durationSeconds * SAMPLE_RATE * CHANNELS;
  }
  #consume(sample: number): void {
    const index = Math.min(this.#peaks.length - 1, Math.floor(this.#samples / this.#expectedSamples * this.#peaks.length));
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
    if (this.#pendingByte !== null || this.#samples % CHANNELS !== 0) throw new ServiceError('Decoded music ended with an incomplete PCM sample frame.', 422);
    return Array.from(this.#peaks);
  }
}

/** Stream PCM through the reducer: stdout is never accumulated, regardless of duration. */
function sampleWaveform(config: ServiceConfig, filename: string, durationSeconds: number, signal: AbortSignal): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ServiceError('Job cancelled.', 499)); return; }
    const reducer = new PcmPeakReducer(durationSeconds);
    const child = spawn(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '2', '-i', filename,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      '-c:a', 'pcm_s16le', '-threads', '2', '-filter_threads', '2', '-f', 's16le', 'pipe:1',
    ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
      if (killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    };
    const cleanUp = (): void => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
    };
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => reducer.add(chunk));
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_768); });
    child.once('error', (error) => { cleanUp(); reject(new ServiceError(`Cannot start ${config.ffmpeg}: ${error.message}`, 503)); });
    child.once('close', (code) => {
      cleanUp();
      if (signal.aborted) { reject(new ServiceError('Job cancelled.', 499)); return; }
      if (code !== 0) { reject(new ServiceError(`${config.ffmpeg} waveform decoder exited ${code}: ${stderr.trim()}`, 422)); return; }
      try { resolve(reducer.finish()); } catch (error) { reject(error); }
    });
  });
}

function verifyPlayback(metadata: AudioAsset['metadata'], original: AudioAsset['metadata']): void {
  if (metadata.codec !== 'aac' || metadata.sampleRate !== SAMPLE_RATE || metadata.channels !== CHANNELS || Math.abs(metadata.durationSeconds - original.durationSeconds) > 0.1) {
    throw new ServiceError('Prepared music differs from the required AAC 48 kHz stereo profile or source duration.', 422);
  }
}

export class AudioLibrary {
  readonly #assets = new Map<string, AudioAsset>();
  readonly #writer = new SerialWriter();
  readonly #operations = new SerialWriter();
  readonly #preparing = new Map<string, string>();
  constructor(readonly config: ServiceConfig, readonly jobs: JobQueue) { }

  async initialise(): Promise<void> {
    await this.#operations.run(async () => {
      const filename = path.join(this.config.dataDir, 'audio.json');
      let saved: z.infer<typeof registrySchema>;
      let changed = false;
      try {
        if (!(await assertNoSymlinks(filename)).isFile()) throw new ServiceError('The audio registry must be a regular file.', 422);
        saved = registrySchema.parse(JSON.parse(await readFile(filename, 'utf8')));
      } catch (error) {
        if (!isNotFound(error)) throw new ServiceError(`Cannot read the audio registry: ${errorMessage(error)} Restore the registry or choose a new cache directory; the existing file was not changed.`, 422);
        saved = { version: 1, assets: [] };
        changed = true;
      }
      for (const asset of saved.assets) {
        if (asset.status === 'queued' || asset.status === 'preparing') {
          asset.status = 'error'; asset.error = 'Audio preparation interrupted. Retry preparation explicitly.'; asset.waveform = [];
          changed = true;
        }
        this.#assets.set(asset.id, asset);
      }
      if (changed) await this.#save();
    });
  }
  list(): AudioAsset[] { return [...this.#assets.values()].map((asset) => audioAssetSchema.parse(asset)); }
  get(id: string): AudioAsset {
    const asset = this.#assets.get(idSchema.parse(id));
    if (!asset) throw new ServiceError('Registered music not found.', 404);
    return audioAssetSchema.parse(asset);
  }
  assetDir(asset: AudioAsset): string {
    const registered = this.get(asset.id);
    return path.join(this.config.dataDir, 'audio-assets', registered.fingerprint.digest, AUDIO_PROFILE);
  }
  playbackPath(asset: AudioAsset): string { return path.join(this.assetDir(asset), 'playback.m4a'); }
  async assertReady(id: string): Promise<AudioAsset> {
    const asset = this.get(id);
    const reason = asset.error ? ' ' + asset.error : '';
    if (asset.status !== 'ready' || asset.waveform.length === 0) throw new ServiceError(`Music is not prepared and ready. Retry preparation explicitly.${reason}`, 409);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
    try {
      if (!(await assertNoSymlinks(this.playbackPath(asset))).isFile()) throw new ServiceError('Prepared music must be a regular cache file.', 422);
    } catch (error) {
      if (isNotFound(error)) throw new ServiceError('The prepared music cache is missing. Retry preparation explicitly.', 409);
      throw error;
    }
    return asset;
  }
  async #save(): Promise<void> {
    await this.#writer.run(() => atomicWrite(path.join(this.config.dataDir, 'audio.json'), `${JSON.stringify({ version: 1, assets: this.list() }, null, 2)}\n`));
  }
  async register(filename: string): Promise<{ asset: AudioAsset; job: MediaJob }> {
    const sourcePath = path.resolve(sourcePathSchema.parse(filename));
    return this.#operations.run(async () => {
      assertCacheOutsideSource(path.dirname(sourcePath), this.config.dataDir);
      const fingerprint = await fingerprintFile(sourcePath);
      const id = `audio-${fingerprint.digest.slice(0, 32)}`;
      if (!this.#assets.has(id)) {
        const metadata = await probeAudio(this.config, sourcePath);
        await assertSourceIdentity(sourcePath, fingerprint, true);
        this.#assets.set(id, audioAssetSchema.parse({ id, name: path.basename(sourcePath), sourcePath, fingerprint, metadata, status: 'registered', error: null, waveform: [] }));
        try { await this.#save(); } catch (error) { this.#assets.delete(id); throw error; }
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
    const snapshot = this.get(id);
    assertCacheOutsideSource(path.dirname(snapshot.sourcePath), this.config.dataDir);
    await assertSourceIdentity(snapshot.sourcePath, snapshot.fingerprint, true);
    const current = this.#assets.get(id)!;
    current.status = 'queued'; current.error = null; current.waveform = [];
    try { await this.#save(); }
    catch (error) { current.status = snapshot.status; current.error = snapshot.error; current.waveform = snapshot.waveform; throw error; }
    const job = this.jobs.submit('audio', snapshot.name, async (context) => {
      assertNotCancelled(context.signal);
      current.status = 'preparing'; await this.#save();
      const waveform = await this.#prepareAsset(snapshot, context);
      assertNotCancelled(context.signal);
      current.waveform = waveform;
    }, async (finished) => this.#operations.run(async () => {
      current.status = finished.state === 'completed' ? 'ready' : 'error';
      current.error = finished.state === 'completed' ? null : finished.message;
      if (finished.state !== 'completed') current.waveform = [];
      try { await this.#save(); }
      catch (error) { current.status = 'error'; current.error = `Cannot persist audio preparation: ${errorMessage(error)}`; current.waveform = []; throw error; }
      finally { this.#preparing.delete(id); }
    }));
    this.#preparing.set(id, job.id);
    return job;
  }
  async #cachedWaveform(asset: AudioAsset, context: JobContext): Promise<number[] | null> {
    if (asset.status !== 'ready' || asset.waveform.length === 0) return null;
    try {
      context.update(0.1, 'Verifying cached music');
      const metadata = await probeAudio(this.config, this.playbackPath(asset), context.signal);
      verifyPlayback(metadata, asset.metadata);
      return await sampleWaveform(this.config, this.playbackPath(asset), metadata.durationSeconds, context.signal);
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
      if (!(await assertNoSymlinks(playback)).isFile()) throw new ServiceError('Prepared music must be a regular cache file.', 422);
      cached = true;
    } catch (error) { if (!isNotFound(error)) throw error; }
    if (cached) {
      const waveform = await this.#cachedWaveform(asset, context);
      if (waveform) {
        await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
        assertNotCancelled(context.signal);
        context.update(0.99, 'Cached playback and waveform verified');
        return waveform;
      }
    }
    const temporary = path.join(directory, `playback-${idSchema.parse(context.id)}.partial.m4a`);
    let published = false;
    try {
      context.update(0.02, 'Preparing AAC 48 kHz stereo music');
      // Match Web Audio mono duplication and the native export mixer; FFmpeg's
      // implicit upmix would attenuate each channel by 3 dB.
      const upmix = asset.metadata.channels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
      await runProcess(this.config.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-n', '-threads', '2', '-i', asset.sourcePath,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-af', `${upmix}asetpts=PTS-STARTPTS`,
        '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-c:a', 'aac', '-b:a', '192k', '-threads', '2', '-filter_threads', '2',
        '-movflags', '+faststart', '-progress', 'pipe:1', temporary,
      ], {
        signal: context.signal, onProgress: (fields) => {
          const microseconds = Number(fields['out_time_us']);
          if (Number.isFinite(microseconds)) context.update(0.05 + Math.min(0.7, microseconds / 1e6 / asset.metadata.durationSeconds * 0.7), 'Encoding music playback');
        }
      });
      context.update(0.78, 'Verifying audio profile and sampling waveform peaks');
      const metadata = await probeAudio(this.config, temporary, context.signal);
      verifyPlayback(metadata, asset.metadata);
      const waveform = await sampleWaveform(this.config, temporary, metadata.durationSeconds, context.signal);
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
    } finally { await rm(temporary, { force: true }); }
  }
}