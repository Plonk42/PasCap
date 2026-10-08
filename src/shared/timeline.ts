import type { ColourSettings } from './colour.js';
import { colourAt, opacityAt } from './composition.js';
import { compileLayerRetiming } from './layer-retiming.js';
import type { ProjectDocument, Transition, VideoClip, VideoLayer } from './model.js';
import { evaluateSpatial, type SpatialPose } from './spatial.js';
import type { Retiming } from './speed.js';

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
  if (!layer) throw new Error('Clip references an unknown video layer.');
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

function regionConsumption(transition: Transition | undefined, side: 'in' | 'out'): number {
  if (!transition || transition.type === 'cut') return 0;
  if (transition.type === 'cross-dissolve') return transition.duration;
  return blackFadeParts(transition.duration)[side];
}

function validateTopology(project: ProjectDocument): void {
  if (new Set(project.layers.map((layer) => layer.id)).size !== project.layers.length)
    throw new Error('Layer IDs must be unique.');
  if (project.clips.some((clip) => !project.layers.some((layer) => layer.id === clip.layerId)))
    throw new Error('Clip references an unknown video layer.');
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
  if (regionConsumption(incoming, 'in') + regionConsumption(outgoing, 'out') + opening + closing > duration)
    throw new Error(`Fade/transition regions overlap or exceed clip ${clip.id}.`);
}

function placeTransition(layerId: string, transition: Transition, start: number): PlacedTransition {
  if (transition.type === 'cross-dissolve')
    return { layerId, transition, start, boundary: start + transition.duration, end: start + transition.duration };
  if (transition.type === 'fade-through-black') {
    const parts = blackFadeParts(transition.duration);
    return { layerId, transition, start: start - parts.out, boundary: start, end: start + parts.in };
  }
  return { layerId, transition, start, boundary: start, end: start };
}

function placementStart(
  clip: VideoClip,
  layer: VideoLayer,
  previous: PlacedClip | undefined,
  incoming: Transition | undefined,
): number {
  if (!layer.ripple || !previous) return clip.start;
  const overlap = incoming?.type === 'cross-dissolve' ? incoming.duration : 0;
  return previous.end - overlap;
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
    const retiming = compileLayerRetiming(clip, layer, start);
    const duration = retiming.duration;
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
  const tracks = project.layers.map((layer) => placeLayer(project, layer));
  const clips = tracks.flatMap((track) => track.clips);
  const duration = Math.max(
    0,
    ...clips.map((clip) => clip.end),
    ...project.music.map((track) => track.start + track.duration),
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
        spatial: evaluateSpatial(placed.clip.spatial, sourcePosition),
        colour: colourAt(layer, frame),
        weight: blendWeight * brightness,
        blendWeight,
        brightness,
        opacity: opacities.get(layer.id)!,
      },
    ];
  });
}
