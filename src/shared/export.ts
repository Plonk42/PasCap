import { z } from 'zod';
import { isNeutralAdvancedColour } from './colour.js';
import {
  MAX_MUSIC_TRACKS,
  MAX_VIDEO_LAYERS,
  projectSchema,
  type MusicTrack,
  type ProjectDocument,
  type Transition,
  type VideoLayer,
} from './model.js';
import { hasSpatialEdits } from './spatial.js';
import { blackFadeParts, calculateLayout, type PlacedClip, type TimelineLayout } from './timeline.js';
import { PROJECT_FPS, sameRate } from './timing.js';

export const exportProfileSchema = z.enum(['draft720', 'final4k']);
export type ExportProfile = z.infer<typeof exportProfileSchema>;

export const exportDocumentSchema = projectSchema
  .refine((document) => document.clips.length > 0, {
    message: 'An export requires at least one video clip.',
  })
  .refine((document) => sameRate(document.frameRate, PROJECT_FPS), {
    message: 'Exports require the project rate 30000/1001.',
  });
export const MAX_EXPORT_NAME_LENGTH = 100;
/** Used only as a label and download name, never as a path. */
export const exportOutputNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter an output name.')
  .max(MAX_EXPORT_NAME_LENGTH, `Use at most ${MAX_EXPORT_NAME_LENGTH} characters.`)
  .refine((name) => !/[\p{Cc}/\\]/u.test(name), { message: 'Use no slashes or control characters.' });
export const exportRequestSchema = z
  .object({
    document: exportDocumentSchema,
    profile: exportProfileSchema,
    outputName: exportOutputNameSchema.optional(),
  })
  .strict();
export function defaultExportName(title: string, profile: ExportProfile): string {
  return `${title} · ${profile === 'draft720' ? '720p' : '4K'}`;
}
export type ExportRequest = z.infer<typeof exportRequestSchema>;

export interface ExportProfileSettings {
  width: number;
  height: number;
  crf: number;
  preset: 'veryfast' | 'medium';
  level: '3.1' | '5.1';
}
export const EXPORT_PROFILES: Readonly<Record<ExportProfile, Readonly<ExportProfileSettings>>> = Object.freeze({
  draft720: Object.freeze({ width: 1280, height: 720, crf: 18, preset: 'veryfast', level: '3.1' }),
  final4k: Object.freeze({ width: 3840, height: 2160, crf: 18, preset: 'medium', level: '5.1' }),
});

/** Limits are per process, not a promise that native codecs use only one frame. */
export const EXPORT_RESOURCES = Object.freeze({
  threadsPerDecoder: 2,
  threadsPerEncoder: 2,
  filterThreads: 2,
  maxOriginalVideoDecoders: 1,
  maxIntermediateVideoDecoders: 2,
  maxLosslessClipsOnDisk: 2,
  rawFrameBuffers: 1,
  stderrBytesPerChild: 32_768,
  terminateGraceMs: 2_000,
  lutSize: 65,
  audioSampleRate: 48_000,
  audioChannels: 2,
  maxMusicTracks: MAX_MUSIC_TRACKS,
  maxOriginalAudioDecoders: 1,
  maxIntermediateAudioInputs: 2,
  maxNativeAudioChildrenPerPass: 1,
  maxAudioScratchFiles: 3,
  audioAccumulatorBits: 64,
});

/** Sequential passes, never one decoder per project layer or one process per frame. */
export const LAYERED_EXPORT_RESOURCES = Object.freeze({
  ...EXPORT_RESOURCES,
  maxVideoLayers: MAX_VIDEO_LAYERS,
  maxVideoEncoders: 1,
  maxNativeVideoChildrenPerPass: 3,
  maxLosslessTimelineRepresentations: 3,
  rawFrameBuffers: 4,
  rawBytesPerPixel: 22, // Two RGB8 source frames + two premultiplied RGBA16 group/accumulator frames.
  maxInMemoryLuts: 2,
  lutBytes: 65 ** 3 * 3 * Float32Array.BYTES_PER_ELEMENT,
  intermediateBitsPerChannel: 16,
});

/** Static chunks support only neutral HSL/curves on an opaque, unanimated, zero-origin contiguous track
 * covering the entire project, including every music instance's OUT. */
export function needsLayeredExport(document: ProjectDocument): boolean {
  if (
    document.layers.length !== 1 ||
    document.clips.some((clip) => hasSpatialEdits(clip.spatial)) ||
    document.layers.some(
      (layer) =>
        !layer.enabled || layer.opacity !== 1 || layer.keyframes.length > 0 || !isNeutralAdvancedColour(layer.colour),
    )
  )
    return true;
  const { clips, duration } = calculateLayout(document);
  return (
    (clips.at(-1)?.end ?? 0) < duration ||
    clips.some((placed, index) => (index === 0 ? placed.start !== 0 : placed.start > clips[index - 1]!.end))
  );
}

export interface ExportClipPlan {
  /** Index in document.clips, independent of chronological/sequence or stack order. */
  index: number;
  clipId: string;
  duration: number;
  bodyIn: number;
  bodyOut: number;
  fadeIn: number;
  fadeOut: number;
}
export type ExportChunk =
  | {
      kind: 'body';
      clipIndex: number;
      sourceIn: number;
      sourceOut: number;
      duration: number;
      start: number;
    }
  | {
      kind: 'dissolve';
      leftIndex: number;
      rightIndex: number;
      leftIn: number;
      duration: number;
      start: number;
    };
/** Clip plans are in track order; chunk source offsets address RETIMED output frames.
 * Duration is the absolute track OUT (zero for an empty track), not the sum of
 * occupied frames. Layered export fills leading/internal/trailing gaps separately.
 */
export interface ExportPlan {
  duration: number;
  clips: ExportClipPlan[];
  chunks: ExportChunk[];
}
export interface LayeredExportLayer {
  id: string;
  enabled: boolean;
  clips: { index: number; clipId: string; start: number; end: number; duration: number }[];
  /** Chunks have absolute project-frame starts; gaps are filled transparently by the renderer. */
  plan: ExportPlan;
}
export interface LayeredExportPlan extends ExportPlan {
  kind: 'layered';
  /** Bottom-to-top composition order; top-level clips flatten the per-track plans. */
  layers: LayeredExportLayer[];
  /** No independently H.264-encoded chunks: encode the complete composite once. */
  chunks: [];
}

function blackFadeLength(transition: Transition | undefined, side: 'in' | 'out'): number {
  return transition?.type === 'fade-through-black' ? blackFadeParts(transition.duration)[side] : 0;
}
function planClip(
  layer: VideoLayer,
  placed: PlacedClip,
  trackIndex: number,
  trackCount: number,
  index: number,
): ExportClipPlan {
  const incoming = layer.transitions[trackIndex - 1];
  const outgoing = layer.transitions[trackIndex];
  return {
    index,
    clipId: placed.clip.id,
    duration: placed.duration,
    bodyIn: incoming?.type === 'cross-dissolve' ? incoming.duration : 0,
    bodyOut: placed.duration - (outgoing?.type === 'cross-dissolve' ? outgoing.duration : 0),
    fadeIn: trackIndex === 0 ? layer.openingFade : blackFadeLength(incoming, 'in'),
    fadeOut: trackIndex === trackCount - 1 ? layer.closingFade : blackFadeLength(outgoing, 'out'),
  };
}

function validateDuration(layout: TimelineLayout): void {
  if (!Number.isSafeInteger(layout.duration) || layout.duration > 2_147_483_647) {
    throw new Error('Export duration exceeds the supported integer project-frame range.');
  }
}

function trackPlan(snapshot: ProjectDocument, layout: TimelineLayout, layer: VideoLayer): ExportPlan {
  const track = layout.clips.filter((placed) => placed.clip.layerId === layer.id);
  const indices = new Map(snapshot.clips.map((clip, index) => [clip.id, index]));
  const clips: ExportClipPlan[] = [];
  const chunks: ExportChunk[] = [];
  let cursor = 0;
  for (const [trackIndex, placed] of track.entries()) {
    const index = indices.get(placed.clip.id)!;
    const incoming = layer.transitions[trackIndex - 1];
    const clip = planClip(layer, placed, trackIndex, track.length, index);
    clips.push(clip);
    if (incoming?.type === 'cross-dissolve') {
      chunks.push({
        kind: 'dissolve',
        leftIndex: indices.get(track[trackIndex - 1]!.clip.id)!,
        rightIndex: index,
        leftIn: track[trackIndex - 1]!.duration - incoming.duration,
        duration: incoming.duration,
        start: placed.start,
      });
    }
    if (clip.bodyOut > clip.bodyIn) {
      chunks.push({
        kind: 'body',
        clipIndex: index,
        sourceIn: clip.bodyIn,
        sourceOut: clip.bodyOut,
        duration: clip.bodyOut - clip.bodyIn,
        start: placed.start + clip.bodyIn,
      });
    }
  }
  for (const chunk of chunks) {
    if (chunk.start < cursor || chunk.duration < 1)
      throw new Error('Track chunks overlap or have an invalid duration.');
    cursor = chunk.start + chunk.duration;
  }
  const duration = track.at(-1)?.end ?? 0;
  if (cursor !== duration) throw new Error('Export chunks do not reach the authoritative track OUT exactly.');
  return { duration, clips, chunks };
}

/** Static single-track optimization; unsupported placement/coverage always uses layered export. */
export function planExport(document: ProjectDocument): ExportPlan {
  const snapshot = exportDocumentSchema.parse(document);
  if (needsLayeredExport(snapshot))
    throw new Error(
      'Multiple/disabled tracks, opacity, shared track keyframes, HSL/curves, spatial edits, gaps, leading starts or music beyond video OUT require the layered exporter, not a static chunk plan.',
    );
  const layout = calculateLayout(snapshot);
  validateDuration(layout);
  const plan = trackPlan(snapshot, layout, snapshot.layers[0]!);
  let cursor = 0;
  for (const chunk of plan.chunks) {
    if (chunk.start !== cursor) throw new Error('Static export chunks must cover every project frame without gaps.');
    cursor += chunk.duration;
  }
  if (cursor !== layout.duration)
    throw new Error('Static export chunks do not cover the authoritative timeline exactly.');
  return plan;
}

/** Uniform track plans in composition order, including disabled placements and all project gaps. */
export function planLayeredExport(document: ProjectDocument): LayeredExportPlan {
  const snapshot = exportDocumentSchema.parse(document);
  const layout = calculateLayout(snapshot);
  validateDuration(layout);
  const indices = new Map(snapshot.clips.map((clip, index) => [clip.id, index]));
  const layers = snapshot.layers.map((layer) => ({
    id: layer.id,
    enabled: layer.enabled,
    plan: trackPlan(snapshot, layout, layer),
    clips: layout.clips
      .filter((placed) => placed.clip.layerId === layer.id)
      .map((placed) => ({
        index: indices.get(placed.clip.id)!,
        clipId: placed.clip.id,
        start: placed.start,
        end: placed.end,
        duration: placed.duration,
      })),
  }));
  return {
    kind: 'layered',
    duration: layout.duration,
    chunks: [],
    layers,
    clips: layers.flatMap((layer) => layer.plan.clips),
  };
}

export function exportAudioSample(frame: number): number {
  const samples = Math.round(
    (frame * PROJECT_FPS.denominator * EXPORT_RESOURCES.audioSampleRate) / PROJECT_FPS.numerator,
  );
  if (!Number.isSafeInteger(samples) || samples < 0)
    throw new Error('Audio positions must fit non-negative integer sample counts.');
  return samples;
}
export interface ExportMusicPlan {
  id: string;
  mediaId: string;
  loop: boolean;
  sourceInSamples: number;
  sourceOutSamples: number;
  startSamples: number;
  durationSamples: number;
  activeSamples: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  videoSamples: number;
  gain: number;
}
/** videoSamples is the complete project duration, including music-only black tails. */
export function planExportMusic(music: MusicTrack, projectFrames: number): ExportMusicPlan {
  const videoSamples = exportAudioSample(projectFrames);
  const startSamples = exportAudioSample(music.start);
  const durationSamples = exportAudioSample(music.duration);
  return {
    id: music.id,
    mediaId: music.mediaId,
    loop: music.loop,
    sourceInSamples: exportAudioSample(music.sourceIn),
    sourceOutSamples: exportAudioSample(music.sourceOut),
    startSamples,
    durationSamples,
    activeSamples: Math.max(0, Math.min(durationSamples, videoSamples - startSamples)),
    fadeInSamples: exportAudioSample(music.fadeIn),
    fadeOutSamples: exportAudioSample(music.fadeOut),
    videoSamples,
    gain: 10 ** (music.gainDb / 20),
  };
}
