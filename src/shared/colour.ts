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
    vibrance: z.number().min(-1).max(1),
    highlights: z.number().min(-1).max(1),
    shadows: z.number().min(-1).max(1),
    whites: z.number().min(-1).max(1),
    blacks: z.number().min(-1).max(1),
    hdr: z.number().min(0).max(1),
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
    vibrance: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    hdr: 0,
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
  { key: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'whites', label: 'Whites', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'blacks', label: 'Blacks', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'hdr', label: 'HDR', min: 0, max: 1, step: 0.01, unit: '' },
] as const;
export type ScalarColourSetting = (typeof COLOUR_CONTROLS)[number]['key'];
/** Only the scalar numeric channels, never static structured settings. */
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
  if (isNeutralScalarColour(settings) && isNeutralAdvancedColour(settings)) return (rgb) => rgb;
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
/** HDR is a neighbourhood stage before grading (src/shared/detail.ts), not part of the per-pixel grade. */
function isNeutralScalarColour(settings: ColourSettings): boolean {
  return COLOUR_CONTROLS.every(({ key }) => key === 'hdr' || settings[key] === NEUTRAL_COLOUR[key]);
}
/** Scalar SDR stages from decoded linear input to an encoded triple. */
function compileScalarGrade(
  settings: ColourSettings,
): (linearRed: number, linearGreen: number, linearBlue: number, out: Float64Array) => void {
  const [redGain, greenGain, blueGain] = temperatureTintGains(settings);
  const exposure = 2 ** settings.exposure;
  const { contrast, brightness, saturation, vibrance, shadows, highlights, whites, blacks } = settings;
  const tonal = contrast !== 1 || brightness !== 0 || shadows !== 0 || highlights !== 0 || whites !== 0 || blacks !== 0;
  const blackGain = blacks < 0 ? 0 : (2 - contrast) * (1 + 2 * brightness) * (1 + shadows);
  const angle = (settings.hue * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (linearRed, linearGreen, linearBlue, out) => {
    const baseRed = linearRed * redGain * exposure;
    const baseGreen = linearGreen * greenGain * exposure;
    const baseBlue = linearBlue * blueGain * exposure;
    const y = clamp01(0.2126 * baseRed + 0.7152 * baseGreen + 0.0722 * baseBlue);
    let gain = 1;
    let lift = 0;
    if (tonal) {
      let toned = toneCurve(encode709(y), settings);
      if (blacks < 0) toned = Math.max(0, blacksCurve(toned, blacks));
      gain = y > 0 ? decode709(toned) / y : blackGain;
      if (blacks > 0) lift = decode709(blacksCurve(toned, blacks)) - decode709(toned);
    }
    const toneRed = baseRed * gain + lift;
    const toneGreen = baseGreen * gain + lift;
    const toneBlue = baseBlue * gain + lift;
    const luminance = 0.2126 * toneRed + 0.7152 * toneGreen + 0.0722 * toneBlue;
    const cb = (toneBlue - luminance) / 1.8556;
    const cr = (toneRed - luminance) / 1.5748;
    const chroma = vibrance === 0 ? saturation : saturation * vibranceGain(toneRed, toneGreen, toneBlue, vibrance);
    const u = chroma * (cb * cos - cr * sin);
    const v = chroma * (cb * sin + cr * cos);
    const red = luminance + 1.5748 * v;
    const blue = luminance + 1.8556 * u;
    const green = (luminance - 0.2126 * red - 0.0722 * blue) / 0.7152;
    out[0] = encode709(clamp01(red));
    out[1] = encode709(clamp01(green));
    out[2] = encode709(clamp01(blue));
  };
}

/** Vibrance scales chroma most on muted pixels: 1 + v(1 − c)² with c the pixel's linear (max − min) / max. */
function vibranceGain(red: number, green: number, blue: number, vibrance: number): number {
  const maximum = Math.max(red, green, blue);
  const colourfulness = maximum > 0 ? (maximum - Math.min(red, green, blue)) / maximum : 0;
  return 1 + vibrance * (1 - Math.min(1, colourfulness)) ** 2;
}
/** Negative Highlights also dims pure white by this much (encoded). */
export const HIGHLIGHTS_WHITE = 0.15;
/** Whites moves pure white by this much (encoded) at ±1; monotonic up to 0.25. */
export const WHITES_RANGE = 0.25;
/** Contrast, Brightness, Shadows, Highlights then Whites on encoded luminance, applied as a linear RGB gain. */
function toneCurve(v: number, settings: ColourSettings): number {
  const { contrast, brightness, shadows, highlights, whites } = settings;
  v += (contrast - 1) * v * (1 - v) * (2 * v - 1);
  v += 2 * brightness * v * (1 - v);
  v += shadows * v * (1 - v) ** 2;
  v += highlights * v * v * (1 - v) + Math.min(highlights, 0) * HIGHLIGHTS_WHITE * v ** 3;
  return v + whites * WHITES_RANGE * v ** 4;
}
/** Blacks moves black by this much (encoded) at ±1: lowered as a gain that crushes, raised as an added lift. */
export const BLACKS_RANGE = 0.25;
function blacksCurve(v: number, blacks: number): number {
  return v + blacks * BLACKS_RANGE * (1 - v) ** 4;
}

export function isNeutralColour(settings: ColourSettings): boolean {
  return settings.hdr === 0 && isNeutralScalarColour(settings) && isNeutralAdvancedColour(settings);
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
