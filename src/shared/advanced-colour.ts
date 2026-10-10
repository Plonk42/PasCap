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
    { message: 'Colour curve control node inputs must strictly ascend from 0 to 1.' },
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
  return compileColourCurve(points)(input);
}
/** Monotone cubic (Fritsch–Butland/PCHIP) node slopes: smooth, never overshooting neighbouring outputs. */
export function colourCurveSlopes(points: readonly ColourCurvePoint[]): Float64Array {
  const last = points.length - 1;
  const width = (at: number): number => points[at + 1]!.x - points[at]!.x;
  const secant = (at: number): number => (points[at + 1]!.y - points[at]!.y) / width(at);
  const slopes = new Float64Array(points.length);
  if (last === 1) {
    slopes.fill(secant(0));
    return slopes;
  }
  for (let at = 1; at < last; at++) {
    const left = secant(at - 1),
      right = secant(at);
    if (left * right <= 0) continue;
    const leftWeight = 2 * width(at) + width(at - 1),
      rightWeight = width(at) + 2 * width(at - 1);
    slopes[at] = (leftWeight + rightWeight) / (leftWeight / left + rightWeight / right);
  }
  slopes[0] = endSlope(width(0), width(1), secant(0), secant(1));
  slopes[last] = endSlope(width(last - 1), width(last - 2), secant(last - 1), secant(last - 2));
  return slopes;
}
function endSlope(near: number, far: number, nearSecant: number, farSecant: number): number {
  const slope = ((2 * near + far) * nearSecant - near * farSecant) / (near + far);
  if (Math.sign(slope) !== Math.sign(nearSecant)) return 0;
  if (Math.sign(nearSecant) !== Math.sign(farSecant) && Math.abs(slope) > Math.abs(3 * nearSecant))
    return 3 * nearSecant;
  return slope;
}
/** Determine identity once for a frame's already validated curve. */
export function compileColourCurve(points: readonly ColourCurvePoint[]): (input: number) => number {
  if (isIdentityCurve(points)) return (input) => input;
  const xs = Float64Array.from(points, (point) => point.x);
  const ys = Float64Array.from(points, (point) => point.y);
  const slopes = colourCurveSlopes(points);
  const last = ys.length - 1;
  return (input) => {
    if (input <= 0) return ys[0]!;
    for (let index = 1; index <= last; index++) {
      if (input <= xs[index]!) {
        const width = xs[index]! - xs[index - 1]!;
        const t = (input - xs[index - 1]!) / width,
          t2 = t * t,
          t3 = t2 * t;
        const value =
          (2 * t3 - 3 * t2 + 1) * ys[index - 1]! +
          (t3 - 2 * t2 + t) * width * slopes[index - 1]! +
          (3 * t2 - 2 * t3) * ys[index]! +
          (t3 - t2) * width * slopes[index]!;
        return Math.min(1, Math.max(0, value));
      }
    }
    return ys[last]!;
  };
}
/** Master then per-channel curves, in place on an encoded triple; null for identity. */
export function compileColourCurvesInto(curves: ColourCurves): ((rgb: Float64Array) => void) | null {
  if (CURVE_CHANNELS.every((channel) => isIdentityCurve(curves[channel]))) return null;
  const master = compileColourCurve(curves.master);
  const channels = [compileColourCurve(curves.red), compileColourCurve(curves.green), compileColourCurve(curves.blue)];
  return (rgb) => {
    for (let channel = 0; channel < 3; channel++) rgb[channel] = channels[channel]!(master(rgb[channel]!));
  };
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
  const grade = compileHslInto(hsl);
  if (!grade || (rgb[0] === rgb[1] && rgb[1] === rgb[2])) return rgb;
  const out = Float64Array.of(...rgb);
  grade(out);
  return [out[0]!, out[1]!, out[2]!];
}
/** Static setup belongs to the source/frame; grades an encoded triple in place, null when neutral. */
export function compileHslInto(hsl: HslSettings): ((rgb: Float64Array) => void) | null {
  if (isNeutralHsl(hsl)) return null;
  const hues = Float64Array.from(HSL_BANDS, (band) => hsl[band].hue);
  const saturations = Float64Array.from(HSL_BANDS, (band) => hsl[band].saturation);
  const lightnesses = Float64Array.from(HSL_BANDS, (band) => hsl[band].lightness);
  return (rgb) => {
    const red = rgb[0]!,
      green = rgb[1]!,
      blue = rgb[2]!;
    const maximum = Math.max(red, green, blue),
      minimum = Math.min(red, green, blue),
      chroma = maximum - minimum;
    if (chroma === 0) return;
    let hue: number;
    if (maximum === red) hue = 60 * ((green - blue) / chroma);
    else if (maximum === green) hue = 60 * (2 + (blue - red) / chroma);
    else hue = 60 * (4 + (red - green) / chroma);
    hue = (hue + 360) % 360;
    let left = 7;
    for (let i = 0; i < 7; i++)
      if (hue < HSL_CENTRES[i + 1]!) {
        left = i;
        break;
      }
    const right = (left + 1) % 8;
    const end = left === 7 ? 360 : HSL_CENTRES[left + 1]!;
    const weight = smooth((hue - HSL_CENTRES[left]!) / (end - HSL_CENTRES[left]!));
    const influence = smooth(clamp(chroma / 0.1));
    const lightness = (maximum + minimum) / 2;
    const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    const l = clamp(lightness + (lightnesses[left]! * (1 - weight) + lightnesses[right]! * weight) * influence);
    const s = clamp(saturation * (1 + (saturations[left]! * (1 - weight) + saturations[right]! * weight) * influence));
    const h = hue + (hues[left]! * (1 - weight) + hues[right]! * weight) * influence;
    const amplitude = (1 - Math.abs(2 * l - 1)) * s;
    rgb[0] = l + amplitude * (hueComponent(h) - 0.5);
    rgb[1] = l + amplitude * (hueComponent(h - 120) - 0.5);
    rgb[2] = l + amplitude * (hueComponent(h - 240) - 0.5);
  };
}
