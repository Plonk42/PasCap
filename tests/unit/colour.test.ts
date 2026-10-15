import { describe, expect, it } from 'vitest';
import {
  COLOUR_CONTROLS,
  colourSchema,
  decode709,
  encode709,
  generateCube,
  gradePixel,
  HIGHLIGHTS_WHITE,
  NEUTRAL_COLOUR,
  type RGB,
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
    { tone: { highlights: 1 }, white: 1 },
    { tone: { highlights: -1 }, white: 1 - HIGHLIGHTS_WHITE },
    { tone: { contrast: 2, brightness: -0.5, shadows: -1, highlights: -1 }, white: 1 - HIGHLIGHTS_WHITE },
    { tone: { contrast: 0, brightness: 0.5, shadows: 1, highlights: 1 }, white: 1 },
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
  it('highlights mirror shadows on bright tones and only dim white when lowered', () => {
    const grey = (v: number, highlights: number) => gradePixel([v, v, v], { ...NEUTRAL_COLOUR, highlights })[0];
    expect(grey(2 / 3, 1)).toBeCloseTo(2 / 3 + 4 / 27, 10);
    expect(grey(2 / 3, -1)).toBeCloseTo(2 / 3 - 4 / 27 - (HIGHLIGHTS_WHITE * 8) / 27, 10);
    expect(grey(1, 1)).toBeCloseTo(1, 10);
    expect(grey(1, -1)).toBeCloseTo(1 - HIGHLIGHTS_WHITE, 10);
  });
  it('shadows lift dark tones by a luminance gain, keeping black, white and colour ratios', () => {
    const lift = { ...NEUTRAL_COLOUR, shadows: 1 };
    expect(gradePixel([0, 0, 0], lift)).toEqual([0, 0, 0]);
    expect(gradePixel([1, 1, 1], lift)[0]).toBeCloseTo(1, 10);
    expect(gradePixel([0.2, 0.2, 0.2], lift)[0]).toBeCloseTo(0.2 + 0.2 * 0.8 ** 2, 10);
    expect(gradePixel([0.2, 0.2, 0.2], { ...NEUTRAL_COLOUR, shadows: -1 })[0]).toBeCloseTo(0.2 - 0.2 * 0.8 ** 2, 10);
    const dark: RGB = [0.05, 0.1, 0.3];
    const lifted = gradePixel(dark, lift);
    const linear = dark.map(decode709);
    const gained = lifted.map(decode709);
    expect(gained[2]! / gained[0]!).toBeCloseTo(linear[2]! / linear[0]!, 6);
    expect(gained[1]! / gained[0]!).toBeCloseTo(linear[1]! / linear[0]!, 6);
    expect(lifted[2]).toBeGreaterThan(dark[2] + 0.1);
  });
  it('zero saturation removes chroma, hue leaves grey alone', () => {
    const grey = gradePixel([0.7, 0.2, 0.4], { ...NEUTRAL_COLOUR, saturation: 0 });
    expect(grey[0]).toBeCloseTo(grey[1], 10);
    expect(grey[1]).toBeCloseTo(grey[2], 10);
    expect(gradePixel([0.4, 0.4, 0.4], { ...NEUTRAL_COLOUR, hue: 130 })[0]).toBeCloseTo(0.4, 10);
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
