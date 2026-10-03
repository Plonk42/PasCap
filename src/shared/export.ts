import { z } from 'zod';
import { MAX_VIDEO_LAYERS, projectSchema, type MusicTrack, type ProjectDocument, type Transition } from './model.js';
import { blackFadeParts, calculateLayout, type PlacedClip, type TimelineLayout } from './timeline.js';
import { PROJECT_FPS, sameRate } from './timing.js';

export const exportProfileSchema = z.enum(['draft720', 'final4k']);
export type ExportProfile = z.infer<typeof exportProfileSchema>;

export const exportDocumentSchema = projectSchema.refine((document) => document.clips.length > 0, {
  message: 'An export requires at least one video clip.',
}).refine((document) => sameRate(document.frameRate, PROJECT_FPS), {
  message: 'Exports require the project rate 30000/1001.',
});
export const exportRequestSchema = z.object({ document: exportDocumentSchema, profile: exportProfileSchema }).strict();
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
});

/** Sequential passes, never one decoder per project layer or one process per frame. */
export const LAYERED_EXPORT_RESOURCES = Object.freeze({
  ...EXPORT_RESOURCES,
  maxVideoLayers: MAX_VIDEO_LAYERS,
  maxVideoEncoders: 1,
  maxNativeVideoChildrenPerPass: 3,
  maxLosslessTimelineRepresentations: 2,
  rawFrameBuffers: 3,
  rawBytesPerPixel: 14, // One premultiplied RGBA16 accumulator and two RGB8 clip frames.
  maxInMemoryLuts: 2,
  lutBytes: 65 ** 3 * 3 * Float32Array.BYTES_PER_ELEMENT,
  intermediateBitsPerChannel: 16,
});

/** Every shared row point, including speed-only/neutral points, needs contextual sampling. */
export function needsLayeredExport(document: ProjectDocument): boolean {
  return document.layers.length !== 1 || document.layers.some((layer) => !layer.enabled || layer.opacity !== 1 || layer.keyframes.length > 0) ||
    document.clips.some((clip) => clip.opacity !== 1);
}

export interface ExportClipPlan {
  index: number;
  clipId: string;
  duration: number;
  bodyIn: number;
  bodyOut: number;
  fadeIn: number;
  fadeOut: number;
}
export type ExportChunk = {
  kind: 'body'; clipIndex: number; sourceIn: number; sourceOut: number; duration: number; start: number;
} | {
  kind: 'dissolve'; leftIndex: number; rightIndex: number; leftIn: number; duration: number; start: number;
};
export interface ExportPlan { duration: number; clips: ExportClipPlan[]; chunks: ExportChunk[] }
export interface LayeredExportLayer {
  id: string;
  enabled: boolean;
  clips: { index: number; clipId: string; start: number; end: number; duration: number }[];
}
export interface LayeredExportPlan extends ExportPlan {
  kind: 'layered';
  baseDuration: number;
  layers: LayeredExportLayer[];
  primary: ExportPlan;
  /** No independently H.264-encoded chunks: encode the complete composite once. */
  chunks: [];
}

function blackFadeLength(transition: Transition | undefined, side: 'in' | 'out'): number {
  return transition?.type === 'fade-through-black' ? blackFadeParts(transition.duration)[side] : 0;
}
function planClip(snapshot: ProjectDocument, placed: PlacedClip, primaryIndex: number, primaryCount: number, index: number): ExportClipPlan {
  const incoming = snapshot.transitions[primaryIndex - 1];
  const outgoing = snapshot.transitions[primaryIndex];
  return {
    index, clipId: placed.clip.id, duration: placed.duration,
    bodyIn: incoming?.type === 'cross-dissolve' ? incoming.duration : 0,
    bodyOut: placed.duration - (outgoing?.type === 'cross-dissolve' ? outgoing.duration : 0),
    fadeIn: primaryIndex === 0 ? snapshot.openingFade : blackFadeLength(incoming, 'in'),
    fadeOut: primaryIndex === primaryCount - 1 ? snapshot.closingFade : blackFadeLength(outgoing, 'out'),
  };
}

function validateDuration(layout: TimelineLayout): void {
  if (!Number.isSafeInteger(layout.duration) || layout.duration > 2_147_483_647) {
    throw new Error('Export duration exceeds the supported integer project-frame range.');
  }
}

function primaryPlan(snapshot: ProjectDocument, layout: TimelineLayout): ExportPlan {
  const primary = layout.clips.filter((placed) => placed.clip.layerId === snapshot.layers[0]!.id);
  const indices = new Map(snapshot.clips.map((clip, index) => [clip.id, index]));
  const clips: ExportClipPlan[] = [];
  const chunks: ExportChunk[] = [];
  let cursor = 0;
  for (const [primaryIndex, placed] of primary.entries()) {
    const index = indices.get(placed.clip.id)!;
    const incoming = snapshot.transitions[primaryIndex - 1];
    const clip = planClip(snapshot, placed, primaryIndex, primary.length, index);
    clips.push(clip);
    if (incoming?.type === 'cross-dissolve') {
      chunks.push({
        kind: 'dissolve', leftIndex: indices.get(primary[primaryIndex - 1]!.clip.id)!, rightIndex: index,
        leftIn: primary[primaryIndex - 1]!.duration - incoming.duration, duration: incoming.duration, start: cursor
      });
      cursor += incoming.duration;
    }
    if (clip.bodyOut > clip.bodyIn) {
      chunks.push({ kind: 'body', clipIndex: index, sourceIn: clip.bodyIn, sourceOut: clip.bodyOut, duration: clip.bodyOut - clip.bodyIn, start: cursor });
      cursor += clip.bodyOut - clip.bodyIn;
    }
  }
  if (cursor !== layout.baseDuration) throw new Error('Export chunks do not cover the authoritative primary timeline exactly.');
  return { duration: layout.baseDuration, clips, chunks };
}

/** Cheap static single-layer plan. Never silently drop layers, opacity or shared row points. */
export function planExport(document: ProjectDocument): ExportPlan {
  const snapshot = exportDocumentSchema.parse(document);
  if (needsLayeredExport(snapshot)) throw new Error('Layers, opacity and shared project-frame layer points require the layered exporter, not a static chunk plan.');
  const layout = calculateLayout(snapshot);
  validateDuration(layout);
  return primaryPlan(snapshot, layout);
}

/** All placements, including disabled layers and black holds past the primary end. */
export function planLayeredExport(document: ProjectDocument): LayeredExportPlan {
  const snapshot = exportDocumentSchema.parse(document);
  const layout = calculateLayout(snapshot);
  validateDuration(layout);
  const primary = primaryPlan(snapshot, layout);
  const indices = new Map(snapshot.clips.map((clip, index) => [clip.id, index]));
  const primaryClips = new Map(primary.clips.map((clip) => [clip.clipId, clip]));
  return {
    kind: 'layered', duration: layout.duration, baseDuration: layout.baseDuration, chunks: [], primary,
    clips: layout.clips.map((placed) => primaryClips.get(placed.clip.id) ?? {
      index: indices.get(placed.clip.id)!, clipId: placed.clip.id, duration: placed.duration,
      bodyIn: 0, bodyOut: placed.duration, fadeIn: 0, fadeOut: 0,
    }),
    layers: snapshot.layers.map((layer) => ({
      id: layer.id, enabled: layer.enabled,
      clips: layout.clips.filter((placed) => placed.clip.layerId === layer.id).map((placed) => ({
        index: indices.get(placed.clip.id)!, clipId: placed.clip.id, start: placed.start, end: placed.end, duration: placed.duration,
      })),
    })),
  };
}

export function exportAudioSample(frame: number): number {
  const samples = Math.round(frame * PROJECT_FPS.denominator * EXPORT_RESOURCES.audioSampleRate / PROJECT_FPS.numerator);
  if (!Number.isSafeInteger(samples) || samples < 0) throw new Error('Audio positions must fit non-negative integer sample counts.');
  return samples;
}
export interface ExportMusicPlan {
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
export function planExportMusic(music: MusicTrack, videoFrames: number): ExportMusicPlan {
  const videoSamples = exportAudioSample(videoFrames);
  const startSamples = exportAudioSample(music.start);
  const durationSamples = exportAudioSample(music.duration);
  return {
    sourceInSamples: exportAudioSample(music.sourceIn), sourceOutSamples: exportAudioSample(music.sourceOut),
    startSamples, durationSamples, activeSamples: Math.max(0, Math.min(durationSamples, videoSamples - startSamples)),
    fadeInSamples: exportAudioSample(music.fadeIn), fadeOutSamples: exportAudioSample(music.fadeOut),
    videoSamples, gain: 10 ** (music.gainDb / 20),
  };
}