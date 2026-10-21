import { median } from './white-balance.js';

/**
 * Detail estimate (#240): starting values, set on synthetic noise and blur; see docs/design/DETAIL_FILTERS.md.
 * Measured on proxy luma at its 720-line size, the scale whose units the detail filters use.
 */
export const DETAIL_ESTIMATE = Object.freeze({
  /** Source frames measured, at the centres of equal slices of the range. */
  frames: 8,
  /** Side of the square blocks noise is measured in, pixels. */
  block: 16,
  /** Noise is this quantile of the blocks' estimates: the flattest areas, where texture adds nothing. */
  noiseQuantile: 0.1,
  /** Blocks whose mean luma is below or above these are clipped (or letterbox) and show no noise. */
  clippedBelow: 0.02,
  clippedAbove: 0.98,
  /** Taps of the box blur the blur measure compares the picture with. */
  blurTaps: 9,
  /** Neighbour differences, 0–1 luma, below which a position is not an edge, at least this... */
  edgeStep: 4 / 255,
  /** ...and at least this many noise standard deviations of a difference (√2 of the noise's). */
  edgeNoise: 4 * Math.SQRT2,
  /** Share of the positions that must be edges to judge sharpness. */
  edgeShare: 0.001,
  /** Noise (standard deviation, 0–1 luma) below which nothing is suggested: about one 8-bit code. */
  noiseFloor: 0.003,
  denoisePerNoise: 25,
  denoiseMax: 0.5,
  /** Blur measure (0–1) up to which edges count as sharp: edges about 3 pixels wide at 720 lines. */
  sharpBlur: 0.3,
  sharpenPerBlur: 2,
  sharpenMax: 0.6,
});

/** Full-range luma bytes of a proxy frame, rows top to bottom. */
export interface LumaFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface DetailMeasure {
  /** Standard deviation of the noise in flat areas, 0–1 luma; null when no area is flat and unclipped. */
  noise: number | null;
  /** 0 (crisp) – 1 (very soft): how little a 9-tap blur changes the picture's edges; null on uniform frames. */
  blur: number | null;
}

export interface DetailSuggestion {
  sharpen: number;
  clarity: number;
  denoise: number;
}

/** Source frames measured: the centres of up to DETAIL_ESTIMATE.frames equal slices of [sourceIn, sourceOut). */
export function detailFrames(sourceIn: number, sourceOut: number): number[] {
  const length = sourceOut - sourceIn;
  const count = Math.min(DETAIL_ESTIMATE.frames, length);
  return Array.from({ length: count }, (_, index) => sourceIn + Math.floor(((index + 0.5) * length) / count));
}

function quantile(values: number[], share: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(share * (sorted.length - 1))]!;
}

/**
 * Immerkær's fast noise estimate per block (a Laplacian difference cancels smooth gradients), then a low
 * quantile over the blocks, so texture and edges do not count as noise.
 */
export function frameNoise({ width, height, data }: LumaFrame): number | null {
  const side = DETAIL_ESTIMATE.block;
  const estimates: number[] = [];
  for (let top = 1; top + side < height; top += side)
    for (let left = 1; left + side < width; left += side) {
      let sum = 0;
      let laplacian = 0;
      for (let y = top; y < top + side; y++)
        for (let x = left; x < left + side; x++) {
          const at = y * width + x;
          sum += data[at]!;
          laplacian += Math.abs(
            data[at - width - 1]! -
              2 * data[at - width]! +
              data[at - width + 1]! -
              2 * data[at - 1]! +
              4 * data[at]! -
              2 * data[at + 1]! +
              data[at + width - 1]! -
              2 * data[at + width]! +
              data[at + width + 1]!,
          );
        }
      const mean = sum / (side * side * 255);
      if (mean < DETAIL_ESTIMATE.clippedBelow || mean > DETAIL_ESTIMATE.clippedAbove) continue;
      estimates.push((Math.sqrt(Math.PI / 2) * laplacian) / (6 * side * side * 255));
    }
  return estimates.length ? quantile(estimates, DETAIL_ESTIMATE.noiseQuantile) : null;
}

/**
 * Adds to `sums` the neighbour differences of `line` at edges (above `step`) and the part of each a box blur
 * keeps (the smaller of the two differences), and counts those edges.
 */
function lineVariation(line: Float64Array, step: number, sums: [number, number, number]): void {
  const radius = (DETAIL_ESTIMATE.blurTaps - 1) / 2;
  let window = 0;
  for (let index = 0; index < DETAIL_ESTIMATE.blurTaps; index++) window += line[index]!;
  let previous = window / DETAIL_ESTIMATE.blurTaps;
  for (let centre = radius + 1; centre + radius < line.length; centre++) {
    window += line[centre + radius]! - line[centre - radius - 1]!;
    const blurred = window / DETAIL_ESTIMATE.blurTaps;
    const original = Math.abs(line[centre]! - line[centre - 1]!);
    if (original > step) {
      sums[0] += original;
      sums[1] += Math.min(original, Math.abs(blurred - previous));
      sums[2]++;
    }
    previous = blurred;
  }
}

/**
 * Crété-Roffet et al.'s no-reference blur measure: the share of the picture's neighbour differences a 9-tap
 * blur keeps, horizontally and vertically, the larger of the two. A crisp step scores about 0.1; edges w pixels
 * wide about w / (w + 8). Only edges standing out of the `noise` count, so noise does not pass for detail.
 */
export function frameBlur({ width, height, data }: LumaFrame, noise: number | null): number | null {
  if (width <= DETAIL_ESTIMATE.blurTaps || height <= DETAIL_ESTIMATE.blurTaps) return null;
  const step = Math.max(DETAIL_ESTIMATE.edgeStep, DETAIL_ESTIMATE.edgeNoise * (noise ?? 0));
  const scores: number[] = [];
  for (const [lines, length, at] of [
    [height, width, (line: number, index: number) => line * width + index],
    [width, height, (line: number, index: number) => index * width + line],
  ] as const) {
    const sums: [number, number, number] = [0, 0, 0];
    const values = new Float64Array(length);
    for (let line = 0; line < lines; line++) {
      for (let index = 0; index < length; index++) values[index] = data[at(line, index)]! / 255;
      lineVariation(values, step, sums);
    }
    if (sums[2] < DETAIL_ESTIMATE.edgeShare * lines * (length - DETAIL_ESTIMATE.blurTaps)) return null;
    scores.push(sums[1] / sums[0]);
  }
  return Math.max(...scores);
}

/** Noise and blur of each frame, the median over the frames that have them. */
export function measureDetail(frames: readonly LumaFrame[]): DetailMeasure {
  const pooled = (values: (number | null)[]): number | null => {
    const usable = values.filter((value): value is number => value !== null);
    return usable.length ? Math.round(median(usable) * 10_000) / 10_000 : null;
  };
  const noise = frames.map(frameNoise);
  return { noise: pooled(noise), blur: pooled(frames.map((frame, index) => frameBlur(frame, noise[index]!))) };
}

const rounded = (value: number): number => Math.round(value * 100) / 100;

/**
 * Detail filters for the measurements: Denoise for visible noise, Sharpen for soft edges. Clarity is a look,
 * not a correction, so it is never suggested.
 */
export function suggestDetail({ noise, blur }: DetailMeasure): DetailSuggestion {
  const denoise =
    noise === null
      ? 0
      : Math.min(
          DETAIL_ESTIMATE.denoiseMax,
          DETAIL_ESTIMATE.denoisePerNoise * Math.max(0, noise - DETAIL_ESTIMATE.noiseFloor),
        );
  const sharpen =
    blur === null
      ? 0
      : Math.min(
          DETAIL_ESTIMATE.sharpenMax,
          DETAIL_ESTIMATE.sharpenPerBlur * Math.max(0, blur - DETAIL_ESTIMATE.sharpBlur),
        );
  return { sharpen: rounded(sharpen), clarity: 0, denoise: rounded(denoise) };
}
