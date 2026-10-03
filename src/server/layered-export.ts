import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { LAYERED_EXPORT_RESOURCES, type ExportChunk, type ExportProfileSettings, type LayeredExportPlan } from '../shared/export.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import type { Retiming } from '../shared/speed.js';
import { calculateLayout, sampleTimeline, type PlacedClip, type PreviewLayer } from '../shared/timeline.js';
import { framesToSeconds } from '../shared/timing.js';
import { ServiceError } from './errors.js';
import { assertSourceIdentity } from './files.js';
import type { JobContext } from './jobs.js';
import { ColourLutCache, checkLayeredCancellation } from './layered-colour.js';
import { composeLayerFrame, fittedContent, type LayerFrameSource } from './layered-frame.js';
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
  layerPasses: number;
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
export interface LayeredRenderResult { filename: string; retiming: RawRetimingReport[]; report: LayeredRenderReport }
interface ClipReader { index: number; filename: string; offset: number }
interface RetainedClip { index: number; filename: string }
interface Span { start: number; duration: number }
interface LosslessChunk { filename: string; duration: number }

function primaryReaders(chunk: ExportChunk, index: number, filename: string, retained: RetainedClip | null): ClipReader[] {
  if (chunk.kind === 'body') return [{ index, filename, offset: chunk.sourceIn }];
  if (retained?.index !== chunk.leftIndex) throw new Error('Primary dissolve lost its retained left clip.');
  return [{ index: retained.index, filename: retained.filename, offset: chunk.leftIn }, { index, filename, offset: 0 }];
}

/** Decode/scale tagged original BT.709 BEFORE any CPU grade, once per clip instance. */
export function layeredDecodeFilter(clip: ProjectDocument['clips'][number], asset: MediaAsset, target: Readonly<ExportProfileSettings>): string {
  const bounds = fittedContent(asset.metadata, target);
  return `trim=start_frame=${clip.sourceIn}:end_frame=${clip.sourceOut},setpts=PTS-STARTPTS,` +
    `scale=${bounds.width}:${bounds.height}:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:` +
    `in_range=${asset.metadata.colourRange}:out_range=pc,format=rgb24,` +
    `pad=${target.width}:${target.height}:${bounds.x}:${bounds.y}:black,setsar=1`;
}

function losslessEncoder(target: Readonly<ExportProfileSettings>, filename: string, alpha: boolean): string[] {
  const raw = alpha ? 'rgba64le' : 'rgb24';
  const native = alpha ? 'gbrap16le' : 'bgr0';
  return [...BASE, '-f', 'rawvideo', '-pixel_format', raw, '-video_size', `${target.width}x${target.height}`,
    '-framerate', FPS, '-threads', '2', '-i', 'pipe:0', '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2',
    '-vf', `format=${alpha ? 'gbrap16le' : 'gbrp'},setsar=1,${CLOCK},${RGB_TAGS}`,
    '-fps_mode', 'passthrough', '-enc_time_base', '1:30000', '-c:v', 'ffv1', '-level', '3', '-coder', '1',
    '-context', '1', '-slicecrc', '1', '-g', '1', '-pix_fmt', native, '-threads', '2', '-f', 'nut', filename];
}

/** FFV1 is all-intra. Exact input seek avoids decoding a growing prefix for each span. */
function losslessReader(filename: string, offset: number, duration: number, alpha: boolean): string[] {
  // FFmpeg seeks use microsecond precision. Rounding an exact rational frame
  // timestamp upward can discard that frame, including the last dissolve tail.
  // Seek strictly between the preceding/current PTS; accurate_seek discards
  // the preceding frame, and trim uses exact decoded frame counts thereafter.
  const seek = Math.max(0, framesToSeconds(offset) - framesToSeconds(1) / 4).toFixed(12);
  return [...BASE, '-xerror', '-err_detect', 'explode', '-threads', '2', ...(offset ? ['-ss', seek] : []), '-i', filename,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2', '-vf', `trim=end_frame=${duration},setpts=PTS-STARTPTS,format=${alpha ? 'rgba64le' : 'rgb24'}`,
    '-frames:v', String(duration), '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-pix_fmt', alpha ? 'rgba64le' : 'rgb24',
    '-threads', '2', '-f', 'rawvideo', 'pipe:1'];
}

/**
 * Primary bodies/dissolves -> premultiplied RGBA16 chunks -> one accumulator.
 * Each overlay lane reads that accumulator in disjoint gap/clip spans, then
 * replaces it. Delete the lower timeline BEFORE joining new span chunks, so
 * even during concat there are at most two complete timeline representations.
 * At most two retained RGB clip files; no all-project decoder/filter graph.
 */
class SequentialLayeredRenderer {
  readonly #layout;
  readonly #cache = new ColourLutCache();
  readonly #rgba: Buffer;
  readonly #rgb: readonly [Buffer, Buffer];
  readonly #retiming: RawRetimingReport[] = [];
  readonly #report: LayeredRenderReport;
  readonly #totalWork: number;
  #finishedWork = 0;
  #progress = 0.04;
  #clipFiles = 0;
  #timelines = 0;
  #spanId = 0;
  constructor(private readonly options: LayeredExportOptions) {
    const { target, document, plan } = options;
    const pixels = target.width * target.height;
    if (!Number.isSafeInteger(pixels) || target.width < 2 || target.height < 2 || target.width % 2 || target.height % 2 || pixels > 3840 * 2160) {
      throw new ServiceError('Layered export dimensions must be even and bounded by UHD.', 422);
    }
    this.#layout = calculateLayout(document);
    if (plan.duration !== this.#layout.duration || plan.baseDuration !== this.#layout.baseDuration || options.assets.length !== document.clips.length) throw new ServiceError('Layered inputs differ from their captured timeline.', 500);
    this.#rgba = Buffer.alloc(pixels * 8);
    this.#rgb = [Buffer.allocUnsafe(pixels * 3), Buffer.allocUnsafe(pixels * 3)];
    this.#report = {
      renderedClipIds: [], skippedLayerIds: document.layers.filter((layer) => !layer.enabled).map((layer) => layer.id),
      layerPasses: 0, originalDecoderProcesses: 0, nativeVideoProcesses: 0, peakOriginalVideoDecoders: 0,
      peakIntermediateVideoDecoders: 0, peakVideoEncoders: 0, peakNativeVideoChildren: 0, peakLosslessClipFiles: 0,
      peakLosslessTimelineRepresentations: 0, rawFrameBuffers: 3, rawBufferBytes: pixels * LAYERED_EXPORT_RESOURCES.rawBytesPerPixel,
      largestReadChunkBytes: 0, peakLutEntries: 0, lutBytes: 0, lutsGenerated: 0, lutGenerationMs: 0,
      compositeFrames: 0, compositePixels: 0, compositionMs: 0, elapsedMs: 0
    };
    const active = plan.layers.filter((layer) => layer.enabled);
    this.#totalWork = active.reduce((sum, layer) => sum + layer.clips.reduce((frames, clip) => frames + clip.duration, 0), 0) +
      plan.duration * (1 + active.slice(document.layers[0]!.enabled ? 1 : 0).filter((layer) => layer.clips.length > 0).length);
  }
  private update(frames: number, message: string): void {
    checkLayeredCancellation(this.options.context.signal);
    this.#progress = Math.max(this.#progress, 0.04 + 0.78 * (this.#finishedWork + frames) / this.#totalWork);
    this.options.context.update(Math.min(0.82, this.#progress), message);
    checkLayeredCancellation(this.options.context.signal);
  }
  private timeline(delta: number): void {
    this.#timelines += delta;
    if (this.#timelines < 0 || this.#timelines > LAYERED_EXPORT_RESOURCES.maxLosslessTimelineRepresentations) throw new Error('Layered timeline scratch bound exceeded.');
    this.#report.peakLosslessTimelineRepresentations = Math.max(this.#report.peakLosslessTimelineRepresentations, this.#timelines);
  }
  private recordPass(report: RawPassReport): void {
    this.#report.peakIntermediateVideoDecoders = Math.max(this.#report.peakIntermediateVideoDecoders, report.peakReaders);
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
    if (planned?.index !== index || planned?.duration !== placed.duration) throw new ServiceError('Layered clip plan differs from its authoritative contextual duration.', 500);
    const asset = assets[index]!;
    const filename = `clip-${index}.nut`;
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
    this.update(0, `Retiming original layered clip ${clip.id}`);
    if (++this.#clipFiles > LAYERED_EXPORT_RESOURCES.maxLosslessClipsOnDisk) throw new Error('Layered clip scratch bound exceeded.');
    this.#report.peakLosslessClipFiles = Math.max(this.#report.peakLosslessClipFiles, this.#clipFiles);
    const report = await retimeRawVideo({
      ffmpeg, cwd: directory, clip, retiming: placed.retiming, frameBytes: this.#rgb[0].length, frameBuffer: this.#rgb[0], signal: context.signal,
      decodeArgs: [...BASE, '-xerror', '-err_detect', 'explode', '-threads', '2', '-noautorotate', '-i', asset.sourcePath,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2', '-vf', layeredDecodeFilter(clip, asset, target),
        '-frames:v', String(clip.sourceOut - clip.sourceIn), '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '2', '-f', 'rawvideo', 'pipe:1'],
      encodeArgs: losslessEncoder(target, filename, false),
      onProgress: (frames, total) => this.update(frames, `Retiming original layered clip ${clip.id}: ${frames} / ${total} frames`),
    });
    if (report.outputFrames !== placed.duration || report.decodedFrames !== clip.sourceOut - clip.sourceIn) throw new ServiceError('Layered retiming did not emit/decode its exact captured frame counts.', 422);
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
    this.#clipFiles--;
  }
  private async readSources(clips: readonly ClipReader[], readers: readonly RawFrameReader[], maps: readonly Retiming[],
    frame: number, samples: readonly PreviewLayer[]): Promise<LayerFrameSource[]> {
    const { document, assets, target } = this.options;
    if (samples.length !== clips.length) throw new Error('Layered span does not match the authoritative active clips.');
    const sources: LayerFrameSource[] = [];
    for (const [index, clip] of clips.entries()) {
      await readers[index]!.requireFrame(this.#rgb[index]!); // NOSONAR -- at most two reusable intermediate frames.
      const sourceClip = document.clips[clip.index]!;
      const sample = samples.find((item) => item.clipId === sourceClip.id);
      if (sample?.sourceFrame !== maps[index]!.sourceAt(clip.offset + frame)) throw new Error('Layered sample differs from the exact shared sourceAt map.');
      sources.push({ sample, rgb: this.#rgb[index]!, bounds: fittedContent(assets[clip.index]!.metadata, target) });
    }
    return sources;
  }
  private async span(layerId: string, span: Span, lower: string | null, clips: readonly ClipReader[]): Promise<LosslessChunk> {
    const { ffmpeg, directory, target, document, context } = this.options;
    if (!Number.isSafeInteger(span.duration) || !Number.isSafeInteger(span.start) || span.duration < 1 || span.start < 0 || span.start + span.duration > this.#layout.duration || clips.length + (lower ? 1 : 0) > 2) {
      throw new Error('Invalid bounded layered span.');
    }
    const filename = `span-${String(this.#spanId++).padStart(5, '0')}.nut`;
    const progressStep = Math.max(1, Math.floor(span.duration / 100));
    const maps = clips.map((clip) => {
      const placed = this.placed(clip.index);
      if (!Number.isSafeInteger(clip.offset) || clip.offset < 0 || clip.offset + span.duration > placed.duration ||
        span.start !== placed.start + clip.offset || placed.clip.layerId !== layerId) {
        throw new Error('Layered intermediate span differs from its authoritative placement/retiming map.');
      }
      return placed.retiming;
    });
    const report = await runRawVideoPass({ ffmpeg, cwd: directory, signal: context.signal }, async (pass) => {
      const below = lower ? pass.reader(losslessReader(lower, span.start, span.duration, true), 'lower timeline decoder') : null;
      const readers = clips.map((clip) => pass.reader(losslessReader(clip.filename, clip.offset, span.duration, false), 'retimed clip decoder'));
      const encoder = pass.encoder(losslessEncoder(target, filename, true), 'premultiplied RGBA16 encoder');
      for (let frame = 0; frame < span.duration; frame++) {
        pass.check();
        if (below) await below.requireFrame(this.#rgba); // NOSONAR -- one reused lower/output frame.
        else this.#rgba.fill(0); // Transparent gaps, not a black opaque overlay.
        const samples = sampleTimeline(document, span.start + frame, this.#layout).filter((sample) => sample.layerId === layerId);
        const sources = await this.readSources(clips, readers, maps, frame, samples); // NOSONAR -- shared samples determine source and grading settings.
        const started = performance.now();
        await composeLayerFrame(this.#rgba, target, sources, this.#cache, context.signal); // NOSONAR -- grade sampled parameters, then source-over the complete group.
        this.#report.compositionMs += performance.now() - started;
        await writeRawFrame(encoder, this.#rgba); // NOSONAR -- never mutate a buffer still owned by a pipe write.
        if (frame === 0 || (frame + 1) % progressStep === 0 || frame + 1 === span.duration) {
          this.update(frame + 1, `Compositing layer ${layerId}: project frame ${span.start + frame + 1} / ${this.#layout.duration}`);
        }
      }
      encoder.end();
      if (below) await below.requireEnd(this.#rgba);
      for (const [index, reader] of readers.entries()) await reader.requireEnd(this.#rgb[index]!); // NOSONAR -- exact exclusive span OUT for every decoder.
    });
    this.recordPass(report);
    this.#finishedWork += span.duration;
    this.#report.compositeFrames += span.duration;
    this.#report.compositePixels += span.duration * target.width * target.height;
    return { filename, duration: span.duration };
  }
  private async join(chunks: LosslessChunk[], layerIndex: number): Promise<string> {
    const { directory, ffmpeg, context, plan } = this.options;
    if (chunks.reduce((sum, chunk) => sum + chunk.duration, 0) !== plan.duration) throw new Error('Layer chunks must cover every authoritative project frame exactly once.');
    const output = `accumulator-${layerIndex}.nut`;
    if (chunks.length === 1) {
      await rename(path.join(directory, chunks[0]!.filename), path.join(directory, output));
      return output;
    }
    this.timeline(1);
    const concat = `layer-${layerIndex}.ffconcat`;
    await atomicWrite(path.join(directory, concat), 'ffconcat version 1.0\n' + chunks.map((chunk) => `file ${chunk.filename}\nduration ${seconds(chunk.duration)}\n`).join(''));
    await runProcess(ffmpeg, [...BASE, '-xerror', '-threads', '2', '-f', 'concat', '-safe', '1', '-i', concat,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy',
      '-bsf:v', 'setts=pts=N*1001:dts=N*1001:duration=1001:time_base=1/30000', '-f', 'nut', output], { cwd: directory, signal: context.signal });
    this.#report.nativeVideoProcesses++;
    for (const chunk of chunks) await rm(path.join(directory, chunk.filename)); // NOSONAR -- dispose serially; a chunk collection is only one timeline representation.
    await rm(path.join(directory, concat));
    this.timeline(-1);
    return output;
  }
  private async primarySpans(index: number, filename: string, retained: RetainedClip | null, chunks: LosslessChunk[]): Promise<RetainedClip | null> {
    const layerId = this.options.document.layers[0]!.id;
    const relevant = this.options.plan.primary.chunks.filter((chunk) => chunk.kind === 'body' ? chunk.clipIndex === index : chunk.rightIndex === index);
    for (const chunk of relevant) {
      chunks.push(await this.span(layerId, chunk, null, primaryReaders(chunk, index, filename, retained))); // NOSONAR -- lossless bodies and two-reader dissolves.
      if (chunk.kind === 'dissolve') {
        await this.removeClip(retained!.filename); // NOSONAR -- release the old tail before retiming another original.
        retained = null;
      }
    }
    return retained;
  }
  private async primary(): Promise<string> {
    const { document, plan } = this.options;
    const layer = document.layers[0]!;
    const chunks: LosslessChunk[] = [];
    let retained: RetainedClip | null = null;
    this.timeline(1);
    if (layer.enabled) {
      for (const [primaryIndex, clip] of plan.primary.clips.entries()) {
        const filename = await this.retime(clip.index); // NOSONAR -- only one original decoder, with at most one retained dissolve tail.
        retained = await this.primarySpans(clip.index, filename, retained, chunks); // NOSONAR -- preserve only the outgoing tail.
        if (document.transitions[primaryIndex]?.type === 'cross-dissolve') retained = { index: clip.index, filename };
        else await this.removeClip(filename); // NOSONAR -- never retain all instances.
      }
    }
    if (retained) throw new Error('An unused primary dissolve tail remained.');
    const filled = layer.enabled ? plan.baseDuration : 0;
    if (filled < plan.duration) chunks.push(await this.span(layer.id, { start: filled, duration: plan.duration - filled }, null, []));
    this.#report.layerPasses++;
    return this.join(chunks, 0);
  }
  private async overlay(lower: string, layerIndex: number): Promise<string> {
    const { plan, directory } = this.options;
    const layer = plan.layers[layerIndex]!;
    const chunks: LosslessChunk[] = [];
    let cursor = 0;
    this.timeline(1); // Old accumulator + the new lane's span collection.
    for (const clip of layer.clips) {
      if (cursor < clip.start) chunks.push(await this.span(layer.id, { start: cursor, duration: clip.start - cursor }, lower, [])); // NOSONAR -- gaps preserve lower RGB/coverage.
      const filename = await this.retime(clip.index); // NOSONAR -- no other original decoder remains active.
      chunks.push(await this.span(layer.id, { start: clip.start, duration: clip.duration }, lower, [{ index: clip.index, filename, offset: 0 }])); // NOSONAR -- one lower and one retimed intermediate reader.
      await this.removeClip(filename); // NOSONAR -- one overlay clip file at a time.
      cursor = clip.end;
    }
    if (cursor < plan.duration) chunks.push(await this.span(layer.id, { start: cursor, duration: plan.duration - cursor }, lower, []));
    await rm(path.join(directory, lower));
    this.timeline(-1); // Delete the old timeline BEFORE making the concat output.
    this.#report.layerPasses++;
    return this.join(chunks, layerIndex);
  }
  async render(): Promise<LayeredRenderResult> {
    const started = performance.now();
    let filename = await this.primary();
    for (const [index, layer] of this.options.plan.layers.entries()) {
      if (index > 0 && layer.enabled && layer.clips.length > 0) filename = await this.overlay(filename, index); // NOSONAR -- strictly bottom-to-top sequential layer passes.
    }
    if (this.#clipFiles || this.#timelines !== 1) throw new Error('Layered renderer left unexpected scratch representations.');
    const lut = this.#cache.report;
    Object.assign(this.#report, {
      peakLutEntries: lut.peakEntries, lutBytes: lut.bytes, lutsGenerated: lut.generated,
      lutGenerationMs: lut.generationMs, elapsedMs: performance.now() - started
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