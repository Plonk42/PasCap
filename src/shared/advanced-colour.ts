import { z } from 'zod';
import type { RGB } from './colour.js';

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta'] as const;
export const HSL_CENTRES = [0, 30, 60, 120, 180, 240, 270, 300] as const;
export const CURVE_CHANNELS = ['master', 'red', 'green', 'blue'] as const;
export type HslBand = (typeof HSL_BANDS)[number];
export type CurveChannel = (typeof CURVE_CHANNELS)[number];
const bandSchema = z
  .object({
    hue: z.number().min(-30).max(30),
    saturation: z.number().min(-1).max(1),
    lightness: z.number().min(-0.5).max(0.5),
  })
  .strict();
export const hslSchema = z
  .object({
    red: bandSchema,
    orange: bandSchema,
    yellow: bandSchema,
    green: bandSchema,
    cyan: bandSchema,
    blue: bandSchema,
    purple: bandSchema,
    magenta: bandSchema,
  })
  .strict();
export const curvePointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
export const colourCurveSchema = z
  .array(curvePointSchema)
  .min(2)
  .max(16)
  .refine(
    (points) =>
      points[0]?.x === 0 &&
      points.at(-1)?.x === 1 &&
      points.every((point, index) => index === 0 || point.x > points[index - 1]!.x),
    { message: 'Curve inputs must strictly ascend from 0 to 1.' },
  );
export const curvesSchema = z
  .object({ master: colourCurveSchema, red: colourCurveSchema, green: colourCurveSchema, blue: colourCurveSchema })
  .strict();
export type HslSettings = z.infer<typeof hslSchema>;
export type ColourCurvePoint = z.infer<typeof curvePointSchema>;
export type ColourCurves = z.infer<typeof curvesSchema>;

export function createHslSettings(): HslSettings {
  return Object.fromEntries(HSL_BANDS.map((band) => [band, { hue: 0, saturation: 0, lightness: 0 }])) as HslSettings;
}
export function createColourCurves(): ColourCurves {
  return Object.fromEntries(
    CURVE_CHANNELS.map((channel) => [
      channel,
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    ]),
  ) as ColourCurves;
}
export function isNeutralHsl(hsl: HslSettings): boolean {
  return HSL_BANDS.every((band) => hsl[band].hue === 0 && hsl[band].saturation === 0 && hsl[band].lightness === 0);
}
export function isIdentityCurve(points: readonly ColourCurvePoint[]): boolean {
  return points.every((point) => point.x === point.y);
}
export function evaluateColourCurve(points: readonly ColourCurvePoint[], input: number): number {
  if (isIdentityCurve(points)) return input;
  return interpolateColourCurve(points, input);
}
/** Determine identity once for a frame's already validated curve. */
export function compileColourCurve(points: readonly ColourCurvePoint[]): (input: number) => number {
  return isIdentityCurve(points) ? (input) => input : (input) => interpolateColourCurve(points, input);
}
function interpolateColourCurve(points: readonly ColourCurvePoint[], input: number): number {
  for (let index = 1; index < points.length; index++) {
    const right = points[index]!;
    if (input <= right.x) {
      const left = points[index - 1]!;
      return left.y + ((right.y - left.y) * (input - left.x)) / (right.x - left.x);
    }
  }
  return points.at(-1)!.y;
}
function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function hueComponent(hue: number): number {
  const k = (((hue % 360) + 360) % 360) / 60;
  return clamp(Math.abs(k - 3) - 1);
}
/** Encoded RGB HSL; one incoming classification and two complementary weights. */
export function applyHsl(rgb: RGB, hsl: HslSettings): RGB {
  if (isNeutralHsl(hsl)) return rgb;
  return gradeHsl(rgb, hsl);
}
/** Static setup belongs to the source/frame, not to every output pixel. */
export function compileHsl(hsl: HslSettings): (rgb: RGB) => RGB {
  return isNeutralHsl(hsl) ? (rgb) => rgb : (rgb) => gradeHsl(rgb, hsl);
}
function gradeHsl(rgb: RGB, hsl: HslSettings): RGB {
  const maximum = Math.max(...rgb),
    minimum = Math.min(...rgb),
    chroma = maximum - minimum;
  if (chroma === 0) return rgb;
  let hue: number;
  if (maximum === rgb[0]) hue = 60 * ((rgb[1] - rgb[2]) / chroma);
  else if (maximum === rgb[1]) hue = 60 * (2 + (rgb[2] - rgb[0]) / chroma);
  else hue = 60 * (4 + (rgb[0] - rgb[1]) / chroma);
  hue = (hue + 360) % 360;
  let index = 7;
  for (let i = 0; i < 7; i++)
    if (hue < HSL_CENTRES[i + 1]!) {
      index = i;
      break;
    }
  const left = hsl[HSL_BANDS[index]!],
    right = hsl[HSL_BANDS[(index + 1) % 8]!];
  const end = index === 7 ? 360 : HSL_CENTRES[index + 1]!;
  const weight = smooth((hue - HSL_CENTRES[index]!) / (end - HSL_CENTRES[index]!));
  const influence = smooth(clamp(chroma / 0.1));
  const offset = (setting: 'hue' | 'saturation' | 'lightness'): number =>
    (left[setting] * (1 - weight) + right[setting] * weight) * influence;
  const lightness = (maximum + minimum) / 2;
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  const l = clamp(lightness + offset('lightness'));
  const s = clamp(saturation * (1 + offset('saturation')));
  const h = hue + offset('hue');
  const amplitude = (1 - Math.abs(2 * l - 1)) * s;
  return [
    l + amplitude * (hueComponent(h) - 0.5),
    l + amplitude * (hueComponent(h - 120) - 0.5),
    l + amplitude * (hueComponent(h - 240) - 0.5),
  ];
}
export function applyColourCurves(rgb: RGB, curves: ColourCurves): RGB {
  return [
    evaluateColourCurve(curves.red, evaluateColourCurve(curves.master, rgb[0])),
    evaluateColourCurve(curves.green, evaluateColourCurve(curves.master, rgb[1])),
    evaluateColourCurve(curves.blue, evaluateColourCurve(curves.master, rgb[2])),
  ];
}
