import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { audioAssetSchema, type AudioAsset } from '../shared/audio.js';
import { generateCube } from '../shared/colour.js';
import {
  EXPORT_PROFILES, EXPORT_RESOURCES,
  exportDocumentSchema, exportRequestSchema,
  LAYERED_EXPORT_RESOURCES,
  needsLayeredExport,
  planExport,
  planExportMusic,
  planLayeredExport,
  type ExportChunk, type ExportMusicPlan, type ExportPlan, type ExportProfile, type ExportProfileSettings, type LayeredExportPlan,
} from '../shared/export.js';
import { mediaAssetSchema, type MediaAsset, type MediaJob, type VideoMetadata } from '../shared/media.js';
import type { MusicTrack, ProjectDocument } from '../shared/model.js';
import { validateSourceRanges } from '../shared/source-range.js';
import { framesToSeconds, PROJECT_FPS, sameRate } from '../shared/timing.js';
import { ServiceError } from './errors.js';
import { exportStorageFailure, readExportSpace, requireExportReserve } from './export-space.js';
import type { ExportPreflight } from '../shared/export-space.js';
import { assertSourceIdentity } from './files.js';
import type { JobContext } from './jobs.js';
import { renderLayeredExport, type LayeredRenderReport } from './layered-export.js';
import type { MediaLibrary } from './library.js';
import { inspectStreams, probeVideo } from './probe.js';
import { runProcess } from './process.js';
import { nativeFadeFilters } from './reference.js';
import { retimeRawVideo, type RawRetimingReport } from './retime-process.js';
import { atomicWrite } from './storage.js';

export type AudioResolver = (id: string) => AudioAsset | Promise<AudioAsset>;
interface ExportInputs { snapshot: ProjectDocument; profile: ExportProfile; plan: ExportPlan | LayeredExportPlan; assets: MediaAsset[] }
interface RenderEnvironment { library: MediaLibrary; directory: string; context: JobContext; target: Readonly<ExportProfileSettings> }
interface EncodedChunk { filename: string; duration: number }
export interface ExportAudioVerification { codec: 'aac'; sampleRate: 48000; channels: 2; durationSeconds: number; durationErrorSeconds: number }
export interface ExportVerification extends VideoMetadata {
  audio: ExportAudioVerification | null;
  fullDecode: true;
  faststart: true;
}
export interface ExportReceipt {
  kind: 'export'; schemaVersion: 1; jobId: string; createdAt: string;
  snapshot: ProjectDocument; profile: ExportProfile;
  sources: { id: string; sourcePath: string; fingerprint: MediaAsset['fingerprint']; metadata: VideoMetadata }[];
  musicSource: AudioAsset | null;
  settings: {
    target: ExportProfileSettings; codec: 'h264'; codecProfile: 'high'; pixelFormat: 'yuv420p'; colour: 'limited BT.709 SDR';
    frameRate: typeof PROJECT_FPS; timeBase: '1/30000'; lutInterpolation: 'tetrahedral'; retiming: 'shared placed.retiming.sourceAt (static compileRetiming)';
    pipeline: 'static-single-layer' | 'sequential-layered';
    intermediate: 'lossless RGB FFV1/bgr0 NUT' | 'lossless RGB8 clips + premultiplied RGBA16 FFV1/gbrap16le NUT';
    resources: typeof EXPORT_RESOURCES | typeof LAYERED_EXPORT_RESOURCES;
    grading: string; layered: LayeredRenderReport | null;
    scratchPolicy: string; audio: ExportMusicPlan | null; audioPlacement: string;
  };
  timeline: ExportPlan | LayeredExportPlan;
  retiming: RawRetimingReport[];
  verification: ExportVerification;
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
function checkCancelled(context: JobContext): void {
  if (context.signal.aborted) throw new ServiceError('Job cancelled.', 499);
}
function validateVideo(clipId: string, sourceOut: number, asset: MediaAsset): void {
  const metadata = asset.metadata;
  if (sourceOut > metadata.frameCount) throw new ServiceError(`Clip ${clipId} exceeds its registered source frame count.`, 422);
  if (!sameRate(metadata.frameRate, PROJECT_FPS) || Math.abs(metadata.durationSeconds - framesToSeconds(metadata.frameCount)) > 1e-5) {
    throw new ServiceError(`Clip ${clipId} does not have verified constant project-rate timing.`, 422);
  }
  if (metadata.pixelFormat !== 'yuv420p' || metadata.colourSpace !== 'bt709' || metadata.colourPrimaries !== 'bt709' || metadata.colourTransfer !== 'bt709' || !['tv', 'pc'].includes(metadata.colourRange)) {
    throw new ServiceError(`Clip ${clipId} must be explicitly tagged 8-bit BT.709 SDR.`, 422);
  }
}
function captureInputs(document: ProjectDocument, profile: ExportProfile, library: MediaLibrary): ExportInputs {
  const request = exportRequestSchema.parse({ document, profile });
  const assets = request.document.clips.map((clip) => {
    const asset = mediaAssetSchema.parse(library.get(clip.mediaId));
    if (asset.id !== clip.mediaId) throw new ServiceError(`Clip ${clip.id} resolved to a different media identity.`, 409);
    validateVideo(clip.id, clip.sourceOut, asset);
    return freezeSnapshot(asset);
  });
  const plan = needsLayeredExport(request.document) ? planLayeredExport(request.document) : planExport(request.document);
  try { validateSourceRanges(request.document, new Map(assets.map((asset) => [asset.id, asset.metadata.frameCount]))); }
  catch (error) { throw new ServiceError(error instanceof Error ? error.message : 'Invalid source range.', 422); }
  return { snapshot: freezeSnapshot(request.document), profile: request.profile, plan, assets };
}

/** Read-only validation; no proxy preparation or document persistence is implicit. */
export function validateExport(document: ProjectDocument, library: MediaLibrary): ProjectDocument {
  return captureInputs(exportDocumentSchema.parse(document), 'draft720', library).snapshot;
}

/** Read-only planning: validate the snapshot/registry, but do not read sources or admit jobs. */
export async function preflightExport(document: ProjectDocument, profile: ExportProfile, library: MediaLibrary, resolveAudio?: AudioResolver): Promise<ExportPreflight> {
  const inputs = captureInputs(document, profile, library);
  if (inputs.snapshot.music) validateExportAudio(inputs.snapshot.music, await resolveRequiredAudio(inputs.snapshot.music.mediaId, resolveAudio));
  return readExportSpace(library.config.dataDir, inputs.snapshot, inputs.profile);
}

export function validateExportAudio(music: MusicTrack, input: AudioAsset): AudioAsset {
  const asset = audioAssetSchema.parse(input);
  if (asset.id !== music.mediaId) throw new ServiceError('Music resolved to a different registered source identity.', 409);
  if (music.sourceOut > asset.metadata.frameCount || framesToSeconds(music.sourceOut) > asset.metadata.durationSeconds + 1 / asset.metadata.sampleRate) {
    throw new ServiceError('Music SOURCE OUT exceeds the registered audio source bounds.', 422);
  }
  return freezeSnapshot(asset);
}

/** The existing single heavy-media queue owns scheduling, progress and cancellation. */
export function startExport(document: ProjectDocument, profile: ExportProfile, library: MediaLibrary, resolveAudio?: AudioResolver): MediaJob {
  const inputs = captureInputs(document, profile, library);
  if (inputs.snapshot.music && !resolveAudio) throw new ServiceError('A music source resolver is required for this export.', 422);
  return library.jobs.submit('export', `${inputs.snapshot.title} · ${profile === 'draft720' ? '720p' : '4K'}`, async (context) => {
    await renderCapturedExport(inputs, library, context, resolveAudio);
    library.jobs.setOutput(context.id, `/api/jobs/${context.id}/export`, `/api/jobs/${context.id}/receipt`);
  });
}

/** Also useful for controlled integration tests; context.id must be a unique UUID. */
export async function renderExport(document: ProjectDocument, profile: ExportProfile, library: MediaLibrary, context: JobContext, resolveAudio?: AudioResolver): Promise<void> {
  await renderCapturedExport(captureInputs(document, profile, library), library, context, resolveAudio);
}

const BASE_ARGS = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
const FPS = '30000/1001';
const CLOCK = 'settb=expr=1/30000,setpts=N*1001';
const RGB_TO_VIDEO = 'scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p,' +
  'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
const seconds = (frames: number): string => framesToSeconds(frames).toFixed(9);

function h264Arguments(target: Readonly<ExportProfileSettings>, frames: number): string[] {
  return ['-an', '-sn', '-dn', '-frames:v', String(frames), '-fps_mode', 'passthrough', '-enc_time_base', '1:30000',
    '-c:v', 'libx264', '-threads', '2', '-preset', target.preset, '-crf', String(target.crf),
    '-profile:v', 'high', '-level:v', target.level, '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0',
    '-x264-params', 'rc-lookahead=0:sync-lookahead=0:lookahead_threads=1',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-video_track_timescale', '30000', '-movflags', '+faststart', '-progress', 'pipe:1'];
}

async function retimeClip(inputs: ExportInputs, index: number, environment: RenderEnvironment,
  onProgress: (frames: number) => void): Promise<{ filename: string; report: RawRetimingReport }> {
  const { target, library, directory, context } = environment;
  const clip = inputs.snapshot.clips[index]!;
  const plan = inputs.plan.clips[index]!;
  const asset = inputs.assets[index]!;
  const lut = `clip-${index}.cube`;
  const filename = `clip-${index}.nut`;
  await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
  checkCancelled(context);
  await atomicWrite(path.join(directory, lut), generateCube(clip.colour, EXPORT_RESOURCES.lutSize));
  const decodeFilter = `trim=start_frame=${clip.sourceIn}:end_frame=${clip.sourceOut},setpts=PTS-STARTPTS,` +
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic:` +
    `in_color_matrix=bt709:out_color_matrix=bt709:in_range=${asset.metadata.colourRange}:out_range=pc,` +
    `format=gbrp,lut3d=file=${lut}:interp=tetrahedral,` +
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=rgb24`;
  const encodeFilter = ['format=gbrp', ...nativeFadeFilters(plan.duration, plan.fadeIn, plan.fadeOut),
    'setsar=1', CLOCK, 'setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=gbr'].join(',');
  const report = await retimeRawVideo({
    ffmpeg: library.config.ffmpeg, cwd: directory, clip, frameBytes: target.width * target.height * 3, signal: context.signal,
    decodeArgs: [...BASE_ARGS, '-xerror', '-err_detect', 'explode', '-threads', '2', '-noautorotate', '-i', asset.sourcePath,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2', '-vf', decodeFilter,
      '-frames:v', String(clip.sourceOut - clip.sourceIn), '-fps_mode', 'passthrough',
      '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '2', '-f', 'rawvideo', 'pipe:1'],
    encodeArgs: [...BASE_ARGS, '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${target.width}x${target.height}`,
      '-framerate', FPS, '-threads', '2', '-i', 'pipe:0', '-map', '0:v:0', '-an', '-sn', '-dn',
      '-filter_threads', '2', '-vf', encodeFilter, '-fps_mode', 'passthrough', '-enc_time_base', '1:30000',
      '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-slicecrc', '1', '-g', '1',
      '-pix_fmt', 'bgr0', '-threads', '2', '-f', 'nut', filename],
    onProgress,
  });
  if (report.outputFrames !== plan.duration || report.decodedFrames !== clip.sourceOut - clip.sourceIn) throw new ServiceError('Static retiming did not emit/decode its exact captured frame counts.', 422);
  await rm(path.join(directory, lut));
  await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
  checkCancelled(context);
  return { filename, report };
}

function bodyGraph(chunk: Extract<ExportChunk, { kind: 'body' }>): string {
  return `[0:v]trim=start_frame=${chunk.sourceIn}:end_frame=${chunk.sourceOut},format=gbrp,${CLOCK},${RGB_TO_VIDEO}[out]`;
}
function dissolveGraph(chunk: Extract<ExportChunk, { kind: 'dissolve' }>): string {
  return `[0:v]trim=start_frame=${chunk.leftIn}:end_frame=${chunk.leftIn + chunk.duration},format=gbrp,${CLOCK}[left];` +
    `[1:v]trim=end_frame=${chunk.duration},format=gbrp,${CLOCK}[right];` +
    `[left][right]xfade=transition=fade:duration=${seconds(chunk.duration)}:offset=0,` +
    `trim=end_frame=${chunk.duration},${CLOCK},${RGB_TO_VIDEO}[out]`;
}

async function encodeChunk(chunk: ExportChunk, filenames: string[], output: string, environment: RenderEnvironment,
  onProgress: (frames: number) => void): Promise<void> {
  const { target, library, directory, context } = environment;
  checkCancelled(context);
  await runProcess(library.config.ffmpeg, [...BASE_ARGS, '-xerror', ...filenames.flatMap((filename) => ['-threads', '2', '-i', filename]),
    '-filter_complex_threads', '2', '-filter_threads', '2', '-filter_complex', chunk.kind === 'body' ? bodyGraph(chunk) : dissolveGraph(chunk),
    '-map', '[out]', ...h264Arguments(target, chunk.duration), output], {
    cwd: directory, signal: context.signal, onProgress: (fields) => {
      const frame = Number(fields['frame']);
      if (Number.isFinite(frame)) onProgress(Math.max(0, Math.min(chunk.duration, frame)));
    },
  });
}

/** Trim/resample BEFORE looping: the original file is never stream_loop's input. */
async function prepareMusic(asset: AudioAsset, music: ExportMusicPlan, library: MediaLibrary, directory: string, context: JobContext): Promise<void> {
  // Web Audio duplicates a mono signal to both speakers. FFmpeg's implicit mono
  // upmix attenuates each channel by 3 dB, which would violate musicGainAt parity.
  const upmix = asset.metadata.channels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
  await runProcess(library.config.ffmpeg, [...BASE_ARGS, '-xerror', '-err_detect', 'explode', '-threads', '2', '-i', asset.sourcePath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-filter_threads', '2', '-af',
  `aresample=48000:first_pts=0,atrim=start_sample=${music.sourceInSamples}:end_sample=${music.sourceOutSamples},` +
  `asetpts=N/SR/TB,${upmix}aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo`,
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-threads', '2', '-rf64', 'auto', 'music.wav'], { cwd: directory, signal: context.signal });
  const streams = await inspectStreams(library.config, path.join(directory, 'music.wav'), context.signal);
  const pcm = streams.streams.find((stream) => stream.codec_type === 'audio');
  if (pcm?.time_base !== '1/48000' || pcm.duration_ts !== music.sourceOutSamples - music.sourceInSamples) {
    throw new ServiceError('Selected music range did not decode to its exact bounded PCM sample count.', 422);
  }
}

/** Silence prefix streams in constant memory; adelay would allocate a duration-sized delay buffer. */
function musicGraph(music: ExportMusicPlan): string {
  if (music.activeSamples === 0) return `anullsrc=r=48000:cl=stereo,atrim=end_sample=${music.videoSamples},asetpts=N/SR/TB[audio]`;
  const fades = [
    ...(music.fadeInSamples ? [`afade=t=in:ss=0:ns=${music.fadeInSamples}:curve=tri`] : []),
    ...(music.fadeOutSamples ? [`afade=t=out:ss=${music.durationSamples - music.fadeOutSamples}:ns=${music.fadeOutSamples}:curve=tri`] : []),
  ];
  const track = `[1:a]atrim=end_sample=${music.activeSamples},asetpts=N/SR/TB,volume=${music.gain.toPrecision(17)},${[...fades, 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'].join(',')}[music];`;
  const prefix = music.startSamples
    ? `anullsrc=r=48000:cl=stereo,atrim=end_sample=${music.startSamples},asetpts=N/SR/TB,aformat=sample_fmts=fltp[lead];[lead][music]concat=n=2:v=0:a=1`
    : '[music]anull';
  return track + prefix + `,apad=whole_len=${music.videoSamples},atrim=end_sample=${music.videoSamples},asetpts=N/SR/TB[audio]`;
}

async function muxExport(inputs: ExportInputs, chunkFiles: EncodedChunk[], music: ExportMusicPlan | null, library: MediaLibrary,
  directory: string, partial: string, context: JobContext): Promise<void> {
  if (chunkFiles.reduce((sum, chunk) => sum + chunk.duration, 0) !== inputs.plan.duration) throw new ServiceError('Encoded video does not cover the captured project duration.', 500);
  await atomicWrite(path.join(directory, 'chunks.ffconcat'), 'ffconcat version 1.0\n' + chunkFiles.map((chunk) =>
    `file ${chunk.filename}\nduration ${seconds(chunk.duration)}\n`).join(''));
  const args = [...BASE_ARGS, '-threads', '2', '-f', 'concat', '-safe', '1', '-i', 'chunks.ffconcat'];
  if (music?.activeSamples) args.push(...(inputs.snapshot.music!.loop ? ['-stream_loop', '-1'] : []), '-threads', '2', '-i', 'music.wav');
  if (music) args.push('-filter_complex_threads', '2', '-filter_threads', '2', '-filter_complex', musicGraph(music), '-map', '0:v:0', '-map', '[audio]',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-threads:a', '2');
  else args.push('-map', '0:v:0', '-an');
  // Concat file durations are in microseconds. Reset EVERY packet to exact project ticks
  // so rounding does not accumulate across hundreds of independently encoded chunks.
  args.push('-sn', '-dn', '-c:v', 'copy', '-bsf:v', 'setts=pts=N*1001:dts=N*1001:duration=1001:time_base=1/30000',
    '-r', FPS, '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-video_track_timescale', '30000', '-movflags', '+faststart', '-t', seconds(inputs.plan.duration), '-progress', 'pipe:1', partial);
  await runProcess(library.config.ffmpeg, args, {
    cwd: directory, signal: context.signal, onProgress: (fields) => {
      const elapsed = Number(fields['out_time_us']);
      if (Number.isFinite(elapsed)) context.update(0.85 + 0.06 * Math.max(0, Math.min(1, elapsed / 1e6 / framesToSeconds(inputs.plan.duration))), 'Assembling MP4 and music');
    }
  });
}

function mp4BoxSize(header: Buffer, bytesRead: number, remaining: number): number {
  if (bytesRead < 8) throw new ServiceError('Export has a truncated MP4 box.', 422);
  const shortSize = header.readUInt32BE(0);
  let size = shortSize;
  if (shortSize === 0) size = remaining;
  if (shortSize === 1) {
    if (bytesRead < 16) throw new ServiceError('Export has a truncated extended MP4 box.', 422);
    size = Number(header.readBigUInt64BE(8));
  }
  if (!Number.isSafeInteger(size) || size < (shortSize === 1 ? 16 : 8) || size > remaining) throw new ServiceError('Export has an invalid MP4 box.', 422);
  return size;
}
async function verifyFaststart(filename: string): Promise<void> {
  const handle = await open(filename, 'r');
  try {
    const size = (await handle.stat()).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    let moov = -1;
    let mdat = -1;
    while (offset < size) {
      const { bytesRead } = await handle.read(header, 0, Math.min(16, size - offset), offset); // NOSONAR -- bounded header reads, not whole-file buffering.
      const boxSize = mp4BoxSize(header, bytesRead, size - offset);
      const type = header.toString('ascii', 4, 8);
      if (type === 'moov') moov = offset;
      if (type === 'mdat') mdat = offset;
      offset += boxSize;
    }
    if (moov < 0 || mdat < 0 || moov > mdat) throw new ServiceError('Export is not a faststart MP4.', 422);
  } finally { await handle.close(); }
}

async function verifyExport(filename: string, inputs: ExportInputs, library: MediaLibrary, context: JobContext): Promise<ExportVerification> {
  const target = EXPORT_PROFILES[inputs.profile];
  const video = await probeVideo(library.config, filename, context.signal);
  if (video.width !== target.width || video.height !== target.height || video.codec !== 'h264' || video.pixelFormat !== 'yuv420p' ||
    video.colourRange !== 'tv' || video.frameCount !== inputs.plan.duration || !sameRate(video.frameRate, inputs.snapshot.frameRate) || video.hasAudio !== (inputs.snapshot.music !== null)) {
    throw new ServiceError('Export verification failed: dimensions, frame count, codec, colour, rate or audio differs from the snapshot.', 422);
  }
  const streams = await inspectStreams(library.config, filename, context.signal);
  const videoStream = streams.streams.find((stream) => stream.codec_type === 'video');
  if (videoStream?.time_base !== '1/30000' || videoStream['profile'] !== 'High') throw new ServiceError('Export H.264 profile or track timebase differs from the target.', 422);
  const audioStreams = streams.streams.filter((stream) => stream.codec_type === 'audio');
  if (audioStreams.length !== (inputs.snapshot.music ? 1 : 0)) throw new ServiceError('Export has an unexpected number of audio streams.', 422);
  let audio: ExportAudioVerification | null = null;
  if (inputs.snapshot.music) {
    const stream = audioStreams[0]!;
    const match = /^(\d+)\/(\d+)$/.exec(stream.time_base);
    const durationSeconds = Number(stream.duration_ts) * Number(match?.[1]) / Number(match?.[2]);
    const durationErrorSeconds = Math.abs(durationSeconds - framesToSeconds(inputs.plan.duration));
    if (stream.codec_name !== 'aac' || Number(stream['sample_rate']) !== 48000 || Number(stream['channels']) !== 2 || !Number.isFinite(durationSeconds) || durationErrorSeconds > framesToSeconds(1) + 1e-6) {
      throw new ServiceError('Export AAC format or duration verification failed (tolerance: one project frame).', 422);
    }
    audio = { codec: 'aac', sampleRate: 48000, channels: 2, durationSeconds, durationErrorSeconds };
  }
  await runProcess(library.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-err_detect', 'explode',
    '-threads', '2', '-i', filename, '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : ['-an']),
    '-filter_threads', '2', '-filter_complex_threads', '2', '-threads', '2', '-f', 'null', '-'], { signal: context.signal });
  await verifyFaststart(filename);
  return { ...video, audio, fullDecode: true, faststart: true };
}

async function checkSources(assets: MediaAsset[], music: AudioAsset | null): Promise<void> {
  for (const asset of assets) await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true); // NOSONAR -- source checks are intentionally serial.
  if (music) await assertSourceIdentity(music.sourcePath, music.fingerprint, true);
}

async function renderClips(inputs: ExportInputs, environment: RenderEnvironment): Promise<{ chunkFiles: string[]; retiming: RawRetimingReport[] }> {
  const { directory, context } = environment;
  const totalWork = inputs.plan.clips.reduce((sum, clip) => sum + clip.duration, 0) + inputs.plan.duration;
  let finishedWork = 0;
  let maxProgress = 0.01;
  const progress = (frames: number, message: string): void => {
    maxProgress = Math.max(maxProgress, 0.04 + 0.78 * (finishedWork + frames) / totalWork);
    context.update(maxProgress, message);
  };
  let retained: { index: number; filename: string } | null = null;
  const chunkFiles: string[] = [];
  const retiming: RawRetimingReport[] = [];
  for (const [index, clip] of inputs.plan.clips.entries()) {
    checkCancelled(context);
    progress(0, `Generating clip ${index + 1} / ${inputs.plan.clips.length} LUT`);
    const result = await retimeClip(inputs, index, environment, // NOSONAR -- decode only one original at a time.
      (frames) => progress(frames, `Retiming original clip ${index + 1} / ${inputs.plan.clips.length}: ${frames} / ${clip.duration} output frames`));
    retiming.push(result.report);
    finishedWork += clip.duration;
    for (const chunk of inputs.plan.chunks.filter((item) => item.kind === 'body' ? item.clipIndex === index : item.rightIndex === index)) {
      const chunkFile = `chunk-${String(chunkFiles.length).padStart(5, '0')}.mp4`;
      const filenames = chunk.kind === 'body' ? [result.filename] : [requireRetained(retained, index - 1), result.filename];
      await encodeChunk(chunk, filenames, chunkFile, environment, // NOSONAR -- a dissolve opens at most two intermediate decoders.
        (frames) => progress(frames, `Encoding ${chunk.kind} chunk ${chunkFiles.length + 1}: ${frames} / ${chunk.duration} frames`));
      chunkFiles.push(chunkFile);
      finishedWork += chunk.duration;
      if (chunk.kind === 'dissolve') {
        await rm(path.join(directory, retained!.filename)); // NOSONAR -- free the old tail before processing another clip.
        retained = null;
      }
    }
    const outgoing = inputs.snapshot.transitions[index];
    if (outgoing?.type === 'cross-dissolve') retained = { index, filename: result.filename };
    else await rm(path.join(directory, result.filename)); // NOSONAR -- bound lossless scratch files to two clips.
  }
  if (retained) throw new ServiceError('Exporter retained an unused dissolve tail.', 500);
  return { chunkFiles, retiming };
}

async function renderVideo(inputs: ExportInputs, environment: RenderEnvironment): Promise<{ chunks: EncodedChunk[]; retiming: RawRetimingReport[]; layered: LayeredRenderReport | null }> {
  if (!('kind' in inputs.plan)) {
    const result = await renderClips(inputs, environment);
    return {
      chunks: result.chunkFiles.map((filename, index) => ({ filename, duration: inputs.plan.chunks[index]!.duration })),
      retiming: result.retiming, layered: null
    };
  }
  const { library, directory, context, target } = environment;
  const result = await renderLayeredExport({
    document: inputs.snapshot, plan: inputs.plan, assets: inputs.assets,
    ffmpeg: library.config.ffmpeg, directory, context, target
  });
  checkCancelled(context);
  const filename = 'chunk-layered.mp4';
  // The RGB channels already contain the premultiplied composite. Dropping alpha
  // flattens against opaque black, including completely empty/disabled-layer holds.
  await runProcess(library.config.ffmpeg, [...BASE_ARGS, '-xerror', '-err_detect', 'explode', '-threads', '2', '-i', result.filename,
    '-map', '0:v:0', '-filter_threads', '2', '-vf', `format=gbrp16le,${CLOCK},${RGB_TO_VIDEO}`,
  ...h264Arguments(target, inputs.plan.duration), filename], {
    cwd: directory, signal: context.signal, onProgress: (fields) => {
      const frame = Number(fields['frame']);
      if (Number.isFinite(frame)) context.update(0.82 + 0.01 * Math.max(0, Math.min(1, frame / inputs.plan.duration)), 'Encoding the complete layered composite to H.264 once');
    }
  });
  result.report.nativeVideoProcesses++;
  result.report.peakIntermediateVideoDecoders = Math.max(result.report.peakIntermediateVideoDecoders, 1);
  await rm(path.join(directory, result.filename));
  return { chunks: [{ filename, duration: inputs.plan.duration }], retiming: result.retiming, layered: result.report };
}

async function renderCapturedExport(inputs: ExportInputs, library: MediaLibrary, context: JobContext, resolveAudio?: AudioResolver): Promise<void> {
  checkCancelled(context);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.id)) throw new ServiceError('Export job directories require a UUID.', 422);
  const directory = path.join(library.config.dataDir, 'renders', context.id);
  const work = path.join(directory, 'work');
  const partial = path.join(directory, 'export.partial.mp4');
  let owned = false;
  let succeeded = false;
  try {
    // A queued job may start long after the dialog check; re-read free space before ownership/native work.
    context.update(0, 'Checking available export storage');
    requireExportReserve(await readExportSpace(library.config.dataDir, inputs.snapshot, inputs.profile));
    checkCancelled(context);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    // EEXIST deliberately fails, and never grants cleanup ownership of an older export.
    await mkdir(directory, { mode: 0o700 });
    owned = true;
    await mkdir(work, { mode: 0o700 });
    context.update(0.01, 'Validating immutable export snapshot and original source identities');
    const uniqueAssets = [...new Map(inputs.assets.map((asset) => [asset.id, asset])).values()];
    await checkSources(uniqueAssets, null);
    const musicSource = inputs.snapshot.music
      ? validateExportAudio(inputs.snapshot.music, await resolveRequiredAudio(inputs.snapshot.music.mediaId, resolveAudio)) : null;
    if (musicSource) await assertSourceIdentity(musicSource.sourcePath, musicSource.fingerprint, true);
    const music = inputs.snapshot.music ? planExportMusic(inputs.snapshot.music, inputs.plan.duration) : null;
    checkCancelled(context);
    const target = EXPORT_PROFILES[inputs.profile];
    const { chunks, retiming, layered } = await renderVideo(inputs, { library, directory: work, context, target });
    checkCancelled(context);
    if (musicSource && music?.activeSamples) {
      context.update(0.83, 'Trimming only the selected original music range to bounded PCM');
      await prepareMusic(musicSource, music, library, work, context);
    }
    context.update(0.85, 'Assembling exact-clock H.264 chunks without re-encoding video');
    await muxExport(inputs, chunks, music, library, work, partial, context);
    context.update(0.93, 'Verifying video timing, dimensions, SDR, AAC and full native decode');
    const verification = await verifyExport(partial, inputs, library, context);
    context.update(0.97, 'Rechecking original fingerprints before publishing');
    await checkSources(uniqueAssets, musicSource);
    checkCancelled(context);
    const receipt: ExportReceipt = {
      kind: 'export', schemaVersion: 1, jobId: context.id, createdAt: new Date().toISOString(), snapshot: inputs.snapshot, profile: inputs.profile,
      sources: uniqueAssets.map((asset) => ({ id: asset.id, sourcePath: asset.sourcePath, fingerprint: asset.fingerprint, metadata: asset.metadata })),
      musicSource, timeline: inputs.plan, retiming, verification,
      settings: {
        target, codec: 'h264', codecProfile: 'high', pixelFormat: 'yuv420p', colour: 'limited BT.709 SDR',
        frameRate: PROJECT_FPS, timeBase: '1/30000', lutInterpolation: 'tetrahedral', retiming: 'shared placed.retiming.sourceAt (static compileRetiming)',
        pipeline: layered ? 'sequential-layered' : 'static-single-layer',
        intermediate: layered ? 'lossless RGB8 clips + premultiplied RGBA16 FFV1/gbrap16le NUT' : 'lossless RGB FFV1/bgr0 NUT',
        resources: layered ? LAYERED_EXPORT_RESOURCES : EXPORT_RESOURCES, layered,
        grading: layered
          ? 'shared sampleTimeline evaluates independently participating layer point channels at absolute project frames across every clip in the row; source frames use placed.retiming.sourceAt(projectFrame - placed.start); at most two reusable in-memory CPU-reference 65³ Float32 LUTs, tetrahedral approximation (not bitwise); clip brightness after grading, coverage independent of black fades, layer opacity after the dissolve group; source-over encoded BT.709; black padding after grade'
          : 'One static CPU-reference 65³ LUT per instance, native tetrahedral interpolation before output-frame black fades',
        scratchPolicy: layered
          ? 'At most two full lossless timeline representations (a span collection counts as one) and two RGB clip files. Delete the lower timeline before joining the next lane, and clip files immediately after their last span. One final H.264 encode. No LUT files. Disk scales with two timelines + two clips + the H.264 chunk and final MP4 + selected PCM; not a fixed GB limit. All owned scratch/partials removed on failure/cancel; successful exports never overwritten.'
          : 'At most two complete lossless clips; delete the previous clip immediately after its tail. Keep compressed chunks and selected PCM until mux/verification. Peak disk scales with two clips + chunks + selected PCM + final MP4, not all lossless clips. All scratch removed before publication; failed/cancelled job directory removed.',
        audio: music, audioPlacement: '48 kHz stereo AAC (mono duplicated without attenuation), linear afade, explicit gain, selected-range loop; streamed silence prefix and pad/trim to video duration; no normalization or source-video audio'
      },
    };
    await atomicWrite(path.join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    await rm(work, { recursive: true, force: true });
    checkCancelled(context);
    await rename(partial, path.join(directory, 'export.mp4'));
    checkCancelled(context);
    context.update(0.99, 'Export verified and ready');
    succeeded = true;
  } catch (cause) {
    throw exportStorageFailure(cause, directory);
  } finally {
    if (owned && !succeeded) await rm(directory, { recursive: true, force: true });
  }
}

function requireRetained(retained: { index: number; filename: string } | null, index: number): string {
  if (retained?.index !== index) throw new ServiceError('Dissolve requires the preceding lossless tail.', 500);
  return retained.filename;
}
async function resolveRequiredAudio(id: string, resolveAudio?: AudioResolver): Promise<AudioAsset> {
  if (!resolveAudio) throw new ServiceError('A music source resolver is required for this export.', 422);
  return resolveAudio(id);
}