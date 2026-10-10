import { describe, expect, it } from 'vitest';
import {
  addClipSpeedKey,
  CLIP_SPEED_PRESETS,
  clipSpeedPreset,
  editableClipSpeed,
  editClipSpeedRate,
  removeClipSpeedKey,
  updateClipSpeedKey,
} from '../../src/shared/clip-speed.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { needsLayeredExport, planExport } from '../../src/shared/export.js';
import { interpolatedProgress, type Interpolation } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema } from '../../src/shared/model.js';
import { trimByOutputFrames, validateSourceRanges } from '../../src/shared/source-range.js';
import {
  compileRetiming,
  sourceRateAt,
  speedSchema,
  type SpeedCurve,
  type SpeedCurveKeyframe,
} from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

const key = (frame: number, rate: number, interpolation: Interpolation = 'linear'): SpeedCurveKeyframe => ({
  frame,
  rate,
  interpolation,
});
const curve = (...keyframes: SpeedCurveKeyframe[]): SpeedCurve => ({ mode: 'curve', keyframes });
const clip = (speed: SpeedCurve, sourceIn = 0, sourceOut = 120) => ({
  ...createClip('a', 'source', sourceIn, sourceOut),
  speed,
});

describe('strict clip-instance speed curves', () => {
  it('adds a discriminated mode without missing defaults, optional legacy fields or project migration', () => {
    const document = createProject('curve', 'Curve');
    document.clips = [clip(curve(key(0, 1), key(120, 2)))];
    expect(projectSchema.parse(document)).toEqual(document);
    expect(document.schemaVersion).toBe(15);
    expect(speedSchema.parse({ mode: 'constant', rate: 1 })).toEqual({ mode: 'constant', rate: 1 });
    expect(() => speedSchema.parse({ mode: 'curve' })).toThrow();
  });
  it.each([
    { mode: 'curve', keyframes: [] },
    { mode: 'ramp', startRate: 1, endRate: 2, anchorIn: 0, anchorOut: 120, curve: 'linear' },
    curve(key(2, 1), key(2, 2)),
    curve(key(10, 1), key(0, 2)),
    curve(key(-1, 1), key(120, 1)),
    curve(key(0.5, 1), key(120, 1)),
    curve(key(0, 1), key(2_147_483_648, 1)),
    curve(key(0, 0), key(120, 1)),
    curve(key(0, 8.01), key(120, 1)),
    curve(key(0, NaN), key(120, 1)),
    curve(key(0, Infinity), key(120, 1)),
    { mode: 'curve', keyframes: [{ frame: 0, rate: 1 }, key(120, 1)] },
    { ...curve(key(0, 1), key(120, 1)), fallback: 1 },
    { mode: 'curve', keyframes: [{ ...key(0, 1), clipId: 'other' }, key(120, 1)] },
    curve(...Array.from({ length: 257 }, (_, index) => key(index, 1))),
  ])('rejects malformed curve %# rather than silently repairing it', (invalid) => {
    expect(speedSchema.safeParse(invalid).success).toBe(false);
  });
  it('retains equal adjacent rates and accepts a single key and the exact 256-point bound', () => {
    const speed = curve(...Array.from({ length: 256 }, (_, index) => key(index, 1)));
    expect(speedSchema.parse(speed)).toEqual(speed);
    expect(speedSchema.parse(curve(key(40, 1.5)))).toEqual(curve(key(40, 1.5)));
  });
  it.each(['hold', 'linear', 'ease-in', 'ease-out', 'smooth'] as const)(
    'samples %s between exact source anchors with endpoint holds',
    (interpolation) => {
      const speed = curve(key(10, 0.5, interpolation), key(110, 2));
      expect(sourceRateAt(speed, 0)).toBe(0.5);
      expect(sourceRateAt(speed, 10)).toBe(0.5);
      expect(sourceRateAt(speed, 35)).toBe(0.5 + 1.5 * interpolatedProgress(0.25, interpolation));
      expect(sourceRateAt(speed, 110)).toBe(2);
      expect(sourceRateAt(speed, 200)).toBe(2);
    },
  );
  it('allows recoverable off-trim points and the exclusive original OUT, but rejects anchors beyond the original', () => {
    const document = createProject('original-bounds', 'Original bounds');
    document.clips = [clip(curve(key(0, 1), key(120, 2)), 30, 90)];
    expect(() => validateSourceRanges(document, new Map([['source', 120]]))).not.toThrow();
    document.clips[0]!.speed = curve(key(0, 1), key(121, 2));
    expect(() => validateSourceRanges(document, new Map([['source', 120]]))).toThrow('speed keyframes exceed');
  });
});

describe('precise bounded curve integration and immutable shared maps', () => {
  it('matches constant clip-base duration and samples exactly for a flat curve', () => {
    for (const rate of [0.1, 0.25, 0.5, 1, 1.125, 2, 8]) {
      const base = createClip('base', 'source', 10, 310);
      const flat = compileRetiming({ ...base, speed: curve(key(10, rate), key(310, rate)) });
      const constant = compileRetiming({ ...base, speed: { mode: 'constant', rate } });
      expect(flat.duration).toBe(constant.duration);
      for (const frame of [0, 1, Math.floor(flat.duration / 2), flat.duration - 1]) {
        expect(flat.sourceAt(frame)).toBe(constant.sourceAt(frame));
        expect(flat.rateAt(frame)).toBeCloseTo(constant.rateAt(frame), 10);
      }
    }
  });
  it('uses the closed-form logarithmic integral and inverse for a linear rate ramp', () => {
    const speed = curve(key(0, 0.5), key(300, 2));
    const map = compileRetiming(clip(speed, 0, 300));
    const total = (300 * Math.log(4)) / 1.5;
    expect(map.duration).toBe(Math.round(total));
    for (const output of [0, 1, 50, 200, map.duration - 1]) {
      const time = (output * total) / map.duration;
      const source = 100 * Math.expm1(time / 200);
      expect(map.sourceAt(output)).toBe(Math.floor(source + 1e-8));
      expect(map.rateAt(output)).toBeCloseTo(((0.5 + (1.5 * source) / 300) * total) / map.duration, 10);
    }
    expect(map.outputAt(100)).toBe(Math.floor((200 * Math.log(2) * map.duration) / total + 1e-8));
  });
  it('does not miss a one-source-frame slow hold on a million-frame recording', () => {
    const speed = curve(key(0, 1, 'hold'), key(123, 0.1, 'hold'), key(124, 1, 'hold'), key(1_000_000, 1));
    const map = compileRetiming(clip(speed, 0, 1_000_000));
    expect(map.duration).toBe(1_000_009);
    expect(map.outputAt(123)).toBe(123);
    expect(map.outputAt(124)).toBe(133);
    expect(map.sourceAt(123)).toBe(123);
    expect(map.sourceAt(132)).toBe(123);
    expect(map.sourceAt(133)).toBe(124);
  });
  it.each(['ease-in', 'ease-out', 'smooth'] as const)(
    'agrees with an independent fine integration for extreme %s rates and retains monotonic frame bounds',
    (interpolation) => {
      const speed = curve(key(0, 0.1, interpolation), key(100, 8));
      const map = compileRetiming(clip(speed, 0, 100));
      let independent = 0;
      for (let index = 0; index < 100_000; index++)
        independent += 0.001 / (0.1 + 7.9 * interpolatedProgress((index + 0.5) / 100_000, interpolation));
      expect(map.duration).toBe(Math.round(independent));
      const sources = Array.from({ length: map.duration }, (_, frame) => map.sourceAt(frame));
      expect(
        sources.every((source, index) => source >= 0 && source < 100 && (index === 0 || source >= sources[index - 1]!)),
      ).toBe(true);
      for (const source of [0, 10, 50, 99]) {
        const output = map.outputAt(source);
        expect(map.sourceAt(output)).toBeLessThanOrEqual(source);
        if (output + 1 < map.duration) expect(map.sourceAt(output + 1)).toBeGreaterThanOrEqual(source - 1);
        else expect(output).toBe(map.duration - 1);
      }
      // Fast end rates can legitimately skip the final recorded frames; neither
      // the map nor native decoder may invent an extra output frame to show them.
      expect(map.sourceAt(map.duration - 1)).toBeLessThan(99);
    },
  );
  it('owns copied point values/times/easing so edits cannot mutate an export or cache entry', () => {
    const original = clip(curve(key(0, 0.5, 'smooth'), key(120, 2)));
    const map = compileRetiming(original);
    const values = [map.duration, map.sourceAt(30), map.outputAt(60), map.rateAt(30)];
    expect(compileRetiming(structuredClone(original))).toBe(map);
    original.speed.keyframes[0]!.rate = 8;
    original.speed.keyframes[1]!.frame = 200;
    original.speed.keyframes.reverse();
    expect([map.duration, map.sourceAt(30), map.outputAt(60), map.rateAt(30)]).toEqual(values);
    expect(Object.isFrozen(map)).toBe(true);
  });
  it('clamps finite source/output queries but rejects nonfinite queries without duration-sized storage', () => {
    const map = compileRetiming(clip(curve(key(0, 1), key(120, 1))));
    expect(map.sourceAt(-10)).toBe(0);
    expect(map.sourceAt(500)).toBe(119);
    expect(map.outputAt(-10)).toBe(0);
    expect(map.outputAt(500)).toBe(119);
    for (const query of [map.sourceAt, map.outputAt, map.rateAt])
      for (const value of [NaN, Infinity, -Infinity]) expect(() => query(value)).toThrow('finite');
    expect(() => compileRetiming(clip(curve(key(0, 0.1), key(2_147_483_647, 0.1)), 0, 2_147_483_647))).toThrow(
      'supported project frames',
    );
  });
});

describe('presets, exact key edits and existing timeline operations', () => {
  it('offers Ramp up/down as two-key smooth presets at the excerpt edges, in catalogue order', () => {
    expect(CLIP_SPEED_PRESETS.map(({ id }) => id)).toEqual([
      'flat',
      'ramp-up',
      'ramp-down',
      'accelerate',
      'decelerate',
      'slow-centre',
      'fast-centre',
    ]);
    expect(clipSpeedPreset({ sourceIn: 30, sourceOut: 90 }, 'ramp-up')).toEqual(
      curve(key(30, 0.5, 'smooth'), key(90, 2, 'smooth')),
    );
    expect(clipSpeedPreset({ sourceIn: 30, sourceOut: 90 }, 'ramp-down')).toEqual(
      curve(key(30, 2, 'smooth'), key(90, 0.5, 'smooth')),
    );
    expect(clipSpeedPreset({ sourceIn: 10, sourceOut: 17 }, 'slow-centre').keyframes.map(({ frame }) => frame)).toEqual(
      [10, 12, 14, 15, 17],
    );
  });
  it.each(CLIP_SPEED_PRESETS)(
    'creates the $label curve across this excerpt only, including one-frame excerpts',
    ({ id }) => {
      for (const length of [1, 2, 17, 120]) {
        const speed = clipSpeedPreset({ sourceIn: 10, sourceOut: 10 + length }, id);
        expect(speed.keyframes[0]!.frame).toBe(10);
        expect(speed.keyframes.at(-1)!.frame).toBe(10 + length);
        expect(speedSchema.parse(speed)).toEqual(speed);
        expect(speed.keyframes.length).toBeGreaterThanOrEqual(2);
      }
    },
  );
  it('deliberate Custom conversion preserves constant values and an existing curve', () => {
    const base = { ...createClip('base', 'source', 30, 90), speed: { mode: 'constant' as const, rate: 1.125 } };
    expect(editableClipSpeed(base).keyframes.every((point) => point.rate === 1.125)).toBe(true);
    const existing = curve(key(0, 0.5, 'ease-out'), key(120, 2));
    expect(editableClipSpeed({ ...base, speed: existing })).toEqual(existing);
  });
  it('adds a captured point, rejects collisions/missing keys, and keeps the last rate as constant speed', () => {
    const speed = curve(key(0, 0.5), key(120, 2));
    const before = structuredClone(speed);
    const added = addClipSpeedKey(speed, 60);
    expect(added.keyframes[1]).toEqual(key(60, 1.25, 'linear'));
    const moved = updateClipSpeedKey(added, 60, { frame: 80, rate: 1.125, interpolation: 'hold' });
    expect(moved.keyframes[1]).toEqual(key(80, 1.125, 'hold'));
    expect(() => updateClipSpeedKey(moved, 80, { frame: 120 })).toThrow();
    expect(() => addClipSpeedKey(speed, 120)).toThrow('already exists');
    expect(() => updateClipSpeedKey(speed, 50, { rate: 1 })).toThrow('no longer exists');
    expect(removeClipSpeedKey(moved, 80)).toEqual(speed);
    expect(() => removeClipSpeedKey(speed, 50)).toThrow('no longer exists');
    expect(removeClipSpeedKey(speed, 0)).toEqual(curve(key(120, 2)));
    expect(removeClipSpeedKey(curve(key(120, 2)), 120)).toEqual({ mode: 'constant', rate: 2 });
    expect(addClipSpeedKey({ mode: 'constant', rate: 1.5 }, 40)).toEqual(curve(key(40, 1.5)));
    expect(editClipSpeedRate({ mode: 'constant', rate: 1.5 }, null, 3)).toEqual({ mode: 'constant', rate: 3 });
    expect(editClipSpeedRate(speed, 120, 4)).toEqual(curve(key(0, 0.5), key(120, 4)));
    for (const frame of [null, 60])
      expect(() => editClipSpeedRate(speed, frame, 4)).toThrow('Add a speed keyframe at this source frame');
    expect(speed).toEqual(before);
  });
  it('trim/split/duplicate retain source anchors, independent instances and exact one-step history', () => {
    const document = createProject('editing-curves', 'Editing curves');
    document.clips = [clip(curve(key(0, 0.5), key(60, 2), key(120, 1)))];
    const trimmed = applyCommand(document, { type: 'trim', clipId: 'a', sourceIn: 20, sourceOut: 100 });
    expect(trimmed.clips[0]!.speed).toEqual(document.clips[0]!.speed);
    const split = applyCommand(trimmed, { type: 'split', clipId: 'a', sourceFrame: 60, newClipId: 'right' });
    expect(split.clips.map((item) => item.speed)).toEqual([document.clips[0]!.speed, document.clips[0]!.speed]);
    expect(split.clips[0]!.speed).not.toBe(split.clips[1]!.speed);
    const duplicated = applyCommand(trimmed, { type: 'duplicate', clipId: 'a', newClipId: 'copy' });
    const history = new EditHistory(duplicated);
    const updated = history.commit({ type: 'speed', clipId: 'copy', speed: curve(key(0, 1), key(120, 8)) });
    expect(updated.clips[0]).toEqual(duplicated.clips[0]);
    expect(history.undo()).toEqual(duplicated);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(updated);
    expect(compileRetiming(trimmed.clips[0]!).duration).toBeLessThan(compileRetiming(document.clips[0]!).duration);
    expect(trimByOutputFrames(trimmed.clips[0]!, 'out', -10, 120).sourceOut).toBeLessThan(100);
  });
  it('static export uses the same custom map, and invalid speed changes never shorten existing dissolves', () => {
    const document = createProject('native-curve', 'Native curve');
    document.clips = [clip(curve(key(0, 0.5), key(120, 2)))];
    expect(needsLayeredExport(document)).toBe(false);
    expect(planExport(document).duration).toBe(calculateLayout(document).duration);
    for (let frame = 0; frame < calculateLayout(document).duration; frame++)
      expect(sampleTimeline(document, frame)[0]!.sourceFrame).toBe(compileRetiming(document.clips[0]!).sourceAt(frame));
    document.clips.push(createClip('b', 'source', 0, 120));
    document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 30 }];
    const before = structuredClone(document);
    expect(() =>
      applyCommand(document, { type: 'speed', clipId: 'a', speed: curve(key(0, 8), key(120, 8)) }),
    ).toThrow();
    expect(document).toEqual(before);
  });
});
