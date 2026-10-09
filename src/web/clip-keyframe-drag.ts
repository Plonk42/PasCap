import { updateClipSpeedKey } from '../shared/clip-speed.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { calculateLayout, type PlacedClip } from '../shared/timeline.js';
import { clipKeyframeMarkers, type ClipKeyframeMarker } from './clip-keyframe-markers.js';
import type { KeyframeSlideKind, KeyframeSlideTarget } from './keyframe-slide.js';
import { replaceSpatialKey } from './spatial-editor.js';

type ClipKeyCommand = Extract<EditCommand, { type: 'spatial' | 'speed' }>;
export type ClipKeyframeType = ClipKeyframeMarker['type'];
export interface ClipKeyframeDragPlan {
  frame: number;
  document: ProjectDocument;
  command: ClipKeyCommand | null;
  error: string;
}

const LABELS: Record<ClipKeyframeType, string> = { transform: 'Transform', speed: 'Speed' };

function moveCommand(clip: VideoClip, type: ClipKeyframeType, origin: number, frame: number): ClipKeyCommand {
  if (type === 'transform')
    return { type: 'spatial', clipId: clip.id, spatial: replaceSpatialKey(clip.spatial, origin, { frame }) };
  if (clip.speed.mode !== 'curve') throw new Error('This clip has no speed keyframes.');
  return { type: 'speed', clipId: clip.id, speed: updateClipSpeedKey(clip.speed, origin, { frame }) };
}

/** Moves one clip key to another original source frame, keeping its value(s) and easing. */
export function planClipKeyframeMove(
  project: ProjectDocument,
  clipId: string,
  origin: number,
  nextFrame: number,
  frameCount: number,
  type: ClipKeyframeType = 'transform',
): ClipKeyframeDragPlan {
  const fail = (error: string): ClipKeyframeDragPlan => ({ frame: nextFrame, document: project, command: null, error });
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return fail('This clip no longer exists.');
  if (nextFrame < 0 || nextFrame > frameCount)
    return fail(`A ${LABELS[type]} keyframe must stay within source frames 0–${frameCount}.`);
  if (
    type === 'speed' &&
    nextFrame !== origin &&
    clip.speed.mode === 'curve' &&
    clip.speed.keyframes.some((key) => key.frame === nextFrame)
  )
    return fail('A clip speed keyframe already exists at this source frame. Choose another frame.');
  try {
    const command = moveCommand(clip, type, origin, nextFrame);
    return {
      frame: nextFrame,
      document: applyCommand(project, command),
      command: nextFrame === origin ? null : command,
      error: '',
    };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : `Cannot move this ${LABELS[type]} keyframe.`);
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

function seekFrameFor(
  document: ProjectDocument,
  clipId: string,
  type: ClipKeyframeType,
  sourceFrame: number,
): number | null {
  const placed = calculateLayout(document).clips.find((item) => item.clip.id === clipId);
  if (!placed) return null;
  return clipKeyframeMarkers(placed).find((m) => m.type === type && m.sourceFrame === sourceFrame)?.seekFrame ?? null;
}

export interface ClipKeyframeTarget extends KeyframeSlideTarget {
  placed: PlacedClip;
  marker: ClipKeyframeMarker;
}

export function clipKeyframeSlideTarget(placed: PlacedClip, marker: ClipKeyframeMarker): ClipKeyframeTarget {
  return { scope: placed.clip.id, origin: marker.sourceFrame, placed, marker };
}

/** Clip keys move in original source frames, following pointer travel through the placed retiming. */
export function clipKeyframeKind(
  type: ClipKeyframeType,
  options: {
    frameCountOf: (mediaId: string) => number;
    onSelect: (clipId: string) => void;
    onSeek: (frame: number) => void;
    onOpen: () => void;
  },
): KeyframeSlideKind<ClipKeyframeTarget> {
  const move = (project: ProjectDocument, target: ClipKeyframeTarget, frame: number): ClipKeyframeDragPlan =>
    planClipKeyframeMove(
      project,
      target.scope,
      target.origin,
      frame,
      options.frameCountOf(target.placed.clip.mediaId),
      type,
    );
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
    seekFrame: (document, target, frame) => seekFrameFor(document, target.scope, type, frame),
    select: ({ scope }) => options.onSelect(scope),
    reveal: (document, target, frame, open) => {
      const seek = seekFrameFor(document, target.scope, type, frame);
      if (seek !== null) options.onSeek(seek);
      if (open) options.onOpen();
    },
    selector: ({ scope }, frame) =>
      `[data-clip-id="${CSS.escape(scope)}"] [data-clip-keyframe="${type}"][data-source-frame="${frame}"]`,
  };
}
