import { COLOUR_CONTROLS, type ColourSettings } from '../shared/colour.js';
import { gradeColourAt, gradeKeyAsLayerKey, type Adjustment } from '../shared/grade.js';
import { activeLayerSetting, type LayerKeyframe } from '../shared/keyframes.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { gradePosition, type PlacedClip } from '../shared/timeline.js';
import { nearestOutput } from './clip-keyframe-markers.js';

/**
 * What the Colour controls edit: a clip's own grade (keyframes at source frames of its recording) or an adjustment
 * (keyframes counted from its start), in the track keyframe shape so the same controls edit either. Neither has Opacity.
 */
export interface ColourOwner {
  /** The clip's or the adjustment's ID. */
  id: string;
  name: string;
  colour: ColourSettings;
  keyframes: LayerKeyframe[];
  gradeClipId?: string;
  adjustmentId?: string;
}

export function clipColourOwner(clip: VideoClip, name: string): ColourOwner & { gradeClipId: string } {
  return {
    id: clip.id,
    name,
    colour: clip.grade.colour,
    keyframes: clip.grade.keyframes.map(gradeKeyAsLayerKey),
    gradeClipId: clip.id,
  };
}

export function adjustmentColourOwner(item: Adjustment, name: string): ColourOwner & { adjustmentId: string } {
  return {
    id: item.id,
    name,
    colour: item.colour,
    keyframes: item.keyframes.map(gradeKeyAsLayerKey),
    adjustmentId: item.id,
  };
}

/** A clip's grade as a Colour owner; null when the clip is gone. */
export function gradeOwnerOf(project: ProjectDocument, clipId: string): (ColourOwner & { gradeClipId: string }) | null {
  const clip = project.clips.find((item) => item.id === clipId);
  return clip ? clipColourOwner(clip, '') : null;
}

/** The source frame a placed clip shows at a project frame, or null off the clip. */
export function sourceFrameAt(placed: PlacedClip, projectFrame: number): number | null {
  return projectFrame >= placed.start && projectFrame < placed.end
    ? placed.retiming.sourceAt(projectFrame - placed.start)
    : null;
}

export function isClipOwner(owner: ColourOwner): owner is ColourOwner & { gradeClipId: string } {
  return owner.gradeClipId !== undefined;
}

/** The fields naming what a Colour or keyframe command edits. */
export function ownerTarget(owner: ColourOwner): { clipId: string } | { adjustmentId: string } {
  return owner.gradeClipId === undefined ? { adjustmentId: owner.id } : { clipId: owner.gradeClipId };
}

/** The fields naming what a whole-Colour command edits. */
export function colourTarget(owner: ColourOwner): { clipIds: [string] } | { adjustmentId: string } {
  return owner.gradeClipId === undefined ? { adjustmentId: owner.id } : { clipIds: [owner.gradeClipId] };
}

/** "clip" or "adjustment", for labels and help. */
export function ownerNoun(owner: ColourOwner): 'clip' | 'adjustment' {
  return isClipOwner(owner) ? 'clip' : 'adjustment';
}

/** The project frame showing a clip grade keyframe's source frame, or the nearest image the clip shows. */
export function gradeSeekFrame(placed: PlacedClip, sourceFrame: number): number {
  const { sourceIn, sourceOut } = placed.clip;
  return placed.start + nearestOutput(placed, Math.min(Math.max(sourceFrame, sourceIn), sourceOut - 1));
}

/** Where the image evaluates a clip grade at a project frame: between source frames in slow motion. */
export function gradeValuePosition(placed: PlacedClip, projectFrame: number): number {
  return gradePosition(placed, projectFrame - placed.start);
}

/**
 * The values the Colour controls show: a setting keyed at the playhead's source frame shows that keyframe, which is
 * what it edits; the others show the image's own value at `position`.
 */
export function displayedColour(owner: ColourOwner, frame: number, position: number): ColourSettings {
  const colour = gradeColourAt(owner, position);
  if (position === frame) return colour;
  const keyed = gradeColourAt(owner, frame);
  for (const { key } of COLOUR_CONTROLS) if (activeLayerSetting(owner, key, frame)) colour[key] = keyed[key];
  return colour;
}
