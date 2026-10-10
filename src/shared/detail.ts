import { z } from 'zod';

/** Clip-owned static detail filters; see docs/design/DETAIL_FILTERS.md. */
export const detailSchema = z
  .object({
    sharpen: z.number().min(0).max(1),
    clarity: z.number().min(-1).max(1),
    denoise: z.number().min(0).max(1),
  })
  .strict();

export type DetailSettings = z.infer<typeof detailSchema>;
export type DetailSetting = keyof DetailSettings;

export const NEUTRAL_DETAIL: Readonly<DetailSettings> = Object.freeze({ sharpen: 0, clarity: 0, denoise: 0 });

/** Creation values only: persisted clips must supply every field. */
export function createDetailSettings(): DetailSettings {
  return { ...NEUTRAL_DETAIL };
}

export const DETAIL_CONTROLS = [
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 1, step: 0.01 },
  { key: 'clarity', label: 'Clarity', min: -1, max: 1, step: 0.01 },
  { key: 'denoise', label: 'Denoise', min: 0, max: 1, step: 0.01 },
] as const satisfies readonly { key: DetailSetting; label: string; min: number; max: number; step: number }[];

/** Exact zeros only: the neutral path must stay bit-identical to unfiltered rendering. */
export function isNeutralDetail(settings: Readonly<DetailSettings>): boolean {
  return settings.sharpen === 0 && settings.clarity === 0 && settings.denoise === 0;
}

/** Radii are in 1/720 of the image height: one pixel of the 720p preview and draft export. */
export const DETAIL_REFERENCE_LINES = 720;
/** Denoise range sigma at full strength, in encoded RGB units. */
export const DENOISE_RANGE_SIGMA = 0.1;
export const SHARPEN_GAIN = 2;
export const CLARITY_GAIN = 1;
const DIAGONAL = Math.SQRT1_2;
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [DIAGONAL, DIAGONAL],
  [0, 1],
  [-DIAGONAL, DIAGONAL],
  [-1, 0],
  [-DIAGONAL, -DIAGONAL],
  [0, -1],
  [DIAGONAL, -DIAGONAL],
];
const SQUARE: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
/** Gaussian (sigma 1 unit) spatial weights of the 3×3 and 5×5 rings, centre 1. */
export const DETAIL_FINE_TAPS = SQUARE.map(([x, y]) => ({ x, y, weight: Math.exp(-(x * x + y * y) / 2) }));
export const DETAIL_WIDE_TAPS = SQUARE.map(([x, y]) => ({
  x: 2 * x,
  y: 2 * y,
  weight: Math.exp(-2 * (x * x + y * y)),
}));
/** Clarity's local mean: centre plus two equal-weight rings of eight. */
export const DETAIL_CLARITY_TAPS = [5, 10].flatMap((radius) =>
  DIRECTIONS.map(([x, y]) => ({ x: x * radius, y: y * radius })),
);
const FINE_WEIGHT = 1 + DETAIL_FINE_TAPS.reduce((sum, tap) => sum + tap.weight, 0);

/** Writes encoded BT.709 RGB in 0–1 at normalized original-image coordinates. */
export type DetailSampler = (u: number, v: number, out: Float64Array) => void;
export interface DetailFilter {
  /** Filtered encoded RGB in 0–1 at (u, v), written to `out`. */
  apply(sample: DetailSampler, u: number, v: number, out: Float64Array): void;
}

function luma(rgb: Float64Array): number {
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}

/**
 * Range-kernel exponent factor 1 / (2σ² · 3) for the mean squared RGB difference.
 * Capped so tiny strengths stay finite in float32 shaders, where it still rejects any 8-bit step.
 */
export function denoiseRangeFactor(denoise: number): number {
  if (denoise <= 0) return 0;
  const sigma = DENOISE_RANGE_SIGMA * denoise;
  return Math.min(1e30, 1 / (6 * sigma * sigma));
}

/**
 * Denoise → Clarity → Sharpen on source pixels, before grading. Null when neutral.
 * `aspect` is the original width / height, so radii follow the image height.
 */
export function compileDetail(settings: Readonly<DetailSettings>, aspect: number): DetailFilter | null {
  const { sharpen, clarity, denoise } = detailSchema.parse(settings);
  if (isNeutralDetail({ sharpen, clarity, denoise })) return null;
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('Detail filters need a positive image aspect.');
  const stepV = 1 / DETAIL_REFERENCE_LINES;
  const stepU = stepV / aspect;
  const inverseRange = denoiseRangeFactor(denoise);
  const centre = new Float64Array(3);
  const tap = new Float64Array(3);
  const gaussian = new Float64Array(3);
  const denoised = new Float64Array(3);
  let denoisedWeight = 1;
  // Bilateral weight: spatial Gaussian times an encoded-RGB range Gaussian around the centre.
  const bilateral = (weight: number): void => {
    const red = tap[0]! - centre[0]!;
    const green = tap[1]! - centre[1]!;
    const blue = tap[2]! - centre[2]!;
    const w = weight * Math.exp(-(red * red + green * green + blue * blue) * inverseRange);
    denoisedWeight += w;
    for (let channel = 0; channel < 3; channel++) denoised[channel]! += w * tap[channel]!;
  };
  const fine = (sample: DetailSampler, u: number, v: number): void => {
    gaussian.set(centre);
    for (const { x, y, weight } of DETAIL_FINE_TAPS) {
      sample(u + x * stepU, v + y * stepV, tap);
      for (let channel = 0; channel < 3; channel++) gaussian[channel]! += weight * tap[channel]!;
      if (denoise > 0) bilateral(weight);
    }
    if (denoise > 0)
      for (const { x, y, weight } of DETAIL_WIDE_TAPS) {
        sample(u + x * stepU, v + y * stepV, tap);
        bilateral(weight);
      }
    for (let channel = 0; channel < 3; channel++) {
      gaussian[channel]! /= FINE_WEIGHT;
      denoised[channel]! /= denoisedWeight;
    }
  };
  const localMean = (sample: DetailSampler, u: number, v: number): number => {
    let sum = luma(centre);
    for (const { x, y } of DETAIL_CLARITY_TAPS) {
      sample(u + x * stepU, v + y * stepV, tap);
      sum += luma(tap);
    }
    return sum / (DETAIL_CLARITY_TAPS.length + 1);
  };
  return {
    apply(sample, u, v, out) {
      sample(u, v, centre);
      denoised.set(centre);
      denoisedWeight = 1;
      if (sharpen > 0 || denoise > 0) fine(sample, u, v);
      const base = luma(denoised);
      let delta = 0;
      if (clarity !== 0) {
        const midtones = Math.min(1, Math.max(0, 4 * base * (1 - base)));
        delta += CLARITY_GAIN * clarity * midtones * (base - localMean(sample, u, v));
      }
      if (sharpen > 0) delta += SHARPEN_GAIN * sharpen * (base - luma(gaussian));
      for (let channel = 0; channel < 3; channel++) out[channel] = Math.min(1, Math.max(0, denoised[channel]! + delta));
    },
  };
}
