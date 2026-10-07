import { endianness } from 'node:os';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { compileSpatialMapping, type SpatialMapping } from '../shared/spatial.js';
import type { PreviewLayer } from '../shared/timeline.js';
import { ColourLutCache, checkLayeredCancellation, sampleColourLut } from './layered-colour.js';

export interface ContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LayerFrameSource {
  sample: PreviewLayer;
  rgb: Uint8Array;
  bounds: ContentBounds;
  /** Registered original dimensions, never the even-rounded decode rectangle. */
  original: { width: number; height: number };
}
interface PreparedSource extends LayerFrameSource {
  lut: Float32Array;
  multiplier: number;
  coverage: number;
  mapping: SpatialMapping;
  fullCanvas: boolean;
}

function hasGradedContent(source: PreparedSource, x: number, y: number): boolean {
  const bounds = source.bounds;
  return (
    source.multiplier !== 0 &&
    (source.fullCanvas ||
      (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height))
  );
}

function validateFrames(accumulator: Buffer, pixels: number, sources: readonly LayerFrameSource[]): void {
  if (endianness() !== 'LE') throw new Error('The native RGBA16 compositor requires a little-endian Linux host.');
  if (accumulator.length !== pixels * 8 || accumulator.byteOffset % 2 !== 0)
    throw new Error('Invalid RGBA16 accumulator.');
  if (sources.length > 2 || sources.some((source) => source.rgb.length !== pixels * 3))
    throw new Error('A layer group requires at most two correctly sized RGB frames.');
}

function validateBounds(bounds: ContentBounds, target: { width: number; height: number }): void {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width < 1 ||
    bounds.height < 1 ||
    bounds.x + bounds.width > target.width ||
    bounds.y + bounds.height > target.height
  )
    throw new Error('Invalid fitted source content rectangle.');
}

/** Inverse original-aspect geometry, then bilinear sampling of the existing fitted RGB. */
function sampleSpatialRgb(source: PreparedSource, x: number, y: number, out: Float64Array): boolean {
  const { mapping, bounds, rgb } = source;
  const [a, b, c, d, e, f] = mapping.affine;
  const outputX = (x + 0.5) / mapping.targetWidth;
  const outputY = (y + 0.5) / mapping.targetHeight;
  const u = a * outputX + b * outputY + c;
  const v = d * outputX + e * outputY + f;
  if (u < mapping.cropLeft || u >= 1 - mapping.cropRight || v < mapping.cropTop || v >= 1 - mapping.cropBottom)
    return false;
  if (source.multiplier === 0) return true;
  const sampleX = bounds.x + u * bounds.width - 0.5;
  const sampleY = bounds.y + v * bounds.height - 0.5;
  const left = Math.floor(sampleX);
  const top = Math.floor(sampleY);
  const fractionX = sampleX - left;
  const fractionY = sampleY - top;
  // Clamp each tap to content, not the canvas's black decode padding.
  const x0 = Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, left));
  const x1 = Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, left + 1));
  const y0 = Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, top));
  const y1 = Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, top + 1));
  const topLeft = (y0 * mapping.targetWidth + x0) * 3;
  const topRight = (y0 * mapping.targetWidth + x1) * 3;
  const bottomLeft = (y1 * mapping.targetWidth + x0) * 3;
  const bottomRight = (y1 * mapping.targetWidth + x1) * 3;
  for (let channel = 0; channel < 3; channel++) {
    const upper = rgb[topLeft + channel]! + (rgb[topRight + channel]! - rgb[topLeft + channel]!) * fractionX;
    const lower = rgb[bottomLeft + channel]! + (rgb[bottomRight + channel]! - rgb[bottomLeft + channel]!) * fractionX;
    out[channel] = upper + (lower - upper) * fractionY;
  }
  return true;
}

/** Return coverage separately from RGB, including opaque neutral padding and black fades. */
function sampleGradedSource(
  source: PreparedSource,
  x: number,
  y: number,
  inputOffset: number,
  resampled: Float64Array,
  graded: Float64Array,
): boolean {
  if (source.mapping.neutral) {
    // Identity preserves byte indexing and opaque, ungraded black letterboxing.
    if (!hasGradedContent(source, x, y)) {
      graded.fill(0);
      return true;
    }
    sampleColourLut(
      source.lut,
      source.rgb[inputOffset]!,
      source.rgb[inputOffset + 1]!,
      source.rgb[inputOffset + 2]!,
      graded,
    );
    return true;
  }
  if (!sampleSpatialRgb(source, x, y, resampled)) return false;
  if (source.multiplier === 0) graded.fill(0);
  // Grade AFTER RGB resampling; never interpolate already graded endpoint colours.
  else sampleColourLut(source.lut, resampled[0]!, resampled[1]!, resampled[2]!, graded);
  return true;
}

function groupCoverage(sources: readonly LayerFrameSource[]): number {
  const { layerId, opacity } = sources[0]!.sample;
  if (sources.some((source) => source.sample.layerId !== layerId || source.sample.opacity !== opacity))
    throw new Error('Compose one authoritative layer group at a time.');
  const coverage = sources.reduce((sum, source) => sum + source.sample.opacity * source.sample.blendWeight, 0);
  if (coverage < 0 || coverage > 1 + 1e-10) throw new Error('Layer coverage must remain in [0, 1].');
  return coverage;
}

async function prepareSources(
  sources: readonly LayerFrameSource[],
  target: { width: number; height: number },
  cache: ColourLutCache,
  signal: AbortSignal,
): Promise<PreparedSource[]> {
  if (sources.length > cache.capacity)
    throw new Error('The LUT cache must hold every borrowed grade in the current group.');
  const prepared: PreparedSource[] = [];
  for (const source of sources) {
    validateBounds(source.bounds, target);
    const mapping = compileSpatialMapping(
      source.sample.spatial,
      source.original.width,
      source.original.height,
      target.width,
      target.height,
    );
    prepared.push({
      ...source,
      lut: await cache.get(source.sample.colour, signal), // NOSONAR -- two borrowed slots, never parallel LUT builds.
      multiplier: source.sample.opacity * source.sample.blendWeight * source.sample.brightness * 65535,
      coverage: source.sample.opacity * source.sample.blendWeight,
      mapping,
      fullCanvas:
        source.bounds.x === 0 &&
        source.bounds.y === 0 &&
        source.bounds.width === target.width &&
        source.bounds.height === target.height,
    });
  }
  return prepared;
}

/** Same fit as the native decode filter; padding stays black AFTER grading. */
export function fittedContent(
  source: { width: number; height: number },
  target: { width: number; height: number },
): ContentBounds {
  const factor = Math.min(target.width / source.width, target.height / source.height);
  const width = Math.min(target.width, Math.max(2, Math.floor((source.width * factor) / 2 + 1e-8) * 2));
  const height = Math.min(target.height, Math.max(2, Math.floor((source.height * factor) / 2 + 1e-8) * 2));
  return { x: Math.floor((target.width - width) / 2), y: Math.floor((target.height - height) / 2), width, height };
}

/**
 * A single source-over GROUP, exactly the grouping/coverage rules in compositePixel.
 * RGB is encoded BT.709 and premultiplied; alpha is coverage, never black-fade
 * brightness. RGBA16 avoids rounding at every layer to an 8-bit intermediate.
 * The accumulator is reused in-place only after the previous pipe write completes.
 */
export async function composeLayerFrame(
  accumulator: Buffer,
  target: { width: number; height: number },
  sources: readonly LayerFrameSource[],
  cache: ColourLutCache,
  signal: AbortSignal,
): Promise<void> {
  checkLayeredCancellation(signal);
  const pixels = target.width * target.height;
  validateFrames(accumulator, pixels, sources);
  if (!sources.length) return;
  const coverage = groupCoverage(sources);
  if (coverage === 0) return;
  const prepared = await prepareSources(sources, target, cache, signal);
  const output = new Uint16Array(accumulator.buffer, accumulator.byteOffset, pixels * 4);
  const graded = new Float64Array(3);
  const resampled = new Float64Array(3);
  let x = 0;
  let y = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    const inputOffset = pixel * 3;
    for (const source of prepared) {
      if (!sampleGradedSource(source, x, y, inputOffset, resampled, graded)) continue;
      alpha += source.coverage;
      red += graded[0]! * source.multiplier;
      green += graded[1]! * source.multiplier;
      blue += graded[2]! * source.multiplier;
    }
    const keep = 1 - Math.min(1, alpha);
    const offset = pixel * 4;
    output[offset] = Math.round(red + output[offset]! * keep);
    output[offset + 1] = Math.round(green + output[offset + 1]! * keep);
    output[offset + 2] = Math.round(blue + output[offset + 2]! * keep);
    output[offset + 3] = Math.round(alpha * 65535 + output[offset + 3]! * keep);
    if (++x === target.width) {
      x = 0;
      y++;
    }
    if ((pixel + 1) % 65_536 === 0) {
      await yieldToEvents(); // NOSONAR -- let cancellation/UI requests interrupt a UHD frame.
      checkLayeredCancellation(signal);
    }
  }
  checkLayeredCancellation(signal);
}
