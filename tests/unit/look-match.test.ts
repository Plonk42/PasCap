import { describe, expect, it } from 'vitest';
import { AUTO_ADJUST_SETTINGS, type AutoCorrection } from '../../src/shared/auto-adjust.js';
import { createColorSettings, type ColorSettings } from '../../src/shared/color.js';
import { heroColor, matchLook, measureLook, type LookProfile } from '../../src/shared/look-match.js';
import { type AnalysisFrame } from '../../src/shared/white-balance.js';
import { flat, frame, frames, scene } from './analysis-fixtures.js';

const look = (input: readonly AnalysisFrame[], color?: ColorSettings): LookProfile => measureLook(input, color)!;

function match(hero: LookProfile, input: readonly AnalysisFrame[]): AutoCorrection {
  const correction = matchLook(hero, input);
  if (!correction) throw new Error('Expected a correction.');
  return correction;
}

/** The largest difference between two looks' luma levels, log-average and shadow areas, in encoded luma. */
function lumaGap(left: LookProfile, right: LookProfile): number {
  const values = (item: LookProfile): number[] => [...item.levels, item.middle, item.shadow];
  const other = values(right);
  return Math.max(...values(left).map((value, index) => Math.abs(value - other[index]!)));
}

const castGap = (left: LookProfile, right: LookProfile): number =>
  Math.hypot(left.cast!.temperature - right.cast!.temperature, left.cast!.tint - right.cast!.tint);

/** The correction's eleven settings as a grade. */
const graded = (values: Partial<ColorSettings>): ColorSettings => ({ ...createColorSettings(), ...values });
describe('Shot matching', () => {
  const hero = frames(8, (seed) => scene(seed));
  const heroLook = look(hero);

  it('brings an underexposed shot with a cast to the hero’s tone, color and light', () => {
    const shot = frames(8, (seed) => scene(seed + 40, { gain: 0.45, light: [1.2, 1, 0.8], chroma: 0.4 }));
    const before = look(shot);
    expect(lumaGap(before, heroLook)).toBeGreaterThan(0.15);
    expect(castGap(before, heroLook)).toBeGreaterThan(0.3);
    const correction = match(heroLook, shot);
    expect(correction.exposure).toBeGreaterThan(0.5);
    expect(correction.temperature).toBeLessThan(-0.2);
    const after = look(shot, graded(correction));
    expect(lumaGap(after, heroLook)).toBeLessThan(0.03);
    expect(castGap(after, heroLook)).toBeLessThan(0.08);
    expect(Math.abs(after.muted - heroLook.muted)).toBeLessThan(0.03);
    expect(Math.abs(after.strong - heroLook.strong)).toBeLessThan(0.03);
  });

  it('brings flat footage to a graded hero as it looks through its grade', () => {
    const color = graded({ exposure: 0.2, contrast: 1.1, saturation: 1.2, temperature: 0.25, shadows: 0.2 });
    const heroOutput = look(hero, color);
    // The hero's look is measured on its frames as graded.
    expect(lumaGap(heroOutput, heroLook)).toBeGreaterThan(0.05);
    const shot = frames(8, (seed) => flat(scene(seed + 80)));
    const correction = match(heroOutput, shot);
    const after = look(shot, graded(correction));
    expect(lumaGap(after, heroOutput)).toBeLessThan(0.03);
    expect(castGap(after, heroOutput)).toBeLessThan(0.08);
    expect(Math.abs(after.muted - heroOutput.muted)).toBeLessThan(0.03);
    expect(Math.abs(after.strong - heroOutput.strong)).toBeLessThan(0.03);
  });

  it('leaves a shot that already looks like the hero nearly unchanged', () => {
    const correction = match(
      heroLook,
      frames(8, (seed) => scene(seed + 120)),
    );
    expect(Math.abs(correction.exposure)).toBeLessThan(0.1);
    expect(Math.abs(correction.temperature)).toBeLessThan(0.05);
    expect(Math.abs(Math.log2(correction.contrast))).toBeLessThan(0.1);
    expect(Math.abs(Math.log2(correction.saturation))).toBeLessThan(0.15);
  });

  it('is deterministic and needs usable pixels', () => {
    const shot = frames(4, (seed) => scene(seed + 7, { gain: 0.7 }));
    expect(match(heroLook, shot)).toEqual(match(heroLook, shot));
    expect(Object.keys(match(heroLook, shot)).sort()).toEqual([...AUTO_ADJUST_SETTINGS].sort());
    const black = [frame(() => [0, 0, 0])];
    expect(matchLook(heroLook, black)).toBeNull();
    expect(measureLook(black)).toBeNull();
  });

  it('measures an animated hero at the middle analyzed frame', () => {
    const color = createColorSettings();
    const keyframes = [0, 100].map((frameNumber, index) => ({
      frame: frameNumber,
      reset: false,
      values: { ...Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, null])), exposure: index },
      easing: { ...Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, null])), exposure: 'linear' },
    }));
    const grade = { color, keyframes } as unknown as Parameters<typeof heroColor>[0];
    expect(heroColor(grade, [10, 50, 90]).exposure).toBeCloseTo(0.5, 5);
  });
});
