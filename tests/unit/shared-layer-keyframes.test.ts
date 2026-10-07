import { describe, expect, it } from 'vitest';
import { gradePixel, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { colourAt, compositePixel, opacityAt } from '../../src/shared/composition.js';
import {
  activeLayerSetting,
  EMPTY_KEY_VALUES,
  evaluateLayerSetting,
  hasLayerKeys,
  KEYFRAME_SETTINGS,
  keySettings,
  layerKeyframeSchema,
  type Interpolation,
  type KeyframeSetting,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { compileLayerRetiming } from '../../src/shared/layer-retiming.js';
import {
  BASE_LAYER_ID,
  clipSchema,
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type ProjectDocument,
  type VideoLayer,
} from '../../src/shared/model.js';
import { trimByOutputFrames, trimOnTimeline, validateSourceRanges } from '../../src/shared/source-range.js';
import { clipDuration, compileRetiming, speedSchema } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { unsupportedProject } from './project-fixtures.js';

const curves: Interpolation[] = ['hold', 'linear', 'ease-in', 'ease-out', 'smooth'];
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function row(keyframes: LayerKeyframe[] = []): VideoLayer {
  return { ...createLayer(BASE_LAYER_ID, 'Video 1'), keyframes };
}
function sequence(keyframes: LayerKeyframe[] = [], lengths = [120, 100]): ProjectDocument {
  let project = createProject('shared', 'Shared row');
  project.layers[0]!.keyframes = keyframes;
  for (const [index, length] of lengths.entries())
    project = applyCommand(project, {
      type: 'insert',
      clip: createClip(`clip-${index}`, `source-${index}`, 0, length),
      index,
    });
  return project;
}
function overlay(
  keyframes = [point(0, { speed: 1 }), point(100, { speed: 3 })],
  start = 50,
  sourceIn = 10,
  sourceOut = 85,
): ProjectDocument {
  const project = applyCommand(createProject('overlay', 'Overlay row'), {
    type: 'layer-add',
    layer: { ...createLayer('upper', 'Video 2', false), keyframes },
  });
  return applyCommand(project, {
    type: 'insert',
    clip: {
      ...createClip('top', 'source', sourceIn, sourceOut),
      layerId: 'upper',
      start,
      speed: { mode: 'constant', rate: 4 },
    },
    index: 0,
  });
}
const changingRate = (): LayerKeyframe[] => [point(0, { speed: 1 }, 'hold'), point(100, { speed: 2 })];
const primitive: Record<Interpolation, (u: number) => number> = {
  hold: () => 0,
  linear: (u) => (u * u) / 2,
  'ease-in': (u) => (u * u * u) / 3,
  'ease-out': (u) => u * u - (u * u * u) / 3,
  smooth: (u) => u * u * u - (u * u * u * u) / 2,
};

describe('strict schema-9 row points and independently participating settings', () => {
  it('exports an ordered immutable nine-setting catalogue and explicit all-null template', () => {
    const settings = [
      'opacity',
      'speed',
      'exposure',
      'brightness',
      'contrast',
      'hue',
      'saturation',
      'highlights',
      'shadows',
    ];
    expect(KEYFRAME_SETTINGS.map((setting) => setting.key)).toEqual(settings);
    expect(Object.keys(EMPTY_KEY_VALUES)).toEqual(settings);
    expect(Object.values(EMPTY_KEY_VALUES)).toEqual(Array(9).fill(null));
    expect(Object.isFrozen(EMPTY_KEY_VALUES)).toBe(true);
    expect(Object.isFrozen(KEYFRAME_SETTINGS)).toBe(true);
    expect(KEYFRAME_SETTINGS.every(Object.isFrozen)).toBe(true);
  });

  it('requires version 9, explicit media membership, row opacity and clip settings without legacy fields', () => {
    const project = createProject('strict', 'Strict');
    const clip = createClip('one', 'source', 0, 20);
    expect(project.schemaVersion).toBe(9);
    expect(project.media).toEqual({ videoIds: [], audioIds: [] });
    expect(project.layers[0]).toEqual(row());
    expect(Object.keys(clip)).toEqual([
      'id',
      'mediaId',
      'layerId',
      'start',
      'sourceIn',
      'sourceOut',
      'colour',
      'speed',
      'spatial',
    ]);
    expect(projectSchema.safeParse({ ...project, schemaVersion: 7 }).success).toBe(false);
    expect(project.layers[0]!.opacity).toBe(1);
    expect(clip).not.toHaveProperty('opacity');
    const { opacity: _opacity, ...withoutOpacity } = row();
    expect(projectSchema.safeParse({ ...project, layers: [withoutOpacity] }).success).toBe(false);
    for (const opacity of [null, undefined, -0.1, 1.1, NaN, Infinity])
      expect(projectSchema.safeParse({ ...project, layers: [{ ...row(), opacity }] }).success).toBe(false);
    for (const opacity of [0, 0.23456789, 1]) {
      expect(projectSchema.parse({ ...project, layers: [{ ...row(), opacity }] }).layers[0]!.opacity).toBe(opacity);
      expect(clipSchema.safeParse({ ...clip, opacity }).success).toBe(false);
    }
    expect(projectSchema.safeParse(unsupportedProject(4, 'old', 'Unsupported row')).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, media: undefined }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, layers: [{ ...row(), opacityKeys: [] }] }).success).toBe(false);
    const { keyframes: _keys, ...incomplete } = row();
    expect(projectSchema.safeParse({ ...project, layers: [incomplete] }).success).toBe(false);
    expect(clipSchema.safeParse({ ...clip, animation: { opacity: [], colour: [] } }).success).toBe(false);
    expect(
      speedSchema.safeParse({ mode: 'keyframes', keys: [{ frame: 0, value: 1, interpolation: 'linear' }] }).success,
    ).toBe(false);
  });

  it('rejects empty points, missing/extra values, noninteger times and unknown easing', () => {
    expect(layerKeyframeSchema.safeParse(point(0, {})).success).toBe(false);
    for (const removed of ['layerOpacity', 'clipOpacity'])
      for (const value of [null, 0, 1]) {
        const current = point(0, { opacity: 0 });
        expect(
          layerKeyframeSchema.safeParse({ ...current, values: { ...current.values, [removed]: value } }).success,
        ).toBe(false);
        const { opacity: _opacity, ...otherValues } = current.values;
        expect(
          layerKeyframeSchema.safeParse({ ...current, values: { ...otherValues, [removed]: value } }).success,
        ).toBe(false);
      }
    const { speed: _speed, ...incomplete } = point(0, { exposure: 0 }).values;
    expect(layerKeyframeSchema.safeParse({ ...point(0, { exposure: 0 }), values: incomplete }).success).toBe(false);
    expect(
      layerKeyframeSchema.safeParse({
        ...point(0, { exposure: 0 }),
        values: { ...EMPTY_KEY_VALUES, exposure: 0, extra: 1 },
      }).success,
    ).toBe(false);
    for (const frame of [-1, 0.5, NaN, Infinity, 2_147_483_648])
      expect(layerKeyframeSchema.safeParse(point(frame, { exposure: 0 })).success).toBe(false);
    expect(layerKeyframeSchema.safeParse({ ...point(0, { exposure: 0 }), interpolation: 'cubic' }).success).toBe(false);
    expect(layerKeyframeSchema.parse(point(0, { opacity: 0, exposure: 0 }))).toEqual(
      point(0, { opacity: 0, exposure: 0 }),
    );
  });

  it.each(KEYFRAME_SETTINGS)('validates $key independently against its exact bounds', ({ key, min, max, step }) => {
    for (const value of [min, max])
      expect(layerKeyframeSchema.safeParse(point(0, { [key]: value })).success).toBe(true);
    for (const value of [min - step, max + step, NaN, Infinity, -Infinity])
      expect(layerKeyframeSchema.safeParse(point(0, { [key]: value })).success).toBe(false);
  });

  it('enforces ascending unique points and a 256-point maximum, including empty rows', () => {
    const project = createProject('limit', 'Limit');
    const keys = Array.from({ length: 256 }, (_, frame) => point(frame, { opacity: 0.5 }));
    expect(projectSchema.parse({ ...project, layers: [row(keys)] }).layers[0]!.keyframes).toHaveLength(256);
    expect(projectSchema.safeParse({ ...project, layers: [row([...keys, point(256, { hue: 10 })])] }).success).toBe(
      false,
    );
    expect(
      projectSchema.safeParse({ ...project, layers: [row([point(1, { exposure: 0 }), point(1, { saturation: 1 })])] })
        .success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({ ...project, layers: [row([point(2, { exposure: 0 }), point(1, { saturation: 1 })])] })
        .success,
    ).toBe(false);
    const history = new EditHistory({ ...project, layers: [row(keys)] });
    history.commit({ type: 'layer-key-toggle', layerId: BASE_LAYER_ID, frame: 100, setting: 'hue', value: 90 });
    expect(history.current.layers[0]!.keyframes).toHaveLength(256);
    const before = history.current;
    expect(() =>
      history.commit({ type: 'layer-key-toggle', layerId: BASE_LAYER_ID, frame: 256, setting: 'hue', value: 90 }),
    ).toThrow();
    expect(history.current).toEqual(before);
  });

  it('merges a point, removes only the exact property, and drops its last participant', () => {
    let project = createProject('toggle', 'Toggle');
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: BASE_LAYER_ID,
      frame: 20,
      setting: 'exposure',
      value: 0,
    });
    project = applyCommand(project, {
      type: 'layer-key-easing',
      layerId: BASE_LAYER_ID,
      frame: 20,
      interpolation: 'smooth',
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: BASE_LAYER_ID,
      frame: 20,
      setting: 'opacity',
      value: 0.4,
    });
    const layer = project.layers[0]!;
    expect(layer.keyframes).toEqual([point(20, { exposure: 0, opacity: 0.4 }, 'smooth')]);
    expect(keySettings(layer.keyframes[0]!)).toEqual(['opacity', 'exposure']);
    expect(hasLayerKeys(layer, 'opacity')).toBe(true);
    expect(hasLayerKeys(layer, 'brightness')).toBe(false);
    expect(activeLayerSetting(layer, 'opacity', 20)).toBe(true);
    expect(activeLayerSetting(layer, 'opacity', 19)).toBe(false);
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: BASE_LAYER_ID,
      frame: 20,
      setting: 'exposure',
      value: 1,
    });
    expect(project.layers[0]!.keyframes).toEqual([point(20, { opacity: 0.4 }, 'smooth')]);
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: BASE_LAYER_ID,
      frame: 20,
      setting: 'opacity',
      value: 0.4,
    });
    expect(project.layers[0]!.keyframes).toEqual([]);
  });

  it('can independently toggle all nine participants at one frame', () => {
    let project = createProject('nine', 'Nine');
    for (const setting of KEYFRAME_SETTINGS)
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        layerId: BASE_LAYER_ID,
        frame: 5,
        setting: setting.key,
        value: setting.min,
      });
    expect(project.layers[0]!.keyframes).toHaveLength(1);
    expect(keySettings(project.layers[0]!.keyframes[0]!)).toEqual(KEYFRAME_SETTINGS.map((setting) => setting.key));
    for (const setting of KEYFRAME_SETTINGS)
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        layerId: BASE_LAYER_ID,
        frame: 5,
        setting: setting.key,
        value: setting.min,
      });
    expect(project.layers[0]!.keyframes).toEqual([]);
  });

  it('updates only existing participants and validates removals without implicit keys', () => {
    const project = {
      ...createProject('values', 'Values'),
      layers: [row([point(10, { exposure: 1, opacity: 0.5 }, 'hold')])],
    };
    const changed = applyCommand(project, {
      type: 'layer-key-value',
      layerId: BASE_LAYER_ID,
      frame: 10,
      setting: 'exposure',
      value: -1,
    });
    expect(changed.layers[0]!.keyframes).toEqual([point(10, { exposure: -1, opacity: 0.5 }, 'hold')]);
    expect(project.layers[0]!.keyframes[0]!.values.exposure).toBe(1);
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-value',
        layerId: BASE_LAYER_ID,
        frame: 10,
        setting: 'brightness',
        value: 0.1,
      }),
    ).toThrow('does not participate');
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-value',
        layerId: BASE_LAYER_ID,
        frame: 11,
        setting: 'exposure',
        value: 0,
      }),
    ).toThrow('does not participate');
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-toggle',
        layerId: BASE_LAYER_ID,
        frame: 10,
        setting: 'exposure',
        value: 4,
      }),
    ).toThrow();
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-toggle',
        layerId: BASE_LAYER_ID,
        frame: -1,
        setting: 'exposure',
        value: 0,
      }),
    ).toThrow();
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-toggle',
        layerId: BASE_LAYER_ID,
        frame: 10,
        setting: 'toString' as KeyframeSetting,
        value: 0,
      }),
    ).toThrow('Unknown keyframe setting');
    expect(() =>
      applyCommand(project, {
        type: 'animation',
        clipId: 'old',
        property: 'opacity',
        key: { frame: 0, value: 1 },
      } as unknown as EditCommand),
    ).toThrow();
  });

  it('moves all values/easing atomically and rejects collisions without changing undo/redo', () => {
    const document = {
      ...createProject('move', 'Move'),
      layers: [
        row([point(10, { opacity: 0.7, speed: 2, exposure: 1, hue: 90 }, 'ease-in'), point(20, { shadows: 0.5 })]),
      ],
    };
    const history = new EditHistory(document);
    history.commit({ type: 'layer-key-move', layerId: BASE_LAYER_ID, frame: 10, nextFrame: 30 });
    expect(history.current.layers[0]!.keyframes).toEqual([
      document.layers[0]!.keyframes[1],
      { ...document.layers[0]!.keyframes[0]!, frame: 30 },
    ]);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(() => history.commit({ type: 'layer-key-move', layerId: BASE_LAYER_ID, frame: 10, nextFrame: 20 })).toThrow(
      'destination frame',
    );
    expect(history.current).toEqual(document);
    expect(history.canRedo).toBe(true);
    expect(history.redo().layers[0]!.keyframes.at(-1)!.interpolation).toBe('ease-in');
    const before = history.current;
    history.commit({ type: 'layer-key-remove', layerId: BASE_LAYER_ID, frame: 30 });
    expect(history.current.layers[0]!.keyframes).toHaveLength(1);
    expect(history.undo()).toEqual(before);
    expect(document.layers[0]!.keyframes[0]!.frame).toBe(10);
  });

  it('rejects timing-invalid speed edits atomically and leaves no history entry', () => {
    const document = applyCommand(sequence([], [100]), {
      type: 'fades',
      layerId: BASE_LAYER_ID,
      opening: 80,
      closing: 0,
    });
    const history = new EditHistory(document);
    expect(() =>
      history.commit({ type: 'layer-key-toggle', layerId: BASE_LAYER_ID, frame: 0, setting: 'speed', value: 8 }),
    ).toThrow('regions overlap');
    expect(history.current).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(() => history.commit({ type: 'layer-key-remove', layerId: BASE_LAYER_ID, frame: 100 })).toThrow(
      'no longer exists',
    );
    expect(() =>
      history.commit({ type: 'layer-key-toggle', layerId: 'missing', frame: 0, setting: 'speed', value: 1 }),
    ).toThrow('Layer no longer exists');
  });
});

describe('independent row interpolation and unchanged CPU composition', () => {
  it.each(curves)('uses only participating points and the shared left easing: %s', (interpolation) => {
    const layer = row([
      point(10, { exposure: -1 }, interpolation),
      point(30, { hue: 90 }, 'hold'),
      point(110, { exposure: 1 }),
    ]);
    const middle: Record<Interpolation, number> = { hold: -1, linear: 0, 'ease-in': -0.5, 'ease-out': 0.5, smooth: 0 };
    expect(evaluateLayerSetting(layer, 'exposure', 60, 2)).toBeCloseTo(middle[interpolation]);
    expect(evaluateLayerSetting(layer, 'exposure', -10, 2)).toBe(-1);
    expect(evaluateLayerSetting(layer, 'exposure', 110, 2)).toBe(1);
    expect(evaluateLayerSetting(layer, 'exposure', 200, 2)).toBe(1);
    expect(evaluateLayerSetting(layer, 'hue', 10, 0)).toBe(90);
    expect(evaluateLayerSetting(layer, 'brightness', 60, 0.2)).toBe(0.2);
  });

  it('interpolates each grading parameter rather than endpoint pixels or whole grades', () => {
    const clip = createClip('colour', 'source', 0, 100);
    clip.colour = { ...NEUTRAL_COLOUR, brightness: 0.12, hue: 30, contrast: 1.2 };
    const layer = row([
      point(0, { exposure: -1, saturation: 0.5 }),
      point(50, { shadows: -0.4 }, 'hold'),
      point(100, { exposure: 1, saturation: 1.5 }),
    ]);
    const middle = colourAt(clip, layer, 50);
    expect(middle).toEqual({ ...clip.colour, exposure: 0, saturation: 1, shadows: -0.4 });
    expect(clip.colour.shadows).toBe(0);
    const pixel = gradePixel([0.4, 0.3, 0.2], middle);
    const first = gradePixel([0.4, 0.3, 0.2], colourAt(clip, layer, 0));
    const last = gradePixel([0.4, 0.3, 0.2], colourAt(clip, layer, 100));
    expect(pixel[0]).not.toBeCloseTo((first[0] + last[0]) / 2, 5);
  });

  it('overrides row opacity uniformly while unkeyed colour keeps independent clip fallbacks', () => {
    let project = sequence([point(0, { exposure: -1, opacity: 0.4 }), point(100, { exposure: 1 })], [100, 100]);
    project = applyCommand(project, {
      type: 'colour',
      clipId: 'clip-0',
      colour: { ...NEUTRAL_COLOUR, brightness: 0.1 },
    });
    project = applyCommand(project, {
      type: 'colour',
      clipId: 'clip-1',
      colour: { ...NEUTRAL_COLOUR, brightness: -0.1, saturation: 1.4 },
    });
    project = applyCommand(project, { type: 'opacity', layerId: BASE_LAYER_ID, opacity: 0.9 });
    project = applyCommand(project, {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 20 },
    });
    const samples = sampleTimeline(project, 90);
    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.sourceFrame)).toEqual([90, 10]);
    expect(samples.map((sample) => sample.colour.exposure)).toEqual([0.8, 0.8]);
    expect(samples.map((sample) => sample.colour.brightness)).toEqual([0.1, -0.1]);
    expect(samples.map((sample) => sample.colour.saturation)).toEqual([1, 1.4]);
    expect(samples.map((sample) => sample.opacity)).toEqual([0.4, 0.4]);
    const staticLayer = { ...row(), opacity: 0.9 };
    expect(colourAt(project.clips[1]!, staticLayer, 90)).toEqual(project.clips[1]!.colour);
    expect(opacityAt(staticLayer, 90)).toBe(0.9);
    expect(project.layers[0]!.opacity).toBe(0.9);
    expect(project.clips.every((clip) => !('opacity' in clip))).toBe(true);
  });

  it('uses uniform row coverage during a dissolve without a second multiplier and restores the row setting', () => {
    const project = applyCommand(sequence([], [100, 100]), {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 20 },
    });
    project.layers[0]!.opacity = 0.6;
    const sourcePixel = (sample: ReturnType<typeof sampleTimeline>[number]): [number, number, number] =>
      sample.clipId === 'clip-0' ? [1, 0, 0] : [0, 0, 1];
    const pixel = compositePixel(sampleTimeline(project, 90), sourcePixel);
    expect(pixel[0]).toBeCloseTo(0.3);
    expect(pixel[1]).toBeCloseTo(0);
    expect(pixel[2]).toBeCloseTo(0.3);
    expect(sampleTimeline(project, 90).map((sample) => sample.opacity)).toEqual([0.6, 0.6]);
    project.layers[0]!.keyframes = [point(0, { opacity: 0.4 })];
    expect(sampleTimeline(project, 90).map((sample) => sample.opacity)).toEqual([0.4, 0.4]);
    const overridden = compositePixel(sampleTimeline(project, 90), sourcePixel);
    expect(overridden[0]).toBeCloseTo(0.2);
    expect(overridden[1]).toBeCloseTo(0);
    expect(overridden[2]).toBeCloseTo(0.2);
    project.layers[0]!.keyframes = [];
    expect(sampleTimeline(project, 90).map((sample) => sample.opacity)).toEqual([0.6, 0.6]);
    project.layers[0]!.enabled = false;
    expect(sampleTimeline(project, 90)).toEqual([]);
    expect(calculateLayout(project).duration).toBe(180);
  });
});

describe('analytic project-frame row rate maps', () => {
  it.each(curves)('integrates the %s polynomial analytically with one duration rounding', (interpolation) => {
    const length = Math.round(100 + 200 * primitive[interpolation](1));
    const clip = createClip('curve', 'source', 10, 10 + length);
    const layer = row([
      point(0, { speed: 1 }, interpolation),
      point(25, { exposure: 1 }, 'hold'),
      point(100, { speed: 3 }),
    ]);
    const map = compileLayerRetiming(clip, layer, 0);
    expect(map.duration).toBe(100);
    for (const frame of [0, 1, 25, 50, 75, 99]) {
      const source = 10 + Math.floor(frame + 200 * primitive[interpolation](frame / 100) + 1e-8);
      expect(map.sourceAt(frame)).toBe(source);
      expect(Number.isInteger(map.sourceAt(frame))).toBe(true);
    }
    expect(map.rateAt(50)).toBe({ hold: 1, linear: 2, 'ease-in': 1.5, 'ease-out': 2.5, smooth: 2 }[interpolation]);
    expect(map.rateAt(100)).toBe(3);
    expect(map.outputAt(clip.sourceIn - 10)).toBe(0);
    expect(map.outputAt(clip.sourceOut)).toBe(map.duration - 1);
  });

  it.each(curves)('integrates partial %s intervals at an offset absolute start', (interpolation) => {
    const initialProgress = 0.15;
    const length = Math.round(
      0.5 * 85 + 250 * (primitive[interpolation](1) - primitive[interpolation](initialProgress)),
    );
    const clip = createClip('partial', 'source', 17, 17 + length);
    const map = compileLayerRetiming(
      clip,
      row([point(20, { speed: 0.5 }, interpolation), point(120, { speed: 3 })]),
      35,
    );
    expect(map.duration).toBe(85);
    for (const output of [0, 1, 5, 25, 50, 84]) {
      const consumed =
        0.5 * output +
        250 * (primitive[interpolation]((15 + output) / 100) - primitive[interpolation](initialProgress));
      expect(map.sourceAt(output)).toBe(17 + Math.floor(consumed + 1e-8));
      expect(map.outputAt(map.sourceAt(output))).toBeLessThanOrEqual(output);
    }
    expect(map.rateAt(85)).toBe(3);
  });

  it('does not rescale key times/rates when consuming source from another absolute start', () => {
    const clip = createClip('offset', 'source', 7, 82);
    const layer = row([point(0, { speed: 1 }), point(100, { speed: 3 })]);
    const map = compileLayerRetiming(clip, layer, 50);
    expect(map.duration).toBe(Math.round((-2 + Math.sqrt(7)) / 0.02));
    expect(map.duration).toBe(32);
    expect(map.rateAt(0)).toBe(2);
    expect(map.rateAt(25)).toBe(2.5);
    expect(map.sourceAt(25)).toBe(63);
    expect(map.outputAt(28)).toBe(10);
    expect(map.sourceAt(-100)).toBe(7);
    expect(map.sourceAt(map.duration)).toBe(81);
    expect(map.sourceAt(1_000)).toBe(81);
    const another = {
      ...clip,
      speed: {
        mode: 'ramp' as const,
        startRate: 0.1,
        endRate: 8,
        curve: 'smooth' as const,
        anchorIn: 0,
        anchorOut: 100,
      },
    };
    expect(compileLayerRetiming(another, layer, 50)).toBe(map);
  });

  it('keeps first/last participating rates and exact discontinuities in hold curves', () => {
    const layer = row([point(0, { hue: 20 }), point(20, { speed: 0.5 }), point(80, { speed: 2 })]);
    const first = compileLayerRetiming(createClip('first', 'source', 0, 50), layer, 0);
    expect(first.duration).toBe(60);
    expect(first.rateAt(10)).toBe(0.5);
    expect(first.rateAt(20)).toBe(0.5);
    expect(first.rateAt(60)).toBe(1.5);
    expect(compileLayerRetiming(createClip('last', 'source', 0, 50), layer, 100).duration).toBe(25);
    const holdLayer = row([point(0, { speed: 0.5 }, 'hold'), point(40, { speed: 2 }, 'hold'), point(90, { speed: 1 })]);
    const map = compileLayerRetiming(createClip('hold', 'source', 0, 100), holdLayer, 0);
    expect(map.duration).toBe(80);
    expect([39, 40, 50].map(map.sourceAt)).toEqual([19, 20, 40]);
    expect(map.rateAt(40)).toBe(2);
    const shifted = compileLayerRetiming(createClip('hold', 'source', 0, 100), holdLayer, 60);
    expect(shifted.duration).toBe(70);
    expect(shifted.rateAt(30)).toBe(1);
  });

  it('repeats/drops discrete original frames without rounding the authored row rate', () => {
    const clip = createClip('discrete', 'source', 10, 22);
    const slow = compileLayerRetiming(clip, row([point(0, { speed: 0.5 })]), 0);
    const fast = compileLayerRetiming(clip, row([point(0, { speed: 2 })]), 0);
    expect(slow.duration).toBe(24);
    expect([0, 1, 2, 23].map(slow.sourceAt)).toEqual([10, 10, 11, 21]);
    expect(fast.duration).toBe(6);
    expect([0, 1, 5].map(fast.sourceAt)).toEqual([10, 12, 20]);
    const short = compileLayerRetiming(createClip('short', 'source', 0, 15), row([point(0, { speed: 8 })]), 0);
    expect(short.duration).toBe(2);
    expect(short.sourceAt(1)).toBe(8);
    expect(short.rateAt(1)).toBe(8);
    expect(short.outputAt(8)).toBe(1);
  });

  it('uses the existing static constant/ramp compiler when no row speed participates', () => {
    const clip = {
      ...createClip('base', 'source', 10, 100),
      speed: {
        mode: 'ramp' as const,
        startRate: 0.5,
        endRate: 2,
        curve: 'smooth' as const,
        anchorIn: 0,
        anchorOut: 120,
      },
    };
    const layer = row([point(50, { exposure: 1 })]);
    expect(compileLayerRetiming(clip, layer, 25)).toBe(compileRetiming(clip));
    expect(compileLayerRetiming(clip, layer, 100).duration).toBe(clipDuration(clip));
    const fast = { ...createClip('static', 'source', 10, 610), speed: { mode: 'constant' as const, rate: 2 } };
    expect(trimByOutputFrames(fast, 'out', -30, 700).sourceOut).toBe(550);
    for (const candidate of [clip, fast]) {
      const map = compileLayerRetiming(candidate, layer, 25);
      expect(() => map.sourceAt(NaN)).toThrow('finite');
      expect(() => map.outputAt(Infinity)).toThrow('finite');
      expect(() => map.rateAt(NaN)).toThrow('finite');
    }
  });

  it('subtracts incoming dissolve before compiling, with one row rate at the same project frame', () => {
    const project = applyCommand(sequence(changingRate()), {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 20 },
    });
    const layout = calculateLayout(project);
    expect(layout.clips.map((clip) => [clip.start, clip.duration, clip.end])).toEqual([
      [0, 110, 110],
      [90, 55, 145],
    ]);
    expect(layout.duration).toBe(145);
    expect(sampleTimeline(project, 100, layout).map((sample) => sample.sourceFrame)).toEqual([100, 10]);
    expect(layout.clips.map((clip) => clip.retiming.rateAt(100 - clip.start))).toEqual([2, 2]);
    expect(layout.clips[1]!.retiming.sourceAt(11)).toBe(12);
    project.layers[0]!.enabled = false;
    expect(calculateLayout(project).duration).toBe(145);
    expect(sampleTimeline(project, 100)).toEqual([]);
  });

  it('copies/freezes maps and rate settings and evicts entries beyond 128', () => {
    const layer = row([point(0, { speed: 1 }), point(100, { speed: 3 })]);
    const clip = createClip('snapshot', 'source', 0, 150);
    const map = compileLayerRetiming(clip, layer, 0);
    const before = [map.duration, map.sourceAt(30), map.rateAt(30)];
    layer.keyframes[0]!.values.speed = 7;
    layer.keyframes[1]!.frame = 200;
    clip.sourceOut = 180;
    expect([map.duration, map.sourceAt(30), map.rateAt(30)]).toEqual(before);
    expect(Object.isFrozen(map)).toBe(true);
    const cacheClip = createClip('cache', 'source', 1_000_000, 1_000_010);
    const cacheLayer = row([point(0, { speed: 1.25 })]);
    const first = compileLayerRetiming(cacheClip, cacheLayer, 5_000);
    expect(compileLayerRetiming(cacheClip, cacheLayer, 5_000)).toBe(first);
    for (let index = 1; index <= 128; index++) compileLayerRetiming(cacheClip, cacheLayer, 5_000 + index);
    expect(compileLayerRetiming(cacheClip, cacheLayer, 5_000)).not.toBe(first);
    expect(first.sourceAt(0)).toBe(1_000_000);
  });

  it('handles a two-billion-frame duration without output-frame arrays and bounds the project', () => {
    const layer = row([point(0, { speed: 0.1 })]);
    const map = compileLayerRetiming(createClip('large', 'source', 0, 200_000_000), layer, 0);
    expect(map.duration).toBe(2_000_000_000);
    expect(map.sourceAt(1_999_999_999)).toBe(199_999_999);
    expect(map.outputAt(100_000_000)).toBe(1_000_000_000);
    expect(() => compileLayerRetiming(createClip('too-long', 'source', 0, 300_000_000), layer, 0)).toThrow(
      'supported project frames',
    );
    expect(() => compileLayerRetiming(createClip('too-late', 'source', 0, 10), layer, 2_147_483_640)).toThrow(
      'supported project frames',
    );
    expect(() => compileLayerRetiming(createClip('base-long', 'source', 0, 300_000_000), row(), 0)).not.toThrow();
    const staticSlow = {
      ...createClip('base-long', 'source', 0, 300_000_000),
      speed: { mode: 'constant' as const, rate: 0.1 },
    };
    expect(() => compileLayerRetiming(staticSlow, row(), 0)).toThrow('supported project frames');
  });

  it('rejects invalid starts, rates, points, static settings and nonfinite row-map queries', () => {
    const clip = createClip('invalid', 'source', 0, 20);
    const layer = row([point(0, { speed: 1 })]);
    for (const start of [-1, 0.5, NaN, Infinity, 2_147_483_648])
      expect(() => compileLayerRetiming(clip, layer, start)).toThrow();
    for (const speed of [0, 0.09, 8.01, NaN, Infinity])
      expect(() => compileLayerRetiming(clip, row([point(0, { speed })]), 0)).toThrow();
    expect(() => compileLayerRetiming(clip, row([point(0, {})]), 0)).toThrow();
    expect(() => compileLayerRetiming(clip, row([point(5, { exposure: 1 }), point(0, { speed: 1 })]), 0)).toThrow();
    expect(() =>
      compileLayerRetiming(clip, row(Array.from({ length: 257 }, (_, frame) => point(frame, { speed: 1 }))), 0),
    ).toThrow();
    expect(() => compileLayerRetiming({ ...clip, speed: { mode: 'constant', rate: 0 } }, layer, 0)).toThrow();
    expect(() => compileLayerRetiming({ ...clip, sourceIn: -1 }, layer, 0)).toThrow();
    const map = compileLayerRetiming(clip, layer, 0);
    expect(() => map.sourceAt(NaN)).toThrow('finite');
    expect(() => map.outputAt(Infinity)).toThrow('finite');
    expect(() => map.rateAt(-Infinity)).toThrow('finite');
  });
});

describe('contextual trims, splits, duplicates and fixed row key times', () => {
  it('keeps primary IN start fixed while rippling downstream contextual durations', () => {
    const original = sequence(changingRate());
    const keys = original.layers[0]!.keyframes;
    const command = trimOnTimeline(original, 'clip-0', 'in', 20, 200, 'output');
    expect(command).toEqual({ type: 'trim', clipId: 'clip-0', sourceIn: 30, sourceOut: 120 });
    const project = applyCommand(original, command);
    expect(calculateLayout(project).clips.map((clip) => [clip.start, clip.duration])).toEqual([
      [0, 90],
      [90, 55],
    ]);
    expect(project.layers[0]!.keyframes).toEqual(keys);
    expect(original.clips[0]!.sourceIn).toBe(0);
  });

  it('uses the nearest original endpoint across an entire rounded-duration plateau', () => {
    const original = sequence([point(0, { speed: 8 })], [100]);
    const project = applyCommand(original, { type: 'trim', clipId: 'clip-0', sourceIn: 80, sourceOut: 100 });
    const restored = trimOnTimeline(project, 'clip-0', 'in', -1, 200, 'output');
    expect(restored).toEqual({ type: 'trim', clipId: 'clip-0', sourceIn: 72, sourceOut: 100 });
    const extended = trimOnTimeline(project, 'clip-0', 'out', 1, 200, 'output');
    expect(extended).toEqual({ type: 'trim', clipId: 'clip-0', sourceIn: 80, sourceOut: 108 });
    const placed = calculateLayout(applyCommand(project, restored)).clips[0]!;
    expect(placed.duration).toBe(4);
    expect(placed.retiming.sourceAt(1)).toBe(80);
  });

  it('solves a changing-rate overlay left trim jointly, retaining the exact old right edge', () => {
    const original = overlay();
    const keys = original.layers[1]!.keyframes;
    const command = trimOnTimeline(original, 'top', 'in', 10, 200, 'output');
    // Several source endpoints round to the same duration; retain more footage.
    expect(command).toEqual({ type: 'trim-place', clipId: 'top', sourceIn: 31, sourceOut: 85, start: 60 });
    const project = applyCommand(original, command);
    const placed = calculateLayout(project).clips[0]!;
    expect([placed.start, placed.duration, placed.end]).toEqual([60, 22, 82]);
    expect(project.layers[1]!.keyframes).toEqual(keys);
    expect(trimOnTimeline(original, 'top', 'in', 21, 200, 'source')).toEqual(command);
    const numeric = applyCommand(original, { type: 'trim', clipId: 'top', sourceIn: 32, sourceOut: 85 });
    expect(numeric.clips[0]!.start).toBe(50);
    expect(calculateLayout(numeric).clips[0]!.end).not.toBe(82);
    expect(numeric.layers[1]!.keyframes).toEqual(keys);
  });

  it.each(curves)('keeps overlay OUT fixed through %s rates and source bounds', (interpolation) => {
    const original = overlay([point(0, { speed: 1 }, interpolation), point(100, { speed: 3 })]);
    const right = calculateLayout(original).clips[0]!.end;
    for (const delta of [-20, -5, 5, 20]) {
      const command = trimOnTimeline(original, 'top', 'in', delta, 200, 'output');
      const placed = calculateLayout(applyCommand(original, command)).clips[0]!;
      expect(placed.end).toBe(right);
      expect(placed.start).toBeGreaterThanOrEqual(0);
      expect(placed.clip.sourceIn).toBeGreaterThanOrEqual(0);
      expect(placed.clip.sourceIn).toBeLessThan(85);
    }
  });

  it('clamps overlay restoration at frame zero and right trims at the original recording', () => {
    const original = overlay([point(0, { speed: 0.5 })], 10, 100, 150);
    for (const unit of ['output', 'source'] as const) {
      const command = trimOnTimeline(original, 'top', 'in', -10_000, 200, unit);
      expect(command).toEqual({ type: 'trim-place', clipId: 'top', sourceIn: 95, sourceOut: 150, start: 0 });
      expect(calculateLayout(applyCommand(original, command)).clips[0]!.end).toBe(110);
    }
    const changing = overlay();
    expect(trimOnTimeline(changing, 'top', 'out', 10, 200, 'output')).toEqual({
      type: 'trim',
      clipId: 'top',
      sourceIn: 10,
      sourceOut: 111,
    });
    const restored = applyCommand(changing, trimOnTimeline(changing, 'top', 'out', 10_000, 200, 'output'));
    expect(restored.clips[0]!.sourceOut).toBe(200);
    expect(restored.clips[0]!.start).toBe(50);
    expect(trimOnTimeline(changing, 'top', 'out', 5, 200, 'source')).toEqual({
      type: 'trim',
      clipId: 'top',
      sourceIn: 10,
      sourceOut: 90,
    });
  });

  it('leaves fade/overlay conflict validation to atomic command application', () => {
    const original = applyCommand(sequence([point(0, { speed: 2 })], [100, 100]), {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 20 },
    });
    const history = new EditHistory(original);
    const command = trimOnTimeline(original, 'clip-0', 'out', -40, 200, 'output');
    expect(() => history.commit(command)).toThrow('regions overlap');
    expect(history.current).toEqual(original);
    expect(history.canUndo).toBe(false);
    const first = overlay([point(0, { speed: 2 })], 0, 0, 100);
    const layered = applyCommand(first, {
      type: 'insert',
      clip: { ...createClip('next', 'source', 0, 100), layerId: 'upper', start: 60 },
      index: 1,
    });
    const overlapping = trimOnTimeline(layered, 'top', 'out', 30, 200, 'output');
    expect(() => applyCommand(layered, overlapping)).toThrow('cannot overlap');
    expect(layered.clips[0]!.sourceOut).toBe(100);
  });

  it('rejects unrepresentable source trims rather than moving the retained overlay OUT', () => {
    const original = overlay([point(0, { speed: 8 }, 'hold'), point(40, { speed: 0.1 })], 30, 0, 90);
    expect(calculateLayout(original).clips[0]!.end).toBe(140);
    expect(() => trimOnTimeline(original, 'top', 'in', 1, 100, 'source')).toThrow(
      'cannot keep the positioned clip OUT',
    );
    expect(original.clips[0]).toMatchObject({ start: 30, sourceIn: 0, sourceOut: 90 });
    const byOutput = trimOnTimeline(original, 'top', 'in', 1, 100, 'output');
    expect(byOutput).toEqual({ type: 'trim-place', clipId: 'top', sourceIn: 8, sourceOut: 90, start: 31 });
    expect(calculateLayout(applyCommand(original, byOutput)).clips[0]!.end).toBe(140);
  });

  it('splits at contextual left duration, keeps points on the row, and preserves static settings', () => {
    const original = overlay();
    const keys = original.layers[1]!.keyframes;
    const split = applyCommand(original, { type: 'split', clipId: 'top', sourceFrame: 40, newClipId: 'right' });
    const layout = calculateLayout(split);
    expect(layout.clips.map((clip) => [clip.start, clip.duration, clip.end])).toEqual([
      [50, 14, 64],
      [64, 18, 82],
    ]);
    expect(split.clips.map((clip) => [clip.sourceIn, clip.sourceOut])).toEqual([
      [10, 40],
      [40, 85],
    ]);
    expect(split.clips[1]!.speed).toEqual(original.clips[0]!.speed);
    expect(split.clips[1]!.colour).toEqual(original.clips[0]!.colour);
    expect(split.clips[1]).not.toHaveProperty('animation');
    expect(split.layers[1]!.keyframes).toEqual(keys);
    expect(layout.clips[1]!.retiming.rateAt(0)).toBeCloseTo(2.28);
    const sequenceProject = applyCommand(sequence(changingRate()), {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 10 },
    });
    const divided = applyCommand(sequenceProject, {
      type: 'split',
      clipId: 'clip-0',
      sourceFrame: 90,
      newClipId: 'part',
    });
    expect(
      calculateLayout(divided)
        .clips.slice(0, 2)
        .map((clip) => [clip.start, clip.duration]),
    ).toEqual([
      [0, 90],
      [90, 20],
    ]);
    expect(
      divided.layers[0]!.transitions.map((transition) => [transition.leftId, transition.rightId, transition.type]),
    ).toEqual([
      ['clip-0', 'part', 'cut'],
      ['part', 'clip-1', 'cross-dissolve'],
    ]);
    expect(divided.layers[0]!.keyframes).toEqual(sequenceProject.layers[0]!.keyframes);
  });

  it('rounds split-piece durations independently without silently sliding row points', () => {
    const original = sequence(changingRate(), [120]);
    const split = applyCommand(original, { type: 'split', clipId: 'clip-0', sourceFrame: 115, newClipId: 'part' });
    expect(calculateLayout(original).duration).toBe(110);
    expect(calculateLayout(split).clips.map((clip) => clip.duration)).toEqual([108, 3]);
    expect(calculateLayout(split).duration).toBe(111);
    expect(split.layers[0]!.keyframes).toEqual(original.layers[0]!.keyframes);
  });

  it('duplicates after the contextual end and retimes the copy at its own absolute start', () => {
    const original = overlay();
    const history = new EditHistory(original);
    history.commit({ type: 'duplicate', clipId: 'top', newClipId: 'copy' });
    const layout = calculateLayout(history.current);
    expect(layout.clips.map((clip) => [clip.start, clip.duration, clip.end])).toEqual([
      [50, 32, 82],
      [82, 26, 108],
    ]);
    expect(history.current.clips[1]).toEqual({ ...original.clips[0]!, id: 'copy', start: 82 });
    expect(history.current.layers[1]!.keyframes).toEqual(original.layers[1]!.keyframes);
    expect(history.undo()).toEqual(original);
    const primary = applyCommand(sequence(changingRate(), [120]), {
      type: 'duplicate',
      clipId: 'clip-0',
      newClipId: 'copy',
    });
    expect(calculateLayout(primary).clips.map((clip) => [clip.start, clip.duration])).toEqual([
      [0, 110],
      [110, 60],
    ]);
    expect(primary.layers[0]!.keyframes).toEqual(changingRate());
  });

  it('uses contextual duration for placement and hidden layers, leaving row keys at fixed frames', () => {
    const original = overlay();
    const keys = original.layers[1]!.keyframes;
    const moved = applyCommand(original, { type: 'place', clipId: 'top', layerId: 'upper', start: 100, index: 0 });
    expect(calculateLayout(moved).clips[0]).toMatchObject({ start: 100, duration: 25, end: 125 });
    expect(moved.layers[1]!.keyframes).toEqual(keys);
    moved.layers[1]!.enabled = false;
    expect(calculateLayout(moved).duration).toBe(125);
    expect(sampleTimeline(moved, 110)).toEqual([]);
  });

  it('bounds only original source ranges, not layer key times', () => {
    const project = overlay([point(500_000, { exposure: 1 })]);
    expect(() => validateSourceRanges(project, new Map([['source', 85]]))).not.toThrow();
    expect(() => validateSourceRanges(project, new Map([['source', 84]]))).toThrow('Source range exceeds');
    expect(() => validateSourceRanges(project, new Map([['source', NaN]]))).toThrow('Source range exceeds');
    expect(() => trimOnTimeline(project, 'top', 'in', 0.5, 100, 'output')).toThrow();
    expect(() => trimOnTimeline(project, 'top', 'out', 1, 84, 'output')).toThrow();
    expect(() => trimOnTimeline(project, 'missing', 'in', 1, 100, 'output')).toThrow('Clip no longer exists');
    expect(() => trimOnTimeline(project, 'top', 'in', 1, 100, 'invalid' as 'output')).toThrow('Trim unit');
  });
});
