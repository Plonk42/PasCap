import { describe, expect, it } from 'vitest';
import { EMPTY_KEY_VALUES, type Interpolation } from '../../src/shared/keyframes.js';
import { compileLayerRetiming } from '../../src/shared/layer-retiming.js';
import { createClip, createLayer } from '../../src/shared/model.js';
import { evaluateSpatial, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { compileRetiming, type Retiming, type SpeedSettings } from '../../src/shared/speed.js';

const easings: Interpolation[] = ['hold', 'linear', 'ease-in', 'ease-out', 'smooth'];
const progress: Record<Interpolation, (u: number) => number> = {
  hold: () => 0,
  linear: (u) => u,
  'ease-in': (u) => u * u,
  'ease-out': (u) => 2 * u - u * u,
  smooth: (u) => 3 * u * u - 2 * u * u * u,
};
const primitive: Record<Interpolation, (u: number) => number> = {
  hold: () => 0,
  linear: (u) => (u * u) / 2,
  'ease-in': (u) => (u * u * u) / 3,
  'ease-out': (u) => u * u - (u * u * u) / 3,
  smooth: (u) => u * u * u - (u * u * u * u) / 2,
};

function base(speed: SpeedSettings, sourceIn = 7, sourceOut = 37) {
  return { ...createClip('spatial-retiming', 'synthetic', sourceIn, sourceOut), speed };
}

function keyedRow(interpolation: Interpolation, left = 0.5, right = 2) {
  const layer = createLayer('spatial-row', 'Spatial row');
  layer.keyframes = [
    { frame: 0, interpolation, values: { ...EMPTY_KEY_VALUES, speed: left } },
    { frame: 100, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: right } },
  ];
  return layer;
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

  it.each(['linear', 'ease-in', 'ease-out', 'smooth'] as const)(
    'exposes the existing midpoint-integrated %s ramp clock before flooring',
    (curve) => {
      const map = compileRetiming(
        base({ mode: 'ramp', startRate: 0.5, endRate: 2, curve, anchorIn: 0, anchorOut: 50 }),
      );
      // Independently reconstruct the specified midpoint clock, including off-trim anchors.
      const step = 30 / 256;
      const times = [0];
      const rate = (source: number) => 0.5 + 1.5 * progress[curve](source / 50);
      for (let index = 0; index < 256; index++) times.push(times[index]! + step / rate(7 + (index + 0.5) * step));
      const total = times[256]!;
      expect(map.duration).toBe(Math.round(total));
      for (const frame of [0.25, 1, map.duration / 2, map.duration - 0.25]) {
        const time = (frame * total) / map.duration;
        const index = times.findIndex((value) => value > time) - 1;
        const source = 7 + (index + (time - times[index]!) / (times[index + 1]! - times[index]!)) * step;
        expect(map.sourcePositionAt(frame)).toBeCloseTo(source, 12);
        expect(map.sourceAt(frame)).toBe(Math.min(36, Math.floor(source + 1e-8)));
        expect(map.rateAt(frame)).toBeCloseTo((rate(source) * total) / map.duration, 12);
      }
      for (const source of [7, 8, 20, 36]) {
        const position = (source - 7) / step;
        const index = Math.floor(position);
        const time = times[index]! + (times[index + 1]! - times[index]!) * (position - index);
        expect(map.outputAt(source)).toBe(Math.min(map.duration - 1, Math.floor((time * map.duration) / total + 1e-8)));
      }
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

  it.each(easings)('uses the unnormalised absolute row %s integral at the actual placement', (interpolation) => {
    const layer = keyedRow(interpolation);
    const clip = base({ mode: 'constant', rate: 8 });
    const start = 20;
    const map = compileLayerRetiming(clip, layer, start);
    const consumed = (elapsed: number) =>
      0.5 * elapsed + 150 * (primitive[interpolation]((start + elapsed) / 100) - primitive[interpolation](start / 100));
    let low = 0;
    let high = 80;
    for (let iteration = 0; iteration < 60; iteration++) {
      const middle = (low + high) / 2;
      if (consumed(middle) < 30) low = middle;
      else high = middle;
    }
    expect(map.duration).toBe(Math.round((low + high) / 2));
    for (const frame of [0.25, 1, map.duration / 2, map.duration - 0.25]) {
      const source = 7 + consumed(frame);
      expect(map.sourcePositionAt(frame)).toBeCloseTo(Math.min(37, source), 11);
      expect(map.sourceAt(frame)).toBe(Math.min(36, Math.floor(source + 1e-8)));
      expect(map.rateAt(frame)).toBeCloseTo(0.5 + 1.5 * progress[interpolation]((start + frame) / 100), 12);
    }
    for (const source of [7, 8, 20, 36]) {
      let begin = 0;
      let end = 80;
      for (let iteration = 0; iteration < 60; iteration++) {
        const middle = (begin + end) / 2;
        if (consumed(middle) < source - 7) begin = middle;
        else end = middle;
      }
      expect(map.outputAt(source)).toBe(Math.min(map.duration - 1, Math.floor(end + 1e-8)));
    }
    expectContinuousBounds(map, 7, 37);
    if (interpolation !== 'hold') {
      const moved = compileLayerRetiming(clip, layer, 30);
      expect(moved.sourcePositionAt(1)).toBeGreaterThan(map.sourcePositionAt(1));
    }
  });

  it('crosses row intervals in project time and skips unrelated participants', () => {
    const layer = createLayer('compound-row', 'Compound row');
    layer.keyframes = [
      { frame: 0, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 0.25 } },
      { frame: 10, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, opacity: 0.5 } },
      { frame: 12, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 2 } },
      { frame: 20, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 0.5 } },
    ];
    const map = compileLayerRetiming(base({ mode: 'constant', rate: 8 }), layer, 8);
    expect(map.duration).toBe(38);
    for (const [output, source, rate] of [
      [0.5, 7.125, 0.25],
      [2.5, 7.625, 0.25],
      [4, 8, 2],
      [4.5, 9, 2],
      [12, 24, 0.5],
      [12.5, 24.25, 0.5],
      [37.5, 36.75, 0.5],
    ] as const) {
      expect(map.sourcePositionAt(output)).toBe(source);
      expect(map.sourceAt(output)).toBe(Math.floor(source));
      expect(map.rateAt(output)).toBe(rate);
    }
    expectContinuousBounds(map, 7, 37);
  });

  it('does not normalise a rounded constant row clock and still includes the exact exclusive OUT', () => {
    const layer = keyedRow('hold', 8, 8);
    const clip = base({ mode: 'constant', rate: 8 }, 7, 10);
    const row = compileLayerRetiming(clip, layer, 0);
    const staticMap = compileRetiming(clip);
    expect(row.duration).toBe(1);
    expect(staticMap.duration).toBe(1);
    expect(row.sourcePositionAt(0.25)).toBe(9);
    expect(staticMap.sourcePositionAt(0.25)).toBe(7.75);
    expect(row.sourcePositionAt(0.75)).toBe(10);
    expect(row.sourceAt(0.75)).toBe(9);
    expectContinuousBounds(row, 7, 10);
  });

  it('evaluates distinct smooth spatial poses on held decoded images for every speed compiler', () => {
    const constant = base({ mode: 'constant', rate: 0.25 });
    const ramp = base({ mode: 'ramp', startRate: 0.2, endRate: 0.5, curve: 'smooth', anchorIn: 7, anchorOut: 37 });
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
    const maps = [
      compileRetiming(constant),
      compileRetiming(ramp),
      compileRetiming(custom),
      compileLayerRetiming(constant, keyedRow('smooth', 0.2, 0.5), 20),
      compileLayerRetiming(constant, createLayer('unkeyed', 'Unkeyed'), 20),
    ];
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
