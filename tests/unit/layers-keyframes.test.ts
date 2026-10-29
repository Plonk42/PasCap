import { describe, expect, it } from 'vitest';
import { createColourSettings, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { adjustmentColour, compositePixel, opacityAt } from '../../src/shared/composition.js';
import {
  adjustmentColourAt,
  createAdjustment,
  gradeKeyAsLayerKey,
  layerKeyAsGradeKey,
  type Adjustment,
  type GradeKeyframe,
  type GradeKeyValues,
} from '../../src/shared/grade.js';
import {
  EMPTY_KEY_VALUES,
  evaluateLayerSetting,
  keySettings,
  type Interpolation,
  layerKeyframe,
  uniformKeyframe,
} from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema } from '../../src/shared/model.js';
import { validateSourceRanges } from '../../src/shared/source-range.js';
import {
  SPATIAL_CHANNELS,
  type SpatialChannel,
  type SpatialKeyframe,
  type SpatialPose,
} from '../../src/shared/spatial.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

/** A Colour keyframe of an adjustment or clip grade. */
function point(frame: number, values: Partial<GradeKeyValues>, interpolation: Interpolation = 'linear'): GradeKeyframe {
  return layerKeyAsGradeKey(layerKeyframe(frame, { ...EMPTY_KEY_VALUES, ...values }, interpolation));
}
const NO_SETTINGS = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as Record<
  SpatialChannel,
  null
>;
/** A Transform keyframe of a track, at a project frame. */
function transformKey(
  frame: number,
  values: Partial<SpatialPose>,
  interpolation: Interpolation = 'linear',
): SpatialKeyframe {
  return { ...uniformKeyframe(frame, { ...NO_SETTINGS, ...values }, interpolation), reset: false };
}
/** An adjustment from project frame 0, so its keyframe frames are project frames. */
function look(keyframes: GradeKeyframe[] = [], colour = createColourSettings()): Adjustment {
  return { ...createAdjustment('look', 0, 1_000), colour, keyframes };
}
function layered() {
  let project = applyCommand(createProject('flight', 'Flight'), {
    type: 'insert',
    clip: createClip('bottom', 'red', 0, 100),
    index: 0,
  });
  const upper = createLayer('upper', 'Track 2', false);
  upper.transform.base.opacity = 0.5;
  project = applyCommand(project, { type: 'layer-add', layer: upper });
  return applyCommand(project, {
    type: 'insert',
    clip: { ...createClip('top', 'blue', 0, 100), layerId: 'upper', start: 20 },
    index: 1,
  });
}
describe('layer layout, compositing and edit commands', () => {
  it('defaults every row to full opacity and edits an empty row in one Undo without creating keys', () => {
    const document = createProject('empty-opacity', 'Empty opacity');
    document.layers.push(createLayer('other', 'Other'));
    expect(document.layers.map((layer) => layer.transform.base.opacity)).toEqual([1, 1]);
    const history = new EditHistory(document);
    history.commit({ type: 'transform-setting', layerId: 'video-1', setting: 'opacity', value: 0.23456789 });
    const { transform } = document.layers[0]!;
    expect(history.current.layers[0]).toEqual({
      ...document.layers[0]!,
      transform: { ...transform, base: { ...transform.base, opacity: 0.23456789 } },
    });
    expect(history.current.layers[1]).toEqual(document.layers[1]);
    expect(history.current.clips).toEqual([]);
    expect(history.current.layers[0]!.transform.keyframes).toEqual([]);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.redo().layers[0]!.transform.base.opacity).toBe(0.23456789);
  });
  it('edits every clip on one row uniformly and keeps the other row, timing and clip settings independent', () => {
    const document = layered();
    const history = new EditHistory(document);
    const beforeLayout = calculateLayout(document);
    history.commit({ type: 'duplicate', clipId: 'top', newClipId: 'later' });
    const populated = history.current;
    history.commit({ type: 'transform-setting', layerId: 'upper', setting: 'opacity', value: 0.3 });
    expect(history.current.clips).toEqual(populated.clips);
    expect(history.current.layers[0]).toEqual(populated.layers[0]);
    expect(history.current.layers[1]!.transform.keyframes).toEqual([]);
    for (const frame of [50, 150])
      expect(sampleTimeline(history.current, frame).find((sample) => sample.layerId === 'upper')!.opacity).toBe(0.3);
    expect(sampleTimeline(history.current, 50)[0]!.opacity).toBe(1);
    expect(calculateLayout(history.current).clips.map(({ start, end }) => [start, end])).toEqual(
      calculateLayout(populated).clips.map(({ start, end }) => [start, end]),
    );
    expect(beforeLayout.duration).toBe(120);
    expect(history.undo()).toEqual(populated);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
  });
  it.each([-1, 1.1, NaN, Infinity])('rejects row opacity %s atomically without discarding redo', (opacity) => {
    const document = layered();
    const history = new EditHistory(document);
    const changed = history.commit({ type: 'transform-setting', layerId: 'upper', setting: 'opacity', value: 0.3 });
    history.undo();
    expect(() =>
      history.commit({ type: 'transform-setting', layerId: 'upper', setting: 'opacity', value: opacity }),
    ).toThrow();
    expect(history.current).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(() =>
      history.commit({ type: 'transform-setting', layerId: 'missing', setting: 'opacity', value: 0.5 }),
    ).toThrow('Track no longer exists');
    expect(history.current).toEqual(document);
    expect(history.redo()).toEqual(changed);
  });
  it('preserves primary ripple and positions overlays independently with gaps/tails', () => {
    const project = layered();
    const layout = calculateLayout(project);
    expect(layout.clips.find((clip) => clip.clip.id === 'bottom')!.end).toBe(100);
    expect(layout.duration).toBe(120);
    expect(sampleTimeline(project, 10)).toHaveLength(1);
    expect(sampleTimeline(project, 50)).toHaveLength(2);
    expect(sampleTimeline(project, 110).map((layer) => layer.clipId)).toEqual(['top']);
  });
  it('composites source-over in layer order and supports hidden rows and half-opacity rows', () => {
    const project = layered();
    const pixel = compositePixel(sampleTimeline(project, 50), (layer) =>
      layer.mediaId === 'red' ? [1, 0, 0] : [0, 0, 1],
    );
    expect(pixel[0]).toBeCloseTo(0.5);
    expect(pixel[1]).toBeCloseTo(0);
    expect(pixel[2]).toBeCloseTo(0.5);
    project.layers[1]!.enabled = false;
    expect(calculateLayout(project).duration).toBe(120);
    expect(sampleTimeline(project, 110)).toEqual([]);
  });
  it('rejects same-lane overlap but permits overlap across different layers', () => {
    const project = layered();
    expect(() =>
      applyCommand(project, {
        type: 'insert',
        clip: { ...createClip('conflict', 'blue', 0, 30), layerId: 'upper', start: 40 },
        index: 2,
      }),
    ).toThrow('cannot overlap');
    expect(() =>
      projectSchema.parse({ ...project, layers: [{ ...project.layers[0]!, id: 'wrong' }, project.layers[1]] }),
    ).toThrow();
    const removed = applyCommand(project, { type: 'layer-remove', layerId: 'video-1' });
    expect(removed.layers.map((layer) => layer.id)).toEqual(['upper']);
    expect(removed.clips).toEqual([project.clips[1]]);
    expect(() => applyCommand(removed, { type: 'layer-remove', layerId: 'upper' })).toThrow('last video track');
  });
  it('layer deletion is one undoable operation restoring its clips/grades/keys', () => {
    const project = layered();
    project.clips[1]!.grade.colour = { ...NEUTRAL_COLOUR, exposure: 0.7, saturation: 0.4 };
    project.layers[1]!.transform.keyframes = [
      transformKey(20, { opacity: 0.3, rotation: 45 }, 'smooth'),
      transformKey(100, { opacity: 0.8 }),
    ];
    const history = new EditHistory(project);
    history.commit({ type: 'layer-remove', layerId: 'upper' });
    expect(history.current.clips).toHaveLength(1);
    expect(history.undo().clips).toHaveLength(2);
    expect(history.current.clips[1]).not.toHaveProperty('opacity');
    expect(history.current.layers[1]!.transform.base.opacity).toBe(0.5);
    expect(history.current).toEqual(project);
    expect(history.redo().layers.map((layer) => layer.id)).toEqual(['video-1']);
  });
  it('duplicates independent static clip settings while retaining the track and adjustment curves as one undo step', () => {
    const project = layered();
    project.layers[1]!.transform.keyframes = [transformKey(20, { opacity: 0.75 }, 'smooth')];
    project.adjustments = [look([point(20, { exposure: 0.4 }, 'smooth')])];
    project.clips[1]!.grade.colour.contrast = 1.3;
    const history = new EditHistory(project);
    const original = history.current.clips[1]!;
    history.commit({ type: 'duplicate', clipId: original.id, newClipId: 'copy' });
    const copy = history.current.clips.find((clip) => clip.id === 'copy')!;
    expect(copy).toEqual({ ...original, id: 'copy', start: 120 });
    expect(copy).not.toHaveProperty('animation');
    expect(history.current.layers[1]!.transform).toEqual(project.layers[1]!.transform);
    expect(sampleTimeline(history.current, 150)[0]).toMatchObject({
      clipId: 'copy',
      grade: { contrast: 1.3 },
      colour: { exposure: 0.4 },
      opacity: 0.75,
    });
    expect(copy).not.toHaveProperty('colour');
    expect(copy).not.toHaveProperty('correction');
    expect(history.current.adjustments).toEqual(project.adjustments);
    history.undo();
    expect(history.current).toEqual(project);
  });
  it('primary duplicate inserts directly after its source and repairs transition adjacency', () => {
    const document = layered();
    const copy = applyCommand(document, { type: 'duplicate', clipId: 'bottom', newClipId: 'copy' });
    expect(copy.clips.map((clip) => clip.id)).toEqual(['bottom', 'copy', 'top']);
    expect(copy.layers[0]!.transitions).toEqual([{ leftId: 'bottom', rightId: 'copy', type: 'cut', duration: 0 }]);
    expect(() => applyCommand(copy, { type: 'duplicate', clipId: 'bottom', newClipId: 'copy' })).toThrow();
  });
  it('moving a primary clip into an overlay repairs boundaries and rejects bad placements atomically', () => {
    let project = layered();
    project.layers[1]!.transform.keyframes = [transformKey(0, { opacity: 0 }), transformKey(100, { opacity: 1 })];
    project.adjustments = [look([point(0, { hue: -90 }), point(100, { hue: 90 })])];
    const transform = structuredClone(project.layers[1]!.transform);
    const adjustments = structuredClone(project.adjustments);
    project = applyCommand(project, { type: 'place', clipId: 'bottom', layerId: 'video-1', start: 0, index: 0 });
    expect(() =>
      applyCommand(project, { type: 'place', clipId: 'bottom', layerId: 'upper', start: 0, index: 0 }),
    ).toThrow();
    expect(project.clips[0]?.layerId).toBe('video-1');
    project = applyCommand(project, { type: 'place', clipId: 'top', layerId: 'upper', start: 150, index: 1 });
    expect(calculateLayout(project).duration).toBe(250);
    expect(project.layers[1]!.transform).toEqual(transform);
    expect(project.adjustments).toEqual(adjustments);
    expect(sampleTimeline(project, 150)[0]).toMatchObject({
      clipId: 'top',
      sourceFrame: 0,
      opacity: 1,
      colour: { hue: 90 },
    });
  });
  it.each([-1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid placement index %s without mutating the committed clips',
    (index) => {
      const project = layered();
      const before = JSON.stringify(project);
      expect(() =>
        applyCommand(project, { type: 'place', clipId: 'top', layerId: 'video-1', start: 0, index }),
      ).toThrow('Invalid placement index');
      expect(JSON.stringify(project)).toBe(before);
    },
  );
  it('rejects deleting an unknown layer without touching existing layers or clips', () => {
    const project = layered();
    const before = JSON.stringify(project);
    expect(() => applyCommand(project, { type: 'layer-remove', layerId: 'missing' })).toThrow('Track no longer exists');
    expect(JSON.stringify(project)).toBe(before);
  });
});
describe('project-frame adjustment and Transform settings', () => {
  it('evaluates hold/easing with deterministic endpoints', () => {
    for (const interpolation of ['hold', 'linear', 'ease-in', 'ease-out', 'smooth'] as const) {
      const item = {
        keyframes: [
          point(0, { exposure: 0 }, interpolation),
          point(25, { hue: 90 }, 'hold'),
          point(100, { exposure: 1 }, interpolation),
        ],
      };
      expect(evaluateLayerSetting(item, 'exposure', -10, 1)).toBe(0);
      expect(evaluateLayerSetting(item, 'exposure', 100, 0)).toBe(1);
      expect(evaluateLayerSetting(item, 'exposure', 150, 0)).toBe(1);
      expect(evaluateLayerSetting(item, 'exposure', 50, 1)).toBeCloseTo(
        { hold: 0, linear: 0.5, 'ease-in': 0.25, 'ease-out': 0.75, smooth: 0.5 }[interpolation],
      );
    }
  });
  it('interpolates grading parameters, not independently graded endpoint pixels', () => {
    const item = look([point(0, { exposure: -1, saturation: 0.5 }), point(80, { exposure: 1, saturation: 1.5 })]);
    expect(adjustmentColour({ adjustments: [item] }, 40)).toEqual(NEUTRAL_COLOUR);
  });
  it('keeps the static Colour and unkeyed settings independent of keyed ones', () => {
    const layer = createLayer('video-1', 'Track 1');
    layer.transform.base.opacity = 0.7;
    const item = look([], {
      ...NEUTRAL_COLOUR,
      temperature: 0.2,
      tint: -0.3,
      exposure: 0.7,
      brightness: 0.09,
      contrast: 0.8,
      hue: 30,
      saturation: 0.65,
      highlights: 0.25,
      shadows: -0.2,
    });
    for (const frame of [-10, 0, 50, 500]) {
      expect(adjustmentColourAt(item, frame)).toEqual(item.colour);
      expect(opacityAt(layer, frame)).toBe(0.7);
    }
    item.keyframes = [point(0, { exposure: -1 }), point(25, { hue: 90 }, 'hold'), point(100, { exposure: 1 })];
    layer.transform.keyframes = [transformKey(0, { opacity: 0 }), transformKey(100, { opacity: 1 })];
    expect(adjustmentColourAt(item, 50)).toEqual({ ...item.colour, exposure: 0, hue: 90 });
    expect(opacityAt(layer, 50)).toBe(0.5);
    expect(layer.transform.base.opacity).toBe(0.7);
    expect(item.colour.exposure).toBe(0.7);
    expect(item.colour.hue).toBe(30);
  });
  it('Opacity and Colour keyframes survive trim/restoration/split at their absolute project frames', () => {
    let project = applyCommand(createProject('p', 'P'), {
      type: 'insert',
      clip: createClip('a', 'source', 0, 100),
      index: 0,
    });
    project = applyCommand(project, { type: 'adjustment-add', adjustmentId: 'look', start: 0, duration: 1_000 });
    project = applyCommand(project, {
      type: 'colour',
      adjustmentId: 'look',
      colour: { ...NEUTRAL_COLOUR, brightness: 0.1 },
    });
    project = applyCommand(project, {
      type: 'transform',
      layerId: 'video-1',
      transform: {
        ...project.layers[0]!.transform,
        keyframes: [transformKey(10, { opacity: 0 }), transformKey(80, { opacity: 1 }, 'smooth')],
      },
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 10,
      setting: 'exposure',
      value: -0.5,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 80,
      setting: 'exposure',
      value: 0.5,
    });
    project = applyCommand(project, {
      type: 'layer-key-easing',
      adjustmentId: 'look',
      frame: 80,
      setting: null,
      interpolation: 'smooth',
    });
    const original = project;
    const transform = structuredClone(project.layers[0]!.transform);
    const adjustments = structuredClone(project.adjustments);
    project = applyCommand(project, { type: 'trim', clipId: 'a', sourceIn: 30, sourceOut: 90 });
    expect(project.layers[0]!.transform).toEqual(transform);
    expect(project.adjustments).toEqual(adjustments);
    expect(calculateLayout(project).duration).toBe(60);
    project = applyCommand(project, { type: 'trim', clipId: 'a', sourceIn: 0, sourceOut: 100 });
    expect(project).toEqual(original);
    project = applyCommand(project, { type: 'split', clipId: 'a', sourceFrame: 50, newClipId: 'b' });
    expect(project.layers[0]!.transform).toEqual(transform);
    expect(project.adjustments).toEqual(adjustments);
    expect(project.clips[1]!.speed).toEqual(project.clips[0]!.speed);
    expect(project.clips.every((clip) => !('animation' in clip))).toBe(true);
    const layout = calculateLayout(project);
    expect(layout.clips.map(({ start, duration, end }) => ({ start, duration, end }))).toEqual([
      { start: 0, duration: 50, end: 50 },
      { start: 50, duration: 50, end: 100 },
    ]);
    expect(layout.clips[1]!.retiming.sourceAt(0)).toBe(50);
    expect(layout.clips[1]!.duration).toBeGreaterThan(0);
    expect(sampleTimeline(project, 75)[0]).toEqual({ ...sampleTimeline(original, 75)[0]!, clipId: 'b' });
  });
  it('keeps track keyframes in project time, rejects keyframe collisions and validates source ranges separately', () => {
    const project = layered();
    project.layers[1]!.transform.keyframes = [
      transformKey(0, { opacity: 0 }),
      transformKey(100, { opacity: 1 }),
      transformKey(150, { rotation: 7 }),
    ];
    expect(sampleTimeline(project, 50)[1]?.opacity).toBe(0.5);
    const before = JSON.stringify(project);
    const upper = project.layers[1]!;
    expect(() =>
      applyCommand(project, {
        type: 'layer-update',
        layer: {
          ...upper,
          transform: {
            ...upper.transform,
            keyframes: [transformKey(10, { opacity: 0 }), transformKey(10, { rotation: 90 })],
          },
        },
      }),
    ).toThrow();
    expect(JSON.stringify(project)).toBe(before);
    expect(projectSchema.parse(project).layers[1]!.transform.keyframes.at(-1)!.frame).toBe(150);
    expect(() =>
      validateSourceRanges(
        project,
        new Map([
          ['red', 100],
          ['blue', 100],
        ]),
      ),
    ).not.toThrow();
    project.clips[1]!.sourceOut = 101;
    expect(() =>
      validateSourceRanges(
        project,
        new Map([
          ['red', 100],
          ['blue', 100],
        ]),
      ),
    ).toThrow('Source range');
  });
  it('moves, eases, edits and removes an entire adjustment keyframe atomically without merging other settings', () => {
    const project = layered();
    project.adjustments = [
      look([point(10, { exposure: 1, contrast: 1.4, saturation: 0.6 }, 'smooth'), point(20, { hue: 45 }, 'hold')]),
    ];
    const keys = project.adjustments[0]!.keyframes;
    const history = new EditHistory(project);
    expect(() => history.commit({ type: 'layer-key-move', adjustmentId: 'look', frame: 10, nextFrame: 20 })).toThrow(
      'destination frame',
    );
    expect(history.current).toEqual(project);
    expect(history.canUndo).toBe(false);
    history.commit({ type: 'layer-key-move', adjustmentId: 'look', frame: 10, nextFrame: 30 });
    expect(history.current.adjustments[0]!.keyframes).toEqual([keys[1], { ...keys[0]!, frame: 30 }]);
    history.commit({
      type: 'layer-key-easing',
      adjustmentId: 'look',
      frame: 30,
      setting: null,
      interpolation: 'ease-out',
    });
    history.commit({ type: 'layer-key-value', adjustmentId: 'look', frame: 30, setting: 'exposure', value: -1 });
    const edited = point(30, { exposure: -1, contrast: 1.4, saturation: 0.6 }, 'ease-out');
    expect(history.current.adjustments[0]!.keyframes[1]).toEqual(edited);
    expect(keySettings(gradeKeyAsLayerKey(history.current.adjustments[0]!.keyframes[1]!))).toEqual([
      'exposure',
      'contrast',
      'saturation',
    ]);
    history.commit({ type: 'layer-key-remove', adjustmentId: 'look', frame: 30 });
    expect(history.current.adjustments[0]!.keyframes).toEqual([keys[1]]);
    expect(history.undo().adjustments[0]!.keyframes[1]).toEqual(edited);
    expect(keys[0]).toEqual(point(10, { exposure: 1, contrast: 1.4, saturation: 0.6 }, 'smooth'));
  });
});
