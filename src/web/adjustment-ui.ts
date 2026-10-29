import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { Adjustment } from '../shared/grade.js';
import type { ProjectDocument } from '../shared/model.js';
import { formatTimecode } from '../shared/timing.js';
import type { KeyframeMove, KeyframeSlideKind, KeyframeSlideTarget } from './keyframe-slide.js';

/** "01:12:05 – 01:20:00": an adjustment by its range, OUT exclusive. */
export function adjustmentLabel(item: Pick<Adjustment, 'start' | 'duration'>): string {
  return `${formatTimecode(item.start)} – ${formatTimecode(item.start + item.duration)}`;
}

/** Dragging the body moves an adjustment with its keyframes; its handles trim it, keyframes keeping their frames. */
export type AdjustmentGestureKind = 'move' | 'in' | 'out';

export interface AdjustmentPlan {
  /** The range drawn for the gesture, valid or not. */
  range: Pick<Adjustment, 'start' | 'duration'>;
  document: ProjectDocument;
  command: Extract<EditCommand, { type: 'adjustment-range' }> | null;
  error: string;
}

function rangeAfter(item: Adjustment, kind: AdjustmentGestureKind, delta: number) {
  if (kind === 'move') return { start: item.start + delta, duration: item.duration };
  if (kind === 'in') return { start: item.start + delta, duration: item.duration - delta };
  return { start: item.start, duration: item.duration + delta };
}

/** Overlaps, a start before frame 0 and empty ranges are refused, never clamped. */
export function planAdjustmentGesture(
  project: ProjectDocument,
  adjustmentId: string,
  kind: AdjustmentGestureKind,
  delta: number,
): AdjustmentPlan {
  const item = project.adjustments.find((candidate) => candidate.id === adjustmentId);
  if (!item)
    return {
      range: { start: 0, duration: 1 },
      document: project,
      command: null,
      error: 'This adjustment no longer exists.',
    };
  const range = rangeAfter(item, kind, delta);
  const fail = (error: string): AdjustmentPlan => ({ range, document: project, command: null, error });
  if (range.start === item.start && range.duration === item.duration)
    return { range, document: project, command: null, error: '' };
  if (range.duration < 1) return fail('An adjustment lasts at least one frame.');
  if (range.start < 0) return fail('An adjustment cannot start before the first frame.');
  const command: AdjustmentPlan['command'] = {
    type: 'adjustment-range',
    adjustmentId,
    ...range,
    keyframes: kind === 'move' ? 'move' : 'stay',
  };
  try {
    return { range, document: applyCommand(project, command!), command, error: '' };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'This adjustment cannot go there.');
  }
}

export interface AdjustmentKeyframeTarget extends KeyframeSlideTarget {
  /** The adjustment as drawn when the gesture started; `origin` counts from its start. */
  item: Adjustment;
}

/** Moves a keyframe to another frame of its adjustment; its markers stay within the adjustment's range. */
export function planAdjustmentKeyframeMove(
  project: ProjectDocument,
  adjustmentId: string,
  origin: number,
  nextFrame: number,
): KeyframeMove {
  const fail = (error: string): KeyframeMove => ({ frame: nextFrame, document: project, command: null, error });
  const item = project.adjustments.find((candidate) => candidate.id === adjustmentId);
  if (!item) return fail('This adjustment no longer exists.');
  if (nextFrame < 0 || nextFrame >= item.duration) return fail('Keep the keyframe within its adjustment.');
  const command: EditCommand = { type: 'layer-key-move', adjustmentId, frame: origin, nextFrame };
  try {
    return {
      frame: nextFrame,
      document: applyCommand(project, command),
      command: nextFrame === origin ? null : command,
      error: '',
    };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'Cannot move this adjustment keyframe.');
  }
}

/** Adjustment keyframes are stored from the adjustment's start and drawn at their project frames. */
export function adjustmentKeyframeKind(options: {
  onSelect: (adjustmentId: string) => void;
  onSeek: (frame: number) => void;
  onOpen: () => void;
}): KeyframeSlideKind<AdjustmentKeyframeTarget> {
  const seekFrame = (document: ProjectDocument, adjustmentId: string, frame: number): number | null => {
    const item = document.adjustments.find((candidate) => candidate.id === adjustmentId);
    return item ? item.start + Math.max(0, Math.min(item.duration - 1, frame)) : null;
  };
  return {
    at: ({ item, origin }, travel) => item.start + Math.max(0, Math.min(item.duration - 1, origin + travel)),
    planAt: (project, { scope, origin, item }, at) =>
      planAdjustmentKeyframeMove(project, scope, origin, at - item.start),
    step: (project, { scope, origin }, delta) => planAdjustmentKeyframeMove(project, scope, origin, origin + delta),
    seekFrame: (document, { scope }, frame) => seekFrame(document, scope, frame),
    select: ({ scope }) => options.onSelect(scope),
    reveal: (document, { scope }, frame, open) => {
      const seek = seekFrame(document, scope, frame);
      if (seek !== null) options.onSeek(seek);
      if (open) options.onOpen();
    },
    selector: ({ scope }, frame) => `[data-adjustment-id="${CSS.escape(scope)}"] [data-adjustment-keyframe="${frame}"]`,
    remove: (_project, { scope, origin }) => ({ type: 'layer-key-remove', adjustmentId: scope, frame: origin }),
  };
}

/** The keyframes drawn inside an adjustment: those within its range. */
export function adjustmentKeyframeTargets(item: Adjustment): AdjustmentKeyframeTarget[] {
  return item.keyframes
    .filter((key) => key.frame >= 0 && key.frame < item.duration)
    .map((key) => ({ scope: item.id, origin: key.frame, item }));
}
