import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { createAdjustment, MAX_ADJUSTMENTS, type Adjustment } from '../../src/shared/grade.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { snapPoints } from '../../src/shared/snap.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  addAdjustmentReason,
  adjustmentKeyframeKind,
  adjustmentKeyframeTargets,
  adjustmentLabel,
  adjustmentMoveCommands,
  adjustmentSpan,
  planAdjustmentCreation,
  planAdjustmentGesture,
  planAdjustmentKeyframeMove,
  planGroupMove,
  splitAdjustmentReason,
} from '../../src/web/adjustment-ui.js';
import { createColourSettings } from '../../src/shared/colour.js';
import {
  copyGradeBlocked,
  pasteGradeCommands,
  pasteTargets,
  pasteTargetsLabel,
} from '../../src/web/grade-clipboard.js';
import { placementSnapPoints, planTimelineDrop } from '../../src/web/timeline-placement.js';

function project(adjustments: Adjustment[]): ProjectDocument {
  const document = createProject('adjustment-ui', 'Adjustment UI');
  document.clips = [createClip('clip', 'recording', 0, 300)];
  document.adjustments = adjustments;
  return projectSchema.parse(document);
}

/** Two adjustments, the first keyed at its frames 0 and 10. */
function keyed(): ProjectDocument {
  let document = project([createAdjustment('a', 30, 40), createAdjustment('b', 100, 20)]);
  for (const frame of [0, 10])
    document = applyCommand(document, {
      type: 'layer-key-toggle',
      adjustmentId: 'a',
      frame,
      setting: 'exposure',
      value: frame / 10,
    });
  return document;
}

const item = (document: ProjectDocument, id: string) => document.adjustments.find((entry) => entry.id === id)!;

describe('adjustment timeline gestures', () => {
  it('names an adjustment by its range, OUT exclusive', () => {
    expect(adjustmentLabel({ start: 30, duration: 60 })).toBe('00:01:00 – 00:03:00');
  });

  it('moves an adjustment with its keyframes, which stay relative to its start', () => {
    const plan = planAdjustmentGesture(keyed(), 'a', 'move', 5);
    expect(plan.error).toBe('');
    expect(plan.command).toEqual({
      type: 'adjustment-range',
      adjustmentId: 'a',
      start: 35,
      duration: 40,
      keyframes: 'move',
    });
    expect(item(plan.document, 'a').keyframes.map((key) => key.frame)).toEqual([0, 10]);
  });

  it('trims either end, its keyframes keeping their project frames', () => {
    const start = planAdjustmentGesture(keyed(), 'a', 'in', -4);
    expect(item(start.document, 'a')).toMatchObject({ start: 26, duration: 44 });
    expect(item(start.document, 'a').keyframes.map((key) => key.frame)).toEqual([4, 14]);
    const end = planAdjustmentGesture(keyed(), 'a', 'out', -15);
    expect(item(end.document, 'a')).toMatchObject({ start: 30, duration: 25 });
    expect(end.command?.keyframes).toBe('stay');
    // A trim never leaves a keyframe outside the adjustment.
    expect(planAdjustmentGesture(keyed(), 'a', 'in', 4).error).toMatch(/within the adjustment/);
    expect(planAdjustmentGesture(keyed(), 'a', 'out', -35).error).toMatch(/within the adjustment/);
  });

  it('refuses overlaps, empty ranges and starts before frame 0 without clamping', () => {
    const document = keyed();
    const overlap = planAdjustmentGesture(document, 'a', 'out', 31);
    expect(overlap.error).toMatch(/cannot overlap/);
    expect(overlap.range).toEqual({ start: 30, duration: 71 });
    expect(overlap.document).toBe(document);
    expect(overlap.command).toBeNull();
    expect(planAdjustmentGesture(document, 'a', 'in', 40).error).toBe('An adjustment lasts at least one frame.');
    expect(planAdjustmentGesture(document, 'a', 'move', -31).error).toBe(
      'An adjustment cannot start before the first frame.',
    );
    expect(planAdjustmentGesture(document, 'a', 'out', 30).error).toBe('');
  });

  it('makes no command for an unchanged range', () => {
    const plan = planAdjustmentGesture(keyed(), 'a', 'move', 0);
    expect(plan).toMatchObject({ command: null, error: '' });
  });

  it('draws a new adjustment in either direction, refusing overlaps and empty ranges', () => {
    const document = keyed();
    const forward = planAdjustmentCreation(document, 'new', 75, 90);
    expect(forward.command).toEqual({ type: 'adjustment-add', adjustmentId: 'new', start: 75, duration: 15 });
    expect(planAdjustmentCreation(document, 'new', 90, 75).command).toEqual(forward.command);
    expect(planAdjustmentCreation(document, 'new', 60, 110).error).toMatch(/cannot overlap/);
    expect(planAdjustmentCreation(document, 'new', 80, 80).error).toBe('An adjustment lasts at least one frame.');
  });

  it('adds over the ruler range, else the selected clip, with the reason when it cannot', () => {
    const document = keyed();
    const clip = calculateLayout(document).clips[0]!;
    expect(adjustmentSpan({ inFrame: 75, outFrame: 90 }, clip)).toEqual({ start: 75, end: 90 });
    expect(adjustmentSpan(null, clip)).toEqual({ start: 0, end: 300 });
    expect(adjustmentSpan(null, undefined)).toBeNull();
    expect(addAdjustmentReason(document, { start: 75, end: 90 })).toBeNull();
    expect(addAdjustmentReason(document, { start: 0, end: 300 })).toMatch(/cannot overlap/);
    expect(addAdjustmentReason(document, null)).toMatch(/Select a range on the time ruler or a clip/);
    const full = projectSchema.parse({
      ...document,
      adjustments: Array.from({ length: MAX_ADJUSTMENTS }, (_, index) => createAdjustment(`x${index}`, index, 1)),
    });
    expect(addAdjustmentReason(full, { start: 200, end: 210 })).toMatch(`at most ${MAX_ADJUSTMENTS}`);
  });

  it('splits only after an adjustment’s first frame and before its end', () => {
    const a = item(keyed(), 'a');
    expect(splitAdjustmentReason(a, 31)).toBeNull();
    for (const frame of [30, 70, 5]) expect(splitAdjustmentReason(a, frame)).toMatch(/inside the selected adjustment/);
  });

  it('snaps to other adjustments, never to the moving one', () => {
    const document = keyed();
    expect(snapPoints(document)).toEqual(expect.arrayContaining([30, 70, 100, 120]));
    const points = placementSnapPoints(document, 'a', 0);
    expect(points).toEqual(expect.arrayContaining([100, 120]));
    expect(points).not.toContain(70);
  });
});

describe('clips and adjustments selected together', () => {
  const starts = (document: ProjectDocument) => ({
    clip: calculateLayout(document).clips[0]!.start,
    adjustments: document.adjustments.map((entry) => entry.start),
  });

  it('move by the same frames in one transaction, adjustments keeping their keyframes', () => {
    const plan = planGroupMove(keyed(), ['clip'], ['a', 'b'], 10);
    expect(plan.error).toBe('');
    expect(starts(plan.document)).toEqual({ clip: 10, adjustments: [40, 110] });
    expect(item(plan.document, 'a').keyframes.map((key) => key.frame)).toEqual([0, 10]);
    // The leading adjustment moves first, so the other never overlaps it on the way.
    expect(
      adjustmentMoveCommands(keyed(), ['a', 'b'], 35).map(
        (command) => 'adjustmentId' in command && command.adjustmentId,
      ),
    ).toEqual(['b', 'a']);
    expect(planGroupMove(keyed(), [], ['a', 'b'], 35).error).toBe('');
    expect(planGroupMove(keyed(), ['clip'], ['a'], -31).error).toBe(
      'An adjustment cannot start before the first frame.',
    );
    expect(planGroupMove(keyed(), [], ['a'], 31).error).toMatch(/cannot overlap/);
  });

  it('follow a dragged clip by the frames it moves, shown as ghosts', () => {
    const document = keyed();
    const plan = planTimelineDrop(
      document,
      { kind: 'group', clipIds: ['clip'], clipId: 'clip', grabFrame: 0, adjustmentIds: ['b'] },
      'video-1',
      5,
      false,
      8,
      0,
    );
    expect(plan.error).toBe('');
    expect(plan.adjustmentGhosts).toEqual([{ id: 'b', start: 105, duration: 20 }]);
    const moved = [plan.command!, ...plan.adjustmentCommands!].reduce(
      (next, command) => applyCommand(next, command),
      document,
    );
    expect(starts(moved)).toEqual({ clip: 5, adjustments: [30, 105] });
    const blocked = planTimelineDrop(
      document,
      { kind: 'group', clipIds: ['clip'], clipId: 'clip', grabFrame: 0, adjustmentIds: ['a'] },
      'video-1',
      40,
      false,
      8,
      0,
    );
    expect(blocked.command).toBeNull();
    expect(blocked.error).toMatch(/cannot overlap/);
  });

  it('copy grades without keyframes and paste them on clips and adjustments, removing keyframes', () => {
    const document = keyed();
    const clip = { kind: 'clip' as const, id: 'clip' };
    const a = { kind: 'adjustment' as const, id: 'a' };
    const b = { kind: 'adjustment' as const, id: 'b' };
    expect(copyGradeBlocked(document, a)).toBe(
      'This adjustment’s grade has keyframes; only a grade without keyframes can be copied.',
    );
    expect(copyGradeBlocked(document, b)).toBeNull();
    expect(copyGradeBlocked(document, { kind: 'adjustment', id: 'gone' })).toBe('This adjustment no longer exists.');
    expect(pasteTargets(b, [clip, a])).toEqual([b]);
    expect(pasteTargets(a, [clip, a])).toEqual([clip, a]);
    expect(pasteTargetsLabel([b])).toBe('this adjustment');
    expect(pasteTargetsLabel([clip, a, b])).toBe('1 clip and 2 adjustments');
    expect(pasteTargetsLabel([a, b])).toBe('these 2 adjustments');
    const colour = { ...createColourSettings(), saturation: 0.4 };
    const pasted = pasteGradeCommands(document, [clip, a], colour).reduce(
      (next, command) => applyCommand(next, command),
      document,
    );
    expect(pasted.clips[0]!.grade).toEqual({ colour, keyframes: [] });
    expect(item(pasted, 'a')).toMatchObject({ colour, keyframes: [] });
    expect(item(pasted, 'b')).toEqual(item(document, 'b'));
  });
});

describe('adjustment keyframe markers', () => {
  it('draws every keyframe, which always lies within the range', () => {
    expect(adjustmentKeyframeTargets(item(keyed(), 'a')).map((target) => target.origin)).toEqual([0, 10]);
  });

  it('moves a keyframe within its adjustment, refusing occupied frames and frames outside it', () => {
    const document = keyed();
    const moved = planAdjustmentKeyframeMove(document, 'a', 10, 20);
    expect(moved.command).toEqual({ type: 'layer-key-move', adjustmentId: 'a', frame: 10, nextFrame: 20 });
    expect(item(moved.document, 'a').keyframes.map((key) => key.frame)).toEqual([0, 20]);
    expect(planAdjustmentKeyframeMove(document, 'a', 10, 0).error).toMatch(/already exists/);
    expect(planAdjustmentKeyframeMove(document, 'a', 10, 40).error).toBe('Keep the keyframe within its adjustment.');
    expect(planAdjustmentKeyframeMove(document, 'a', 10, -1).error).toBe('Keep the keyframe within its adjustment.');
  });

  it('maps pointer travel to project frames and seeks the keyframe in its adjustment', () => {
    const seeks: number[] = [];
    const kind = adjustmentKeyframeKind({ onSelect: () => {}, onSeek: (frame) => seeks.push(frame), onOpen: () => {} });
    const document = keyed();
    const [, target] = adjustmentKeyframeTargets(item(document, 'a'));
    expect(kind.at(target!, 0)).toBe(40);
    expect(kind.at(target!, 100)).toBe(69);
    // Snapping may land on the last frame but never past the adjustment, whose OUT is exclusive.
    expect(kind.snapRange!(target!)).toEqual({ min: 30, max: 69 });
    expect(kind.planAt(document, target!, 69).error).toBe('');
    expect(kind.planAt(document, target!, 50).frame).toBe(20);
    expect(kind.step(document, target!, -1).frame).toBe(9);
    kind.reveal(document, target!, 10, false);
    expect(seeks).toEqual([40]);
    expect(kind.remove!(document, target!)).toEqual({ type: 'layer-key-remove', adjustmentId: 'a', frame: 10 });
  });
});
