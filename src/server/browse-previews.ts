import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { forEachSerial } from '../shared/serial.js';
import type { ServiceConfig } from './config.js';
import { isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';
import { runProcess } from './process.js';
import { ensurePrivateDirectory } from './storage.js';

/** Bump when the rendered image changes, so cached previews are regenerated. */
const PREVIEW_VERSION = 'pascap-browse-preview-v1';
export const PREVIEW_LIMITS = {
  active: 2,
  waiting: 16,
  timeoutMs: 20_000,
  imageBytes: 512 * 1024,
  cached: 4_000,
  failures: 2_000,
} as const;

export interface BrowsePreview {
  image: Buffer;
  tag: string;
}

async function sourceInfo(filename: string): Promise<Stats> {
  try {
    const info = await assertNoSymlinks(filename);
    if (!info.isFile()) throw new ServiceError('Only regular recording files have previews.', 422);
    return info;
  } catch (error) {
    if (isNotFound(error)) throw new ServiceError('The recording is missing or was moved. Refresh the folder.', 404);
    throw error;
  }
}

function identityTag(filename: string, info: Stats): string {
  return createHash('sha256')
    .update([PREVIEW_VERSION, filename, info.dev, info.ino, info.size, info.mtimeMs].join('\0'))
    .digest('hex');
}

/**
 * Small JPEG previews of recordings seen while browsing, read-only and on demand.
 * Each one reads the container index and the keyframe nearest the middle (plus
 * FFmpeg's bounded probe and read-ahead), never the whole original. Nothing is
 * registered or prepared; images are cached in the data directory, not next to footage.
 */
export class BrowsePreviews {
  readonly #directory: string;
  readonly #failures = new Map<string, string>();
  readonly #waiting: (() => void)[] = [];
  #active = 0;
  #stored: number | null = null;
  #pruning: Promise<void> = Promise.resolve();

  constructor(private readonly config: ServiceConfig) {
    this.#directory = path.join(config.dataDir, 'browse-previews');
  }

  /** Changes whenever the file is replaced or modified; also the HTTP entity tag. */
  async tag(filename: string): Promise<string> {
    return identityTag(filename, await sourceInfo(filename));
  }

  async get(filename: string, signal: AbortSignal): Promise<BrowsePreview> {
    const tag = await this.tag(filename);
    const cached = await this.#read(tag);
    if (cached) return { image: cached, tag };
    const failure = this.#failures.get(tag);
    if (failure !== undefined) throw new ServiceError(failure, 422);
    const image = await this.#slot(signal, () => this.#render(filename, tag, signal));
    if ((await this.tag(filename)) !== tag)
      throw new ServiceError('The recording changed while its preview was read. Refresh the folder.', 409);
    await this.#store(tag, image);
    return { image, tag };
  }

  async #slot<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new ServiceError('Preview cancelled.', 499);
    if (this.#active < PREVIEW_LIMITS.active) this.#active++;
    else {
      if (this.#waiting.length >= PREVIEW_LIMITS.waiting)
        throw new ServiceError('Too many previews are being read. Try again shortly.', 503);
      await new Promise<void>((resolve, reject) => {
        const start = (): void => {
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = (): void => {
          this.#waiting.splice(this.#waiting.indexOf(start), 1);
          reject(new ServiceError('Preview cancelled.', 499));
        };
        this.#waiting.push(start);
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter, if any.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }

  async #render(filename: string, tag: string, signal: AbortSignal): Promise<Buffer> {
    const timeout = AbortSignal.timeout(PREVIEW_LIMITS.timeoutMs);
    const options = { signal: AbortSignal.any([signal, timeout]), maxBytes: PREVIEW_LIMITS.imageBytes };
    try {
      const duration = Number(
        (
          await runProcess(
            this.config.ffprobe,
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filename],
            { ...options, maxBytes: 4096 },
          )
        ).toString('utf8'),
      );
      const middle = Number.isFinite(duration) && duration > 0 ? duration / 2 : 0;
      // Demux only keyframes and keep source timestamps, so a clip whose only keyframe
      // precedes the middle still yields that keyframe instead of nothing.
      const image = await runProcess(
        this.config.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-threads',
          '1',
          '-discard',
          'nokey',
          '-noaccurate_seek',
          '-copyts',
          '-ss',
          middle.toFixed(3),
          '-i',
          filename,
          '-map',
          '0:v:0',
          '-an',
          '-sn',
          '-dn',
          '-frames:v',
          '1',
          '-vf',
          'scale=w=320:h=180:force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=pc,format=yuvj420p',
          '-c:v',
          'mjpeg',
          '-q:v',
          '5',
          '-filter_threads',
          '1',
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        options,
      );
      if (image.length === 0) throw new ServiceError('No picture could be decoded from this recording.', 422);
      return image;
    } catch (error) {
      if (signal.aborted) throw new ServiceError('Preview cancelled.', 499);
      let failure = 'No preview: this file could not be decoded as video.';
      if (timeout.aborted) failure = `Reading a preview took longer than ${PREVIEW_LIMITS.timeoutMs / 1000} seconds.`;
      // Only remember answers about the file itself, not a missing FFmpeg or similar.
      else if (!(error instanceof ServiceError && error.statusCode === 422)) throw error;
      if (this.#failures.size >= PREVIEW_LIMITS.failures) this.#failures.delete(this.#failures.keys().next().value!);
      this.#failures.set(tag, failure);
      throw new ServiceError(failure, 422);
    }
  }

  #filename(tag: string): string {
    return path.join(this.#directory, `${tag}.jpg`);
  }

  async #read(tag: string): Promise<Buffer | null> {
    const filename = this.#filename(tag);
    try {
      const info = await assertNoSymlinks(filename);
      if (!info.isFile() || info.size > PREVIEW_LIMITS.imageBytes) return null;
      const image = await readFile(filename);
      // The modification time orders eviction: recently shown previews stay.
      const now = new Date();
      await utimes(filename, now, now).catch(() => undefined);
      return image;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async #store(tag: string, image: Buffer): Promise<void> {
    await ensurePrivateDirectory(this.#directory);
    const temporary = path.join(this.#directory, `${tag}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(image);
      } finally {
        await file.close();
      }
      await rename(temporary, this.#filename(tag));
    } finally {
      await rm(temporary, { force: true });
    }
    this.#stored ??= (await readdir(this.#directory)).length;
    this.#stored++;
    if (this.#stored > PREVIEW_LIMITS.cached) {
      this.#pruning = this.#pruning.then(() => this.#prune());
      await this.#pruning;
    }
  }

  /** Keep the most recently shown previews, down to 90% of the limit. */
  async #prune(): Promise<void> {
    const names = await readdir(this.#directory);
    if (names.length <= PREVIEW_LIMITS.cached) {
      this.#stored = names.length;
      return;
    }
    const entries: { name: string; time: number }[] = [];
    await forEachSerial(names, async (name) => {
      const info = await stat(path.join(this.#directory, name)).catch(() => null);
      if (info?.isFile()) entries.push({ name, time: info.mtimeMs });
    });
    entries.sort((left, right) => left.time - right.time);
    const excess = entries.slice(0, entries.length - Math.floor(PREVIEW_LIMITS.cached * 0.9));
    await forEachSerial(excess, (entry) => rm(path.join(this.#directory, entry.name), { force: true }));
    this.#stored = entries.length - excess.length;
  }
}
