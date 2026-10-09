import { describe, expect, it, vi } from 'vitest';
import { updateClipSpeedKey } from '../../src/shared/clip-speed.js';
import { EditHistory } from '../../src/shared/commands.js';
import { activeLayerSetting, EMPTY_KEY_VALUES, type LayerKeyValues } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import * as timeline from '../../src/shared/timeline.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';
import { inspectKeyframe, reconcileKeyframeInspection } from '../../src/web/keyframe-navigation.js';
import {
  buildSpeedNavigationTargets,
  inspectSpeedTarget,
  previewPlacedSpeedSource,
  reconcileSpeedInspection,
  speedNavigationPosition,
  type SpeedNavigationContext,
} from '../../src/web/speed-navigation.js';

function point(frame: number, values: Partial<LayerKeyValues>) {
  return { frame, interpolation: 'linear' as const, values: { ...EMPTY_KEY_VALUES, ...values } };
}

function fixture(sourceIn = 30, sourceOut = 90, start = 17): ProjectDocument {
  const project = createProject('speed-navigation', 'Memory-only speed navigation');
  project.media.videoIds = ['synthetic'];
  const clip = createClip('clip', 'synthetic', sourceIn, sourceOut);
  clip.start = start;
  project.clips = [clip];
  return project;
}

function curve(project: ProjectDocument, frames: readonly number[], rate = 1): void {
  project.clips[0]!.speed = {
    mode: 'curve',
    keyframes: frames.map((frame) => ({ frame, rate, interpolation: 'linear' })),
  };
}

function context(project: ProjectDocument): SpeedNavigationContext {
  return {
    projectId: project.id,
    layerId: project.layers[0]!.id,
    clipId: project.clips[0]?.id ?? null,
    resetKey: 'editing-context',
  };
}

function targetsFor(project: ProjectDocument) {
  return buildSpeedNavigationTargets(project, project.clips[0] ?? null, project.layers[0]!);
}

describe('bounded Speed section target union', () => {
  it('creates no targets for neutral or ramp bases and skips unrelated track settings', () => {
    const project = fixture();
    project.layers[0]!.keyframes = [point(0, { opacity: 0 }), point(30, { temperature: 0, exposure: 1 })];
    expect(targetsFor(project)).toEqual([]);
    project.clips[0]!.speed = {
      mode: 'ramp',
      startRate: 0.5,
      endRate: 2,
      curve: 'linear',
      anchorIn: 0,
      anchorOut: 120,
    };
    expect(targetsFor(project)).toEqual([]);
    project.layers[0]!.keyframes.push(point(100, { speed: 1, opacity: 0 }));
    expect(targetsFor(project)).toEqual([{ id: 'track:100', frame: 100, source: null }]);
  });

  it('includes every retained source key, numerically ordered at coincident edges with track first', () => {
    const project = fixture();
    curve(project, [0, 2, 10, 29, 30, 60, 90, 91, 120]);
    project.layers[0]!.keyframes = [point(17, { speed: 1 }), point(40, { opacity: 0 }), point(76, { speed: 1 })];
    expect(targetsFor(project)).toEqual([
      { id: 'track:17', frame: 17, source: null },
      ...[0, 2, 10, 29, 30].map((source) => ({ id: `clip:${source}`, frame: 17, source })),
      { id: 'clip:60', frame: 47, source: 60 },
      { id: 'track:76', frame: 76, source: null },
      ...[90, 91, 120].map((source) => ({ id: `clip:${source}`, frame: 76, source })),
    ]);
  });

  it('keeps Speed keys reachable on an empty track without adding duration or clip targets', () => {
    const project = fixture();
    project.clips = [];
    project.layers[0]!.keyframes = [point(0, { opacity: 0 }), point(60, { speed: 1 }), point(100, { speed: 2 })];
    const targets = targetsFor(project);
    const central = inspectKeyframe(project.id, project.layers[0]!, 60, 0, 0)!;
    expect(targets.map((target) => target.frame)).toEqual([60, 100]);
    expect(timeline.calculateLayout(project).duration).toBe(0);
    expect(speedNavigationPosition(targets, context(project), 0, null, central).next?.frame).toBe(100);
  });

  it('does not adopt a selected clip from another track or a removed clip', () => {
    const project = fixture();
    curve(project, [0, 120]);
    const clip = project.clips[0]!;
    const layer = project.layers[0]!;
    expect(buildSpeedNavigationTargets(project, { ...clip, layerId: 'other' }, layer)).toEqual([]);
    expect(buildSpeedNavigationTargets({ ...project, clips: [] }, clip, layer)).toEqual([]);
  });

  it('compiles layout once and bounds mapping work by 512 keys even for a two-billion-frame source', () => {
    const project = fixture(0, 2_000_000_000, 0);
    curve(
      project,
      Array.from({ length: 256 }, (_, index) => index * 7_000_000),
    );
    project.layers[0]!.keyframes = Array.from({ length: 256 }, (_, index) => point(index * 7_000_000, { speed: 1 }));
    const layout = timeline.calculateLayout(project);
    const placed = layout.clips[0]!;
    const sourceAt = vi.fn(placed.retiming.sourceAt);
    const calculate = vi.spyOn(timeline, 'calculateLayout').mockReturnValue({
      ...layout,
      clips: [{ ...placed, retiming: { ...placed.retiming, sourceAt } }],
    });
    try {
      const targets = targetsFor(project);
      expect(calculate).toHaveBeenCalledTimes(1);
      expect(targets).toHaveLength(512);
      expect(sourceAt.mock.calls.length).toBeLessThanOrEqual(512);
      expect(sourceAt.mock.calls.length).toBeGreaterThan(0);
      expect(layout.duration).toBe(2_000_000_000);
    } finally {
      calculate.mockRestore();
    }
  });
});

describe('authoritative source preview mapping', () => {
  it.each([0.1, 0.3, 0.5, 1.125, 2, 8])('matches previewClipSource for every retained key at %s×', (rate) => {
    const project = fixture(10, 130, 7);
    curve(project, [0, 9, 10, 11, 40, 129, 130, 200], rate);
    const placed = timeline.calculateLayout(project).clips[0]!;
    for (const target of targetsFor(project)) {
      expect(target.frame).toBe(previewClipSource(project, 'clip', target.source!));
      expect(target.frame).toBe(previewPlacedSpeedSource(placed, target.source!));
      expect(target.frame).toBeGreaterThanOrEqual(placed.start);
      expect(target.frame).toBeLessThan(placed.end);
    }
    expect(targetsFor(project)[0]!.frame).toBe(7);
    expect(targetsFor(project).at(-1)!.frame).toBe(placed.end - 1);
  });

  it.each([
    { source: 1, rate: 0.3, output: 4, displayed: 1 },
    { source: 30, rate: 0.25, output: 120, displayed: 30 },
    { source: 1, rate: 4, output: 0, displayed: 0 },
    { source: 2, rate: 4, output: 0, displayed: 0 },
    { source: 3, rate: 4, output: 1, displayed: 4 },
  ])('maps held/skipped source $source at $rate× to output $output, with earlier ties', (test) => {
    const project = fixture(0, 120, 7);
    curve(project, [0, test.source, 120], test.rate);
    const placed = timeline.calculateLayout(project).clips[0]!;
    const target = targetsFor(project).find((item) => item.source === test.source)!;
    expect(target.frame).toBe(7 + test.output);
    expect(placed.retiming.sourceAt(target.frame - placed.start)).toBe(test.displayed);
    expect(target.source).toBe(test.source);
  });

  it('compares the inverse neighbour to find an exact image on a changing slow curve', () => {
    const project = fixture(0, 120, 7);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.5, interpolation: 'linear' },
        { frame: 60, rate: 0.75, interpolation: 'linear' },
        { frame: 120, rate: 1, interpolation: 'hold' },
      ],
    };
    const placed = timeline.calculateLayout(project).clips[0]!;
    const before = placed.retiming.outputAt(60);
    expect(placed.retiming.sourceAt(before)).toBe(59);
    const target = targetsFor(project).find((item) => item.source === 60)!;
    expect(target.frame).toBe(placed.start + before + 1);
    expect(placed.retiming.sourceAt(target.frame - placed.start)).toBe(60);
  });

  it('uses the overriding project-time track Speed map without dropping retained clip keys', () => {
    const project = fixture(10, 130, 20);
    curve(project, [0, 40, 130, 180], 8);
    project.layers[0]!.keyframes = [point(0, { speed: 0.5 }), point(30, { opacity: 0 }), point(100, { speed: 2 })];
    const placed = timeline.calculateLayout(project).clips[0]!;
    const targets = targetsFor(project);
    expect(placed.duration).toBe(84);
    expect(targets.find((target) => target.source === 40)!.frame).toBe(50);
    expect(targets.filter((target) => target.source !== null).map((target) => target.source)).toEqual([
      0, 40, 130, 180,
    ]);
    expect(targets.find((target) => target.source === 180)!.frame).toBe(placed.end - 1);
    expect(targets.some((target) => target.id === 'track:30')).toBe(false);
  });

  it('uses the selected suffix clip’s actual Ripple placement instead of its saved start', () => {
    const project = fixture(0, 60, 20);
    curve(project, [0, 30, 60]);
    const second = structuredClone(project.clips[0]!);
    second.id = 'second';
    second.start = 999;
    project.clips.push(second);
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: second.id, type: 'cut', duration: 0 }];
    project.layers[0]!.keyframes = [point(0, { speed: 0.5 }), point(100, { speed: 2 })];
    const layout = timeline.calculateLayout(project);
    const placed = layout.clips[1]!;
    const target = buildSpeedNavigationTargets(project, second, project.layers[0]!).find((item) => item.source === 30)!;
    expect(placed.start).toBe(layout.clips[0]!.end);
    expect(placed.start).not.toBe(second.start);
    expect(target.frame).toBe(previewClipSource(project, second.id, 30));
    expect(target.frame).toBe(previewPlacedSpeedSource(placed, 30));
  });

  it('previews the last held output at original exclusive OUT, never an out-of-range image', () => {
    const project = fixture(0, 120, 7);
    curve(project, [0, 120], 0.25);
    const placed = timeline.calculateLayout(project).clips[0]!;
    const target = targetsFor(project).at(-1)!;
    expect(target).toEqual({ id: 'clip:120', frame: 486, source: 120 });
    expect(placed.duration).toBe(480);
    expect(placed.retiming.sourceAt(target.frame - placed.start)).toBe(119);
  });
});

describe('editor-only Speed navigation cursors', () => {
  it('uses strict playhead neighbours until a stored target is explicitly inspected', () => {
    const project = fixture();
    curve(project, [0, 2, 10, 30, 60, 90, 120]);
    const targets = targetsFor(project);
    const position = speedNavigationPosition(targets, context(project), 17, null, null);
    expect(position.cursor).toBe(-1);
    expect(position.previous).toBeUndefined();
    expect(position.next?.source).toBe(60);
    expect(position.inspectedFrame).toBeNull();
  });

  it('traverses all coincident off-trim targets in both directions without changing the real playhead', () => {
    const project = fixture();
    curve(project, [0, 2, 10, 30, 60, 90, 91, 120]);
    const targets = targetsFor(project);
    const ctx = context(project);
    const duration = timeline.calculateLayout(project).duration;
    for (const [index, target] of targets.entries()) {
      const inspection = inspectSpeedTarget(ctx, targets, target, target.frame, duration)!;
      expect(reconcileSpeedInspection(inspection, ctx, targets, target.frame, duration, null)).toBe(inspection);
      const position = speedNavigationPosition(targets, ctx, target.frame, inspection, null);
      expect(position.previous).toBe(targets[index - 1]);
      expect(position.next).toBe(targets[index + 1]);
      expect(position.inspectedFrame).toBe(target.source);
      expect(inspection.observedFrame).toBe(target.frame);
    }
    const first = inspectSpeedTarget(ctx, targets, targets[0]!, 17, duration)!;
    expect(first.source).toBe(0);
    expect(timeline.calculateLayout(project).clips[0]!.retiming.sourceAt(0)).toBe(30);
  });

  it('sustains central track inspection through off-duration Speed keys, skipping opacity-only keys', () => {
    const project = fixture(0, 20, 0);
    const layer = project.layers[0]!;
    layer.keyframes = [
      point(10, { speed: 1 }),
      point(60, { speed: 1 }),
      point(80, { opacity: 0 }),
      point(100, { speed: 1 }),
    ];
    const targets = targetsFor(project);
    let central = inspectKeyframe(project.id, layer, 60, 19, 20)!;
    let position = speedNavigationPosition(targets, context(project), 19, null, central);
    expect(position.previous?.frame).toBe(10);
    expect(position.next?.frame).toBe(100);
    central = inspectKeyframe(project.id, layer, position.next!.frame, 19, 20)!;
    position = speedNavigationPosition(targets, context(project), 19, null, central);
    expect(position.previous?.frame).toBe(60);
    expect(position.next).toBeUndefined();
    expect(position.inspectedFrame).toBeNull();
    expect(central.expectedFrame).toBe(19);
    expect(activeLayerSetting(layer, 'speed', 19)).toBe(false);
    expect(inspectSpeedTarget(context(project), targets, targets[0]!, 19, 20)).toBeNull();
  });

  it('keeps the central and local cursors independent even at the same preview frame', () => {
    const project = fixture();
    curve(project, [0, 120]);
    project.layers[0]!.keyframes = [point(17, { speed: 1 }), point(100, { opacity: 0 })];
    const targets = targetsFor(project);
    const ctx = context(project);
    const local = inspectSpeedTarget(
      ctx,
      targets,
      targets.find((target) => target.source === 0)!,
      17,
      77,
    )!;
    const central = inspectKeyframe(project.id, project.layers[0]!, 17, 17, 77)!;
    expect(speedNavigationPosition(targets, ctx, 17, local, null).inspectedFrame).toBe(0);
    expect(speedNavigationPosition(targets, ctx, 17, local, central).inspectedFrame).toBeNull();
    expect(speedNavigationPosition(targets, ctx, 17, local, central).next?.source).toBe(0);
    expect(reconcileSpeedInspection(local, ctx, targets, 17, 77, central)).toBeNull();
    const foreign = { ...central, projectId: 'different' };
    expect(speedNavigationPosition(targets, ctx, 17, null, foreign).cursor).toBe(-1);
    expect(speedNavigationPosition(targets, ctx, 17, null, { ...central, layerId: 'different' }).cursor).toBe(-1);
  });

  it('accepts asynchronous seek diagnostics, then clears permanently on distinct manual seek or advancing playback', () => {
    const project = fixture();
    curve(project, [0, 40, 120]);
    const targets = targetsFor(project);
    const ctx = context(project);
    const target = targets.find((item) => item.source === 40)!;
    const local = inspectSpeedTarget(ctx, targets, target, 17, 77)!;
    expect(reconcileSpeedInspection(local, ctx, targets, 17, 77, null)).toBe(local);
    const arrived = reconcileSpeedInspection(local, ctx, targets, target.frame, 77, null)!;
    expect(arrived.observedFrame).toBe(target.frame);
    expect(reconcileSpeedInspection(arrived, ctx, targets, 17, 77, null)).toBeNull();
    expect(reconcileSpeedInspection(arrived, ctx, targets, target.frame + 1, 77, null)).toBeNull();
    expect(reconcileSpeedInspection(null, ctx, targets, target.frame, 77, null)).toBeNull();
  });

  it.each([
    { projectId: 'different' },
    { layerId: 'different' },
    { clipId: 'different' },
    { clipId: null },
    { resetKey: 'different' },
  ])('clears clip inspection on context change %j without reviving it when returning', (change) => {
    const project = fixture();
    curve(project, [0, 120]);
    const targets = targetsFor(project);
    const ctx = context(project);
    const local = inspectSpeedTarget(ctx, targets, targets[0]!, 17, 77)!;
    const cleared = reconcileSpeedInspection(local, { ...ctx, ...change }, targets, 17, 77, null);
    expect(cleared).toBeNull();
    expect(reconcileSpeedInspection(cleared, ctx, targets, 17, 77, null)).toBeNull();
  });

  it('retains a selected source-key move and Undo/Redo, but not deletion or later restoration', () => {
    const project = fixture();
    curve(project, [0, 20, 40, 120]);
    const history = new EditHistory(project);
    const targets = targetsFor(project);
    const ctx = context(project);
    let local = inspectSpeedTarget(
      ctx,
      targets,
      targets.find((target) => target.source === 20)!,
      17,
      77,
    )!;
    const speed = project.clips[0]!.speed;
    if (speed.mode !== 'curve') throw new Error('Expected the synthetic curve.');
    history.commit({ type: 'speed', clipId: 'clip', speed: updateClipSpeedKey(speed, 20, { frame: 22 }) });
    local = reconcileSpeedInspection(local, ctx, targetsFor(history.current), 17, 77, null)!;
    expect(local.source).toBe(22);
    local = reconcileSpeedInspection(local, ctx, targetsFor(history.undo()), 17, 77, null)!;
    expect(local.source).toBe(20);
    local = reconcileSpeedInspection(local, ctx, targetsFor(history.redo()), 17, 77, null)!;
    expect(local.source).toBe(22);
    history.commit({
      type: 'speed',
      clipId: 'clip',
      speed: { ...speed, keyframes: speed.keyframes.filter((key) => key.frame !== 20) },
    });
    expect(reconcileSpeedInspection(local, ctx, targetsFor(history.current), 17, 77, null)).toBeNull();
    expect(reconcileSpeedInspection(null, ctx, targetsFor(history.undo()), 17, 77, null)).toBeNull();
  });

  it('follows moved central track keys using the existing context reconciliation', () => {
    const project = fixture(0, 20, 0);
    project.layers[0]!.keyframes = [point(60, { speed: 1 }), point(100, { speed: 1 })];
    const history = new EditHistory(project);
    let central = inspectKeyframe(project.id, project.layers[0]!, 60, 19, 20)!;
    history.commit({ type: 'layer-key-move', layerId: project.layers[0]!.id, frame: 60, nextFrame: 70 });
    central = reconcileKeyframeInspection(central, history.current, central.layerId, 19, 20, false)!;
    expect(speedNavigationPosition(targetsFor(history.current), context(project), 19, null, central).next?.frame).toBe(
      100,
    );
    expect(central.frame).toBe(70);
    const restored = history.undo();
    central = reconcileKeyframeInspection(central, restored, central.layerId, 19, 20, false)!;
    expect(central.frame).toBe(60);
  });

  it('adds no save/history changes, persisted cursor fields or timing changes while navigating', () => {
    const project = fixture();
    curve(project, [0, 2, 10, 40, 90, 120]);
    project.layers[0]!.keyframes = [point(100, { speed: 1 }), point(200, { speed: 1 })];
    const history = new EditHistory(projectSchema.parse(project));
    const before = structuredClone(history.current);
    const duration = timeline.calculateLayout(history.current).duration;
    const targets = targetsFor(history.current);
    const ctx = context(history.current);
    for (const target of targets) {
      const preview = Math.min(target.frame, duration - 1);
      const local = inspectSpeedTarget(ctx, targets, target, preview, duration);
      const central =
        target.source === null
          ? inspectKeyframe(project.id, project.layers[0]!, target.frame, preview, duration)
          : null;
      const reconciled = reconcileSpeedInspection(local, ctx, targets, preview, duration, central);
      speedNavigationPosition(targets, ctx, preview, reconciled, central);
    }
    expect(history.current).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(timeline.calculateLayout(history.current).duration).toBe(duration);
    expect(projectSchema.parse(history.current)).toEqual(before);
  });
});
