import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { previewClipSource } from './clip-speed-geometry.js';

/** Clip-local stored source time, never a replacement for the actual playhead. */
export interface SpatialInspection {
  context: string;
  frame: number;
  frames: readonly number[];
  observedFrame: number;
  expectedFrame: number;
}

/** Which clip-owned keyframes a section navigates. */
export type ClipKeyFrames = (clip: VideoClip) => readonly number[];
const transformFrames: ClipKeyFrames = (clip) => clip.spatial.keyframes.map((key) => key.frame);
export const speedFrames: ClipKeyFrames = (clip) =>
  clip.speed.mode === 'curve' ? clip.speed.keyframes.map((key) => key.frame) : [];

function spatialFrames(project: ProjectDocument, clip: VideoClip | null, framesOf: ClipKeyFrames): number[] {
  if (!clip || !project.clips.some((item) => item.id === clip.id && item.layerId === clip.layerId)) return [];
  return [...framesOf(clip)];
}

/** Selection alone does not seek; callers can publish expectedFrame through the source-only route. */
export function inspectSpatialKeyframe(
  context: string,
  project: ProjectDocument,
  clip: VideoClip | null,
  frame: number,
  observedFrame: number,
  framesOf: ClipKeyFrames = transformFrames,
): SpatialInspection | null {
  const frames = spatialFrames(project, clip, framesOf);
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

/** Follow one moved source key/Undo, but clear on deletion, playback or track inspection (`interrupted`) or a foreign context. */
export function reconcileSpatialInspection(
  inspection: SpatialInspection | null,
  context: string,
  project: ProjectDocument,
  clip: VideoClip | null,
  observedFrame: number,
  interrupted: boolean,
  framesOf: ClipKeyFrames = transformFrames,
): SpatialInspection | null {
  if (inspection?.context !== context || interrupted) return null;
  const frames = spatialFrames(project, clip, framesOf);
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
