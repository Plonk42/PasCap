import { updateClipSpeedKey } from '../shared/clip-speed.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { calculateLayout, type PlacedClip } from '../shared/timeline.js';
import { clipMarkersOf, type ClipKeyframeMarker } from './clip-keyframe-markers.js';
import type { KeyframeSlideKind, KeyframeSlideTarget } from './keyframe-slide.js';

type ClipKeyCommand = Extract<EditCommand, { type: 'speed' | 'layer-key-move' }>;
export type ClipKeyframeType = ClipKeyframeMarker['type'];
export interface ClipKeyframeDragPlan {
  frame: number;
  document: ProjectDocument;
  command: ClipKeyCommand | null;
  error: string;
}

const LABELS: Record<ClipKeyframeType, string> = { speed: 'Speed', grade: 'clip grade' };

function moveCommand(clip: VideoClip, origin: number, frame: number, type: ClipKeyframeType): ClipKeyCommand {
  if (type === 'grade') return { type: 'layer-key-move', clipId: clip.id, frame: origin, nextFrame: frame };
  if (clip.speed.mode !== 'curve') throw new Error('This clip has no speed keyframes.');
  return { type: 'speed', clipId: clip.id, speed: updateClipSpeedKey(clip.speed, origin, { frame }) };
}

/** Moves one clip speed key to another original source frame, keeping its rate and easing. */
/** The source frames of a clip's keyframes of one type. */
function keyFrames(clip: VideoClip, type: ClipKeyframeType): number[] {
  if (type === 'grade') return clip.grade.keyframes.map((key) => key.frame);
  return clip.speed.mode === 'curve' ? clip.speed.keyframes.map((key) => key.frame) : [];
}

export function planClipKeyframeMove(
  project: ProjectDocument,
  clipId: string,
  origin: number,
  nextFrame: number,
  frameCount: number,
  type: ClipKeyframeType = 'speed',
): ClipKeyframeDragPlan {
  const fail = (error: string): ClipKeyframeDragPlan => ({ frame: nextFrame, document: project, command: null, error });
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return fail('This clip no longer exists.');
  // A speed key may sit on the exclusive OUT; a grade key belongs to a recorded frame.
  const last = type === 'grade' ? frameCount - 1 : frameCount;
  if (nextFrame < 0 || nextFrame > last)
    return fail(`A ${LABELS[type]} keyframe must stay within source frames 0–${last}.`);
  if (nextFrame !== origin && keyFrames(clip, type).includes(nextFrame))
    return fail(`A clip ${type} keyframe already exists at this source frame. Choose another frame.`);
  try {
    const command = moveCommand(clip, origin, nextFrame, type);
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
  return clipMarkersOf(placed, type).find((m) => m.sourceFrame === sourceFrame)?.seekFrame ?? null;
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
      // A snap to a forward clip's end lands on its exclusive OUT boundary; a reversed
      // clip's start is its first frame, so travel maps through the retiming there too.
      const boundary = type === 'speed' && !placed.clip.reverse && at >= placed.end;
      const frame = boundary ? placed.clip.sourceOut : clipKeyframeTarget(placed, marker, at - marker.timelineFrame);
      return move(project, target, frame);
    },
    // Arrow keys move the marker along the timeline: a reversed clip shows lower source frames to the right.
    step: (project, target, delta) =>
      move(project, target, target.origin + (target.placed.clip.reverse ? -delta : delta)),
    seekFrame: (document, target, frame) => seekFrameFor(document, target.scope, type, frame),
    select: ({ scope }) => options.onSelect(scope),
    reveal: (document, target, frame, open) => {
      const seek = seekFrameFor(document, target.scope, type, frame);
      if (seek !== null) options.onSeek(seek);
      if (open) options.onOpen();
    },
    ...(type === 'grade'
      ? {
          remove: (_project: ProjectDocument, { scope, origin }: ClipKeyframeTarget) => ({
            type: 'layer-key-remove' as const,
            clipId: scope,
            frame: origin,
          }),
        }
      : {}),
    selector: ({ scope }, frame) =>
      `[data-clip-id="${CSS.escape(scope)}"] [data-clip-keyframe="${type}"][data-source-frame="${frame}"]`,
  };
}
