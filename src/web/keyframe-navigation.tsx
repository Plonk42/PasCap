import { createContext, useContext } from 'react';
import { isKeyframeFrame } from '../shared/keyframes.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';

/** Editor-only stored-point cursor; the preview/playhead always keeps its real frame. */
export interface KeyframeInspection {
  projectId: string;
  layerId: string;
  frame: number;
  frames: readonly number[];
  observedFrame: number;
  expectedFrame: number;
}

export function previewFrameFor(time: number, duration: number): number {
  return Math.max(0, Math.min(time, Math.max(0, duration - 1)));
}

export function keySeekHint(time: number, duration: number): string {
  if (duration === 0) return `Stored timeline frame ${time}; the timeline is empty, so there is no frame to preview.`;
  if (time >= duration) return `Stored timeline frame ${time}; preview the nearest available frame ${previewFrameFor(time, duration)}. The point stays in place.`;
  return `Go to timeline frame ${time}.`;
}

export function inspectKeyframe(projectId: string, layer: VideoLayer, frame: number, previewFrame: number, duration: number): KeyframeInspection | null {
  if (!isKeyframeFrame(frame) || !isKeyframeFrame(previewFrame) || !isKeyframeFrame(duration) || !layer.keyframes.some((point) => point.frame === frame)) return null;
  return {
    projectId, layerId: layer.id, frame, frames: layer.keyframes.map((point) => point.frame),
    observedFrame: previewFrame, expectedFrame: previewFrameFor(frame, duration),
  };
}

/** Retain a single moved point/its undo, but never a deleted or foreign-row cursor. */
export function reconcileKeyframeInspection(inspection: KeyframeInspection | null, project: ProjectDocument | null, layerId: string, previewFrame: number, duration: number, playing: boolean): KeyframeInspection | null {
  if (!inspection || !project) return null;
  if (inspection.projectId !== project.id || inspection.layerId !== layerId || playing || !isKeyframeFrame(previewFrame) || !isKeyframeFrame(duration)) return null;
  const layer = project.layers.find((item) => item.id === layerId);
  if (!layer || !isKeyframeFrame(inspection.frame)) return null;
  const frames = layer.keyframes.map((point) => point.frame);
  let frame = inspection.frame;
  if (!frames.includes(frame)) {
    const removed = inspection.frames.filter((previous) => !frames.includes(previous));
    const added = frames.filter((next) => !inspection.frames.includes(next));
    if (removed.length !== 1 || removed[0] !== frame || added.length !== 1 || !isKeyframeFrame(added[0]!)) return null;
    frame = added[0]!;
  }
  const expectedFrame = previewFrameFor(frame, duration);
  // A navigation seek is asynchronous. Old diagnostics and its clamped result
  // are both expected; a different external seek resumes following the playhead.
  if (previewFrame !== inspection.observedFrame && previewFrame !== inspection.expectedFrame && previewFrame !== expectedFrame) return null;
  const framesChanged = frames.length !== inspection.frames.length || frames.some((time, index) => time !== inspection.frames[index]);
  if (!framesChanged && frame === inspection.frame && previewFrame === inspection.observedFrame && expectedFrame === inspection.expectedFrame) return inspection;
  return { ...inspection, frame, frames, observedFrame: previewFrame, expectedFrame };
}

export function keyframeNavigationFrame(inspection: KeyframeInspection | null, layerId: string, previewFrame: number): number {
  return inspection?.layerId === layerId ? inspection.frame : previewFrame;
}

export interface KeyframeNavigation {
  inspection: KeyframeInspection | null;
  duration: number;
  disabled: boolean;
  onSeekKeyframe: (layerId: string, frame: number) => void;
  onFollowPlayhead: () => void;
}

export const KeyframeNavigationContext = createContext<KeyframeNavigation | null>(null);

/** Shared by the inspector, point list and Timeline's existing layer sidebar. */
export function useKeyframeNavigation(): KeyframeNavigation {
  const navigation = useContext(KeyframeNavigationContext);
  if (!navigation) throw new Error('Keyframe controls require the editor navigation context.');
  return navigation;
}
