import type { ColourSettings } from './colour.js';
import { colourAt, layerOpacityAt, opacityAt } from './composition.js';
import { compileLayerRetiming } from './layer-retiming.js';
import type { ProjectDocument, Transition, VideoClip } from './model.js';
import type { Retiming } from './speed.js';

export interface PlacedClip { clip: VideoClip; start: number; end: number; duration: number; retiming: Retiming }
export interface PlacedTransition { transition: Transition; start: number; boundary: number; end: number }
export interface TimelineLayout { clips: PlacedClip[]; transitions: PlacedTransition[]; duration: number; baseDuration: number }
export interface PreviewLayer { clipId: string; mediaId: string; layerId: string; sourceFrame: number; colour: ColourSettings; weight: number; blendWeight: number; brightness: number; opacity: number; layerOpacity: number }

export function primaryClips(project: ProjectDocument): VideoClip[] { return project.clips.filter((clip) => clip.layerId === project.layers[0]!.id); }

export function blackFadeParts(duration: number): { out: number; in: number } {
  return { out: Math.ceil(duration / 2), in: Math.floor(duration / 2) };
}

function regionConsumption(transition: Transition | undefined, side: 'in' | 'out'): number {
  if (!transition || transition.type === 'cut') return 0;
  if (transition.type === 'cross-dissolve') return transition.duration;
  return blackFadeParts(transition.duration)[side];
}

function validateTopology(project: ProjectDocument): void {
  const primary = primaryClips(project);
  if (new Set(project.layers.map((layer) => layer.id)).size !== project.layers.length) throw new Error('Layer IDs must be unique.');
  if (project.layers[0]!.id !== 'video-1') throw new Error('The primary ripple layer must remain first.');
  if (project.clips.some((clip) => !project.layers.some((layer) => layer.id === clip.layerId))) throw new Error('Clip references an unknown video layer.');
  if (new Set(project.clips.map((clip) => clip.id)).size !== project.clips.length) throw new Error('Clip-instance IDs must be unique.');
  if (project.transitions.length !== Math.max(0, primary.length - 1)) throw new Error('Exactly one transition is required per adjacent primary clip pair.');
  for (const [index, transition] of project.transitions.entries()) {
    if (transition.leftId !== primary[index]?.id || transition.rightId !== primary[index + 1]?.id) throw new Error('Transitions must follow the ordered adjacent clip pairs.');
  }
}

function validateClipRegions(clip: VideoClip, duration: number, incoming: Transition | undefined, outgoing: Transition | undefined, opening: number, closing: number): void {
  if (duration <= 0) throw new Error('Clips must contain at least one frame.');
  if (regionConsumption(incoming, 'in') + regionConsumption(outgoing, 'out') + opening + closing > duration) throw new Error(`Fade/transition regions overlap or exceed clip ${clip.id}.`);
}

function placeTransition(transition: Transition, start: number): PlacedTransition {
  if (transition.type === 'cross-dissolve') return { transition, start, boundary: start + transition.duration, end: start + transition.duration };
  if (transition.type === 'fade-through-black') {
    const parts = blackFadeParts(transition.duration);
    return { transition, start: start - parts.out, boundary: start, end: start + parts.in };
  }
  return { transition, start, boundary: start, end: start };
}

function placePrimary(project: ProjectDocument, primary: VideoClip[]): { clips: PlacedClip[]; transitions: PlacedTransition[]; duration: number } {
  const clips: PlacedClip[] = [];
  const transitions: PlacedTransition[] = [];
  let cursor = 0;
  for (const [index, clip] of primary.entries()) {
    const incoming = index > 0 ? project.transitions[index - 1] : undefined;
    const outgoing = project.transitions[index];
    const opening = index === 0 ? project.openingFade : 0;
    const closing = index === primary.length - 1 ? project.closingFade : 0;
    if (incoming?.type === 'cross-dissolve') cursor -= incoming.duration;
    const retiming = compileLayerRetiming(clip, project.layers[0]!, cursor);
    const duration = retiming.duration;
    validateClipRegions(clip, duration, incoming, outgoing, opening, closing);
    const placed = { clip, start: cursor, end: cursor + duration, duration, retiming };
    clips.push(placed);
    if (incoming) transitions.push(placeTransition(incoming, cursor));
    cursor = placed.end;
  }
  return { clips, transitions, duration: cursor };
}

function placeOverlays(project: ProjectDocument): PlacedClip[] {
  const clips: PlacedClip[] = [];
  for (const layer of project.layers.slice(1)) {
    const placed = project.clips.filter((clip) => clip.layerId === layer.id).map((clip) => {
      const retiming = compileLayerRetiming(clip, layer, clip.start);
      return { clip, start: clip.start, end: clip.start + retiming.duration, duration: retiming.duration, retiming };
    }).sort((left, right) => left.start - right.start || left.clip.id.localeCompare(right.clip.id));
    for (const [index, clip] of placed.entries()) {
      if (index > 0 && clip.start < placed[index - 1]!.end) throw new Error('Clips on the same overlay layer cannot overlap; use another layer.');
    }
    clips.push(...placed);
  }
  return clips;
}

/** Single authoritative layout and incompatible-region validation, shared by preview/export. */
export function calculateLayout(project: ProjectDocument): TimelineLayout {
  validateTopology(project);
  const primary = primaryClips(project);
  if (primary.length === 0 && (project.openingFade || project.closingFade)) throw new Error('An empty timeline cannot have opening/closing fades.');
  const base = placePrimary(project, primary);
  const overlays = placeOverlays(project);
  return { clips: [...base.clips, ...overlays], transitions: base.transitions, duration: Math.max(base.duration, ...overlays.map((clip) => clip.end)), baseDuration: base.duration };
}

export function fadeInWeight(offset: number, duration: number): number {
  return duration === 1 ? 0 : Math.min(1, Math.max(0, offset / (duration - 1)));
}
export function fadeOutWeight(offset: number, duration: number): number {
  return duration === 1 ? 0 : 1 - fadeInWeight(offset, duration);
}

function clipWeight(placed: PlacedClip, frame: number, project: ProjectDocument, layout: TimelineLayout): number {
  const region = layout.transitions.find((item) => frame >= item.start && frame < item.end && (item.transition.leftId === placed.clip.id || item.transition.rightId === placed.clip.id));
  let weight = 1;
  if (region?.transition.type === 'cross-dissolve') {
    const progress = (frame - region.start) / region.transition.duration;
    weight = placed.clip.id === region.transition.leftId ? 1 - progress : progress;
  }
  if (region?.transition.type === 'fade-through-black') {
    const parts = blackFadeParts(region.transition.duration);
    weight = placed.clip.id === region.transition.leftId ? fadeOutWeight(frame - region.start, parts.out) : fadeInWeight(frame - region.boundary, parts.in);
  }
  const primary = layout.clips.filter((item) => item.clip.layerId === project.layers[0]!.id);
  if (placed === primary[0] && frame < project.openingFade) weight *= fadeInWeight(frame, project.openingFade);
  if (placed === primary.at(-1) && frame >= placed.end - project.closingFade) weight *= fadeOutWeight(frame - (placed.end - project.closingFade), project.closingFade);
  return weight;
}

export function sampleTimeline(project: ProjectDocument, frame: number, layout = calculateLayout(project)): PreviewLayer[] {
  if (!Number.isInteger(frame) || frame < 0 || frame >= layout.duration) return [];
  const active = layout.clips.filter((placed) => frame >= placed.start && frame < placed.end);
  const opacities = new Map(project.layers.map((layer) => [layer.id, layerOpacityAt(layer, frame)]));
  return active.flatMap((placed) => {
    const layer = project.layers.find((item) => item.id === placed.clip.layerId)!;
    if (!layer.enabled) return [];
    const sourceFrame = placed.retiming.sourceAt(frame - placed.start);
    const weight = clipWeight(placed, frame, project, layout);
    const dissolve = layout.transitions.some((region) => region.transition.type === 'cross-dissolve' && frame >= region.start && frame < region.end && (region.transition.leftId === placed.clip.id || region.transition.rightId === placed.clip.id));
    const blendWeight = dissolve ? weight : 1;
    return [{ clipId: placed.clip.id, mediaId: placed.clip.mediaId, layerId: layer.id, sourceFrame, colour: colourAt(placed.clip, layer, frame), weight, blendWeight, brightness: dissolve ? 1 : weight, opacity: opacityAt(placed.clip, layer, frame), layerOpacity: opacities.get(layer.id)! }];
  });
}