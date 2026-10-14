import { describe, expect, it } from 'vitest';
import { EditHistory } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES, layerKeyframe, uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';
import { inspectKeyframe } from '../../src/web/keyframe-navigation.js';
import { removeSpatialKey, replaceSpatialKey } from '../../src/web/spatial-editor.js';
import {
  clipSpeedKeyframes,
  inspectSpatialKeyframe,
  reconcileSpatialInspection,
  trackTransformKeyframes,
  type SpatialInspection,
} from '../../src/web/spatial-navigation.js';

function fixture(frames: readonly number[] = [0, 2, 20, 30, 60, 76, 90, 120]): ProjectDocument {
  const project = createProject('spatial-navigation', 'Memory-only Transform navigation');
  project.media.videoIds = ['synthetic'];
  const clip = createClip('clip', 'synthetic', 30, 90);
  clip.start = 17;
  project.clips = [clip];
  const transform = project.layers[0]!.transform;
  transform.base.scale = 1.5;
  transform.keyframes = frames.map((frame) => ({
    ...uniformKeyframe(frame, { ...NEUTRAL_SPATIAL_POSE, scale: 2 }, 'linear'),
    reset: false,
  }));
  return project;
}

function context(project: ProjectDocument, epoch = 0): string {
  return `${project.id}:${project.layers[0]!.id}:${epoch}:transform`;
}

function stored(project: ProjectDocument) {
  return trackTransformKeyframes(project.layers[0]!, calculateLayout(project).duration);
}

function inspect(project: ProjectDocument, frame: number, observedFrame = 17): SpatialInspection {
  const inspection = inspectSpatialKeyframe(context(project), stored(project), frame, observedFrame);
  if (!inspection) throw new Error('Expected the synthetic stored Transform keyframe.');
  return inspection;
}

function reconcile(inspection: SpatialInspection | null, project: ProjectDocument, observedFrame = 17) {
  return reconcileSpatialInspection(inspection, context(project), stored(project), observedFrame, false);
}

function withTransform(
  project: ProjectDocument,
  produce: (transform: ProjectDocument['layers'][0]['transform']) => ProjectDocument['layers'][0]['transform'],
): ProjectDocument {
  const next = structuredClone(project);
  next.layers[0]!.transform = produce(next.layers[0]!.transform);
  return next;
}

describe('track-local Transform stored-keyframe cursor', () => {
  it('snapshots all stored keys and keeps stored time separate from the actual frame', () => {
    const project = fixture();
    const before = structuredClone(project);
    const cursor = inspect(project, 2);
    expect(cursor).toEqual({
      context: context(project),
      frame: 2,
      frames: [0, 2, 20, 30, 60, 76, 90, 120],
      observedFrame: 17,
      expectedFrame: 2,
    });
    expect(reconcile(cursor, project)).toBe(cursor);
    expect(project).toEqual(before);
  });

  it('retains every successive key after the duration despite coincident clamped previews', () => {
    const project = fixture();
    const keys = project.layers[0]!.transform.keyframes;
    expect(calculateLayout(project).duration).toBe(77);
    for (const key of [...keys, ...[...keys].reverse()]) {
      const cursor = inspect(project, key.frame);
      const arrived = reconcile(cursor, project, cursor.expectedFrame)!;
      expect(arrived.frame).toBe(key.frame);
      expect(arrived.frames).toEqual(keys.map((point) => point.frame));
      expect(arrived.expectedFrame).toBe(Math.min(key.frame, 76));
    }
    for (const frame of [76, 90, 120]) expect(inspect(project, frame).expectedFrame).toBe(76);
  });

  it('accepts the pending observation and seek result, then rejects the old observation', () => {
    const project = fixture();
    const cursor = inspect(project, 60);
    expect(cursor.expectedFrame).toBe(60);
    expect(reconcile(cursor, project)).toBe(cursor);
    const arrived = reconcile(cursor, project, 60)!;
    expect(arrived.observedFrame).toBe(60);
    expect(reconcile(arrived, project, 60)).toBe(arrived);
    expect(reconcile(arrived, project, 17)).toBeNull();
    expect(reconcile(arrived, project, 61)).toBeNull();
    expect(reconcile(null, project, 60)).toBeNull();
  });

  it.each([
    'other-project:video-1:0:transform',
    'spatial-navigation:other:0:transform',
    'spatial-navigation:video-1:1:transform',
  ])('clears context %s, including same-frame manual seeks through the source epoch', (nextContext) => {
    const project = fixture();
    const cleared = reconcileSpatialInspection(inspect(project, 2), nextContext, stored(project), 17, false);
    expect(cleared).toBeNull();
    expect(reconcile(cleared, project)).toBeNull();
  });

  it('clears immediately when playback starts or a central track inspection interrupts it', () => {
    const project = fixture();
    expect(reconcileSpatialInspection(inspect(project, 2), context(project), stored(project), 17, true)).toBeNull();
    project.layers[0]!.keyframes = [layerKeyframe(100, { ...EMPTY_KEY_VALUES, opacity: 0 }, 'linear')];
    const central = inspectKeyframe(project.id, project.layers[0]!, 100, 17, 77)!;
    const cursor = inspect(project, 2);
    expect(reconcileSpatialInspection(cursor, context(project), stored(project), 17, central !== null)).toBeNull();
    expect(cursor.frame).toBe(2);
    expect(central.frame).toBe(100);
  });

  it('does not select missing keys', () => {
    const project = fixture();
    expect(inspectSpatialKeyframe(context(project), stored(project), 12, 17)).toBeNull();
  });

  it('follows one selected key through reordering and Undo/Redo without seeking or changing its base', () => {
    const project = fixture([0, 20, 60, 120]);
    const history = new EditHistory(project);
    let cursor = inspect(project, 20);
    const transform = replaceSpatialKey(project.layers[0]!.transform, 20, { frame: 65 });
    history.commit({ type: 'transform', layerId: 'video-1', transform });
    cursor = reconcile(cursor, history.current)!;
    expect(cursor.frame).toBe(65);
    expect(cursor.frames).toEqual([0, 60, 65, 120]);
    expect(cursor.observedFrame).toBe(17);
    expect(cursor.expectedFrame).toBe(65);
    cursor = reconcile(cursor, history.undo())!;
    expect(cursor.frame).toBe(20);
    expect(cursor.expectedFrame).toBe(20);
    cursor = reconcile(cursor, history.redo())!;
    expect(cursor.frame).toBe(65);
    expect(history.current.layers[0]!.transform.base).toEqual(project.layers[0]!.transform.base);
  });

  it('updates the previous key list after unrelated changes before identifying a later selected-key move', () => {
    const project = fixture();
    const initial = inspect(project, 20);
    const unrelated = withTransform(project, (transform) => replaceSpatialKey(transform, 60, { frame: 65 }));
    const retained = reconcile(initial, unrelated)!;
    expect(retained.frame).toBe(20);
    expect(retained.frames).toContain(65);
    const moved = withTransform(unrelated, (transform) => replaceSpatialKey(transform, 20, { frame: 22 }));
    expect(reconcile(retained, moved)?.frame).toBe(22);
  });

  it('clears a deleted selected key permanently, including after Undo', () => {
    const project = fixture();
    const history = new EditHistory(project);
    const cursor = inspect(project, 20);
    history.commit({
      type: 'transform',
      layerId: 'video-1',
      transform: removeSpatialKey(project.layers[0]!.transform, 20),
    });
    const cleared = reconcile(cursor, history.current);
    expect(cleared).toBeNull();
    expect(reconcile(cleared, history.undo())).toBeNull();
    const replaced = withTransform(project, (transform) =>
      replaceSpatialKey(replaceSpatialKey(transform, 20, { frame: 22 }), 60, { frame: 65 }),
    );
    expect(reconcile(cursor, replaced)).toBeNull();
  });

  it('navigates retained clip speed keys, including off-trim and original OUT', () => {
    const project = fixture([60]);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.5, interpolation: 'linear' },
        { frame: 45, rate: 2, interpolation: 'smooth' },
        { frame: 120, rate: 1, interpolation: 'hold' },
      ],
    };
    const clip = project.clips[0]!;
    const speed = clipSpeedKeyframes(project, clip);
    const speedContext = `${project.id}:clip:0:speed`;
    expect(inspectSpatialKeyframe(speedContext, speed, 60, 17)).toBeNull();
    for (const frame of [0, 45, 120]) {
      const cursor = inspectSpatialKeyframe(speedContext, speed, frame, 17)!;
      expect(cursor).toMatchObject({
        frame,
        frames: [0, 45, 120],
        expectedFrame: previewClipSource(project, 'clip', frame),
      });
      const arrived = reconcileSpatialInspection(cursor, speedContext, speed, cursor.expectedFrame, false);
      expect(arrived?.frame).toBe(frame);
    }
    expect(clipSpeedKeyframes(project, { ...clip, id: 'foreign' }).frames).toEqual([]);
    expect(clipSpeedKeyframes(project, null).frames).toEqual([]);
    project.clips[0]!.speed = { mode: 'constant', rate: 1 };
    expect(clipSpeedKeyframes(project, project.clips[0]!).frames).toEqual([]);
  });

  it('adds no persisted fields, history entries, duration changes or edits while inspecting', () => {
    const history = new EditHistory(projectSchema.parse(fixture()));
    const before = structuredClone(history.current);
    const duration = calculateLayout(history.current).duration;
    for (const key of history.current.layers[0]!.transform.keyframes) {
      const cursor = inspect(history.current, key.frame);
      reconcile(cursor, history.current, cursor.expectedFrame);
    }
    expect(history.current).toEqual(before);
    expect(projectSchema.parse(history.current)).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(calculateLayout(history.current).duration).toBe(duration);
  });
});
