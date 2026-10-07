import { describe, expect, it } from 'vitest';
import { musicGainAt, musicSourceFrame } from '../../src/shared/audio.js';
import { applyCommand } from '../../src/shared/commands.js';
import {
  EMPTY_KEY_VALUES,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { compileLayerRetiming } from '../../src/shared/layer-retiming.js';
import { createClip, createLayer, createProject, projectSchema, type VideoLayer } from '../../src/shared/model.js';
import { snapFrame, snapPoints } from '../../src/shared/snap.js';
import { trimByOutputFrames } from '../../src/shared/source-range.js';
import { clipDuration, compileRetiming, curveValue, sourceFrameAt } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { unsupportedProject } from './project-fixtures.js';

function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function row(keyframes: LayerKeyframe[]): VideoLayer {
  return { ...createLayer('video-1', 'Video 1'), keyframes };
}

describe('shared retiming and recoverable speed edits', () => {
  it('requires explicit v8 static speed settings; earlier documents are not guessed', () => {
    const project = createProject('flight', 'Flight');
    expect(project.schemaVersion).toBe(8);
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7])
      expect(() => projectSchema.parse({ ...project, schemaVersion })).toThrow();
    expect(() => projectSchema.parse(unsupportedProject(4, 'old-flight', 'Unsupported flight'))).toThrow();
    const clip = createClip('a', 'source', 0, 600);
    const { speed: _speed, ...incomplete } = clip;
    expect(() => projectSchema.parse({ ...project, clips: [incomplete] })).toThrow();
  });
  it('doubles/halves output duration with nearest interval source-frame sampling', () => {
    const original = createClip('a', 'source', 10, 610);
    const slow = { ...original, speed: { mode: 'constant' as const, rate: 0.5 } };
    const fast = { ...original, speed: { mode: 'constant' as const, rate: 2 } };
    expect(clipDuration(slow)).toBe(1200);
    expect(clipDuration(fast)).toBe(300);
    expect([0, 1, 2, 1199].map((frame) => sourceFrameAt(slow, frame))).toEqual([10, 10, 11, 609]);
    expect([0, 1, 299].map((frame) => sourceFrameAt(fast, frame))).toEqual([10, 12, 608]);
    expect(trimByOutputFrames(fast, 'out', -30, 700).sourceOut).toBe(550);
  });
  for (const curve of ['linear', 'ease-in', 'ease-out', 'smooth'] as const) {
    it(`compiles monotonic ${curve} ramps, preserving source anchors while trimming`, () => {
      const clip = {
        ...createClip('a', 'source', 0, 600),
        speed: { mode: 'ramp' as const, startRate: 0.5, endRate: 2, curve, anchorIn: 0, anchorOut: 600 },
      };
      const map = compileRetiming(clip);
      const samples = Array.from({ length: map.duration }, (_, frame) => map.sourceAt(frame));
      expect(samples.every((source, frame) => frame === 0 || source >= samples[frame - 1]!)).toBe(true);
      expect(samples[0]).toBe(0);
      expect(samples.at(-1)).toBeLessThan(600);
      expect(map.duration).toBeGreaterThan(300);
      expect(map.duration).toBeLessThan(1200);
      const trimmed = { ...clip, sourceIn: 150, sourceOut: 510 };
      expect(trimmed.speed).toEqual(clip.speed);
      expect(clipDuration(trimmed)).toBeLessThan(map.duration);
      expect(curveValue(0, curve)).toBe(0);
      expect(curveValue(1, curve)).toBe(1);
    });
  }
  it('retimes transitions in output frames and supports independent per-clip colour/speed undo', () => {
    let project = applyCommand(createProject('p', 'P'), {
      type: 'insert',
      clip: createClip('a', 'source', 0, 120),
      index: 0,
    });
    project = applyCommand(project, { type: 'insert', clip: createClip('b', 'source', 0, 120), index: 1 });
    project = applyCommand(project, { type: 'speed', clipId: 'a', speed: { mode: 'constant', rate: 2 } });
    project = applyCommand(project, {
      type: 'transition',
      transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 30 },
    });
    expect(calculateLayout(project).duration).toBe(150);
    expect(sampleTimeline(project, 45).map((layer) => [layer.sourceFrame, layer.weight])).toEqual([
      [90, 0.5],
      [15, 0.5],
    ]);
    expect(() => applyCommand(project, { type: 'speed', clipId: 'a', speed: { mode: 'constant', rate: 8 } })).toThrow();
    expect(project.clips[1]?.speed).toEqual({ mode: 'constant', rate: 1 });
  });
  it('compiled cache entries do not retain mutable editor ranges or ramp settings', () => {
    const clip = {
      ...createClip('mutable', 'source', 0, 75),
      speed: {
        mode: 'ramp' as const,
        startRate: 0.5,
        endRate: 2,
        curve: 'smooth' as const,
        anchorIn: 0,
        anchorOut: 75,
      },
    };
    const map = compileRetiming(clip);
    const before = [map.duration, map.sourceAt(30), map.rateAt(30)];
    clip.sourceOut = 60;
    clip.speed.endRate = 5;
    expect([map.duration, map.sourceAt(30), map.rateAt(30)]).toEqual(before);
  });
});

describe('absolute-project row speed integration', () => {
  it.each([
    { interpolation: 'hold', source: 60, rate: 1 },
    { interpolation: 'linear', source: 110, rate: 2.5 },
    { interpolation: 'ease-in', source: 87, rate: 2.125 },
    { interpolation: 'ease-out', source: 132, rate: 2.875 },
    { interpolation: 'smooth', source: 110, rate: 2.6875 },
  ] as const)(
    'integrates $interpolation rate in project time without inserting unrelated parameter anchors',
    ({ interpolation, source, rate }) => {
      const clip = createClip('absolute', 'source', 10, 610);
      clip.speed = { mode: 'constant', rate: 8 };
      const layer = row([
        point(0, { speed: 1 }, interpolation),
        point(40, { hue: 45, opacity: 0.6 }, 'hold'),
        point(100, { speed: 3 }, 'hold'),
      ]);
      const before = structuredClone(layer.keyframes);
      const map = compileLayerRetiming(clip, layer, 25);
      // Between project frames 25 and 75, consume the integral of 1 + 2*easing(t/100).
      expect(map.sourceAt(50)).toBe(source);
      expect(map.rateAt(50)).toBe(rate);
      expect(map.duration).toBeGreaterThan(compileRetiming(clip).duration);
      const samples = Array.from({ length: map.duration }, (_, frame) => map.sourceAt(frame));
      expect(samples[0]).toBe(10);
      expect(samples.at(-1)).toBeLessThan(610);
      expect(
        samples.every(
          (sourceFrame, frame) =>
            sourceFrame >= 10 && sourceFrame < 610 && (frame === 0 || sourceFrame >= samples[frame - 1]!),
        ),
      ).toBe(true);
      expect(map.outputAt(map.sourceAt(50))).toBeGreaterThanOrEqual(49);
      expect(map.outputAt(map.sourceAt(50))).toBeLessThanOrEqual(50);
      expect(layer.keyframes).toEqual(before);
    },
  );

  it('rounds only the final duration and never rescales a participating row rate to fit it', () => {
    const clip = createClip('rounded', 'source', 0, 5);
    const layer = row([point(40, { speed: 3 }, 'hold')]);
    const map = compileLayerRetiming(clip, layer, 40);
    expect(map.duration).toBe(2);
    expect(map.sourceAt(1)).toBe(3);
    expect(map.rateAt(1)).toBe(3);
    const staticMap = compileRetiming({ ...clip, speed: { mode: 'constant', rate: 3 } });
    expect(staticMap.duration).toBe(2);
    expect(staticMap.sourceAt(1)).toBe(2);
    expect(staticMap.rateAt(1)).toBe(2.5);
    expect(layer.keyframes[0]!.frame).toBe(40);
    expect(layer.keyframes[0]!.values.speed).toBe(3);
  });

  it('moving a clip recompiles from its new absolute start without moving or source-anchoring the row points', () => {
    let project = applyCommand(createProject('moving', 'Moving'), {
      type: 'insert',
      clip: createClip('base', 'source', 0, 200),
      index: 0,
    });
    project = applyCommand(project, {
      type: 'layer-add',
      layer: {
        ...row([point(0, { speed: 1, opacity: 0 }), point(100, { speed: 3, opacity: 1 }, 'hold')]),
        id: 'upper',
        name: 'Upper',
        ripple: false,
      },
    });
    project = applyCommand(project, {
      type: 'insert',
      clip: { ...createClip('overlay', 'source', 10, 85), layerId: 'upper' },
      index: 1,
    });
    const keys = structuredClone(project.layers[1]!.keyframes);
    const original = calculateLayout(project).clips[1]!;
    expect(original.duration).toBe(50);
    expect(original.retiming.sourceAt(25)).toBe(41);
    const moved = applyCommand(project, { type: 'place', clipId: 'overlay', layerId: 'upper', start: 50, index: 1 });
    const placed = calculateLayout(moved).clips[1]!;
    expect(placed).toMatchObject({ start: 50, duration: 32, end: 82 });
    expect(placed.retiming.sourceAt(25)).toBe(66);
    expect(placed.retiming.rateAt(25)).toBe(2.5);
    expect(sampleTimeline(moved, 75).find((sample) => sample.clipId === 'overlay')).toMatchObject({
      sourceFrame: 66,
      opacity: 0.75,
    });
    expect(sampleTimeline(moved, 81).find((sample) => sample.clipId === 'overlay')?.sourceFrame).toBe(81);
    expect(moved.layers[1]!.keyframes).toEqual(keys);
    expect(project.layers[1]!.keyframes).toEqual(keys);
  });

  it('retains the exact constant/ramp cache when no row speed participates', () => {
    const layer = row([point(0, { exposure: 1, opacity: 0.5 }), point(200, { hue: 90 }, 'hold')]);
    for (const speed of [
      { mode: 'constant' as const, rate: 2.5 },
      { mode: 'ramp' as const, startRate: 0.4, endRate: 3, anchorIn: 2, anchorOut: 42, curve: 'smooth' as const },
    ]) {
      const clip = { ...createClip('fallback', 'source', 7, 37), speed };
      expect(compileLayerRetiming(clip, layer, 25)).toBe(compileRetiming(clip));
      expect(compileLayerRetiming(clip, layer, 125)).toBe(compileRetiming(clip));
    }
  });

  it('owns copied row rates/ranges, caches by placement and ignores non-speed participation', () => {
    const clip = createClip('captured', 'source', 10, 110);
    const layer = row([
      point(0, { speed: 0.5 }, 'smooth'),
      point(40, { hue: 45 }, 'hold'),
      point(100, { speed: 2 }, 'hold'),
    ]);
    const map = compileLayerRetiming(clip, layer, 25);
    const before = [map.duration, map.sourceAt(30), map.outputAt(50), map.rateAt(30)];
    expect(Object.isFrozen(map)).toBe(true);
    expect(compileLayerRetiming(structuredClone(clip), structuredClone(layer), 25)).toBe(map);
    expect(compileLayerRetiming(clip, layer, 50)).not.toBe(map);
    layer.keyframes[0]!.values.exposure = 1;
    layer.keyframes[1]!.frame = 50;
    expect(compileLayerRetiming(clip, layer, 25)).toBe(map);
    layer.keyframes[0]!.values.speed = 7;
    layer.keyframes[2]!.frame = 120;
    clip.sourceOut = 90;
    expect([map.duration, map.sourceAt(30), map.outputAt(50), map.rateAt(30)]).toEqual(before);
    expect(compileLayerRetiming(clip, layer, 25)).not.toBe(map);
  });
});

describe('music and snapping', () => {
  const music = {
    id: 'song-instance',
    mediaId: 'song',
    sourceIn: 30,
    sourceOut: 90,
    start: 10,
    duration: 120,
    gainDb: -6,
    fadeIn: 20,
    fadeOut: 20,
    loop: true,
  };
  it('loops only the chosen source interval, with silence outside placement', () => {
    expect([9, 10, 69, 70, 129, 130].map((frame) => musicSourceFrame(music, frame))).toEqual([
      null,
      30,
      89,
      30,
      89,
      null,
    ]);
    expect(musicGainAt(music, 10)).toBe(0);
    expect(musicGainAt(music, 30)).toBeCloseTo(10 ** (-6 / 20));
    expect(musicGainAt(music, 120)).toBeCloseTo(0.5 * 10 ** (-6 / 20));
    expect(musicGainAt(music, 130)).toBe(0);
  });
  it('rejects music without explicit loop when the track exceeds the selected source', () => {
    expect(() => projectSchema.parse({ ...createProject('p', 'P'), music: [{ ...music, loop: false }] })).toThrow();
  });
  it('snaps to the closest clip or music boundary only within tolerance', () => {
    const project = applyCommand(createProject('p', 'P'), {
      type: 'insert',
      clip: createClip('a', 'source', 0, 100),
      index: 0,
    });
    const points = snapPoints({ ...project, music: [music, { ...music, id: 'second', start: 40 }] });
    expect(points).toContain(10);
    expect(points).toContain(130);
    expect(points).toContain(40);
    expect(points).toContain(160);
    expect(snapFrame(97, points, 4)).toBe(100);
    expect(snapFrame(94, points, 4)).toBe(94);
    expect(snapFrame(128, points, 4)).toBe(130);
  });
});
