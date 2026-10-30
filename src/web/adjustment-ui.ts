import { applyCommand, type EditCommand } from '../shared/commands.js';
import { MAX_ADJUSTMENTS, type Adjustment } from '../shared/grade.js';
import type { ProjectDocument } from '../shared/model.js';
import type { TimelineRange } from '../shared/rush-editing.js';
import type { PlacedClip } from '../shared/timeline.js';
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

/** Moves adjustments by `delta` with their keyframes, the leading one first so none passes over another. */
export function adjustmentMoveCommands(
  project: ProjectDocument,
  adjustmentIds: readonly string[],
  delta: number,
): EditCommand[] {
  if (!delta) return [];
  return project.adjustments
    .filter((item) => adjustmentIds.includes(item.id))
    .sort((left, right) => (delta > 0 ? right.start - left.start : left.start - right.start))
    .map((item): EditCommand => ({
      type: 'adjustment-range',
      adjustmentId: item.id,
      start: item.start + delta,
      duration: item.duration,
      keyframes: 'move',
    }));
}

export interface GroupMovePlan {
  document: ProjectDocument;
  commands: EditCommand[];
  error: string;
}

/** Selected clips and adjustments move together by `delta`, clips staying on their tracks, in one transaction. */
export function planGroupMove(
  project: ProjectDocument,
  clipIds: readonly string[],
  adjustmentIds: readonly string[],
  delta: number,
): GroupMovePlan {
  const fail = (error: string): GroupMovePlan => ({ document: project, commands: [], error });
  if (project.adjustments.some((item) => adjustmentIds.includes(item.id) && item.start + delta < 0))
    return fail('An adjustment cannot start before the first frame.');
  const commands: EditCommand[] = [
    ...(clipIds.length && delta ? [{ type: 'move-clips' as const, clipIds: [...clipIds], delta, layerId: null }] : []),
    ...adjustmentMoveCommands(project, adjustmentIds, delta),
  ];
  try {
    const document = commands.reduce((next, command) => applyCommand(next, command), project);
    return { document, commands, error: '' };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'These clips and adjustments cannot move there.');
  }
}

export interface AdjustmentKeyframeTarget extends KeyframeSlideTarget {
  /** The adjustment as drawn when the gesture started; `origin` counts from its start. */
  item: Adjustment;
}

export interface AdjustmentCreation {
  range: Pick<Adjustment, 'start' | 'duration'>;
  document: ProjectDocument;
  command: Extract<EditCommand, { type: 'adjustment-add' }> | null;
  error: string;
}

/** A new neutral adjustment over frames [start, end); overlaps and the 64-adjustment limit are refused. */
export function planAdjustmentCreation(
  project: ProjectDocument,
  adjustmentId: string,
  start: number,
  end: number,
): AdjustmentCreation {
  const range = { start: Math.min(start, end), duration: Math.abs(end - start) };
  const fail = (error: string): AdjustmentCreation => ({ range, document: project, command: null, error });
  if (range.duration < 1) return fail('An adjustment lasts at least one frame.');
  if (range.start < 0) return fail('An adjustment cannot start before the first frame.');
  const command = { type: 'adjustment-add' as const, adjustmentId, ...range };
  try {
    return { range, document: applyCommand(project, command), command, error: '' };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'An adjustment cannot go there.');
  }
}

/** What **Add adjustment** covers: the ruler range, else the selected clip's span. */
export function adjustmentSpan(
  range: TimelineRange | null,
  clip: PlacedClip | undefined,
): { start: number; end: number } | null {
  if (range) return { start: range.inFrame, end: range.outFrame };
  return clip ? { start: clip.start, end: clip.end } : null;
}

/** Why an adjustment cannot be added over `span`, or null. */
export function addAdjustmentReason(
  project: ProjectDocument,
  span: { start: number; end: number } | null,
): string | null {
  if (project.adjustments.length >= MAX_ADJUSTMENTS)
    return `A project has at most ${MAX_ADJUSTMENTS} adjustments. Remove one first.`;
  if (!span) return 'Select a range on the time ruler or a clip first, or draw one in the adjustment track.';
  return planAdjustmentCreation(project, 'candidate', span.start, span.end).error || null;
}

/** An adjustment can be split at frames after its first one. */
export function splitAdjustmentReason(item: Adjustment, frame: number): string | null {
  return frame > item.start && frame < item.start + item.duration
    ? null
    : 'Place the playhead inside the selected adjustment, after its first frame, to split it.';
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
    snapRange: ({ item }) => ({ min: item.start, max: item.start + item.duration - 1 }),
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

/** The keyframes drawn inside an adjustment; they always lie within its range. */
export function adjustmentKeyframeTargets(item: Adjustment): AdjustmentKeyframeTarget[] {
  return item.keyframes.map((key) => ({ scope: item.id, origin: key.frame, item }));
}
