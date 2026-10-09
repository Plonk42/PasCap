import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { previewClipSource } from './clip-speed-geometry.js';
import type { KeyframeInspection } from './keyframe-navigation.js';

/** Clip-local stored source time, never a replacement for the actual playhead. */
export interface SpatialInspection {
  context: string;
  frame: number;
  frames: readonly number[];
  observedFrame: number;
  expectedFrame: number;
}

function spatialFrames(project: ProjectDocument, clip: VideoClip | null): number[] {
  if (!clip || !project.clips.some((item) => item.id === clip.id && item.layerId === clip.layerId)) return [];
  return clip.spatial.keyframes.map((key) => key.frame);
}

/** Selection alone does not seek; callers can publish expectedFrame through the source-only route. */
export function inspectSpatialKeyframe(
  context: string,
  project: ProjectDocument,
  clip: VideoClip | null,
  frame: number,
  observedFrame: number,
): SpatialInspection | null {
  const frames = spatialFrames(project, clip);
  if (!clip || !frames.includes(frame)) return null;
  return {
    context,
    frame,
    frames,
    observedFrame,
    expectedFrame: previewClipSource(project, clip.id, frame),
  };
}

function retainedSpatialFrame(inspection: SpatialInspection, frames: readonly number[]): number | null {
  const current = new Set(frames);
  if (current.has(inspection.frame)) return inspection.frame;
  const previous = new Set(inspection.frames);
  const removed = inspection.frames.filter((frame) => !current.has(frame));
  const added = frames.filter((frame) => !previous.has(frame));
  return removed.length === 1 && removed[0] === inspection.frame && added.length === 1 ? added[0]! : null;
}

function sameFrames(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((frame, index) => frame === right[index]);
}

/** Retain old observations until an asynchronous seek arrives; never adopt a distinct external frame. */
function acceptsObservation(inspection: SpatialInspection, observedFrame: number, expectedFrame: number): boolean {
  return (
    observedFrame === inspection.observedFrame ||
    observedFrame === inspection.expectedFrame ||
    observedFrame === expectedFrame
  );
}

/** Follow one moved source key/Undo, but clear on deletion, playback, track inspection or a foreign context. */
export function reconcileSpatialInspection(
  inspection: SpatialInspection | null,
  context: string,
  project: ProjectDocument,
  clip: VideoClip | null,
  observedFrame: number,
  playing: boolean,
  centralInspection: KeyframeInspection | null,
): SpatialInspection | null {
  if (inspection?.context !== context || playing || centralInspection) return null;
  const frames = spatialFrames(project, clip);
  const frame = retainedSpatialFrame(inspection, frames);
  if (frame === null || !clip) return null;
  const expectedFrame = previewClipSource(project, clip.id, frame);
  if (!acceptsObservation(inspection, observedFrame, expectedFrame)) return null;
  if (
    frame === inspection.frame &&
    observedFrame === inspection.observedFrame &&
    expectedFrame === inspection.expectedFrame &&
    sameFrames(frames, inspection.frames)
  )
    return inspection;
  return { ...inspection, frame, frames, observedFrame, expectedFrame };
}
