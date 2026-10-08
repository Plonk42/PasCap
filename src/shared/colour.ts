import { z } from 'zod';
import {
  compileColourCurvesInto,
  compileHslInto,
  createColourCurves,
  createHslSettings,
  curvesSchema,
  hslSchema,
  isIdentityCurve,
  isNeutralHsl,
} from './advanced-colour.js';

export const colourSchema = z
  .object({
    temperature: z.number().min(-1).max(1),
    tint: z.number().min(-1).max(1),
    exposure: z.number().min(-3).max(3),
    brightness: z.number().min(-0.5).max(0.5),
    contrast: z.number().min(0).max(2),
    hue: z.number().min(-180).max(180),
    saturation: z.number().min(0).max(2),
    highlights: z.number().min(-1).max(1),
    shadows: z.number().min(-1).max(1),
    hsl: hslSchema,
    curves: curvesSchema,
  })
  .strict();

export type ColourSettings = z.infer<typeof colourSchema>;
export type RGB = readonly [number, number, number];
export function createColourSettings(): ColourSettings {
  return {
    temperature: 0,
    tint: 0,
    exposure: 0,
    brightness: 0,
    contrast: 1,
    hue: 0,
    saturation: 1,
    highlights: 0,
    shadows: 0,
    hsl: createHslSettings(),
    curves: createColourCurves(),
  };
}
const neutral = createColourSettings();
for (const band of Object.values(neutral.hsl)) Object.freeze(band);
for (const curve of Object.values(neutral.curves)) {
  curve.forEach(Object.freeze);
  Object.freeze(curve);
}
Object.freeze(neutral.hsl);
Object.freeze(neutral.curves);
export const NEUTRAL_COLOUR: Readonly<ColourSettings> = Object.freeze(neutral);

export const COLOUR_CONTROLS = [
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.01, unit: 'EV' },
  { key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.005, unit: '' },
  { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.01, unit: '×' },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, unit: '×' },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01, unit: '' },
] as const;
export type ScalarColourSetting = (typeof COLOUR_CONTROLS)[number]['key'];
/** Only the nine numeric channels, never static structured settings. */
export function scalarColourValues(settings: ColourSettings): Record<ScalarColourSetting, number> {
  return Object.fromEntries(COLOUR_CONTROLS.map(({ key }) => [key, settings[key]])) as Record<
    ScalarColourSetting,
    number
  >;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Rounded BT.709 constants with a continuous join, including a neutral round-trip.
export const BT709_ALPHA = 1.09929682680944;
export const BT709_BETA = 0.018053968510807;
export function decode709(value: number): number {
  return value < 4.5 * BT709_BETA ? value / 4.5 : ((value + BT709_ALPHA - 1) / BT709_ALPHA) ** (1 / 0.45);
}
export function encode709(value: number): number {
  return value < BT709_BETA ? 4.5 * value : BT709_ALPHA * value ** 0.45 - (BT709_ALPHA - 1);
}

/** Normalized SDR axes, preserving neutral-white linear luminance before clipping. */
export function temperatureTintGains(settings: Pick<ColourSettings, 'temperature' | 'tint'>): RGB {
  const { temperature, tint } = settings;
  const red = 2 ** (temperature / 2 + tint / 4);
  const green = 2 ** (-tint / 4);
  const blue = 2 ** (-temperature / 2 + tint / 4);
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return [red / luminance, green / luminance, blue / luminance];
}

/** Authoritative SDR transform. See docs/COLOUR_AND_TIMING.md; no FFmpeg eq approximation. */
export function gradePixel(rgb: RGB, settings: ColourSettings): RGB {
  return compilePixelGrade(settings)(rgb);
}
/** Exact frame-owned grade; cache only bounded settings/functions, never pixels. */
export function compilePixelGrade(settings: ColourSettings): (rgb: RGB) => RGB {
  if (isNeutralColour(settings)) return (rgb) => rgb;
  const grade = compileGradeInto(settings);
  const triple = new Float64Array(3);
  return (rgb) => {
    triple.set(rgb);
    grade.encoded(triple);
    return [triple[0]!, triple[1]!, triple[2]!];
  };
}
export interface PixelGrade {
  /** Grade an encoded triple in place. */
  encoded(rgb: Float64Array): void;
  /** Identical to encoded() on code / 255, with the per-code BT.709 decode tabulated. */
  bytes(red: number, green: number, blue: number, out: Float64Array): void;
}
const DECODED_BYTES = Float64Array.from({ length: 256 }, (_, code) => decode709(clamp01(code / 255)));
/** The same grade on a reusable triple, for per-pixel native work. */
export function compileGradeInto(settings: ColourSettings): PixelGrade {
  const scalar = isNeutralScalarColour(settings) ? null : compileScalarGrade(settings);
  const hsl = compileHslInto(settings.hsl);
  const curves = compileColourCurvesInto(settings.curves);
  return {
    encoded(rgb) {
      if (scalar) scalar(decode709(clamp01(rgb[0]!)), decode709(clamp01(rgb[1]!)), decode709(clamp01(rgb[2]!)), rgb);
      hsl?.(rgb);
      curves?.(rgb);
    },
    bytes(red, green, blue, out) {
      if (scalar) scalar(DECODED_BYTES[red]!, DECODED_BYTES[green]!, DECODED_BYTES[blue]!, out);
      else {
        out[0] = red / 255;
        out[1] = green / 255;
        out[2] = blue / 255;
      }
      hsl?.(out);
      curves?.(out);
    },
  };
}
function isNeutralScalarColour(settings: ColourSettings): boolean {
  return COLOUR_CONTROLS.every(({ key }) => settings[key] === NEUTRAL_COLOUR[key]);
}
/** Scalar SDR stages from decoded linear input to an encoded triple. */
function compileScalarGrade(
  settings: ColourSettings,
): (linearRed: number, linearGreen: number, linearBlue: number, out: Float64Array) => void {
  const [redGain, greenGain, blueGain] = temperatureTintGains(settings);
  const exposure = 2 ** settings.exposure;
  const { contrast, brightness, saturation, shadows, highlights } = settings;
  const angle = (settings.hue * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (linearRed, linearGreen, linearBlue, out) => {
    const baseRed = (linearRed * redGain * exposure - 0.18) * contrast + 0.18 + brightness;
    const baseGreen = (linearGreen * greenGain * exposure - 0.18) * contrast + 0.18 + brightness;
    const baseBlue = (linearBlue * blueGain * exposure - 0.18) * contrast + 0.18 + brightness;
    const y = clamp01(0.2126 * baseRed + 0.7152 * baseGreen + 0.0722 * baseBlue);
    const tone = 0.25 * (shadows * (1 - y) ** 2 + highlights * y ** 2);
    const toneRed = baseRed + tone;
    const toneBlue = baseBlue + tone;
    const luminance = 0.2126 * toneRed + 0.7152 * (baseGreen + tone) + 0.0722 * toneBlue;
    const cb = (toneBlue - luminance) / 1.8556;
    const cr = (toneRed - luminance) / 1.5748;
    const u = saturation * (cb * cos - cr * sin);
    const v = saturation * (cb * sin + cr * cos);
    const red = luminance + 1.5748 * v;
    const blue = luminance + 1.8556 * u;
    const green = (luminance - 0.2126 * red - 0.0722 * blue) / 0.7152;
    out[0] = encode709(clamp01(red));
    out[1] = encode709(clamp01(green));
    out[2] = encode709(clamp01(blue));
  };
}

export function isNeutralColour(settings: ColourSettings): boolean {
  return isNeutralScalarColour(settings) && isNeutralAdvancedColour(settings);
}

export function isNeutralAdvancedColour(settings: ColourSettings): boolean {
  return isNeutralHsl(settings.hsl) && Object.values(settings.curves).every(isIdentityCurve);
}

export function generateCube(settings: ColourSettings, size = 65): string {
  colourSchema.parse(settings);
  if (!Number.isInteger(size) || size < 2 || size > 129)
    throw new Error('LUT size must be an integer between 2 and 129.');
  const lines = ['TITLE "PasCap BT709 linear SDR v1"', `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  const grade = compilePixelGrade(settings);
  // .cube convention: red is the fastest-moving coordinate.
  for (let blue = 0; blue < size; blue++) {
    for (let green = 0; green < size; green++) {
      for (let red = 0; red < size; red++) {
        lines.push(
          grade([red / (size - 1), green / (size - 1), blue / (size - 1)])
            .map((v) => v.toFixed(9))
            .join(' '),
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
