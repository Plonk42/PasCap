import type { MediaAsset } from '../shared/media.js';
import { createColourSettings } from '../shared/colour.js';
import { NEUTRAL_DETAIL } from '../shared/detail.js';
import type { LumaFrame } from '../shared/detail-estimate.js';
import type { ProjectDocument } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import { calculateLayout, sampleSlots, sampleTimeline, type TimelineLayout } from '../shared/timeline.js';
import { framesToSeconds } from '../shared/timing.js';
import { analysisSize, type AnalysisFrame } from '../shared/white-balance.js';
import type { AssistantImageBudget, ServiceConfig } from './config.js';
import { ServiceError } from './errors.js';
import type { JobQueue } from './jobs.js';
import { ColourLutCache } from './layered-colour.js';
import { sourceOverGroup } from './layered-export.js';
import { composeLayerFrame, fittedContent, type LayerFrameSource } from './layered-frame.js';
import { CompositorPool } from './layered-pool.js';
import type { MediaLibrary } from './library.js';
import { runProcess } from './process.js';

/** Stills compose at the 720p proxy size, the size the preview shows. */
export const STILL_SIZE = Object.freeze({ width: 1280, height: 720 });
const PIXELS = STILL_SIZE.width * STILL_SIZE.height;
const MAX_IMAGE_BYTES = 1024 * 1024;
/** Calls rendering or waiting their turn. */
const MAX_QUEUED = 16;
const QUEUE_TIMEOUT_MS = 5 * 60_000;
const RENDER_TIMEOUT_MS = 120_000;

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface JpegImage {
  mimeType: 'image/jpeg';
  data: string;
  width: number;
  height: number;
}
type DecodeFrame = (asset: MediaAsset, sourceFrame: number, signal: AbortSignal) => Promise<Buffer>;

/** Exactly proxy frame `sourceFrame`, fitted and padded like the layered export's decode, as RGB8. */
export function proxyFrameArgs(proxy: string, asset: MediaAsset, sourceFrame: number): string[] {
  const bounds = fittedContent(asset.metadata, STILL_SIZE);
  return decodeArgs(
    proxy,
    sourceFrame,
    `scale=${bounds.width}:${bounds.height}:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:` +
      `in_range=tv:out_range=pc,format=rgb24,` +
      `pad=${STILL_SIZE.width}:${STILL_SIZE.height}:${bounds.x}:${bounds.y}:black,setsar=1`,
  );
}

/**
 * Exactly proxy frame `sourceFrame` for analysis: RGBA at the size the editor reads it (`analysisSize`), as
 * the browser draws a decoded frame into a canvas, or full-range luma at the proxy's own size.
 */
export function analysisFrameArgs(
  proxy: string,
  size: { width: number; height: number },
  sourceFrame: number,
  format: 'rgba' | 'gray',
): string[] {
  // Full chroma interpolation with accurate rounding comes closest to the browser's canvas readback.
  return decodeArgs(
    proxy,
    sourceFrame,
    `scale=${size.width}:${size.height}:flags=area+accurate_rnd+full_chroma_int:` +
      `in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=${format}`,
  );
}

function decodeArgs(proxy: string, sourceFrame: number, filter: string): string[] {
  // A quarter frame early: accurate seeking keeps the first frame at or after the time, never one later.
  const seek = sourceFrame > 0 ? ['-ss', framesToSeconds(sourceFrame - 0.25).toFixed(9)] : [];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-threads',
    '2',
    ...seek,
    '-i',
    proxy,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-an',
    '-vf',
    filter,
    '-f',
    'rawvideo',
    'pipe:1',
  ];
}

export interface ComposeContext {
  assetOf: (mediaId: string) => MediaAsset;
  decode: DecodeFrame;
  cache: ColourLutCache;
  signal: AbortSignal;
  pool?: CompositorPool | null;
  /** Without any Colour or clip Detail, as the editor's Original preview: geometry, Opacity and fades remain. */
  ungraded?: boolean;
}

/**
 * Project frame `frame` as the layered export composes it: each enabled track one group,
 * source-over the tracks below, over opaque black; returns premultiplied RGBA16.
 * With a pool, every frame buffer is shared memory, as the workers require.
 */
export async function composeProjectFrame(
  document: ProjectDocument,
  layout: TimelineLayout,
  frame: number,
  { assetOf, decode, cache, signal, pool = null, ungraded = false }: ComposeContext,
): Promise<Buffer> {
  const allocate = (bytes: number): Buffer => (pool ? Buffer.from(new SharedArrayBuffer(bytes)) : Buffer.alloc(bytes));
  const shared = (frame: Buffer): Buffer => {
    if (!pool) return frame;
    const copy = allocate(frame.length);
    frame.copy(copy);
    return copy;
  };
  const accumulator = allocate(PIXELS * 8);
  const group = allocate(PIXELS * 8);
  const samples = sampleTimeline(document, frame, layout).map((sample) =>
    ungraded
      ? { ...sample, grade: createColourSettings(), colour: createColourSettings(), detail: { ...NEUTRAL_DETAIL } }
      : sample,
  );
  const slots = sampleSlots(document, frame, layout);
  // A timeslot draws geometry and coverage only: brightness 0 never reads its pixels.
  const blank = allocate(PIXELS * 3);
  const source = (sample: LayerFrameSource['sample'], rgb: Buffer): LayerFrameSource => {
    const { width, height } = assetOf(sample.mediaId).metadata;
    return { sample, rgb, original: { width, height }, bounds: fittedContent({ width, height }, STILL_SIZE) };
  };
  await forEachSerial(document.layers, async (layer) => {
    const sources: LayerFrameSource[] = [];
    await forEachSerial(
      samples.filter((sample) => sample.layerId === layer.id),
      async (sample) => {
        const decoded = await decode(assetOf(sample.mediaId), sample.sourceFrame, signal);
        sources.push(source(sample, shared(decoded)));
      },
    );
    sources.push(...slots.filter((sample) => sample.layerId === layer.id).map((sample) => source(sample, blank)));
    if (!sources.length) return;
    group.fill(0);
    await composeLayerFrame(group, STILL_SIZE, sources, cache, signal, pool);
    await sourceOverGroup(accumulator, group, signal);
  });
  return accumulator;
}

/** Drops coverage: over opaque black, premultiplied RGB is the picture. */
export function rgba16ToRgb8(frame: Buffer): Buffer {
  const input = new Uint16Array(frame.buffer, frame.byteOffset, frame.length / 2);
  const output = Buffer.alloc((input.length / 4) * 3);
  for (let pixel = 0, offset = 0; offset < input.length; pixel += 3, offset += 4) {
    output[pixel] = Math.round(input[offset]! / 257);
    output[pixel + 1] = Math.round(input[offset + 1]! / 257);
    output[pixel + 2] = Math.round(input[offset + 2]! / 257);
  }
  return output;
}

export function cropRgb8(frame: Buffer, crop: Crop): Buffer {
  if (crop.x + crop.width > STILL_SIZE.width || crop.y + crop.height > STILL_SIZE.height)
    throw new ServiceError(`The crop must lie within the ${STILL_SIZE.width} × ${STILL_SIZE.height} composition.`, 422);
  const output = Buffer.alloc(crop.width * crop.height * 3);
  for (let row = 0; row < crop.height; row++) {
    const start = ((crop.y + row) * STILL_SIZE.width + crop.x) * 3;
    frame.copy(output, row * crop.width * 3, start, start + crop.width * 3);
  }
  return output;
}

/** Columns and rows of a contact sheet: as square as possible, filled row by row. */
export function sheetGrid(cells: number): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(cells));
  return { columns, rows: Math.ceil(cells / columns) };
}

const SHEET_PADDING = 4;

function scaledHeight(width: number, source: { width: number; height: number }): number {
  return Math.max(2, Math.round((source.height * width) / source.width / 2) * 2);
}

/** Serial still and contact-sheet rendering from verified proxies; never decodes an original. */
export class StillRenderer {
  readonly #cache = new ColourLutCache();
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  constructor(
    private readonly config: Pick<ServiceConfig, 'ffmpeg'>,
    private readonly library: Pick<MediaLibrary, 'get' | 'proxyPath'>,
    private readonly jobs: Pick<JobQueue, 'list'>,
  ) {}

  /**
   * One render at a time; up to MAX_QUEUED calls wait their turn, each at most QUEUE_TIMEOUT_MS before it starts.
   * Refused while an export or reference job runs.
   */
  #run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const busy = this.jobs
      .list()
      .find((job) => job.state === 'running' && (job.kind === 'export' || job.kind === 'reference'));
    if (busy) throw new ServiceError(`Pictures wait while “${busy.label}” renders; try again when it finishes.`, 409);
    if (this.#pending >= MAX_QUEUED)
      throw new ServiceError(
        `${MAX_QUEUED} pictures and estimates are already rendering or waiting, one at a time; try again when one finishes.`,
        503,
      );
    this.#pending++;
    const late = () =>
      new ServiceError(
        `Waited ${QUEUE_TIMEOUT_MS / 60_000} minutes behind other pictures and estimates, which render one at a time; try again.`,
        503,
      );
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(late());
      }, QUEUE_TIMEOUT_MS);
    });
    const result = this.#tail.then(() => {
      clearTimeout(timer);
      if (expired) throw late();
      return task(AbortSignal.timeout(RENDER_TIMEOUT_MS));
    });
    this.#tail = result.catch(() => undefined);
    return Promise.race([result, timedOut]).finally(() => {
      this.#pending--;
    });
  }

  readyAsset(mediaId: string): MediaAsset {
    const asset = this.library.get(mediaId);
    if (asset.status !== 'ready' || !asset.prepared)
      throw new ServiceError(`Recording ${asset.name} has no verified proxy yet; prepare it first.`, 409);
    return asset;
  }

  readonly #decode: DecodeFrame = async (asset, sourceFrame, signal) =>
    this.#decodeRaw(
      asset,
      sourceFrame,
      proxyFrameArgs(this.library.proxyPath(asset), asset, sourceFrame),
      PIXELS * 3,
      signal,
    );

  async #decodeRaw(
    asset: MediaAsset,
    sourceFrame: number,
    args: string[],
    bytes: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (sourceFrame >= asset.metadata.frameCount)
      throw new ServiceError(`Recording ${asset.name} has ${asset.metadata.frameCount} frames.`, 422);
    const raw = await runProcess(this.config.ffmpeg, args, { signal, maxBytes: bytes });
    if (raw.length !== bytes)
      throw new ServiceError(`The proxy of ${asset.name} did not deliver source frame ${sourceFrame}.`, 500);
    return raw;
  }

  /** RGB8 compositions of project frames, decoded from the proxies of the clips they show. */
  async #projectFrames(
    document: ProjectDocument,
    frames: readonly number[],
    signal: AbortSignal,
    ungraded = false,
  ): Promise<Buffer[]> {
    const layout = calculateLayout(document);
    const outside = frames.find((frame) => frame >= layout.duration);
    if (outside !== undefined)
      throw new ServiceError(`Frame ${outside} is outside the project, which has ${layout.duration} frames.`, 422);
    const pictures: Buffer[] = [];
    // Local tone and Detail cost about 3 s per 720p frame in process, 1 s on the pool.
    const pool = CompositorPool.forHost();
    try {
      await forEachSerial(frames, async (frame) => {
        const composed = await composeProjectFrame(document, layout, frame, {
          assetOf: (mediaId) => this.readyAsset(mediaId),
          decode: this.#decode,
          cache: this.#cache,
          signal,
          pool,
          ungraded,
        });
        pictures.push(rgba16ToRgb8(composed));
      });
    } finally {
      await pool?.close();
    }
    return pictures;
  }

  async #encode(
    pictures: readonly Buffer[],
    size: { width: number; height: number },
    cellWidth: number,
    signal: AbortSignal,
    columnCount?: number,
  ): Promise<JpegImage> {
    const cellHeight = scaledHeight(cellWidth, size);
    const { columns, rows } = columnCount
      ? { columns: columnCount, rows: Math.ceil(pictures.length / columnCount) }
      : sheetGrid(pictures.length);
    const tiled = pictures.length > 1;
    const filters = [`scale=${cellWidth}:${cellHeight}:flags=area`];
    if (tiled) filters.push(`tile=${columns}x${rows}:padding=${SHEET_PADDING}:color=black`);
    const jpeg = await runProcess(
      this.config.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        `${size.width}x${size.height}`,
        '-i',
        'pipe:0',
        '-vf',
        filters.join(','),
        '-frames:v',
        '1',
        '-c:v',
        'mjpeg',
        '-pix_fmt',
        'yuvj420p',
        '-q:v',
        '4',
        '-f',
        'image2',
        'pipe:1',
      ],
      { signal, input: Buffer.concat(pictures), maxBytes: MAX_IMAGE_BYTES },
    );
    return {
      mimeType: 'image/jpeg',
      data: jpeg.toString('base64'),
      width: tiled ? columns * cellWidth + (columns - 1) * SHEET_PADDING : cellWidth,
      height: tiled ? rows * cellHeight + (rows - 1) * SHEET_PADDING : cellHeight,
    };
  }

  /** One project frame at `width`, or a 1:1 crop of its composition. */
  still(document: ProjectDocument, frame: number, width: number, crop: Crop | null): Promise<JpegImage> {
    return this.#run(async (signal) => {
      const [picture] = await this.#projectFrames(document, [frame], signal);
      if (!crop) return this.#encode([picture!], STILL_SIZE, width, signal);
      return this.#encode([cropRgb8(picture!, crop)], crop, crop.width, signal);
    });
  }

  /** The same frame of two versions side by side in one picture, each at `width` or as a 1:1 crop. */
  comparison(
    sides: readonly [
      { document: ProjectDocument; ungraded: boolean },
      { document: ProjectDocument; ungraded: boolean },
    ],
    frame: number,
    width: number,
    crop: Crop | null,
  ): Promise<JpegImage> {
    return this.#run(async (signal) => {
      const pictures: Buffer[] = [];
      await forEachSerial(sides, async ({ document, ungraded }) => {
        const [picture] = await this.#projectFrames(document, [frame], signal, ungraded);
        pictures.push(crop ? cropRgb8(picture!, crop) : picture!);
      });
      return crop
        ? this.#encode(pictures, crop, crop.width, signal, 2)
        : this.#encode(pictures, STILL_SIZE, width, signal, 2);
    });
  }

  /** A contact sheet of project frames; a single frame renders at `stillWidth`. */
  timelineSheet(
    document: ProjectDocument,
    frames: readonly number[],
    budget: AssistantImageBudget,
  ): Promise<JpegImage> {
    return this.#run(async (signal) => {
      const pictures = await this.#projectFrames(document, frames, signal);
      return this.#encode(pictures, STILL_SIZE, frames.length > 1 ? budget.sheetCellWidth : budget.stillWidth, signal);
    });
  }

  /** A contact sheet of a recording's proxy frames, without track appearance. */
  recordingSheet(mediaId: string, frames: readonly number[], budget: AssistantImageBudget): Promise<JpegImage> {
    return this.#run(async (signal) => {
      const asset = this.readyAsset(mediaId);
      const pictures: Buffer[] = [];
      await forEachSerial(frames, async (frame) => {
        pictures.push(await this.#decode(asset, frame, signal));
      });
      return this.#encode(pictures, STILL_SIZE, frames.length > 1 ? budget.sheetCellWidth : budget.stillWidth, signal);
    });
  }

  /** Proxy frames of several recordings in one sheet, `columns` per row (else a square grid). */
  sourceSheet(
    cells: readonly { mediaId: string; frame: number }[],
    columns: number | null,
    budget: AssistantImageBudget,
  ): Promise<JpegImage> {
    return this.#run(async (signal) => {
      const pictures: Buffer[] = [];
      await forEachSerial(cells, async ({ mediaId, frame }) => {
        pictures.push(await this.#decode(this.readyAsset(mediaId), frame, signal));
      });
      const width = cells.length > 1 ? budget.sheetCellWidth : budget.stillWidth;
      return this.#encode(pictures, STILL_SIZE, width, signal, columns ?? undefined);
    });
  }

  /** Each distinct source frame of a recording's proxy as the editor's analyses read it, in RGBA. */
  analysisFrames(mediaId: string, sourceFrames: readonly number[]): Promise<Map<number, AnalysisFrame>> {
    return this.#run(async (signal) => {
      const asset = this.readyAsset(mediaId);
      const { width, height } = analysisSize(asset.prepared!.width, asset.prepared!.height);
      const frames = new Map<number, AnalysisFrame>();
      await forEachSerial([...new Set(sourceFrames)], async (frame) => {
        const args = analysisFrameArgs(this.library.proxyPath(asset), { width, height }, frame, 'rgba');
        const data = await this.#decodeRaw(asset, frame, args, width * height * 4, signal);
        frames.set(frame, { width, height, data });
      });
      return frames;
    });
  }

  /** Source frames of a recording's proxy as full-range luma at the proxy's size. */
  lumaFrames(mediaId: string, sourceFrames: readonly number[]): Promise<LumaFrame[]> {
    return this.#run(async (signal) => {
      const asset = this.readyAsset(mediaId);
      const size = { width: asset.prepared!.width, height: asset.prepared!.height };
      const frames: LumaFrame[] = [];
      await forEachSerial(sourceFrames, async (frame) => {
        const args = analysisFrameArgs(this.library.proxyPath(asset), size, frame, 'gray');
        const data = await this.#decodeRaw(asset, frame, args, size.width * size.height, signal);
        frames.push({ ...size, data });
      });
      return frames;
    });
  }
}
