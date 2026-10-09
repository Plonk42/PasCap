import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { createSpatialSettings, evaluateSpatial, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';
import { validateNumberDraft } from '../../src/web/NumberField.js';
import {
  editSpatialPose,
  removeSpatialKey,
  replaceSpatialKey,
  SPATIAL_CONTROLS,
  spatialPlayhead,
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
};

describe('per-setting clip Transform editor', () => {
  it('exposes all eight exact value controls and edits only the unanimated base', () => {
    expect(SPATIAL_CONTROLS.map((control) => control.key)).toEqual(Object.keys(NEUTRAL_SPATIAL_POSE));
    let settings = createSpatialSettings();
    const values = [0.1234567, 0.2, 0.3, 0.4, 1.234567, -0.1234567, 0.1234567, 17.1234567];
    for (const [index, control] of SPATIAL_CONTROLS.entries()) {
      settings = editSpatialPose(settings, null, control.key, values[index]!);
      expect(settings.base[control.key]).toBe(values[index]);
      expect(settings.keyframes).toEqual([]);
    }
  });

  it('captures one continuously evaluated setting at a separate integer source identity', () => {
    const settings = createSpatialSettings();
    settings.base.scale = 1.5;
    settings.base.rotation = 20;
    settings.keyframes = [
      {
        frame: 0,
        interpolation: 'linear',
        values: { ...NO_VALUES, scale: 1 },
      },
      { frame: 10, interpolation: 'smooth', values: { ...NO_VALUES, scale: 3 } },
    ];
    const before = structuredClone(settings);
    const scaled = toggleSpatialChannel(settings, 'scale', 4, 4.75);
    // Scale already had a key set at 4: it joins as a new key, capturing only that channel.
    expect(scaled.keyframes[1]).toEqual({
      frame: 4,
      interpolation: 'linear',
      values: { ...NO_VALUES, scale: evaluateSpatial(settings, 4.75).scale },
    });
    // Rotation is unkeyed, so its capture holds the base value and adds no other channel.
    const rotated = toggleSpatialChannel(settings, 'rotation', 4, 4.75);
    expect(rotated.keyframes[1]).toEqual({
      frame: 4,
      interpolation: 'linear',
      values: { ...NO_VALUES, rotation: 20 },
    });
    expect(rotated.base).toEqual(settings.base);
    expect(settings).toEqual(before);
    // A second channel at the same frame joins the same key and keeps its easing.
    const eased = replaceSpatialKey(rotated, 4, { interpolation: 'ease-in' });
    const joined = toggleSpatialChannel(eased, 'translateX', 4, 4.75);
    expect(joined.keyframes[1]).toEqual({
      frame: 4,
      interpolation: 'ease-in',
      values: { ...NO_VALUES, rotation: 20, translateX: 0 },
    });
  });

  it('removes only the toggled setting and the key itself once no setting remains', () => {
    let settings = toggleSpatialChannel(createSpatialSettings(), 'scale', 12, 12);
    settings = toggleSpatialChannel(settings, 'rotation', 12, 12);
    settings = toggleSpatialChannel(settings, 'scale', 12, 12);
    expect(settings.keyframes).toEqual([{ frame: 12, interpolation: 'linear', values: { ...NO_VALUES, rotation: 0 } }]);
    settings = toggleSpatialChannel(settings, 'rotation', 12, 12);
    expect(settings).toEqual(createSpatialSettings());
  });

  it('never creates implicit keys and keeps each setting independent of the others', () => {
    const base = editSpatialPose(createSpatialSettings(), null, 'scale', 1.456789);
    const keyed = toggleSpatialChannel(base, 'scale', 12, 12.5);
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
    let settings = toggleSpatialChannel(createSpatialSettings(), 'scale', 0, 0);
    settings = toggleSpatialChannel(settings, 'rotation', 10, 10);
    settings = toggleSpatialChannel(settings, 'scale', 20, 20);
    settings = editSpatialPose(settings, 20, 'scale', 3);
    settings = editSpatialPose(settings, 10, 'rotation', 90);
    expect(evaluateSpatial(settings, 10).scale).toBe(2);
    expect(evaluateSpatial(settings, 10).rotation).toBe(90);
    expect(evaluateSpatial(settings, 15).scale).toBe(2.5);
    // Single-key settings hold everywhere; the base only returns for unkeyed settings.
    expect(evaluateSpatial(settings, 99).rotation).toBe(90);
    expect(evaluateSpatial(settings, 5).translateX).toBe(0);
  });

  it('moves a key and its easing atomically, rejects collisions, and retains off-trim keys', () => {
    let settings = toggleSpatialChannel(createSpatialSettings(), 'translateX', 0, 0);
    settings = toggleSpatialChannel(settings, 'translateX', 120, 120);
    settings = replaceSpatialKey(settings, 0, {
      interpolation: 'ease-in',
      values: { ...NO_VALUES, translateX: 0.5 },
    });
    const moved = replaceSpatialKey(settings, 0, { frame: 90 });
    expect(moved.keyframes[0]).toEqual({ ...settings.keyframes[0], frame: 90 });
    expect(moved.base).toEqual(settings.base);
    expect(() => replaceSpatialKey(settings, 0, { frame: 120 })).toThrow('already exists');
    const project = createProject('spatial-editor', 'Transform editor');
    const clip = createClip('one', 'source', 30, 60);
    project.clips = [clip];
    const next = applyCommand(project, { type: 'spatial', clipId: clip.id, spatial: settings });
    expect(next.clips[0]!.spatial.keyframes.map((key) => key.frame)).toEqual([0, 120]);
    expect(calculateLayout(next).duration).toBe(calculateLayout(project).duration);
    expect(previewClipSource(next, clip.id, 0)).toBe(0);
    expect(previewClipSource(next, clip.id, 120)).toBe(29);
    expect(next.layers).toEqual(project.layers);
  });

  it.each([
    ['cropLeft', 1],
    ['cropRight', 1],
    ['cropBottom', -0.1],
    ['scale', 0.09],
    ['translateX', -2.01],
    ['translateY', 2.01],
    ['rotation', 180.01],
  ] as const)('rejects invalid %s %s without clamping or modifying the source pose', (key, value) => {
    const settings = createSpatialSettings();
    settings.base.cropLeft = 0.2;
    settings.base.cropTop = 0.2;
    const before = structuredClone(settings);
    expect(() => editSpatialPose(settings, null, key, value)).toThrow();
    expect(settings).toEqual(before);
  });

  it('accepts opposite crops that cover nothing instead of repairing them', () => {
    const settings = createSpatialSettings();
    settings.base.cropRight = 0.6;
    const edited = editSpatialPose(settings, null, 'cropLeft', 0.7);
    expect(edited.base).toMatchObject({ cropLeft: 0.7, cropRight: 0.6 });
  });

  it('validates number drafts and pointer releases for an animated setting without publishing them', () => {
    const settings = toggleSpatialChannel(createSpatialSettings(), 'scale', 10, 10);
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
    expect(syncValueControlState(state, { ...context, resetKey: 'two:5' }).pointer?.cancelled).toBe(true);
  });

  it('uses the actual retiming source identity and continuous position, with no fictional off-clip frame', () => {
    const project = createProject('source-position', 'Source position');
    const clip = createClip('one', 'source', 20, 40);
    clip.speed = { mode: 'constant', rate: 0.75 };
    project.clips = [clip];
    const placed = calculateLayout(project).clips[0]!;
    expect(spatialPlayhead(project, clip.id, 1)).toEqual({
      frame: placed.retiming.sourceAt(1),
      position: placed.retiming.sourcePositionAt(1),
    });
    expect(spatialPlayhead(project, clip.id, -1)).toBeNull();
    expect(spatialPlayhead(project, clip.id, placed.end)).toBeNull();
    expect(spatialPlayhead(project, 'missing', 0)).toBeNull();
  });

  it('bounds explicit capture at 256 keys', () => {
    const settings = createSpatialSettings();
    settings.keyframes = Array.from({ length: 256 }, (_, frame) => ({
      frame,
      interpolation: 'linear',
      values: { ...NO_VALUES, scale: 1 },
    }));
    expect(() => toggleSpatialChannel(settings, 'rotation', 256, 256)).toThrow();
    // Joining an existing key adds no key, so it stays within the limit.
    expect(toggleSpatialChannel(settings, 'rotation', 7, 7).keyframes).toHaveLength(256);
    expect(removeSpatialKey(settings, 0).keyframes).toHaveLength(255);
  });
});
