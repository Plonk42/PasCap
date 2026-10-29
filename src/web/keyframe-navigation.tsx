import { createContext, useContext } from 'react';

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

/** `noun` names what `time` counts: timeline frames, or source frames of a clip, or frames of an adjustment. */
export function keySeekHint(time: number, duration: number, noun = 'timeline frame'): string {
  if (duration === 0) return `Stored ${noun} ${time}; the timeline is empty, so there is no frame to preview.`;
  if (time >= duration)
    return `Stored ${noun} ${time}; preview the nearest available frame ${previewFrameFor(time, duration)}. The keyframe stays in place.`;
  return `Go to ${noun} ${time}.`;
}

export function keyframeNavigationFrame(
  inspection: KeyframeInspection | null,
  layerId: string,
  previewFrame: number,
): number {
  return inspection?.layerId === layerId ? inspection.frame : previewFrame;
}

export interface KeyframeNavigation {
  inspection: KeyframeInspection | null;
  duration: number;
  /** What keyframe frames count, for hints: "timeline frame" unless a grade's navigation says otherwise. */
  frameNoun?: string;
  disabled: boolean;
  playing?: boolean;
  sourceEpoch?: number;
  onSeekSourceKeyframe?: (frame: number) => void;
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
