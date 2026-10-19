import { describe, expect, it } from 'vitest';
import {
  analyseAutoAdjust,
  AUTO_ADJUST,
  AUTO_ADJUST_SETTINGS,
  autoAdjustFrames,
  renderFlat,
  scaleCorrection,
  toneStatistics,
  type AutoCorrection,
} from '../../src/shared/auto-adjust.js';
import { decode709, encode709, temperatureTintGains } from '../../src/shared/colour.js';
import { WHITE_BALANCE, type AnalysisFrame } from '../../src/shared/white-balance.js';

type Linear = readonly [number, number, number];
type Pixel = (x: number, y: number) => Linear;

function hash(x: number, y: number, seed = 0): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263) + Math.imul(seed, 2_147_483_647);
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

/** 8-bit encoded BT.709 RGBA from linear light, as a canvas reads a proxy frame back. */
function frame(pixel: Pixel, width = 160, height = 90): AnalysisFrame {
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
  const cumulative = density.map((value) => (sum += value) / total);
  return Array.from({ length: 256 }, (_, index) => {
    const u = (index + 0.5) / 256;
    return (cumulative.findIndex((value) => value >= u) + 0.5) / steps;
  });
})();

/**
 * A well-exposed, fairly colourful scene of 8-pixel patches with fine texture. Patches come in
 * triples whose hues are 120° apart, so every channel has the same statistics: neutral as a whole.
 */
function scene(seed: number, { gain = 1, chroma = 0.7, light = [1, 1, 1] as Linear } = {}): Pixel {
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
function flat(pixel: Pixel): Pixel {
  return (x, y) => {
    const encoded = pixel(x, y).map((value) => encode709(Math.min(1, value)));
    const level = 0.2126 * encoded[0]! + 0.7152 * encoded[1]! + 0.0722 * encoded[2]!;
    const flattened = level - 0.133 * level * (1 - level) * (2 * level - 1);
    return encoded.map((value) => decode709(0.1 + 0.75 * (flattened + 0.6 * (value - level)))) as unknown as Linear;
  };
}

const frames = (count: number, pixel: (seed: number) => Pixel): AnalysisFrame[] =>
  Array.from({ length: count }, (_, index) => frame(pixel(index + 1)));

function analyse(input: readonly AnalysisFrame[]): AutoCorrection {
  const correction = analyseAutoAdjust(input);
  if (!correction) throw new Error('Expected a correction.');
  return correction;
}

/** The frame as PasCap renders it with the correction, for flat areas: Shadows/Highlights on itself. */
function apply(input: AnalysisFrame, correction: AutoCorrection): AnalysisFrame {
  const { temperature, tint, saturation, ...tone } = correction;
  const gains = temperatureTintGains({ temperature, tint });
  const render = renderFlat({ temperature, tint }, tone, saturation);
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

/** Mean absolute change of the encoded channels, 0–1: how much a correction changes the image. */
function change(before: readonly AnalysisFrame[], after: readonly AnalysisFrame[]): number {
  let sum = 0;
  let count = 0;
  before.forEach((input, index) => {
    for (let offset = 0; offset < input.data.length; offset += 4)
      for (let channel = 0; channel < 3; channel++) {
        sum += Math.abs(input.data[offset + channel]! - after[index]!.data[offset + channel]!);
        count++;
      }
  });
  return sum / count / 255;
}

/** Encoded black point, white point and log-average of frames, as the estimator measures them. */
function measured(input: readonly AnalysisFrame[]): { black: number; white: number; middle: number } {
  const statistics = toneStatistics(input, { temperature: 0, tint: 0 })!;
  return {
    black: encode709(statistics.black),
    white: encode709(Math.min(1, statistics.white)),
    middle: encode709(statistics.logAverage),
  };
}

const TONE = ['exposure', 'brightness', 'highlights', 'shadows', 'whites', 'blacks'] as const;
const logged = (value: number): number => Math.abs(Math.log2(value));

describe('Auto adjust estimator', () => {
  it('leaves well-exposed, neutral, fairly colourful footage almost unchanged', () => {
    const correction = analyse(frames(6, (seed) => scene(seed)));
    expect(Math.abs(correction.temperature)).toBeLessThan(0.03);
    expect(Math.abs(correction.tint)).toBeLessThan(0.03);
    for (const setting of TONE) expect(Math.abs(correction[setting])).toBeLessThan(0.03);
    expect(logged(correction.contrast)).toBeLessThan(0.03);
    expect(logged(correction.saturation)).toBeLessThan(0.05);
  });

  it('restores the black and white points, midtone contrast and saturation of flat footage', () => {
    const input = frames(6, (seed) => flat(scene(seed)));
    const correction = analyse(input);
    expect(correction.blacks).toBeLessThan(0);
    expect(correction.contrast).toBeGreaterThan(1.1);
    expect(correction.saturation).toBeGreaterThan(1.2);
    const before = measured(input);
    const after = measured(input.map((item) => apply(item, correction)));
    // One 8-bit step of tolerance for the corrected frames' quantisation.
    expect(after.black).toBeGreaterThanOrEqual(AUTO_ADJUST.black[0] - 0.004);
    expect(after.black).toBeLessThanOrEqual(AUTO_ADJUST.black[1] + 0.004);
    expect(after.white).toBeGreaterThanOrEqual(AUTO_ADJUST.white[0] - 0.004);
    expect(after.white).toBeLessThanOrEqual(AUTO_ADJUST.white[1] + 0.004);
    expect(before.black).toBeGreaterThan(0.1);
    expect(before.white).toBeLessThan(0.82);
    // The output's midtone slope, measured on grey around the log-average, at least 1.3× the input's.
    const { temperature, tint, saturation, ...tone } = correction;
    const render = renderFlat({ temperature, tint }, tone, saturation);
    const middle = toneStatistics(input, { temperature, tint })!.logAverage;
    const output = (value: number): number => {
      const [red, green, blue] = render([value, value, value]);
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const slope = (curve: (value: number) => number): number => curve(middle * 1.05) - curve(middle / 1.05);
    expect(slope(output) / slope(encode709)).toBeGreaterThanOrEqual(1.3);
  });

  it('corrects most of an exposure error beyond its half-stop dead zone', () => {
    const exposure = (stops: number): number =>
      analyse(frames(6, (seed) => scene(seed, { gain: 2 ** stops }))).exposure;
    const [under, slightly, little, none, over, overer] = [-1.5, -1, -0.5, 0, 0.5, 1].map(exposure) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    expect(under).toBeGreaterThan(slightly);
    expect(slightly).toBeGreaterThan(little);
    expect(little).toBeGreaterThan(none);
    expect(Math.abs(none)).toBeLessThan(0.03);
    // Underexposure: each extra stop down adds about a stop of Exposure.
    expect(under - slightly).toBeGreaterThan(0.4);
    expect(under - slightly).toBeLessThan(0.6);
    expect(slightly).toBeGreaterThan(0.5);
    // Overexposure clips highlights, so the scene partly reads as high-key: darkened, conservatively.
    expect(over).toBeLessThan(-0.15);
    expect(overer).toBeLessThan(-0.15);
  });

  it.each([
    { name: 'blue', light: [0.75, 1, 1.3] as const, temperature: 1, tint: 1 },
    { name: 'warm', light: [1.3, 1, 0.7] as const, temperature: -1, tint: 1 },
    { name: 'green', light: [0.9, 1.15, 0.9] as const, temperature: 0, tint: 1 },
    { name: 'magenta', light: [1, 0.85, 1] as const, temperature: 0, tint: -1 },
  ])('counters a $name cast with the expected signs and damping', ({ light, temperature, tint }) => {
    const correction = analyse(frames(6, (seed) => scene(seed, { gain: 0.8, light })));
    if (temperature === 0) expect(Math.abs(correction.temperature)).toBeLessThan(0.05);
    else expect(Math.sign(correction.temperature)).toBe(temperature);
    expect(Math.sign(correction.tint)).toBe(tint);
    expect(Math.abs(correction.temperature)).toBeLessThanOrEqual(WHITE_BALANCE.temperatureLimit);
    expect(Math.abs(correction.tint)).toBeLessThanOrEqual(WHITE_BALANCE.tintLimit);
  });

  it('removes more of a cool cast than of an equally strong warm one', () => {
    const cool = analyse(frames(6, (seed) => scene(seed, { gain: 0.8, light: [0.85, 1, 1.18] })));
    const warm = analyse(frames(6, (seed) => scene(seed, { gain: 0.8, light: [1.18, 1, 0.85] })));
    expect(cool.temperature).toBeGreaterThan(0.2);
    expect(-warm.temperature).toBeLessThan(cool.temperature);
  });

  it('is nearly idempotent: analysing its own output changes the image far less', () => {
    const input = frames(6, (seed) => scene(seed, { gain: 0.5, light: [0.85, 1, 1.18] }));
    const first = analyse(input);
    const once = input.map((item) => apply(item, first));
    const second = analyse(once);
    const twice = once.map((item) => apply(item, second));
    expect(change(once, twice)).toBeLessThan(0.2 * change(input, once));
  });

  it('settles the tone of flat footage in one pass', () => {
    const input = frames(6, (seed) => flat(scene(seed)));
    const first = analyse(input);
    const second = analyse(input.map((item) => apply(item, first)));
    const size = (correction: AutoCorrection): number =>
      Math.hypot(...TONE.map((setting) => correction[setting]), Math.log2(correction.contrast));
    expect(size(second)).toBeLessThan(0.2 * size(first));
    // Saturation stops at its cap on flat footage, so a second pass would still add some.
    expect(first.saturation).toBe(AUTO_ADJUST.maximumSaturation);
  });

  it('is deterministic', () => {
    const input = frames(4, (seed) => flat(scene(seed, { light: [1.1, 1, 0.9] })));
    const first = analyse(input);
    const second = analyse(input);
    expect(second).toEqual(first);
    for (const setting of AUTO_ADJUST_SETTINGS) expect(Object.is(second[setting], first[setting])).toBe(true);
  });

  it('lets one outlier frame among sixteen barely move the result', () => {
    const steady = frames(16, (seed) => flat(scene(seed)));
    const flash = frame(() => [0.9, 0.85, 0.7]);
    const reference = analyse(steady);
    const disturbed = analyse([...steady.slice(0, 15), flash]);
    for (const setting of AUTO_ADJUST_SETTINGS) {
      const difference =
        setting === 'contrast' || setting === 'saturation'
          ? logged(disturbed[setting] / reference[setting])
          : Math.abs(disturbed[setting] - reference[setting]);
      expect(difference, setting).toBeLessThan(0.05);
    }
  });

  it('lowers the black point and adds contrast to hazy footage', () => {
    const correction = analyse(
      frames(6, (seed) => (x, y) => scene(seed)(x, y).map((value) => 0.8 * value + 0.024) as unknown as Linear),
    );
    expect(correction.blacks).toBeLessThan(-0.3);
    expect(correction.contrast).toBeGreaterThan(1.1);
  });

  it('keeps snow bright', () => {
    const snow = frames(6, (seed) => (x, y) => {
      const tree = hash(Math.floor(x / 10), Math.floor(y / 10), seed) < 0.15;
      const level = tree
        ? 0.02 + 0.03 * hash(x, y, seed)
        : 0.55 + 0.3 * hash(Math.floor(x / 4), Math.floor(y / 4), seed + 3);
      return [level * 0.97, level, level * 1.03];
    });
    const correction = analyse(snow);
    const before = measured(snow);
    const after = measured(snow.map((item) => apply(item, correction)));
    expect(before.middle).toBeGreaterThan(0.6);
    expect(after.middle).toBeGreaterThan(0.6);
    expect(correction.exposure).toBeGreaterThan(-0.2);
  });

  it('does not lift night footage to mid-grey', () => {
    const night = frames(6, (seed) => (x, y) => {
      const level = 0.001 + 0.03 * hash(Math.floor(x / 6), Math.floor(y / 6), seed + 5) ** 2;
      return [level * 1.1, level, level * 0.8];
    });
    const correction = analyse(night);
    expect(measured(night).white).toBeLessThan(encode709(AUTO_ADJUST.lowLight));
    // The low-light guard halves the lift: Exposure stays at most half its bound.
    expect(correction.exposure).toBeLessThanOrEqual(0.75);
    expect(measured(night.map((item) => apply(item, correction))).middle).toBeLessThan(0.25);
  });

  it('does not neutralise a sky- and sea-dominated frame to grey', () => {
    const view = frames(4, (seed) => (x, y) => {
      if (y < 40) {
        const haze = y / 40;
        return [0.22 + 0.3 * haze, 0.36 + 0.24 * haze, 0.78 - 0.05 * haze];
      }
      if (y < 52) {
        const level = 0.05 + 0.4 * hash(Math.floor(x / 3), Math.floor(y / 3), seed);
        return [level, level, level];
      }
      const ripple = 0.85 + 0.3 * hash(Math.floor(x / 2), Math.floor(y / 2), seed + 2);
      return [0.03 * ripple, 0.12 * ripple, 0.2 * ripple];
    });
    const correction = analyse(view);
    // Grey World would warm this view by its whole blue/red imbalance; Auto keeps it blue.
    const means = [0, 1, 2].map((channel) => {
      let sum = 0;
      for (const item of view)
        for (let index = channel; index < item.data.length; index += 4) sum += decode709(item.data[index]! / 255);
      return sum;
    });
    const greyWorld = Math.log2(means[2]! / means[0]!);
    expect(greyWorld).toBeGreaterThan(1);
    expect(Math.abs(correction.temperature)).toBeLessThan(0.2 * greyWorld);
    expect(Math.abs(correction.tint)).toBeLessThan(0.15);
    const [red, , blue] = temperatureTintGains(correction);
    expect((0.78 * blue) / (0.22 * red)).toBeGreaterThan(3);
  });

  it('keeps a sunset warm', () => {
    const sunset = frames(4, (seed) => (x, y) => {
      if (y < 55) {
        const glow = 1 - y / 55;
        return [0.55 + 0.35 * glow, 0.22 + 0.2 * glow, 0.06 + 0.04 * glow];
      }
      const level = (0.03 + 0.45 * hash(Math.floor(x / 6), Math.floor(y / 6), seed) ** 1.5) * 0.15;
      return [level * 1.2, level, level * 0.8];
    });
    const correction = analyse(sunset);
    expect(correction.temperature).toBeLessThan(0);
    expect(correction.temperature).toBeGreaterThanOrEqual(-WHITE_BALANCE.temperatureLimit);
    const [red, , blue] = temperatureTintGains(correction);
    expect((0.9 * red) / (0.1 * blue)).toBeGreaterThan(4);
  });

  it('gives no correction without usable pixels', () => {
    expect(analyseAutoAdjust([frame(() => [0, 0, 0])])).toBeNull();
    expect(analyseAutoAdjust([])).toBeNull();
  });
});

describe('Auto adjust intensity and frames', () => {
  const correction: AutoCorrection = {
    temperature: 0.4,
    tint: -0.2,
    saturation: 1.44,
    exposure: 1,
    brightness: 0.1,
    contrast: 1.21,
    highlights: -0.3,
    shadows: 0.2,
    whites: 0.5,
    blacks: -0.6,
  };

  it('scales log-gains and offsets linearly, Contrast and Saturation geometrically, from neutral', () => {
    expect(scaleCorrection(correction, 1)).toEqual(correction);
    const half = scaleCorrection(correction, 0.5);
    expect(half).toEqual({
      temperature: 0.2,
      tint: -0.1,
      saturation: 1.2,
      exposure: 0.5,
      brightness: 0.05,
      contrast: 1.1,
      highlights: -0.15,
      shadows: 0.1,
      whites: 0.25,
      blacks: -0.3,
    });
    const none = scaleCorrection(correction, 0);
    for (const setting of AUTO_ADJUST_SETTINGS)
      expect(none[setting]).toBe(setting === 'contrast' || setting === 'saturation' ? 1 : 0);
    for (const amount of [-0.01, 1.01, Number.NaN])
      expect(() => scaleCorrection(correction, amount)).toThrow(/Intensity/);
  });

  it('analyses the centres of up to sixteen equal slices of the source range', () => {
    expect(autoAdjustFrames(100, 420)).toEqual(Array.from({ length: 16 }, (_, index) => 110 + 20 * index));
    expect(autoAdjustFrames(5, 8)).toEqual([5, 6, 7]);
    expect(autoAdjustFrames(7, 8)).toEqual([7]);
    expect(() => autoAdjustFrames(8, 8)).toThrow(/at least one frame/);
  });
});
