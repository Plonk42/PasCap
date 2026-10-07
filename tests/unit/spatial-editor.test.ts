import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { createSpatialSettings, evaluateSpatial, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';
import { validateNumberDraft } from '../../src/web/NumberField.js';
import {
  captureSpatialKey,
  editSpatialPose,
  removeSpatialKey,
  replaceSpatialKey,
  SPATIAL_CONTROLS,
  spatialPlayhead,
} from '../../src/web/spatial-editor.js';
import { createValueControlState, syncValueControlState, transitionValueControl } from '../../src/web/ValueControl.js';

describe('full-pose clip Transform editor', () => {
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

  it('captures the continuously evaluated full pose at a separate integer source identity', () => {
    const settings = createSpatialSettings();
    settings.base.scale = 1.5;
    settings.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...NEUTRAL_SPATIAL_POSE, scale: 1 } },
      { frame: 10, interpolation: 'smooth', values: { ...NEUTRAL_SPATIAL_POSE, scale: 3, rotation: 90 } },
    ];
    const before = structuredClone(settings);
    const captured = captureSpatialKey(settings, 4, 4.75);
    expect(captured.keyframes[1]).toEqual({
      frame: 4,
      interpolation: 'linear',
      values: evaluateSpatial(settings, 4.75),
    });
    expect(captured.base).toEqual(settings.base);
    expect(settings).toEqual(before);
    expect(() => captureSpatialKey(captured, 4, 4.9)).toThrow('already exists');
  });

  it('never creates implicit keys and preserves the base through editing and last-key deletion', () => {
    const base = editSpatialPose(createSpatialSettings(), null, 'scale', 1.456789);
    const keyed = captureSpatialKey(base, 12, 12.5);
    expect(() => editSpatialPose(keyed, 13, 'scale', 2)).toThrow('add a Transform keyframe');
    const edited = editSpatialPose(keyed, 12, 'scale', 2);
    expect(edited.base).toEqual(base.base);
    expect(edited.keyframes[0]!.values.scale).toBe(2);
    expect(removeSpatialKey(edited, 12)).toEqual(base);
  });

  it('moves the full pose and easing atomically, rejects collisions, and retains off-trim keys', () => {
    let settings = captureSpatialKey(createSpatialSettings(), 0, 0);
    settings = captureSpatialKey(settings, 120, 120);
    settings = replaceSpatialKey(settings, 0, {
      interpolation: 'ease-in',
      values: { ...NEUTRAL_SPATIAL_POSE, translateX: 0.5 },
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
    ['cropRight', 0.9],
    ['cropBottom', 0.9],
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

  it('validates invalid crop number drafts and pointer releases without publishing or discarding them', () => {
    const settings = createSpatialSettings();
    settings.base.cropRight = 0.6;
    const validate = (value: number): string | null => {
      try {
        editSpatialPose(settings, null, 'cropLeft', value);
        return null;
      } catch {
        return 'Crop must retain a positive source width and height.';
      }
    };
    expect(validateNumberDraft('0.456789', { min: 0, max: 1, validate }).valid).toBe(false);
    const context = { value: 0, min: 0, max: 1, step: 0.001, disabled: false, integer: false, resetKey: 'one:base' };
    let state = transitionValueControl(createValueControlState(context), { type: 'begin', pointerId: 7 }).state;
    const draft = transitionValueControl(state, { type: 'change', value: 0.456789 }, validate);
    expect(draft.commit).toBeNull();
    state = draft.state;
    const released = transitionValueControl(state, { type: 'finish', pointerId: 7 }, validate);
    expect(released.commit).toBeNull();
    expect(released.state.draft).toBe(0.456789);
    expect(released.state.error).toContain('positive');
    expect(syncValueControlState(state, { ...context, resetKey: 'two:base' }).pointer?.cancelled).toBe(true);
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

  it('bounds explicit capture at 256 whole-pose keys', () => {
    const settings = createSpatialSettings();
    settings.keyframes = Array.from({ length: 256 }, (_, frame) => ({
      frame,
      interpolation: 'linear',
      values: { ...NEUTRAL_SPATIAL_POSE },
    }));
    expect(() => captureSpatialKey(settings, 256, 256)).toThrow();
    expect(removeSpatialKey(settings, 0).keyframes).toHaveLength(255);
  });
});
