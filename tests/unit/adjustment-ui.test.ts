import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { createAdjustment, type Adjustment } from '../../src/shared/grade.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { snapPoints } from '../../src/shared/snap.js';
import {
  adjustmentKeyframeKind,
  adjustmentKeyframeTargets,
  adjustmentLabel,
  planAdjustmentGesture,
  planAdjustmentKeyframeMove,
} from '../../src/web/adjustment-ui.js';
import { placementSnapPoints } from '../../src/web/timeline-placement.js';

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
    const start = planAdjustmentGesture(keyed(), 'a', 'in', 4);
    expect(item(start.document, 'a')).toMatchObject({ start: 34, duration: 36 });
    expect(item(start.document, 'a').keyframes.map((key) => key.frame)).toEqual([-4, 6]);
    const end = planAdjustmentGesture(keyed(), 'a', 'out', -15);
    expect(item(end.document, 'a')).toMatchObject({ start: 30, duration: 25 });
    expect(end.command?.keyframes).toBe('stay');
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

  it('snaps to other adjustments, never to the moving one', () => {
    const document = keyed();
    expect(snapPoints(document)).toEqual(expect.arrayContaining([30, 70, 100, 120]));
    const points = placementSnapPoints(document, 'a', 0);
    expect(points).toEqual(expect.arrayContaining([100, 120]));
    expect(points).not.toContain(70);
  });
});

describe('adjustment keyframe markers', () => {
  it('draws only the keyframes within the range', () => {
    const document = applyCommand(keyed(), {
      type: 'adjustment-range',
      adjustmentId: 'a',
      start: 35,
      duration: 35,
      keyframes: 'stay',
    });
    expect(adjustmentKeyframeTargets(item(document, 'a')).map((target) => target.origin)).toEqual([5]);
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
    expect(kind.planAt(document, target!, 50).frame).toBe(20);
    expect(kind.step(document, target!, -1).frame).toBe(9);
    kind.reveal(document, target!, 10, false);
    expect(seeks).toEqual([40]);
    expect(kind.remove!(document, target!)).toEqual({ type: 'layer-key-remove', adjustmentId: 'a', frame: 10 });
  });
});
