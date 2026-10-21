import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { MUSIC_ANALYSIS_HOP, sectionKinds, type MusicMeasurement } from '../shared/music-analysis.js';
import { MUSIC_BYTES_PER_SAMPLE, MUSIC_SAMPLE_RATE } from '../shared/music-format.js';
import { whileSerial } from '../shared/serial.js';
import { ServiceError } from './errors.js';

/** Every tuning constant of the music analysis, in one place for evaluation on real songs. */
export const MUSIC_ANALYSIS = {
  window: 2048,
  bands: 40,
  lowHz: 30,
  highHz: 16_000,
  /** Bands centred below this carry the kick drum, used to find downbeats. */
  kickHz: 150,
  chromaHz: [55, 2_000] as const,
  /** Spectral flux peaks this many samples before the onset that causes it (measured on clicks). */
  onsetLead: 365,
  /** Onset envelope: the local mean over ±0.5 s is removed. */
  meanFrames: 50,
  bpm: [50, 220] as const,
  /** Log-normal tempo prior around 120 BPM, in octaves. */
  prior: { bpm: 120, octaves: 1.5 },
  /** The fastest periodicity scoring at least this share of the best is the tempo. */
  fastestShare: 0.85,
  /**
   * Local tempo: 8 s windows every 2 s. A window takes its own tempo, within this many octaves of the
   * global one, only where the global tempo scores below `change` of its own peak (a tempo change).
   */
  tempoWindow: { frames: 800, step: 200, octaves: 0.25, change: 0.5 },
  tightness: 100,
  /** Fewer tracked beats than this are isolated hits, not a tempo. */
  minimumBeats: 4,
  /** Below this tempo confidence the pulse is too ambiguous to tap along to: no tempo or beats. */
  minimumConfidence: 0.3,
  /** Below this pulse clarity the onsets barely repeat at the beat (scattered hits): no tempo or beats. */
  minimumClarity: 0.25,
  /** Beats snap to the strongest onset within ±20 ms. */
  refineFrames: 2,
  /** Leading and trailing beats weaker than this share of the beats' RMS are dropped. */
  trimShare: 0.5,
  downbeat: {
    /** Beat salience: standard scores of the kick bands and the chord change (onsets mark every beat alike). */
    weights: { onset: 0, low: 1, harmony: 1 },
    /** Chords are compared over this many beats on either side. */
    harmonyBeats: 4,
    /** Restarting the bar costs this much salience. */
    jump: 8,
    /** Three beats per bar must score this much better than four. */
    threeOverFour: 1.2,
    /** Downbeats this many standard deviations above the other beats make the meter certain. */
    sureContrast: 1.5,
  },
  accentFrames: 15,
  accentPercentile: 0.9,
  /** Section boundaries: novelty over ±8 s, sections at least 8 s long. */
  sectionBlocks: 8,
  sectionNovelty: 0.25,
  /** Section boundaries move to the nearest downbeat within this many seconds. */
  sectionSnapSeconds: 2,
  /** Loudness change across a section, in dB, that makes it a build or a release. */
  sectionSlopeDb: 6,
} as const;

const HOP = MUSIC_ANALYSIS_HOP;
const WINDOW = MUSIC_ANALYSIS.window;
const HALF = WINDOW / 2;
const BANDS = MUSIC_ANALYSIS.bands;
const FRAME_RATE = MUSIC_SAMPLE_RATE / HOP;
const BLOCK_FRAMES = FRAME_RATE;
const LOUDNESS_SAMPLES = MUSIC_SAMPLE_RATE / 10;
const RING = 4096;
const CHROMA = 12;
const LAG_MIN = Math.floor((FRAME_RATE * 60) / MUSIC_ANALYSIS.bpm[1]);
const LAG_MAX = Math.ceil((FRAME_RATE * 60) / MUSIC_ANALYSIS.bpm[0]);
const SILENT_DB = -120;

class Fft {
  readonly #reverse: Uint32Array;
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  constructor(readonly size: number) {
    const bits = Math.log2(size);
    this.#reverse = new Uint32Array(size);
    for (let index = 0; index < size; index++) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit++) reversed |= ((index >> bit) & 1) << (bits - 1 - bit);
      this.#reverse[index] = reversed;
    }
    this.#cos = new Float64Array(size / 2);
    this.#sin = new Float64Array(size / 2);
    for (let index = 0; index < size / 2; index++) {
      this.#cos[index] = Math.cos((2 * Math.PI * index) / size);
      this.#sin[index] = -Math.sin((2 * Math.PI * index) / size);
    }
  }
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let index = 0; index < n; index++) {
      const other = this.#reverse[index]!;
      if (other > index) {
        const real = re[index]!;
        const imaginary = im[index]!;
        re[index] = re[other]!;
        im[index] = im[other]!;
        re[other] = real;
        im[other] = imaginary;
      }
    }
    for (let span = 2; span <= n; span *= 2) {
      const half = span / 2;
      const step = n / span;
      for (let start = 0; start < n; start += span) {
        for (let k = 0; k < half; k++) {
          const wr = this.#cos[k * step]!;
          const wi = this.#sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  }
}

interface BandWeight {
  bin: number;
  band: number;
  weight: number;
}

function mel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function hzFromMel(value: number): number {
  return 700 * (10 ** (value / 2595) - 1);
}
const binHz = (bin: number): number => (bin * MUSIC_SAMPLE_RATE) / WINDOW;

/** Triangular mel bands; a band narrower than one bin takes the bin nearest its centre. */
function bandWeights(): { weights: BandWeight[]; centres: number[] } {
  const low = mel(MUSIC_ANALYSIS.lowHz);
  const edges = Array.from({ length: BANDS + 2 }, (_, index) =>
    hzFromMel(low + ((mel(MUSIC_ANALYSIS.highHz) - low) * index) / (BANDS + 1)),
  );
  const weights: BandWeight[] = [];
  for (let band = 0; band < BANDS; band++) {
    const [from, centre, to] = [edges[band]!, edges[band + 1]!, edges[band + 2]!];
    let found = false;
    for (let bin = 1; bin <= HALF; bin++) {
      const hz = binHz(bin);
      const weight = hz <= centre ? (hz - from) / (centre - from) : (to - hz) / (to - centre);
      if (weight > 0) {
        weights.push({ bin, band, weight });
        found = true;
      }
    }
    if (!found) weights.push({ bin: Math.max(1, Math.round((centre * WINDOW) / MUSIC_SAMPLE_RATE)), band, weight: 1 });
  }
  return { weights, centres: edges.slice(1, -1) };
}

/** Per-frame and per-second features of a mono 48 kHz stream, never holding the whole stream. */
export interface MusicFeatures {
  samples: number;
  /** Spectral flux per 10 ms frame. */
  flux: Float32Array;
  /** Mean log level of the kick bands per frame. */
  low: Float32Array;
  /** Pitch-class magnitudes, twelve per frame. */
  chroma: Float32Array;
  /** Per second: mean log level of every band, then the share of each pitch class. */
  blocks: Float32Array[];
  /** dBFS per 100 ms. */
  loudness: number[];
}

export class MusicFeatureExtractor {
  readonly #fft = new Fft(WINDOW);
  readonly #hann = Float64Array.from(
    { length: WINDOW },
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / WINDOW),
  );
  readonly #scale = 2 / this.#hann.reduce((sum, value) => sum + value, 0);
  readonly #weights: BandWeight[];
  readonly #kick: number[];
  readonly #pitch: Int8Array;
  readonly #ring = new Float32Array(RING);
  readonly #re = new Float64Array(WINDOW);
  readonly #im = new Float64Array(WINDOW);
  readonly #power = new Float64Array(BANDS);
  readonly #level = new Float64Array(BANDS);
  readonly #previous = new Float64Array(BANDS);
  readonly #flux: number[] = [];
  readonly #low: number[] = [];
  readonly #chroma: number[] = [];
  readonly #frameChroma = new Float64Array(CHROMA);
  readonly #blocks: Float32Array[] = [];
  readonly #blockLevels = new Float64Array(BANDS);
  readonly #blockChroma = new Float64Array(CHROMA);
  readonly #loudness: number[] = [];
  #blockFrames = 0;
  #received = 0;
  #frame = 0;
  #squares = 0;
  #loudnessSamples = 0;
  constructor() {
    const { weights, centres } = bandWeights();
    this.#weights = weights;
    this.#kick = centres.flatMap((hz, band) => (hz < MUSIC_ANALYSIS.kickHz ? [band] : []));
    this.#pitch = Int8Array.from({ length: HALF + 1 }, (_, bin) => {
      const hz = binHz(bin);
      if (hz < MUSIC_ANALYSIS.chromaHz[0] || hz > MUSIC_ANALYSIS.chromaHz[1]) return -1;
      return ((Math.round(12 * Math.log2(hz / 440)) % CHROMA) + CHROMA) % CHROMA;
    });
  }
  push(mono: Float32Array): void {
    for (const value of mono) {
      this.#ring[this.#received & (RING - 1)] = value;
      this.#received++;
      this.#squares += value * value;
      if (++this.#loudnessSamples === LOUDNESS_SAMPLES) this.#flushLoudness();
      if (this.#frame * HOP + HALF <= this.#received) this.#analyseFrame();
    }
  }
  finish(): MusicFeatures {
    while (this.#frame * HOP < this.#received) this.#analyseFrame();
    if (this.#loudnessSamples > 0) this.#flushLoudness();
    if (this.#blockFrames > 0) this.#flushBlock();
    return {
      samples: this.#received,
      flux: Float32Array.from(this.#flux),
      low: Float32Array.from(this.#low),
      chroma: Float32Array.from(this.#chroma),
      blocks: this.#blocks,
      loudness: this.#loudness,
    };
  }
  #flushLoudness(): void {
    const rms = Math.sqrt(this.#squares / this.#loudnessSamples);
    this.#loudness.push(rms > 0 ? Math.min(0, Math.max(SILENT_DB, 20 * Math.log10(rms))) : SILENT_DB);
    this.#squares = 0;
    this.#loudnessSamples = 0;
  }
  #flushBlock(): void {
    const block = new Float32Array(BANDS + CHROMA);
    for (let band = 0; band < BANDS; band++) block[band] = this.#blockLevels[band]! / this.#blockFrames;
    const chroma = this.#blockChroma.reduce((sum, value) => sum + value, 0);
    if (chroma > 0)
      for (let pitch = 0; pitch < CHROMA; pitch++) block[BANDS + pitch] = this.#blockChroma[pitch]! / chroma;
    this.#blocks.push(block);
    this.#blockLevels.fill(0);
    this.#blockChroma.fill(0);
    this.#blockFrames = 0;
  }
  #analyseFrame(): void {
    const first = this.#frame * HOP - HALF;
    for (let index = 0; index < WINDOW; index++) {
      const position = first + index;
      const value = position >= 0 && position < this.#received ? this.#ring[position & (RING - 1)]! : 0;
      this.#re[index] = value * this.#hann[index]!;
      this.#im[index] = 0;
    }
    this.#fft.transform(this.#re, this.#im);
    this.#power.fill(0);
    for (const { bin, band, weight } of this.#weights)
      this.#power[band] = this.#power[band]! + weight * (this.#re[bin]! ** 2 + this.#im[bin]! ** 2);
    let flux = 0;
    let low = 0;
    for (let band = 0; band < BANDS; band++) {
      const level = Math.log1p(1000 * Math.sqrt(this.#power[band]!) * this.#scale);
      if (this.#frame > 0) flux += Math.max(0, level - this.#previous[band]!);
      this.#previous[band] = level;
      this.#level[band] = level;
      this.#blockLevels[band] = this.#blockLevels[band]! + level;
    }
    for (const band of this.#kick) low += this.#level[band]!;
    this.#frameChroma.fill(0);
    for (let bin = 0; bin <= HALF; bin++) {
      const pitch = this.#pitch[bin]!;
      if (pitch >= 0)
        this.#frameChroma[pitch] = this.#frameChroma[pitch]! + Math.hypot(this.#re[bin]!, this.#im[bin]!) * this.#scale;
    }
    for (let pitch = 0; pitch < CHROMA; pitch++) {
      this.#blockChroma[pitch] = this.#blockChroma[pitch]! + this.#frameChroma[pitch]!;
      this.#chroma.push(this.#frameChroma[pitch]!);
    }
    this.#flux.push(flux);
    this.#low.push(this.#kick.length ? low / this.#kick.length : 0);
    this.#frame++;
    if (++this.#blockFrames === BLOCK_FRAMES) this.#flushBlock();
  }
}

/** Flux with its local mean removed, lightly smoothed, in units of its standard deviation. */
function onsetEnvelope(flux: Float32Array): Float32Array | null {
  const n = flux.length;
  const prefix = new Float64Array(n + 1);
  for (let index = 0; index < n; index++) prefix[index + 1] = prefix[index]! + flux[index]!;
  const raised = new Float64Array(n);
  for (let index = 0; index < n; index++) {
    const from = Math.max(0, index - MUSIC_ANALYSIS.meanFrames);
    const to = Math.min(n, index + MUSIC_ANALYSIS.meanFrames + 1);
    raised[index] = Math.max(0, flux[index]! - (prefix[to]! - prefix[from]!) / (to - from));
  }
  const kernel = [1, 4, 6, 4, 1].map((value) => value / 16);
  const envelope = new Float32Array(n);
  let squares = 0;
  for (let index = 0; index < n; index++) {
    let value = 0;
    for (let tap = -2; tap <= 2; tap++) {
      const position = index + tap;
      if (position >= 0 && position < n) value += kernel[tap + 2]! * raised[position]!;
    }
    envelope[index] = value;
    squares += value * value;
  }
  const deviation = Math.sqrt(squares / Math.max(1, n));
  if (deviation <= 1e-9) return null;
  for (let index = 0; index < n; index++) envelope[index] = envelope[index]! / deviation;
  return envelope;
}

function autocorrelate(envelope: Float32Array, from: number, to: number, into: Float64Array): void {
  for (let lag = LAG_MIN - 1; lag <= LAG_MAX + 1; lag++) {
    let sum = 0;
    for (let index = from; index + lag < to; index++) sum += envelope[index]! * envelope[index + lag]!;
    into[lag] = into[lag]! + sum / (to - from);
  }
}

const octaves = (ratio: number): number => Math.log2(ratio);
const bpmOfLag = (lag: number): number => (FRAME_RATE * 60) / lag;

/** The fastest strong periodicity, weighted by `weight`, as a fractional lag in frames. */
function chooseLag(correlation: Float64Array, weight: (lag: number) => number): number | null {
  const peaks: { lag: number; score: number }[] = [];
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
    const value = correlation[lag]!;
    if (value > 0 && value >= correlation[lag - 1]! && value > correlation[lag + 1]!)
      peaks.push({ lag, score: value * weight(lag) });
  }
  if (!peaks.length) return null;
  const best = Math.max(...peaks.map((peak) => peak.score));
  const { lag } = peaks.find((peak) => peak.score >= MUSIC_ANALYSIS.fastestShare * best)!;
  const [a, b, c] = [correlation[lag - 1]!, correlation[lag]!, correlation[lag + 1]!];
  const curvature = a - 2 * b + c;
  const shift = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature)) : 0;
  return lag + shift;
}

interface Periods {
  confidence: number;
  /** Autocorrelation at the beat period over the envelope's energy: how much of the onsets repeat at the beat. */
  clarity: number;
  /** Beat period in frames at every frame. */
  frames: Float32Array;
  windows: { from: number; to: number }[];
}

function tempoWindows(n: number): { from: number; to: number }[] {
  const { frames: size, step } = MUSIC_ANALYSIS.tempoWindow;
  if (n <= size) return [{ from: 0, to: n }];
  const windows: { from: number; to: number }[] = [];
  for (let from = 0; from + size <= n; from += step) windows.push({ from, to: from + size });
  if (windows.at(-1)!.to < n) windows.push({ from: n - size, to: n });
  return windows;
}

function meanSquare(envelope: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let index = from; index < to; index++) sum += envelope[index]! ** 2;
  return sum / (to - from);
}

/** The window periods at every frame, interpolated between window centres. */
function framePeriods(n: number, windows: { from: number; to: number }[], periods: number[]): Float32Array {
  const centres = windows.map((window) => (window.from + window.to) / 2);
  const frames = new Float32Array(n);
  let window = 0;
  for (let index = 0; index < n; index++) {
    while (window + 1 < centres.length && centres[window + 1]! <= index) window++;
    if (index <= centres[0]! || window + 1 >= centres.length) frames[index] = periods[window]!;
    else {
      const progress = (index - centres[window]!) / (centres[window + 1]! - centres[window]!);
      frames[index] = periods[window]! + progress * (periods[window + 1]! - periods[window]!);
    }
  }
  return frames;
}

function beatPeriods(envelope: Float32Array): Periods | null {
  const windows = tempoWindows(envelope.length);
  const global = new Float64Array(LAG_MAX + 2);
  let energy = 0;
  const local = windows.map((window) => {
    const correlation = new Float64Array(LAG_MAX + 2);
    autocorrelate(envelope, window.from, window.to, correlation);
    for (let lag = 0; lag < correlation.length; lag++) global[lag] = global[lag]! + correlation[lag]!;
    energy += meanSquare(envelope, window.from, window.to);
    return correlation;
  });
  const { bpm, octaves: width } = MUSIC_ANALYSIS.prior;
  const lag = chooseLag(global, (candidate) => Math.exp(-0.5 * (octaves(bpmOfLag(candidate) / bpm) / width) ** 2));
  if (lag === null) return null;
  const values = Array.from({ length: LAG_MAX - LAG_MIN + 1 }, (_, index) => global[LAG_MIN + index]!).sort(
    (a, b) => a - b,
  );
  const peak = global[Math.round(lag)]!;
  const confidence = Math.max(0, Math.min(1, 1 - values[values.length >> 1]! / peak));
  const clarity = energy > 0 ? Math.max(0, Math.min(1, peak / energy)) : 0;
  const spread = MUSIC_ANALYSIS.tempoWindow.octaves;
  const atLag = (correlation: Float64Array, candidate: number): number =>
    Math.max(correlation[Math.floor(candidate)]!, correlation[Math.ceil(candidate)]!);
  const lags = local.map((correlation) => {
    const own = chooseLag(correlation, (candidate) => Math.exp(-0.5 * (octaves(candidate / lag) / spread) ** 2));
    // A window keeps the global tempo unless it clearly lacks it: weak passages follow noise otherwise.
    if (own === null || atLag(correlation, lag) >= MUSIC_ANALYSIS.tempoWindow.change * atLag(correlation, own))
      return lag;
    return own;
  });
  const smoothed = lags.map((_, index) => {
    const around = lags.slice(Math.max(0, index - 1), index + 2).sort((a, b) => a - b);
    return around[around.length >> 1]!;
  });
  return { confidence, clarity, frames: framePeriods(envelope.length, windows, smoothed), windows };
}

/** Dynamic-programming beat tracking (Ellis 2007) at the local period. */
function trackBeats(envelope: Float32Array, periods: Float32Array): number[] {
  const n = envelope.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let index = 0; index < n; index++) {
    const period = periods[index]!;
    let best = -Infinity;
    let from = -1;
    const last = index - Math.round(period / 2);
    for (let previous = Math.max(0, index - Math.round(2 * period)); previous <= last; previous++) {
      const value = score[previous]! - MUSIC_ANALYSIS.tightness * Math.log((index - previous) / period) ** 2;
      if (value > best) {
        best = value;
        from = previous;
      }
    }
    if (from >= 0 && best > 0) {
      score[index] = envelope[index]! + best;
      back[index] = from;
    } else score[index] = envelope[index]!;
  }
  let end = Math.max(0, n - Math.round(2 * periods[n - 1]!));
  for (let index = end; index < n; index++) if (score[index]! > score[end]!) end = index;
  const beats: number[] = [];
  for (let index = end; index >= 0; index = back[index]!) beats.push(index);
  return beats.reverse();
}

function percentile(values: ArrayLike<number>, share: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]! : 0;
}

/** The strongest onset within ±20 ms, at sub-frame precision. */
function refine(envelope: Float32Array, frame: number): { position: number; peak: number } {
  let peak = frame;
  const reach = MUSIC_ANALYSIS.refineFrames;
  for (let index = Math.max(0, frame - reach); index <= Math.min(envelope.length - 1, frame + reach); index++)
    if (envelope[index]! > envelope[peak]!) peak = index;
  const [a, b, c] = [envelope[peak - 1] ?? 0, envelope[peak]!, envelope[peak + 1] ?? 0];
  const curvature = a - 2 * b + c;
  const shift = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature)) : 0;
  return { position: peak + shift, peak };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

interface TrackedBeat {
  sample: number;
  frame: number;
  onset: number;
}

function placeBeats(envelope: Float32Array, frames: number[], samples: number): TrackedBeat[] {
  const refined = frames.map((frame) => {
    const { position, peak } = refine(envelope, frame);
    return {
      sample: Math.max(0, Math.min(samples - 1, Math.round(position * HOP + MUSIC_ANALYSIS.onsetLead))),
      frame: peak,
      onset: envelope[peak]!,
    };
  });
  const rms = Math.sqrt(refined.reduce((sum, beat) => sum + beat.onset ** 2, 0) / Math.max(1, refined.length));
  const strong = (beat: TrackedBeat): boolean => beat.onset >= MUSIC_ANALYSIS.trimShare * rms;
  const first = refined.findIndex(strong);
  let last = refined.length - 1;
  while (last >= 0 && !strong(refined[last]!)) last--;
  const kept: TrackedBeat[] = [];
  for (const beat of first < 0 ? [] : refined.slice(first, last + 1))
    if (!kept.length || beat.sample > kept.at(-1)!.sample) kept.push(beat);
  return kept;
}

function tempoCurve(beats: TrackedBeat[], windows: Periods['windows']): { fromSample: number; bpm: number }[] {
  const curve: { fromSample: number; bpm: number }[] = [];
  for (const window of windows) {
    const inside = beats.filter((beat) => beat.frame >= window.from && beat.frame < window.to);
    if (inside.length < 3) continue;
    const bpm =
      (60 * MUSIC_SAMPLE_RATE) / median(inside.slice(1).map((beat, index) => beat.sample - inside[index]!.sample));
    const previous = curve.at(-1);
    if (!previous || Math.abs(bpm / previous.bpm - 1) > 0.02)
      curve.push({ fromSample: curve.length ? window.from * HOP : 0, bpm });
  }
  return curve;
}

/** Each value in units of the values' standard deviation from their mean. */
function standardScores(values: number[]): number[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return values.map((value) => (deviation > 1e-9 ? (value - mean) / deviation : 0));
}

/** How much the chords change at each beat: chroma over the beats before it against those after it. */
function harmonicChange(beats: TrackedBeat[], chroma: Float32Array): number[] {
  const frames = chroma.length / CHROMA;
  const reach = MUSIC_ANALYSIS.downbeat.harmonyBeats;
  const profile = (from: number, to: number): Float64Array => {
    const sum = new Float64Array(CHROMA);
    for (let frame = Math.max(0, from); frame < Math.min(frames, to); frame++)
      for (let pitch = 0; pitch < CHROMA; pitch++) sum[pitch] = sum[pitch]! + chroma[frame * CHROMA + pitch]!;
    const length = Math.hypot(...sum);
    return length > 0 ? sum.map((value) => value / length) : sum;
  };
  return beats.map((beat, index) => {
    const before = beats[Math.max(0, index - reach)]!.frame;
    const after = beats[Math.min(beats.length - 1, index + reach)]!.frame;
    if (before === beat.frame || after === beat.frame) return 0;
    return 1 - dot(profile(before, beat.frame), profile(beat.frame, after));
  });
}

/**
 * Bar positions by dynamic programming over the beats: each beat advances the bar by one, or the
 * bar restarts anywhere at a cost, so a dropped or added beat does not shift every later downbeat.
 */
function barPositions(salience: number[], beatsPerBar: number): { downbeats: boolean[]; score: number } {
  const jump = MUSIC_ANALYSIS.downbeat.jump;
  const emit = (value: number, position: number): number => (position === 0 ? value : -value / (beatsPerBar - 1));
  let scores = Array.from({ length: beatsPerBar }, (_, position) => emit(salience[0]!, position));
  const back: Int8Array[] = [];
  for (let index = 1; index < salience.length; index++) {
    const best = scores.indexOf(Math.max(...scores));
    const from = new Int8Array(beatsPerBar);
    scores = scores.map((_, position) => {
      const previous = (position + beatsPerBar - 1) % beatsPerBar;
      const restart = scores[best]! - jump > scores[previous]!;
      from[position] = restart ? best : previous;
      return (restart ? scores[best]! - jump : scores[previous]!) + emit(salience[index]!, position);
    });
    back.push(from);
  }
  let position = scores.indexOf(Math.max(...scores));
  const score = scores[position]!;
  const downbeats = new Array<boolean>(salience.length).fill(false);
  for (let index = salience.length - 1; index >= 0; index--) {
    downbeats[index] = position === 0;
    if (index > 0) position = back[index - 1]![position]!;
  }
  return { downbeats, score };
}

function downbeats(
  beats: TrackedBeat[],
  features: MusicFeatures,
): { meter: MusicMeasurement['meter']; downbeats: boolean[] } {
  const { onset, low, harmony } = MUSIC_ANALYSIS.downbeat.weights;
  const parts = [
    standardScores(beats.map((beat) => beat.onset)),
    standardScores(beats.map((beat) => features.low[beat.frame]!)),
    standardScores(harmonicChange(beats, features.chroma)),
  ];
  const salience = beats.map(
    (_, index) => onset * parts[0]![index]! + low * parts[1]![index]! + harmony * parts[2]![index]!,
  );
  const candidates = ([4, 3] as const).flatMap((beatsPerBar) => {
    if (beats.length < 2 * beatsPerBar) return [];
    const { downbeats: marked, score } = barPositions(salience, beatsPerBar);
    // Effect size: downbeats' mean salience against the other beats', in standard deviations.
    const on = salience.filter((_, index) => marked[index]);
    const off = salience.filter((_, index) => !marked[index]);
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = Math.sqrt(mean(salience.map((value) => value ** 2)) - mean(salience) ** 2) || 1;
    return [{ beatsPerBar, marked, score, contrast: on.length && off.length ? (mean(on) - mean(off)) / spread : 0 }];
  });
  if (!candidates.length) return { meter: null, downbeats: beats.map(() => false) };
  const [four, three] = candidates;
  const chosen = three && three.score > MUSIC_ANALYSIS.downbeat.threeOverFour * four!.score ? three : four!;
  const confidence = Math.max(0, Math.min(1, chosen.contrast / MUSIC_ANALYSIS.downbeat.sureContrast));
  return {
    meter: { beatsPerBar: chosen.beatsPerBar, confidence },
    downbeats: chosen.marked,
  };
}

function accents(envelope: Float32Array, samples: number): MusicMeasurement['accents'] {
  const threshold = percentile(envelope, MUSIC_ANALYSIS.accentPercentile);
  const reach = MUSIC_ANALYSIS.accentFrames;
  const top = percentile(envelope, 0.999) || 1;
  const peaks: number[] = [];
  for (let index = 1; index + 1 < envelope.length; index++) {
    const value = envelope[index]!;
    if (value > threshold && value >= envelope[index - 1]! && value > envelope[index + 1]!) peaks.push(index);
  }
  peaks.sort((a, b) => envelope[b]! - envelope[a]! || a - b);
  const taken: number[] = [];
  for (const peak of peaks) if (taken.every((other) => Math.abs(other - peak) >= reach)) taken.push(peak);
  taken.sort((a, b) => a - b);
  return taken.map((frame) => ({
    sample: Math.max(
      0,
      Math.min(samples - 1, Math.round(refine(envelope, frame).position * HOP + MUSIC_ANALYSIS.onsetLead)),
    ),
    strength: Math.round(Math.min(1, envelope[frame]! / top) * 1000) / 1000,
  }));
}

/** Energy-averaged dB of loudness values (100 ms each). */
function meanDb(values: number[]): number {
  if (!values.length) return SILENT_DB;
  const power = values.reduce((sum, value) => sum + 10 ** (value / 10), 0) / values.length;
  return Math.max(SILENT_DB, 10 * Math.log10(power));
}

/** Each per-second feature standardised over the song, then each block scaled to unit length. */
function standardise(blocks: Float32Array[]): Float64Array[] {
  const count = blocks.length;
  const size = blocks[0]!.length;
  const mean = new Float64Array(size);
  const deviation = new Float64Array(size);
  for (const block of blocks)
    for (let index = 0; index < size; index++) mean[index] = mean[index]! + block[index]! / count;
  for (const block of blocks)
    for (let index = 0; index < size; index++)
      deviation[index] = deviation[index]! + (block[index]! - mean[index]!) ** 2 / count;
  return blocks.map((block) => {
    const vector = Float64Array.from(block, (value, index) => {
      const spread = Math.sqrt(deviation[index]!);
      return spread > 1e-9 ? (value - mean[index]!) / spread : 0;
    });
    const length = Math.hypot(...vector);
    return length > 0 ? vector.map((value) => value / length) : vector;
  });
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += a[index]! * b[index]!;
  return sum;
}

/** Foote's checkerboard novelty over the self-similarity of the blocks, from −1 to 1. */
function novelty(vectors: Float64Array[], reach: number): Float64Array {
  const taper = Array.from({ length: 2 * reach }, (_, index) =>
    Math.exp(-0.5 * ((index - reach + 0.5) / (reach / 2)) ** 2),
  );
  // Same-side pairs count as similar, cross pairs as different; a block is not compared with itself.
  const kernel = (a: number, b: number): number => {
    if (a === b) return 0;
    const sign = a < 0 === b < 0 ? 1 : -1;
    return sign * taper[a + reach]! * taper[b + reach]!;
  };
  const count = vectors.length;
  const curve = new Float64Array(count);
  for (let centre = 1; centre < count; centre++) {
    const from = Math.max(-reach, -centre);
    const to = Math.min(reach, count - centre);
    let sum = 0;
    let weight = 0;
    for (let a = from; a < to; a++) {
      for (let b = from; b < to; b++) {
        const value = kernel(a, b);
        sum += value && value * dot(vectors[centre + a]!, vectors[centre + b]!);
        weight += Math.abs(value);
      }
    }
    curve[centre] = weight > 0 ? sum / weight : 0;
  }
  return curve;
}

function sectionBoundaries(blocks: Float32Array[]): number[] {
  const reach = MUSIC_ANALYSIS.sectionBlocks;
  if (blocks.length < 2 * reach) return [];
  const curve = novelty(standardise(blocks), reach);
  const peaks: number[] = [];
  for (let centre = reach; centre <= blocks.length - reach; centre++) {
    const value = curve[centre]!;
    if (value >= MUSIC_ANALYSIS.sectionNovelty && value >= curve[centre - 1]! && value >= (curve[centre + 1] ?? 0))
      peaks.push(centre);
  }
  peaks.sort((a, b) => curve[b]! - curve[a]! || a - b);
  const chosen: number[] = [];
  for (const peak of peaks) if (chosen.every((other) => Math.abs(other - peak) >= reach)) chosen.push(peak);
  return chosen.sort((a, b) => a - b);
}

function sections(features: MusicFeatures, anchors: number[]): MusicMeasurement['sections'] {
  if (features.samples === 0) return [];
  const reach = MUSIC_ANALYSIS.sectionSnapSeconds * MUSIC_SAMPLE_RATE;
  // A boundary moves to the nearest downbeat within reach, so a cut there lands on the bar.
  const snapped = sectionBoundaries(features.blocks).map((block) => {
    const sample = block * MUSIC_SAMPLE_RATE;
    let nearest: number | null = null;
    for (const anchor of anchors)
      if (
        Math.abs(anchor - sample) <= reach &&
        (nearest === null || Math.abs(anchor - sample) < Math.abs(nearest - sample))
      )
        nearest = anchor;
    return nearest ?? sample;
  });
  const inside = snapped.filter(
    (sample, index) => sample > 0 && sample < features.samples && sample > (snapped[index - 1] ?? 0),
  );
  const edges = [0, ...inside, features.samples];
  const parts = edges.slice(1).map((toSample, index) => {
    const fromSample = edges[index]!;
    const values = features.loudness.slice(
      Math.floor(fromSample / LOUDNESS_SAMPLES),
      Math.ceil(toSample / LOUDNESS_SAMPLES),
    );
    // Least-squares slope of loudness over the section, as its change from start to end.
    const centre = (values.length - 1) / 2;
    const level = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, _, index) => sum + (index - centre) ** 2, 0);
    const slope =
      variance > 0 ? values.reduce((sum, value, index) => sum + (index - centre) * (value - level), 0) / variance : 0;
    return { fromSample, toSample, loudnessDb: meanDb(values), change: slope * (values.length - 1) };
  });
  const levels = parts.map((part) => part.loudnessDb);
  // A single section is quiet only when it is nearly silent.
  const middle = parts.length > 1 ? (Math.max(...levels) + Math.min(...levels)) / 2 : -50;
  const [quiet, build, peak, release] = sectionKinds;
  return parts.map(({ change, ...part }) => {
    let kind: (typeof sectionKinds)[number] = part.loudnessDb < middle ? quiet : peak;
    if (change >= MUSIC_ANALYSIS.sectionSlopeDb) kind = build;
    else if (change <= -MUSIC_ANALYSIS.sectionSlopeDb) kind = release;
    return { ...part, kind, loudnessDb: Math.round(part.loudnessDb * 10) / 10 };
  });
}

/** Tempo, beats, downbeats, accents and sections from the features. Deterministic. */
export function analyseFeatures(features: MusicFeatures): MusicMeasurement {
  const envelope = onsetEnvelope(features.flux);
  const base = {
    sampleRate: MUSIC_SAMPLE_RATE,
    hop: HOP,
    samples: features.samples,
    accents: envelope ? accents(envelope, features.samples) : [],
    loudness: features.loudness.map((value) => Math.round(value * 10) / 10),
  } as const;
  const periods = envelope && beatPeriods(envelope);
  const tracked =
    envelope && periods ? placeBeats(envelope, trackBeats(envelope, periods.frames), features.samples) : [];
  // A few isolated hits, or a pulse too weak to tap along to, are not a beat.
  if (
    !envelope ||
    !periods ||
    tracked.length < MUSIC_ANALYSIS.minimumBeats ||
    periods.confidence < MUSIC_ANALYSIS.minimumConfidence ||
    periods.clarity < MUSIC_ANALYSIS.minimumClarity
  )
    return { ...base, sections: sections(features, []), tempo: null, meter: null, beats: [] };
  const top = percentile(envelope, 0.999) || 1;
  const bar = downbeats(tracked, features);
  const intervals = tracked.slice(1).map((beat, index) => beat.sample - tracked[index]!.sample);
  const bpm = (60 * MUSIC_SAMPLE_RATE) / median(intervals);
  const curve = tempoCurve(tracked, periods.windows);
  return {
    ...base,
    sections: sections(
      features,
      tracked.flatMap((beat, index) => (bar.downbeats[index] ? [beat.sample] : [])),
    ),
    tempo: {
      bpm: Math.round(bpm * 100) / 100,
      confidence: Math.round(periods.confidence * 100) / 100,
      curve: (curve.length ? curve : [{ fromSample: 0, bpm }]).map((point) => ({
        ...point,
        bpm: Math.round(point.bpm * 100) / 100,
      })),
    },
    meter: bar.meter,
    beats: tracked.map((beat, index) => ({
      sample: beat.sample,
      strength: Math.round(Math.min(1, beat.onset / top) * 1000) / 1000,
      downbeat: bar.downbeats[index]!,
    })),
  };
}

const READ_BYTES = 1_048_576;

/** Streams the stereo PCM16 cache in 1 MiB blocks as a float mono mix; never reads it whole. */
export async function analyseMusicFile(
  filename: string,
  onProgress: (fraction: number) => void = () => {},
): Promise<MusicMeasurement> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await file.stat();
    if (size === 0 || size % MUSIC_BYTES_PER_SAMPLE !== 0)
      throw new Error('The music cache must hold complete stereo PCM16 sample frames.');
    const extractor = new MusicFeatureExtractor();
    const buffer = Buffer.alloc(READ_BYTES);
    const mono = new Float32Array(READ_BYTES / MUSIC_BYTES_PER_SAMPLE);
    let position = 0;
    let filled = 0;
    await whileSerial(
      () => position < size,
      async () => {
        const { bytesRead } = await file.read(buffer, filled, Math.min(READ_BYTES - filled, size - position), position);
        if (bytesRead === 0) throw new Error('The music cache ended early.');
        position += bytesRead;
        filled += bytesRead;
        if (filled < READ_BYTES && position < size) return;
        const frames = filled / MUSIC_BYTES_PER_SAMPLE;
        for (let index = 0; index < frames; index++)
          mono[index] = (buffer.readInt16LE(index * 4) + buffer.readInt16LE(index * 4 + 2)) / 65_536;
        extractor.push(mono.subarray(0, frames));
        filled = 0;
        onProgress((0.9 * position) / size);
      },
    );
    const measurement = analyseFeatures(extractor.finish());
    onProgress(1);
    return measurement;
  } finally {
    await file.close();
  }
}

export type MusicWorkerReply = { progress: number } | { measurement: MusicMeasurement } | { error: string };

/** Analyses the PCM cache on one worker thread, keeping the service responsive; abort terminates it. */
export function measureMusic(
  filename: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<MusicMeasurement> {
  // Source checkouts (tsx/Vitest) load the TypeScript worker; builds load the compiled file.
  const source = import.meta.url.endsWith('.ts');
  const entry = new URL(`./music-analysis-worker.${source ? 'ts' : 'js'}`, import.meta.url);
  const worker = new Worker(entry, source ? { execArgv: ['--import', 'tsx'] } : {});
  return new Promise<MusicMeasurement>((resolve, reject) => {
    const abort = (): void => reject(new ServiceError('Job cancelled.', 499));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (reply: MusicWorkerReply) => {
      if ('progress' in reply) onProgress(reply.progress);
      else if ('measurement' in reply) resolve(reply.measurement);
      else reject(new ServiceError(`Music analysis failed: ${reply.error}`, 422));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => reject(new Error(`The music analysis worker exited with code ${code}.`)));
    worker.postMessage(filename);
  }).finally(() => worker.terminate());
}
