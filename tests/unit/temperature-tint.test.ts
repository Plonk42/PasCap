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
import { createAdjustment, gradeKeyframeSchema, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createProject, PROJECT_SCHEMA_VERSION, projectSchema } from '../../src/shared/model.js';
import { EARLIER_SCHEMA_VERSIONS } from './project-fixtures.js';

const luma: RGB = [0.2126, 0.7152, 0.0722];
const axes = [-2, -1, -0.234567891, 0, 0.123456789, 1, 2];

describe('normalized linear Temperature and Tint', () => {
  it('keeps exact neutral identity and makes new grades neutral without compatibility defaults', () => {
    const settings = createColourSettings();
    expect(temperatureTintGains(settings)).toEqual([1, 1, 1]);
    const input: RGB = [0.123456789, 0.4, 0.78];
    expect(gradePixel(input, settings)).toBe(input);
    expect(compilePixelGrade(settings)(input)).toBe(input);
    expect(createClip('shot', 'rec', 0, 10).grade.colour).toEqual(settings);
    expect(createAdjustment('look', 0, 10).colour).toEqual(settings);
    expect(Object.keys(layerKeyAsGradeKey(layerKeyframe(0, EMPTY_KEY_VALUES, 'linear')).values)).toHaveLength(14);
    const project = createProject('strict', 'Strict');
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    for (const schemaVersion of EARLIER_SCHEMA_VERSIONS)
      expect(projectSchema.safeParse({ ...project, schemaVersion }).success).toBe(false);
    for (const [channel, limit] of [
      ['temperature', 2],
      ['tint', 1],
    ] as const) {
      const incomplete = { ...settings };
      delete (incomplete as Partial<typeof settings>)[channel];
      expect(colourSchema.safeParse(incomplete).success).toBe(false);
      const key = layerKeyAsGradeKey(layerKeyframe(0, { ...EMPTY_KEY_VALUES, exposure: 0 }, 'linear'));
      expect(gradeKeyframeSchema.safeParse(key).success).toBe(true);
      const values: Partial<typeof key.values> = { ...key.values };
      delete values[channel];
      expect(gradeKeyframeSchema.safeParse({ ...key, values }).success).toBe(false);
      for (const value of [-limit - 0.000001, limit + 0.000001, NaN, Infinity, -Infinity, null, undefined])
        expect(colourSchema.safeParse({ ...settings, [channel]: value }).success).toBe(false);
      for (const value of [-limit, 0, 0.123456789, limit])
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
