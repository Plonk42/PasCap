import {
  AUTO_ADJUST,
  AUTO_TONE,
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
  type Chroma,
  type Tone,
  type ToneSetting,
  type ToneStatistics,
} from './auto-adjust.js';
import { createColorSettings, encode709, isNeutralColor, temperatureTintGains, type ColorSettings } from './color.js';
import { gradeColorAt, type ClipGrade } from './grade.js';
import {
  frameIlluminant,
  LINEAR_CODES,
  median,
  WHITE_BALANCE,
  type AnalysisFrame,
  type WhiteBalance,
} from './white-balance.js';

/** Shot matching (#315): constants of the fit; see docs/design/AUTO_ADJUST.md (Matching a look). */
export const LOOK_MATCH = Object.freeze({
  /** Output differences, in encoded luma or linear saturation, are measured in units of this. */
  scale: 0.02,
  /** Coordinate descent sweeps of the tone fit and of the color fit, each pass starting from the last. */
  sweeps: 8,
  chromaSweeps: 2,
  /** Golden-section steps of the color fit's line searches: about 0.006 on Saturation and Vibrance. */
  chromaSteps: 12,
  /** Fits: after each but the last, the output is measured and the fit aims again at what it missed. */
  passes: 2,
  /** Frames are measured at most this wide: a 320 × 180 analysis frame is measured at 80 × 45. */
  width: 80,
  /** Pixels whose saturations and colorfulness are measured, shared among the frames… */
  samples: 4000,
  /** …and of them, per frame, those the color fit grades again. */
  chromaSamples: 32,
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
/** What a fit may set: each setting's range, and the tone settings' regularization scales. */
export interface MatchBounds {
  tone: readonly (Range & { key: ToneSetting; scale: number })[];
  saturation: Range;
  vibrance: Range;
  temperature: Range;
  tint: Range;
}

/** A match: wider than Auto's balance, so that shots can take a graded hero's look. */
export const MATCH_BOUNDS: MatchBounds = Object.freeze<MatchBounds>({
  tone: [
    { key: 'exposure', low: -2, high: 2, scale: 1 },
    { key: 'blacks', low: -1, high: 1, scale: 0.6 },
    { key: 'whites', low: -1, high: 1, scale: 0.6 },
    { key: 'contrast', low: 0.5, high: 2, scale: 0.8 },
    { key: 'brightness', low: -0.3, high: 0.3, scale: 0.1 },
    { key: 'highlights', low: -1, high: 1, scale: 0.4 },
    { key: 'shadows', low: -1, high: 1, scale: 0.4 },
  ],
  saturation: { low: 0, high: 2 },
  vibrance: { low: -1, high: 1 },
  temperature: { low: -2, high: 2 },
  tint: { low: -1, high: 1 },
});

/** A style: Auto's own settings and bounds, aimed at the style instead of Auto's constants. */
export const STYLE_BOUNDS: MatchBounds = Object.freeze<MatchBounds>({
  tone: AUTO_TONE,
  saturation: { low: AUTO_ADJUST.minimumSaturation, high: AUTO_ADJUST.maximumSaturation },
  vibrance: { low: 0, high: AUTO_ADJUST.maximumVibrance },
  temperature: { low: -WHITE_BALANCE.temperatureLimit, high: WHITE_BALANCE.temperatureLimit },
  tint: { low: -WHITE_BALANCE.tintLimit, high: WHITE_BALANCE.tintLimit },
});

/** Regularization scales of Saturation (in stops) and Vibrance. */
const CHROMA_SCALE = 0.5;
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

function regularization(tone: Readonly<Tone>, bounds: MatchBounds): number {
  let sum = 0;
  for (const { key, scale } of bounds.tone) {
    const value = key === 'contrast' ? Math.log2(tone[key]) : tone[key];
    sum += (value / scale) ** 2;
  }
  return AUTO_ADJUST.regularization * sum;
}

/** What a fit renders through: the white balance, the grade's other settings, and the bounds of what it sets. */
interface FitSettings {
  balance: WhiteBalance;
  base: Readonly<ColorSettings>;
  bounds: MatchBounds;
}

/** The tone settings whose output levels, shadow areas and log-average come closest to the aimed ones, on gray anchors. */
function matchTone(
  aim: Readonly<LookProfile>,
  statistics: ToneStatistics,
  { balance, base, bounds }: FitSettings,
  start: Readonly<Tone>,
): Tone {
  const anchors = [...statistics.levels, statistics.logAverage, statistics.shadow];
  const targets = [...aim.levels, aim.middle, aim.shadow];
  const cost = (tone: Readonly<Tone>): number => {
    const render = renderFlat(balance, tone, NEUTRAL_CHROMA, base);
    let sum = 0;
    anchors.forEach((anchor, index) => {
      sum += ((luma(render([anchor, anchor, anchor])) - targets[index]!) / LOOK_MATCH.scale) ** 2;
    });
    return sum + regularization(tone, bounds);
  };
  const tone = { ...start };
  for (let sweep = 0; sweep < LOOK_MATCH.sweeps; sweep++)
    for (const { key, low, high } of bounds.tone)
      tone[key] = lineSearch((value) => cost({ ...tone, [key]: value }), low, high, tone[key]);
  return tone;
}

/**
 * Saturation and Vibrance bringing the muted and strong colors to the aimed ones, measured on a pooled subsample
 * of the frames' pixels (the passes correct the difference from the per-frame medians): the grade does not keep
 * the pixels' order of saturation once colors clip.
 */
function matchChroma(
  aim: Readonly<LookProfile>,
  samples: readonly Float64Array[],
  balance: WhiteBalance,
  tone: Readonly<Tone>,
  base: Readonly<ColorSettings>,
  start: Readonly<Chroma>,
  bounds: MatchBounds,
): Chroma {
  const picked: number[] = [];
  for (const item of samples) {
    const stride = Math.max(1, Math.floor(item.length / 3 / LOOK_MATCH.chromaSamples));
    for (let offset = 0; offset < item.length; offset += 3 * stride)
      picked.push(item[offset]!, item[offset + 1]!, item[offset + 2]!);
  }
  const pooled = [Float64Array.from(picked)];
  if (
    !picked.length ||
    samplesColorfulness(pooled, renderFlat(balance, tone, NEUTRAL_CHROMA, base)) < AUTO_ADJUST.monochrome
  )
    return NEUTRAL_CHROMA;
  const cost = (chroma: Readonly<Chroma>): number => {
    const { muted, strong } = saturationQuantiles(pooled, renderFlat(balance, tone, chroma, base));
    const pull = (Math.log2(Math.max(chroma.saturation, 1e-3)) ** 2 + chroma.vibrance ** 2) / CHROMA_SCALE ** 2;
    return (
      ((muted - aim.muted) / LOOK_MATCH.scale) ** 2 +
      ((strong - aim.strong) / LOOK_MATCH.scale) ** 2 +
      AUTO_ADJUST.regularization * pull
    );
  };
  const chroma: Chroma = { ...start };
  for (let sweep = 0; sweep < LOOK_MATCH.chromaSweeps; sweep++) {
    chroma.saturation = lineSearch(
      (value) => cost({ ...chroma, saturation: value }),
      bounds.saturation.low,
      bounds.saturation.high,
      chroma.saturation,
      LOOK_MATCH.chromaSteps,
    );
    chroma.vibrance = lineSearch(
      (value) => cost({ ...chroma, vibrance: value }),
      bounds.vibrance.low,
      bounds.vibrance.high,
      chroma.vibrance,
      LOOK_MATCH.chromaSteps,
    );
  }
  return chroma;
}

/** The aim moved by what the last fit missed: `look` + (aim − measured). */
function reaim(aim: LookProfile, look: Readonly<LookProfile>, measured: Readonly<LookProfile>): LookProfile {
  const step = (key: 'middle' | 'shadow' | 'muted' | 'strong'): number => aim[key] + look[key] - measured[key];
  return {
    ...aim,
    levels: aim.levels.map((value, index) => value + look.levels[index]! - measured.levels[index]!),
    middle: step('middle'),
    shadow: step('shadow'),
    muted: step('muted'),
    strong: step('strong'),
  };
}

/** Temperature and Tint moved so the output's cast becomes the look's, within their bounds. */
function rebalance(
  balance: WhiteBalance,
  look: Readonly<LookProfile>,
  measured: Readonly<LookProfile>,
  bounds: MatchBounds,
): WhiteBalance {
  if (!look.cast || !measured.cast) return balance;
  return {
    temperature: within(bounds.temperature, balance.temperature + measured.cast.temperature - look.cast.temperature),
    tint: within(bounds.tint, balance.tint + measured.cast.tint - look.cast.tint),
  };
}

/**
 * The eleven settings that make frames look like `look`, replacing the grade's values of those settings, with
 * `base`, the grade's other settings (Hue, HSL, curves), kept, each within `bounds`. Tone and color are fitted
 * through the real grade; then the graded frames are measured, Temperature and Tint move their cast to the look's,
 * and the fit aims again at what it missed. Null when no frame has usable pixels.
 */
export function matchLook(
  look: Readonly<LookProfile>,
  frames: readonly AnalysisFrame[],
  base: Readonly<ColorSettings> = createColorSettings(),
  bounds: MatchBounds = MATCH_BOUNDS,
): AutoCorrection | null {
  const small = frames.map(reduced);
  const before = finishedLook(small);
  if (!before) return null;
  let balance = rebalance({ ...NEUTRAL_BALANCE }, look, before, bounds);
  let aim: LookProfile = { ...look };
  let tone: Tone = { ...NEUTRAL_TONE };
  let chroma: Chroma = { ...NEUTRAL_CHROMA };
  for (let pass = 0; pass < LOOK_MATCH.passes; pass++) {
    const statistics = toneStatistics(small, balance, LOOK_MATCH.samples);
    if (!statistics) return null;
    tone = matchTone(aim, statistics, { balance, base, bounds }, tone);
    chroma = matchChroma(aim, statistics.samples, balance, tone, base, chroma, bounds);
    if (pass === LOOK_MATCH.passes - 1) break;
    const measured = gradedLook(small, { ...balance, ...tone, ...chroma }, base);
    if (!measured) break;
    aim = reaim(aim, look, measured);
    balance = rebalance(balance, look, measured, bounds);
  }
  return scaleCorrection({ ...balance, ...tone, ...chroma }, AUTO_ADJUST.balancedIntensity);
}

/** The hero's grade as it looks over the analyzed frames: its Color at the middle one. */
export function heroColor(
  grade: Pick<ClipGrade, 'color' | 'keyframes'>,
  sourceFrames: readonly number[],
): ColorSettings {
  return gradeColorAt(grade, sourceFrames[sourceFrames.length >> 1]!);
}
