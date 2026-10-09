import { describe, expect, it } from 'vitest';
import { EditHistory } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';
import { inspectKeyframe } from '../../src/web/keyframe-navigation.js';
import { removeSpatialKey, replaceSpatialKey, spatialPlayhead } from '../../src/web/spatial-editor.js';
import {
  inspectSpatialKeyframe,
  reconcileSpatialInspection,
  type SpatialInspection,
} from '../../src/web/spatial-navigation.js';

function fixture(frames: readonly number[] = [0, 2, 20, 30, 60, 90, 91, 120]): ProjectDocument {
  const project = createProject('spatial-navigation', 'Memory-only Transform navigation');
  project.media.videoIds = ['synthetic'];
  const clip = createClip('clip', 'synthetic', 30, 90);
  clip.start = 17;
  clip.spatial.base.scale = 1.5;
  clip.spatial.keyframes = frames.map((frame) => ({
    frame,
    interpolation: 'linear',
    values: { ...NEUTRAL_SPATIAL_POSE, scale: 2 },
  }));
  project.clips = [clip];
  return project;
}

function context(project: ProjectDocument, epoch = 0): string {
  return `${project.id}:${project.clips[0]?.id}:${epoch}`;
}

function inspect(project: ProjectDocument, source: number, observedFrame = 17): SpatialInspection {
  const inspection = inspectSpatialKeyframe(context(project), project, project.clips[0]!, source, observedFrame);
  if (!inspection) throw new Error('Expected the synthetic stored Transform keyframe.');
  return inspection;
}

function reconcile(inspection: SpatialInspection | null, project: ProjectDocument, observedFrame = 17) {
  return reconcileSpatialInspection(
    inspection,
    context(project),
    project,
    project.clips[0] ?? null,
    observedFrame,
    false,
    null,
  );
}

describe('clip-local Transform stored-source cursor', () => {
  it('snapshots all retained source keys and keeps stored source time separate from the actual frame', () => {
    const project = fixture();
    const before = structuredClone(project);
    const cursor = inspect(project, 2);
    expect(cursor).toEqual({
      context: context(project),
      frame: 2,
      frames: [0, 2, 20, 30, 60, 90, 91, 120],
      observedFrame: 17,
      expectedFrame: 17,
    });
    expect(spatialPlayhead(project, 'clip', cursor.expectedFrame)?.frame).toBe(30);
    expect(reconcile(cursor, project)).toBe(cursor);
    expect(project).toEqual(before);
  });

  it('retains every successive off-trim and original-OUT key despite coincident nearest previews', () => {
    const project = fixture();
    const keys = project.clips[0]!.spatial.keyframes;
    for (const key of [...keys, ...[...keys].reverse()]) {
      const cursor = inspect(project, key.frame);
      const arrived = reconcile(cursor, project, cursor.expectedFrame)!;
      expect(arrived.frame).toBe(key.frame);
      expect(arrived.frames).toEqual(keys.map((point) => point.frame));
      expect(arrived.expectedFrame).toBe(previewClipSource(project, 'clip', key.frame));
    }
    for (const source of [0, 2, 20, 30]) expect(inspect(project, source).expectedFrame).toBe(17);
    for (const source of [90, 91, 120]) expect(inspect(project, source).expectedFrame).toBe(76);
    expect(spatialPlayhead(project, 'clip', inspect(project, 120).expectedFrame)?.frame).toBe(89);
  });

  it('accepts the pending observation and nearest seek result, then rejects the old observation', () => {
    const project = fixture();
    const cursor = inspect(project, 60);
    expect(cursor.expectedFrame).toBe(47);
    expect(reconcile(cursor, project)).toBe(cursor);
    const arrived = reconcile(cursor, project, 47)!;
    expect(arrived.observedFrame).toBe(47);
    expect(reconcile(arrived, project, 47)).toBe(arrived);
    expect(reconcile(arrived, project, 17)).toBeNull();
    expect(reconcile(arrived, project, 48)).toBeNull();
    expect(reconcile(null, project, 47)).toBeNull();
  });

  it.each(['other-project:clip:0', 'spatial-navigation:other-clip:0', 'spatial-navigation:clip:1'])(
    'clears context %s, including same-frame manual seeks through the source epoch',
    (nextContext) => {
      const project = fixture();
      const cleared = reconcileSpatialInspection(
        inspect(project, 2),
        nextContext,
        project,
        project.clips[0]!,
        17,
        false,
        null,
      );
      expect(cleared).toBeNull();
      expect(reconcile(cleared, project)).toBeNull();
    },
  );

  it('clears immediately when playback starts, even before the actual frame advances', () => {
    const project = fixture();
    const cleared = reconcileSpatialInspection(
      inspect(project, 2),
      context(project),
      project,
      project.clips[0]!,
      17,
      true,
      null,
    );
    expect(cleared).toBeNull();
    expect(reconcile(cleared, project)).toBeNull();
  });

  it('clears for any central track inspection without substituting its stored time', () => {
    const project = fixture();
    project.layers[0]!.keyframes = [
      { frame: 100, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, opacity: 0 } },
    ];
    const central = inspectKeyframe(project.id, project.layers[0]!, 100, 17, 77)!;
    const cursor = inspect(project, 2);
    for (const inspection of [central, { ...central, projectId: 'foreign', layerId: 'foreign' }])
      expect(
        reconcileSpatialInspection(cursor, context(project), project, project.clips[0]!, 17, false, inspection),
      ).toBeNull();
    expect(cursor.frame).toBe(2);
    expect(central.frame).toBe(100);
  });

  it('does not select missing keys or adopt a foreign, removed or absent clip', () => {
    const project = fixture();
    const clip = project.clips[0]!;
    const cursor = inspect(project, 2);
    expect(inspectSpatialKeyframe(context(project), project, clip, 12, 17)).toBeNull();
    for (const foreign of [null, { ...clip, id: 'foreign' }, { ...clip, layerId: 'foreign' }]) {
      expect(inspectSpatialKeyframe(context(project), project, foreign, 2, 17)).toBeNull();
      expect(reconcileSpatialInspection(cursor, context(project), project, foreign, 17, false, null)).toBeNull();
    }
    const removed = { ...project, clips: [] };
    expect(inspectSpatialKeyframe(context(project), removed, clip, 2, 17)).toBeNull();
    expect(reconcileSpatialInspection(cursor, context(project), removed, clip, 17, false, null)).toBeNull();
  });

  it('follows one selected key through reordering and Undo/Redo without seeking or changing its base', () => {
    const project = fixture([0, 20, 60, 120]);
    const history = new EditHistory(project);
    let cursor = inspect(project, 20);
    const spatial = replaceSpatialKey(project.clips[0]!.spatial, 20, { frame: 65 });
    history.commit({ type: 'spatial', clipId: 'clip', spatial });
    cursor = reconcile(cursor, history.current)!;
    expect(cursor.frame).toBe(65);
    expect(cursor.frames).toEqual([0, 60, 65, 120]);
    expect(cursor.observedFrame).toBe(17);
    expect(cursor.expectedFrame).toBe(52);
    cursor = reconcile(cursor, history.undo())!;
    expect(cursor.frame).toBe(20);
    expect(cursor.expectedFrame).toBe(17);
    cursor = reconcile(cursor, history.redo())!;
    expect(cursor.frame).toBe(65);
    expect(history.current.clips[0]!.spatial.base).toEqual(project.clips[0]!.spatial.base);
    expect(spatialPlayhead(history.current, 'clip', cursor.observedFrame)?.frame).toBe(30);
  });

  it('retains both old and updated nearest observations while a moved key is reconciled', () => {
    const project = fixture();
    const cursor = inspect(project, 60, 47);
    const moved = structuredClone(project);
    moved.clips[0]!.spatial = replaceSpatialKey(moved.clips[0]!.spatial, 60, { frame: 65 });
    const pending = reconcile(cursor, moved, 47)!;
    expect(pending.frame).toBe(65);
    expect(pending.expectedFrame).toBe(52);
    const arrived = reconcile(pending, moved, 52)!;
    expect(arrived.observedFrame).toBe(52);
    expect(reconcile(arrived, moved, 47)).toBeNull();
    expect(reconcile(cursor, moved, 50)).toBeNull();
  });

  it('updates the previous key list after unrelated changes before identifying a later selected-key move', () => {
    const project = fixture();
    const initial = inspect(project, 20);
    const unrelated = structuredClone(project);
    unrelated.clips[0]!.spatial = replaceSpatialKey(unrelated.clips[0]!.spatial, 60, { frame: 65 });
    const retained = reconcile(initial, unrelated)!;
    expect(retained.frame).toBe(20);
    expect(retained.frames).toContain(65);
    const moved = structuredClone(unrelated);
    moved.clips[0]!.spatial = replaceSpatialKey(moved.clips[0]!.spatial, 20, { frame: 22 });
    expect(reconcile(retained, moved)?.frame).toBe(22);
  });

  it('clears a deleted selected key permanently, including after Undo', () => {
    const project = fixture();
    const history = new EditHistory(project);
    const cursor = inspect(project, 20);
    history.commit({ type: 'spatial', clipId: 'clip', spatial: removeSpatialKey(project.clips[0]!.spatial, 20) });
    const cleared = reconcile(cursor, history.current);
    expect(cleared).toBeNull();
    expect(reconcile(cleared, history.undo())).toBeNull();
    const replaced = structuredClone(project);
    replaced.clips[0]!.spatial = replaceSpatialKey(replaced.clips[0]!.spatial, 20, { frame: 22 });
    replaced.clips[0]!.spatial = replaceSpatialKey(replaced.clips[0]!.spatial, 60, { frame: 65 });
    expect(reconcile(cursor, replaced)).toBeNull();
  });

  it.each([0.25, 1.125, 4, 8])('keeps authoritative nearest previews under a %s× track override', (rate) => {
    const project = fixture([0, 31, 32, 33, 60, 90, 120]);
    project.layers[0]!.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: rate } },
    ];
    const placed = calculateLayout(project).clips[0]!;
    for (const key of project.clips[0]!.spatial.keyframes) {
      const cursor = inspect(project, key.frame);
      expect(cursor.expectedFrame).toBe(previewClipSource(project, 'clip', key.frame));
      expect(cursor.expectedFrame).toBeGreaterThanOrEqual(placed.start);
      expect(cursor.expectedFrame).toBeLessThan(placed.end);
      expect(reconcile(cursor, project, cursor.expectedFrame)?.frame).toBe(key.frame);
    }
    expect(inspect(project, 120).expectedFrame).toBe(placed.end - 1);
    expect(spatialPlayhead(project, 'clip', placed.end - 1)!.frame).toBeLessThan(90);
  });

  it('adds no persisted fields, history entries, duration changes or edits while inspecting', () => {
    const history = new EditHistory(projectSchema.parse(fixture()));
    const before = structuredClone(history.current);
    const duration = calculateLayout(history.current).duration;
    for (const key of history.current.clips[0]!.spatial.keyframes) {
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
