import { describe, expect, it } from 'vitest';
import {
  analyzeAutoAdjust,
  AUTO_ADJUST,
  AUTO_ADJUST_SETTINGS,
  autoAdjustFrames,
  renderFlat,
  scaleCorrection,
  toneStatistics,
  type AutoCorrection,
} from '../../src/shared/auto-adjust.js';
import { decode709, encode709, temperatureTintGains } from '../../src/shared/color.js';
import {
  frameIlluminant,
  poolWhiteBalance,
  WHITE_BALANCE,
  type AnalysisFrame,
} from '../../src/shared/white-balance.js';

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
 * A well-exposed, fairly colorful scene of 8-pixel patches with fine texture. Patches come in
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

function analyze(input: readonly AnalysisFrame[]): AutoCorrection {
  const correction = analyzeAutoAdjust(input);
  if (!correction) throw new Error('Expected a correction.');
  return correction;
}

/** The frame as PasCap renders it with the correction, for flat areas: Shadows/Highlights on itself. */
function apply(input: AnalysisFrame, correction: AutoCorrection): AnalysisFrame {
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

/** Each frame's pixel saturations in `region`, linear (max − min) / max as Vibrance measures them. */
function saturations(input: readonly AnalysisFrame[], region: (x: number, y: number) => boolean = () => true) {
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
const meanSaturation = (values: number[][]): number => {
  const all = values.flat();
  return all.reduce((sum, value) => sum + value, 0) / all.length;
};
/** The median over frames of each frame's `q` quantile of saturation. */
const saturationQuantile = (values: number[][], q: number): number => {
  const quantiles = values.map((frame) => frame[Math.min(frame.length - 1, Math.floor(q * frame.length))]!);
  return quantiles.sort((a, b) => a - b)[Math.floor(quantiles.length / 2)]!;
};
/** Stops between the log-average and the darkest tenth of the areas, as the estimator measures them. */
const shadowDepth = (input: readonly AnalysisFrame[]): number => {
  const statistics = toneStatistics(input, { temperature: 0, tint: 0 })!;
  return Math.log2(statistics.logAverage / statistics.shadow);
};

describe('Auto adjust estimator', () => {
  it('leaves well-exposed, neutral, fairly colorful footage almost unchanged, but opens its darkest areas', () => {
    const input = frames(6, (seed) => scene(seed));
    const correction = analyze(input);
    expect(Math.abs(correction.temperature)).toBeLessThan(0.03);
    expect(Math.abs(correction.tint)).toBeLessThan(0.03);
    for (const setting of TONE)
      if (setting !== 'shadows') expect(Math.abs(correction[setting]), setting).toBeLessThan(0.03);
    expect(logged(correction.contrast)).toBeLessThan(0.03);
    expect(logged(correction.saturation)).toBeLessThan(0.05);
    expect(correction.vibrance).toBeLessThan(0.05);
    // Its darkest tenth of the areas sits more than shadowStops below the log-average: Shadows lifts it.
    const depth = shadowDepth(input);
    expect(depth).toBeGreaterThan(AUTO_ADJUST.shadowStops);
    expect(correction.shadows).toBeGreaterThan(0.3);
    expect(shadowDepth(input.map((item) => apply(item, correction)))).toBeLessThan(depth - 0.3);
  });

  it('does not open shadow areas that are already open', () => {
    // The same scene with no area darker than 0.25 encoded, and black speckles keeping its black point.
    const floor = decode709(0.25);
    const input = frames(6, (seed) => (x, y) => {
      if (hash(x, y, seed + 11) < 0.01) return [0.006, 0.006, 0.006];
      const pixel = scene(seed)(x, y);
      const level = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
      return pixel.map((value) => (value * Math.max(level, floor)) / level) as unknown as Linear;
    });
    expect(shadowDepth(input)).toBeLessThan(AUTO_ADJUST.shadowStops);
    expect(analyze(input).shadows).toBe(0);
  });

  it('restores the black and white points, midtone contrast and saturation of flat footage', () => {
    const input = frames(6, (seed) => flat(scene(seed)));
    const correction = analyze(input);
    expect(correction.blacks).toBeLessThan(0);
    expect(correction.contrast).toBeGreaterThan(1.1);
    expect(correction.saturation).toBeGreaterThan(1.1);
    expect(correction.vibrance).toBeGreaterThan(0.1);
    const corrected = input.map((item) => apply(item, correction));
    expect(meanSaturation(saturations(corrected))).toBeGreaterThan(1.2 * meanSaturation(saturations(input)));
    const before = measured(input);
    const after = measured(corrected);
    // One 8-bit step of tolerance for the corrected frames' quantization.
    expect(after.black).toBeGreaterThanOrEqual(AUTO_ADJUST.black[0] - 0.004);
    expect(after.black).toBeLessThanOrEqual(AUTO_ADJUST.black[1] + 0.004);
    expect(after.white).toBeGreaterThanOrEqual(AUTO_ADJUST.white[0] - 0.004);
    expect(after.white).toBeLessThanOrEqual(AUTO_ADJUST.white[1] + 0.004);
    expect(before.black).toBeGreaterThan(0.1);
    expect(before.white).toBeLessThan(0.82);
    // The output's midtone slope, measured on gray around the log-average, at least 1.3× the input's.
    const { temperature, tint, saturation, vibrance, ...tone } = correction;
    const render = renderFlat({ temperature, tint }, tone, { saturation, vibrance });
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
      analyze(frames(6, (seed) => scene(seed, { gain: 2 ** stops }))).exposure;
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
    const correction = analyze(frames(6, (seed) => scene(seed, { gain: 0.8, light })));
    if (temperature === 0) expect(Math.abs(correction.temperature)).toBeLessThan(0.05);
    else expect(Math.sign(correction.temperature)).toBe(temperature);
    expect(Math.sign(correction.tint)).toBe(tint);
    expect(Math.abs(correction.temperature)).toBeLessThanOrEqual(WHITE_BALANCE.temperatureLimit);
    expect(Math.abs(correction.tint)).toBeLessThanOrEqual(WHITE_BALANCE.tintLimit);
  });

  it('removes more of a cool cast than of an equally strong warm one', () => {
    const cool = analyze(frames(6, (seed) => scene(seed, { gain: 0.8, light: [0.85, 1, 1.18] })));
    const warm = analyze(frames(6, (seed) => scene(seed, { gain: 0.8, light: [1.18, 1, 0.85] })));
    expect(cool.temperature).toBeGreaterThan(0.2);
    expect(-warm.temperature).toBeLessThan(cool.temperature);
  });

  it('is nearly idempotent: analyzing its own output changes the image far less', () => {
    const input = frames(6, (seed) => scene(seed, { gain: 0.5, light: [0.85, 1, 1.18] }));
    const first = analyze(input);
    const once = input.map((item) => apply(item, first));
    const second = analyze(once);
    const twice = once.map((item) => apply(item, second));
    expect(change(once, twice)).toBeLessThan(0.2 * change(input, once));
  });

  it('settles the tone of flat footage in one pass', () => {
    const input = frames(6, (seed) => flat(scene(seed)));
    const first = analyze(input);
    const second = analyze(input.map((item) => apply(item, first)));
    // Shadows stops at its bound on flat footage and Vibrance spares its stronger colors, so a second pass
    // would still add some of both, and lower Blacks to keep the black point that Shadows lifts in its band.
    expect(first.shadows).toBe(0.5);
    const settled = ['exposure', 'brightness', 'highlights', 'whites'] as const;
    const size = (correction: AutoCorrection): number =>
      Math.hypot(...settled.map((setting) => correction[setting]), Math.log2(correction.contrast));
    expect(size(second)).toBeLessThan(0.2 * size(first));
  });

  it('is deterministic', () => {
    const input = frames(4, (seed) => flat(scene(seed, { light: [1.1, 1, 0.9] })));
    const first = analyze(input);
    const second = analyze(input);
    expect(second).toEqual(first);
    for (const setting of AUTO_ADJUST_SETTINGS) expect(Object.is(second[setting], first[setting])).toBe(true);
  });

  it('lets one outlier frame among sixteen barely move the result', () => {
    const steady = frames(16, (seed) => flat(scene(seed)));
    const flash = frame(() => [0.9, 0.85, 0.7]);
    const reference = analyze(steady);
    const disturbed = analyze([...steady.slice(0, 15), flash]);
    for (const setting of AUTO_ADJUST_SETTINGS) {
      const difference =
        setting === 'contrast' || setting === 'saturation'
          ? logged(disturbed[setting] / reference[setting])
          : Math.abs(disturbed[setting] - reference[setting]);
      expect(difference, setting).toBeLessThan(0.05);
    }
  });

  it('lowers the black point and adds contrast to hazy footage', () => {
    const correction = analyze(
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
    const correction = analyze(snow);
    const before = measured(snow);
    const after = measured(snow.map((item) => apply(item, correction)));
    expect(before.middle).toBeGreaterThan(0.6);
    expect(after.middle).toBeGreaterThan(0.6);
    expect(correction.exposure).toBeGreaterThan(-0.2);
  });

  it('does not lift night footage to mid-gray', () => {
    const night = frames(6, (seed) => (x, y) => {
      const level = 0.001 + 0.03 * hash(Math.floor(x / 6), Math.floor(y / 6), seed + 5) ** 2;
      return [level * 1.1, level, level * 0.8];
    });
    const correction = analyze(night);
    expect(measured(night).white).toBeLessThan(encode709(AUTO_ADJUST.lowLight));
    // The low-light guard halves the lift: Exposure stays at most half its bound.
    expect(correction.exposure).toBeLessThanOrEqual(0.75);
    expect(measured(night.map((item) => apply(item, correction))).middle).toBeLessThan(0.25);
  });

  it('does not neutralize a sky- and sea-dominated frame to gray', () => {
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
    const correction = analyze(view);
    // Gray World would warm this view by its whole blue/red imbalance; Auto keeps it blue.
    const means = [0, 1, 2].map((channel) => {
      let sum = 0;
      for (const item of view)
        for (let index = channel; index < item.data.length; index += 4) sum += decode709(item.data[index]! / 255);
      return sum;
    });
    const grayWorld = Math.log2(means[2]! / means[0]!);
    expect(grayWorld).toBeGreaterThan(1);
    expect(Math.abs(correction.temperature)).toBeLessThan(0.2 * grayWorld);
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
    const correction = analyze(sunset);
    expect(correction.temperature).toBeLessThan(0);
    expect(correction.temperature).toBeGreaterThanOrEqual(-WHITE_BALANCE.temperatureLimit);
    const [red, , blue] = temperatureTintGains(correction);
    expect((0.9 * red) / (0.1 * blue)).toBeGreaterThan(4);
  });

  it('gives no correction without usable pixels', () => {
    expect(analyzeAutoAdjust([frame(() => [0, 0, 0])])).toBeNull();
    expect(analyzeAutoAdjust([])).toBeNull();
  });

  it('takes the same Temperature and Tint as Auto white balance from the same frames', () => {
    for (const light of [
      [1.25, 1, 0.8],
      [0.85, 1, 1.2],
      [1, 1.15, 1],
      [1, 1, 1],
    ] as const) {
      const input = frames(16, (seed) => scene(seed, { light }));
      const balance = poolWhiteBalance(input.map(frameIlluminant))!;
      const correction = analyze(input);
      expect({ temperature: correction.temperature, tint: correction.tint }, String(light)).toEqual(balance);
    }
  });

  it('raises the color of muted footage with both Saturation and Vibrance', () => {
    const input = frames(6, (seed) => scene(seed, { chroma: 0.15 }));
    const correction = analyze(input);
    // Saturation takes its whole share of the 1.5 gain, Vibrance brings the muted colors to the rest.
    expect(correction.saturation).toBeCloseTo(1.5 ** AUTO_ADJUST.saturationShare, 2);
    expect(correction.vibrance).toBeGreaterThan(0.1);
    const corrected = input.map((item) => apply(item, correction));
    expect(meanSaturation(saturations(corrected))).toBeGreaterThan(1.25 * meanSaturation(saturations(input)));
  });

  it('keeps the color of monochrome footage', () => {
    const correction = analyze(frames(6, (seed) => scene(seed, { chroma: 0 })));
    expect(correction.saturation).toBe(1);
    expect(correction.vibrance).toBe(0);
  });

  it('lowers the Saturation of very colorful footage, without Vibrance', () => {
    const correction = analyze(frames(6, (seed) => scene(seed, { chroma: 1.6 })));
    expect(correction.saturation).toBeLessThan(1);
    expect(correction.saturation).toBeGreaterThanOrEqual(AUTO_ADJUST.minimumSaturation);
    expect(correction.vibrance).toBe(0);
  });

  it('barely pushes a saturated sky that fills the frame, which measures dull for its uniformity', () => {
    const sky = frames(6, (seed) => (x, y) => {
      const haze = y / 90;
      const grain = 0.98 + 0.04 * hash(x, y, seed);
      return [(0.15 + 0.2 * haze) * grain, (0.3 + 0.2 * haze) * grain, (0.7 + 0.05 * haze) * grain];
    });
    const correction = analyze(sky);
    // Saturation gives way entirely, and Vibrance as far as the strong colors require.
    expect(correction.saturation).toBe(1);
    const before = saturations(sky);
    const after = saturations(sky.map((item) => apply(item, correction)));
    expect(saturationQuantile(before, AUTO_ADJUST.strongQuantile)).toBeGreaterThan(AUTO_ADJUST.strongCeiling);
    // Its strongest tenth rises by at most strongMargin (with 8-bit quantization); its paler, lower part
    // may rise to strongCeiling. A Saturation of 1.5 took the sky from 0.66 to 0.80 on average.
    expect(saturationQuantile(after, AUTO_ADJUST.strongQuantile)).toBeLessThanOrEqual(
      saturationQuantile(before, AUTO_ADJUST.strongQuantile) + AUTO_ADJUST.strongMargin + 0.01,
    );
    expect(meanSaturation(after) - meanSaturation(before)).toBeLessThan(0.1);
  });

  it('keeps the sky above snow at its saturation while the snow gains color', () => {
    const isSky = (_x: number, y: number): boolean => y < 18;
    const view = frames(6, (seed) => (x, y) => {
      if (isSky(x, y)) {
        const haze = y / 18;
        const grain = 0.98 + 0.04 * hash(x, y, seed);
        return [(0.12 + 0.2 * haze) * grain, (0.28 + 0.18 * haze) * grain, (0.72 + 0.03 * haze) * grain];
      }
      const rock = hash(Math.floor(x / 6), Math.floor(y / 6), seed + 3) < 0.2;
      const level = rock
        ? 0.03 + 0.05 * hash(x, y, seed)
        : 0.45 + 0.3 * hash(Math.floor(x / 3), Math.floor(y / 3), seed);
      return [level * 0.97, level, level * 1.04];
    });
    const correction = analyze(view);
    // Saturation's share of the 1.39 gain mostly gives way to Vibrance.
    expect(correction.saturation).toBeGreaterThan(1);
    expect(correction.saturation).toBeLessThan(1.1);
    expect(correction.vibrance).toBeGreaterThan(0.1);
    const corrected = view.map((item) => apply(item, correction));
    // A Saturation of 1.39 took this sky from 0.71 to 0.80.
    expect(meanSaturation(saturations(corrected, isSky))).toBeLessThanOrEqual(
      meanSaturation(saturations(view, isSky)) + AUTO_ADJUST.strongMargin,
    );
  });
});

describe('Auto adjust intensity and frames', () => {
  const correction: AutoCorrection = {
    temperature: 0.4,
    tint: -0.2,
    saturation: 1.44,
    vibrance: 0.4,
    exposure: 1,
    brightness: 0.1,
    contrast: 1.21,
    highlights: -0.3,
    shadows: 0.2,
    whites: 0.5,
    blacks: -0.6,
  };

  it('applies the correction as fitted at 80%, scaled from neutral below: linearly, Contrast and Saturation geometrically', () => {
    expect(AUTO_ADJUST.balancedIntensity).toBe(0.8);
    expect(scaleCorrection(correction, 0.8)).toEqual(correction);
    const half = scaleCorrection(correction, 0.4);
    expect(half).toEqual({
      temperature: 0.2,
      tint: -0.1,
      saturation: 1.2,
      vibrance: 0.2,
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

  it("exaggerates the correction by a quarter at 100%, within each setting's bounds", () => {
    expect(scaleCorrection(correction, 1)).toEqual({
      temperature: 0.5,
      tint: -0.25,
      saturation: 1.577,
      vibrance: 0.5,
      exposure: 1.25,
      brightness: 0.125,
      contrast: 1.269,
      highlights: -0.375,
      shadows: 0.25,
      whites: 0.625,
      blacks: -0.75,
    });
    const strong = scaleCorrection({ ...correction, contrast: 1.8, whites: 0.9, blacks: -1 }, 1);
    expect([strong.contrast, strong.whites, strong.blacks]).toEqual([2, 1, -1]);
  });

  it('analyzes the centers of up to sixteen equal slices of the source range', () => {
    expect(autoAdjustFrames(100, 420)).toEqual(Array.from({ length: 16 }, (_, index) => 110 + 20 * index));
    expect(autoAdjustFrames(5, 8)).toEqual([5, 6, 7]);
    expect(autoAdjustFrames(7, 8)).toEqual([7]);
    expect(() => autoAdjustFrames(8, 8)).toThrow(/at least one frame/);
  });
});
