import { describe, expect, it } from 'vitest';
import type { Interpolation } from '../../src/shared/keyframes.js';
import { createClip } from '../../src/shared/model.js';
import { evaluateSpatial, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { compileRetiming, type Retiming, type SpeedSettings } from '../../src/shared/speed.js';

const progress: Record<Interpolation, (u: number) => number> = {
  hold: () => 0,
  linear: (u) => u,
  'ease-in': (u) => u * u,
  'ease-out': (u) => 2 * u - u * u,
  smooth: (u) => 3 * u * u - 2 * u * u * u,
};
function base(speed: SpeedSettings, sourceIn = 7, sourceOut = 37) {
  return { ...createClip('spatial-retiming', 'synthetic', sourceIn, sourceOut), speed };
}

function expectContinuousBounds(map: Retiming, sourceIn: number, sourceOut: number): void {
  for (const frame of [-Number.MAX_VALUE, -0.5, 0]) expect(map.sourcePositionAt(frame)).toBe(sourceIn);
  for (const frame of [map.duration, map.duration + 0.5, Number.MAX_VALUE])
    expect(map.sourcePositionAt(frame)).toBe(sourceOut);
  let previous = sourceIn;
  for (let step = 1; step < 100; step++) {
    const position = map.sourcePositionAt((map.duration * step) / 100);
    expect(Number.isFinite(position)).toBe(true);
    expect(position).toBeGreaterThanOrEqual(previous);
    expect(position).toBeLessThanOrEqual(sourceOut);
    previous = position;
  }
  for (const frame of [NaN, Infinity, -Infinity]) expect(() => map.sourcePositionAt(frame)).toThrow('finite');
  expect(map.sourceAt(map.duration)).toBe(sourceOut - 1);
}

describe('continuous original-source retiming for spatial animation', () => {
  it.each([0.1, 0.5, 1, 1.125, 3, 8])(
    'normalises constant %sx to the rounded clock without changing discrete queries',
    (rate) => {
      const map = compileRetiming(base({ mode: 'constant', rate }));
      const duration = Math.max(1, Math.round(30 / rate));
      expect(map.duration).toBe(duration);
      for (const frame of [0, 0.25, 1, duration / 2, duration - 0.25]) {
        const position = 7 + (frame * 30) / duration;
        expect(map.sourcePositionAt(frame)).toBeCloseTo(position, 12);
        expect(map.sourceAt(frame)).toBe(Math.max(7, Math.min(36, Math.floor(position + 1e-8))));
        expect(map.rateAt(frame)).toBe(30 / duration);
      }
      for (const source of [7, 8, 21, 36, 37])
        expect(map.outputAt(source)).toBe(Math.min(duration - 1, Math.floor((source - 7) / (30 / duration) + 1e-8)));
      expectContinuousBounds(map, 7, 37);
    },
  );

  it('uses the analytic custom-curve inverse and retains original keys outside the trimmed excerpt', () => {
    const clip = base(
      {
        mode: 'curve',
        keyframes: [
          { frame: 0, rate: 0.5, interpolation: 'linear' },
          { frame: 200, rate: 1.5, interpolation: 'hold' },
        ],
      },
      40,
      100,
    );
    const snapshot = structuredClone(clip);
    const map = compileRetiming(clip);
    const total = Math.log(1 / 0.7) / 0.005;
    expect(map.duration).toBe(Math.round(total));
    for (const frame of [0.25, 1, 20, map.duration - 0.25]) {
      const time = (frame * total) / map.duration;
      const source = 40 + (0.7 * Math.expm1(0.005 * time)) / 0.005;
      expect(map.sourcePositionAt(frame)).toBeCloseTo(source, 11);
      expect(map.sourceAt(frame)).toBe(Math.min(99, Math.floor(source + 1e-8)));
      expect(map.rateAt(frame)).toBeCloseTo(((0.5 + source * 0.005) * total) / map.duration, 12);
    }
    for (const source of [40, 41, 65, 99]) {
      const time = Math.log((0.5 + source * 0.005) / 0.7) / 0.005;
      expect(map.outputAt(source)).toBe(Math.floor((time * map.duration) / total + 1e-8));
    }
    expectContinuousBounds(map, 40, 100);
    expect(clip).toEqual(snapshot);
  });

  it.each(['ease-in', 'ease-out', 'smooth'] as const)(
    'exposes the normalised custom %s quadrature clock without flooring',
    (interpolation) => {
      const map = compileRetiming(
        base({
          mode: 'curve',
          keyframes: [
            { frame: 0, rate: 0.5, interpolation },
            { frame: 50, rate: 2, interpolation: 'hold' },
          ],
        }),
      );
      // Fine midpoint integration is independent of the production Gauss-Legendre solver.
      const elapsed = (end: number): number => {
        const step = (end - 7) / 20_000;
        let time = 0;
        for (let index = 0; index < 20_000; index++)
          time += step / (0.5 + 1.5 * progress[interpolation]((7 + (index + 0.5) * step) / 50));
        return time;
      };
      const total = elapsed(37);
      expect(map.duration).toBe(Math.round(total));
      for (const output of [0.25, 1, map.duration / 2, map.duration - 0.25]) {
        const source = map.sourcePositionAt(output);
        expect(elapsed(source)).toBeCloseTo((output * total) / map.duration, 6);
        expect(map.sourceAt(output)).toBe(Math.min(36, Math.floor(source + 1e-8)));
      }
      expectContinuousBounds(map, 7, 37);
    },
  );

  it('keeps a one-source-frame custom hold continuous instead of reconstructing it from decoded frames', () => {
    const map = compileRetiming(
      base(
        {
          mode: 'curve',
          keyframes: [
            { frame: 0, rate: 1, interpolation: 'hold' },
            { frame: 123, rate: 0.1, interpolation: 'hold' },
            { frame: 124, rate: 1, interpolation: 'hold' },
            { frame: 1000, rate: 1, interpolation: 'hold' },
          ],
        },
        0,
        1000,
      ),
    );
    expect(map.duration).toBe(1009);
    expect(map.sourcePositionAt(123.5)).toBeCloseTo(123.05, 12);
    expect(map.sourcePositionAt(132.5)).toBeCloseTo(123.95, 12);
    expect(map.sourceAt(123.5)).toBe(123);
    expect(map.sourceAt(132.5)).toBe(123);
    expect(map.outputAt(124)).toBe(133);
    expectContinuousBounds(map, 0, 1000);
  });

  it('evaluates distinct smooth spatial poses on held decoded images for every speed compiler', () => {
    const constant = base({ mode: 'constant', rate: 0.25 });
    const custom = base({
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.2, interpolation: 'smooth' },
        { frame: 100, rate: 0.5, interpolation: 'hold' },
      ],
    });
    const spatial = {
      base: { ...NEUTRAL_SPATIAL_POSE },
      keyframes: [
        { frame: 0, interpolation: 'linear' as const, values: { ...NEUTRAL_SPATIAL_POSE, translateX: 0 } },
        { frame: 100, interpolation: 'linear' as const, values: { ...NEUTRAL_SPATIAL_POSE, translateX: 1 } },
      ],
    };
    const before = structuredClone(spatial);
    const maps = [compileRetiming(constant), compileRetiming(custom)];
    for (const map of maps) {
      expect(map.sourceAt(1)).toBe(7);
      expect(map.sourceAt(2)).toBe(7);
      const first = map.sourcePositionAt(1);
      const second = map.sourcePositionAt(2);
      expect(second).toBeGreaterThan(first);
      expect(second).toBeLessThan(8);
      expect(evaluateSpatial(spatial, first).translateX).toBeCloseTo(first / 100, 12);
      expect(evaluateSpatial(spatial, second).translateX).toBeCloseTo(second / 100, 12);
      expect(evaluateSpatial(spatial, second).translateX).toBeGreaterThan(evaluateSpatial(spatial, first).translateX);
      expectContinuousBounds(map, 7, 37);
    }
    expect(spatial).toEqual(before);
  });
});
