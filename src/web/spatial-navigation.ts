import type { ProjectDocument, VideoClip, VideoLayer } from '../shared/model.js';
import { previewClipSource } from './clip-speed-geometry.js';
import { previewFrameFor } from './keyframe-navigation.js';

/** Section-local stored keyframe time, never a replacement for the actual playhead. */
export interface SpatialInspection {
  context: string;
  frame: number;
  frames: readonly number[];
  observedFrame: number;
  expectedFrame: number;
}

/** The stored keyframe times a section navigates and the timeline frame each previews. */
export interface StoredKeyframes {
  frames: readonly number[];
  expectedFrame: (frame: number) => number;
}

/** Clip speed keyframes, in original source frames, previewing their nearest mapped image. */
export function clipSpeedKeyframes(project: ProjectDocument, clip: VideoClip | null): StoredKeyframes {
  const current = project.clips.find((item) => item.id === clip?.id && item.layerId === clip.layerId);
  if (current?.speed.mode !== 'curve') return { frames: [], expectedFrame: () => 0 };
  return {
    frames: current.speed.keyframes.map((key) => key.frame),
    expectedFrame: (frame) => previewClipSource(project, current.id, frame),
  };
}

/** Track Transform keyframes, in timeline frames, previewing the nearest available frame. */
export function trackTransformKeyframes(layer: VideoLayer, duration: number): StoredKeyframes {
  return {
    frames: layer.transform.keyframes.map((key) => key.frame),
    expectedFrame: (frame) => previewFrameFor(frame, duration),
  };
}

/** Selection alone does not seek; callers can publish expectedFrame through the source-only route. */
export function inspectSpatialKeyframe(
  context: string,
  keys: StoredKeyframes,
  frame: number,
  observedFrame: number,
): SpatialInspection | null {
  if (!keys.frames.includes(frame)) return null;
  return { context, frame, frames: [...keys.frames], observedFrame, expectedFrame: keys.expectedFrame(frame) };
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

/** Follow one moved key/Undo, but clear on deletion, playback or track inspection (`interrupted`) or a foreign context. */
export function reconcileSpatialInspection(
  inspection: SpatialInspection | null,
  context: string,
  keys: StoredKeyframes,
  observedFrame: number,
  interrupted: boolean,
): SpatialInspection | null {
  if (inspection?.context !== context || interrupted) return null;
  const frame = retainedSpatialFrame(inspection, keys.frames);
  if (frame === null) return null;
  const expectedFrame = keys.expectedFrame(frame);
  if (!acceptsObservation(inspection, observedFrame, expectedFrame)) return null;
  if (
    frame === inspection.frame &&
    observedFrame === inspection.observedFrame &&
    expectedFrame === inspection.expectedFrame &&
    sameFrames(keys.frames, inspection.frames)
  )
    return inspection;
  return { ...inspection, frame, frames: [...keys.frames], observedFrame, expectedFrame };
}
