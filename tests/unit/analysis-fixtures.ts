import { renderFlat, type AutoCorrection } from '../../src/shared/auto-adjust.js';
import { decode709, encode709, temperatureTintGains } from '../../src/shared/color.js';
import type { AnalysisFrame } from '../../src/shared/white-balance.js';

/** Synthetic footage for the color estimators' tests. */

export type Linear = readonly [number, number, number];
export type Pixel = (x: number, y: number) => Linear;

export function hash(x: number, y: number, seed = 0): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263) + Math.imul(seed, 2_147_483_647);
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

/** 8-bit encoded BT.709 RGBA from linear light, as a canvas reads a proxy frame back. */
export function frame(pixel: Pixel, width = 160, height = 90): AnalysisFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      pixel(x, y).forEach((value, channel) => {
        data[index + channel] = Math.round(encode709(Math.min(1, Math.max(0, value))) * 255);
      });
      data[index + 3] = 255;
    }
  return { width, height, data };
}

/** Encoded lightness quantiles of a Beta(1.5, 1.7) distribution: a spread like well-exposed footage. */
const LIGHTNESS = (() => {
  const steps = 4000;
  const density = Array.from({ length: steps }, (_, index) => {
    const u = (index + 0.5) / steps;
    return u ** 0.5 * (1 - u) ** 0.7;
  });
  const total = density.reduce((sum, value) => sum + value, 0);
  let sum = 0;
  const cumulative = density.map((value) => {
    sum += value;
    return sum / total;
  });
  return Array.from({ length: 256 }, (_, index) => {
    const u = (index + 0.5) / 256;
    return (cumulative.findIndex((value) => value >= u) + 0.5) / steps;
  });
})();

/**
 * A well-exposed, fairly colorful scene of 8-pixel patches with fine texture. Patches come in
 * triples whose hues are 120° apart, so every channel has the same statistics: neutral as a whole.
 */
export function scene(seed: number, { gain = 1, chroma = 0.7, light = [1, 1, 1] as Linear } = {}): Pixel {
  return (x, y) => {
    const index = Math.floor(x / 8) + Math.floor(y / 8) * 20;
    const triple = Math.floor(index / 3);
    const level =
      decode709(0.02 + 0.94 * LIGHTNESS[Math.floor(hash(triple, 0, seed) * 256)]!) *
      (0.95 + 0.1 * hash(x, y, seed + 1));
    const angle = hash(triple, 1, seed + 7) * 2 * Math.PI + ((index % 3) * 2 * Math.PI) / 3;
    const amount = hash(triple, 2, seed + 9) < 0.6 ? chroma : chroma / 4;
    return [0, 1, 2].map(
      (channel) => level * (1 + amount * Math.cos(angle - (channel * 2 * Math.PI) / 3)) * gain * light[channel]!,
    ) as unknown as Linear;
  };
}

/** Flat profile: encoded black 0.10 and white 0.85, midtone contrast about 0.7× and saturation 0.6×. */
export function flat(pixel: Pixel): Pixel {
  return (x, y) => {
    const encoded = pixel(x, y).map((value) => encode709(Math.min(1, value)));
    const level = 0.2126 * encoded[0]! + 0.7152 * encoded[1]! + 0.0722 * encoded[2]!;
    const flattened = level - 0.133 * level * (1 - level) * (2 * level - 1);
    return encoded.map((value) => decode709(0.1 + 0.75 * (flattened + 0.6 * (value - level)))) as unknown as Linear;
  };
}

export const frames = (count: number, pixel: (seed: number) => Pixel): AnalysisFrame[] =>
  Array.from({ length: count }, (_, index) => frame(pixel(index + 1)));

/** The frame as PasCap renders it with the correction, for flat areas: Shadows/Highlights on itself. */
export function apply(input: AnalysisFrame, correction: AutoCorrection): AnalysisFrame {
  const { temperature, tint, saturation, vibrance, ...tone } = correction;
  const gains = temperatureTintGains({ temperature, tint });
  const render = renderFlat({ temperature, tint }, tone, { saturation, vibrance });
  const data = new Uint8ClampedArray(input.data.length);
  for (let index = 0; index < data.length; index += 4) {
    const balanced = [0, 1, 2].map((channel) => decode709(input.data[index + channel]! / 255) * gains[channel]!);
    render(balanced).forEach((value, channel) => {
      data[index + channel] = Math.round(value * 255);
    });
    data[index + 3] = 255;
  }
  return { width: input.width, height: input.height, data };
}

/** Each frame's pixel saturations in `region`, linear (max − min) / max as Vibrance measures them. */
export function saturations(
  input: readonly AnalysisFrame[],
  region: (x: number, y: number) => boolean = () => true,
): number[][] {
  return input.map((item) => {
    const values: number[] = [];
    for (let y = 0; y < item.height; y++)
      for (let x = 0; x < item.width; x++) {
        if (!region(x, y)) continue;
        const offset = (y * item.width + x) * 4;
        const linear = [0, 1, 2].map((channel) => decode709(item.data[offset + channel]! / 255));
        const maximum = Math.max(...linear);
        values.push(maximum > 0 ? (maximum - Math.min(...linear)) / maximum : 0);
      }
    return values.sort((a, b) => a - b);
  });
}

export const meanSaturation = (values: number[][]): number => {
  const all = values.flat();
  return all.reduce((sum, value) => sum + value, 0) / all.length;
};

/** The median over frames of each frame's `q` quantile of saturation. */
export const saturationQuantile = (values: number[][], q: number): number => {
  const quantiles = values.map((item) => item[Math.min(item.length - 1, Math.floor(q * item.length))]!);
  quantiles.sort((a, b) => a - b);
  return quantiles[Math.floor(quantiles.length / 2)]!;
};
