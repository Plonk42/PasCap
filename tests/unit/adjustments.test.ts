import { describe, expect, it } from 'vitest';
import { createColourSettings, NEUTRAL_COLOUR, type RGB, type ScalarColourSetting } from '../../src/shared/colour.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { adjustmentColour, compositePixel } from '../../src/shared/composition.js';
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
  colour: { ...item.colour, temperature },
});

describe('adjustments', () => {
  it('grade every video track within their range and nothing outside it', () => {
    const document = project([warm(createAdjustment('look', 30, 20), 0.5)]);
    for (const frame of [29, 50]) {
      for (const layer of sampleTimeline(document, frame)) expect(layer.colour).toEqual(NEUTRAL_COLOUR);
    }
    for (const frame of [30, 49]) {
      const layers = sampleTimeline(document, frame);
      expect(layers.map((layer) => layer.layerId)).toEqual(['video-1', 'video-2']);
      for (const layer of layers) expect(layer.colour.temperature).toBe(0.5);
    }
  });

  it('apply after the clip grade, each source keeping its own', () => {
    const document = project([warm(createAdjustment('look', 0, 100), 0.5)]);
    document.clips[0]!.grade.colour.exposure = 1;
    const [lower, upper] = sampleTimeline(projectSchema.parse(document), 40);
    expect(lower).toMatchObject({ grade: { exposure: 1 }, colour: { temperature: 0.5, exposure: 0 } });
    expect(upper).toMatchObject({ grade: { exposure: 0 }, colour: { temperature: 0.5 } });
    // Sequential: the clip grade, then the adjustment on its encoded output, never their sum.
    const rgb: RGB = [0.4, 0.3, 0.2];
    const graded = compositePixel([lower!], () => rgb);
    expect(graded).toEqual(gradeChainPixel(gradeChainPixel(rgb, [lower!.grade]), [lower!.colour]));
    // Brightening a stop clips the highlights, which darkening a stop afterwards cannot restore; a sum would.
    const bright: RGB = [0.95, 0.9, 0.85];
    const darker = { ...lower!, colour: { ...createColourSettings(), exposure: -1 } };
    const restored = compositePixel([darker], () => bright);
    expect(restored[0]).toBeLessThan(bright[0] - 0.1);
    expect(gradeChainPixel(bright, [{ ...lower!.grade, exposure: 0 }])).toEqual(bright);
  });

  it('evaluate keyframes counted from their start, including before it', () => {
    const item: Adjustment = {
      ...createAdjustment('look', 100, 50),
      keyframes: [
        {
          frame: -10,
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
    expect(adjustmentColour(document, 100).exposure).toBeCloseTo(0.5);
    expect(adjustmentColour(document, 110).exposure).toBe(1);
    expect(adjustmentColour(document, 149).exposure).toBe(1);
    expect(adjustmentColour(document, 150)).toEqual(NEUTRAL_COLOUR);
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
    expect(added.adjustments[0]!.colour).toEqual({ ...createColourSettings(), saturation: 1.3, temperature: 0.2 });
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

  it('carry their keyframes when moved and keep their project frames when trimmed', () => {
    let document = applyCommand(project(), { type: 'adjustment-add', adjustmentId: 'a', start: 10, duration: 40 });
    document = applyCommand(document, {
      type: 'layer-key-toggle',
      adjustmentId: 'a',
      frame: 5,
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
    expect(moved.adjustments[0]!.keyframes[0]!.frame).toBe(5);
    const trimmed = applyCommand(document, {
      type: 'adjustment-range',
      adjustmentId: 'a',
      start: 20,
      duration: 30,
      keyframes: 'stay',
    });
    // The keyframe at project frame 15 stays there, now before the trimmed start, so trimming back restores it.
    expect(trimmed.adjustments[0]!.keyframes[0]!.frame).toBe(-5);
    const restored = applyCommand(trimmed, {
      type: 'adjustment-range',
      adjustmentId: 'a',
      start: 10,
      duration: 40,
      keyframes: 'stay',
    });
    expect(restored.adjustments).toEqual(document.adjustments);
  });

  it('split into two pieces with the whole grade and every keyframe at its project frame', () => {
    let document = applyCommand(project(), { type: 'adjustment-add', adjustmentId: 'a', start: 10, duration: 40 });
    document = applyCommand(document, { type: 'colour-setting', adjustmentId: 'a', setting: 'saturation', value: 0.5 });
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
    expect(right!.colour).toEqual(left!.colour);
    expect(left!.keyframes.map((key) => key.frame)).toEqual([5, 30]);
    expect(right!.keyframes.map((key) => key.frame)).toEqual([-15, 10]);
    // Each frame keeps its grade.
    for (const frame of [12, 29, 30, 45])
      expect(sampleTimeline(split, frame)[0]!.colour).toEqual(sampleTimeline(document, frame)[0]!.colour);
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

  it('refuse a colour command naming no target or two', () => {
    const document = applyCommand(project(), { type: 'adjustment-add', adjustmentId: 'a', start: 0, duration: 10 });
    expect(() => applyCommand(document, { type: 'colour', colour: createColourSettings() })).toThrow('Give either');
    expect(() =>
      applyCommand(document, { type: 'colour', clipIds: ['lower'], adjustmentId: 'a', colour: createColourSettings() }),
    ).toThrow('Give either');
    const graded = applyCommand(document, {
      type: 'colour-setting',
      adjustmentId: 'a',
      setting: 'saturation',
      value: 1.4,
    });
    expect(graded.adjustments[0]!.colour.saturation).toBe(1.4);
    expect(graded.clips.every((clip) => clip.grade.colour.saturation === 1)).toBe(true);
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
        start: 1_000,
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

function nullValues(): Record<ScalarColourSetting, null> {
  return Object.fromEntries(GRADE_SETTINGS.map((key) => [key, null])) as Record<ScalarColourSetting, null>;
}
function nullEasing(): Record<ScalarColourSetting, null> {
  return nullValues();
}
