import { describe, expect, it } from 'vitest';
import {
  createColorCurves,
  createHslSettings,
  evaluateColorCurve,
  type ColorCurves,
} from '../../src/shared/advanced-color.js';
import { analyzeAutoAdjust, AUTO_ADJUST_SETTINGS, type AutoCorrection } from '../../src/shared/auto-adjust.js';
import { createColorSettings, type ColorSettings } from '../../src/shared/color.js';
import {
  curvesTowardsMatch,
  effectsTowardsMatch,
  frameSimilarity,
  hslTowardsMatch,
  matchFrame,
  matchStyle,
  measureLook,
  sceneLikeness,
  STYLE_BOUNDS,
  towardsMatch,
  type FrameMatch,
  type LookProfile,
} from '../../src/shared/look-match.js';
import { type AnalysisFrame } from '../../src/shared/white-balance.js';
import { apply, flat, frame, frames, scene } from './analysis-fixtures.js';

const graded = (values: Partial<ColorSettings>): ColorSettings => ({ ...createColorSettings(), ...values });
const eleven = (color: ColorSettings): AutoCorrection =>
  Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, color[setting]])) as AutoCorrection;

/** Mean absolute difference of two frames' encoded RGB, 0–1. */
function difference(left: AnalysisFrame, right: AnalysisFrame): number {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < left.data.length; index += 4)
    for (let channel = 0; channel < 3; channel++) {
      sum += Math.abs(left.data[index + channel]! - right.data[index + channel]!);
      count++;
    }
  return sum / count / 255;
}

function match(reference: AnalysisFrame, color: ColorSettings, target: AnalysisFrame): FrameMatch {
  const result = matchFrame({ frame: reference, color }, { frame: target, color: createColorSettings() });
  if (!result) throw new Error('Expected a match.');
  return result;
}

/** A graded hero: a look worth matching, beyond a balance. */
const LOOK = graded({ exposure: 0.15, contrast: 1.25, saturation: 1.15, temperature: 0.12, tint: -0.04 });

describe('Frame matching', () => {
  const hero = frame(scene(1));
  const heroOutput = apply(hero, eleven(LOOK));

  it('matches the same scene shot differently picture to picture', () => {
    for (const options of [
      { gain: 0.45, light: [1.2, 1, 0.8] as const, chroma: 0.4 },
      { gain: 1.6, light: [0.9, 1, 1.15] as const },
    ]) {
      const shot = frame(scene(1, options));
      const before = difference(apply(shot, eleven(LOOK)), heroOutput);
      const result = match(hero, LOOK, shot);
      expect(result.likeness).toBe(1);
      const after = difference(apply(shot, result.correction), heroOutput);
      expect(before).toBeGreaterThan(0.06);
      expect(after).toBeLessThan(0.03);
    }
  });

  it('brings flat footage of the scene to the graded hero', () => {
    const shot = frame(flat(scene(1)));
    const result = match(hero, LOOK, shot);
    expect(result.correction.contrast).toBeGreaterThan(LOOK.contrast);
    expect(result.correction.blacks).toBeLessThan(-0.2);
    expect(Math.abs(result.correction.temperature - LOOK.temperature)).toBeLessThan(0.05);
    expect(difference(apply(shot, eleven(LOOK)), heroOutput)).toBeGreaterThan(0.06);
    expect(difference(apply(shot, result.correction), heroOutput)).toBeLessThan(0.035);
  });

  it('gives another scene the hero’s light and look instead of copying its statistics', () => {
    // A brighter, warmer scene: matching its statistics to the hero's would darken it and push its settings away.
    const other = frame(scene(50, { gain: 1.7, light: [1.15, 1, 0.85] }));
    const result = match(hero, LOOK, other);
    expect(result.likeness).toBe(0);
    const theirs = analyzeAutoAdjust([hero])!;
    const ours = analyzeAutoAdjust([other])!;
    // The hero's settings, with the difference of light the two frames' Auto corrections see.
    expect(result.correction.contrast).toBeCloseTo(LOOK.contrast, 3);
    expect(result.correction.saturation).toBeCloseTo(LOOK.saturation, 3);
    expect(result.correction.exposure).toBeCloseTo(LOOK.exposure + ours.exposure - theirs.exposure, 2);
    expect(result.correction.temperature).toBeCloseTo(LOOK.temperature + ours.temperature - theirs.temperature, 2);
  });

  it('leaves the hero’s own frame as graded', () => {
    const result = match(hero, LOOK, hero);
    for (const setting of AUTO_ADJUST_SETTINGS)
      expect(Math.abs(result.correction[setting] - LOOK[setting])).toBeLessThan(0.005);
  });

  it('keeps every setting within reach of its start, however unlike the frames', () => {
    const dark = frame(scene(1, { gain: 0.08 }));
    const result = match(hero, LOOK, dark);
    expect(result.correction.contrast).toBeLessThanOrEqual(2);
    expect(result.correction.exposure).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.log2(result.correction.saturation / LOOK.saturation))).toBeLessThanOrEqual(
      Math.log2(1.3) + 1e-3,
    );
  });

  it('is deterministic and needs usable pixels', () => {
    const shot = frame(scene(1, { gain: 0.7 }));
    expect(match(hero, LOOK, shot)).toEqual(match(hero, LOOK, shot));
    expect(Object.keys(match(hero, LOOK, shot).correction).sort()).toEqual([...AUTO_ADJUST_SETTINGS].sort());
    const black = frame(() => [0, 0, 0]);
    expect(matchFrame({ frame: hero, color: LOOK }, { frame: black, color: createColorSettings() })).toBeNull();
    expect(matchFrame({ frame: black, color: LOOK }, { frame: hero, color: createColorSettings() })).toBeNull();
  });
});

describe('Scene likeness', () => {
  it('sees one scene through exposure, white balance and contrast, and tells scenes apart', () => {
    const base = frame(scene(3));
    expect(frameSimilarity(base, frame(scene(3, { gain: 0.4, light: [1.3, 1, 0.7] })))).toBeGreaterThan(0.95);
    expect(frameSimilarity(base, frame(flat(scene(3))))).toBeGreaterThan(0.9);
    for (const seed of [4, 9, 30]) expect(frameSimilarity(base, frame(scene(seed)))).toBeLessThan(0.4);
    expect(
      frameSimilarity(
        base,
        frame(() => [0.2, 0.2, 0.2]),
      ),
    ).toBe(0);
  });

  it('trusts the fitted picture between the similar bounds only', () => {
    expect(sceneLikeness(0.2)).toBe(0);
    expect(sceneLikeness(0.5)).toBe(0);
    expect(sceneLikeness(0.7)).toBeCloseTo(0.5, 5);
    expect(sceneLikeness(0.95)).toBe(1);
  });
});

describe('Match curves', () => {
  const hero = frame(scene(1));
  /** Cool shadows and warm highlights over LOOK. */
  const SPLIT: ColorCurves = {
    ...createColorCurves(),
    red: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.2 },
      { x: 0.75, y: 0.8 },
      { x: 1, y: 1 },
    ],
    blue: [
      { x: 0, y: 0.04 },
      { x: 0.25, y: 0.3 },
      { x: 0.75, y: 0.7 },
      { x: 1, y: 0.96 },
    ],
  };
  const SPLIT_LOOK = { ...LOOK, curves: SPLIT };
  const heroOutput = apply(hero, eleven(LOOK), SPLIT_LOOK);
  const shot = frame(scene(1, { gain: 0.6, light: [1.15, 1, 0.85] }));
  const withCurves = (curves: ColorCurves | null): ColorSettings => ({
    ...createColorSettings(),
    ...(curves && { curves }),
  });

  it('takes a graded reference’s curves on a clip without any', () => {
    const result = match(hero, SPLIT_LOOK, shot);
    expect(result.curves).not.toBeNull();
    const after = difference(apply(shot, result.correction, withCurves(result.curves)), heroOutput);
    expect(after).toBeLessThan(0.03);
    expect(difference(apply(shot, result.correction), heroOutput)).toBeGreaterThan(after * 1.5);
    // Another scene takes them too, like the reference's eleven settings.
    expect(match(hero, SPLIT_LOOK, frame(scene(50))).curves).toEqual(SPLIT);
  });

  it('brings each channel towards a split-toned picture as shot', () => {
    const result = match(heroOutput, createColorSettings(), shot);
    const { red, blue } = result.curves!;
    // Blue rises over red in the shadows and falls under it in the highlights.
    expect(evaluateColorCurve(blue, 0.15) - evaluateColorCurve(red, 0.15)).toBeGreaterThan(0.01);
    expect(evaluateColorCurve(red, 0.85) - evaluateColorCurve(blue, 0.85)).toBeGreaterThan(0.01);
    const without = difference(apply(shot, result.correction), heroOutput);
    expect(difference(apply(shot, result.correction, withCurves(result.curves)), heroOutput)).toBeLessThan(
      without * 0.85,
    );
  });

  it('leaves the curves identity when the picture needs none', () => {
    expect(match(hero, createColorSettings(), hero).curves).toEqual(createColorCurves());
    expect(match(hero, LOOK, hero).curves).toEqual(createColorCurves());
  });

  it('never changes curves the clip has', () => {
    const own = { ...createColorSettings(), curves: { ...createColorCurves(), master: SPLIT.red } };
    expect(matchFrame({ frame: hero, color: SPLIT_LOOK }, { frame: shot, color: own })!.curves).toBeNull();
  });

  it('scales the curves with Intensity and is deterministic', () => {
    const curves = match(hero, SPLIT_LOOK, shot).curves!;
    expect(match(hero, SPLIT_LOOK, shot).curves).toEqual(curves);
    expect(curvesTowardsMatch(curves, 0)).toEqual(
      Object.fromEntries(Object.entries(curves).map(([key, points]) => [key, points.map(({ x }) => ({ x, y: x }))])),
    );
    expect(curvesTowardsMatch(curves, 1)).toEqual(curves);
    expect(curvesTowardsMatch(curves, 0.5).blue[0]!.y).toBeCloseTo(curves.blue[0]!.y / 2, 3);
    expect(() => curvesTowardsMatch(curves, -0.1)).toThrow(/Intensity/);
  });
});

describe('Match HSL', () => {
  const hero = frame(scene(1));
  const HSL = {
    ...createHslSettings(),
    orange: { hue: 6, saturation: -0.16, lightness: 0 },
    blue: { hue: 0, saturation: -0.45, lightness: -0.085 },
  };
  const HSL_LOOK = { ...LOOK, hsl: HSL };
  const heroOutput = apply(hero, eleven(LOOK), HSL_LOOK);
  const shot = frame(scene(1, { gain: 0.6, light: [1.15, 1, 0.85] }));

  it('takes a graded reference’s HSL on a clip whose HSL is neutral, whatever the scene', () => {
    const result = match(hero, HSL_LOOK, shot);
    expect(result.hsl).toEqual(HSL);
    const after = difference(
      apply(shot, result.correction, { ...createColorSettings(), hsl: result.hsl! }),
      heroOutput,
    );
    expect(after).toBeLessThan(0.03);
    expect(difference(apply(shot, result.correction), heroOutput)).toBeGreaterThan(after);
    expect(match(hero, HSL_LOOK, frame(scene(50))).hsl).toEqual(HSL);
    expect(match(hero, LOOK, shot).hsl).toBeNull();
  });

  it('never changes HSL the clip has', () => {
    const own = {
      ...createColorSettings(),
      hsl: { ...createHslSettings(), green: { hue: 5, saturation: 0, lightness: 0 } },
    };
    expect(matchFrame({ frame: hero, color: HSL_LOOK }, { frame: shot, color: own })!.hsl).toBeNull();
  });

  it('scales the HSL with Intensity', () => {
    expect(hslTowardsMatch(HSL, 0)).toEqual(createHslSettings());
    expect(hslTowardsMatch(HSL, 1)).toEqual(HSL);
    const half = hslTowardsMatch(HSL, 0.5).blue;
    expect(half.saturation).toBe(-0.225);
    expect(half.lightness).toBeCloseTo(-0.0425, 2);
    expect(() => hslTowardsMatch(HSL, 2)).toThrow(/Intensity/);
  });
});

describe('Match HDR and Local contrast', () => {
  const hero = frame(scene(1));
  const shot = frame(scene(1, { gain: 0.6 }));
  const EFFECTS_LOOK = { ...LOOK, hdr: 0.4, localContrast: 0.2 };

  it('takes the reference’s where the clip has none, whatever the scene', () => {
    expect(match(hero, EFFECTS_LOOK, shot).effects).toEqual({ hdr: 0.4, localContrast: 0.2 });
    expect(match(hero, EFFECTS_LOOK, frame(scene(50))).effects).toEqual({ hdr: 0.4, localContrast: 0.2 });
    expect(match(hero, LOOK, shot).effects).toEqual({});
    const own = { ...createColorSettings(), hdr: 0.1 };
    expect(matchFrame({ frame: hero, color: EFFECTS_LOOK }, { frame: shot, color: own })!.effects).toEqual({
      localContrast: 0.2,
    });
  });

  it('scales them with Intensity', () => {
    expect(effectsTowardsMatch({ hdr: 0.4, localContrast: -0.3 }, 0.5)).toEqual({ hdr: 0.2, localContrast: -0.15 });
    expect(effectsTowardsMatch({ hdr: 0.4 }, 0)).toEqual({ hdr: 0 });
    expect(() => effectsTowardsMatch({}, 1.1)).toThrow(/Intensity/);
  });
});

describe('Match intensity', () => {
  it('moves the grade from its values to the match', () => {
    const current = graded({ exposure: -0.2, contrast: 1.2, temperature: 0.1 });
    const matched = { ...eleven(createColorSettings()), exposure: 0.6, contrast: 0.8, temperature: -0.3 };
    expect(towardsMatch(current, matched, 0)).toEqual(eleven(current));
    expect(towardsMatch(current, matched, 1)).toEqual(matched);
    const half = towardsMatch(current, matched, 0.5);
    expect(half.exposure).toBeCloseTo(0.2, 3);
    expect(half.temperature).toBeCloseTo(-0.1, 3);
    expect(half.contrast).toBeCloseTo(Math.sqrt(1.2 * 0.8), 3);
    expect(() => towardsMatch(current, matched, 1.5)).toThrow(/Intensity/);
  });
});

describe('Style matching', () => {
  it('moves Auto’s balance towards a registered style within Auto’s bounds', () => {
    // The style's references: brighter, softer and less colorful finished footage of other scenes.
    const style: LookProfile = measureLook(frames(8, (seed) => scene(seed + 200, { gain: 1.6, chroma: 0.45 })))!;
    const shot = frame(scene(240, { gain: 0.8 }));
    const styled = matchStyle(style, { frame: shot, color: createColorSettings() })!;
    const generic = analyzeAutoAdjust([shot])!;
    const distance = (correction: AutoCorrection): number => {
      const result = measureLook([shot], graded(correction))!;
      return (
        Math.abs(result.middle - style.middle) +
        Math.abs(result.muted - style.muted) +
        Math.abs(result.strong - style.strong)
      );
    };
    expect(distance(styled)).toBeLessThan(distance(generic) * 0.75);
    for (const [key, { low, high }] of Object.entries(STYLE_BOUNDS)) {
      expect(styled[key as keyof AutoCorrection]).toBeGreaterThanOrEqual(low);
      expect(styled[key as keyof AutoCorrection]).toBeLessThanOrEqual(high);
    }
    expect(matchStyle(style, { frame: frame(() => [0, 0, 0]), color: createColorSettings() })).toBeNull();
  });
});
