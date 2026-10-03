import { endianness } from 'node:os';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import type { PreviewLayer } from '../shared/timeline.js';
import { ColourLutCache, checkLayeredCancellation, sampleColourLut } from './layered-colour.js';

export interface ContentBounds { x: number; y: number; width: number; height: number }
export interface LayerFrameSource { sample: PreviewLayer; rgb: Uint8Array; bounds: ContentBounds }
interface PreparedSource extends LayerFrameSource { lut: Float32Array; multiplier: number; fullCanvas: boolean }

function hasGradedContent(source: PreparedSource, x: number, y: number): boolean {
  const bounds = source.bounds;
  return source.multiplier !== 0 && (source.fullCanvas ||
    (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height));
}

function validateFrames(accumulator: Buffer, pixels: number, sources: readonly LayerFrameSource[]): void {
  if (endianness() !== 'LE') throw new Error('The native RGBA16 compositor requires a little-endian Linux host.');
  if (accumulator.length !== pixels * 8 || accumulator.byteOffset % 2 !== 0) throw new Error('Invalid RGBA16 accumulator.');
  if (sources.length > 2 || sources.some((source) => source.rgb.length !== pixels * 3)) throw new Error('A layer group requires at most two correctly sized RGB frames.');
}

function groupCoverage(sources: readonly LayerFrameSource[]): number {
  const { layerId, layerOpacity } = sources[0]!.sample;
  if (sources.some((source) => source.sample.layerId !== layerId || source.sample.layerOpacity !== layerOpacity)) throw new Error('Compose one authoritative layer group at a time.');
  const coverage = sources.reduce((sum, source) => sum + source.sample.opacity * source.sample.blendWeight, 0) * layerOpacity;
  if (coverage < 0 || coverage > 1 + 1e-10) throw new Error('Layer coverage must remain in [0, 1].');
  return coverage;
}

async function prepareSources(sources: readonly LayerFrameSource[], target: { width: number; height: number }, cache: ColourLutCache, signal: AbortSignal): Promise<PreparedSource[]> {
  if (sources.length > cache.capacity) throw new Error('The LUT cache must hold every borrowed grade in the current group.');
  const prepared: PreparedSource[] = [];
  for (const source of sources) {
    prepared.push({
      ...source, lut: await cache.get(source.sample.colour, signal), // NOSONAR -- two borrowed slots, never parallel LUT builds.
      multiplier: source.sample.opacity * source.sample.blendWeight * source.sample.brightness * source.sample.layerOpacity * 65535,
      fullCanvas: source.bounds.x === 0 && source.bounds.y === 0 && source.bounds.width === target.width && source.bounds.height === target.height
    });
  }
  return prepared;
}

/** Same fit as the native decode filter; padding stays black AFTER grading. */
export function fittedContent(source: { width: number; height: number }, target: { width: number; height: number }): ContentBounds {
  const factor = Math.min(target.width / source.width, target.height / source.height);
  const width = Math.min(target.width, Math.max(2, Math.floor(source.width * factor / 2 + 1e-8) * 2));
  const height = Math.min(target.height, Math.max(2, Math.floor(source.height * factor / 2 + 1e-8) * 2));
  return { x: Math.floor((target.width - width) / 2), y: Math.floor((target.height - height) / 2), width, height };
}

/**
 * A single source-over GROUP, exactly the grouping/coverage rules in compositePixel.
 * RGB is encoded BT.709 and premultiplied; alpha is coverage, never black-fade
 * brightness. RGBA16 avoids rounding at every layer to an 8-bit intermediate.
 * The accumulator is reused in-place only after the previous pipe write completes.
 */
export async function composeLayerFrame(accumulator: Buffer, target: { width: number; height: number },
  sources: readonly LayerFrameSource[], cache: ColourLutCache, signal: AbortSignal): Promise<void> {
  checkLayeredCancellation(signal);
  const pixels = target.width * target.height;
  validateFrames(accumulator, pixels, sources);
  if (!sources.length) return;
  const coverage = groupCoverage(sources);
  if (coverage === 0) return;
  const prepared = await prepareSources(sources, target, cache, signal);
  const output = new Uint16Array(accumulator.buffer, accumulator.byteOffset, pixels * 4);
  const graded = new Float64Array(3);
  const keep = 1 - Math.min(1, coverage);
  let x = 0; let y = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    let red = 0; let green = 0; let blue = 0;
    const inputOffset = pixel * 3;
    for (const source of prepared) {
      if (!hasGradedContent(source, x, y)) continue;
      sampleColourLut(source.lut, source.rgb[inputOffset]!, source.rgb[inputOffset + 1]!, source.rgb[inputOffset + 2]!, graded);
      red += graded[0]! * source.multiplier; green += graded[1]! * source.multiplier; blue += graded[2]! * source.multiplier;
    }
    const offset = pixel * 4;
    output[offset] = Math.round(red + output[offset]! * keep);
    output[offset + 1] = Math.round(green + output[offset + 1]! * keep);
    output[offset + 2] = Math.round(blue + output[offset + 2]! * keep);
    output[offset + 3] = Math.round(coverage * 65535 + output[offset + 3]! * keep);
    if (++x === target.width) { x = 0; y++; }
    if ((pixel + 1) % 65_536 === 0) {
      await yieldToEvents(); // NOSONAR -- let cancellation/UI requests interrupt a UHD frame.
      checkLayeredCancellation(signal);
    }
  }
  checkLayeredCancellation(signal);
}