import { rename, rm } from 'node:fs/promises';
import { endianness } from 'node:os';
import path from 'node:path';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  LAYERED_EXPORT_RESOURCES,
  planLayeredExport,
  type ExportChunk,
  type ExportProfileSettings,
  type LayeredExportLayer,
  type LayeredExportPlan,
} from '../shared/export.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import type { Retiming } from '../shared/speed.js';
import { calculateLayout, sampleTimeline, type PlacedClip, type PreviewLayer } from '../shared/timeline.js';
import { framesToSeconds } from '../shared/timing.js';
import { ServiceError } from './errors.js';
import { assertSourceIdentity } from './files.js';
import type { JobContext } from './jobs.js';
import { ColourLutCache, checkLayeredCancellation } from './layered-colour.js';
import { composeLayerFrame, fittedContent, type LayerFrameSource } from './layered-frame.js';
import { CompositorPool } from './layered-pool.js';
import { runProcess } from './process.js';
import { runRawVideoPass, writeRawFrame, type RawFrameReader, type RawPassReport } from './raw-process.js';
import { retimeRawVideo, type RawRetimingReport } from './retime-process.js';
import { atomicWrite } from './storage.js';

const BASE = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
const FPS = '30000/1001';
const CLOCK = 'settb=expr=1/30000,setpts=N*1001';
const RGB_TAGS = 'setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=gbr';
const seconds = (frame: number): string => framesToSeconds(frame).toFixed(12);

export interface LayeredExportOptions {
  document: ProjectDocument;
  plan: LayeredExportPlan;
  /** Same flat order as document.clips, including every disabled-layer reference. */
  assets: readonly MediaAsset[];
  ffmpeg: string;
  directory: string;
  target: Readonly<ExportProfileSettings>;
  context: JobContext;
}
export interface LayeredRenderReport {
  renderedClipIds: string[];
  skippedLayerIds: string[];
  /** One independently graded premultiplied group per enabled, populated track. */
  layerPasses: number;
  /** Subsequent groups source-over the lower accumulator without grading again. */
  sourceOverPasses: number;
  originalDecoderProcesses: number;
  nativeVideoProcesses: number;
  peakOriginalVideoDecoders: number;
  peakIntermediateVideoDecoders: number;
  peakVideoEncoders: number;
  peakNativeVideoChildren: number;
  peakLosslessClipFiles: number;
  /** A chunk collection totaling one timeline counts as one representation. */
  peakLosslessTimelineRepresentations: number;
  rawFrameBuffers: number;
  rawBufferBytes: number;
  largestReadChunkBytes: number;
  peakLutEntries: number;
  lutBytes: number;
  lutsGenerated: number;
  lutGenerationMs: number;
  compositeFrames: number;
  compositePixels: number;
  compositionMs: number;
  elapsedMs: number;
}
export interface LayeredRenderResult {
  filename: string;
  retiming: RawRetimingReport[];
  report: LayeredRenderReport;
}
interface ClipReader {
  index: number;
  filename: string;
  offset: number;
}
interface RetainedClip {
  index: number;
  filename: string;
}
interface Span {
  start: number;
  duration: number;
}
interface LosslessChunk {
  filename: string;
  duration: number;
}

function trackReaders(
  chunk: ExportChunk,
  index: number,
  filename: string,
  retained: RetainedClip | null,
): ClipReader[] {
  if (chunk.kind === 'body') {
    if (chunk.clipIndex !== index) throw new Error('Track body references a different clip.');
    return [{ index, filename, offset: chunk.sourceIn }];
  }
  if (chunk.rightIndex !== index || retained?.index !== chunk.leftIndex)
    throw new Error('Track dissolve lost its retained left clip.');
  return [
    { index: retained.index, filename: retained.filename, offset: chunk.leftIn },
    { index, filename, offset: 0 },
  ];
}

function* frameIndices(count: number): Generator<number> {
  for (let index = 0; index < count; index++) yield index;
}

/** The same four raw buffers, shareable with compositor workers instead of copied. */
function sharedFrame(bytes: number): Buffer {
  return Buffer.from(new SharedArrayBuffer(bytes));
}

/** Already graded/premultiplied RGBA16 groups: apply coverage once, never a second LUT. */
async function sourceOverGroup(lower: Buffer, group: Buffer, signal: AbortSignal): Promise<void> {
  checkLayeredCancellation(signal);
  if (
    lower.length !== group.length ||
    lower.length % 8 !== 0 ||
    lower.byteOffset % 2 !== 0 ||
    group.byteOffset % 2 !== 0
  )
    throw new Error('Invalid RGBA16 group frames.');
  const output = new Uint16Array(lower.buffer, lower.byteOffset, lower.length / 2);
  const above = new Uint16Array(group.buffer, group.byteOffset, group.length / 2);
  const batchSize = 65_536 * 4;
  await forEachSerial(frameIndices(Math.ceil(output.length / batchSize)), async (batch) => {
    checkLayeredCancellation(signal);
    const end = Math.min(output.length, (batch + 1) * batchSize);
    for (let offset = batch * batchSize; offset < end; offset += 4) {
      const keep = 1 - above[offset + 3]! / 65535;
      for (let channel = 0; channel < 4; channel++)
        output[offset + channel] = Math.round(above[offset + channel]! + output[offset + channel]! * keep);
    }
    await yieldToEvents();
    checkLayeredCancellation(signal);
  });
}

/** Decode/scale tagged original BT.709 BEFORE any CPU grade, once per clip instance. */
export function layeredDecodeFilter(
  clip: ProjectDocument['clips'][number],
  asset: MediaAsset,
  target: Readonly<ExportProfileSettings>,
): string {
  const bounds = fittedContent(asset.metadata, target);
  return (
    `trim=start_frame=${clip.sourceIn}:end_frame=${clip.sourceOut},setpts=PTS-STARTPTS,` +
    `scale=${bounds.width}:${bounds.height}:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:` +
    `in_range=${asset.metadata.colourRange}:out_range=pc,format=rgb24,` +
    `pad=${target.width}:${target.height}:${bounds.x}:${bounds.y}:black,setsar=1`
  );
}

function losslessEncoder(target: Readonly<ExportProfileSettings>, filename: string, alpha: boolean): string[] {
  const raw = alpha ? 'rgba64le' : 'rgb24';
  const native = alpha ? 'gbrap16le' : 'bgr0';
  return [
    ...BASE,
    '-f',
    'rawvideo',
    '-pixel_format',
    raw,
    '-video_size',
    `${target.width}x${target.height}`,
    '-framerate',
    FPS,
    '-threads',
    '2',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-filter_threads',
    '2',
    '-vf',
    `format=${alpha ? 'gbrap16le' : 'gbrp'},setsar=1,${CLOCK},${RGB_TAGS}`,
    '-fps_mode',
    'passthrough',
    '-enc_time_base',
    '1:30000',
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-coder',
    '1',
    '-context',
    '1',
    '-slicecrc',
    '1',
    '-g',
    '1',
    '-pix_fmt',
    native,
    '-threads',
    '2',
    '-f',
    'nut',
    filename,
  ];
}

/** FFV1 is all-intra. Exact input seek avoids decoding a growing prefix for each span. */
function losslessReader(filename: string, offset: number, duration: number, alpha: boolean): string[] {
  // FFmpeg seeks use microsecond precision. Rounding an exact rational frame
  // timestamp upward can discard that frame, including the last dissolve tail.
  // Seek strictly between the preceding/current PTS; accurate_seek discards
  // the preceding frame, and trim uses exact decoded frame counts thereafter.
  const seek = Math.max(0, framesToSeconds(offset) - framesToSeconds(1) / 4).toFixed(12);
  return [
    ...BASE,
    '-xerror',
    '-err_detect',
    'explode',
    '-threads',
    '2',
    ...(offset ? ['-ss', seek] : []),
    '-i',
    filename,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-filter_threads',
    '2',
    '-vf',
    `trim=end_frame=${duration},setpts=PTS-STARTPTS,format=${alpha ? 'rgba64le' : 'rgb24'}`,
    '-frames:v',
    String(duration),
    '-fps_mode',
    'passthrough',
    '-c:v',
    'rawvideo',
    '-pix_fmt',
    alpha ? 'rgba64le' : 'rgb24',
    '-threads',
    '2',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
}

/**
 * Every track's bodies/dissolves -> premultiplied RGBA16 chunks -> one group.
 * Each subsequent group source-overs the lower accumulator in a separate pass.
 * Lower + group chunks + joined group, or lower + group + output, are explicitly
 * three timeline representations; delete inputs as soon as their pass finishes.
 * At most two retained RGB clip files; no all-project decoder/filter graph.
 */
class SequentialLayeredRenderer {
  readonly #layout;
  readonly #cache = new ColourLutCache();
  readonly #rgba: readonly [Buffer, Buffer];
  readonly #rgb: readonly [Buffer, Buffer];
  readonly #retiming: RawRetimingReport[] = [];
  readonly #report: LayeredRenderReport;
  readonly #totalWork: number;
  #pool: CompositorPool | null = null;
  #finishedWork = 0;
  #progress = 0.04;
  #clipFiles = 0;
  #timelines = 0;
  #spanId = 0;
  constructor(private readonly options: LayeredExportOptions) {
    const { target, document, plan } = options;
    const pixels = target.width * target.height;
    if (
      !Number.isSafeInteger(pixels) ||
      target.width < 2 ||
      target.height < 2 ||
      target.width % 2 ||
      target.height % 2 ||
      pixels > 3840 * 2160
    ) {
      throw new ServiceError('Layered export dimensions must be even and bounded by UHD.', 422);
    }
    if (endianness() !== 'LE')
      throw new ServiceError('The native RGBA16 compositor requires a little-endian Linux host.', 422);
    this.#layout = calculateLayout(document);
    if (!isDeepStrictEqual(plan, planLayeredExport(document)) || options.assets.length !== document.clips.length)
      throw new ServiceError('Layered inputs differ from their captured timeline.', 500);
    if (
      options.assets.some(
        (asset, index) =>
          asset.id !== document.clips[index]!.mediaId || document.clips[index]!.sourceOut > asset.metadata.frameCount,
      )
    )
      throw new ServiceError('Layered inputs differ from their registered original identities or source bounds.', 422);
    this.#rgba = [sharedFrame(pixels * 8), sharedFrame(pixels * 8)];
    this.#rgb = [sharedFrame(pixels * 3), sharedFrame(pixels * 3)];
    this.#report = {
      renderedClipIds: [],
      skippedLayerIds: document.layers.filter((layer) => !layer.enabled).map((layer) => layer.id),
      layerPasses: 0,
      sourceOverPasses: 0,
      originalDecoderProcesses: 0,
      nativeVideoProcesses: 0,
      peakOriginalVideoDecoders: 0,
      peakIntermediateVideoDecoders: 0,
      peakVideoEncoders: 0,
      peakNativeVideoChildren: 0,
      peakLosslessClipFiles: 0,
      peakLosslessTimelineRepresentations: 0,
      rawFrameBuffers: this.#rgb.length + this.#rgba.length,
      rawBufferBytes: [...this.#rgb, ...this.#rgba].reduce((sum, buffer) => sum + buffer.length, 0),
      largestReadChunkBytes: 0,
      peakLutEntries: 0,
      lutBytes: 0,
      lutsGenerated: 0,
      lutGenerationMs: 0,
      compositeFrames: 0,
      compositePixels: 0,
      compositionMs: 0,
      elapsedMs: 0,
    };
    const active = plan.layers.filter((layer) => layer.enabled && layer.clips.length > 0);
    this.#totalWork =
      active.reduce((sum, layer) => sum + layer.clips.reduce((frames, clip) => frames + clip.duration, 0), 0) +
      plan.duration * Math.max(1, 2 * active.length - 1);
    if (
      this.#report.rawFrameBuffers !== LAYERED_EXPORT_RESOURCES.rawFrameBuffers ||
      this.#report.rawBufferBytes !== pixels * LAYERED_EXPORT_RESOURCES.rawBytesPerPixel
    )
      throw new Error('Layered raw-buffer allocation differs from the resource contract.');
  }
  private update(frames: number, message: string): void {
    checkLayeredCancellation(this.options.context.signal);
    this.#progress = Math.max(this.#progress, 0.04 + (0.78 * (this.#finishedWork + frames)) / this.#totalWork);
    this.options.context.update(Math.min(0.82, this.#progress), message);
    checkLayeredCancellation(this.options.context.signal);
  }
  private timeline(delta: number): void {
    this.#timelines += delta;
    if (this.#timelines < 0 || this.#timelines > LAYERED_EXPORT_RESOURCES.maxLosslessTimelineRepresentations)
      throw new Error('Layered timeline scratch bound exceeded.');
    this.#report.peakLosslessTimelineRepresentations = Math.max(
      this.#report.peakLosslessTimelineRepresentations,
      this.#timelines,
    );
  }
  private recordPass(report: RawPassReport): void {
    if (
      report.peakReaders > LAYERED_EXPORT_RESOURCES.maxIntermediateVideoDecoders ||
      report.peakEncoders > LAYERED_EXPORT_RESOURCES.maxVideoEncoders ||
      report.peakChildren > LAYERED_EXPORT_RESOURCES.maxNativeVideoChildrenPerPass
    )
      throw new Error('Layered native pass exceeded its reader/encoder/child bound.');
    this.#report.peakIntermediateVideoDecoders = Math.max(
      this.#report.peakIntermediateVideoDecoders,
      report.peakReaders,
    );
    this.#report.peakVideoEncoders = Math.max(this.#report.peakVideoEncoders, report.peakEncoders);
    this.#report.peakNativeVideoChildren = Math.max(this.#report.peakNativeVideoChildren, report.peakChildren);
    this.#report.nativeVideoProcesses += report.readerProcesses + report.encoderProcesses;
    this.#report.largestReadChunkBytes = Math.max(this.#report.largestReadChunkBytes, report.largestReadChunkBytes);
  }
  private placed(index: number): PlacedClip {
    const clip = this.options.document.clips[index];
    const placed = clip && this.#layout.clips.find((item) => item.clip.id === clip.id);
    if (!placed) throw new ServiceError('Layered clip has no authoritative placement/retiming map.', 500);
    return placed;
  }
  private async retime(index: number): Promise<string> {
    const { assets, target, ffmpeg, directory, context, plan } = this.options;
    const placed = this.placed(index);
    const clip = placed.clip;
    const planned = plan.clips.find((item) => item.clipId === clip.id);
    if (planned?.index !== index || planned?.duration !== placed.duration)
      throw new ServiceError('Layered clip plan differs from its authoritative contextual duration.', 500);
    const asset = assets[index]!;
    const filename = `clip-${index}.nut`;
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
    this.update(0, `Retiming original layered clip ${clip.id}`);
    if (++this.#clipFiles > LAYERED_EXPORT_RESOURCES.maxLosslessClipsOnDisk)
      throw new Error('Layered clip scratch bound exceeded.');
    this.#report.peakLosslessClipFiles = Math.max(this.#report.peakLosslessClipFiles, this.#clipFiles);
    const report = await retimeRawVideo({
      ffmpeg,
      cwd: directory,
      clip,
      retiming: placed.retiming,
      frameBytes: this.#rgb[0].length,
      frameBuffer: this.#rgb[0],
      signal: context.signal,
      decodeArgs: [
        ...BASE,
        '-xerror',
        '-err_detect',
        'explode',
        '-threads',
        '2',
        '-noautorotate',
        '-i',
        asset.sourcePath,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-filter_threads',
        '2',
        '-vf',
        layeredDecodeFilter(clip, asset, target),
        '-frames:v',
        String(clip.sourceOut - clip.sourceIn),
        '-fps_mode',
        'passthrough',
        '-c:v',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-threads',
        '2',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      encodeArgs: losslessEncoder(target, filename, false),
      onProgress: (frames, total) =>
        this.update(frames, `Retiming original layered clip ${clip.id}: ${frames} / ${total} frames`),
    });
    if (report.outputFrames !== placed.duration || report.decodedFrames !== clip.sourceOut - clip.sourceIn)
      throw new ServiceError('Layered retiming did not emit/decode its exact captured frame counts.', 422);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
    this.#retiming.push(report);
    this.#report.renderedClipIds.push(clip.id);
    this.#report.originalDecoderProcesses++;
    this.#report.nativeVideoProcesses += 2;
    this.#report.peakOriginalVideoDecoders = 1;
    this.#report.peakVideoEncoders = Math.max(1, this.#report.peakVideoEncoders);
    this.#report.peakNativeVideoChildren = Math.max(2, this.#report.peakNativeVideoChildren);
    this.#report.largestReadChunkBytes = Math.max(this.#report.largestReadChunkBytes, report.largestReadChunkBytes);
    this.#finishedWork += report.outputFrames;
    return filename;
  }
  private async removeClip(filename: string): Promise<void> {
    await rm(path.join(this.options.directory, filename));
    if (--this.#clipFiles < 0) throw new Error('Layered clip scratch ledger underflowed.');
  }
  private async readSources(
    clips: readonly ClipReader[],
    readers: readonly RawFrameReader[],
    maps: readonly Retiming[],
    frame: number,
    samples: readonly PreviewLayer[],
  ): Promise<LayerFrameSource[]> {
    const { document, assets, target } = this.options;
    if (samples.length !== clips.length) throw new Error('Layered span does not match the authoritative active clips.');
    const sources: LayerFrameSource[] = [];
    for (const [index, clip] of clips.entries()) {
      await readers[index]!.requireFrame(this.#rgb[index]!); // NOSONAR -- at most two reusable intermediate frames.
      const sourceClip = document.clips[clip.index]!;
      const sample = samples.find((item) => item.clipId === sourceClip.id);
      if (!sample || sample.sourceFrame !== maps[index]!.sourceAt(clip.offset + frame))
        throw new Error('Layered sample differs from the exact shared sourceAt map.');
      const sourcePosition = maps[index]!.sourcePositionAt(clip.offset + frame);
      if (
        !Number.isFinite(sourcePosition) ||
        sourcePosition < sourceClip.sourceIn ||
        sourcePosition > sourceClip.sourceOut ||
        sample.sourcePosition !== sourcePosition
      )
        throw new Error('Layered sample differs from the exact shared continuous source-position map.');
      const { width, height } = assets[clip.index]!.metadata;
      sources.push({
        sample,
        rgb: this.#rgb[index]!,
        original: { width, height },
        bounds: fittedContent({ width, height }, target),
      });
    }
    return sources;
  }
  private async span(layerId: string, span: Span, clips: readonly ClipReader[]): Promise<LosslessChunk> {
    const { ffmpeg, directory, target, document, context } = this.options;
    if (
      !Number.isSafeInteger(span.duration) ||
      !Number.isSafeInteger(span.start) ||
      span.duration < 1 ||
      span.start < 0 ||
      span.start + span.duration > this.#layout.duration ||
      clips.length > 2
    ) {
      throw new Error('Invalid bounded layered span.');
    }
    const filename = `span-${String(this.#spanId++).padStart(5, '0')}.nut`;
    const progressStep = Math.max(1, Math.floor(span.duration / 100));
    const maps = clips.map((clip) => {
      const placed = this.placed(clip.index);
      if (
        !Number.isSafeInteger(clip.offset) ||
        clip.offset < 0 ||
        clip.offset + span.duration > placed.duration ||
        span.start !== placed.start + clip.offset ||
        placed.clip.layerId !== layerId
      ) {
        throw new Error('Layered intermediate span differs from its authoritative placement/retiming map.');
      }
      return placed.retiming;
    });
    const report = await runRawVideoPass({ ffmpeg, cwd: directory, signal: context.signal }, async (pass) => {
      const readers = clips.map((clip) =>
        pass.reader(losslessReader(clip.filename, clip.offset, span.duration, false), 'retimed clip decoder'),
      );
      const encoder = pass.encoder(losslessEncoder(target, filename, true), 'premultiplied RGBA16 encoder');
      await forEachSerial(frameIndices(span.duration), async (frame) => {
        pass.check();
        this.#rgba[0].fill(0); // A standalone transparent group, never the lower composite.
        const samples = sampleTimeline(document, span.start + frame, this.#layout).filter(
          (sample) => sample.layerId === layerId,
        );
        const sources = await this.readSources(clips, readers, maps, frame, samples);
        const started = performance.now();
        await composeLayerFrame(this.#rgba[0], target, sources, this.#cache, context.signal, this.#pool);
        this.#report.compositionMs += performance.now() - started;
        await writeRawFrame(encoder, this.#rgba[0]);
        if (frame === 0 || (frame + 1) % progressStep === 0 || frame + 1 === span.duration) {
          this.update(
            frame + 1,
            `Rendering track group ${layerId}: project frame ${span.start + frame + 1} / ${this.#layout.duration}`,
          );
        }
      });
      encoder.end();
      await forEachSerial(readers, (reader, index) => reader.requireEnd(this.#rgb[index]!));
    });
    this.recordPass(report);
    this.#finishedWork += span.duration;
    this.#report.compositeFrames += span.duration;
    this.#report.compositePixels += span.duration * target.width * target.height;
    return { filename, duration: span.duration };
  }
  private async join(chunks: LosslessChunk[], output: string): Promise<string> {
    const { directory, ffmpeg, context, plan } = this.options;
    if (chunks.reduce((sum, chunk) => sum + chunk.duration, 0) !== plan.duration)
      throw new Error('Track chunks must cover every authoritative project frame exactly once.');
    if (!chunks.length) throw new Error('A lossless timeline requires at least one chunk.');
    if (chunks.length === 1) {
      await rename(path.join(directory, chunks[0]!.filename), path.join(directory, output));
      return output;
    }
    this.timeline(1);
    const concat = `${output}.ffconcat`;
    await atomicWrite(
      path.join(directory, concat),
      'ffconcat version 1.0\n' +
        chunks.map((chunk) => `file ${chunk.filename}\nduration ${seconds(chunk.duration)}\n`).join(''),
    );
    await runProcess(
      ffmpeg,
      [
        ...BASE,
        '-xerror',
        '-threads',
        '2',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        concat,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-c:v',
        'copy',
        '-bsf:v',
        'setts=pts=N*1001:dts=N*1001:duration=1001:time_base=1/30000',
        '-f',
        'nut',
        output,
      ],
      { cwd: directory, signal: context.signal },
    );
    this.#report.nativeVideoProcesses++;
    await forEachSerial(chunks, (chunk) => rm(path.join(directory, chunk.filename)));
    await rm(path.join(directory, concat));
    this.timeline(-1);
    return output;
  }
  private async group(layer: LayeredExportLayer, layerIndex: number): Promise<string> {
    const { plan } = this.options;
    const chunks: LosslessChunk[] = [];
    let retained: RetainedClip | null = null;
    let cursor = 0;
    this.timeline(1);
    await forEachSerial(layer.plan.clips, async (clip) => {
      const filename = await this.retime(clip.index);
      const relevant = layer.plan.chunks.filter((chunk) =>
        chunk.kind === 'body' ? chunk.clipIndex === clip.index : chunk.rightIndex === clip.index,
      );
      await forEachSerial(relevant, async (chunk) => {
        if (chunk.start < cursor) throw new Error('Track group chunks overlap.');
        if (cursor < chunk.start)
          chunks.push(await this.span(layer.id, { start: cursor, duration: chunk.start - cursor }, []));
        chunks.push(await this.span(layer.id, chunk, trackReaders(chunk, clip.index, filename, retained)));
        cursor = chunk.start + chunk.duration;
        if (chunk.kind === 'dissolve') {
          await this.removeClip(retained!.filename);
          retained = null;
        }
      });
      if (layer.plan.chunks.some((chunk) => chunk.kind === 'dissolve' && chunk.leftIndex === clip.index))
        retained = { index: clip.index, filename };
      else await this.removeClip(filename);
    });
    if (retained) throw new Error('An unused track dissolve tail remained.');
    if (cursor < plan.duration)
      chunks.push(await this.span(layer.id, { start: cursor, duration: plan.duration - cursor }, []));
    this.#report.layerPasses++;
    return this.join(chunks, `group-${layerIndex}.nut`);
  }
  private async composite(lower: string, group: string, layerIndex: number): Promise<string> {
    const { plan, ffmpeg, directory, target, context } = this.options;
    const filename = `accumulator-${layerIndex}.nut`;
    const progressStep = Math.max(1, Math.floor(plan.duration / 100));
    this.timeline(1); // Lower + independently graded group + output accumulator.
    const report = await runRawVideoPass({ ffmpeg, cwd: directory, signal: context.signal }, async (pass) => {
      const below = pass.reader(losslessReader(lower, 0, plan.duration, true), 'lower RGBA16 timeline decoder');
      const above = pass.reader(losslessReader(group, 0, plan.duration, true), 'track RGBA16 group decoder');
      const encoder = pass.encoder(losslessEncoder(target, filename, true), 'source-over RGBA16 encoder');
      await forEachSerial(frameIndices(plan.duration), async (frame) => {
        pass.check();
        await below.requireFrame(this.#rgba[0]);
        await above.requireFrame(this.#rgba[1]);
        const started = performance.now();
        await sourceOverGroup(this.#rgba[0], this.#rgba[1], context.signal);
        this.#report.compositionMs += performance.now() - started;
        await writeRawFrame(encoder, this.#rgba[0]);
        if (frame === 0 || (frame + 1) % progressStep === 0 || frame + 1 === plan.duration)
          this.update(
            frame + 1,
            `Compositing track ${plan.layers[layerIndex]!.id}: ${frame + 1} / ${plan.duration} frames`,
          );
      });
      encoder.end();
      await below.requireEnd(this.#rgba[0]);
      await above.requireEnd(this.#rgba[1]);
    });
    this.recordPass(report);
    await forEachSerial([lower, group], async (input) => {
      await rm(path.join(directory, input));
      this.timeline(-1);
    });
    this.#report.sourceOverPasses++;
    this.#finishedWork += plan.duration;
    this.#report.compositeFrames += plan.duration;
    this.#report.compositePixels += plan.duration * target.width * target.height;
    return filename;
  }
  async render(): Promise<LayeredRenderResult> {
    this.#pool = CompositorPool.forHost();
    try {
      return await this.renderPasses();
    } finally {
      await this.#pool?.close();
      this.#pool = null;
    }
  }
  private async renderPasses(): Promise<LayeredRenderResult> {
    const started = performance.now();
    let filename: string | null = null;
    await forEachSerial(this.options.plan.layers, async (layer, index) => {
      if (!layer.enabled || !layer.clips.length) return;
      const group = await this.group(layer, index);
      filename = filename === null ? group : await this.composite(filename, group, index);
    });
    if (filename === null) {
      this.timeline(1);
      const gap = await this.span(
        this.options.plan.layers[0]!.id,
        { start: 0, duration: this.options.plan.duration },
        [],
      );
      filename = await this.join([gap], 'transparent-timeline.nut');
    }
    if (this.#clipFiles || this.#timelines !== 1)
      throw new Error('Layered renderer left unexpected scratch representations.');
    const lut = this.#cache.report;
    Object.assign(this.#report, {
      peakLutEntries: lut.peakEntries,
      lutBytes: lut.bytes,
      lutsGenerated: lut.generated,
      lutGenerationMs: lut.generationMs,
      elapsedMs: performance.now() - started,
    });
    this.update(0, 'Layered lossless composite complete; encoding H.264 once');
    return { filename, retiming: this.#retiming, report: this.#report };
  }
}

/** Caller owns the UUID work directory and removes it on any failure/cancellation. */
export async function renderLayeredExport(options: LayeredExportOptions): Promise<LayeredRenderResult> {
  checkLayeredCancellation(options.context.signal);
  return new SequentialLayeredRenderer(options).render();
}
