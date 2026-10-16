import { z } from 'zod';
import { clamp01, decode709, encode709, type ColourSettings, type LocalToneSetting } from './colour.js';

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

/** Edge-aware large-scale luma base shared by the local tone settings; see docs/design/DETAIL_FILTERS.md. */
export const TONE_BASE_SPATIAL_SIGMA = 16;
export const TONE_BASE_RANGE_SIGMA = 0.12;
export const TONE_BASE_RANGE_FACTOR = 1 / (2 * TONE_BASE_RANGE_SIGMA * TONE_BASE_RANGE_SIGMA);
/** The first ring's taps, averaged with the centre, guide the range weights. */
export const TONE_BASE_GUIDE_TAPS = 8;
/** Track HDR look: base compression; its former detail boost is Local contrast. */
export const HDR_COMPRESSION = 1;
/** Below this encoded luma, the luma change blends from chroma-preserving ratio to additive. */
export const HDR_RATIO_FLOOR = 0.1;
const EIGHTH_TURN = Math.PI / 8;
/** Three rings of eight at radii 6, 16 and 32 units; the middle ring is rotated 22.5°. */
export const TONE_BASE_TAPS = [
  { radius: 6, rotation: 0 },
  { radius: 16, rotation: EIGHTH_TURN },
  { radius: 32, rotation: 0 },
].flatMap(({ radius, rotation }) =>
  DIRECTIONS.map(([x, y]) => {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      x: radius * (x * cos - y * sin),
      y: radius * (x * sin + y * cos),
      weight: Math.exp(-(radius * radius) / (2 * TONE_BASE_SPATIAL_SIGMA * TONE_BASE_SPATIAL_SIGMA)),
    };
  }),
);

/** Kernel taps per pixel beyond the centre: the dominant per-pixel cost of these filters. */
export function detailTapCount(settings: Readonly<DetailSettings>, localTone: boolean): number {
  return (
    (settings.sharpen > 0 || settings.denoise > 0 ? DETAIL_FINE_TAPS.length : 0) +
    (settings.denoise > 0 ? DETAIL_WIDE_TAPS.length : 0) +
    (settings.clarity === 0 ? 0 : DETAIL_CLARITY_TAPS.length) +
    (localTone ? TONE_BASE_TAPS.length : 0)
  );
}

/** Track Colour settings this stage evaluates at the project frame instead of the per-pixel grade. */
export interface LocalTone {
  shadows: number;
  highlights: number;
  hdr: number;
  /** Boosts (or, below 0, flattens) the residual around the base, like HDR's detail part alone. */
  localContrast: number;
  /** Shadows and Highlights select tones after Exposure, which itself stays in the grade. */
  exposure: number;
}
export function localTone(colour: Pick<ColourSettings, LocalToneSetting | 'exposure'>): LocalTone {
  const { shadows, highlights, hdr, localContrast, exposure } = colour;
  return { shadows, highlights, hdr, localContrast, exposure };
}

/** Shadows/Highlights pivot: linear mid-grey, in stops below white. */
export const MID_GREY_STOPS = Math.log2(0.18);
/** At ±1, tones change by this fraction of their distance from mid-grey, in stops... */
export const LOCAL_TONE_SLOPE = 0.5;
/** ...up to this distance, so the darkest shadows move by at most 2 stops. */
export const LOCAL_TONE_RANGE = 4;
/** Keeps log2 finite on black. */
export const LOCAL_TONE_FLOOR = 2 ** -16;

/** Zero below 0, x − ½ above 1, joined by x³ − x⁴/2: a ramp with a one-stop smooth knee. */
function softRamp(x: number): number {
  const knee = clamp01(x);
  return knee ** 3 - knee ** 4 / 2 + Math.max(0, x - 1);
}
/** Distance from mid-grey, eased in over the first stop and out after LOCAL_TONE_RANGE. */
function toneDistance(stops: number): number {
  return softRamp(stops) - softRamp(stops - LOCAL_TONE_RANGE);
}
/** Shadows/Highlights exposure change in stops for an encoded local base luma. */
export function localToneStops(base: number, tone: Readonly<LocalTone>): number {
  const stops = Math.log2(Math.max(LOCAL_TONE_FLOOR, decode709(clamp01(base)) * 2 ** tone.exposure));
  return (
    LOCAL_TONE_SLOPE *
    (tone.shadows * toneDistance(MID_GREY_STOPS - stops) + tone.highlights * toneDistance(stops - MID_GREY_STOPS))
  );
}

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
 * Denoise → HDR and Local contrast → Shadows/Highlights → Clarity → Sharpen on source pixels, before grading.
 * Null when neutral.
 * `aspect` is the original width / height, so radii follow the image height.
 * `tone` holds the evaluated track Colour local tone settings at this project frame.
 */
export function compileDetail(
  settings: Readonly<DetailSettings>,
  aspect: number,
  tone: Readonly<LocalTone>,
): DetailFilter | null {
  const { sharpen, clarity, denoise } = detailSchema.parse(settings);
  const { shadows, highlights, hdr, localContrast, exposure } = tone;
  if (!Number.isFinite(hdr) || hdr < 0 || hdr > 1) throw new Error('HDR must be between 0 and 1.');
  for (const value of [shadows, highlights, localContrast])
    if (!Number.isFinite(value) || value < -1 || value > 1)
      throw new Error('Shadows, Highlights and Local contrast must be between -1 and 1.');
  if (!Number.isFinite(exposure)) throw new Error('Exposure must be finite.');
  const toneGain = shadows !== 0 || highlights !== 0;
  const residual = hdr > 0 || localContrast !== 0;
  if (isNeutralDetail({ sharpen, clarity, denoise }) && !residual && !toneGain) return null;
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
  const compression = HDR_COMPRESSION * hdr;
  const detailGain = 1 + localContrast;
  // Range weights compare taps with a small local mean rather than the pixel itself, so a dark
  // pixel within bright texture takes its surroundings' base, while large edges still stop it.
  const levels = new Float64Array(TONE_BASE_TAPS.length);
  const edgeAwareBase = (sample: DetailSampler, u: number, v: number, y: number): number => {
    let guide = y;
    for (const [index, { x, y: offset }] of TONE_BASE_TAPS.entries()) {
      sample(u + x * stepU, v + offset * stepV, tap);
      levels[index] = luma(tap);
      if (index < TONE_BASE_GUIDE_TAPS) guide += levels[index]!;
    }
    guide /= TONE_BASE_GUIDE_TAPS + 1;
    const selfWeight = Math.exp(-(y - guide) * (y - guide) * TONE_BASE_RANGE_FACTOR);
    let sum = selfWeight * y;
    let total = selfWeight;
    for (const [index, { weight }] of TONE_BASE_TAPS.entries()) {
      const level = levels[index]!;
      const w = weight * Math.exp(-(level - guide) * (level - guide) * TONE_BASE_RANGE_FACTOR);
      sum += w * level;
      total += w;
    }
    return sum / total;
  };
  // HDR compresses the base (black/white fixed); Local contrast scales the residual.
  const toneMap = (y: number, base: number): void => {
    const target = base + compression * base * (1 - base) * (1 - 2 * base) + (y - base) * detailGain;
    const lift = target - y;
    if (y <= 0) {
      for (let channel = 0; channel < 3; channel++) denoised[channel]! += lift;
      return;
    }
    const ratio = target / y;
    const blend = Math.min(1, y / HDR_RATIO_FLOOR);
    for (let channel = 0; channel < 3; channel++) {
      const value = denoised[channel]!;
      denoised[channel] = value + lift + blend * (value * ratio - value - lift);
    }
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
      if (residual || toneGain) {
        const smooth = edgeAwareBase(sample, u, v, base);
        if (residual) toneMap(base, smooth);
        if (toneGain) {
          // A linear-light gain keeps local contrast and colour ratios, and black at black.
          const gain = 2 ** localToneStops(smooth, tone);
          for (let channel = 0; channel < 3; channel++)
            denoised[channel] = encode709(decode709(denoised[channel]!) * gain);
        }
      }
      for (let channel = 0; channel < 3; channel++) out[channel] = Math.min(1, Math.max(0, denoised[channel]! + delta));
    },
  };
}
