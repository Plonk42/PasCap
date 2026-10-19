import { describe, expect, it } from 'vitest';
import { encode709, temperatureTintGains } from '../../src/shared/colour.js';
import {
  frameIlluminant,
  neutralisingWhiteBalance,
  poolWhiteBalance,
  WHITE_BALANCE,
  whiteBalanceWindow,
  type AnalysisFrame,
  type IlluminantEstimate,
} from '../../src/shared/white-balance.js';

type Linear = readonly [number, number, number];

function hash(x: number, y: number, seed = 0): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263) + Math.imul(seed, 2_147_483_647);
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

/** 8-bit encoded BT.709 RGBA from linear light, as a canvas would read it back. */
function frame(width: number, height: number, pixel: (x: number, y: number) => Linear): AnalysisFrame {
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

/** Grey ground: 6-pixel patches of varied lightness with fine texture, so it has plenty of edges. */
function groundLevel(x: number, y: number, seed = 0): number {
  const patch = hash(Math.floor(x / 6), Math.floor(y / 6), seed);
  return (0.03 + 0.45 * patch ** 1.5) * (0.96 + 0.08 * hash(x, y, seed + 1));
}

function neutral(seed = 0, width = 320, height = 180): AnalysisFrame {
  return frame(width, height, (x, y) => {
    const level = groundLevel(x, y, seed);
    return [level, level, level];
  });
}

function cast(gains: Linear, seed = 0, width = 320, height = 180): AnalysisFrame {
  return frame(width, height, (x, y) => {
    const level = groundLevel(x, y, seed);
    return [level * gains[0], level * gains[1], level * gains[2]];
  });
}

const PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/** Saturated objects cycling through every channel order, so the scene as a whole is balanced. */
function colourful(seed = 0): AnalysisFrame {
  const base = [0.5, 0.22, 0.08] as const;
  return frame(320, 180, (x, y) => {
    const index = Math.floor(x / 10) + 32 * Math.floor(y / 10) + seed;
    const order = PERMUTATIONS[index % 6]!;
    const level = 0.3 + 0.7 * hash(Math.floor(index / 6), 0, seed);
    return [base[order[0]] * level, base[order[1]] * level, base[order[2]] * level];
  });
}

/** Corrected light of a cast: the cast times the gains of a Temperature/Tint, normalised to green. */
function corrected(gains: Linear, balance: { temperature: number; tint: number }): Linear {
  const correction = temperatureTintGains(balance);
  const light = gains.map((gain, channel) => gain * correction[channel]!);
  return [light[0]! / light[1]!, 1, light[2]! / light[1]!];
}

function estimate(input: AnalysisFrame): IlluminantEstimate {
  const result = frameIlluminant(input);
  if (!result) throw new Error('Expected an estimate.');
  return result;
}

describe('automatic white balance estimator', () => {
  it('maps a measured light to the Temperature and Tint whose gains neutralise it exactly', () => {
    for (const light of [
      [1.3, 1, 0.7],
      [0.8, 1.1, 1.25],
      [1, 0.85, 1],
    ] as const) {
      const neutralised = corrected(light, neutralisingWhiteBalance(light));
      expect(neutralised[0]).toBeCloseTo(1, 12);
      expect(neutralised[2]).toBeCloseTo(1, 12);
    }
  });

  it('gives exactly zero for a neutral image, with full confidence', () => {
    expect(estimate(neutral())).toEqual({ temperature: 0, tint: 0, confidence: 1 });
    expect(poolWhiteBalance([estimate(neutral())])).toEqual({ temperature: 0, tint: 0 });
  });

  it('stays near zero for a colourful scene that is balanced as a whole', () => {
    const result = poolWhiteBalance([estimate(colourful(1)), estimate(colourful(2)), estimate(colourful(3))])!;
    expect(Math.abs(result.temperature)).toBeLessThan(0.05);
    expect(Math.abs(result.tint)).toBeLessThan(0.05);
  });

  it.each([
    { name: 'warm', gains: [1.3, 1, 0.7] as const, temperature: -1, tint: 1 },
    { name: 'blue', gains: [0.75, 1, 1.3] as const, temperature: 1, tint: 1 },
    { name: 'magenta', gains: [1, 0.85, 1] as const, temperature: 0, tint: -1 },
    { name: 'green', gains: [0.9, 1.15, 0.9] as const, temperature: 0, tint: 1 },
  ])('measures a $name cast that its Temperature and Tint neutralise', ({ gains, temperature, tint }) => {
    const raw = estimate(cast(gains));
    expect(raw.confidence).toBeGreaterThan(0.95);
    const neutralised = corrected(gains, raw);
    expect(neutralised[0]).toBeCloseTo(1, 2);
    expect(neutralised[2]).toBeCloseTo(1, 2);
    const result = poolWhiteBalance([raw])!;
    // Signs: positive Temperature warms (a cool cast), positive Tint adds magenta (a green cast).
    if (temperature === 0) expect(Math.abs(result.temperature)).toBeLessThan(0.01);
    else expect(Math.sign(result.temperature)).toBe(temperature);
    expect(Math.sign(result.tint)).toBe(tint);
    // Damped and soft-limited by the documented constants, never beyond the raw correction.
    const strength = raw.temperature > 0 ? WHITE_BALANCE.coolStrength : WHITE_BALANCE.warmStrength;
    const limit = WHITE_BALANCE.temperatureLimit;
    expect(result.temperature).toBeCloseTo(limit * Math.tanh((raw.confidence * strength * raw.temperature) / limit), 2);
    expect(Math.abs(result.temperature)).toBeLessThanOrEqual(Math.abs(raw.temperature));
    expect(Math.abs(result.tint)).toBeLessThanOrEqual(Math.abs(raw.tint));
    expect(Math.abs(result.temperature)).toBeLessThanOrEqual(WHITE_BALANCE.temperatureLimit);
    expect(Math.abs(result.tint)).toBeLessThanOrEqual(WHITE_BALANCE.tintLimit);
  });

  it('removes most of a moderate cool cast and less of a warm one', () => {
    const coolRaw = estimate(cast([0.85, 1, 1.15]));
    const cool = poolWhiteBalance([coolRaw])!;
    const warm = poolWhiteBalance([estimate(cast([1.15, 1, 0.85]))])!;
    expect(cool.temperature / coolRaw.temperature).toBeGreaterThan(0.7);
    expect(-warm.temperature).toBeLessThan(cool.temperature);
  });

  it('is deterministic', () => {
    const frames = [cast([1.1, 1, 0.9], 4), cast([1.1, 1, 0.9], 5), neutral(6)];
    const first = poolWhiteBalance(frames.map(frameIlluminant));
    const second = poolWhiteBalance(frames.map(frameIlluminant));
    expect(second).toEqual(first);
    expect(Object.is(second!.temperature, first!.temperature)).toBe(true);
  });

  it('lets one outlier frame barely move the pooled result', () => {
    const steady = Array.from({ length: 7 }, (_, index) => estimate(cast([0.9, 1, 1.12], index, 160, 90)));
    const flash = estimate(
      frame(160, 90, (x, y) => {
        const level = groundLevel(x, y, 9);
        return [level * 1.6, level * 0.7, level * 0.3];
      }),
    );
    const reference = poolWhiteBalance(steady)!;
    const disturbed = poolWhiteBalance([...steady.slice(0, 6), flash])!;
    expect(Math.abs(disturbed.temperature - reference.temperature)).toBeLessThan(0.02);
    expect(Math.abs(disturbed.tint - reference.tint)).toBeLessThan(0.02);
  });

  it('halves confidence when the light changes within the window', () => {
    const blues = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
    const changing = blues.map((blue, index) => estimate(cast([1, 1, blue], index, 160, 90)));
    const middle = estimate(cast([1, 1, 1.2], 3, 160, 90));
    const steady = poolWhiteBalance(Array.from({ length: 7 }, () => middle))!;
    const pooled = poolWhiteBalance(changing)!;
    expect(pooled.temperature).toBeGreaterThan(0);
    expect(pooled.temperature).toBeLessThan(0.6 * steady.temperature);
  });

  it('does not drag a sky-dominated frame to grey', () => {
    const horizon = 117;
    const sky = frame(320, 180, (x, y) => {
      if (y < horizon) {
        // Blue sky turning hazy towards the horizon, with no texture.
        const haze = y / horizon;
        return [0.22 + 0.3 * haze, 0.36 + 0.24 * haze, 0.78 - 0.05 * haze];
      }
      // Hazy, then contrasted neutral ground.
      const depth = Math.min(1, (y - horizon) / 20);
      const level = groundLevel(x, y, 3);
      const hazy = 0.3 + (level - 0.3) * depth;
      return [hazy, hazy, hazy];
    });
    const means = [0, 1, 2].map((channel) => {
      let sum = 0;
      for (let index = channel; index < sky.data.length; index += 4) sum += (sky.data[index]! / 255) ** 2.2;
      return sum;
    });
    const greyWorld = Math.log2(means[2]! / means[0]!);
    expect(greyWorld).toBeGreaterThan(0.6);
    const result = poolWhiteBalance([estimate(sky)])!;
    expect(Math.abs(result.temperature)).toBeLessThan(0.15);
  });

  it('keeps a sunset warm', () => {
    const sunset = frame(320, 180, (x, y) => {
      if (y < 110) {
        const glow = 1 - y / 110;
        return [0.55 + 0.35 * glow, 0.22 + 0.2 * glow, 0.06 + 0.04 * glow];
      }
      const level = groundLevel(x, y, 7) * 0.15;
      return [level * 1.2, level, level * 0.8];
    });
    const raw = estimate(sunset);
    const result = poolWhiteBalance([raw])!;
    expect(raw.temperature).toBeLessThan(-1);
    expect(result.temperature).toBeLessThan(0);
    expect(result.temperature).toBeGreaterThanOrEqual(-WHITE_BALANCE.temperatureLimit);
    // The corrected sky keeps far more red than blue.
    const [red, , blue] = temperatureTintGains(result);
    expect((0.9 * red) / (0.1 * blue)).toBeGreaterThan(4);
  });

  it('ignores letterbox, clipped and black pixels, and gives no estimate without usable pixels', () => {
    const content = (x: number, y: number): Linear => {
      const level = groundLevel(x, y, 2);
      return [level * 0.85, level, level * 1.15];
    };
    const plain = estimate(frame(280, 140, content));
    const letterboxed = estimate(
      frame(320, 180, (x, y) => (x < 20 || x >= 300 || y < 20 || y >= 160 ? [0, 0, 0] : content(x - 20, y - 20))),
    );
    expect(letterboxed).toEqual(plain);
    // Clipped highlights (a white sky patch, sun glints) do not pull the estimate.
    const glints = estimate(
      frame(280, 140, (x, y) => (hash(Math.floor(x / 12), Math.floor(y / 12), 8) < 0.12 ? [1, 1, 1] : content(x, y))),
    );
    expect(glints.temperature).toBeCloseTo(plain.temperature, 2);
    expect(glints.tint).toBeCloseTo(plain.tint, 2);
    expect(frameIlluminant(frame(64, 36, () => [0, 0, 0]))).toBeNull();
    expect(frameIlluminant(frame(64, 36, () => [1, 1, 1]))).toBeNull();
    expect(frameIlluminant(frame(64, 36, () => [0.2, 0.3, 0.4]))).toBeNull();
    expect(poolWhiteBalance([null, null])).toBeNull();
    expect(() => frameIlluminant({ width: 2, height: 2, data: new Uint8ClampedArray(12) })).toThrow(/RGBA/);
  });
});

describe('white balance analysis window', () => {
  it('spreads seven frames over half a second each side, including the playhead', () => {
    expect(whiteBalanceWindow({ start: 0, end: 300 }, 100)).toEqual([85, 90, 95, 100, 105, 110, 115]);
  });

  it('stays within the clip at the playhead and keeps seven frames when there is room', () => {
    expect(whiteBalanceWindow({ start: 100, end: 300 }, 100)).toEqual([100, 103, 105, 108, 110, 113, 115]);
    expect(whiteBalanceWindow({ start: 0, end: 300 }, 299)).toEqual([284, 286, 289, 291, 294, 296, 299]);
    expect(whiteBalanceWindow({ start: 98, end: 300 }, 100)).toEqual([98, 100, 103, 106, 109, 112, 115]);
    for (let playhead = 40; playhead < 80; playhead++) {
      const window = whiteBalanceWindow({ start: 40, end: 80 }, playhead);
      expect(window).toContain(playhead);
      expect(window).toHaveLength(7);
      expect(new Set(window).size).toBe(7);
      expect(window.every((frame) => frame >= 40 && frame < 80 && Math.abs(frame - playhead) <= 15)).toBe(true);
    }
  });

  it('uses every frame of a short clip', () => {
    expect(whiteBalanceWindow({ start: 10, end: 14 }, 11)).toEqual([10, 11, 12, 13]);
    expect(whiteBalanceWindow({ start: 10, end: 11 }, 10)).toEqual([10]);
    expect(() => whiteBalanceWindow({ start: 10, end: 14 }, 14)).toThrow(/inside/);
  });
});
