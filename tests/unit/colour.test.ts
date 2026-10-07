import { describe, expect, it } from 'vitest';
import {
  COLOUR_CONTROLS,
  colourSchema,
  decode709,
  encode709,
  generateCube,
  gradePixel,
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
  it('contrast pivots at 18% linear light', () => {
    const pivot = encode709(0.18);
    expect(gradePixel([pivot, pivot, pivot], { ...NEUTRAL_COLOUR, contrast: 2 })[0]).toBeCloseTo(pivot, 10);
  });
  it('brightness is a linear offset', () => {
    expect(gradePixel([0, 0, 0], { ...NEUTRAL_COLOUR, brightness: 0.1 })[0]).toBeCloseTo(encode709(0.1), 10);
  });
  it('shadow/highlight controls use fixed squared luminance masks', () => {
    expect(gradePixel([0, 0, 0], { ...NEUTRAL_COLOUR, shadows: 1 })[0]).toBeCloseTo(encode709(0.25), 10);
    expect(gradePixel([1, 1, 1], { ...NEUTRAL_COLOUR, highlights: -1 })[0]).toBeCloseTo(encode709(0.75), 10);
  });
  it('zero saturation removes chroma, hue leaves grey alone', () => {
    const grey = gradePixel([0.7, 0.2, 0.4], { ...NEUTRAL_COLOUR, saturation: 0 });
    expect(grey[0]).toBeCloseTo(grey[1], 10);
    expect(grey[1]).toBeCloseTo(grey[2], 10);
    expect(gradePixel([0.4, 0.4, 0.4], { ...NEUTRAL_COLOUR, hue: 130 })[0]).toBeCloseTo(0.4, 10);
  });
  it('clips gamut and rejects incomplete/out-of-range/non-finite settings', () => {
    const result = gradePixel([1, 0.8, 0], {
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
