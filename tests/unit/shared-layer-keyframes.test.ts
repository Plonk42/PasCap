import { describe, expect, it } from 'vitest';
import {
  COLOUR_CONTROLS,
  createColourSettings,
  gradePixel,
  NEUTRAL_COLOUR,
  type ColourSettings,
  type ScalarColourSetting,
} from '../../src/shared/colour.js';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { adjustmentColour, compositePixel, opacityAt } from '../../src/shared/composition.js';
import {
  adjustmentColourAt,
  createAdjustment,
  gradeKeyAsLayerKey,
  layerKeyAsGradeKey,
  MAX_GRADE_KEYFRAMES,
  type Adjustment,
  type GradeKeyframe,
  type GradeKeyValues,
} from '../../src/shared/grade.js';
import {
  activeLayerSetting,
  EMPTY_KEY_VALUES,
  evaluateLayerSetting,
  hasLayerKeys,
  KEYFRAME_SETTINGS,
  keySettings,
  layerKeyframeSchema,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
  layerKeyframe,
  uniformKeyframe,
} from '../../src/shared/keyframes.js';
import {
  BASE_LAYER_ID,
  clipSchema,
  createClip,
  createLayer,
  createProject,
  PROJECT_SCHEMA_VERSION,
  projectSchema,
  type ProjectDocument,
  type VideoLayer,
} from '../../src/shared/model.js';
import { trimOnTimeline, validateSourceRanges } from '../../src/shared/source-range.js';
import { SPATIAL_CHANNELS, type SpatialChannel, type SpatialKeyframe } from '../../src/shared/spatial.js';
import { speedSchema } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { unsupportedProject } from './project-fixtures.js';

const curves: Interpolation[] = ['hold', 'linear', 'ease-in', 'ease-out', 'smooth'];
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return layerKeyframe(frame, { ...EMPTY_KEY_VALUES, ...values }, interpolation);
}
/** The same keyframe as an adjustment or clip grade stores it, without Opacity. */
function grade(frame: number, values: Partial<GradeKeyValues>, interpolation: Interpolation = 'linear'): GradeKeyframe {
  return layerKeyAsGradeKey(point(frame, values, interpolation));
}
const NO_SETTINGS = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as Record<
  SpatialChannel,
  null
>;
function opacityKey(frame: number, opacity: number): SpatialKeyframe {
  return { ...uniformKeyframe(frame, { ...NO_SETTINGS, opacity }, 'linear'), reset: false };
}
function row(): VideoLayer {
  return createLayer(BASE_LAYER_ID, 'Track 1');
}
/** An adjustment from project frame 0, so its keyframe frames are project frames. */
function look(keyframes: GradeKeyframe[] = [], colour: ColourSettings = createColourSettings()): Adjustment {
  return { ...createAdjustment('look', 0, 1_000_000), colour, keyframes };
}
function adjusted(keyframes: GradeKeyframe[] = []): ProjectDocument {
  return projectSchema.parse({ ...createProject('adjusted', 'Adjusted'), adjustments: [look(keyframes)] });
}
/** Its keyframes as the Colour controls read them. */
function view(project: ProjectDocument): { keyframes: LayerKeyframe[] } {
  return { keyframes: project.adjustments[0]!.keyframes.map(gradeKeyAsLayerKey) };
}
function sequence(keyframes: GradeKeyframe[] = [], lengths = [120, 100]): ProjectDocument {
  let project = projectSchema.parse({
    ...createProject('shared', 'Shared adjustment'),
    adjustments: [look(keyframes)],
  });
  for (const [index, length] of lengths.entries())
    project = applyCommand(project, {
      type: 'insert',
      clip: createClip(`clip-${index}`, `source-${index}`, 0, length),
      index,
    });
  return project;
}
function overlay(
  keyframes = [grade(0, { exposure: 0.5 }), grade(100, { hue: 30 })],
  start = 50,
  sourceIn = 10,
  sourceOut = 85,
  rate = 4,
): ProjectDocument {
  const project = applyCommand(adjusted(keyframes), {
    type: 'layer-add',
    layer: createLayer('upper', 'Track 2', false),
  });
  return applyCommand(project, {
    type: 'insert',
    clip: {
      ...createClip('top', 'source', sourceIn, sourceOut),
      layerId: 'upper',
      start,
      speed: { mode: 'constant', rate },
    },
    index: 0,
  });
}
const colourKeys = (): GradeKeyframe[] => [grade(0, { exposure: 1 }, 'hold'), grade(100, { hue: 20 })];
describe('strict current-schema keyframes and independently enabled settings', () => {
  it('exports an ordered immutable fifteen-setting catalogue and explicit all-null template', () => {
    const settings = [
      'opacity',
      'temperature',
      'tint',
      'exposure',
      'brightness',
      'contrast',
      'hue',
      'saturation',
      'vibrance',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'hdr',
      'localContrast',
    ];
    expect(KEYFRAME_SETTINGS.map((setting) => setting.key)).toEqual(settings);
    expect(Object.keys(EMPTY_KEY_VALUES)).toEqual(settings);
    expect(Object.values(EMPTY_KEY_VALUES)).toEqual(Array(15).fill(null));
    expect(Object.isFrozen(EMPTY_KEY_VALUES)).toBe(true);
    expect(Object.isFrozen(KEYFRAME_SETTINGS)).toBe(true);
    expect(KEYFRAME_SETTINGS.every(Object.isFrozen)).toBe(true);
  });

  it('requires the current schema version, explicit media membership, Transform Opacity and clip settings without legacy fields', () => {
    const project = createProject('strict', 'Strict');
    const clip = createClip('one', 'source', 0, 20);
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(project.media).toEqual({ videoIds: [], audioIds: [] });
    expect(project.layers[0]).toEqual(row());
    expect(Object.keys(clip)).toEqual([
      'id',
      'mediaId',
      'layerId',
      'start',
      'sourceIn',
      'sourceOut',
      'speed',
      'reverse',
      'detail',
      'grade',
    ]);
    expect(clip.reverse).toBe(false);
    const { reverse: _reverse, ...withoutDirection } = clip;
    expect(clipSchema.safeParse(withoutDirection).success).toBe(false);
    expect(clipSchema.safeParse({ ...clip, reverse: 'yes' }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, schemaVersion: 7 }).success).toBe(false);
    expect(project.layers[0]!.transform.base.opacity).toBe(1);
    expect(clip).not.toHaveProperty('opacity');
    const { transform } = row();
    const withOpacity = (opacity: unknown) => ({
      ...project,
      layers: [{ ...row(), transform: { ...transform, base: { ...transform.base, opacity } } }],
    });
    const { opacity: _opacity, ...withoutOpacity } = transform.base;
    expect(
      projectSchema.safeParse({ ...project, layers: [{ ...row(), transform: { ...transform, base: withoutOpacity } }] })
        .success,
    ).toBe(false);
    for (const opacity of [null, undefined, -0.1, 1.1, NaN, Infinity])
      expect(projectSchema.safeParse(withOpacity(opacity)).success).toBe(false);
    for (const opacity of [0, 0.23456789, 1]) {
      expect(projectSchema.parse(withOpacity(opacity)).layers[0]!.transform.base.opacity).toBe(opacity);
      expect(projectSchema.safeParse({ ...project, layers: [{ ...row(), opacity }] }).success).toBe(false);
      expect(clipSchema.safeParse({ ...clip, opacity }).success).toBe(false);
    }
    expect(projectSchema.safeParse(unsupportedProject(4, 'old', 'Unsupported row')).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, media: undefined }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, layers: [{ ...row(), opacityKeys: [] }] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, layers: [{ ...row(), keyframes: [] }] }).success).toBe(false);
    const { keyframes: _keys, ...incomplete } = transform;
    expect(projectSchema.safeParse({ ...project, layers: [{ ...row(), transform: incomplete }] }).success).toBe(false);
    const key = grade(0, { exposure: 0 });
    const opaque = { ...key, values: { ...key.values, opacity: 0.5 }, easing: { ...key.easing, opacity: 'linear' } };
    expect(clipSchema.safeParse({ ...clip, grade: { ...clip.grade, keyframes: [key] } }).success).toBe(true);
    expect(clipSchema.safeParse({ ...clip, grade: { ...clip.grade, keyframes: [opaque] } }).success).toBe(false);
    expect(clipSchema.safeParse({ ...clip, animation: { opacity: [], colour: [] } }).success).toBe(false);
    expect(
      speedSchema.safeParse({ mode: 'keyframes', keys: [{ frame: 0, value: 1, interpolation: 'linear' }] }).success,
    ).toBe(false);
  });

  it('rejects empty points, missing/extra values, noninteger times and unknown easing', () => {
    expect(layerKeyframeSchema.safeParse(point(0, {})).success).toBe(false);
    for (const removed of ['layerOpacity', 'clipOpacity', 'speed'])
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
    const { temperature: _temperature, ...incomplete } = point(0, { exposure: 0 }).values;
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
    // The former shared keyframe easing is rejected, and each enabled setting needs its own.
    expect(layerKeyframeSchema.safeParse({ ...point(0, { exposure: 0 }), interpolation: 'linear' }).success).toBe(
      false,
    );
    const { easing: _easing, ...withoutEasing } = point(0, { exposure: 0 });
    expect(layerKeyframeSchema.safeParse({ ...withoutEasing, interpolation: 'linear' }).success).toBe(false);
    const eased = point(0, { exposure: 0 });
    expect(layerKeyframeSchema.safeParse({ ...eased, easing: { ...eased.easing, exposure: null } }).success).toBe(
      false,
    );
    expect(layerKeyframeSchema.safeParse({ ...eased, easing: { ...eased.easing, hue: 'linear' } }).success).toBe(false);
    expect(layerKeyframeSchema.safeParse({ ...eased, easing: { ...eased.easing, exposure: 'cubic' } }).success).toBe(
      false,
    );
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

  it('enforces ascending unique keyframes and a 64-keyframe maximum per adjustment', () => {
    const project = createProject('limit', 'Limit');
    const keys = Array.from({ length: MAX_GRADE_KEYFRAMES }, (_, frame) => grade(frame, { exposure: 0.5 }));
    expect(projectSchema.parse({ ...project, adjustments: [look(keys)] }).adjustments[0]!.keyframes).toHaveLength(64);
    expect(
      projectSchema.safeParse({ ...project, adjustments: [look([...keys, grade(64, { hue: 10 })])] }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({
        ...project,
        adjustments: [look([grade(1, { exposure: 0 }), grade(1, { saturation: 1 })])],
      }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({
        ...project,
        adjustments: [look([grade(2, { exposure: 0 }), grade(1, { saturation: 1 })])],
      }).success,
    ).toBe(false);
    const history = new EditHistory({ ...project, adjustments: [look(keys)] });
    history.commit({ type: 'layer-key-toggle', adjustmentId: 'look', frame: 10, setting: 'hue', value: 90 });
    expect(history.current.adjustments[0]!.keyframes).toHaveLength(64);
    const before = history.current;
    expect(() =>
      history.commit({ type: 'layer-key-toggle', adjustmentId: 'look', frame: 64, setting: 'hue', value: 90 }),
    ).toThrow('already has 64 keyframes');
    expect(history.current).toEqual(before);
  });

  it('merges a keyframe, removes only the exact setting, and drops its last one', () => {
    let project = adjusted();
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 20,
      setting: 'exposure',
      value: 0,
    });
    project = applyCommand(project, {
      type: 'layer-key-easing',
      adjustmentId: 'look',
      frame: 20,
      setting: null,
      interpolation: 'smooth',
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 20,
      setting: 'contrast',
      value: 1.4,
    });
    expect(project.adjustments[0]!.keyframes).toEqual([grade(20, { exposure: 0, contrast: 1.4 }, 'smooth')]);
    const keyed = view(project);
    expect(keySettings(keyed.keyframes[0]!)).toEqual(['exposure', 'contrast']);
    expect(hasLayerKeys(keyed, 'contrast')).toBe(true);
    expect(hasLayerKeys(keyed, 'brightness')).toBe(false);
    expect(hasLayerKeys(keyed, 'opacity')).toBe(false);
    expect(activeLayerSetting(keyed, 'contrast', 20)).toBe(true);
    expect(activeLayerSetting(keyed, 'contrast', 19)).toBe(false);
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 20,
      setting: 'exposure',
      value: 1,
    });
    expect(project.adjustments[0]!.keyframes).toEqual([grade(20, { contrast: 1.4 }, 'smooth')]);
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 20,
      setting: 'contrast',
      value: 1.4,
    });
    expect(project.adjustments[0]!.keyframes).toEqual([]);
  });

  it('keeps a separate Easing per setting, defaulting a joining setting to the agreed one', () => {
    let project = adjusted();
    const toggle = (frame: number, setting: ScalarColourSetting, value: number): void => {
      project = applyCommand(project, { type: 'layer-key-toggle', adjustmentId: 'look', frame, setting, value });
    };
    const ease = (frame: number, setting: ScalarColourSetting | null, interpolation: Interpolation): void => {
      project = applyCommand(project, {
        type: 'layer-key-easing',
        adjustmentId: 'look',
        frame,
        setting,
        interpolation,
      });
    };
    toggle(0, 'exposure', 0);
    toggle(0, 'contrast', 1);
    toggle(20, 'exposure', 2);
    toggle(20, 'contrast', 2);
    ease(0, 'exposure', 'hold');
    ease(0, 'contrast', 'ease-in');
    const item = project.adjustments[0]!;
    expect(item.keyframes[0]!.easing).toMatchObject({ exposure: 'hold', contrast: 'ease-in', hue: null });
    // Exposure holds while Contrast eases in across the same interval.
    expect(evaluateLayerSetting(item, 'exposure', 10, 0)).toBe(0);
    expect(evaluateLayerSetting(item, 'contrast', 10, 1)).toBe(1.25);
    expect(adjustmentColourAt(item, 10)).toMatchObject({ exposure: 0, contrast: 1.25 });
    // Mixed settings give a joining setting Linear; agreed settings give it theirs.
    toggle(0, 'hue', 10);
    expect(project.adjustments[0]!.keyframes[0]!.easing.hue).toBe('linear');
    ease(0, null, 'smooth');
    expect(project.adjustments[0]!.keyframes[0]!.easing).toMatchObject({
      exposure: 'smooth',
      contrast: 'smooth',
      hue: 'smooth',
    });
    toggle(0, 'saturation', 1);
    expect(project.adjustments[0]!.keyframes[0]!.easing.saturation).toBe('smooth');
    // A brand-new keyframe starts Linear, and removing a setting removes its easing.
    toggle(40, 'exposure', 1);
    expect(project.adjustments[0]!.keyframes.at(-1)!.easing.exposure).toBe('linear');
    toggle(0, 'hue', 0);
    expect(project.adjustments[0]!.keyframes[0]!.easing.hue).toBeNull();
    const before = project;
    expect(() => ease(0, 'hue', 'hold')).toThrow('not enabled');
    expect(project).toBe(before);
  });

  it('sets a whole keyframe in one command exactly like its toggles and Easing', () => {
    const values = {
      temperature: 0.2,
      tint: -0.1,
      exposure: 0.3,
      brightness: 0.02,
      contrast: 1.1,
      saturation: 1.2,
      vibrance: 0.3,
      highlights: -0.2,
      shadows: 0.25,
      blacks: -0.1,
    } satisfies Partial<Record<ScalarColourSetting, number>>;
    let toggled = adjusted();
    for (const [setting, value] of Object.entries(values))
      toggled = applyCommand(toggled, {
        type: 'layer-key-toggle',
        adjustmentId: 'look',
        frame: 30,
        setting: setting as ScalarColourSetting,
        value,
      });
    toggled = applyCommand(toggled, {
      type: 'layer-key-easing',
      adjustmentId: 'look',
      frame: 30,
      setting: null,
      interpolation: 'hold',
    });
    const set = (project: ProjectDocument, command: Omit<Extract<EditCommand, { type: 'layer-key-set' }>, 'type'>) =>
      applyCommand(project, { type: 'layer-key-set', ...command });
    let project = set(adjusted(), { adjustmentId: 'look', frame: 30, values, easing: 'hold' });
    expect(project).toEqual(toggled);

    // Unlisted settings stay; null disables one; a new setting joins with the agreed Easing.
    project = set(project, { adjustmentId: 'look', frame: 30, values: { exposure: 0.5, contrast: null, hue: 10 } });
    const key = project.adjustments[0]!.keyframes[0]!;
    expect(key.values).toMatchObject({ exposure: 0.5, contrast: null, hue: 10, saturation: 1.2 });
    expect(key.easing).toMatchObject({ exposure: 'hold', contrast: null, hue: 'hold', saturation: 'hold' });
    project = set(project, { adjustmentId: 'look', frame: 30, values: { hue: 20 }, easing: { exposure: 'smooth' } });
    expect(project.adjustments[0]!.keyframes[0]!.easing).toMatchObject({ exposure: 'smooth', hue: 'hold' });

    // reset makes it a default keyframe; disabling every setting removes the keyframe.
    project = set(project, { adjustmentId: 'look', frame: 30, values: { hdr: 0 }, reset: true });
    expect(project.adjustments[0]!.keyframes[0]!.reset).toBe(true);
    const all = Object.fromEntries(COLOUR_CONTROLS.map((setting) => [setting.key, null]));
    expect(set(project, { adjustmentId: 'look', frame: 30, values: all }).adjustments[0]!.keyframes).toEqual([]);
  });

  it('rejects a whole keyframe command without partial edits', () => {
    const keys = Array.from({ length: MAX_GRADE_KEYFRAMES }, (_, frame) => grade(frame, { exposure: 0.25 }));
    const history = new EditHistory(adjusted(keys));
    const before = history.current;
    const attempt = (command: Record<string, unknown>) => () =>
      history.commit({
        type: 'layer-key-set',
        adjustmentId: 'look',
        frame: 10,
        values: {},
        ...command,
      } as EditCommand);
    expect(attempt({ values: { exposure: 0.5, contrast: 9 } })).toThrow();
    expect(attempt({ values: { exposure: 0.5, sharpness: 1 } })).toThrow();
    expect(attempt({ values: { exposure: 0.5, opacity: 0.5 } })).toThrow();
    expect(attempt({ values: {} })).toThrow('at least one');
    expect(attempt({ values: { exposure: 0.5 }, easing: { hue: 'hold' } })).toThrow('hue is not keyed');
    expect(attempt({ values: { exposure: 0.5 }, easing: 'cubic' })).toThrow();
    expect(attempt({ frame: 300, values: { exposure: 0.5 } })).toThrow('already has 64 keyframes');
    expect(attempt({ adjustmentId: 'missing', values: { exposure: 0.5 } })).toThrow('Adjustment no longer exists');
    expect(history.current).toEqual(before);
    // Changing a keyframe that exists is still allowed at the limit.
    history.commit({ type: 'layer-key-set', adjustmentId: 'look', frame: 10, values: { exposure: 0.5 } });
    expect(history.current.adjustments[0]!.keyframes).toHaveLength(64);
    expect(history.current.adjustments[0]!.keyframes[10]!.values.exposure).toBe(0.5);
  });

  it('adds a default keyframe that holds defaults from its frame without reaching back', () => {
    let project = projectSchema.parse({
      ...createProject('default', 'Default keyframe'),
      adjustments: [look([grade(10, { exposure: 1 })], { ...createColourSettings(), exposure: 0.5, contrast: 1.4 })],
    });
    const toggle = (frame: number): void => {
      project = applyCommand(project, { type: 'layer-key-default', adjustmentId: 'look', frame });
    };
    toggle(50);
    const reset = project.adjustments[0]!.keyframes[1]!;
    expect(reset.reset).toBe(true);
    expect(keySettings(gradeKeyAsLayerKey(reset))).toEqual(COLOUR_CONTROLS.map((setting) => setting.key));
    expect(new Set(Object.values(reset.easing))).toEqual(new Set(['hold']));
    expect(reset.values).toMatchObject({ exposure: 0, contrast: 1, saturation: 1, hdr: 0 });
    expect(reset.values).not.toHaveProperty('opacity');
    const keyed = project.adjustments[0]!;
    // An animated setting eases into the default from its previous keyframe, then holds it.
    expect(evaluateLayerSetting(keyed, 'exposure', 5, 0.5)).toBe(1);
    expect(evaluateLayerSetting(keyed, 'exposure', 30, 0.5)).toBe(0.5);
    expect(evaluateLayerSetting(keyed, 'exposure', 80, 0.5)).toBe(0);
    // Unanimated settings keep their saved values until the default keyframe.
    expect(adjustmentColourAt(keyed, 49).contrast).toBe(1.4);
    expect(adjustmentColourAt(keyed, 50).contrast).toBe(1);
    // It moves and loses settings like any keyframe, staying a default keyframe.
    project = applyCommand(project, { type: 'layer-key-move', adjustmentId: 'look', frame: 50, nextFrame: 60 });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 60,
      setting: 'hue',
      value: 0,
    });
    expect(project.adjustments[0]!.keyframes[1]).toMatchObject({ frame: 60, reset: true, values: { hue: null } });
    const before = project;
    expect(() => toggle(10)).toThrow('already exists');
    expect(project).toBe(before);
    toggle(60);
    expect(project.adjustments[0]!.keyframes).toEqual([grade(10, { exposure: 1 })]);
    const { reset: _reset, ...withoutKind } = point(0, { exposure: 0 });
    expect(layerKeyframeSchema.safeParse(withoutKind).success).toBe(false);
  });

  it('can independently toggle all fourteen Colour settings at one frame', () => {
    let project = adjusted();
    for (const setting of COLOUR_CONTROLS)
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        adjustmentId: 'look',
        frame: 5,
        setting: setting.key,
        value: setting.min,
      });
    expect(project.adjustments[0]!.keyframes).toHaveLength(1);
    expect(keySettings(gradeKeyAsLayerKey(project.adjustments[0]!.keyframes[0]!))).toEqual(
      COLOUR_CONTROLS.map((setting) => setting.key),
    );
    for (const setting of COLOUR_CONTROLS)
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        adjustmentId: 'look',
        frame: 5,
        setting: setting.key,
        value: setting.min,
      });
    expect(project.adjustments[0]!.keyframes).toEqual([]);
  });

  it('updates only existing settings and validates removals without implicit keys', () => {
    const project = adjusted([grade(10, { exposure: 1, contrast: 1.5 }, 'hold')]);
    const changed = applyCommand(project, {
      type: 'layer-key-value',
      adjustmentId: 'look',
      frame: 10,
      setting: 'exposure',
      value: -1,
    });
    expect(changed.adjustments[0]!.keyframes).toEqual([grade(10, { exposure: -1, contrast: 1.5 }, 'hold')]);
    expect(project.adjustments[0]!.keyframes[0]!.values.exposure).toBe(1);
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-value',
        adjustmentId: 'look',
        frame: 10,
        setting: 'brightness',
        value: 0.1,
      }),
    ).toThrow('The setting is not enabled at this adjustment keyframe.');
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-value',
        adjustmentId: 'look',
        frame: 11,
        setting: 'exposure',
        value: 0,
      }),
    ).toThrow('The setting is not enabled at this adjustment keyframe.');
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-toggle',
        adjustmentId: 'look',
        frame: 10,
        setting: 'exposure',
        value: 4,
      }),
    ).toThrow();
    expect(() =>
      applyCommand(project, {
        type: 'layer-key-toggle',
        adjustmentId: 'look',
        frame: -1,
        setting: 'exposure',
        value: 0,
      }),
    ).toThrow();
    for (const setting of ['toString', 'opacity'])
      expect(() =>
        applyCommand(project, {
          type: 'layer-key-toggle',
          adjustmentId: 'look',
          frame: 10,
          setting: setting as ScalarColourSetting,
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
    const document = adjusted([
      grade(10, { contrast: 1.7, exposure: 1, hue: 90 }, 'ease-in'),
      grade(20, { shadows: 0.5 }),
    ]);
    const history = new EditHistory(document);
    history.commit({ type: 'layer-key-move', adjustmentId: 'look', frame: 10, nextFrame: 30 });
    expect(history.current.adjustments[0]!.keyframes).toEqual([
      document.adjustments[0]!.keyframes[1],
      { ...document.adjustments[0]!.keyframes[0]!, frame: 30 },
    ]);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(() => history.commit({ type: 'layer-key-move', adjustmentId: 'look', frame: 10, nextFrame: 20 })).toThrow(
      'destination frame',
    );
    expect(history.current).toEqual(document);
    expect(history.canRedo).toBe(true);
    expect(history.redo().adjustments[0]!.keyframes.at(-1)!.easing.contrast).toBe('ease-in');
    const before = history.current;
    history.commit({ type: 'layer-key-remove', adjustmentId: 'look', frame: 30 });
    expect(history.current.adjustments[0]!.keyframes).toHaveLength(1);
    expect(history.undo()).toEqual(before);
    expect(document.adjustments[0]!.keyframes[0]!.frame).toBe(10);
  });

  it('rejects timing-invalid clip speed edits atomically and leaves no history entry', () => {
    const document = applyCommand(sequence([], [100]), {
      type: 'fades',
      layerId: BASE_LAYER_ID,
      opening: 80,
      closing: 0,
    });
    const history = new EditHistory(document);
    expect(() => history.commit({ type: 'speed', clipId: 'clip-0', speed: { mode: 'constant', rate: 8 } })).toThrow(
      'regions overlap',
    );
    expect(history.current).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(() => history.commit({ type: 'layer-key-remove', adjustmentId: 'look', frame: 100 })).toThrow(
      'no longer exists',
    );
    expect(() =>
      history.commit({ type: 'layer-key-toggle', adjustmentId: 'missing', frame: 0, setting: 'exposure', value: 1 }),
    ).toThrow('Adjustment no longer exists');
  });
});

describe('independent adjustment interpolation and unchanged CPU composition', () => {
  it.each(curves)('uses only keyframes with the setting enabled and its left easing: %s', (interpolation) => {
    const item = look([
      grade(10, { exposure: -1 }, interpolation),
      grade(30, { hue: 90 }, 'hold'),
      grade(110, { exposure: 1 }),
    ]);
    const middle: Record<Interpolation, number> = { hold: -1, linear: 0, 'ease-in': -0.5, 'ease-out': 0.5, smooth: 0 };
    expect(evaluateLayerSetting(item, 'exposure', 60, 2)).toBeCloseTo(middle[interpolation]);
    expect(evaluateLayerSetting(item, 'exposure', -10, 2)).toBe(-1);
    expect(evaluateLayerSetting(item, 'exposure', 110, 2)).toBe(1);
    expect(evaluateLayerSetting(item, 'exposure', 200, 2)).toBe(1);
    expect(evaluateLayerSetting(item, 'hue', 10, 0)).toBe(90);
    expect(evaluateLayerSetting(item, 'brightness', 60, 0.2)).toBe(0.2);
  });

  it('interpolates each grading parameter rather than endpoint pixels or whole grades', () => {
    const item = look(
      [
        grade(0, { exposure: -1, saturation: 0.5 }),
        grade(50, { shadows: -0.4 }, 'hold'),
        grade(100, { exposure: 1, saturation: 1.5 }),
      ],
      { ...NEUTRAL_COLOUR, brightness: 0.12, hue: 30, contrast: 1.2 },
    );
    const middle = adjustmentColourAt(item, 50);
    expect(middle).toEqual({ ...item.colour, exposure: 0, saturation: 1, shadows: -0.4 });
    expect(item.colour.shadows).toBe(0);
    const pixel = gradePixel([0.4, 0.3, 0.2], middle);
    const first = gradePixel([0.4, 0.3, 0.2], adjustmentColourAt(item, 0));
    const last = gradePixel([0.4, 0.3, 0.2], adjustmentColourAt(item, 100));
    expect(pixel[0]).not.toBeCloseTo((first[0] + last[0]) / 2, 5);
  });

  it('overrides Transform Opacity uniformly while both dissolve sources share the adjustment colour', () => {
    let project = sequence([grade(0, { exposure: -1 }), grade(100, { exposure: 1 })], [100, 100]);
    project = applyCommand(project, {
      type: 'colour',
      adjustmentId: 'look',
      colour: { ...NEUTRAL_COLOUR, brightness: 0.1, saturation: 1.4 },
    });
    project = applyCommand(project, {
      type: 'transform-setting',
      layerId: BASE_LAYER_ID,
      setting: 'opacity',
      value: 0.9,
    });
    project = applyCommand(project, {
      type: 'transform',
      layerId: BASE_LAYER_ID,
      transform: { ...project.layers[0]!.transform, keyframes: [opacityKey(0, 0.4)] },
    });
    project = applyCommand(project, {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 20 },
    });
    const samples = sampleTimeline(project, 90);
    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.sourceFrame)).toEqual([90, 10]);
    expect(samples.map((sample) => sample.colour.exposure)).toEqual([0.8, 0.8]);
    expect(samples.map((sample) => sample.colour.brightness)).toEqual([0.1, 0.1]);
    expect(samples.map((sample) => sample.colour.saturation)).toEqual([1.4, 1.4]);
    expect(samples.map((sample) => sample.opacity)).toEqual([0.4, 0.4]);
    expect(adjustmentColour(project, 90)).toEqual(samples[0]!.colour);
    const unkeyed = look([], { ...NEUTRAL_COLOUR, exposure: 0.3 });
    expect(adjustmentColourAt(unkeyed, 90)).toEqual(unkeyed.colour);
    const staticLayer = row();
    staticLayer.transform.base.opacity = 0.9;
    expect(opacityAt(staticLayer, 90)).toBe(0.9);
    expect(project.layers[0]!.transform.base.opacity).toBe(0.9);
    expect(project.clips.every((clip) => !('opacity' in clip))).toBe(true);
  });

  it('uses uniform track coverage during a dissolve without a second multiplier and restores the base', () => {
    const project = applyCommand(sequence([], [100, 100]), {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 20 },
    });
    const { transform } = project.layers[0]!;
    transform.base.opacity = 0.6;
    const sourcePixel = (sample: ReturnType<typeof sampleTimeline>[number]): [number, number, number] =>
      sample.clipId === 'clip-0' ? [1, 0, 0] : [0, 0, 1];
    const pixel = compositePixel(sampleTimeline(project, 90), sourcePixel);
    expect(pixel[0]).toBeCloseTo(0.3);
    expect(pixel[1]).toBeCloseTo(0);
    expect(pixel[2]).toBeCloseTo(0.3);
    expect(sampleTimeline(project, 90).map((sample) => sample.opacity)).toEqual([0.6, 0.6]);
    transform.keyframes = [opacityKey(0, 0.4)];
    expect(sampleTimeline(project, 90).map((sample) => sample.opacity)).toEqual([0.4, 0.4]);
    const overridden = compositePixel(sampleTimeline(project, 90), sourcePixel);
    expect(overridden[0]).toBeCloseTo(0.2);
    expect(overridden[1]).toBeCloseTo(0);
    expect(overridden[2]).toBeCloseTo(0.2);
    transform.keyframes = [];
    expect(sampleTimeline(project, 90).map((sample) => sample.opacity)).toEqual([0.6, 0.6]);
    project.layers[0]!.enabled = false;
    expect(sampleTimeline(project, 90)).toEqual([]);
    expect(calculateLayout(project).duration).toBe(180);
  });
});

describe('fixed clip durations through trims, splits, duplicates and fixed adjustment key times', () => {
  it('keeps primary IN start fixed while rippling downstream clips', () => {
    const original = sequence(colourKeys());
    const keys = original.adjustments[0]!.keyframes;
    const command = trimOnTimeline(original, 'clip-0', 'in', 20, 200, 'output');
    expect(command).toEqual({ type: 'trim', clipId: 'clip-0', sourceIn: 20, sourceOut: 120 });
    const project = applyCommand(original, command);
    expect(calculateLayout(project).clips.map((clip) => [clip.start, clip.duration])).toEqual([
      [0, 100],
      [100, 100],
    ]);
    expect(project.adjustments[0]!.keyframes).toEqual(keys);
    expect(original.clips[0]!.sourceIn).toBe(0);
  });

  it('uses the nearest original endpoint across an entire rounded-duration plateau', () => {
    const original = applyCommand(sequence([], [100]), {
      type: 'speed',
      clipId: 'clip-0',
      speed: { mode: 'constant', rate: 8 },
    });
    const project = applyCommand(original, { type: 'trim', clipId: 'clip-0', sourceIn: 80, sourceOut: 100 });
    const restored = trimOnTimeline(project, 'clip-0', 'in', -1, 200, 'output');
    expect(restored).toEqual({ type: 'trim', clipId: 'clip-0', sourceIn: 72, sourceOut: 100 });
    const extended = trimOnTimeline(project, 'clip-0', 'out', 1, 200, 'output');
    expect(extended).toEqual({ type: 'trim', clipId: 'clip-0', sourceIn: 80, sourceOut: 108 });
    const placed = calculateLayout(applyCommand(project, restored)).clips[0]!;
    expect(placed.duration).toBe(4);
    // 28 source frames over 4 output frames: 7 per output frame.
    expect(placed.retiming.sourceAt(1)).toBe(79);
  });

  it.each([0.5, 1, 4])('keeps overlay OUT fixed for a %sx clip and source bounds', (rate) => {
    const original = overlay(undefined, 50, 10, 85, rate);
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
    const original = overlay([grade(0, { exposure: 0.5 })], 10, 100, 150, 0.5);
    for (const unit of ['output', 'source'] as const) {
      const command = trimOnTimeline(original, 'top', 'in', -10_000, 200, unit);
      expect(command).toEqual({ type: 'trim-place', clipId: 'top', sourceIn: 95, sourceOut: 150, start: 0 });
      expect(calculateLayout(applyCommand(original, command)).clips[0]!.end).toBe(110);
    }
    const fast = overlay();
    // 19 + 10 output frames at 4x need 114–117 source frames; keep the nearest OUT.
    expect(trimOnTimeline(fast, 'top', 'out', 10, 200, 'output')).toEqual({
      type: 'trim',
      clipId: 'top',
      sourceIn: 10,
      sourceOut: 124,
    });
    const restored = applyCommand(fast, trimOnTimeline(fast, 'top', 'out', 10_000, 200, 'output'));
    expect(restored.clips[0]!.sourceOut).toBe(200);
    expect(restored.clips[0]!.start).toBe(50);
    expect(trimOnTimeline(fast, 'top', 'out', 5, 200, 'source')).toEqual({
      type: 'trim',
      clipId: 'top',
      sourceIn: 10,
      sourceOut: 90,
    });
  });

  it('leaves fade/overlay conflict validation to atomic command application', () => {
    const fastFirst = applyCommand(sequence([], [100, 100]), {
      type: 'speed',
      clipId: 'clip-0',
      speed: { mode: 'constant', rate: 2 },
    });
    const original = applyCommand(fastFirst, {
      type: 'transition',
      transition: { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 20 },
    });
    const history = new EditHistory(original);
    const command = trimOnTimeline(original, 'clip-0', 'out', -40, 200, 'output');
    expect(() => history.commit(command)).toThrow('regions overlap');
    expect(history.current).toEqual(original);
    expect(history.canUndo).toBe(false);
    const first = overlay([], 0, 0, 100, 2);
    const layered = applyCommand(first, {
      type: 'insert',
      clip: { ...createClip('next', 'source', 0, 100), layerId: 'upper', start: 60 },
      index: 1,
    });
    const overlapping = trimOnTimeline(layered, 'top', 'out', 30, 200, 'output');
    expect(() => applyCommand(layered, overlapping)).toThrow('cannot overlap');
    expect(layered.clips[0]!.sourceOut).toBe(100);
  });

  it('splits at the left piece duration, keeps keyframes on the adjustment, and preserves static settings', () => {
    const original = overlay();
    const keys = original.adjustments[0]!.keyframes;
    const split = applyCommand(original, { type: 'split', clipId: 'top', sourceFrame: 40, newClipId: 'right' });
    const layout = calculateLayout(split);
    // 30 and 45 source frames at 4x round independently to 8 and 11 output frames.
    expect(layout.clips.map((clip) => [clip.start, clip.duration, clip.end])).toEqual([
      [50, 8, 58],
      [58, 11, 69],
    ]);
    expect(split.clips.map((clip) => [clip.sourceIn, clip.sourceOut])).toEqual([
      [10, 40],
      [40, 85],
    ]);
    expect(split.clips[1]!.speed).toEqual(original.clips[0]!.speed);
    expect(split.clips[1]!.grade).toEqual(original.clips[0]!.grade);
    expect(split.layers.map((layer) => layer.transform)).toEqual(original.layers.map((layer) => layer.transform));
    expect(split.clips[1]).not.toHaveProperty('animation');
    expect(split.adjustments[0]!.keyframes).toEqual(keys);
    expect(layout.clips[1]!.duration).toBe(11);
    const sequenceProject = applyCommand(sequence(colourKeys()), {
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
      [90, 30],
    ]);
    expect(
      divided.layers[0]!.transitions.map((transition) => [transition.leftId, transition.rightId, transition.type]),
    ).toEqual([
      ['clip-0', 'part', 'cut'],
      ['part', 'clip-1', 'cross-dissolve'],
    ]);
    expect(divided.adjustments).toEqual(sequenceProject.adjustments);
  });

  it('rounds split-piece durations independently without silently sliding adjustment keyframes', () => {
    const original = applyCommand(sequence(colourKeys(), [120]), {
      type: 'speed',
      clipId: 'clip-0',
      speed: { mode: 'constant', rate: 8 },
    });
    const split = applyCommand(original, { type: 'split', clipId: 'clip-0', sourceFrame: 4, newClipId: 'part' });
    // 120 / 8 = 15, but 4 / 8 and 116 / 8 round up independently.
    expect(calculateLayout(original).duration).toBe(15);
    expect(calculateLayout(split).clips.map((clip) => clip.duration)).toEqual([1, 15]);
    expect(calculateLayout(split).duration).toBe(16);
    expect(split.adjustments).toEqual(original.adjustments);
  });

  it('duplicates after the clip end with the same fixed duration', () => {
    const original = overlay();
    const history = new EditHistory(original);
    history.commit({ type: 'duplicate', clipId: 'top', newClipId: 'copy' });
    const layout = calculateLayout(history.current);
    expect(layout.clips.map((clip) => [clip.start, clip.duration, clip.end])).toEqual([
      [50, 19, 69],
      [69, 19, 88],
    ]);
    expect(history.current.clips[1]).toEqual({ ...original.clips[0]!, id: 'copy', start: 69 });
    expect(history.current.adjustments).toEqual(original.adjustments);
    expect(history.undo()).toEqual(original);
    const primary = applyCommand(sequence(colourKeys(), [120]), {
      type: 'duplicate',
      clipId: 'clip-0',
      newClipId: 'copy',
    });
    expect(calculateLayout(primary).clips.map((clip) => [clip.start, clip.duration])).toEqual([
      [0, 120],
      [120, 120],
    ]);
    expect(primary.adjustments[0]!.keyframes).toEqual(colourKeys());
  });

  it('keeps the clip duration through placement and hidden layers, leaving adjustment keys at fixed frames', () => {
    const original = overlay();
    const keys = original.adjustments[0]!.keyframes;
    const moved = applyCommand(original, { type: 'place', clipId: 'top', layerId: 'upper', start: 100, index: 0 });
    expect(calculateLayout(moved).clips[0]).toMatchObject({ start: 100, duration: 19, end: 119 });
    expect(moved.adjustments[0]!.keyframes).toEqual(keys);
    moved.layers[1]!.enabled = false;
    expect(calculateLayout(moved).duration).toBe(119);
    expect(sampleTimeline(moved, 110)).toEqual([]);
  });

  it('bounds only original source ranges, not adjustment key times', () => {
    const project = overlay([grade(500_000, { exposure: 1 })]);
    expect(() => validateSourceRanges(project, new Map([['source', 85]]))).not.toThrow();
    expect(() => validateSourceRanges(project, new Map([['source', 84]]))).toThrow('Source range exceeds');
    expect(() => validateSourceRanges(project, new Map([['source', NaN]]))).toThrow('Source range exceeds');
    expect(() => trimOnTimeline(project, 'top', 'in', 0.5, 100, 'output')).toThrow();
    expect(() => trimOnTimeline(project, 'top', 'out', 1, 84, 'output')).toThrow();
    expect(() => trimOnTimeline(project, 'missing', 'in', 1, 100, 'output')).toThrow('Clip no longer exists');
    expect(() => trimOnTimeline(project, 'top', 'in', 1, 100, 'invalid' as 'output')).toThrow('Trim unit');
  });
});
