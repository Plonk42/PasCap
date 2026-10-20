import {
  clamp01,
  COLOUR_CONTROLS,
  compilePixelGrade,
  createColourSettings,
  decode709,
  encode709,
  temperatureTintGains,
  type ColourSettings,
  type RGB,
} from './colour.js';
import { localToneStops } from './detail.js';
import {
  contentBox,
  frameIlluminant,
  LINEAR_CODES,
  LUMA,
  median,
  poolWhiteBalance,
  WHITE_BALANCE,
  whiteBalanceWindow,
  type AnalysisFrame,
  type IlluminantEstimate,
  type WhiteBalance,
} from './white-balance.js';

/** Auto adjust (#167): starting values, tuned on synthetic fixtures and real flights; see docs/design/AUTO_ADJUST.md. */
export const AUTO_ADJUST = Object.freeze({
  /** Source frames analysed, at the centres of equal slices of the clip's range. */
  frames: 16,
  /** A keyframe analyses the same number of frames within this many project frames (1 s) of the playhead. */
  keyframeRadius: 30,
  /** Centre weight 0.5 + 0.5·exp(−r² / (2σ²)), r the distance from the centre (1 at the corners). */
  centreSigma: 0.35,
  /** Reinhard's automatic key: mid-grey, adapted to high- and low-key scenes within these bounds. */
  key: 0.18,
  minimumKey: 0.09,
  maximumKey: 0.72,
  /** A 99th luma percentile at least this bright is clipped: overexposure, not a high-key scene. */
  clippedLuma: 0.95,
  /** Exposure is left alone while the log-average stays within this many stops of the key. */
  keyTolerance: 0.5,
  keyWeight: 4,
  /**
   * Encoded output bands of the 0.5th and 99.5th luma percentiles, and their distance scale. The black point
   * may rise to 0.08: Shadows lifts it with the shadow areas.
   */
  black: [0.01, 0.08] as const,
  white: [0.92, 0.98] as const,
  bandScale: 0.02,
  /** Areas are blocks this many to the frame height, about the reach of the base Shadows and Highlights use. */
  areaLines: 22.5,
  /**
   * Once the rest of the tone is fitted, Shadows lifts the darkest tenth of the areas to at most this many
   * stops below the log-average, up to its bound: on real flights, about the Shadows chosen by hand.
   */
  shadowArea: 0.1,
  shadowStops: 1.5,
  /**
   * Flat footage also lost midtone contrast: Contrast is pulled towards 1 + flatContrast per stop by which
   * the scene's black-to-white range falls short of the bands' range, beyond rangeTolerance stops.
   */
  rangeTolerance: 1,
  flatContrast: 0.2,
  maximumFlatContrast: 1.4,
  /** Weight of stops pushed past clipping on the saturated colour anchor. */
  clipWeight: 4,
  /** Pull towards no correction, so good footage barely changes. */
  regularisation: 0.02,
  sweeps: 16,
  lineSearchSteps: 24,
  /** Below this 99.5th percentile luma, footage is dark: halve the stretch rather than amplify noise. */
  lowLight: 0.05,
  /** Hasler–Süsstrunk colourfulness target, response exponent and bounds of the Saturation. */
  colourfulness: 65,
  saturationExponent: 0.75,
  minimumSaturation: 0.9,
  maximumSaturation: 1.5,
  /** Below this colourfulness footage is monochrome and keeps Saturation 1. */
  monochrome: 5,
  /** Pixels whose colourfulness is measured, shared among the frames. */
  saturationSamples: 20_000,
  /** Intensity that applies the correction as fitted; above it, up to 100%, the correction is exaggerated. */
  balancedIntensity: 0.8,
});

/** Fitted tone settings in solve order, with their bounds and regularisation scales. */
const TONE = [
  { key: 'exposure', low: -1.5, high: 1.5, scale: 1 },
  { key: 'blacks', low: -1, high: 0, scale: 0.6 },
  { key: 'whites', low: -0.5, high: 1, scale: 0.6 },
  { key: 'contrast', low: 0.75, high: 1.8, scale: 0.8 },
  { key: 'brightness', low: -0.15, high: 0.15, scale: 0.1 },
  { key: 'highlights', low: -0.6, high: 0.2, scale: 0.4 },
  { key: 'shadows', low: 0, high: 0.5, scale: 0.4 },
] as const;
type ToneSetting = (typeof TONE)[number]['key'];
type Tone = Record<ToneSetting, number>;
const NEUTRAL_TONE: Readonly<Tone> = Object.freeze({
  exposure: 0,
  blacks: 0,
  whites: 0,
  contrast: 1,
  brightness: 0,
  highlights: 0,
  shadows: 0,
});

/** The ten track Colour settings Auto adjust sets, in Track → Colour order. */
export const AUTO_ADJUST_SETTINGS = [
  'temperature',
  'tint',
  'saturation',
  'exposure',
  'brightness',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
] as const;
export type AutoAdjustSetting = (typeof AUTO_ADJUST_SETTINGS)[number];
/** Resolved settings at the balanced intensity, each within its Colour bounds. */
export type AutoCorrection = Record<AutoAdjustSetting, number>;

/** Settings that scale geometrically from their neutral 1; the others scale linearly from 0. */
const MULTIPLICATIVE: ReadonlySet<AutoAdjustSetting> = new Set(['contrast', 'saturation']);
const BOUNDS = new Map<string, { min: number; max: number }>(COLOUR_CONTROLS.map((control) => [control.key, control]));

/**
 * The correction at `intensity` (0–1), scaled from neutral by intensity / balancedIntensity: log-gains and
 * offsets linearly, Contrast and Saturation geometrically, each kept within its Colour bounds.
 */
export function scaleCorrection(correction: Readonly<AutoCorrection>, intensity: number): AutoCorrection {
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1)
    throw new Error('Intensity must be between 0 and 100%.');
  const amount = intensity / AUTO_ADJUST.balancedIntensity;
  return Object.fromEntries(
    AUTO_ADJUST_SETTINGS.map((setting) => {
      const { min, max } = BOUNDS.get(setting)!;
      const value = MULTIPLICATIVE.has(setting) ? correction[setting] ** amount : correction[setting] * amount;
      return [setting, rounded(Math.min(max, Math.max(min, value)))];
    }),
  ) as AutoCorrection;
}

/** Source frames analysed: the centres of up to AUTO_ADJUST.frames equal slices of [sourceIn, sourceOut). */
export function autoAdjustFrames(sourceIn: number, sourceOut: number): number[] {
  const length = sourceOut - sourceIn;
  if (!Number.isSafeInteger(sourceIn) || !Number.isSafeInteger(sourceOut) || length < 1)
    throw new Error('Auto adjust needs a source range of at least one frame.');
  const count = Math.min(AUTO_ADJUST.frames, length);
  return Array.from({ length: count }, (_, index) => sourceIn + Math.floor(((index + 0.5) * length) / count));
}

/** Project frames a keyframe analyses: the playhead and up to 1 s on each side, within its clip [start, end). */
export function autoAdjustWindow(clip: { start: number; end: number }, playhead: number): number[] {
  return whiteBalanceWindow(clip, playhead, AUTO_ADJUST.frames, AUTO_ADJUST.keyframeRadius);
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}

function luma(rgb: ArrayLike<number>): number {
  return LUMA[0] * rgb[0]! + LUMA[1] * rgb[1]! + LUMA[2] * rgb[2]!;
}

const BINS = 4096;
const LOG_LOW = -20;
const LOG_HIGH = 2;
function binOf(value: number): number {
  const stops = Math.log2(Math.max(value, 2 ** LOG_LOW));
  return Math.min(BINS - 1, Math.max(0, Math.floor(((stops - LOG_LOW) / (LOG_HIGH - LOG_LOW)) * BINS)));
}

/** A weighted histogram in log space (about 0.005 stop per bin). */
class Histogram {
  readonly weights = new Float64Array(BINS);
  total = 0;
  add(value: number, weight: number): number {
    const index = binOf(value);
    this.weights[index]! += weight;
    this.total += weight;
    return index;
  }
  /** The value below which a fraction `q` of the weight lies, interpolated within its bin. */
  quantile(q: number): number {
    const target = q * this.total;
    let cumulative = 0;
    for (let index = 0; index < BINS; index++) {
      const weight = this.weights[index]!;
      if (weight > 0 && cumulative + weight >= target)
        return 2 ** (LOG_LOW + ((index + (target - cumulative) / weight) / BINS) * (LOG_HIGH - LOG_LOW));
      cumulative += weight;
    }
    return 2 ** LOG_HIGH;
  }
}

/** What the tone fit needs, in white-balanced linear light: each statistic is the median over the frames. */
export interface ToneStatistics {
  /** Luma percentiles: 0.5th and 99.5th. */
  black: number;
  white: number;
  logAverage: number;
  /** The AUTO_ADJUST.shadowArea quantile of the areas' mean luma: how dark the shadow areas are. */
  shadow: number;
  /** Reinhard's adaptive key for this scene. */
  key: number;
  /** A colour typical of the 99th percentile of the brightest channel: saturated colours clip first. */
  saturated: RGB;
  /** Each frame's deterministic subsample of pixels (RGB triples), for its colourfulness. */
  samples: Float64Array[];
}

interface FrameTone extends Omit<ToneStatistics, 'key' | 'samples'> {
  low: number;
  high: number;
  samples: Float64Array;
}

/** One frame's weighted histograms: pixels weighted towards the centre, noisy ones left out. */
class FrameAccumulator {
  readonly luma = new Histogram();
  readonly brightest = new Histogram();
  readonly colours = new Float64Array(BINS * 3);
  readonly samples: number[] = [];
  /** Per area: summed luma, pixel count and centre weight. */
  readonly areas: Float64Array;
  logSum = 0;
  #counter = 0;
  constructor(
    readonly gains: RGB,
    readonly stride: number,
    areas: number,
  ) {
    this.areas = new Float64Array(areas * 3);
  }

  add(red: number, green: number, blue: number, weight: number, area: number): void {
    const rgb: RGB = [red * this.gains[0], green * this.gains[1], blue * this.gains[2]];
    if (this.#counter++ % this.stride === 0) this.samples.push(...rgb);
    const level = luma(rgb);
    this.areas[area * 3]! += level;
    this.areas[area * 3 + 1]! += 1;
    this.areas[area * 3 + 2]! += weight;
    if (level < WHITE_BALANCE.noisyLuma) return;
    this.luma.add(level, weight);
    this.logSum += weight * Math.log(level + 1e-4);
    const index = this.brightest.add(Math.max(...rgb), weight);
    for (let channel = 0; channel < 3; channel++) this.colours[index * 3 + channel]! += weight * rgb[channel]!;
  }

  tone(): FrameTone | null {
    if (this.luma.total <= 0) return null;
    const index = binOf(this.brightest.quantile(0.99));
    const weight = this.brightest.weights[index]!;
    const areas = new Histogram();
    for (let area = 0; area < this.areas.length; area += 3)
      if (this.areas[area + 1]! > 0) areas.add(this.areas[area]! / this.areas[area + 1]!, this.areas[area + 2]!);
    return {
      black: this.luma.quantile(0.005),
      low: this.luma.quantile(0.01),
      high: this.luma.quantile(0.99),
      white: this.luma.quantile(0.995),
      logAverage: Math.exp(this.logSum / this.luma.total),
      shadow: areas.quantile(AUTO_ADJUST.shadowArea),
      saturated: [0, 1, 2].map((channel) => this.colours[index * 3 + channel]! / weight) as unknown as RGB,
      samples: Float64Array.from(this.samples),
    };
  }
}

function frameTone(frame: AnalysisFrame, gains: RGB, samples: number): FrameTone | null {
  const box = contentBox(frame);
  if (!box) return null;
  const width = box.right - box.left + 1;
  const height = box.bottom - box.top + 1;
  const size = Math.max(1, Math.round(height / AUTO_ADJUST.areaLines));
  const columns = Math.ceil(width / size);
  const accumulator = new FrameAccumulator(
    gains,
    Math.max(1, Math.floor((width * height) / samples)),
    columns * Math.ceil(height / size),
  );
  const weights = centreWeights(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const source = ((box.top + y) * frame.width + box.left + x) * 4;
      accumulator.add(
        LINEAR_CODES[frame.data[source]!]!,
        LINEAR_CODES[frame.data[source + 1]!]!,
        LINEAR_CODES[frame.data[source + 2]!]!,
        weights[y * width + x]!,
        Math.floor(y / size) * columns + Math.floor(x / size),
      );
    }
  return accumulator.tone();
}

function centreWeights(width: number, height: number): Float64Array {
  const weights = new Float64Array(width * height);
  const spread = 2 * AUTO_ADJUST.centreSigma ** 2;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = (x + 0.5) / width - 0.5;
      const dy = (y + 0.5) / height - 0.5;
      weights[y * width + x] = 0.5 + 0.5 * Math.exp(-(2 * (dx * dx + dy * dy)) / spread);
    }
  return weights;
}

/** Reinhard (2002): the key rises for scenes whose log-average sits high in their range, falls for low ones. */
function adaptiveKey(logAverage: number, low: number, high: number): number {
  const range = Math.log2(high) - Math.log2(low);
  if (!Number.isFinite(range) || range <= 1e-6) return AUTO_ADJUST.key;
  const key = AUTO_ADJUST.key * 4 ** ((2 * Math.log2(logAverage) - Math.log2(low) - Math.log2(high)) / range);
  return Math.min(AUTO_ADJUST.maximumKey, Math.max(AUTO_ADJUST.minimumKey, key));
}

/**
 * Pixel statistics of the analysed frames after the white balance gains. Each frame is measured on its
 * own and every statistic is the median over the frames, so one frame facing the sun cannot decide.
 */
export function toneStatistics(frames: readonly AnalysisFrame[], balance: WhiteBalance): ToneStatistics | null {
  const gains = temperatureTintGains(balance);
  const share = AUTO_ADJUST.saturationSamples / Math.max(1, frames.length);
  const tones = frames
    .map((frame) => frameTone(frame, gains, share))
    .filter((tone): tone is FrameTone => tone !== null);
  if (!tones.length) return null;
  const pooled = (read: (tone: FrameTone) => number): number => median(tones.map(read));
  const logAverage = pooled((tone) => tone.logAverage);
  const high = pooled((tone) => tone.high);
  const key = adaptiveKey(
    logAverage,
    pooled((tone) => tone.low),
    high,
  );
  return {
    black: pooled((tone) => tone.black),
    white: pooled((tone) => tone.white),
    logAverage,
    shadow: pooled((tone) => tone.shadow),
    key: high >= AUTO_ADJUST.clippedLuma ? Math.min(AUTO_ADJUST.key, key) : key,
    saturated: [0, 1, 2].map((channel) => pooled((tone) => tone.saturated[channel]!)) as unknown as RGB,
    samples: tones.map((tone) => tone.samples),
  };
}

/**
 * Renders a white-balanced linear pixel of a flat area as PasCap does: Shadows/Highlights (local tone,
 * whose base is the area itself) on the source pixel, then the grade. Returns encoded RGB.
 */
export function renderFlat(
  balance: WhiteBalance,
  tone: Readonly<Tone>,
  saturation: number,
): (balanced: ArrayLike<number>) => RGB {
  const gains = temperatureTintGains(balance);
  const settings: ColourSettings = { ...createColourSettings(), ...balance, ...tone, saturation };
  const grade = compilePixelGrade(settings);
  const local = { ...tone, hdr: 0, localContrast: 0 };
  const toned = tone.shadows !== 0 || tone.highlights !== 0;
  return (balanced) => {
    const encoded = [0, 1, 2].map((channel) => encode709(clamp01(balanced[channel]! / gains[channel]!)));
    if (!toned) return grade(encoded as unknown as RGB);
    const gain = 2 ** localToneStops(luma(encoded), local);
    return grade(encoded.map((value) => clamp01(encode709(decode709(value) * gain))) as unknown as RGB);
  };
}

function band(value: number, [low, high]: readonly [number, number]): number {
  if (value < low) return (low - value) / AUTO_ADJUST.bandScale;
  if (value > high) return (value - high) / AUTO_ADJUST.bandScale;
  return 0;
}

const CLIPPED = 0.999;
/** Stops by which a colour is pushed past clipping in its brightest channel: 0 when it does not clip. */
function clippedStops(render: (balanced: ArrayLike<number>) => RGB, colour: RGB): number {
  if (Math.max(...render(colour)) < CLIPPED) return 0;
  let low = 0;
  let high = 8;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    const scale = 2 ** -middle;
    if (Math.max(...render([colour[0] * scale, colour[1] * scale, colour[2] * scale])) >= CLIPPED) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * Pull towards no correction, so good footage barely changes. Contrast is pulled towards a value that
 * grows with the stretch the black and white points need: flat footage also lost midtone contrast.
 */
function regularisation(tone: Readonly<Tone>, contrast: number): number {
  let sum = 0;
  for (const { key, scale } of TONE) {
    const value = key === 'contrast' ? Math.log2(tone.contrast / contrast) : tone[key];
    sum += (value / scale) ** 2;
  }
  return AUTO_ADJUST.regularisation * sum;
}

const middleOf = ([low, high]: readonly [number, number]): number => decode709((low + high) / 2);
/** Stops between the middles of the black and white bands: the range a corrected scene spans. */
const TARGET_RANGE = Math.log2(middleOf(AUTO_ADJUST.white) / middleOf(AUTO_ADJUST.black));
/**
 * The Contrast flat footage needs, from its range in stops: unlike encoded values, that range does not
 * change with exposure, so an underexposed shot is not mistaken for a flat one.
 */
function flatContrast(statistics: ToneStatistics): number {
  const range = Math.log2(Math.min(1, statistics.white) / Math.max(statistics.black, WHITE_BALANCE.noisyLuma));
  const shortfall = Math.max(0, TARGET_RANGE - range - AUTO_ADJUST.rangeTolerance);
  return Math.min(AUTO_ADJUST.maximumFlatContrast, 1 + AUTO_ADJUST.flatContrast * shortfall);
}

/**
 * The tone objective, measured through the real local tone and grade on flat anchors: the log-average near
 * the key (Reinhard's display value key / (1 + key)), black and white points in their bands, saturated
 * colours unclipped, and as little correction as possible. Shadows is not fitted against it: see fitShadows.
 */
function toneCost(statistics: ToneStatistics, balance: WhiteBalance): (tone: Readonly<Tone>) => number {
  const target = statistics.key / (1 + statistics.key);
  const contrast = flatContrast(statistics);
  return (tone) => {
    const render = renderFlat(balance, tone, 1);
    const level = (value: number): number => luma(render([value, value, value]));
    const middle = Math.max(1e-6, decode709(level(statistics.logAverage)));
    const miss = Math.max(0, Math.abs(Math.log2(middle / target)) - AUTO_ADJUST.keyTolerance);
    return (
      AUTO_ADJUST.keyWeight * miss * miss +
      band(level(statistics.black), AUTO_ADJUST.black) ** 2 +
      band(level(statistics.white), AUTO_ADJUST.white) ** 2 +
      AUTO_ADJUST.clipWeight * clippedStops(render, statistics.saturated) ** 2 +
      regularisation(tone, contrast)
    );
  };
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;
/** Golden-section search on [low, high]; keeps `current` unless the search finds a lower cost. */
function lineSearch(cost: (value: number) => number, low: number, high: number, current: number): number {
  let a = low;
  let b = high;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let costC = cost(c);
  let costD = cost(d);
  for (let step = 0; step < AUTO_ADJUST.lineSearchSteps; step++) {
    if (costC <= costD) {
      b = d;
      d = c;
      costD = costC;
      c = b - GOLDEN * (b - a);
      costC = cost(c);
    } else {
      a = c;
      c = d;
      costC = costD;
      d = a + GOLDEN * (b - a);
      costD = cost(d);
    }
  }
  const found = (a + b) / 2;
  return cost(found) < cost(current) ? found : current;
}

/** Settings that lift dark footage, halved in low light where they would mostly amplify noise. */
const LIFTING = ['exposure', 'whites', 'brightness', 'shadows'] as const;

/**
 * Projected coordinate descent with a fixed number of sweeps, deterministic and bounded: each sweep fits the
 * other tone settings to the objective, then Shadows to the shadow areas.
 */
function fitTone(statistics: ToneStatistics, balance: WhiteBalance): Tone {
  const cost = toneCost(statistics, balance);
  const tone = { ...NEUTRAL_TONE };
  for (let sweep = 0; sweep < AUTO_ADJUST.sweeps; sweep++) {
    for (const { key, low, high } of TONE)
      if (key !== 'shadows') tone[key] = lineSearch((value) => cost({ ...tone, [key]: value }), low, high, tone[key]);
    tone.shadows = fitShadows(statistics, balance, tone);
  }
  if (statistics.white < AUTO_ADJUST.lowLight) {
    for (const key of LIFTING) tone[key] *= 0.5;
    tone.contrast = 1 + (tone.contrast - 1) * 0.5;
  }
  return tone;
}

const SHADOWS = TONE.find(({ key }) => key === 'shadows')!;
/**
 * The smallest Shadows that lifts the darkest tenth of the areas, through the fitted tone, to at most
 * shadowStops below the log-average, up to its bound. Only Shadows, which changes the areas below mid-grey
 * and keeps their local contrast, opens them: flattening Contrast or raising Exposure would cost the rest of
 * the picture. Measured on the output, so opened shadow areas are not opened again.
 */
function fitShadows(statistics: ToneStatistics, balance: WhiteBalance, tone: Readonly<Tone>): number {
  const lifted = (shadows: number): boolean => {
    const render = renderFlat(balance, { ...tone, shadows }, 1);
    const level = (value: number): number => decode709(luma(render([value, value, value])));
    return level(statistics.shadow) >= level(statistics.logAverage) * 2 ** -AUTO_ADJUST.shadowStops;
  };
  if (lifted(0)) return 0;
  if (!lifted(SHADOWS.high)) return SHADOWS.high;
  let low = 0;
  let high: number = SHADOWS.high;
  for (let step = 0; step < AUTO_ADJUST.lineSearchSteps; step++) {
    const middle = (low + high) / 2;
    if (lifted(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/** Hasler–Süsstrunk colourfulness of pixels after white balance and tone, on encoded 0–255 values. */
function colourfulness(samples: Float64Array, render: (balanced: ArrayLike<number>) => RGB): number {
  const count = samples.length / 3;
  let sumRg = 0;
  let sumYb = 0;
  let squareRg = 0;
  let squareYb = 0;
  for (let index = 0; index < samples.length; index += 3) {
    const [red, green, blue] = render(samples.subarray(index, index + 3));
    const rg = 255 * (red - green);
    const yb = 255 * ((red + green) / 2 - blue);
    sumRg += rg;
    sumYb += yb;
    squareRg += rg * rg;
    squareYb += yb * yb;
  }
  const meanRg = sumRg / count;
  const meanYb = sumYb / count;
  const deviation = Math.sqrt(
    Math.max(0, squareRg / count - meanRg ** 2) + Math.max(0, squareYb / count - meanYb ** 2),
  );
  return deviation + 0.3 * Math.hypot(meanRg, meanYb);
}

/** Saturation towards a fairly colourful result, from the median frame colourfulness after tone. */
function fitSaturation(statistics: ToneStatistics, balance: WhiteBalance, tone: Readonly<Tone>): number {
  const render = renderFlat(balance, tone, 1);
  const frames = statistics.samples.filter((samples) => samples.length > 0);
  if (!frames.length) return 1;
  const measured = median(frames.map((samples) => colourfulness(samples, render)));
  if (measured < AUTO_ADJUST.monochrome) return 1;
  const saturation = (AUTO_ADJUST.colourfulness / measured) ** AUTO_ADJUST.saturationExponent;
  return Math.min(AUTO_ADJUST.maximumSaturation, Math.max(AUTO_ADJUST.minimumSaturation, saturation));
}

/**
 * A balanced correction for the analysed frames, by analysis through the real grade: white balance as
 * Auto white balance estimates it, then tone, then Saturation. Null when no frame has usable pixels.
 * `illuminants` are the frames' `frameIlluminant` estimates, when the caller already computed them.
 */
export function analyseAutoAdjust(
  frames: readonly AnalysisFrame[],
  illuminants: readonly (IlluminantEstimate | null)[] = frames.map(frameIlluminant),
): AutoCorrection | null {
  const balance = poolWhiteBalance(illuminants) ?? { temperature: 0, tint: 0 };
  const statistics = toneStatistics(frames, balance);
  if (!statistics) return null;
  const tone = fitTone(statistics, balance);
  const saturation = fitSaturation(statistics, balance, tone);
  return scaleCorrection({ ...balance, ...tone, saturation }, AUTO_ADJUST.balancedIntensity);
}
