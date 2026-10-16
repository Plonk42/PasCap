import { describe, expect, it } from 'vitest';
import {
  BLACKS_RANGE,
  COLOUR_CONTROLS,
  colourSchema,
  decode709,
  encode709,
  generateCube,
  gradePixel,
  NEUTRAL_COLOUR,
  type RGB,
  WHITES_RANGE,
} from '../../src/shared/colour.js';
import { musicSchema } from '../../src/shared/model.js';

describe('authoritative colour transform', () => {
  it('is a neutral identity including the transfer-function join', () => {
    for (let index = 0; index <= 1000; index++) {
      const rgb: RGB = [index / 1000, ((index * 197) % 1001) / 1000, ((index * 31) % 1001) / 1000];
      const result = gradePixel(rgb, NEUTRAL_COLOUR);
      rgb.forEach((value, channel) => expect(result[channel]).toBeCloseTo(value, 10));
      expect(encode709(decode709(index / 1000))).toBeCloseTo(index / 1000, 10);
    }
  });
  it('exposure doubles linear light rather than encoded values', () => {
    const result = gradePixel([0.3, 0.3, 0.3], { ...NEUTRAL_COLOUR, exposure: 1 });
    expect(result[0]).toBeCloseTo(encode709(2 * decode709(0.3)), 10);
    expect(result[0]).not.toBeCloseTo(0.6, 2);
  });
  it('contrast is an S-curve on encoded luminance pivoting at 0.5', () => {
    const grey = (v: number, contrast: number) => gradePixel([v, v, v], { ...NEUTRAL_COLOUR, contrast })[0];
    expect(grey(0.5, 2)).toBeCloseTo(0.5, 10);
    expect(grey(0.25, 2)).toBeCloseTo(0.25 - 0.25 * 0.75 * 0.5, 10);
    expect(grey(0.25, 0)).toBeCloseTo(0.25 + 0.25 * 0.75 * 0.5, 10);
  });
  it('brightness is a midtone curve on encoded luminance', () => {
    const grey = (v: number, brightness: number) => gradePixel([v, v, v], { ...NEUTRAL_COLOUR, brightness })[0];
    expect(grey(0.5, 0.5)).toBeCloseTo(0.75, 10);
    expect(grey(0.5, -0.5)).toBeCloseTo(0.25, 10);
  });
  it.each([
    { tone: { contrast: 0 }, white: 1 },
    { tone: { contrast: 2 }, white: 1 },
    { tone: { brightness: 0.5 }, white: 1 },
    { tone: { brightness: -0.5 }, white: 1 },
    { tone: { whites: 1 }, white: 1 },
    { tone: { whites: -1 }, white: 1 - WHITES_RANGE },
    { tone: { blacks: -0.1 }, white: 1 },
    { tone: { contrast: 2, brightness: -0.5, whites: -1 }, white: 1 - WHITES_RANGE },
    { tone: { contrast: 0, brightness: 0.5, whites: 1 }, white: 1 },
  ])('tone curves $tone keep black, white, colour ratios and tone order', ({ tone, white }) => {
    const settings = { ...NEUTRAL_COLOUR, ...tone };
    expect(gradePixel([0, 0, 0], settings)).toEqual([0, 0, 0]);
    expect(gradePixel([1, 1, 1], settings)[0]).toBeCloseTo(white, 10);
    const dark: RGB = [0.03, 0.05, 0.1];
    const linear = dark.map(decode709);
    const graded = gradePixel(dark, settings).map(decode709);
    expect(graded[2]! / graded[0]!).toBeCloseTo(linear[2]! / linear[0]!, 6);
    expect(graded[1]! / graded[0]!).toBeCloseTo(linear[1]! / linear[0]!, 6);
    let previous = 0;
    for (let index = 1; index <= 200; index++) {
      const value = gradePixel([index / 200, index / 200, index / 200], settings)[0];
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
  });
  it('whites moves the white point with little effect below the upper tones', () => {
    const grey = (v: number, whites: number) => gradePixel([v, v, v], { ...NEUTRAL_COLOUR, whites })[0];
    expect(grey(1, -1)).toBeCloseTo(1 - WHITES_RANGE, 10);
    expect(grey(0.8, -1)).toBeCloseTo(0.8 - WHITES_RANGE * 0.8 ** 4, 10);
    expect(grey(0.8, 1)).toBeCloseTo(0.8 + WHITES_RANGE * 0.8 ** 4, 10);
    expect(grey(0.9, 1)).toBe(1);
    expect(Math.abs(grey(0.5, -1) - 0.5)).toBeLessThan(0.02);
  });
  it('blacks crushes near-black tones when lowered and lifts black like a matte when raised', () => {
    const grey = (v: number, blacks: number) => gradePixel([v, v, v], { ...NEUTRAL_COLOUR, blacks })[0];
    expect(grey(0, 1)).toBeCloseTo(BLACKS_RANGE, 10);
    expect(grey(0.5, 1)).toBeCloseTo(0.5 + BLACKS_RANGE * 0.5 ** 4, 10);
    expect(grey(0.1, -1)).toBe(0);
    expect(grey(0.5, -1)).toBeCloseTo(0.5 - BLACKS_RANGE * 0.5 ** 4, 10);
    expect(grey(1, 1)).toBeCloseTo(1, 10);
    expect(grey(1, -1)).toBeCloseTo(1, 10);
    let previous = 0;
    for (let index = 0; index <= 200; index++) {
      const value = grey(index / 200, 1);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
    // Fully lowered Blacks is a luminance gain, so tones it does not crush keep their colour ratios.
    const mid: RGB = [0.2, 0.3, 0.5];
    const linear = mid.map(decode709);
    const crushed = gradePixel(mid, { ...NEUTRAL_COLOUR, blacks: -1 }).map(decode709);
    expect(crushed[0]).toBeGreaterThan(0);
    expect(crushed[2]! / crushed[0]!).toBeCloseTo(linear[2]! / linear[0]!, 6);
    expect(crushed[1]! / crushed[0]!).toBeCloseTo(linear[1]! / linear[0]!, 6);
  });
  it('leaves Shadows and Highlights to the local tone stage, outside the per-pixel grade', () => {
    const input: RGB = [0.05, 0.1, 0.3];
    expect(gradePixel(input, { ...NEUTRAL_COLOUR, shadows: 1, highlights: -1 })).toBe(input);
  });
  it('zero saturation removes chroma, hue leaves grey alone', () => {
    const grey = gradePixel([0.7, 0.2, 0.4], { ...NEUTRAL_COLOUR, saturation: 0 });
    expect(grey[0]).toBeCloseTo(grey[1], 10);
    expect(grey[1]).toBeCloseTo(grey[2], 10);
    expect(gradePixel([0.4, 0.4, 0.4], { ...NEUTRAL_COLOUR, hue: 130 })[0]).toBeCloseTo(0.4, 10);
  });
  it('vibrance saturates muted colours most and leaves grey and saturated colours alone', () => {
    const chroma = (rgb: RGB) => {
      const linear = rgb.map(decode709);
      return (Math.max(...linear) - Math.min(...linear)) / Math.max(...linear);
    };
    const muted: RGB = [0.55, 0.62, 0.7];
    const strong: RGB = [0.9, 0.3, 0.1];
    for (const vibrance of [-1, 1]) {
      const settings = { ...NEUTRAL_COLOUR, vibrance };
      expect(gradePixel([0.4, 0.4, 0.4], settings)[0]).toBeCloseTo(0.4, 10);
      expect(Math.sign(chroma(gradePixel(muted, settings)) - chroma(muted))).toBe(vibrance);
    }
    const boosted = { ...NEUTRAL_COLOUR, vibrance: 1 };
    const saturated = { ...NEUTRAL_COLOUR, saturation: 1.5 };
    expect(chroma(gradePixel(strong, boosted)) - chroma(strong)).toBeLessThan(0.01);
    expect(chroma(gradePixel(strong, saturated)) - chroma(strong)).toBeGreaterThan(0.02);
    expect(chroma(gradePixel(muted, boosted))).toBeGreaterThan(chroma(muted) + 0.08);
    // The +2 maximum roughly doubles a muted colour's chroma, never a fully saturated one's.
    const strongest = { ...NEUTRAL_COLOUR, vibrance: 2 };
    expect(chroma(gradePixel(muted, strongest))).toBeGreaterThan(chroma(gradePixel(muted, boosted)) + 0.08);
    expect(gradePixel([1, 0, 0], strongest)).toEqual([1, 0, 0]);
    for (const invalid of [-1.01, 2.01])
      expect(colourSchema.safeParse({ ...NEUTRAL_COLOUR, vibrance: invalid }).success).toBe(false);
  });
  it('clips gamut and rejects incomplete/out-of-range/non-finite settings', () => {
    const result = gradePixel([1, 0.8, 0], {
      ...NEUTRAL_COLOUR,
      exposure: 3,
      brightness: 0.5,
      contrast: 2,
      hue: 180,
      saturation: 2,
      highlights: 1,
      shadows: -1,
    });
    expect(result.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(() => colourSchema.parse({ exposure: 0 })).toThrow();
    expect(() => colourSchema.parse({ ...NEUTRAL_COLOUR, exposure: 3.1 })).toThrow();
    expect(() => colourSchema.parse({ ...NEUTRAL_COLOUR, hue: Number.NaN })).toThrow();
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'Zod number schemas reject %s without a deprecated finite check',
    (value) => {
      for (const control of COLOUR_CONTROLS)
        expect(colourSchema.safeParse({ ...NEUTRAL_COLOUR, [control.key]: value }).success).toBe(false);
      const music = {
        id: 'music-instance',
        mediaId: 'music',
        sourceIn: 0,
        sourceOut: 60,
        start: 0,
        duration: 30,
        gainDb: value,
        fadeIn: 0,
        fadeOut: 0,
        loop: false,
      };
      expect(musicSchema.safeParse(music).success).toBe(false);
    },
  );
  it('writes deterministic red-fastest LUTs from the actual reference function', () => {
    const lines = generateCube(NEUTRAL_COLOUR, 2).trim().split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[4]).toBe('0.000000000 0.000000000 0.000000000');
    expect(lines[5]).toBe('1.000000000 0.000000000 0.000000000');
    expect(lines[6]).toBe('0.000000000 1.000000000 0.000000000');
    expect(() => generateCube(NEUTRAL_COLOUR, 1)).toThrow();
  });
});
