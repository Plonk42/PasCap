import { describe, expect, it } from 'vitest';
import { createColorSettings, NEUTRAL_COLOR, type RGB, type ScalarColorSetting } from '../../src/shared/color.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { adjustmentColor, compositePixel } from '../../src/shared/composition.js';
import { editedFrame } from '../../src/shared/edited-frame.js';
import { needsLayeredExport } from '../../src/shared/export.js';
import {
  adjustmentAt,
  createAdjustment,
  GRADE_SETTINGS,
  gradeChainPixel,
  MAX_ADJUSTMENTS,
  type Adjustment,
} from '../../src/shared/grade.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { hasGeometryEdits, hasSpatialEdits, isNeutralSpatial, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { sampleTimeline } from '../../src/shared/timeline.js';

function project(adjustments: Adjustment[] = []): ProjectDocument {
  const document = createProject('adjustments', 'Adjustments');
  document.layers.push(createLayer('video-2', 'Track 2', false));
  document.clips = [
    createClip('lower', 'recording', 0, 120),
    { ...createClip('upper', 'recording', 0, 60), layerId: 'video-2', start: 20 },
  ];
  document.adjustments = adjustments;
  return projectSchema.parse(document);
}

const warm = (item: Adjustment, temperature: number): Adjustment => ({
  ...item,
  color: { ...item.color, temperature },
});

describe('adjustments', () => {
  it('grade every video track within their range and nothing outside it', () => {
    const document = project([warm(createAdjustment('look', 30, 20), 0.5)]);
    for (const frame of [29, 50]) {
      for (const layer of sampleTimeline(document, frame)) expect(layer.color).toEqual(NEUTRAL_COLOR);
    }
    for (const frame of [30, 49]) {
      const layers = sampleTimeline(document, frame);
      expect(layers.map((layer) => layer.layerId)).toEqual(['video-1', 'video-2']);
      for (const layer of layers) expect(layer.color.temperature).toBe(0.5);
    }
  });

  it('apply after the clip grade, each source keeping its own', () => {
    const document = project([warm(createAdjustment('look', 0, 100), 0.5)]);
    document.clips[0]!.grade.color.exposure = 1;
    const [lower, upper] = sampleTimeline(projectSchema.parse(document), 40);
    expect(lower).toMatchObject({ grade: { exposure: 1 }, color: { temperature: 0.5, exposure: 0 } });
    expect(upper).toMatchObject({ grade: { exposure: 0 }, color: { temperature: 0.5 } });
    // Sequential: the clip grade, then the adjustment on its encoded output, never their sum.
    const rgb: RGB = [0.4, 0.3, 0.2];
    const graded = compositePixel([lower!], () => rgb);
    expect(graded).toEqual(gradeChainPixel(gradeChainPixel(rgb, [lower!.grade]), [lower!.color]));
    // Brightening a stop clips the highlights, which darkening a stop afterwards cannot restore; a sum would.
    const bright: RGB = [0.95, 0.9, 0.85];
    const darker = { ...lower!, color: { ...createColorSettings(), exposure: -1 } };
    const restored = compositePixel([darker], () => bright);
    expect(restored[0]).toBeLessThan(bright[0] - 0.1);
    expect(gradeChainPixel(bright, [{ ...lower!.grade, exposure: 0 }])).toEqual(bright);
  });

  it('evaluate keyframes counted from their start', () => {
    const item: Adjustment = {
      ...createAdjustment('look', 100, 50),
      keyframes: [
        {
          frame: 0,
          values: { ...nullValues(), exposure: 0 },
          easing: { ...nullEasing(), exposure: 'linear' },
          reset: false,
        },
        {
          frame: 10,
          values: { ...nullValues(), exposure: 1 },
          easing: { ...nullEasing(), exposure: 'linear' },
          reset: false,
        },
      ],
    };
    const document = { adjustments: [item] };
    expect(adjustmentColor(document, 100).exposure).toBeCloseTo(0);
    expect(adjustmentColor(document, 105).exposure).toBeCloseTo(0.5);
    expect(adjustmentColor(document, 110).exposure).toBe(1);
    expect(adjustmentColor(document, 149).exposure).toBe(1);
    expect(adjustmentColor(document, 150)).toEqual(NEUTRAL_COLOR);
    expect(adjustmentAt([item], 99)).toBeUndefined();
  });

  it('are added, moved, trimmed and removed in one Undo step each, never overlapping', () => {
    const history = new EditHistory(project());
    history.commit({ type: 'adjustment-add', adjustmentId: 'b', start: 60, duration: 20 });
    history.commit({ type: 'adjustment-add', adjustmentId: 'a', start: 10, duration: 20 });
    expect(history.current.adjustments.map((item) => item.id)).toEqual(['a', 'b']);
    expect(() => history.commit({ type: 'adjustment-add', adjustmentId: 'c', start: 25, duration: 10 })).toThrow(
      'Adjustments cannot overlap',
    );
    expect(() =>
      history.commit({ type: 'adjustment-range', adjustmentId: 'a', start: 50, duration: 20, keyframes: 'move' }),
    ).toThrow('Adjustments cannot overlap');
    history.commit({ type: 'adjustment-remove', adjustmentId: 'b' });
    expect(history.current.adjustments.map((item) => item.id)).toEqual(['a']);
    history.undo();
    expect(history.current.adjustments.map((item) => item.id)).toEqual(['a', 'b']);
    expect(() => applyCommand(history.current, { type: 'adjustment-remove', adjustmentId: 'gone' })).toThrow(
      'Adjustment no longer exists',
    );
    expect(() =>
      applyCommand(history.current, { type: 'adjustment-add', adjustmentId: 'z', start: 0, duration: 0 }),
    ).toThrow('at least one frame');
  });

  it('start with the scalar settings they are added with, the others neutral', () => {
    const added = applyCommand(project(), {
      type: 'adjustment-add',
      adjustmentId: 'look',
      start: 0,
      duration: 60,
      settings: { saturation: 1.3, temperature: 0.2 },
    });
    expect(added.adjustments[0]!.color).toEqual({ ...createColorSettings(), saturation: 1.3, temperature: 0.2 });
    expect(() =>
      applyCommand(project(), {
        type: 'adjustment-add',
        adjustmentId: 'look',
        start: 0,
        duration: 60,
        settings: { saturation: 3 },
      }),
    ).toThrow();
  });

  it('carry their keyframes when moved and keep their project frames when trimmed, never outside their range', () => {
    let document = applyCommand(project(), { type: 'adjustment-add', adjustmentId: 'a', start: 10, duration: 40 });
    document = applyCommand(document, {
      type: 'layer-key-toggle',
      adjustmentId: 'a',
      frame: 15,
      setting: 'exposure',
      value: 0.5,
    });
    const moved = applyCommand(document, {
      type: 'adjustment-range',
      adjustmentId: 'a',
      start: 30,
      duration: 40,
      keyframes: 'move',
    });
    expect(moved.adjustments[0]!.keyframes[0]!.frame).toBe(15);
    const trimmed = applyCommand(document, {
      type: 'adjustment-range',
      adjustmentId: 'a',
      start: 20,
      duration: 30,
      keyframes: 'stay',
    });
    // The keyframe at project frame 25 stays there.
    expect(trimmed.adjustments[0]!.keyframes[0]!.frame).toBe(5);
    const restored = applyCommand(trimmed, {
      type: 'adjustment-range',
      adjustmentId: 'a',
      start: 10,
      duration: 40,
      keyframes: 'stay',
    });
    expect(restored.adjustments).toEqual(document.adjustments);
    // A trim that would leave the keyframe outside the adjustment is refused, never clamped.
    for (const range of [
      { start: 30, duration: 20, keyframes: 'stay' as const },
      { start: 10, duration: 10, keyframes: 'stay' as const },
      { start: 10, duration: 15, keyframes: 'move' as const },
    ])
      expect(() => applyCommand(document, { type: 'adjustment-range', adjustmentId: 'a', ...range })).toThrow(
        'within the adjustment',
      );
    for (const frame of [-1, 40])
      expect(() =>
        applyCommand(document, {
          type: 'layer-key-toggle',
          adjustmentId: 'a',
          frame,
          setting: 'exposure',
          value: 0.5,
        }),
      ).toThrow('within the adjustment');
  });

  it('split into two pieces with the whole grade, each keeping the keyframes within its range', () => {
    let document = applyCommand(project(), { type: 'adjustment-add', adjustmentId: 'a', start: 10, duration: 40 });
    document = applyCommand(document, { type: 'color-setting', adjustmentId: 'a', setting: 'saturation', value: 0.5 });
    for (const frame of [5, 30])
      document = applyCommand(document, {
        type: 'layer-key-toggle',
        adjustmentId: 'a',
        frame,
        setting: 'exposure',
        value: 1,
      });
    const split = applyCommand(document, {
      type: 'adjustment-split',
      adjustmentId: 'a',
      frame: 30,
      newAdjustmentId: 'b',
    });
    const [left, right] = split.adjustments;
    expect(left).toMatchObject({ id: 'a', start: 10, duration: 20 });
    expect(right).toMatchObject({ id: 'b', start: 30, duration: 20 });
    expect(right!.color).toEqual(left!.color);
    expect(left!.keyframes.map((key) => key.frame)).toEqual([5]);
    expect(right!.keyframes.map((key) => key.frame)).toEqual([10]);
    // Each frame keeps its grade.
    for (const frame of [12, 29, 30, 45])
      expect(sampleTimeline(split, frame)[0]!.color).toEqual(sampleTimeline(document, frame)[0]!.color);
    for (const frame of [10, 50])
      expect(() =>
        applyCommand(document, { type: 'adjustment-split', adjustmentId: 'a', frame, newAdjustmentId: 'b' }),
      ).toThrow('inside it');
    expect(() =>
      applyCommand(split, { type: 'adjustment-split', adjustmentId: 'b', frame: 40, newAdjustmentId: 'a' }),
    ).toThrow('already exists');
  });

  it('never follow clip edits and never extend the project', () => {
    const document = applyCommand(project(), { type: 'adjustment-add', adjustmentId: 'a', start: 100, duration: 500 });
    const moved = applyCommand(document, { type: 'delete', clipId: 'lower' });
    expect(moved.adjustments).toEqual(document.adjustments);
    expect(sampleTimeline(document, 130)).toEqual([]);
  });

  it('refuse a color command naming no target or two', () => {
    const document = applyCommand(project(), { type: 'adjustment-add', adjustmentId: 'a', start: 0, duration: 10 });
    expect(() => applyCommand(document, { type: 'color', color: createColorSettings() })).toThrow('Give either');
    expect(() =>
      applyCommand(document, { type: 'color', clipIds: ['lower'], adjustmentId: 'a', color: createColorSettings() }),
    ).toThrow('Give either');
    const graded = applyCommand(document, {
      type: 'color-setting',
      adjustmentId: 'a',
      setting: 'saturation',
      value: 1.4,
    });
    expect(graded.adjustments[0]!.color.saturation).toBe(1.4);
    expect(graded.clips.every((clip) => clip.grade.color.saturation === 1)).toBe(true);
  });

  it(`hold at most ${MAX_ADJUSTMENTS}`, () => {
    let document = project();
    document = {
      ...document,
      adjustments: Array.from({ length: MAX_ADJUSTMENTS }, (_, index) => createAdjustment(`a${index}`, index * 2, 1)),
    };
    expect(() =>
      applyCommand(projectSchema.parse(document), {
        type: 'adjustment-add',
        adjustmentId: 'extra',
        start: MAX_ADJUSTMENTS * 2 + 10,
        duration: 1,
      }),
    ).toThrow(`at most ${MAX_ADJUSTMENTS}`);
  });

  it('send the export through composition, and show the frames they change', () => {
    const plain = project();
    plain.layers = [plain.layers[0]!];
    plain.clips = [plain.clips[0]!];
    expect(needsLayeredExport(projectSchema.parse(plain))).toBe(false);
    const adjusted = applyCommand(projectSchema.parse(plain), {
      type: 'adjustment-add',
      adjustmentId: 'a',
      start: 40,
      duration: 10,
    });
    expect(needsLayeredExport(adjusted)).toBe(true);
    expect(editedFrame(projectSchema.parse(plain), adjusted)).toBe(40);
  });
});

describe('Transform Opacity', () => {
  it('is coverage, not geometry, and samples into each source', () => {
    const document = project();
    document.layers[1]!.transform.base.opacity = 0.4;
    expect(isNeutralSpatial(document.layers[1]!.transform.base)).toBe(true);
    expect(hasGeometryEdits(document.layers[1]!.transform)).toBe(false);
    expect(hasSpatialEdits(document.layers[1]!.transform)).toBe(true);
    const upper = sampleTimeline(projectSchema.parse(document), 30).find((layer) => layer.layerId === 'video-2')!;
    expect(upper.opacity).toBe(0.4);
  });

  it('is edited with transform-setting and returns to 1 with a default Transform keyframe', () => {
    const document = applyCommand(project(), {
      type: 'transform-setting',
      layerId: 'video-2',
      setting: 'opacity',
      value: 0.25,
    });
    expect(document.layers[1]!.transform.base).toEqual({ ...NEUTRAL_SPATIAL_POSE, opacity: 0.25 });
    expect(() =>
      applyCommand(document, { type: 'transform-setting', layerId: 'video-2', setting: 'opacity', value: 1.5 }),
    ).toThrow();
  });
});

function nullValues(): Record<ScalarColorSetting, null> {
  return Object.fromEntries(GRADE_SETTINGS.map((key) => [key, null])) as Record<ScalarColorSetting, null>;
}
function nullEasing(): Record<ScalarColorSetting, null> {
  return nullValues();
}
