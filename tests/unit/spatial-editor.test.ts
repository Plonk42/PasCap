import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { uniformKeyframe, type Interpolation } from '../../src/shared/keyframes.js';
import { createClip, createProject } from '../../src/shared/model.js';
import {
  createSpatialSettings,
  defaultSpatialKeyframe,
  evaluateSpatial,
  NEUTRAL_SPATIAL_POSE,
  type SpatialKeyframe,
  type SpatialKeyValues,
} from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { validateNumberDraft } from '../../src/web/NumberField.js';
import {
  editSpatialPose,
  removeSpatialKey,
  replaceSpatialKey,
  resetSpatial,
  setSpatialEasing,
  SPATIAL_CONTROLS,
  toggleDefaultSpatialKey,
  toggleSpatialChannel,
} from '../../src/web/spatial-editor.js';
import { createValueControlState, syncValueControlState, transitionValueControl } from '../../src/web/ValueControl.js';

const NO_VALUES = {
  cropLeft: null,
  cropRight: null,
  cropTop: null,
  cropBottom: null,
  scale: null,
  translateX: null,
  translateY: null,
  rotation: null,
  opacity: null,
};

function key(frame: number, values: Partial<SpatialKeyValues>, curve: Interpolation): SpatialKeyframe {
  return { ...uniformKeyframe(frame, { ...NO_VALUES, ...values }, curve), reset: false };
}

describe('per-setting track Transform editor', () => {
  it('exposes all nine exact value controls, Opacity included, and edits only the unanimated base', () => {
    expect(SPATIAL_CONTROLS.map((control) => control.key)).toEqual(Object.keys(NEUTRAL_SPATIAL_POSE));
    let settings = createSpatialSettings();
    const values = [0.1234567, 0.2, 0.3, 0.4, 1.234567, -0.1234567, 0.1234567, 17.1234567, 0.4567891];
    for (const [index, control] of SPATIAL_CONTROLS.entries()) {
      settings = editSpatialPose(settings, null, control.key, values[index]!);
      expect(settings.base[control.key]).toBe(values[index]);
      expect(settings.keyframes).toEqual([]);
    }
  });

  it('captures one setting’s evaluated value at a timeline frame', () => {
    const settings = createSpatialSettings();
    settings.base.scale = 1.5;
    settings.base.rotation = 20;
    settings.keyframes = [key(0, { scale: 1 }, 'linear'), key(10, { scale: 3 }, 'smooth')];
    const before = structuredClone(settings);
    const scaled = toggleSpatialChannel(settings, 'scale', 4);
    expect(scaled.keyframes[1]).toEqual(key(4, { scale: evaluateSpatial(settings, 4).scale }, 'linear'));
    // Rotation is unkeyed, so its capture holds the base value and adds no other channel.
    const rotated = toggleSpatialChannel(settings, 'rotation', 4);
    expect(rotated.keyframes[1]).toEqual(key(4, { rotation: 20 }, 'linear'));
    expect(rotated.base).toEqual(settings.base);
    expect(settings).toEqual(before);
    // A second channel at the same frame joins the same key and adopts its agreed easing.
    const eased = setSpatialEasing(rotated, 4, null, 'ease-in');
    const joined = toggleSpatialChannel(eased, 'translateX', 4);
    expect(joined.keyframes[1]).toEqual(key(4, { rotation: 20, translateX: 0 }, 'ease-in'));
  });

  it('removes only the toggled setting and the key itself once no setting remains', () => {
    let settings = toggleSpatialChannel(createSpatialSettings(), 'scale', 12);
    settings = toggleSpatialChannel(settings, 'rotation', 12);
    settings = toggleSpatialChannel(settings, 'scale', 12);
    expect(settings.keyframes).toEqual([key(12, { rotation: 0 }, 'linear')]);
    settings = toggleSpatialChannel(settings, 'rotation', 12);
    expect(settings).toEqual(createSpatialSettings());
  });

  it('never creates implicit keys and keeps each setting independent of the others', () => {
    const base = editSpatialPose(createSpatialSettings(), null, 'scale', 1.456789);
    const keyed = toggleSpatialChannel(base, 'scale', 12);
    expect(() => editSpatialPose(keyed, 13, 'scale', 2)).toThrow('add a keyframe');
    // Unkeyed settings still edit their base even while another setting is animated.
    const moved = editSpatialPose(keyed, 13, 'translateX', 0.25);
    expect(moved.base.translateX).toBe(0.25);
    expect(moved.keyframes).toEqual(keyed.keyframes);
    const edited = editSpatialPose(keyed, 12, 'scale', 2);
    expect(edited.base).toEqual(keyed.base);
    expect(edited.keyframes[0]!.values.scale).toBe(2);
    expect(removeSpatialKey(edited, 12)).toEqual(base);
  });

  it('interpolates each setting between its own keys, skipping keys that leave it out', () => {
    let settings = toggleSpatialChannel(createSpatialSettings(), 'scale', 0);
    settings = toggleSpatialChannel(settings, 'rotation', 10);
    settings = toggleSpatialChannel(settings, 'scale', 20);
    settings = editSpatialPose(settings, 20, 'scale', 3);
    settings = editSpatialPose(settings, 10, 'rotation', 90);
    expect(evaluateSpatial(settings, 10).scale).toBe(2);
    expect(evaluateSpatial(settings, 10).rotation).toBe(90);
    expect(evaluateSpatial(settings, 15).scale).toBe(2.5);
    // Single-key settings hold everywhere; the base only returns for unkeyed settings.
    expect(evaluateSpatial(settings, 99).rotation).toBe(90);
    expect(evaluateSpatial(settings, 5).translateX).toBe(0);
  });

  it('moves a key and its easing atomically, rejects collisions, and keeps keys after the duration', () => {
    let settings = toggleSpatialChannel(createSpatialSettings(), 'translateX', 0);
    settings = toggleSpatialChannel(settings, 'translateX', 120);
    settings = replaceSpatialKey(settings, 0, key(0, { translateX: 0.5 }, 'ease-in'));
    const moved = replaceSpatialKey(settings, 0, { frame: 90 });
    expect(moved.keyframes[0]).toEqual({ ...settings.keyframes[0], frame: 90 });
    expect(moved.base).toEqual(settings.base);
    expect(() => replaceSpatialKey(settings, 0, { frame: 120 })).toThrow('already exists');
    const project = createProject('spatial-editor', 'Transform editor');
    project.clips = [createClip('one', 'source', 30, 60)];
    const next = applyCommand(project, { type: 'transform', layerId: 'video-1', transform: settings });
    expect(next.layers[0]!.transform.keyframes.map((point) => point.frame)).toEqual([0, 120]);
    expect(calculateLayout(next).duration).toBe(calculateLayout(project).duration);
    expect(next.clips).toEqual(project.clips);
  });

  it('toggles a default keyframe without ever replacing an ordinary one', () => {
    const settings = toggleSpatialChannel(createSpatialSettings(), 'scale', 10);
    const added = toggleDefaultSpatialKey(settings, 30);
    expect(added.keyframes).toEqual([settings.keyframes[0], defaultSpatialKeyframe(30)]);
    expect(toggleDefaultSpatialKey(added, 30)).toEqual(settings);
    expect(() => toggleDefaultSpatialKey(settings, 10)).toThrow('already exists');
    // A default keyframe stays one while its values are edited.
    const edited = editSpatialPose(added, 30, 'scale', 2);
    expect(edited.keyframes[1]).toMatchObject({ frame: 30, reset: true, values: { scale: 2 } });
  });

  it('resets like Color: the whole base when unanimated, else only the keyframe at the playhead', () => {
    const base = editSpatialPose(editSpatialPose(createSpatialSettings(), null, 'scale', 2), null, 'rotation', 30);
    expect(resetSpatial(base, 0)).toEqual(createSpatialSettings());
    expect(resetSpatial(createSpatialSettings(), 0)).toBeNull();
    let animated = toggleSpatialChannel(base, 'scale', 10);
    animated = editSpatialPose(animated, 10, 'scale', 3);
    animated = toggleSpatialChannel(animated, 'translateX', 20);
    animated = editSpatialPose(animated, 20, 'translateX', 0.5);
    const reset = resetSpatial(animated, 10)!;
    expect(reset.keyframes[0]!.values).toEqual({ ...NO_VALUES, scale: 1 });
    // Other keyframes, the easing and the saved base under keyed and unkeyed settings stay unchanged.
    expect(reset.keyframes[1]).toEqual(animated.keyframes[1]);
    expect(reset.keyframes[0]!.easing).toEqual(animated.keyframes[0]!.easing);
    expect(reset.base).toEqual(animated.base);
    expect(resetSpatial(animated, 15)).toBeNull();
    expect(resetSpatial(reset, 10)).toBeNull();
  });

  it.each([
    ['cropLeft', 1.01],
    ['cropRight', 1.01],
    ['cropBottom', -0.1],
    ['scale', 0.09],
    ['translateX', -2.01],
    ['translateY', 2.01],
    ['rotation', 180.01],
  ] as const)('rejects invalid %s %s without clamping or modifying the source pose', (setting, value) => {
    const settings = createSpatialSettings();
    settings.base.cropLeft = 0.2;
    settings.base.cropTop = 0.2;
    const before = structuredClone(settings);
    expect(() => editSpatialPose(settings, null, setting, value)).toThrow();
    expect(settings).toEqual(before);
  });

  it('accepts opposite crops that cover nothing instead of repairing them', () => {
    const settings = createSpatialSettings();
    settings.base.cropRight = 0.6;
    const edited = editSpatialPose(settings, null, 'cropLeft', 0.7);
    expect(edited.base).toMatchObject({ cropLeft: 0.7, cropRight: 0.6 });
  });

  it('validates number drafts and pointer releases for an animated setting without publishing them', () => {
    const settings = toggleSpatialChannel(createSpatialSettings(), 'scale', 10);
    const validate = (value: number): string | null => {
      try {
        editSpatialPose(settings, 5, 'scale', value);
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'invalid';
      }
    };
    expect(validateNumberDraft('1.456789', { min: 0.1, max: 8, validate }).valid).toBe(false);
    const context = { value: 1, min: 0.1, max: 8, step: 0.001, disabled: false, integer: false, resetKey: 'one:5' };
    let state = transitionValueControl(createValueControlState(context), { type: 'begin', pointerId: 7 }).state;
    const draft = transitionValueControl(state, { type: 'change', value: 1.456789 }, validate);
    expect(draft.commit).toBeNull();
    state = draft.state;
    const released = transitionValueControl(state, { type: 'finish', pointerId: 7 }, validate);
    expect(released.commit).toBeNull();
    expect(released.state.draft).toBe(1.456789);
    expect(released.state.error).toContain('keyframe');
    expect(syncValueControlState(state, { ...context, resetKey: 'two:5' }).pointer?.canceled).toBe(true);
  });

  it('bounds explicit capture at 256 keys', () => {
    const settings = createSpatialSettings();
    settings.keyframes = Array.from({ length: 256 }, (_, frame) => key(frame, { scale: 1 }, 'linear'));
    expect(() => toggleSpatialChannel(settings, 'rotation', 256)).toThrow();
    expect(() => toggleDefaultSpatialKey(settings, 256)).toThrow();
    // Joining an existing key adds no key, so it stays within the limit.
    expect(toggleSpatialChannel(settings, 'rotation', 7).keyframes).toHaveLength(256);
    expect(removeSpatialKey(settings, 0).keyframes).toHaveLength(255);
  });
});
