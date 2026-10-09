import { describe, expect, it } from 'vitest';
import type { Interpolation } from '../../src/shared/keyframes.js';
import { interpolatedProgress } from '../../src/shared/keyframes.js';
import type { SpatialKeyframe, SpatialMapping, SpatialPose, SpatialSettings } from '../../src/shared/spatial.js';
import {
  compileSpatialMapping,
  createSpatialSettings,
  evaluateSpatial,
  hasSpatialChannelKeys,
  hasSpatialEdits,
  isNeutralSpatial,
  mapSpatialPoint,
  NEUTRAL_SPATIAL_POSE,
  spatialCoverage,
  spatialKeyChannels,
  spatialKeyframeSchema,
  spatialPoseSchema,
  spatialSettingsSchema,
} from '../../src/shared/spatial.js';

const channels = Object.keys(NEUTRAL_SPATIAL_POSE) as (keyof SpatialPose)[];
const curves: Interpolation[] = ['hold', 'linear', 'ease-in', 'ease-out', 'smooth'];
const nonfinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

function pose(changes: Partial<SpatialPose> = {}): SpatialPose {
  return { ...NEUTRAL_SPATIAL_POSE, ...changes };
}

function key(frame: number, values = pose(), interpolation: Interpolation = 'linear'): SpatialKeyframe {
  return { frame, interpolation, values };
}

function settings(keyframes: SpatialKeyframe[] = [], base = pose()): SpatialSettings {
  return { base, keyframes };
}

function mapped(mapping: SpatialMapping, x: number, y: number): number[] {
  return Array.from(mapSpatialPoint(mapping, x, y, new Float64Array(2)));
}

function expectUv(actual: readonly number[], u: number, v: number): void {
  expect(actual[0]).toBeCloseTo(u, 12);
  expect(actual[1]).toBeCloseTo(v, 12);
}

describe('strict spatial settings', () => {
  it('creates fresh independent neutral settings without persisted defaults', () => {
    const first = createSpatialSettings();
    const second = createSpatialSettings();
    expect(spatialSettingsSchema.parse(first)).toEqual(settings());
    expect(Object.isFrozen(NEUTRAL_SPATIAL_POSE)).toBe(true);
    first.base.scale = 2;
    first.keyframes.push(key(7));
    expect(second).toEqual(settings());
    expect(NEUTRAL_SPATIAL_POSE.scale).toBe(1);
    expect(first.base).not.toBe(second.base);
    expect(first.keyframes).not.toBe(second.keyframes);
  });

  it.each(channels)('requires the %s number on base and every full-pose key', (channel) => {
    const incomplete: Partial<SpatialPose> = pose();
    delete incomplete[channel];
    expect(spatialPoseSchema.safeParse(incomplete).success).toBe(false);
    expect(spatialSettingsSchema.safeParse({ base: incomplete, keyframes: [] }).success).toBe(false);
    expect(spatialKeyframeSchema.safeParse({ ...key(0), values: incomplete }).success).toBe(false);
    expect(spatialPoseSchema.safeParse({ ...pose(), [channel]: null }).success).toBe(false);
    expect(spatialPoseSchema.safeParse({ ...pose(), [channel]: '0' }).success).toBe(false);
  });

  it('rejects missing, unknown and compatibility fields at every object level', () => {
    const invalid: unknown[] = [
      {},
      { base: pose() },
      { keyframes: [] },
      { base: pose(), keyframes: null },
      { ...settings(), opacity: 1 },
      { ...settings(), colour: {} },
      { ...settings(), base: { ...pose(), exposure: 0 } },
      { ...settings(), base: { ...pose(), rotationDegrees: 0 } },
      settings([{ ...key(0), extra: 1 } as SpatialKeyframe]),
      { ...settings(), keyframes: [{ frame: 0, values: pose() }] },
      { ...settings(), keyframes: [{ frame: 0, interpolation: 'linear' }] },
      { ...settings(), keyframes: [{ ...key(0), values: { ...pose(), unknown: 0 } }] },
    ];
    for (const value of invalid) expect(spatialSettingsSchema.safeParse(value).success).toBe(false);
  });

  it.each(channels)('rejects every nonfinite %s in base and key values', (channel) => {
    for (const value of nonfinite) {
      const invalid = pose({ [channel]: value });
      expect(spatialSettingsSchema.safeParse(settings([], invalid)).success).toBe(false);
      expect(spatialSettingsSchema.safeParse(settings([key(0, invalid)])).success).toBe(false);
      expect(() => compileSpatialMapping(invalid, 1920, 1080, 1280, 720)).toThrow();
    }
  });

  it('accepts closed transform bounds and opposite crops that cover nothing', () => {
    for (const scale of [0.1, 8]) {
      for (const translation of [-2, 2]) {
        for (const rotation of [-180, 180]) {
          expect(
            spatialPoseSchema.safeParse(pose({ scale, translateX: translation, translateY: translation, rotation }))
              .success,
          ).toBe(true);
        }
      }
    }
    expect(spatialPoseSchema.safeParse(pose({ cropLeft: 1 - Number.EPSILON })).success).toBe(true);
    expect(spatialPoseSchema.safeParse(pose({ cropTop: 0.4, cropBottom: 0.599 })).success).toBe(true);
    // Opposite edges meeting or crossing are valid: nothing is covered, with no repair.
    expect(spatialPoseSchema.safeParse(pose({ cropLeft: 0.4, cropRight: 0.6 })).success).toBe(true);
    expect(spatialPoseSchema.safeParse(pose({ cropTop: 0.8, cropBottom: 0.3 })).success).toBe(true);
  });

  it('rejects individual bounds without clamping', () => {
    const invalid: Partial<SpatialPose>[] = [
      { cropLeft: -0.001 },
      { cropRight: 1 },
      { cropTop: 1 },
      { cropBottom: -0.001 },
      { scale: 0.099 },
      { scale: 8.001 },
      { translateX: -2.001 },
      { translateX: 2.001 },
      { translateY: -2.001 },
      { translateY: 2.001 },
      { rotation: -180.001 },
      { rotation: 180.001 },
    ];
    for (const changes of invalid) {
      const value = pose(changes);
      expect(spatialPoseSchema.safeParse(value).success).toBe(false);
      expect(spatialSettingsSchema.safeParse(settings([key(0, value)])).success).toBe(false);
      expect(() => compileSpatialMapping(value, 1920, 1080, 1280, 720)).toThrow();
    }
  });

  it('requires bounded integer, unique ordered source anchors and known interpolation', () => {
    const valid = [key(0), key(2_147_483_647)];
    expect(spatialSettingsSchema.parse(settings(valid)).keyframes).toEqual(valid);
    for (const frame of [-1, 0.5, 2_147_483_648, ...nonfinite])
      expect(spatialKeyframeSchema.safeParse(key(frame)).success).toBe(false);
    expect(spatialSettingsSchema.safeParse(settings([key(7), key(7)])).success).toBe(false);
    expect(spatialSettingsSchema.safeParse(settings([key(8), key(7)])).success).toBe(false);
    expect(spatialKeyframeSchema.safeParse({ ...key(0), interpolation: 'cubic' }).success).toBe(false);
    expect(spatialSettingsSchema.parse(settings(Array.from({ length: 256 }, (_, frame) => key(frame))))).toBeTruthy();
    expect(
      spatialSettingsSchema.safeParse(settings(Array.from({ length: 257 }, (_, frame) => key(frame)))).success,
    ).toBe(false);
  });
});

describe('full-pose source-time spatial animation', () => {
  const left = pose({
    cropLeft: 0.1,
    cropRight: 0.2,
    cropTop: 0.05,
    cropBottom: 0.3,
    scale: 0.25,
    translateX: -1.5,
    translateY: 1.25,
    rotation: 170,
  });
  const right = pose({
    cropLeft: 0.4,
    cropRight: 0.1,
    cropTop: 0.3,
    cropBottom: 0.1,
    scale: 7,
    translateX: 1.75,
    translateY: -0.75,
    rotation: -170,
  });

  it.each(curves)('uses the existing %s easing for all eight numbers and preserves convex crop', (curve) => {
    const value = settings([key(10, left, curve), key(30, right, 'hold')]);
    for (const sourcePosition of [10, 10.25, 15, 20, 29.75]) {
      const progress = interpolatedProgress((sourcePosition - 10) / 20, curve);
      const evaluated = evaluateSpatial(value, sourcePosition);
      for (const channel of channels)
        expect(evaluated[channel]).toBeCloseTo(left[channel] * (1 - progress) + right[channel] * progress, 12);
      expect(spatialPoseSchema.safeParse(evaluated).success).toBe(true);
      expect(evaluated.cropLeft + evaluated.cropRight).toBeLessThan(1);
      expect(evaluated.cropTop + evaluated.cropBottom).toBeLessThan(1);
    }
    expect(evaluateSpatial(value, 30)).toEqual(right);
  });

  it.each(curves)('holds first/last and exact endpoints for %s, ignoring base while keyed', (curve) => {
    const value = settings([key(10, left, curve), key(30, right)], pose({ scale: 3 }));
    for (const position of [-100, 0, 10]) expect(evaluateSpatial(value, position)).toEqual(left);
    for (const position of [30, 31, 2_147_483_647]) expect(evaluateSpatial(value, position)).toEqual(right);
    const single = settings([key(12, right, curve)], left);
    for (const position of [-1, 12, 99]) expect(evaluateSpatial(single, position)).toEqual(right);
  });

  it('interpolates rotation numerically, not by the shortest arc', () => {
    expect(evaluateSpatial(settings([key(10, left), key(30, right)]), 20).rotation).toBe(0);
    expect(
      evaluateSpatial(settings([key(10, pose({ rotation: -180 })), key(30, pose({ rotation: 180 }))]), 20).rotation,
    ).toBe(0);
  });

  it('uses source anchors outside trims and restores the complete unchanged base when keys are removed', () => {
    const base = pose({ scale: 4, cropLeft: 0.2, rotation: 63, translateY: 0.1 });
    const value = settings([key(0, left), key(1000, right)], base);
    // A hypothetical retained excerpt [400,600) does not discard or shift either anchor.
    const snapshot = structuredClone(value);
    const evaluated = evaluateSpatial(value, 500.5);
    expect(evaluated.scale).toBeCloseTo(left.scale * 0.4995 + right.scale * 0.5005, 12);
    expect(value).toEqual(snapshot);
    evaluated.cropLeft = 0;
    expect(value).toEqual(snapshot);
    value.keyframes = [];
    const restored = evaluateSpatial(value, 500.5);
    expect(restored).toEqual(base);
    expect(restored).not.toBe(base);
    restored.scale = 1;
    expect(value.base).toEqual(snapshot.base);
  });

  it('rejects nonfinite queries even without keys and never repairs invalid settings', () => {
    for (const position of nonfinite) {
      expect(() => evaluateSpatial(settings(), position)).toThrow('finite');
      expect(() => evaluateSpatial(settings([key(0)]), position)).toThrow('finite');
    }
    expect(() => evaluateSpatial(settings([key(2), key(1)]), 1)).toThrow();
  });

  it('marks exact identity independently from static-fast-path eligibility', () => {
    expect(isNeutralSpatial(NEUTRAL_SPATIAL_POSE)).toBe(true);
    expect(hasSpatialEdits(settings())).toBe(false);
    for (const channel of channels) {
      const changed = pose({ [channel]: NEUTRAL_SPATIAL_POSE[channel] + Number.EPSILON });
      expect(isNeutralSpatial(changed)).toBe(false);
      expect(hasSpatialEdits(settings([], changed))).toBe(true);
    }
    const animatedNeutral = settings([key(1), key(10)]);
    expect(isNeutralSpatial(evaluateSpatial(animatedNeutral, 5))).toBe(true);
    expect(hasSpatialEdits(animatedNeutral)).toBe(true);
    expect(hasSpatialEdits(settings([], pose({ scale: 2 })))).toBe(true);
  });
});

describe('independent per-setting spatial keyframes', () => {
  const none = Object.fromEntries(channels.map((channel) => [channel, null])) as Record<
    keyof SpatialPose,
    number | null
  >;
  const sparse = (frame: number, values: Partial<Record<keyof SpatialPose, number>>, curve: Interpolation = 'linear') =>
    ({ frame, interpolation: curve, values: { ...none, ...values } }) as SpatialKeyframe;

  it('requires every field and at least one enabled setting, allowing null elsewhere', () => {
    expect(spatialKeyframeSchema.safeParse(sparse(0, { scale: 2 })).success).toBe(true);
    expect(spatialKeyframeSchema.safeParse(sparse(0, {})).success).toBe(false);
    const missing: Partial<typeof none> = { ...none, scale: 2 };
    delete missing.rotation;
    expect(spatialKeyframeSchema.safeParse({ frame: 0, interpolation: 'linear', values: missing }).success).toBe(false);
    expect(spatialKeyframeSchema.safeParse(sparse(0, { scale: 9 })).success).toBe(false);
    expect(spatialPoseSchema.safeParse({ ...pose(), scale: null }).success).toBe(false);
  });

  it('interpolates each setting between its own keys, skipping keys that leave it out', () => {
    const value = settings(
      [
        sparse(0, { scale: 1 }, 'linear'),
        sparse(10, { rotation: 100 }, 'hold'),
        sparse(20, { scale: 3 }, 'linear'),
        sparse(30, { rotation: -100 }, 'hold'),
      ],
      pose({ translateX: 0.5 }),
    );
    // A key for another setting neither interrupts nor shortens this setting's interval.
    expect(evaluateSpatial(value, 10).scale).toBe(2);
    expect(evaluateSpatial(value, 5).scale).toBe(1.5);
    expect(evaluateSpatial(value, 25).scale).toBe(3);
    // Rotation holds its first key before it, ramps with its own left easing and holds the last.
    expect(evaluateSpatial(value, 0).rotation).toBe(100);
    expect(evaluateSpatial(value, 20).rotation).toBe(100);
    expect(evaluateSpatial(value, 30).rotation).toBe(-100);
    // A setting without keys keeps the saved base.
    for (const position of [0, 15, 99]) expect(evaluateSpatial(value, position).translateX).toBe(0.5);
  });

  it('applies the left key\u2019s easing to each of its enabled settings', () => {
    const value = settings([
      sparse(0, { scale: 1, rotation: 0 }, 'hold'),
      sparse(10, { scale: 3, rotation: 90 }, 'linear'),
    ]);
    expect(evaluateSpatial(value, 5)).toMatchObject({ scale: 1, rotation: 0 });
    expect(evaluateSpatial(value, 10)).toMatchObject({ scale: 3, rotation: 90 });
  });

  it('reports animation by setting, including all-null base-only settings', () => {
    expect(hasSpatialEdits(settings([sparse(0, { scale: 1 })]))).toBe(true);
    expect(spatialKeyChannels(sparse(3, { scale: 1, rotation: 0 }))).toEqual(['scale', 'rotation']);
    const value = settings([sparse(3, { rotation: 0 })]);
    expect(hasSpatialChannelKeys(value, 'rotation')).toBe(true);
    expect(hasSpatialChannelKeys(value, 'scale')).toBe(false);
  });

  it('covers nothing when opposite crops meet or cross, without repairing them', () => {
    for (const crops of [
      { cropLeft: 0.5, cropRight: 0.5 },
      { cropTop: 0.7, cropBottom: 0.6 },
    ]) {
      const mapping = compileSpatialMapping(pose(crops), 1920, 1080, 1280, 720);
      for (const [u, v] of [
        [0, 0],
        [0.25, 0.25],
        [0.5, 0.5],
        [0.75, 0.75],
        [0.999, 0.999],
      ])
        expect(spatialCoverage(mapping, u!, v!)).toBe(0);
    }
  });
});

describe('bounded inverse spatial geometry and independent coverage', () => {
  it('maps neutral pixel centres, without making outside letterbox coverage opaque', () => {
    const mapping = compileSpatialMapping(pose(), 1920, 1080, 1280, 720);
    expect(mapping.neutral).toBe(true);
    expectUv(mapped(mapping, 0.5, 0.5), 0.5 / 1280, 0.5 / 720);
    expectUv(mapped(mapping, 1279.5, 719.5), 1279.5 / 1280, 719.5 / 720);
    expectUv(mapped(mapping, 640, 360), 0.5, 0.5);
    const letterboxed = compileSpatialMapping(pose(), 1000, 1000, 1280, 720);
    const outside = mapped(letterboxed, 0.5, 360);
    expect(outside[0]).toBeLessThan(0);
    expect(spatialCoverage(letterboxed, outside[0]!, outside[1]!)).toBe(0);
    expect(spatialCoverage(letterboxed, 0.5, 0.5)).toBe(1);
    expect(letterboxed.neutral).toBe(true);
  });

  it('uniformly scales about the original centre', () => {
    const mapping = compileSpatialMapping(pose({ scale: 2 }), 1920, 1080, 1280, 720);
    expectUv(mapped(mapping, 0, 0), 0.25, 0.25);
    expectUv(mapped(mapping, 1280, 720), 0.75, 0.75);
    expectUv(mapped(mapping, 640, 360), 0.5, 0.5);
    expect(mapping.neutral).toBe(false);
    const small = compileSpatialMapping(pose({ scale: 0.5 }), 1920, 1080, 1280, 720);
    expectUv(mapped(small, 0, 0), -0.5, -0.5);
    expect(spatialCoverage(small, -0.5, -0.5)).toBe(0);
  });

  it('translates by full-output fractions, not fitted-image fractions', () => {
    const mapping = compileSpatialMapping(pose({ translateX: 0.25, translateY: -0.1 }), 1000, 1000, 1280, 720);
    expectUv(mapped(mapping, 960, 288), 0.5, 0.5);
    expectUv(mapped(mapping, 640, 360), 0.5 - 320 / 720, 0.6);
  });

  it.each([90, -90, 180, -180])('inverts %s-degree clockwise rotation in positive-Y-down pixels', (rotation) => {
    const mapping = compileSpatialMapping(pose({ rotation }), 1000, 1000, 1000, 1000);
    const expected: Record<number, readonly [number, number]> = {
      90: [0.5, 0.25],
      [-90]: [0.5, 0.75],
      180: [0.25, 0.5],
      [-180]: [0.25, 0.5],
    };
    expectUv(mapped(mapping, 750, 500), ...expected[rotation]!);
  });

  it('crops in unchanged original UV with half-open bounds, without refit or recentering', () => {
    const mapping = compileSpatialMapping(
      pose({ cropLeft: 0.2, cropRight: 0.3, cropTop: 0.1, cropBottom: 0.25 }),
      1920,
      1080,
      1280,
      720,
    );
    expectUv(mapped(mapping, 640, 360), 0.5, 0.5);
    expect(mapping.fittedWidth).toBe(1280);
    expect(mapping.fittedHeight).toBe(720);
    for (const [u, v, coverage] of [
      [0.2, 0.1, 1],
      [0.699, 0.749, 1],
      [0.199, 0.5, 0],
      [0.7, 0.5, 0],
      [0.5, 0.099, 0],
      [0.5, 0.75, 0],
      [-1, 0.5, 0],
      [0.5, 2, 0],
    ])
      expect(spatialCoverage(mapping, u!, v!)).toBe(coverage);
    const neutral = compileSpatialMapping(pose(), 100, 100, 100, 100);
    expect(spatialCoverage(neutral, 0, 0)).toBe(1);
    expect(spatialCoverage(neutral, 1, 0.5)).toBe(0);
    expect(spatialCoverage(neutral, 0.5, 1)).toBe(0);
  });

  it('uses unrounded original aspect, not rounded proxy/preparation geometry', () => {
    const mapping = compileSpatialMapping(pose(), 4031, 3023, 1280, 720);
    expect(mapping.fittedWidth).toBeCloseTo((720 * 4031) / 3023, 12);
    expect(mapping.fittedWidth).not.toBe(Math.round(mapping.fittedWidth));
    expectUv(mapped(mapping, 640 + mapping.fittedWidth / 4, 540), 0.75, 0.75);
    const portrait = compileSpatialMapping(pose(), 1080, 1920, 1280, 720);
    expect(portrait.fittedWidth).toBe(405);
    expectUv(mapped(portrait, 640 + 405 / 4, 540), 0.75, 0.75);
    const wide = compileSpatialMapping(pose(), 3000, 1000, 1280, 720);
    expect(wide.fittedWidth).toBe(1280);
    expectUv(mapped(wide, 960, 360 + wide.fittedHeight / 4), 0.75, 0.75);
  });

  it.each([
    [1280, 720],
    [3840, 2160],
  ])('inverts combined crop/scale/rotation/translation at %sx%s', (width, height) => {
    const value = pose({
      scale: 1.7,
      rotation: 37,
      translateX: 0.15,
      translateY: -0.2,
      cropLeft: 0.1,
      cropRight: 0.2,
      cropTop: 0.05,
      cropBottom: 0.25,
    });
    const mapping = compileSpatialMapping(value, 4031, 3023, width, height);
    // Independent forward construction from the original point, in physical pixels.
    const fit = Math.min(width / 4031, height / 3023);
    const angle = (37 * Math.PI) / 180;
    for (const [u, v, coverage] of [
      [0.3, 0.4, 1],
      [0.05, 0.4, 0],
      [0.9, 0.4, 0],
      [0.3, 0.9, 0],
    ]) {
      const sourceX = (u! - 0.5) * 4031 * fit * value.scale;
      const sourceY = (v! - 0.5) * 3023 * fit * value.scale;
      const x = width * (0.5 + value.translateX) + Math.cos(angle) * sourceX - Math.sin(angle) * sourceY;
      const y = height * (0.5 + value.translateY) + Math.sin(angle) * sourceX + Math.cos(angle) * sourceY;
      const uv = mapped(mapping, x, y);
      expectUv(uv, u!, v!);
      expect(spatialCoverage(mapping, uv[0]!, uv[1]!)).toBe(coverage);
    }
  });

  it('exposes resolution-independent affine rows for GPU and reusable native point storage', () => {
    const value = pose({ scale: 0.7, rotation: -53, translateX: -0.25, translateY: 0.1 });
    const hd = compileSpatialMapping(value, 4031, 3023, 1280, 720);
    const uhd = compileSpatialMapping(value, 4031, 3023, 3840, 2160);
    for (let index = 0; index < 6; index++) expect(hd.affine[index]).toBeCloseTo(uhd.affine[index]!, 12);
    const out = new Float64Array(2);
    for (const [x, y] of [
      [0.5, 0.5],
      [360.5, 512.5],
      [1279.5, 719.5],
    ]) {
      expect(mapSpatialPoint(hd, x!, y!, out)).toBe(out);
      expectUv(mapped(uhd, x! * 3, y! * 3), out[0]!, out[1]!);
      const [a, b, c, d, e, f] = hd.affine;
      expectUv(Array.from(out), (a * x!) / 1280 + (b * y!) / 720 + c, (d * x!) / 1280 + (e * y!) / 720 + f);
    }
    expect(Object.isFrozen(hd)).toBe(true);
    expect(Object.isFrozen(hd.affine)).toBe(true);
  });

  it('provides independent binary dissolve-source masks, with no implicit opaque padding', () => {
    const first = compileSpatialMapping(pose({ translateX: -0.25, scale: 0.5 }), 100, 100, 100, 100);
    const second = compileSpatialMapping(pose({ translateX: 0.25, scale: 0.5 }), 100, 100, 100, 100);
    for (const [x, firstMask, secondMask] of [
      [25, 1, 0],
      [75, 0, 1],
      [0, 1, 0],
      [100, 0, 0],
    ]) {
      const firstUv = mapped(first, x!, 50);
      const secondUv = mapped(second, x!, 50);
      const maskA = spatialCoverage(first, firstUv[0]!, firstUv[1]!);
      const maskB = spatialCoverage(second, secondUv[0]!, secondUv[1]!);
      expect(maskA).toBe(firstMask);
      expect(maskB).toBe(secondMask);
      // Illustration only: existing opacity and dissolve weights stay independent of geometry.
      const coverage = 0.6 * (0.25 * maskA + 0.75 * maskB);
      expect(coverage).toBeCloseTo(0.6 * (0.25 * firstMask! + 0.75 * secondMask!), 12);
      expect(Number.isFinite(coverage)).toBe(true);
    }
  });

  it('rejects nonpositive/nonfinite dimensions and unrepresentable derived geometry', () => {
    for (const invalid of [0, -1, ...nonfinite]) {
      for (let index = 0; index < 4; index++) {
        const dimensions: [number, number, number, number] = [1920, 1080, 1280, 720];
        dimensions[index] = invalid;
        expect(() => compileSpatialMapping(pose(), ...dimensions)).toThrow();
      }
    }
    expect(() => compileSpatialMapping(pose(), Number.MAX_VALUE, Number.MIN_VALUE, 1280, 720)).toThrow();
    expect(() => compileSpatialMapping(pose(), Number.MIN_VALUE, Number.MIN_VALUE, 1280, 720)).toThrow();
  });

  it('rejects nonfinite coordinates/coverage and invalid output buffers without partial writes', () => {
    const mapping = compileSpatialMapping(pose(), 1920, 1080, 1280, 720);
    const out = new Float64Array([7, 9]);
    for (const invalid of nonfinite) {
      expect(() => mapSpatialPoint(mapping, invalid, 0, out)).toThrow('finite');
      expect(() => mapSpatialPoint(mapping, 0, invalid, out)).toThrow('finite');
      expect(() => spatialCoverage(mapping, invalid, 0)).toThrow('finite');
      expect(() => spatialCoverage(mapping, 0, invalid)).toThrow('finite');
      expect(Array.from(out)).toEqual([7, 9]);
    }
    for (const length of [0, 1, 3])
      expect(() => mapSpatialPoint(mapping, 0, 0, new Float64Array(length))).toThrow('two-element');
    const tiny = compileSpatialMapping(pose(), 1, 1, Number.MIN_VALUE, Number.MIN_VALUE);
    expect(() => mapSpatialPoint(tiny, Number.MAX_VALUE, 0, out)).toThrow('finite');
    expect(Array.from(out)).toEqual([7, 9]);
  });
});
