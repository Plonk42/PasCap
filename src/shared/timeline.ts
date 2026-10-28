import { NEUTRAL_COLOUR, type ColourSettings } from './colour.js';
import { colourAt, opacityAt } from './composition.js';
import { NEUTRAL_DETAIL, type DetailSettings } from './detail.js';
import { gradeColourAt } from './grade.js';
import type { ProjectDocument, Transition, VideoClip, VideoLayer } from './model.js';
import { musicClips, validateMusicLane } from './music-lanes.js';
import { evaluateSpatial, type SpatialPose } from './spatial.js';
import { compileRetiming, type Retiming } from './speed.js';

export interface PlacedClip {
  clip: VideoClip;
  start: number;
  end: number;
  duration: number;
  retiming: Retiming;
}
export interface PlacedTransition {
  layerId: string;
  transition: Transition;
  start: number;
  boundary: number;
  end: number;
  /** Frames the transition owns between the left OUT and the right start, if any. */
  slot: { start: number; end: number } | null;
}
export interface TimelineLayout {
  clips: PlacedClip[];
  transitions: PlacedTransition[];
  duration: number;
}
export interface PreviewLayer {
  clipId: string;
  mediaId: string;
  layerId: string;
  sourceFrame: number;
  sourcePosition: number;
  spatial: SpatialPose;
  detail: DetailSettings;
  /** The clip's own Colour at the source frame shown, applied before the track's. */
  grade: ColourSettings;
  /** The track's Colour at the project frame. */
  colour: ColourSettings;
  weight: number;
  blendWeight: number;
  brightness: number;
  opacity: number;
}

/** Ripple follows saved clip order. Positioned tracks follow chronological starts;
 * stored pair order disambiguates a legal equal-start full-overlap dissolve. */
export function layerClips(project: ProjectDocument, layerId: string): VideoClip[] {
  const layer = project.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error('Clip references an unknown video track.');
  const clips = project.clips.filter((clip) => clip.layerId === layerId);
  if (layer.ripple) return clips;
  const pairOrder = new Map<string, number>();
  for (const [index, transition] of layer.transitions.entries()) {
    pairOrder.set(transition.leftId, index);
    pairOrder.set(transition.rightId, index + 1);
  }
  return clips.sort(
    (left, right) =>
      left.start - right.start || (pairOrder.get(left.id) ?? clips.length) - (pairOrder.get(right.id) ?? clips.length),
  );
}

export function blackFadeParts(duration: number): { out: number; in: number } {
  return { out: Math.ceil(duration / 2), in: Math.floor(duration / 2) };
}

/** Frames a transition owns between its clips, rendered by the transition itself rather than footage. */
export function transitionSlot(transition: Transition | undefined): number {
  return transition?.type === 'fade-black-pause' ? transition.pause : 0;
}

/** Signed frames from the left clip's OUT to the right clip's start: negative overlap or a positive slot. */
export function transitionOffset(transition: Transition | undefined): number {
  return transition?.type === 'cross-dissolve' ? -transition.duration : transitionSlot(transition);
}

/** Footage frames a transition consumes at the end of its left clip ('out') or start of its right clip ('in'). */
export function transitionConsumption(transition: Transition | undefined, side: 'in' | 'out'): number {
  if (!transition || transition.type === 'cut') return 0;
  if (transition.type === 'cross-dissolve') return transition.duration;
  if (transition.type === 'fade-black-pause') return transition.fade;
  return blackFadeParts(transition.duration)[side];
}

function validateTopology(project: ProjectDocument): void {
  if (new Set(project.layers.map((layer) => layer.id)).size !== project.layers.length)
    throw new Error('Track IDs must be unique.');
  if (project.clips.some((clip) => !project.layers.some((layer) => layer.id === clip.layerId)))
    throw new Error('Clip references an unknown video track.');
  if (new Set(project.clips.map((clip) => clip.id)).size !== project.clips.length)
    throw new Error('Clip-instance IDs must be unique.');
  for (const layer of project.layers) {
    const clips = layerClips(project, layer.id);
    if (layer.transitions.length !== Math.max(0, clips.length - 1))
      throw new Error('Exactly one transition is required per adjacent track clip pair.');
    for (const [index, transition] of layer.transitions.entries()) {
      if (transition.leftId !== clips[index]?.id || transition.rightId !== clips[index + 1]?.id)
        throw new Error('Transitions must follow the ordered adjacent clip pairs on their own track.');
    }
  }
}

function validateClipRegions(
  clip: VideoClip,
  duration: number,
  incoming: Transition | undefined,
  outgoing: Transition | undefined,
  opening: number,
  closing: number,
): void {
  if (duration <= 0) throw new Error('Clips must contain at least one frame.');
  if (transitionConsumption(incoming, 'in') + transitionConsumption(outgoing, 'out') + opening + closing > duration)
    throw new Error(`Fade/transition regions overlap or exceed clip ${clip.id}.`);
}

function placeTransition(layerId: string, transition: Transition, start: number): PlacedTransition {
  if (transition.type === 'cross-dissolve') {
    const end = start + transition.duration;
    return { layerId, transition, start, boundary: end, end, slot: null };
  }
  if (transition.type === 'fade-through-black') {
    const parts = blackFadeParts(transition.duration);
    return { layerId, transition, start: start - parts.out, boundary: start, end: start + parts.in, slot: null };
  }
  if (transition.type === 'fade-black-pause') {
    const boundary = start - transition.pause;
    return {
      layerId,
      transition,
      start: boundary - transition.fade,
      boundary,
      end: start + transition.fade,
      slot: { start: boundary, end: start },
    };
  }
  return { layerId, transition, start, boundary: start, end: start, slot: null };
}

function placementStart(
  clip: VideoClip,
  layer: VideoLayer,
  previous: PlacedClip | undefined,
  incoming: Transition | undefined,
): number {
  if (!layer.ripple || !previous) return clip.start;
  return previous.end + transitionOffset(incoming);
}

function validatePlacement(
  placed: PlacedClip,
  previous: PlacedClip | undefined,
  earlier: PlacedClip | undefined,
  incoming: Transition | undefined,
): void {
  if (previous) {
    if (incoming?.type === 'cross-dissolve') {
      if (placed.start !== previous.end - incoming.duration)
        throw new Error('A cross-dissolve must have its exact stored overlap.');
    } else if (placed.start < previous.end)
      throw new Error('Clips on the same track cannot overlap except in an exact adjacent cross-dissolve.');
    if (incoming?.type === 'fade-through-black' && placed.start !== previous.end)
      throw new Error('Fade-through-black requires touching clips, not a gap.');
    if (incoming?.type === 'fade-black-pause' && placed.start !== previous.end + incoming.pause)
      throw new Error('A black pause must keep exactly its pause frames between the clips.');
  }
  if (earlier && placed.start < earlier.end) throw new Error('A track cannot contain a triple overlap.');
}

function placeLayer(
  project: ProjectDocument,
  layer: VideoLayer,
): { clips: PlacedClip[]; transitions: PlacedTransition[] } {
  const ordered = layerClips(project, layer.id);
  const clips: PlacedClip[] = [];
  const transitions: PlacedTransition[] = [];
  for (const [index, clip] of ordered.entries()) {
    const incoming = index > 0 ? layer.transitions[index - 1] : undefined;
    const outgoing = layer.transitions[index];
    const opening = index === 0 ? layer.openingFade : 0;
    const closing = index === ordered.length - 1 ? layer.closingFade : 0;
    const previous = clips[index - 1];
    const start = placementStart(clip, layer, previous, incoming);
    const retiming = compileRetiming(clip);
    const duration = retiming.duration;
    if (start + duration > 2_147_483_647) throw new RangeError('Track duration exceeds supported project frames.');
    validateClipRegions(clip, duration, incoming, outgoing, opening, closing);
    const placed = { clip, start, end: start + duration, duration, retiming };
    validatePlacement(placed, previous, clips[index - 2], incoming);
    clips.push(placed);
    if (incoming) transitions.push(placeTransition(layer.id, incoming, start));
  }
  return { clips, transitions };
}

/** Single authoritative layout and incompatible-region validation, shared by preview/export. */
export function calculateLayout(project: ProjectDocument): TimelineLayout {
  validateTopology(project);
  for (const [index, lane] of project.music.entries()) validateMusicLane(lane, index);
  const tracks = project.layers.map((layer) => placeLayer(project, layer));
  const clips = tracks.flatMap((track) => track.clips);
  const duration = Math.max(
    0,
    ...clips.map((clip) => clip.end),
    ...musicClips(project.music).map((clip) => clip.start + clip.duration),
  );
  if (!Number.isSafeInteger(duration) || duration > 2_147_483_647)
    throw new Error('Project duration exceeds the supported integer project-frame range.');
  return {
    clips,
    transitions: tracks.flatMap((track) => track.transitions),
    duration,
  };
}

export function fadeInWeight(offset: number, duration: number): number {
  return duration === 1 ? 0 : Math.min(1, Math.max(0, offset / (duration - 1)));
}
export function fadeOutWeight(offset: number, duration: number): number {
  return duration === 1 ? 0 : 1 - fadeInWeight(offset, duration);
}

function clipWeights(
  placed: PlacedClip,
  frame: number,
  layer: VideoLayer,
  layout: TimelineLayout,
): { blendWeight: number; brightness: number } {
  const region = layout.transitions.find(
    (item) =>
      item.layerId === layer.id &&
      frame >= item.start &&
      frame < item.end &&
      (item.transition.leftId === placed.clip.id || item.transition.rightId === placed.clip.id),
  );
  let blendWeight = 1;
  let brightness = 1;
  if (region?.transition.type === 'cross-dissolve') {
    const progress = (frame - region.start) / region.transition.duration;
    blendWeight = placed.clip.id === region.transition.leftId ? 1 - progress : progress;
  }
  if (region?.transition.type === 'fade-through-black') {
    const parts = blackFadeParts(region.transition.duration);
    brightness =
      placed.clip.id === region.transition.leftId
        ? fadeOutWeight(frame - region.start, parts.out)
        : fadeInWeight(frame - region.boundary, parts.in);
  }
  if (region?.transition.type === 'fade-black-pause') {
    const { fade } = region.transition;
    brightness =
      placed.clip.id === region.transition.leftId
        ? fadeOutWeight(frame - region.start, fade)
        : fadeInWeight(frame - placed.start, fade);
  }
  const clips = layout.clips.filter((item) => item.clip.layerId === layer.id);
  if (placed === clips[0] && frame < placed.start + layer.openingFade)
    brightness *= fadeInWeight(frame - placed.start, layer.openingFade);
  if (placed === clips.at(-1) && frame >= placed.end - layer.closingFade)
    brightness *= fadeOutWeight(frame - (placed.end - layer.closingFade), layer.closingFade);
  return { blendWeight, brightness };
}

export function sampleTimeline(
  project: ProjectDocument,
  frame: number,
  layout = calculateLayout(project),
): PreviewLayer[] {
  if (!Number.isInteger(frame) || frame < 0 || frame >= layout.duration) return [];
  const active = layout.clips.filter((placed) => frame >= placed.start && frame < placed.end);
  const opacities = new Map(project.layers.map((layer) => [layer.id, opacityAt(layer, frame)]));
  return active.flatMap((placed) => {
    const layer = project.layers.find((item) => item.id === placed.clip.layerId)!;
    if (!layer.enabled) return [];
    const sourceFrame = placed.retiming.sourceAt(frame - placed.start);
    const sourcePosition = placed.retiming.sourcePositionAt(frame - placed.start);
    const { blendWeight, brightness } = clipWeights(placed, frame, layer, layout);
    return [
      {
        clipId: placed.clip.id,
        mediaId: placed.clip.mediaId,
        layerId: layer.id,
        sourceFrame,
        sourcePosition,
        spatial: evaluateSpatial(layer.transform, frame),
        detail: placed.clip.detail,
        grade: gradeColourAt(placed.clip.grade, sourceFrame),
        colour: colourAt(layer, frame),
        weight: blendWeight * brightness,
        blendWeight,
        brightness,
        opacity: opacities.get(layer.id)!,
      },
    ];
  });
}

/**
 * Layers a transition draws in its own timeslot, where no clip is active on its track. They
 * need no decoded image: a black pause is the left clip's geometry at brightness 0, so it keeps
 * the track's Transform coverage and Opacity like a fade through black.
 */
export function sampleSlots(
  project: ProjectDocument,
  frame: number,
  layout = calculateLayout(project),
): PreviewLayer[] {
  return layout.transitions.flatMap(({ layerId, transition, slot }) => {
    if (!slot || frame < slot.start || frame >= slot.end) return [];
    const layer = project.layers.find((item) => item.id === layerId)!;
    if (!layer.enabled) return [];
    const left = layout.clips.find((item) => item.clip.id === transition.leftId)!;
    const last = left.duration - 1;
    return [
      {
        clipId: left.clip.id,
        mediaId: left.clip.mediaId,
        layerId,
        sourceFrame: left.retiming.sourceAt(last),
        sourcePosition: left.retiming.sourcePositionAt(last),
        spatial: evaluateSpatial(layer.transform, frame),
        detail: { ...NEUTRAL_DETAIL },
        grade: structuredClone(NEUTRAL_COLOUR),
        colour: structuredClone(NEUTRAL_COLOUR),
        weight: 0,
        blendWeight: 1,
        brightness: 0,
        opacity: opacityAt(layer, frame),
      },
    ];
  });
}
