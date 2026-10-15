import { describe, expect, it } from 'vitest';
import {
  colourSchema,
  compilePixelGrade,
  createColourSettings,
  decode709,
  encode709,
  gradePixel,
  isNeutralAdvancedColour,
  temperatureTintGains,
  type RGB,
} from '../../src/shared/colour.js';
import { EMPTY_KEY_VALUES, layerKeyframeSchema, uniformKeyframe } from '../../src/shared/keyframes.js';
import { createLayer, createProject, projectSchema } from '../../src/shared/model.js';

const luma: RGB = [0.2126, 0.7152, 0.0722];
const axes = [-1, -0.234567891, 0, 0.123456789, 1];

describe('normalized linear Temperature and Tint', () => {
  it('keeps exact neutral identity and makes new rows neutral without compatibility defaults', () => {
    const settings = createColourSettings();
    expect(temperatureTintGains(settings)).toEqual([1, 1, 1]);
    const input: RGB = [0.123456789, 0.4, 0.78];
    expect(gradePixel(input, settings)).toBe(input);
    expect(compilePixelGrade(settings)(input)).toBe(input);
    expect(createLayer('empty', 'Empty').colour).toEqual(settings);
    expect(Object.keys(EMPTY_KEY_VALUES)).toHaveLength(11);
    const project = createProject('strict', 'Strict');
    expect(project.schemaVersion).toBe(19);
    for (let schemaVersion = 1; schemaVersion < 19; schemaVersion++)
      expect(projectSchema.safeParse({ ...project, schemaVersion }).success).toBe(false);
    for (const channel of ['temperature', 'tint'] as const) {
      const incomplete = { ...settings };
      delete (incomplete as Partial<typeof settings>)[channel];
      expect(colourSchema.safeParse(incomplete).success).toBe(false);
      const values: Partial<typeof EMPTY_KEY_VALUES> = { ...EMPTY_KEY_VALUES, exposure: 0 };
      delete values[channel];
      expect(layerKeyframeSchema.safeParse({ ...uniformKeyframe(0, values, 'linear'), reset: false }).success).toBe(
        false,
      );
      for (const value of [-1.000001, 1.000001, NaN, Infinity, -Infinity, null, undefined])
        expect(colourSchema.safeParse({ ...settings, [channel]: value }).success).toBe(false);
      for (const value of [-1, 0, 0.123456789, 1])
        expect(colourSchema.parse({ ...settings, [channel]: value })[channel]).toBe(value);
    }
  });

  it('has positive finite gains, documented axis ratios and unit neutral-white luminance throughout the domain', () => {
    for (const temperature of axes) {
      for (const tint of axes) {
        const gains = temperatureTintGains({ temperature, tint });
        expect(gains.every((gain) => Number.isFinite(gain) && gain > 0)).toBe(true);
        expect(gains.reduce((sum, gain, channel) => sum + gain * luma[channel]!, 0)).toBeCloseTo(1, 14);
        expect(gains[0] / gains[2]).toBeCloseTo(2 ** temperature, 14);
        expect(Math.sqrt(gains[0] * gains[2]) / gains[1]).toBeCloseTo(2 ** (tint / 2), 14);
      }
    }
  });

  it('intentionally warms/cools and magenta/green-tints greys while preserving pre-clipping linear luminance', () => {
    const neutral = createColourSettings();
    for (const temperature of [-1, 1]) {
      const result = gradePixel([0.3, 0.3, 0.3], { ...neutral, temperature });
      expect((result[0] - result[2]) * temperature).toBeGreaterThan(0);
      expect(result.reduce((sum, code, channel) => sum + decode709(code) * luma[channel]!, 0)).toBeCloseTo(
        decode709(0.3),
        12,
      );
    }
    for (const tint of [-1, 1]) {
      const result = gradePixel([0.3, 0.3, 0.3], { ...neutral, tint });
      expect((result[0] - result[1]) * tint).toBeGreaterThan(0);
      expect(result[0]).toBeCloseTo(result[2], 12);
    }
  });

  it('applies independent gains before exposure, contrast and brightness, never in encoded or chroma space', () => {
    const settings = {
      ...createColourSettings(),
      temperature: 0.7,
      tint: -0.6,
      exposure: 0.4,
      contrast: 1.2,
      brightness: 0.02,
    };
    const input: RGB = [0.2, 0.3, 0.4];
    const raw = [Math.pow(2, 0.7 / 2 - 0.6 / 4), Math.pow(2, 0.6 / 4), Math.pow(2, -0.7 / 2 - 0.6 / 4)];
    const whiteY = raw.reduce((sum, gain, channel) => sum + luma[channel]! * gain, 0);
    const linear = input.map((code, channel) => ((decode709(code) * raw[channel]!) / whiteY) * Math.pow(2, 0.4));
    const y = linear.reduce((sum, value, channel) => sum + luma[channel]! * value, 0);
    const encoded = encode709(y);
    const contrasted = encoded + 0.2 * encoded * (1 - encoded) * (2 * encoded - 1);
    const gain = decode709(contrasted + 0.04 * contrasted * (1 - contrasted)) / y;
    const expected = linear.map((value) => encode709(value * gain));
    gradePixel(input, settings).forEach((value, channel) => expect(value).toBeCloseTo(expected[channel]!, 12));
    expect(isNeutralAdvancedColour(settings)).toBe(true);
  });

  it('matches the reference exactly when compiling correction and sharp advanced settings once per frame', () => {
    for (const temperature of axes) {
      for (const tint of axes) {
        const settings = { ...createColourSettings(), temperature, tint, exposure: -0.2, saturation: 0.8, hue: 15 };
        settings.hsl.red = { hue: 12, saturation: -0.3, lightness: 0.02 };
        settings.curves.master = [
          { x: 0, y: 0.02 },
          { x: 0.49999, y: 0.1 },
          { x: 0.5, y: 0.9 },
          { x: 1, y: 0.98 },
        ];
        const compiled = compilePixelGrade(settings);
        for (let index = 0; index <= 32; index++) {
          const input: RGB = [index / 32, ((index * 17) % 33) / 32, ((index * 7) % 33) / 32];
          expect(compiled(input)).toEqual(gradePixel(input, settings));
        }
      }
    }
  });
});
