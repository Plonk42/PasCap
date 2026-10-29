import { COLOUR_CONTROLS, type ColourSettings } from '../shared/colour.js';
import { colourAt } from '../shared/composition.js';
import { gradeKeyAsLayerKey } from '../shared/grade.js';
import { activeLayerSetting } from '../shared/keyframes.js';
import type { VideoClip, VideoLayer } from '../shared/model.js';
import { gradePosition, type PlacedClip } from '../shared/timeline.js';
import { nearestOutput } from './clip-keyframe-markers.js';

/**
 * What the Colour controls edit: a track, or a clip's own grade shown in the track's shape so the same controls
 * edit either. A clip grade has no Opacity, and its keyframes and frames are source frames of the recording.
 */
export type ColourOwner = VideoLayer & { gradeClipId?: string };

export function clipColourOwner(layer: VideoLayer, clip: VideoClip, name: string): ColourOwner {
  return {
    ...layer,
    id: clip.id,
    name,
    opacity: 1,
    colour: clip.grade.colour,
    keyframes: clip.grade.keyframes.map(gradeKeyAsLayerKey),
    gradeClipId: clip.id,
  };
}

export function isClipOwner(owner: VideoLayer): owner is ColourOwner & { gradeClipId: string } {
  return (owner as ColourOwner).gradeClipId !== undefined;
}

/** The fields naming what a Colour or keyframe command edits. */
export function ownerTarget(owner: VideoLayer): { layerId: string } | { clipId: string } {
  const clipId = (owner as ColourOwner).gradeClipId;
  return clipId === undefined ? { layerId: owner.id } : { clipId };
}

/** The fields naming what a whole-Colour command edits. */
export function colourTarget(owner: VideoLayer): { layerId: string } | { clipIds: [string] } {
  const clipId = (owner as ColourOwner).gradeClipId;
  return clipId === undefined ? { layerId: owner.id } : { clipIds: [clipId] };
}

/** "track" or "clip", for labels and help. */
export function ownerNoun(owner: VideoLayer): 'track' | 'clip' {
  return isClipOwner(owner) ? 'clip' : 'track';
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
export function displayedColour(owner: VideoLayer, frame: number, position: number): ColourSettings {
  const colour = colourAt(owner, position);
  if (position === frame) return colour;
  const keyed = colourAt(owner, frame);
  for (const { key } of COLOUR_CONTROLS) if (activeLayerSetting(owner, key, frame)) colour[key] = keyed[key];
  return colour;
}
