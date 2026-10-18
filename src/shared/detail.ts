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
/**
 * Above 720 lines, detail is measured on taps shifted by up to half a source pixel diagonally, so each
 * bilinear tap averages up to 2×2 pixels: the sparse kernel then sees the 720p picture, not finer detail.
 */
export function detailShift(lines: number): number {
  return 0.5 * Math.min(1, Math.max(0, lines / DETAIL_REFERENCE_LINES - 1));
}
/** Denoise eases finer-than-720p detail below this fraction of its range sigma. */
export const DENOISE_DETAIL_CORE = 0.5;
/** Denoise range sigma at full strength, in encoded RGB units. */
export const DENOISE_RANGE_SIGMA = 0.1;
/** Colour is smoothed with this many times Denoise's range sigma: colour noise goes, colour edges stay. */
export const DENOISE_CHROMA_RANGE = 2.5;
/** Denoise's spatial Gaussian sigma in units, over both rings. */
export const DENOISE_SPATIAL_SIGMA = 1.5;
export const SHARPEN_GAIN = 2;
/** Sharpen overshoot beyond the 3×3 luma range tends to this, in encoded units: no hard halos. */
export const SHARPEN_HALO = 0.05;
/** Fine detail below about this luma amplitude (≈ 1/255: grain, compression noise) is barely sharpened. */
export const SHARPEN_THRESHOLD = 0.004;
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
/** 3×3 and 5×5 rings: Sharpen's Gaussian (sigma 1 unit) and Denoise's spatial weights, centre 1. */
const denoiseWeight = (x: number, y: number): number =>
  Math.exp(-(x * x + y * y) / (2 * DENOISE_SPATIAL_SIGMA * DENOISE_SPATIAL_SIGMA));
export const DETAIL_FINE_TAPS = SQUARE.map(([x, y]) => ({
  x,
  y,
  weight: Math.exp(-(x * x + y * y) / 2),
  denoise: denoiseWeight(x, y),
}));
export const DETAIL_WIDE_TAPS = SQUARE.map(([x, y]) => ({ x: 2 * x, y: 2 * y, denoise: denoiseWeight(2 * x, 2 * y) }));
const FINE_WEIGHT = 1 + DETAIL_FINE_TAPS.reduce((sum, tap) => sum + tap.weight, 0);

const EIGHTH_TURN = Math.PI / 8;
/** Three rings of eight, the middle one rotated 22.5°, with Gaussian spatial weights. */
function threeRings(radii: readonly number[], sigma: number): { x: number; y: number; weight: number }[] {
  return radii.flatMap((radius, ring) =>
    DIRECTIONS.map(([x, y]) => {
      const rotation = ring === 1 ? EIGHTH_TURN : 0;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      return {
        x: radius * (x * cos - y * sin),
        y: radius * (x * sin + y * cos),
        weight: Math.exp(-(radius * radius) / (2 * sigma * sigma)),
      };
    }),
  );
}
/** Edge-aware bases: the first ring's taps, averaged with the centre, guide the range weights. */
export const EDGE_GUIDE_TAPS = 8;

/** Clarity's edge-aware mid-scale base, at radii 3, 6 and 10 units: no halos along strong edges. */
export const CLARITY_SPATIAL_SIGMA = 6;
export const CLARITY_RANGE_SIGMA = 0.1;
export const CLARITY_RANGE_FACTOR = 1 / (2 * CLARITY_RANGE_SIGMA * CLARITY_RANGE_SIGMA);
export const DETAIL_CLARITY_TAPS = threeRings([3, 6, 10], CLARITY_SPATIAL_SIGMA);

/** Edge-aware large-scale luma base shared by the local tone settings; see docs/design/DETAIL_FILTERS.md. */
export const TONE_BASE_SPATIAL_SIGMA = 16;
export const TONE_BASE_RANGE_SIGMA = 0.12;
export const TONE_BASE_RANGE_FACTOR = 1 / (2 * TONE_BASE_RANGE_SIGMA * TONE_BASE_RANGE_SIGMA);
/** Track HDR look: base compression; its former detail boost is Local contrast. */
export const HDR_COMPRESSION = 1;
/** Below this encoded luma, the luma change blends from chroma-preserving ratio to additive. */
export const HDR_RATIO_FLOOR = 0.1;
/** Radii 6, 16 and 32 units. */
export const TONE_BASE_TAPS = threeRings([6, 16, 32], TONE_BASE_SPATIAL_SIGMA);

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

/** Soft threshold d³ / (d² + t²): nearly zero well below t, nearly d well above it; d itself when t is 0. */
export function softThreshold(value: number, threshold: number): number {
  if (threshold <= 0) return value;
  return (value * value * value) / (value * value + threshold * threshold);
}

/** Sharpened luma with its excess beyond [low, high] eased towards SHARPEN_HALO; small overshoots stay. */
export function limitOvershoot(value: number, low: number, high: number): number {
  // Capped: tanh(10) is 1 in float32, and some GPU tanh implementations overflow far beyond it.
  if (value > high) return high + SHARPEN_HALO * Math.tanh(Math.min(10, (value - high) / SHARPEN_HALO));
  if (value < low) return low - SHARPEN_HALO * Math.tanh(Math.min(10, (low - value) / SHARPEN_HALO));
  return value;
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
 * `lines` is the sampled image's height in pixels.
 * `tone` holds the evaluated track Colour local tone settings at this project frame.
 */
export function compileDetail(
  settings: Readonly<DetailSettings>,
  aspect: number,
  tone: Readonly<LocalTone>,
  lines: number,
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
  if (!Number.isFinite(lines) || lines <= 0) throw new Error('Detail filters need a positive image height.');
  const stepV = 1 / DETAIL_REFERENCE_LINES;
  const stepU = stepV / aspect;
  const shift = isNeutralDetail({ sharpen, clarity, denoise }) ? 0 : detailShift(lines);
  const shiftV = shift / lines;
  const shiftU = shiftV / aspect;
  const inverseRange = denoiseRangeFactor(denoise);
  const core = DENOISE_DETAIL_CORE * DENOISE_RANGE_SIGMA * denoise;
  const centre = new Float64Array(3);
  const measured = new Float64Array(3);
  const tap = new Float64Array(3);
  const gaussian = new Float64Array(3);
  const denoised = new Float64Array(3);
  const chroma = new Float64Array(3);
  let denoisedWeight = 1;
  let chromaWeight = 1;
  let low = 0;
  let high = 0;
  const chromaRange = inverseRange / (DENOISE_CHROMA_RANGE * DENOISE_CHROMA_RANGE);
  // Bilateral weights: spatial Gaussian times an encoded-RGB range Gaussian around the measured centre,
  // a wider one for colour.
  const bilateral = (weight: number): void => {
    const red = tap[0]! - measured[0]!;
    const green = tap[1]! - measured[1]!;
    const blue = tap[2]! - measured[2]!;
    const distance = red * red + green * green + blue * blue;
    const w = weight * Math.exp(-distance * inverseRange);
    const c = weight * Math.exp(-distance * chromaRange);
    denoisedWeight += w;
    chromaWeight += c;
    for (let channel = 0; channel < 3; channel++) {
      denoised[channel]! += w * tap[channel]!;
      chroma[channel]! += c * tap[channel]!;
    }
  };
  const fine = (sample: DetailSampler, u: number, v: number): void => {
    gaussian.set(measured);
    low = high = luma(measured);
    for (const { x, y, weight, denoise: spatial } of DETAIL_FINE_TAPS) {
      sample(u + x * stepU, v + y * stepV, tap);
      const level = luma(tap);
      low = Math.min(low, level);
      high = Math.max(high, level);
      for (let channel = 0; channel < 3; channel++) gaussian[channel]! += weight * tap[channel]!;
      if (denoise > 0) bilateral(spatial);
    }
    for (let channel = 0; channel < 3; channel++) gaussian[channel]! /= FINE_WEIGHT;
    if (denoise === 0) return;
    for (const { x, y, denoise: spatial } of DETAIL_WIDE_TAPS) {
      sample(u + x * stepU, v + y * stepV, tap);
      bilateral(spatial);
    }
    for (let channel = 0; channel < 3; channel++) {
      denoised[channel]! /= denoisedWeight;
      chroma[channel]! /= chromaWeight;
    }
    // Luma from the tight weights, colour from the wide ones.
    const lift = luma(denoised) - luma(chroma);
    for (let channel = 0; channel < 3; channel++) denoised[channel] = chroma[channel]! + lift;
  };
  const compression = HDR_COMPRESSION * hdr;
  const detailGain = 1 + localContrast;
  // Range weights compare taps with a small local mean rather than the pixel itself, so a dark
  // pixel within bright texture takes its surroundings' base, while large edges still stop it.
  const edgeAware = (taps: typeof TONE_BASE_TAPS, rangeFactor: number) => {
    const levels = new Float64Array(taps.length);
    return (sample: DetailSampler, u: number, v: number, y: number): number => {
      let guide = y;
      for (const [index, { x, y: offset }] of taps.entries()) {
        sample(u + x * stepU, v + offset * stepV, tap);
        levels[index] = luma(tap);
        if (index < EDGE_GUIDE_TAPS) guide += levels[index]!;
      }
      guide /= EDGE_GUIDE_TAPS + 1;
      const selfWeight = Math.exp(-(y - guide) * (y - guide) * rangeFactor);
      let sum = selfWeight * y;
      let total = selfWeight;
      for (const [index, { weight }] of taps.entries()) {
        const level = levels[index]!;
        const w = weight * Math.exp(-(level - guide) * (level - guide) * rangeFactor);
        sum += w * level;
        total += w;
      }
      return sum / total;
    };
  };
  const edgeAwareBase = edgeAware(TONE_BASE_TAPS, TONE_BASE_RANGE_FACTOR);
  const clarityBase = edgeAware(DETAIL_CLARITY_TAPS, CLARITY_RANGE_FACTOR);
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
  const clarityTerm = (sample: DetailSampler, u: number, v: number, y: number): number => {
    const midtones = Math.min(1, Math.max(0, 4 * y * (1 - y)));
    return CLARITY_GAIN * clarity * midtones * (y - clarityBase(sample, u, v, y));
  };
  const sharpenTerm = (y: number): number => {
    const sharpened = y + SHARPEN_GAIN * sharpen * softThreshold(y - luma(gaussian), SHARPEN_THRESHOLD);
    // Denoise's wide ring can move the base outside the fine range: never limit towards it.
    return limitOvershoot(sharpened, Math.min(low, y), Math.max(high, y)) - y;
  };
  // Finer-than-720p detail passes through, eased below the Denoise threshold.
  const addFiner = (): void => {
    for (let channel = 0; channel < 3; channel++)
      denoised[channel]! += softThreshold(centre[channel]! - measured[channel]!, core);
  };
  const applyLocalTone = (sample: DetailSampler, u: number, v: number): void => {
    const base = luma(denoised);
    const smooth = edgeAwareBase(sample, u, v, base);
    if (residual) toneMap(base, smooth);
    if (toneGain) {
      // A linear-light gain keeps local contrast and colour ratios, and black at black.
      const gain = 2 ** localToneStops(smooth, tone);
      for (let channel = 0; channel < 3; channel++) denoised[channel] = encode709(decode709(denoised[channel]!) * gain);
    }
  };
  return {
    apply(sample, u, v, out) {
      sample(u, v, centre);
      // Detail is measured at 720p scale (shifted taps) and applied to the full-resolution pixel.
      const mu = u + shiftU;
      const mv = v + shiftV;
      if (shift > 0) sample(mu, mv, measured);
      else measured.set(centre);
      denoised.set(measured);
      denoisedWeight = 1;
      chroma.set(measured);
      chromaWeight = 1;
      if (sharpen > 0 || denoise > 0) fine(sample, mu, mv);
      const detailBase = luma(denoised);
      let delta = 0;
      if (clarity !== 0) delta += clarityTerm(sample, mu, mv, detailBase);
      if (sharpen > 0) delta += sharpenTerm(detailBase);
      if (shift > 0) addFiner();
      if (residual || toneGain) applyLocalTone(sample, u, v);
      for (let channel = 0; channel < 3; channel++) out[channel] = Math.min(1, Math.max(0, denoised[channel]! + delta));
    },
  };
}
