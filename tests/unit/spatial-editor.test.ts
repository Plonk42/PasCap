import { describe, expect, it } from 'vitest';
import { applyCommand, type EditCommand } from '../../src/shared/commands.js';
import { uniformKeyframe, type Interpolation } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type VideoLayer } from '../../src/shared/model.js';
import {
  createSpatialSettings,
  defaultSpatialKeyframe,
  evaluateSpatial,
  NEUTRAL_SPATIAL_POSE,
  type SpatialKeyframe,
  type SpatialKeyValues,
  type SpatialSettings,
} from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { validateNumberDraft } from '../../src/web/NumberField.js';
import {
  editSpatialPose,
  moveSpatialKey,
  removeSpatialKey,
  resetSpatial,
  setSpatialEasing,
  setSpatialKeyValue,
  SPATIAL_CONTROLS,
  toggleDefaultSpatialKey,
  toggleSpatialChannel,
  withoutSpatialChannel,
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

const project = createProject('spatial-editor', 'Transform editor');

/** The track with this Transform. */
function track(transform: SpatialSettings = createSpatialSettings()): VideoLayer {
  return { ...structuredClone(project.layers[0]!), transform };
}

/** The track after the editor's commands, applied like edits. */
function edited(layer: VideoLayer, ...commands: EditCommand[]): VideoLayer {
  return commands.reduce(
    (current, command) => applyCommand(projectSchema.parse({ ...project, layers: [current] }), command).layers[0]!,
    layer,
  );
}

/** Applies each command a helper builds from the track as it is then. */
function edit(layer: VideoLayer, ...builds: ((current: VideoLayer) => EditCommand)[]): VideoLayer {
  return builds.reduce((current, build) => edited(current, build(current)), layer);
}

describe('per-setting track Transform editor', () => {
  it('previews one setting neutral at every frame for its hold-to-compare eye, other settings unchanged', () => {
    const settings = createSpatialSettings();
    expect(withoutSpatialChannel(track(settings), 'scale')).toBeNull();
    settings.base.scale = 1.5;
    settings.base.rotation = 20;
    settings.keyframes = [key(0, { scale: 2 }, 'linear'), key(10, { scale: 3, opacity: 0.5 }, 'smooth')];
    const without = edited(track(settings), ...withoutSpatialChannel(track(settings), 'scale')!).transform;
    expect(without.base).toEqual({ ...settings.base, scale: 1 });
    expect(without.keyframes).toEqual([key(10, { opacity: 0.5 }, 'smooth')]);
    for (const frame of [0, 5, 10, 20]) {
      expect(evaluateSpatial(without, frame)).toEqual({ ...evaluateSpatial(settings, frame), scale: 1 });
    }
    expect(withoutSpatialChannel(track(settings), 'translateX')).toBeNull();
  });
  it('exposes all nine exact value controls, Opacity included, and edits only the unanimated base', () => {
    expect(SPATIAL_CONTROLS.map((control) => control.key)).toEqual(Object.keys(NEUTRAL_SPATIAL_POSE));
    let layer = track();
    const values = [0.1234567, 0.2, 0.3, 0.4, 1.234567, -0.1234567, 0.1234567, 17.1234567, 0.4567891];
    for (const [index, control] of SPATIAL_CONTROLS.entries()) {
      expect(editSpatialPose(layer, null, control.key, values[index]!).type).toBe('transform-patch');
      layer = edit(layer, (current) => editSpatialPose(current, null, control.key, values[index]!));
      expect(layer.transform.base[control.key]).toBe(values[index]);
      expect(layer.transform.keyframes).toEqual([]);
    }
  });

  it('captures one setting’s evaluated value at a timeline frame', () => {
    const settings = createSpatialSettings();
    settings.base.scale = 1.5;
    settings.base.rotation = 20;
    settings.keyframes = [key(0, { scale: 1 }, 'linear'), key(10, { scale: 3 }, 'smooth')];
    const layer = track(settings);
    const scaled = edit(layer, (current) => toggleSpatialChannel(current, 'scale', 4));
    expect(scaled.transform.keyframes[1]).toEqual(key(4, { scale: evaluateSpatial(settings, 4).scale }, 'linear'));
    // Rotation is unkeyed, so its capture holds the base value and adds no other channel.
    const rotated = edit(layer, (current) => toggleSpatialChannel(current, 'rotation', 4));
    expect(rotated.transform.keyframes[1]).toEqual(key(4, { rotation: 20 }, 'linear'));
    expect(rotated.transform.base).toEqual(settings.base);
    // A second channel at the same frame joins the same key and adopts its agreed easing.
    const joined = edit(
      rotated,
      (current) => setSpatialEasing(current, 4, null, 'ease-in'),
      (current) => toggleSpatialChannel(current, 'translateX', 4),
    );
    expect(joined.transform.keyframes[1]).toEqual(key(4, { rotation: 20, translateX: 0 }, 'ease-in'));
  });

  it('removes only the toggled setting and the key itself once no setting remains', () => {
    let layer = edit(
      track(),
      (current) => toggleSpatialChannel(current, 'scale', 12),
      (current) => toggleSpatialChannel(current, 'rotation', 12),
      (current) => toggleSpatialChannel(current, 'scale', 12),
    );
    expect(layer.transform.keyframes).toEqual([key(12, { rotation: 0 }, 'linear')]);
    layer = edit(layer, (current) => toggleSpatialChannel(current, 'rotation', 12));
    expect(layer.transform).toEqual(createSpatialSettings());
  });

  it('never creates implicit keys and keeps each setting independent of the others', () => {
    const base = edit(track(), (current) => editSpatialPose(current, null, 'scale', 1.456789));
    const keyed = edit(base, (current) => toggleSpatialChannel(current, 'scale', 12));
    expect(() => editSpatialPose(keyed, 13, 'scale', 2)).toThrow('add a keyframe');
    // Unkeyed settings still edit their base even while another setting is animated.
    const moved = edit(keyed, (current) => editSpatialPose(current, 13, 'translateX', 0.25));
    expect(moved.transform.base.translateX).toBe(0.25);
    expect(moved.transform.keyframes).toEqual(keyed.transform.keyframes);
    const changed = edit(keyed, (current) => editSpatialPose(current, 12, 'scale', 2));
    expect(changed.transform.base).toEqual(keyed.transform.base);
    expect(changed.transform.keyframes[0]!.values.scale).toBe(2);
    expect(edit(changed, (current) => removeSpatialKey(current, 12))).toEqual(base);
  });

  it('interpolates each setting between its own keys, skipping keys that leave it out', () => {
    const { transform } = edit(
      track(),
      (current) => toggleSpatialChannel(current, 'scale', 0),
      (current) => toggleSpatialChannel(current, 'rotation', 10),
      (current) => toggleSpatialChannel(current, 'scale', 20),
      (current) => editSpatialPose(current, 20, 'scale', 3),
      (current) => editSpatialPose(current, 10, 'rotation', 90),
    );
    expect(evaluateSpatial(transform, 10).scale).toBe(2);
    expect(evaluateSpatial(transform, 10).rotation).toBe(90);
    expect(evaluateSpatial(transform, 15).scale).toBe(2.5);
    // Single-key settings hold everywhere; the base only returns for unkeyed settings.
    expect(evaluateSpatial(transform, 99).rotation).toBe(90);
    expect(evaluateSpatial(transform, 5).translateX).toBe(0);
  });

  it('moves a key and its easing atomically, rejects collisions, and keeps keys after the duration', () => {
    const layer = edit(
      track(),
      (current) => toggleSpatialChannel(current, 'translateX', 0),
      (current) => toggleSpatialChannel(current, 'translateX', 120),
      (current) => setSpatialKeyValue(current, 0, 'translateX', 0.5),
      (current) => setSpatialEasing(current, 0, null, 'ease-in'),
    );
    expect(layer.transform.keyframes[0]).toEqual(key(0, { translateX: 0.5 }, 'ease-in'));
    const moved = edit(layer, (current) => moveSpatialKey(current, 0, 90));
    expect(moved.transform.keyframes[0]).toEqual({ ...layer.transform.keyframes[0], frame: 90 });
    expect(moved.transform.base).toEqual(layer.transform.base);
    expect(() => moveSpatialKey(layer, 0, 120)).toThrow('already exists');
    expect(() => setSpatialKeyValue(layer, 5, 'translateX', 1)).toThrow('no longer exists');
    const document = projectSchema.parse({ ...project, clips: [createClip('one', 'source', 30, 60)], layers: [layer] });
    expect(document.layers[0]!.transform.keyframes.map((point) => point.frame)).toEqual([0, 120]);
    expect(calculateLayout(document).duration).toBe(30);
  });

  it('toggles a default keyframe without ever replacing an ordinary one', () => {
    const layer = edit(track(), (current) => toggleSpatialChannel(current, 'scale', 10));
    const added = edit(layer, (current) => toggleDefaultSpatialKey(current, 30));
    expect(added.transform.keyframes).toEqual([layer.transform.keyframes[0], defaultSpatialKeyframe(30)]);
    expect(edit(added, (current) => toggleDefaultSpatialKey(current, 30))).toEqual(layer);
    expect(() => toggleDefaultSpatialKey(layer, 10)).toThrow('already exists');
    // A default keyframe stays one while its values are edited.
    const changed = edit(added, (current) => editSpatialPose(current, 30, 'scale', 2));
    expect(changed.transform.keyframes[1]).toMatchObject({ frame: 30, reset: true, values: { scale: 2 } });
  });

  it('resets like Color: the whole base when unanimated, else only the keyframe at the playhead', () => {
    const base = edit(
      track(),
      (current) => editSpatialPose(current, null, 'scale', 2),
      (current) => editSpatialPose(current, null, 'rotation', 30),
    );
    expect(edit(base, (current) => resetSpatial(current, 0)!).transform).toEqual(createSpatialSettings());
    expect(resetSpatial(track(), 0)).toBeNull();
    const animated = edit(
      base,
      (current) => toggleSpatialChannel(current, 'scale', 10),
      (current) => editSpatialPose(current, 10, 'scale', 3),
      (current) => toggleSpatialChannel(current, 'translateX', 20),
      (current) => editSpatialPose(current, 20, 'translateX', 0.5),
    );
    const reset = edit(animated, (current) => resetSpatial(current, 10)!);
    expect(reset.transform.keyframes[0]!.values).toEqual({ ...NO_VALUES, scale: 1 });
    // Other keyframes, the easing and the saved base under keyed and unkeyed settings stay unchanged.
    expect(reset.transform.keyframes[1]).toEqual(animated.transform.keyframes[1]);
    expect(reset.transform.keyframes[0]!.easing).toEqual(animated.transform.keyframes[0]!.easing);
    expect(reset.transform.base).toEqual(animated.transform.base);
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
    const layer = track(settings);
    const before = structuredClone(layer);
    expect(() => edit(layer, (current) => editSpatialPose(current, null, setting, value))).toThrow();
    expect(layer).toEqual(before);
  });

  it('accepts opposite crops that cover nothing instead of repairing them', () => {
    const settings = createSpatialSettings();
    settings.base.cropRight = 0.6;
    const layer = edit(track(settings), (current) => editSpatialPose(current, null, 'cropLeft', 0.7));
    expect(layer.transform.base).toMatchObject({ cropLeft: 0.7, cropRight: 0.6 });
  });

  it('validates number drafts and pointer releases for an animated setting without publishing them', () => {
    const layer = edit(track(), (current) => toggleSpatialChannel(current, 'scale', 10));
    const validate = (value: number): string | null => {
      try {
        editSpatialPose(layer, 5, 'scale', value);
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
    const layer = track(settings);
    expect(() => edit(layer, (current) => toggleSpatialChannel(current, 'rotation', 256))).toThrow();
    expect(() => edit(layer, (current) => toggleDefaultSpatialKey(current, 256))).toThrow();
    // Joining an existing key adds no key, so it stays within the limit.
    expect(edit(layer, (current) => toggleSpatialChannel(current, 'rotation', 7)).transform.keyframes).toHaveLength(
      256,
    );
    expect(edit(layer, (current) => removeSpatialKey(current, 0)).transform.keyframes).toHaveLength(255);
  });
});
