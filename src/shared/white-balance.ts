import { decode709 } from './colour.js';

/** Automatic white balance (#218): starting values, tuned on real footage. */
export const WHITE_BALANCE = Object.freeze({
  /** Minkowski norm of Shades of Grey (Finlayson & Trezzi) and 1st-order Grey-Edge (van de Weijer et al.). */
  norm: 6,
  /** A pixel with any channel at or above this code is clipped: it and its 3×3 neighbourhood are ignored. */
  clippedCode: 250,
  /** Pixels darker than this linear luma are too noisy to carry colour. */
  noisyLuma: 0.002,
  /** Full rows and columns at the edges no brighter than this code are letterbox. */
  letterboxCode: 16,
  /** A frame needs this many usable pixels and edge samples for an estimate. */
  minimumSamples: 256,
  /** Angle in degrees between the two estimates at which confidence reaches zero. */
  disagreementDegrees: 8,
  /** Above this robust spread of per-frame Temperature the light changes within the window: confidence halves. */
  unstableTemperature: 0.25,
  /** Share of a cool cast removed (the correction warms)… */
  coolStrength: 0.85,
  /** …and of a warm one: warm light such as a sunset is only partly neutralised. */
  warmStrength: 0.6,
  /** Share of a green or magenta cast removed. */
  tintStrength: 0.8,
  /** Soft limits m·tanh(x / m) of the captured values. */
  temperatureLimit: 0.5,
  tintLimit: 0.3,
});

/** Frames analysed: the playhead and up to `radius` project frames (1 s) on each side, within its clip; shared with Auto adjust. */
export const WHITE_BALANCE_WINDOW = Object.freeze({ frames: 16, radius: 30 });

/** Encoded BT.709 RGBA bytes, rows top to bottom, as read back from a canvas. */
export interface AnalysisFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** One frame's light: the Temperature and Tint that neutralise it exactly, and how far to trust them. */
export interface IlluminantEstimate {
  temperature: number;
  tint: number;
  /** 0–1: agreement between Shades of Grey and Grey-Edge. */
  confidence: number;
}

export interface WhiteBalance {
  temperature: number;
  tint: number;
}

type Triple = [number, number, number];
interface Plane {
  width: number;
  height: number;
  /** Linear R, G and B planes. */
  channels: [Float64Array, Float64Array, Float64Array];
  /** Clipped (and their neighbours) or noisy pixels. */
  excluded: Uint8Array;
}

/** Linear BT.709 light of each 8-bit code. */
export const LINEAR_CODES = Float64Array.from({ length: 256 }, (_, code) => decode709(code / 255));
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

export interface ContentBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Rows and columns at the edges whose brightest code is letterbox-dark are dropped. */
export function contentBox({ width, height, data }: AnalysisFrame): ContentBox | null {
  const rows = new Uint8Array(height);
  const columns = new Uint8Array(width);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const brightest = Math.max(data[index]!, data[index + 1]!, data[index + 2]!);
      rows[y] = Math.max(rows[y]!, brightest);
      columns[x] = Math.max(columns[x]!, brightest);
    }
  const lit = (values: Uint8Array): number[] =>
    [...values.keys()].filter((index) => values[index]! > WHITE_BALANCE.letterboxCode);
  const litRows = lit(rows);
  const litColumns = lit(columns);
  if (!litRows.length || !litColumns.length) return null;
  return { left: litColumns[0]!, right: litColumns.at(-1)!, top: litRows[0]!, bottom: litRows.at(-1)! };
}

function dilateLine(
  mask: Uint8Array,
  result: Uint8Array,
  line: { start: number; step: number; length: number },
  radius: number,
): void {
  const { start, step, length } = line;
  for (let position = 0; position < length; position++) {
    if (!mask[start + position * step]) continue;
    const last = Math.min(length - 1, position + radius);
    for (let near = Math.max(0, position - radius); near <= last; near++) result[start + near * step] = 1;
  }
}

/** Marks every pixel within `radius` (a square) of a marked one. */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) dilateLine(mask, rows, { start: y * width, step: 1, length: width }, radius);
  const result = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) dilateLine(rows, result, { start: x, step: width, length: height }, radius);
  return result;
}

function linearPlane(frame: AnalysisFrame): Plane | null {
  const box = contentBox(frame);
  if (!box) return null;
  const width = box.right - box.left + 1;
  const height = box.bottom - box.top + 1;
  const channels: Plane['channels'] = [
    new Float64Array(width * height),
    new Float64Array(width * height),
    new Float64Array(width * height),
  ];
  const clipped = new Uint8Array(width * height);
  const noisy = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const source = ((box.top + y) * frame.width + box.left + x) * 4;
      const target = y * width + x;
      let luma = 0;
      for (let channel = 0; channel < 3; channel++) {
        const code = frame.data[source + channel]!;
        const value = LINEAR_CODES[code]!;
        channels[channel]![target] = value;
        luma += LUMA[channel]! * value;
        if (code >= WHITE_BALANCE.clippedCode) clipped[target] = 1;
      }
      if (luma < WHITE_BALANCE.noisyLuma) noisy[target] = 1;
    }
  const excluded = dilate(clipped, width, height, 1);
  for (let index = 0; index < excluded.length; index++) excluded[index]! |= noisy[index]!;
  return { width, height, channels, excluded };
}

/** (mean xᵖ)^(1/p) per channel, null below the minimum sample count. */
function minkowski(sums: Triple, count: number): Triple | null {
  if (count < WHITE_BALANCE.minimumSamples) return null;
  const estimate = sums.map((sum) => (sum / count) ** (1 / WHITE_BALANCE.norm)) as Triple;
  return estimate.every((value) => value > 1e-9) ? estimate : null;
}

/** Shades of Grey: the Minkowski mean of usable linear pixels. */
function shadesOfGrey({ channels, excluded }: Plane): Triple | null {
  const sums: Triple = [0, 0, 0];
  let count = 0;
  for (let index = 0; index < excluded.length; index++) {
    if (excluded[index]) continue;
    count++;
    for (let channel = 0; channel < 3; channel++) sums[channel]! += channels[channel]![index]! ** WHITE_BALANCE.norm;
  }
  return minkowski(sums, count);
}

/** A 3×3 binomial blur (σ ≈ 1), borders repeated. */
function blur(values: Float64Array, width: number, height: number): Float64Array {
  const at = (x: number, y: number): number =>
    values[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;
  const rows = new Float64Array(values.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows[y * width + x] = (at(x - 1, y) + 2 * at(x, y) + at(x + 1, y)) / 4;
  const result = new Float64Array(values.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const above = rows[Math.max(0, y - 1) * width + x]!;
      const below = rows[Math.min(height - 1, y + 1) * width + x]!;
      result[y * width + x] = (above + 2 * rows[y * width + x]! + below) / 4;
    }
  return result;
}

/** 1st-order Grey-Edge: the Minkowski mean of blurred gradient magnitudes, away from excluded pixels. */
function greyEdge({ width, height, channels, excluded }: Plane): Triple | null {
  // The blur and central differences reach two pixels: no excluded pixel may lie within them.
  const nearExcluded = dilate(excluded, width, height, 2);
  const blurred = channels.map((values) => blur(values, width, height));
  const sums: Triple = [0, 0, 0];
  let count = 0;
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      const index = y * width + x;
      if (nearExcluded[index]) continue;
      count++;
      for (let channel = 0; channel < 3; channel++) {
        const plane = blurred[channel]!;
        const dx = (plane[index + 1]! - plane[index - 1]!) / 2;
        const dy = (plane[index + width]! - plane[index - width]!) / 2;
        sums[channel]! += (dx * dx + dy * dy) ** (WHITE_BALANCE.norm / 2);
      }
    }
  return minkowski(sums, count);
}

function angleDegrees(left: Triple, right: Triple): number {
  const dot = left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  const length = Math.hypot(...left) * Math.hypot(...right);
  return (Math.acos(Math.min(1, Math.max(-1, dot / length))) * 180) / Math.PI;
}

/**
 * Temperature and Tint whose gains are proportional to 1 / illuminant: q_R / q_B = 2^T and
 * q_R·q_B / q_G² = 2^I (see temperatureTintGains), so T = log2(e_B / e_R) and I = log2(e_G² / (e_R·e_B)).
 */
export function neutralisingWhiteBalance(illuminant: readonly [number, number, number]): WhiteBalance {
  const [red, green, blue] = illuminant;
  return { temperature: Math.log2(blue / red), tint: Math.log2((green * green) / (red * blue)) };
}

/**
 * One frame's light from its usable pixels: the geometric mean of Shades of Grey and Grey-Edge, trusted
 * as far as they agree. Grey-Edge ignores large uniform areas such as sky, sea or grass. Null when the
 * frame has too few usable pixels or edges (black, clipped or uniform).
 */
export function frameIlluminant(frame: AnalysisFrame): IlluminantEstimate | null {
  const { width, height, data } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error('An analysis frame needs a positive integer size.');
  if (data.length !== width * height * 4) throw new Error('An analysis frame needs width × height RGBA bytes.');
  const plane = linearPlane(frame);
  if (!plane) return null;
  const grey = shadesOfGrey(plane);
  const edges = greyEdge(plane);
  if (!grey || !edges) return null;
  const illuminant = grey.map((value, channel) => Math.sqrt(value * edges[channel]!)) as Triple;
  const confidence = 1 - Math.min(1, angleDegrees(grey, edges) / WHITE_BALANCE.disagreementDegrees);
  return { ...neutralisingWhiteBalance(illuminant), confidence };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function soft(value: number, limit: number): number {
  return limit * Math.tanh(value / limit);
}

/** Thousandths keep stored values readable; −0 becomes 0. */
function rounded(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}

/**
 * Pools per-frame estimates by median, so one frame facing the sun or a passing subject cannot decide,
 * then damps the correction by confidence and soft-limits it. Null when no frame had an estimate.
 */
export function poolWhiteBalance(estimates: readonly (IlluminantEstimate | null)[]): WhiteBalance | null {
  const usable = estimates.filter((estimate): estimate is IlluminantEstimate => estimate !== null);
  if (!usable.length) return null;
  const temperature = median(usable.map((estimate) => estimate.temperature));
  const tint = median(usable.map((estimate) => estimate.tint));
  // A robust spread: one outlier frame does not count as changing light.
  const spread = 1.4826 * median(usable.map((estimate) => Math.abs(estimate.temperature - temperature)));
  const confidence =
    median(usable.map((estimate) => estimate.confidence)) * (spread > WHITE_BALANCE.unstableTemperature ? 0.5 : 1);
  const strength = temperature > 0 ? WHITE_BALANCE.coolStrength : WHITE_BALANCE.warmStrength;
  return {
    temperature: rounded(soft(confidence * strength * temperature, WHITE_BALANCE.temperatureLimit)),
    tint: rounded(soft(confidence * WHITE_BALANCE.tintStrength * tint, WHITE_BALANCE.tintLimit)),
  };
}

/**
 * Project frames analysed around `playhead` within its clip [start, end): the playhead itself, and the
 * other frames shared between the two sides in proportion to their room, evenly spaced up to `radius`.
 */
export function whiteBalanceWindow(
  clip: { start: number; end: number },
  playhead: number,
  frames: number = WHITE_BALANCE_WINDOW.frames,
  radius: number = WHITE_BALANCE_WINDOW.radius,
): number[] {
  if (!Number.isSafeInteger(playhead) || playhead < clip.start || playhead >= clip.end)
    throw new Error('The playhead must be inside the analysed clip.');
  const before = Math.min(radius, playhead - clip.start);
  const after = Math.min(radius, clip.end - 1 - playhead);
  const others = Math.max(0, frames - 1);
  const share = before + after === 0 ? 0 : Math.round((others * before) / (before + after));
  const right = Math.min(after, others - Math.min(before, share));
  const left = Math.min(before, others - right);
  const window = [playhead];
  for (let step = 1; step <= left; step++) window.push(playhead - Math.round((before * step) / left));
  for (let step = 1; step <= right; step++) window.push(playhead + Math.round((after * step) / right));
  return window.sort((first, second) => first - second);
}
