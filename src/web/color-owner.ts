import { COLOR_CONTROLS, type ColorSettings } from '../shared/color.js';
import { gradeColorAt, gradeKeyAsLayerKey, type Adjustment } from '../shared/grade.js';
import { activeLayerSetting, type LayerKeyframe } from '../shared/keyframes.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { gradePosition, type PlacedClip } from '../shared/timeline.js';
import { nearestOutput } from './clip-keyframe-markers.js';

/**
 * What the Color controls edit: a clip's own grade (keyframes at source frames of its recording) or an adjustment
 * (keyframes counted from its start), in the track keyframe shape so the same controls edit either. Neither has Opacity.
 */
export interface ColorOwner {
  /** The clip's or the adjustment's ID. */
  id: string;
  name: string;
  color: ColorSettings;
  keyframes: LayerKeyframe[];
  gradeClipId?: string;
  adjustmentId?: string;
}

export function clipColorOwner(clip: VideoClip, name: string): ColorOwner & { gradeClipId: string } {
  return {
    id: clip.id,
    name,
    color: clip.grade.color,
    keyframes: clip.grade.keyframes.map(gradeKeyAsLayerKey),
    gradeClipId: clip.id,
  };
}

export function adjustmentColorOwner(item: Adjustment, name: string): ColorOwner & { adjustmentId: string } {
  return {
    id: item.id,
    name,
    color: item.color,
    keyframes: item.keyframes.map(gradeKeyAsLayerKey),
    adjustmentId: item.id,
  };
}

/** A clip's grade as a Color owner; null when the clip is gone. */
export function gradeOwnerOf(project: ProjectDocument, clipId: string): (ColorOwner & { gradeClipId: string }) | null {
  const clip = project.clips.find((item) => item.id === clipId);
  return clip ? clipColorOwner(clip, '') : null;
}

/** The source frame a placed clip shows at a project frame, or null off the clip. */
export function sourceFrameAt(placed: PlacedClip, projectFrame: number): number | null {
  return projectFrame >= placed.start && projectFrame < placed.end
    ? placed.retiming.sourceAt(projectFrame - placed.start)
    : null;
}

export function isClipOwner(owner: ColorOwner): owner is ColorOwner & { gradeClipId: string } {
  return owner.gradeClipId !== undefined;
}

/** The fields naming what a Color or keyframe command edits. */
export function ownerTarget(owner: ColorOwner): { clipId: string } | { adjustmentId: string } {
  return owner.gradeClipId === undefined ? { adjustmentId: owner.id } : { clipId: owner.gradeClipId };
}

/** The fields naming what a whole-Color command edits. */
export function colorTarget(owner: ColorOwner): { clipIds: [string] } | { adjustmentId: string } {
  return owner.gradeClipId === undefined ? { adjustmentId: owner.id } : { clipIds: [owner.gradeClipId] };
}

/** "clip" or "adjustment", for labels and help. */
export function ownerNoun(owner: ColorOwner): 'clip' | 'adjustment' {
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
 * The values the Color controls show: a setting keyed at the playhead's source frame shows that keyframe, which is
 * what it edits; the others show the image's own value at `position`.
 */
export function displayedColor(owner: ColorOwner, frame: number, position: number): ColorSettings {
  const color = gradeColorAt(owner, position);
  if (position === frame) return color;
  const keyed = gradeColorAt(owner, frame);
  for (const { key } of COLOR_CONTROLS) if (activeLayerSetting(owner, key, frame)) color[key] = keyed[key];
  return color;
}
