import {
  analyzeAutoAdjust,
  AUTO_ADJUST,
  AUTO_ADJUST_SETTINGS,
  bySaturation,
  colorfulness,
  lineSearch,
  luma,
  NEUTRAL_CHROMA,
  NEUTRAL_TONE,
  quantileIndex,
  renderFlat,
  scaleCorrection,
  toneStatistics,
  type AutoCorrection,
  type ToneStatistics,
} from './auto-adjust.js';
import { createColorSettings, encode709, isNeutralColor, temperatureTintGains, type ColorSettings } from './color.js';
import {
  contentBox,
  frameIlluminant,
  LINEAR_CODES,
  median,
  WHITE_BALANCE,
  type AnalysisFrame,
  type WhiteBalance,
} from './white-balance.js';

/** Color match (#315, #314): constants of the fit; see docs/design/COLOR_MATCH.md. */
export const LOOK_MATCH = Object.freeze({
  /** Output differences, in encoded luma or linear saturation, are measured in units of this… */
  scale: 0.02,
  /** …and a cast difference, in Temperature and Tint, in units of this. */
  castScale: 0.05,
  /**
   * Cauchy loss width, in those units: larger differences, which a scene explains better than light, count less
   * and less.
   */
  robust: 1.5,
  /** Pull towards the start: its weight, and each fitted setting's scale (Contrast and Saturation in stops). */
  pull: 1,
  pullScales: {
    exposure: 0.5,
    contrast: 0.2,
    blacks: 0.3,
    whites: 0.3,
    saturation: 0.2,
    vibrance: 0.3,
    temperature: 0.3,
    tint: 0.2,
  },
  /** How far a fit may move each setting from its start: stops of Exposure, ratios of Contrast and Saturation. */
  reach: {
    exposure: 0.5,
    contrast: 1.3,
    blacks: 0.5,
    whites: 0.5,
    saturation: 1.3,
    vibrance: 0.3,
    temperature: 0.3,
    tint: 0.15,
  },
  /** Coordinate descent sweeps and golden-section steps of each fit. */
  sweeps: 4,
  steps: 14,
  /** Fits: after each but the last, the output is measured again and the fit aims again at what it missed. */
  passes: 3,
  /** Frames are measured at most this wide: a 320 × 180 analysis frame is measured at 80 × 45. */
  width: 80,
  /** Pixels whose saturations and colorfulness are measured, shared among the frames… */
  samples: 4000,
  /** …and of them, per frame, those the color fit grades again. */
  chromaSamples: 32,
  /** Scene likeness: the coarse grid compared, and the similarities between which the fit is trusted from not to fully. */
  grid: { columns: 16, rows: 9 },
  similar: { low: 0.5, high: 0.9 },
});

/**
 * How footage looks, measured on its output: what a match aims at. Luma values are encoded luma, saturations
 * linear (max − min) / max as Vibrance measures them, each the median over the frames.
 */
export interface LookProfile {
  /** Luma at each of TONE_QUANTILES, from the black point to the white point. */
  levels: number[];
  /** Luma of the log-average. */
  middle: number;
  /** Luma of the shadow areas: the darkest tenth of the areas, as Auto measures them. */
  shadow: number;
  /** The output's cast: the Temperature and Tint that would neutralize it; null without a usable estimate. */
  cast: { temperature: number; tint: number } | null;
  /** Saturation of the muted colors (25th percentile) and the strong ones (90th). */
  muted: number;
  strong: number;
  /** Hasler–Süsstrunk colorfulness. */
  colorfulness: number;
}

interface Range {
  low: number;
  high: number;
}
type Fitted = keyof typeof LOOK_MATCH.reach;
/** The ranges a fit may set each of its settings in. */
export type FitBounds = Readonly<Record<Fitted, Range>>;

/** A frame match may reach each setting's whole range; the pull, the loss and the reach keep it near its start. */
export const FRAME_BOUNDS: FitBounds = Object.freeze({
  exposure: { low: -2, high: 2 },
  contrast: { low: 0.5, high: 2 },
  blacks: { low: -1, high: 1 },
  whites: { low: -1, high: 1 },
  saturation: { low: 0, high: 2 },
  vibrance: { low: -1, high: 1 },
  temperature: { low: -2, high: 2 },
  tint: { low: -1, high: 1 },
});

/** A style keeps Auto's own bounds: it is Auto's balance aimed at the user's look. */
export const STYLE_BOUNDS: FitBounds = Object.freeze({
  exposure: { low: -1.5, high: 1.5 },
  contrast: { low: 0.75, high: 1.8 },
  blacks: { low: -1, high: 0 },
  whites: { low: -0.5, high: 1 },
  saturation: { low: AUTO_ADJUST.minimumSaturation, high: AUTO_ADJUST.maximumSaturation },
  vibrance: { low: 0, high: AUTO_ADJUST.maximumVibrance },
  temperature: { low: -WHITE_BALANCE.temperatureLimit, high: WHITE_BALANCE.temperatureLimit },
  tint: { low: -WHITE_BALANCE.tintLimit, high: WHITE_BALANCE.tintLimit },
});

const within = ({ low, high }: Range, value: number): number => Math.min(high, Math.max(low, value));
const NEUTRAL_BALANCE: Readonly<WhiteBalance> = Object.freeze({ temperature: 0, tint: 0 });

type Render = ReturnType<typeof renderFlat>;

/** A frame about LOOK_MATCH.width wide, by averaging square blocks of codes. */
function reduced(frame: AnalysisFrame): AnalysisFrame {
  const factor = Math.min(Math.floor(frame.width / LOOK_MATCH.width), frame.height);
  if (factor <= 1) return frame;
  const width = Math.floor(frame.width / factor);
  const height = Math.floor(frame.height / factor);
  const sums = new Float64Array(width * height * 4);
  const { data } = frame;
  for (let y = 0; y < height * factor; y++) {
    const row = Math.floor(y / factor) * width;
    for (let x = 0; x < width * factor; x++) {
      const source = (y * frame.width + x) * 4;
      const target = (row + Math.floor(x / factor)) * 4;
      sums[target] = sums[target]! + data[source]!;
      sums[target + 1] = sums[target + 1]! + data[source + 1]!;
      sums[target + 2] = sums[target + 2]! + data[source + 2]!;
      sums[target + 3] = sums[target + 3]! + data[source + 3]!;
    }
  }
  const area = factor * factor;
  return { width, height, data: Uint8ClampedArray.from(sums, (sum) => Math.round(sum / area)) };
}

/** The frames as PasCap grades them with the eleven settings and `base`'s others, Shadows and Highlights on flat areas. */
function rendered(
  frames: readonly AnalysisFrame[],
  correction: Readonly<AutoCorrection>,
  base: Readonly<ColorSettings>,
): AnalysisFrame[] {
  const { temperature, tint, saturation, vibrance, ...tone } = correction;
  const gains = temperatureTintGains({ temperature, tint });
  const render = renderFlat({ temperature, tint }, tone, { saturation, vibrance }, base);
  const balanced = new Float64Array(3);
  return frames.map(({ width, height, data }) => {
    const output = new Uint8ClampedArray(data.length);
    for (let index = 0; index < data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++)
        balanced[channel] = LINEAR_CODES[data[index + channel]!]! * gains[channel]!;
      const graded = render(balanced);
      for (let channel = 0; channel < 3; channel++) output[index + channel] = Math.round(graded[channel]! * 255);
      output[index + 3] = 255;
    }
    return { width, height, data: output };
  });
}

/** The `q` quantiles of each frame's saturations through `render`, median over the frames. */
function saturationQuantiles(samples: readonly Float64Array[], render: Render): { muted: number; strong: number } {
  const sorted = samples.filter((item) => item.length > 0).map((item) => bySaturation(item, render).saturations);
  if (!sorted.length) return { muted: 0, strong: 0 };
  const at = (q: number): number => median(sorted.map((values) => values[quantileIndex(values.length, q)]!));
  return { muted: at(AUTO_ADJUST.mutedQuantile), strong: at(AUTO_ADJUST.strongQuantile) };
}

function samplesColorfulness(samples: readonly Float64Array[], render: Render): number {
  const usable = samples.filter((item) => item.length > 0);
  return usable.length ? median(usable.map((item) => colorfulness(item, render))) : 0;
}

/** The frames' median light: the Temperature and Tint that would neutralize it, or null without an estimate. */
function castOf(frames: readonly AnalysisFrame[]): LookProfile['cast'] {
  const lights = frames.flatMap((frame) => frameIlluminant(frame) ?? []);
  if (!lights.length) return null;
  return {
    temperature: median(lights.map((light) => light.temperature)),
    tint: median(lights.map((light) => light.tint)),
  };
}

/** The mean color of frames of one scene: log2 of red and of blue over green, on unclipped pixels lit enough. */
interface ChromaBalance {
  red: number;
  blue: number;
}

function chromaBalance(frames: readonly AnalysisFrame[]): ChromaBalance | null {
  let red = 0;
  let blue = 0;
  let count = 0;
  for (const { data } of frames)
    for (let index = 0; index < data.length; index += 4) {
      if (Math.max(data[index]!, data[index + 1]!, data[index + 2]!) >= WHITE_BALANCE.clippedCode) continue;
      const pixel = [LINEAR_CODES[data[index]!]!, LINEAR_CODES[data[index + 1]!]!, LINEAR_CODES[data[index + 2]!]!];
      if (luma(pixel) < WHITE_BALANCE.noisyLuma * 5) continue;
      red += Math.log2((pixel[0]! + 1e-4) / (pixel[1]! + 1e-4));
      blue += Math.log2((pixel[2]! + 1e-4) / (pixel[1]! + 1e-4));
      count++;
    }
  return count ? { red: red / count, blue: blue / count } : null;
}

/** How finished frames look, as they are; `cast` is measured on `toned` frames instead when given. */
function finishedLook(frames: readonly AnalysisFrame[], toned: readonly AnalysisFrame[] = frames): LookProfile | null {
  const statistics = toneStatistics(frames, NEUTRAL_BALANCE, LOOK_MATCH.samples);
  if (!statistics) return null;
  const level = (value: number): number => encode709(Math.min(1, value));
  const identity = renderFlat(NEUTRAL_BALANCE, NEUTRAL_TONE);
  return {
    levels: statistics.levels.map(level),
    middle: level(statistics.logAverage),
    shadow: level(statistics.shadow),
    cast: castOf(toned),
    ...saturationQuantiles(statistics.samples, identity),
    colorfulness: samplesColorfulness(statistics.samples, identity),
  };
}

/** Saturation and Vibrance left neutral: the cast is measured before them, which would scale it. */
const unsaturated = (correction: Readonly<AutoCorrection>): AutoCorrection => ({
  ...correction,
  ...NEUTRAL_CHROMA,
});

/** How frames look through `correction`, with `base`'s other settings. */
function gradedLook(
  frames: readonly AnalysisFrame[],
  correction: Readonly<AutoCorrection>,
  base: Readonly<ColorSettings>,
): LookProfile | null {
  return finishedLook(rendered(frames, correction, base), rendered(frames, unsaturated(correction), base));
}

const elevenOf = (color: Readonly<ColorSettings>): AutoCorrection =>
  Object.fromEntries(
    ['temperature', 'tint', 'saturation', 'vibrance', ...Object.keys(NEUTRAL_TONE)].map((key) => [
      key,
      color[key as keyof AutoCorrection],
    ]),
  ) as AutoCorrection;

/**
 * How frames look through `color`, a grade's settings at the analyzed frames: measured on the frames as graded
 * (as they are when `color` is neutral, such as finished footage), the cast before Saturation and Vibrance. Null
 * when no frame has usable pixels.
 */
export function measureLook(
  frames: readonly AnalysisFrame[],
  color: Readonly<ColorSettings> = createColorSettings(),
): LookProfile | null {
  const small = frames.map(reduced);
  return isNeutralColor(color) ? finishedLook(small) : gradedLook(small, elevenOf(color), color);
}

/** A frame and the Color its grade gives it there: neutral for footage as shot. */
export interface GradedFrame {
  frame: AnalysisFrame;
  color: Readonly<ColorSettings>;
}

/** A frame match: the eleven settings, and how far they follow the picture rather than its light and look. */
export interface FrameMatch {
  correction: AutoCorrection;
  /** 0 for different scenes (matched by light and look only) to 1 for the same scene (matched to the picture). */
  likeness: number;
}

const cauchy = (residual: number): number => LOOK_MATCH.robust ** 2 * Math.log1p((residual / LOOK_MATCH.robust) ** 2);
const LOGARITHMIC: ReadonlySet<Fitted> = new Set(['contrast', 'saturation']);

/** How far `value` moved from `start`, in units of the setting's pull scale, squared and weighted. */
function pullOf(key: Fitted, value: number, start: number): number {
  const moved = LOGARITHMIC.has(key) ? Math.log2(value / start) : value - start;
  return LOOK_MATCH.pull * (moved / LOOK_MATCH.pullScales[key]) ** 2;
}

/** Each setting's range within `bounds` and within its reach of `start`. */
function reachOf(start: Readonly<AutoCorrection>, bounds: FitBounds): FitBounds {
  const ranges = {} as Record<Fitted, Range>;
  for (const key of Object.keys(LOOK_MATCH.reach) as Fitted[]) {
    const reach = LOOK_MATCH.reach[key];
    const low = LOGARITHMIC.has(key) ? start[key] / reach : start[key] - reach;
    const high = LOGARITHMIC.has(key) ? start[key] * reach : start[key] + reach;
    ranges[key] = { low: Math.max(bounds[key].low, low), high: Math.min(bounds[key].high, high) };
  }
  return ranges;
}

/** Auto adjust's correction of one frame, or null when it cannot analyze it. */
function autoCorrectionOf(frame: AnalysisFrame): AutoCorrection | null {
  return analyzeAutoAdjust([frame], [frameIlluminant(frame)]);
}

/**
 * Where a frame match starts: the reference's settings, moved by the difference between the two frames' Auto
 * corrections in Exposure, Temperature and Tint. Auto brings both frames to the same balance, so the reference's
 * settings on top of that difference give the target the reference's light and look, whatever each scene shows.
 */
function frameStart(reference: GradedFrame, target: GradedFrame): AutoCorrection {
  const values = elevenOf(reference.color);
  const theirs = autoCorrectionOf(reference.frame);
  const ours = autoCorrectionOf(target.frame);
  if (theirs && ours)
    for (const key of ['exposure', 'temperature', 'tint'] as const)
      values[key] = within(FRAME_BOUNDS[key], values[key] + ours[key] - theirs[key]);
  return values;
}

/**
 * The Temperature and Tint the output's color asks for: for a frame of the same scene, those moving its mean color to
 * the reference's (Temperature and Tint shift log2 red/green by (T + I) / 2 and blue/green by (I − T) / 2); for a
 * style, those moving the cast of its light to the style's.
 */
function wantedBalance(
  look: Readonly<LookProfile>,
  measured: Readonly<LookProfile>,
  values: Readonly<AutoCorrection>,
  colors: { aim: ChromaBalance; measured: ChromaBalance | null } | null,
): WhiteBalance | null {
  if (colors) {
    if (!colors.measured) return null;
    const red = colors.aim.red - colors.measured.red;
    const blue = colors.aim.blue - colors.measured.blue;
    return { temperature: values.temperature + red - blue, tint: values.tint + red + blue };
  }
  if (!look.cast || !measured.cast) return null;
  return {
    temperature: values.temperature + measured.cast.temperature - look.cast.temperature,
    tint: values.tint + measured.cast.tint - look.cast.tint,
  };
}

/** Temperature and Tint moving the output towards the wanted balance, near the start. */
function fitBalance(
  wanted: WhiteBalance | null,
  values: AutoCorrection,
  start: Readonly<AutoCorrection>,
  bounds: FitBounds,
): void {
  if (!wanted) return;
  for (const key of ['temperature', 'tint'] as const)
    values[key] = lineSearch(
      (value) => cauchy((value - wanted[key]) / LOOK_MATCH.castScale) + pullOf(key, value, start[key]),
      bounds[key].low,
      bounds[key].high,
      values[key],
      LOOK_MATCH.steps,
    );
}

const TONE_FITTED = ['exposure', 'contrast', 'blacks', 'whites'] as const;
const toneOf = (values: Readonly<AutoCorrection>) => {
  const tone = { ...NEUTRAL_TONE };
  for (const key of Object.keys(tone) as (keyof typeof tone)[]) tone[key] = values[key];
  return tone;
};
const balanceOf = ({ temperature, tint }: Readonly<AutoCorrection>): WhiteBalance => ({ temperature, tint });

/**
 * The model the tone fit searches through: the output luma of gray anchors at the frames' luma levels and
 * log-average, through the real grade. Colored pixels and local tone make the real output differ a little; the
 * difference is measured on the graded frames and aimed past.
 */
function toneModel(statistics: ToneStatistics, base: Readonly<ColorSettings>, values: Readonly<AutoCorrection>) {
  const render = renderFlat(balanceOf(values), toneOf(values), NEUTRAL_CHROMA, base);
  return [...statistics.levels, statistics.logAverage].map((anchor) => luma(render([anchor, anchor, anchor])));
}

/** A pooled subsample of the frames' pixels, which the color fit grades again at each step. */
function pooledSamples(samples: readonly Float64Array[]): Float64Array[] {
  const picked: number[] = [];
  for (const item of samples) {
    const stride = Math.max(1, Math.floor(item.length / 3 / LOOK_MATCH.chromaSamples));
    for (let offset = 0; offset < item.length; offset += 3 * stride)
      picked.push(item[offset]!, item[offset + 1]!, item[offset + 2]!);
  }
  return picked.length ? [Float64Array.from(picked)] : [];
}

/** The model the color fit searches through: the muted and strong saturations of the pooled pixels, graded. */
function chromaModel(pooled: readonly Float64Array[], base: Readonly<ColorSettings>, values: Readonly<AutoCorrection>) {
  return saturationQuantiles(pooled, renderFlat(balanceOf(values), toneOf(values), values, base));
}

/** Exposure, Contrast, Blacks and Whites bringing the modeled output levels and log-average to `targets`. */
function fitTone(
  targets: readonly number[],
  statistics: ToneStatistics,
  base: Readonly<ColorSettings>,
  values: AutoCorrection,
  start: Readonly<AutoCorrection>,
  bounds: FitBounds,
): void {
  const cost = (candidate: Readonly<AutoCorrection>): number => {
    let sum = 0;
    for (const key of TONE_FITTED) sum += pullOf(key, candidate[key], start[key]);
    toneModel(statistics, base, candidate).forEach((output, index) => {
      sum += cauchy((output - targets[index]!) / LOOK_MATCH.scale);
    });
    return sum;
  };
  for (let sweep = 0; sweep < LOOK_MATCH.sweeps; sweep++)
    for (const key of TONE_FITTED)
      values[key] = lineSearch(
        (value) => cost({ ...values, [key]: value }),
        bounds[key].low,
        bounds[key].high,
        values[key],
        LOOK_MATCH.steps,
      );
}

/**
 * Saturation and Vibrance bringing the modeled muted and strong colors to `targets`, measured on a pooled subsample of
 * the frames' pixels: the grade does not keep the pixels' order of saturation once colors clip.
 */
function fitChroma(
  targets: { muted: number; strong: number },
  pooled: readonly Float64Array[],
  base: Readonly<ColorSettings>,
  values: AutoCorrection,
  start: Readonly<AutoCorrection>,
  bounds: FitBounds,
): void {
  const cost = (candidate: Readonly<AutoCorrection>): number => {
    const { muted, strong } = chromaModel(pooled, base, candidate);
    return (
      cauchy((muted - targets.muted) / LOOK_MATCH.scale) +
      cauchy((strong - targets.strong) / LOOK_MATCH.scale) +
      pullOf('saturation', candidate.saturation, start.saturation) +
      pullOf('vibrance', candidate.vibrance, start.vibrance)
    );
  };
  for (let sweep = 0; sweep < LOOK_MATCH.sweeps; sweep++)
    for (const key of ['saturation', 'vibrance'] as const)
      values[key] = lineSearch(
        (value) => cost({ ...values, [key]: value }),
        bounds[key].low,
        bounds[key].high,
        values[key],
        LOOK_MATCH.steps,
      );
}

/**
 * The eleven settings, from `start`, that make `frames` graded through `base` (the grade's other settings) look like
 * `look`: Temperature and Tint from the casts, then the tone, then Saturation and Vibrance, each within its reach of
 * the start; Brightness, Highlights and Shadows keep their start. The tone and color fits search through models of
 * the grade; each pass measures the graded frames and aims the models past their difference from the real output.
 * Robust differences and a pull towards the start keep a scene unlike the look from pushing the settings to their
 * bounds. Null when no frame has usable pixels.
 */
function fitLook(
  look: Readonly<LookProfile>,
  frames: readonly AnalysisFrame[],
  base: Readonly<ColorSettings>,
  start: Readonly<AutoCorrection>,
  outer: FitBounds,
  color: ChromaBalance | null = null,
): AutoCorrection | null {
  const bounds = reachOf(start, outer);
  const small = frames.map(reduced);
  const values: AutoCorrection = { ...start };
  for (let pass = 0; pass < LOOK_MATCH.passes; pass++) {
    const before = gradedLook(small, values, base);
    if (!before) return null;
    const colors = color && { aim: color, measured: chromaBalance(rendered(small, unsaturated(values), base)) };
    fitBalance(wantedBalance(look, before, values, colors), values, start, bounds);
    const measured = gradedLook(small, values, base);
    const statistics = toneStatistics(small, balanceOf(values), LOOK_MATCH.samples);
    if (!measured || !statistics) return null;
    const outputs = [...measured.levels, measured.middle];
    const modeled = toneModel(statistics, base, values);
    const toneTargets = [...look.levels, look.middle].map((value, index) => value - outputs[index]! + modeled[index]!);
    fitTone(toneTargets, statistics, base, values, start, bounds);
    const pooled = pooledSamples(statistics.samples);
    if (!pooled.length) continue;
    const chroma = chromaModel(pooled, base, values);
    fitChroma(
      { muted: look.muted - measured.muted + chroma.muted, strong: look.strong - measured.strong + chroma.strong },
      pooled,
      base,
      values,
      start,
      bounds,
    );
  }
  return scaleCorrection(values, AUTO_ADJUST.balancedIntensity);
}

/** The log luma of a coarse grid over the frame's picture, letterbox left out. */
function layout(frame: AnalysisFrame): number[] | null {
  const box = contentBox(frame);
  if (!box) return null;
  const { columns, rows } = LOOK_MATCH.grid;
  const sums = new Float64Array(columns * rows);
  const counts = new Float64Array(columns * rows);
  const width = box.right - box.left + 1;
  const height = box.bottom - box.top + 1;
  const pixel = [0, 0, 0];
  for (let y = box.top; y <= box.bottom; y++)
    for (let x = box.left; x <= box.right; x++) {
      const cell =
        Math.floor(((y - box.top) * rows) / height) * columns + Math.floor(((x - box.left) * columns) / width);
      const index = (y * frame.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixel[channel] = LINEAR_CODES[frame.data[index + channel]!]!;
      sums[cell] = sums[cell]! + luma(pixel);
      counts[cell] = counts[cell]! + 1;
    }
  return Array.from(sums, (sum, cell) => Math.log2(sum / Math.max(1, counts[cell]!) + 1e-3));
}

/**
 * How alike two frames' scenes are, −1 to 1: the correlation of their coarse log-luma layouts, which exposure,
 * contrast and white balance barely change. About 1 for frames of one shot a second apart, near 0 or below for
 * different scenes, and 0 when either frame is uniform.
 */
export function frameSimilarity(left: AnalysisFrame, right: AnalysisFrame): number {
  const a = layout(left);
  const b = layout(right);
  if (!a || !b) return 0;
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let product = 0;
  let squaresA = 0;
  let squaresB = 0;
  a.forEach((value, index) => {
    product += (value - meanA) * (b[index]! - meanB);
    squaresA += (value - meanA) ** 2;
    squaresB += (b[index]! - meanB) ** 2;
  });
  return squaresA > 1e-9 && squaresB > 1e-9 ? product / Math.sqrt(squaresA * squaresB) : 0;
}

/** How far a frame match follows the fitted picture over its start: 0 to 1 between the similar bounds. */
export function sceneLikeness(similarity: number): number {
  const { low, high } = LOOK_MATCH.similar;
  return Math.min(1, Math.max(0, (similarity - low) / (high - low)));
}

/** `start` moved `share` of the way to `fitted`: Contrast and Saturation geometrically. */
function blended(start: Readonly<AutoCorrection>, fitted: Readonly<AutoCorrection>, share: number): AutoCorrection {
  const values = { ...fitted };
  for (const key of AUTO_ADJUST_SETTINGS) {
    const from = start[key];
    const to = fitted[key];
    values[key] = key === 'contrast' || key === 'saturation' ? from * (to / from) ** share : from + (to - from) * share;
  }
  return scaleCorrection(values, AUTO_ADJUST.balancedIntensity);
}

/**
 * A grade's eleven settings moved `intensity` (0–1) of the way from `current` to a match: the match's Intensity, 0
 * leaving the grade as it is and 1 applying the match.
 */
export function towardsMatch(
  current: Readonly<ColorSettings>,
  matched: Readonly<AutoCorrection>,
  intensity: number,
): AutoCorrection {
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1)
    throw new Error('Intensity must be between 0 and 100%.');
  return blended(elevenOf(current), matched, intensity);
}

/**
 * The eleven settings that make `target`, with its grade's other settings, look like `reference` as its grade shows
 * it. They start from the reference's settings with the frames' difference of light (see frameStart), then follow the
 * fitted picture as far as the scenes are alike: statistics of different scenes differ by what they show, which no
 * grade should copy. Null when either frame has no usable pixels.
 */
export function matchFrame(reference: GradedFrame, target: GradedFrame): FrameMatch | null {
  const look = measureLook([reference.frame], reference.color);
  if (!look) return null;
  const small = reduced(reference.frame);
  const color = chromaBalance(rendered([small], unsaturated(elevenOf(reference.color)), reference.color));
  const start = frameStart(reference, target);
  const fitted = fitLook(look, [target.frame], target.color, start, FRAME_BOUNDS, color);
  if (!fitted) return null;
  const likeness = sceneLikeness(frameSimilarity(reference.frame, target.frame));
  return { correction: blended(start, fitted, likeness), likeness };
}

/**
 * The eleven settings bringing `target` towards a registered style's look, within Auto's bounds: from Auto's own
 * correction of the frame, fitted to the style's statistics. Null when the frame has no usable pixels.
 */
export function matchStyle(look: Readonly<LookProfile>, target: GradedFrame): AutoCorrection | null {
  const start = autoCorrectionOf(target.frame);
  if (!start) return null;
  return fitLook(look, [target.frame], target.color, start, STYLE_BOUNDS);
}
