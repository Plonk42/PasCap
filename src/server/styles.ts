import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isStillFilename } from '../shared/footage.js';
import { measureLook } from '../shared/look-match.js';
import { forEachSerial } from '../shared/serial.js';
import {
  MAX_STYLE_REFERENCES,
  MAX_STYLES,
  STYLE_VIDEO_FRAMES,
  stylesFileSchema,
  type Style,
} from '../shared/styles.js';
import { analysisSize, type AnalysisFrame } from '../shared/white-balance.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';
import type { FootageBrowser } from './footage.js';
import { runProcess } from './process.js';
import { atomicWrite } from './storage.js';

const probeSchema = z.looseObject({
  streams: z.array(z.looseObject({ width: z.number().int().positive(), height: z.number().int().positive() })),
  format: z.looseObject({ duration: z.string().optional() }),
});

/** Seconds into a video at which its frames are read: the centers of equal slices. */
export function referenceTimes(duration: number, count = STYLE_VIDEO_FRAMES): number[] {
  return Array.from({ length: count }, (_, index) => ((index + 0.5) * duration) / count);
}

/**
 * Registered styles (#314) in `<dataDir>/styles.json`: each a look measured on the user's finished edits. The
 * references are read in place with FFmpeg, never copied or modified, and only when a style is registered.
 */
export class StyleLibrary {
  readonly #file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Pick<ServiceConfig, 'dataDir' | 'ffmpeg' | 'ffprobe'>,
    private readonly footage: Pick<FootageBrowser, 'validateReferencePath'>,
  ) {
    this.#file = path.join(config.dataDir, 'styles.json');
  }

  /** The registered styles; a registry this build cannot read is reported, never replaced. */
  async list(): Promise<Style[]> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const parsed = stylesFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw new ServiceError(`styles.json cannot be read by this version; it is left unchanged.`, 500);
    return parsed.data.styles;
  }

  async get(id: string): Promise<Style> {
    const style = (await this.list()).find((item) => item.id === id);
    if (!style) throw new ServiceError(`No style ${id} is registered; list them with list_styles.`, 404);
    return style;
  }

  /** Measures the references and registers their look under `name`; one registration at a time. */
  create(name: string, paths: readonly string[]): Promise<Style> {
    if (paths.length < 1 || paths.length > MAX_STYLE_REFERENCES)
      throw new ServiceError(`A style takes 1 to ${MAX_STYLE_REFERENCES} references.`, 400);
    const files = paths.map((filename) => this.footage.validateReferencePath(filename));
    if (new Set(files).size !== files.length) throw new ServiceError('List each reference once.', 400);
    return this.#serial(async () => {
      const styles = await this.list();
      if (styles.length >= MAX_STYLES) throw new ServiceError(`At most ${MAX_STYLES} styles can be registered.`, 409);
      const references: Style['references'] = [];
      const frames: AnalysisFrame[] = [];
      await forEachSerial(files, async (filename) => {
        const read = await this.#referenceFrames(filename);
        references.push({ path: filename, kind: read.kind, frames: read.frames.length });
        frames.push(...read.frames);
      });
      const look = measureLook(frames);
      if (!look) throw new ServiceError('These references are too dark or too uniform to measure.', 422);
      const style: Style = { id: randomUUID(), name, references, look, createdAt: new Date().toISOString() };
      await this.#write([...styles, style]);
      return style;
    });
  }

  remove(id: string): Promise<void> {
    return this.#serial(async () => {
      const styles = await this.list();
      if (!styles.some((style) => style.id === id)) throw new ServiceError(`No style ${id} is registered.`, 404);
      await this.#write(styles.filter((style) => style.id !== id));
    });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(styles: Style[]): Promise<void> {
    await atomicWrite(this.#file, `${JSON.stringify(stylesFileSchema.parse({ version: 1, styles }), null, 2)}\n`);
  }

  /** A reference's frames at the analysis size: a still's one, a video's at the centers of equal slices. */
  async #referenceFrames(filename: string): Promise<{ kind: 'video' | 'still'; frames: AnalysisFrame[] }> {
    const name = path.basename(filename);
    try {
      if (!(await assertNoSymlinks(filename)).isFile()) throw new ServiceError(`${name} is not a file.`, 422);
      const probe = probeSchema.parse(
        JSON.parse(
          (
            await runProcess(this.config.ffprobe, [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_entries',
              'stream=width,height:format=duration',
              '-of',
              'json',
              filename,
            ])
          ).toString('utf8'),
        ),
      );
      const stream = probe.streams[0];
      if (!stream) throw new ServiceError(`${name} has no picture.`, 422);
      const size = analysisSize(stream.width, stream.height);
      if (isStillFilename(name)) return { kind: 'still', frames: [await this.#frame(filename, size, null)] };
      const duration = Number(probe.format.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new ServiceError(`${name} has no duration.`, 422);
      const frames: AnalysisFrame[] = [];
      await forEachSerial(referenceTimes(duration), async (time) => {
        frames.push(await this.#frame(filename, size, time));
      });
      return { kind: 'video', frames };
    } catch (error) {
      if (isNotFound(error)) throw new ServiceError(`${name} is missing.`, 404);
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(`Cannot read ${name}: ${errorMessage(error)}`, 422);
    }
  }

  async #frame(filename: string, size: { width: number; height: number }, time: number | null): Promise<AnalysisFrame> {
    const bytes = size.width * size.height * 4;
    const seek = time === null ? [] : ['-ss', time.toFixed(6)];
    const data = await runProcess(
      this.config.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-threads',
        '2',
        ...seek,
        '-i',
        filename,
        '-frames:v',
        '1',
        '-vf',
        `scale=${size.width}:${size.height}:flags=area+accurate_rnd+full_chroma_int:out_range=pc,format=rgba`,
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { maxBytes: bytes },
    );
    if (data.length !== bytes)
      throw new ServiceError(`${path.basename(filename)} gave no frame at ${time ?? 0} s.`, 422);
    return { ...size, data: new Uint8Array(data) };
  }
}
