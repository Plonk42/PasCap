import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { calculateLayout, type PlacedClip } from '../shared/timeline.js';
import { clipKeyframeMarkers, type ClipKeyframeMarker } from './clip-keyframe-markers.js';
import type { KeyframeSlideKind, KeyframeSlideTarget } from './keyframe-slide.js';
import { replaceSpatialKey } from './spatial-editor.js';

type SpatialCommand = Extract<EditCommand, { type: 'spatial' }>;
export interface ClipKeyframeDragPlan {
  frame: number;
  document: ProjectDocument;
  command: SpatialCommand | null;
  error: string;
}

/** Moves one Transform key to another original source frame, keeping its easing and enabled settings. */
export function planClipKeyframeMove(
  project: ProjectDocument,
  clipId: string,
  origin: number,
  nextFrame: number,
  frameCount: number,
): ClipKeyframeDragPlan {
  const fail = (error: string): ClipKeyframeDragPlan => ({ frame: nextFrame, document: project, command: null, error });
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return fail('This clip no longer exists.');
  if (nextFrame < 0 || nextFrame > frameCount)
    return fail(`A Transform keyframe must stay within source frames 0–${frameCount}.`);
  try {
    const command: SpatialCommand = {
      type: 'spatial',
      clipId,
      spatial: replaceSpatialKey(clip.spatial, origin, { frame: nextFrame }),
    };
    return {
      frame: nextFrame,
      document: applyCommand(project, command),
      command: nextFrame === origin ? null : command,
      error: '',
    };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'Cannot move this Transform keyframe.');
  }
}

/** Pointer travel is in output frames; zero travel keeps the stored frame, whatever frames speed skips. */
export function clipKeyframeTarget(
  placed: PlacedClip,
  marker: Pick<ClipKeyframeMarker, 'sourceFrame' | 'outputFrame'>,
  delta: number,
): number {
  if (delta === 0) return marker.sourceFrame;
  return placed.retiming.sourceAt(Math.max(0, Math.min(placed.duration - 1, marker.outputFrame + delta)));
}

function seekFrameFor(document: ProjectDocument, clipId: string, sourceFrame: number): number | null {
  const placed = calculateLayout(document).clips.find((item) => item.clip.id === clipId);
  const layer = document.layers.find((item) => item.id === placed?.clip.layerId);
  if (!placed || !layer) return null;
  return (
    clipKeyframeMarkers(placed, layer).find((m) => m.type === 'transform' && m.sourceFrame === sourceFrame)
      ?.seekFrame ?? null
  );
}

export interface TransformKeyframeTarget extends KeyframeSlideTarget {
  placed: PlacedClip;
  marker: ClipKeyframeMarker;
}

export function transformKeyframeTarget(placed: PlacedClip, marker: ClipKeyframeMarker): TransformKeyframeTarget {
  return { scope: placed.clip.id, origin: marker.sourceFrame, placed, marker };
}

/** Clip Transform keys move in original source frames, following pointer travel through the placed retiming. */
export function transformKeyframeKind(options: {
  frameCountOf: (mediaId: string) => number;
  onSelect: (clipId: string) => void;
  onSeek: (frame: number) => void;
  onOpenTransform: () => void;
}): KeyframeSlideKind<TransformKeyframeTarget> {
  const move = (project: ProjectDocument, target: TransformKeyframeTarget, frame: number): ClipKeyframeDragPlan =>
    planClipKeyframeMove(project, target.scope, target.origin, frame, options.frameCountOf(target.placed.clip.mediaId));
  return {
    at: ({ placed, marker }, travel) =>
      travel === 0
        ? marker.timelineFrame
        : placed.start + Math.max(0, Math.min(placed.duration - 1, marker.outputFrame + travel)),
    planAt: (project, target, at) => {
      const { placed, marker } = target;
      // A snap to the clip's end lands on its exclusive OUT boundary.
      const frame =
        at >= placed.end ? placed.clip.sourceOut : clipKeyframeTarget(placed, marker, at - marker.timelineFrame);
      return move(project, target, frame);
    },
    step: (project, target, delta) => move(project, target, target.origin + delta),
    seekFrame: (document, target, frame) => seekFrameFor(document, target.scope, frame),
    select: ({ scope }) => options.onSelect(scope),
    reveal: (document, target, frame, open) => {
      const seek = seekFrameFor(document, target.scope, frame);
      if (seek !== null) options.onSeek(seek);
      if (open) options.onOpenTransform();
    },
    selector: ({ scope }, frame) =>
      `[data-clip-id="${CSS.escape(scope)}"] [data-clip-keyframe="transform"][data-source-frame="${frame}"]`,
  };
}
