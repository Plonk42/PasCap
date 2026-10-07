import { z } from 'zod';
import {
  applyColourCurves,
  applyHsl,
  compileColourCurve,
  compileHsl,
  createColourCurves,
  createHslSettings,
  curvesSchema,
  hslSchema,
  isIdentityCurve,
  isNeutralHsl,
} from './advanced-colour.js';

export const colourSchema = z
  .object({
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
  { key: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.01, unit: 'EV' },
  { key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.005, unit: '' },
  { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.01, unit: '×' },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, unit: '×' },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01, unit: '' },
] as const;
export type ScalarColourSetting = (typeof COLOUR_CONTROLS)[number]['key'];
/** Only the seven numeric channels, never static structured settings. */
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

/** Authoritative SDR transform. See docs/COLOUR_AND_TIMING.md; no FFmpeg eq approximation. */
export function gradePixel(rgb: RGB, settings: ColourSettings): RGB {
  if (isNeutralColour(settings)) return rgb;
  const base = gradeScalarPixel(rgb, settings);
  return applyColourCurves(applyHsl(base, settings.hsl), settings.curves);
}
/** Exact frame-owned grade; cache only bounded settings/functions, never pixels. */
export function compilePixelGrade(settings: ColourSettings): (rgb: RGB) => RGB {
  if (isNeutralColour(settings)) return (rgb) => rgb;
  const scalarNeutral = COLOUR_CONTROLS.every(({ key }) => settings[key] === NEUTRAL_COLOUR[key]);
  const hsl = compileHsl(settings.hsl);
  const master = compileColourCurve(settings.curves.master);
  const red = compileColourCurve(settings.curves.red);
  const green = compileColourCurve(settings.curves.green);
  const blue = compileColourCurve(settings.curves.blue);
  return (rgb) => {
    const base = hsl(scalarNeutral ? rgb : gradeScalarPixel(rgb, settings));
    return [red(master(base[0])), green(master(base[1])), blue(master(base[2]))];
  };
}
function gradeScalarPixel(rgb: RGB, settings: ColourSettings): RGB {
  if (COLOUR_CONTROLS.every(({ key }) => settings[key] === NEUTRAL_COLOUR[key])) return rgb;
  const exposure = 2 ** settings.exposure;
  const base = rgb.map(
    (value) => (decode709(clamp01(value)) * exposure - 0.18) * settings.contrast + 0.18 + settings.brightness,
  );
  const y = clamp01(0.2126 * base[0]! + 0.7152 * base[1]! + 0.0722 * base[2]!);
  const low = (1 - y) ** 2;
  const high = y ** 2;
  const tone = base.map((value) => value + 0.25 * (settings.shadows * low + settings.highlights * high));
  const luminance = 0.2126 * tone[0]! + 0.7152 * tone[1]! + 0.0722 * tone[2]!;
  const cb = (tone[2]! - luminance) / 1.8556;
  const cr = (tone[0]! - luminance) / 1.5748;
  const angle = (settings.hue * Math.PI) / 180;
  const u = settings.saturation * (cb * Math.cos(angle) - cr * Math.sin(angle));
  const v = settings.saturation * (cb * Math.sin(angle) + cr * Math.cos(angle));
  const red = luminance + 1.5748 * v;
  const blue = luminance + 1.8556 * u;
  const green = (luminance - 0.2126 * red - 0.0722 * blue) / 0.7152;
  return [encode709(clamp01(red)), encode709(clamp01(green)), encode709(clamp01(blue))];
}

export function isNeutralColour(settings: ColourSettings): boolean {
  return COLOUR_CONTROLS.every(({ key }) => settings[key] === NEUTRAL_COLOUR[key]) && isNeutralAdvancedColour(settings);
}

export function isNeutralAdvancedColour(settings: ColourSettings): boolean {
  return isNeutralHsl(settings.hsl) && Object.values(settings.curves).every(isIdentityCurve);
}

export function generateCube(settings: ColourSettings, size = 65): string {
  colourSchema.parse(settings);
  if (!Number.isInteger(size) || size < 2 || size > 129)
    throw new Error('LUT size must be an integer between 2 and 129.');
  const lines = ['TITLE "PasCap BT709 linear SDR v1"', `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  // .cube convention: red is the fastest-moving coordinate.
  for (let blue = 0; blue < size; blue++) {
    for (let green = 0; green < size; green++) {
      for (let red = 0; red < size; red++) {
        lines.push(
          gradePixel([red / (size - 1), green / (size - 1), blue / (size - 1)], settings)
            .map((v) => v.toFixed(9))
            .join(' '),
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
