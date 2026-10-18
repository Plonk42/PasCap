import { describe, expect, it } from 'vitest';
import { ColourLutCache } from '../../src/server/layered-colour.js';
import { composeLayerFrame, composeRows, type FrameSource } from '../../src/server/layered-frame.js';
import {
  colourSchema,
  createColourSettings,
  decode709,
  encode709,
  gradePixel,
  isNeutralColour,
  type RGB,
} from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import {
  compileDetail,
  createDetailSettings,
  denoiseRangeFactor,
  detailSchema,
  detailTapCount,
  isNeutralDetail,
  NEUTRAL_DETAIL,
  type DetailSettings,
  type LocalTone,
} from '../../src/shared/detail.js';
import { needsLayeredExport } from '../../src/shared/export.js';
import { clipSchema, createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { compileSpatialMapping, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout, sampleTimeline, type PreviewLayer } from '../../src/shared/timeline.js';

type Image = (u: number, v: number) => RGB;
type Tone = Partial<LocalTone>;
const toneOf = (tone: Tone): LocalTone => ({
  shadows: 0,
  highlights: 0,
  hdr: 0,
  localContrast: 0,
  exposure: 0,
  ...tone,
});

/** Independent transcription of the documented kernel, without the production tap tables. */
function reference(
  image: Image,
  u: number,
  v: number,
  settings: DetailSettings,
  aspect: number,
  tone: Tone = {},
  lines = 720,
): RGB {
  const { shadows, highlights, hdr, localContrast, exposure } = toneOf(tone);
  const dv = 1 / 720;
  const du = dv / aspect;
  const luma = (rgb: RGB): number => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const centre = image(u, v);
  const neutral = settings.sharpen === 0 && settings.clarity === 0 && settings.denoise === 0;
  // Above 720 lines detail is measured half a pixel (at most) down and right, then applied to the pixel.
  const shift = neutral ? 0 : 0.5 * Math.min(1, Math.max(0, lines / 720 - 1));
  const mu = u + shift / lines / aspect;
  const mv = v + shift / lines;
  const measured = shift > 0 ? image(mu, mv) : centre;
  let denoised: RGB = measured;
  let gaussian: RGB = measured;
  let low = luma(measured);
  let high = low;
  if (settings.sharpen > 0 || settings.denoise > 0) {
    const sigma = 0.1 * settings.denoise;
    const sumG = [0, 0, 0];
    const sumD = [0, 0, 0];
    let weightG = 0;
    let weightD = 0;
    for (const radius of [1, 2])
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          if (radius === 2 && i === 0 && j === 0) continue;
          const x = i * radius;
          const y = j * radius;
          const tap = image(mu + x * du, mv + y * dv);
          const spatial = Math.exp(-(x * x + y * y) / 2);
          if (radius === 1) {
            weightG += spatial;
            tap.forEach((channel, index) => (sumG[index]! += spatial * channel));
            low = Math.min(low, luma(tap));
            high = Math.max(high, luma(tap));
          }
          if (settings.denoise > 0) {
            const meanSquare = tap.reduce((sum, channel, index) => sum + (channel - measured[index]!) ** 2, 0) / 3;
            const range = Math.exp(-meanSquare / (2 * sigma * sigma));
            weightD += spatial * range;
            tap.forEach((channel, index) => (sumD[index]! += spatial * range * channel));
          }
        }
    gaussian = sumG.map((sum) => sum / weightG) as unknown as RGB;
    if (settings.denoise > 0) denoised = sumD.map((sum) => sum / weightD) as unknown as RGB;
  }
  const detailBase = luma(denoised);
  // Edge-aware base: three rings of eight (the middle one turned 22.5°), range weights against
  // the mean of the centre and first ring.
  const edgeBase = (
    cu: number,
    cv: number,
    y: number,
    radii: number[],
    spatialSigma: number,
    rangeSigma: number,
  ): number => {
    const taps: { level: number; spatial: number }[] = [];
    radii.forEach((radius, ring) => {
      for (let k = 0; k < 8; k++) {
        const angle = (k * Math.PI) / 4 + (ring === 1 ? Math.PI / 8 : 0);
        taps.push({
          level: luma(image(cu + Math.cos(angle) * radius * du, cv + Math.sin(angle) * radius * dv)),
          spatial: Math.exp(-(radius * radius) / (2 * spatialSigma ** 2)),
        });
      }
    });
    const guide = (y + taps.slice(0, 8).reduce((sum, tap) => sum + tap.level, 0)) / 9;
    const range = (level: number): number => Math.exp(-((level - guide) ** 2) / (2 * rangeSigma ** 2));
    let sum = range(y) * y;
    let total = range(y);
    for (const { level, spatial } of taps) {
      sum += spatial * range(level) * level;
      total += spatial * range(level);
    }
    return sum / total;
  };
  let delta = 0;
  if (settings.clarity !== 0) {
    const mean = edgeBase(mu, mv, detailBase, [3, 6, 10], 6, 0.1);
    delta += settings.clarity * Math.min(1, Math.max(0, 4 * detailBase * (1 - detailBase))) * (detailBase - mean);
  }
  if (settings.sharpen > 0) {
    const fine = detailBase - luma(gaussian);
    const sharpened = detailBase + (2 * settings.sharpen * fine ** 3) / (fine ** 2 + 0.004 ** 2);
    const top = Math.max(high, detailBase);
    const bottom = Math.min(low, detailBase);
    const ease = (excess: number): number => 0.05 * Math.tanh(Math.min(10, excess / 0.05));
    let limited = sharpened;
    if (sharpened > top) limited = top + ease(sharpened - top);
    if (sharpened < bottom) limited = bottom - ease(bottom - sharpened);
    delta += limited - detailBase;
  }
  if (shift > 0) {
    const core = 0.5 * 0.1 * settings.denoise;
    denoised = denoised.map((channel, index) => {
      const finer = centre[index]! - measured[index]!;
      return channel + (core > 0 ? finer ** 3 / (finer ** 2 + core ** 2) : finer);
    }) as unknown as RGB;
  }
  const base = luma(denoised);
  if (hdr > 0 || localContrast !== 0 || shadows !== 0 || highlights !== 0) {
    const b = edgeBase(u, v, base, [6, 16, 32], 16, 0.12);
    if (hdr > 0 || localContrast !== 0) {
      const target = b + hdr * b * (1 - b) * (1 - 2 * b) + (base - b) * (1 + localContrast);
      const lift = target - base;
      const blend = Math.min(1, base / 0.1);
      denoised = denoised.map((channel) =>
        base > 0 ? channel + lift + blend * ((channel * target) / base - channel - lift) : channel + lift,
      ) as unknown as RGB;
    }
    if (shadows !== 0 || highlights !== 0) {
      const stops = Math.log2(Math.max(2 ** -16, decode709(b) * 2 ** exposure));
      const ramp = (x: number): number => (x <= 0 ? 0 : x < 1 ? x ** 3 - x ** 4 / 2 : x - 0.5);
      const distance = (x: number): number => ramp(x) - ramp(x - 4);
      const grey = Math.log2(0.18);
      const gain = 2 ** (0.5 * (shadows * distance(grey - stops) + highlights * distance(stops - grey)));
      denoised = denoised.map((channel) => encode709(decode709(channel) * gain)) as unknown as RGB;
    }
  }
  return denoised.map((channel) => Math.min(1, Math.max(0, channel + delta))) as unknown as RGB;
}

function run(
  image: Image,
  u: number,
  v: number,
  settings: DetailSettings,
  aspect = 16 / 9,
  tone: Tone = {},
  lines = 720,
): RGB {
  const filter = compileDetail(settings, aspect, toneOf(tone), lines);
  if (!filter) return image(u, v);
  const out = new Float64Array(3);
  filter.apply(
    (x, y, target) => {
      target.set(image(x, y));
    },
    u,
    v,
    out,
  );
  return [out[0]!, out[1]!, out[2]!];
}

const textured: Image = (u, v) => [
  0.5 + 0.3 * Math.sin(u * 97 + v * 31),
  0.45 + 0.25 * Math.cos(u * 53 - v * 71),
  0.4 + 0.2 * Math.sin(u * 211 + v * 173),
];

describe('clip detail settings', () => {
  it('requires exactly three bounded fields on every clip and keeps neutral exact', () => {
    const clip = createClip('clip', 'media', 0, 10);
    expect(clip.detail).toEqual({ sharpen: 0, clarity: 0, denoise: 0 });
    expect(createDetailSettings()).not.toBe(createDetailSettings());
    const { detail: _detail, ...withoutDetail } = clip;
    expect(clipSchema.safeParse(withoutDetail).success).toBe(false);
    for (const invalid of [
      { sharpen: -0.01, clarity: 0, denoise: 0 },
      { sharpen: 1.01, clarity: 0, denoise: 0 },
      { sharpen: 0, clarity: -1.01, denoise: 0 },
      { sharpen: 0, clarity: 1.01, denoise: 0 },
      { sharpen: 0, clarity: 0, denoise: -0.01 },
      { sharpen: 0, clarity: 0, denoise: 1.01 },
      { sharpen: Number.NaN, clarity: 0, denoise: 0 },
      { sharpen: 0, clarity: 0 },
      { sharpen: 0, clarity: 0, denoise: 0, radius: 1 },
    ])
      expect(detailSchema.safeParse(invalid).success).toBe(false);
    expect(isNeutralDetail(NEUTRAL_DETAIL)).toBe(true);
    expect(isNeutralDetail({ sharpen: Number.MIN_VALUE, clarity: 0, denoise: 0 })).toBe(false);
    expect(compileDetail(NEUTRAL_DETAIL, 1, toneOf({}), 720)).toBeNull();
  });

  it('counts the kernel taps each setting adds', () => {
    expect(detailTapCount(NEUTRAL_DETAIL, false)).toBe(0);
    expect(detailTapCount({ sharpen: 0.3, clarity: 0, denoise: 0 }, false)).toBe(8);
    expect(detailTapCount({ sharpen: 0, clarity: 0, denoise: 0.2 }, false)).toBe(16);
    expect(detailTapCount({ sharpen: 0, clarity: -0.5, denoise: 0 }, false)).toBe(24);
    expect(detailTapCount(NEUTRAL_DETAIL, true)).toBe(24);
    expect(detailTapCount({ sharpen: 0.4, clarity: 0.5, denoise: 0.3 }, true)).toBe(64);
  });

  it('matches an independent transcription of the Denoise → Clarity → Sharpen kernel', () => {
    const cases: DetailSettings[] = [
      { sharpen: 1, clarity: 0, denoise: 0 },
      { sharpen: 0, clarity: 0.7, denoise: 0 },
      { sharpen: 0, clarity: -1, denoise: 0 },
      { sharpen: 0, clarity: 0, denoise: 0.6 },
      { sharpen: 0.35, clarity: 0.4, denoise: 0.8 },
    ];
    for (const settings of cases)
      for (const [u, v] of [
        [0.31, 0.43],
        [0.02, 0.97],
        [0.77, 0.12],
      ]) {
        const actual = run(textured, u!, v!, settings, 4 / 3);
        reference(textured, u!, v!, settings, 4 / 3).forEach((channel, index) =>
          expect(actual[index]).toBeCloseTo(channel, 12),
        );
      }
  });

  it('measures detail at 720p scale on larger images, keeping finer detail as it is', () => {
    for (const lines of [1080, 1440, 2160])
      for (const settings of [
        { sharpen: 1, clarity: 0, denoise: 0 },
        { sharpen: 0.35, clarity: 0.4, denoise: 0.8 },
      ])
        for (const [u, v] of [
          [0.31, 0.43],
          [0.02, 0.97],
        ]) {
          const actual = run(textured, u!, v!, settings, 4 / 3, { hdr: 0.3 }, lines);
          reference(textured, u!, v!, settings, 4 / 3, { hdr: 0.3 }, lines).forEach((channel, index) =>
            expect(actual[index]).toBeCloseTo(channel, 12),
          );
        }
    const sharp = { sharpen: 1, clarity: 0, denoise: 0 };
    const gain = (period: number, lines: number): number => {
      const width = lines * (16 / 9);
      const stripes: Image = (u) => {
        const level = 0.5 + 0.05 * Math.cos(((u * width - 0.5) * 2 * Math.PI) / period);
        return [level, level, level];
      };
      let peak = 0;
      for (let x = 100; x < 100 + 2 * period; x++)
        peak = Math.max(peak, Math.abs(run(stripes, (x + 0.5) / width, 0.5, sharp, 16 / 9, {}, lines)[0]! - 0.5));
      return peak / 0.05;
    };
    // UHD pixel-level stripes, invisible at 720p, are no longer boosted like 720p detail.
    expect(gain(2, 2160)).toBeLessThan(1.1);
    expect(gain(4, 2160)).toBeLessThan(1.7);
    // Detail the 720p preview shows is sharpened in UHD as in the preview.
    expect(gain(6, 2160)).toBeGreaterThan(0.85 * gain(2, 720));
    expect(gain(9, 2160)).toBeGreaterThan(0.85 * gain(3, 720));
  });

  it('leaves flat footage unchanged and stays finite for the tiniest strengths', () => {
    const flat: Image = () => [0.25, 0.5, 0.75];
    run(flat, 0.5, 0.5, { sharpen: 1, clarity: 1, denoise: 1 }).forEach((channel, index) =>
      expect(channel).toBeCloseTo([0.25, 0.5, 0.75][index]!, 14),
    );
    const tiny = { sharpen: 0, clarity: 0, denoise: Number.MIN_VALUE };
    expect(denoiseRangeFactor(Number.MIN_VALUE)).toBe(1e30);
    expect(run(textured, 0.4, 0.6, tiny).every(Number.isFinite)).toBe(true);
    run(flat, 0.4, 0.6, tiny).forEach((channel, index) => expect(channel).toBeCloseTo([0.25, 0.5, 0.75][index]!, 14));
  });

  it('sharpens an edge, adds or removes clarity and denoises without blurring a strong edge', () => {
    const edge: Image = (u) => (u < 0.5 ? [0.3, 0.3, 0.3] : [0.7, 0.7, 0.7]);
    const pixel = 1 / 720 / (16 / 9);
    const left = 0.5 - pixel / 2;
    const right = 0.5 + pixel / 2;
    const sharp = { sharpen: 1, clarity: 0, denoise: 0 };
    expect(run(edge, left, 0.5, sharp)[0]).toBeLessThan(0.3);
    expect(run(edge, right, 0.5, sharp)[0]).toBeGreaterThan(0.7);
    // Halo control: a hard step overshoots by at most 0.05 instead of turning black or white.
    expect(run(edge, left, 0.5, sharp)[0]).toBeGreaterThanOrEqual(0.25);
    expect(run(edge, right, 0.5, sharp)[0]).toBeLessThanOrEqual(0.75);
    // A soft edge still steepens inside its range, near its knee.
    const ramp: Image = (u) => {
      const level = Math.min(0.7, Math.max(0.3, 0.5 + (u - 0.5) * 1280 * 0.05));
      return [level, level, level];
    };
    const knee = 0.5 + 3.5 * pixel;
    expect(run(ramp, knee, 0.5, sharp)[0]).toBeGreaterThan(ramp(knee, 0.5)[0] + 0.01);
    expect(run(ramp, knee, 0.5, sharp)[0]).toBeLessThanOrEqual(0.7);
    // Texture keeps nearly all of its sharpening.
    const texture: Image = (u) => {
      const level = 0.5 + 0.04 * Math.cos(((u * 1280 - 0.5) * 2 * Math.PI) / 6);
      return [level, level, level];
    };
    expect(run(texture, 6.5 / 1280, 0.5, sharp)[0]! - 0.5).toBeGreaterThan(1.4 * 0.04);
    // Grain-sized detail is left alone rather than amplified.
    const faint: Image = (u) => {
      const level = 0.5 + 0.003 * Math.cos(((u * 1280 - 0.5) * 2 * Math.PI) / 6);
      return [level, level, level];
    };
    expect(run(faint, 6.5 / 1280, 0.5, sharp)[0]! - 0.5).toBeLessThan(1.05 * 0.003);
    const near = 0.5 + 4 * pixel;
    // Clarity leaves the bright side of a strong edge alone instead of drawing a halo band.
    for (const clarity of [-1, 1])
      expect(Math.abs(run(edge, near, 0.5, { sharpen: 0, clarity, denoise: 0 })[0]! - 0.7)).toBeLessThan(0.005);
    // It still lifts or flattens mid-scale texture.
    const bumps: Image = (u) => {
      const level = 0.5 + 0.05 * Math.cos(((u * 1280 - 0.5) * 2 * Math.PI) / 16);
      return [level, level, level];
    };
    const crest = 16.5 / 1280;
    expect(run(bumps, crest, 0.5, { sharpen: 0, clarity: 1, denoise: 0 })[0]).toBeGreaterThan(0.56);
    expect(run(bumps, crest, 0.5, { sharpen: 0, clarity: -1, denoise: 0 })[0]).toBeLessThan(0.54);
    let seed = 7;
    const noise = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32 - 0.5;
    };
    const grain = new Map<string, number>();
    const noisy: Image = (u, v) => {
      const key = `${Math.round(u * 1280)}:${Math.round(v * 720)}`;
      if (!grain.has(key)) grain.set(key, 0.06 * noise());
      const value = (u < 0.5 ? 0.2 : 0.8) + grain.get(key)!;
      return [value, value, value];
    };
    const spread = (settings: DetailSettings): number => {
      let sum = 0;
      for (let index = 0; index < 50; index++) sum += (run(noisy, 0.25 + index * pixel, 0.5, settings)[0]! - 0.2) ** 2;
      return Math.sqrt(sum / 50);
    };
    expect(spread({ sharpen: 0, clarity: 0, denoise: 1 })).toBeLessThan(spread(NEUTRAL_DETAIL) * 0.75);
    const denoise = { sharpen: 0, clarity: 0, denoise: 1 };
    expect(run(noisy, left, 0.5, denoise)[0]).toBeLessThan(0.3);
    expect(run(noisy, right, 0.5, denoise)[0]).toBeGreaterThan(0.7);
  });
});

describe('track HDR look', () => {
  it('is a bounded track Colour channel that skips the per-pixel grade', () => {
    expect(createColourSettings().hdr).toBe(0);
    expect(colourSchema.safeParse({ ...createColourSettings(), hdr: 1.01 }).success).toBe(false);
    expect(colourSchema.safeParse({ ...createColourSettings(), hdr: -0.01 }).success).toBe(false);
    const { hdr: _hdr, ...missing } = createColourSettings();
    expect(colourSchema.safeParse(missing).success).toBe(false);
    const hdrOnly = { ...createColourSettings(), hdr: 0.8 };
    expect(isNeutralColour(hdrOnly)).toBe(false);
    const input: RGB = [0.2, 0.4, 0.6];
    expect(gradePixel(input, hdrOnly)).toBe(input);
    expect(compileDetail(NEUTRAL_DETAIL, 1, toneOf({ hdr: 0.01 }), 720)).not.toBeNull();
    for (const invalid of [-0.01, 1.01, Number.NaN])
      expect(() => compileDetail(NEUTRAL_DETAIL, 1, toneOf({ hdr: invalid }), 720)).toThrow();
  });

  it('matches an independent transcription of the Denoise → HDR → Clarity → Sharpen kernel', () => {
    const cases: [DetailSettings, number][] = [
      [NEUTRAL_DETAIL, 0.5],
      [NEUTRAL_DETAIL, 1],
      [{ sharpen: 0.35, clarity: 0.4, denoise: 0.8 }, 0.7],
    ];
    for (const [settings, hdr] of cases)
      for (const [u, v] of [
        [0.31, 0.43],
        [0.02, 0.97],
        [0.77, 0.12],
      ]) {
        const actual = run(textured, u!, v!, settings, 4 / 3, { hdr });
        reference(textured, u!, v!, settings, 4 / 3, { hdr }).forEach((channel, index) =>
          expect(actual[index]).toBeCloseTo(channel, 12),
        );
      }
  });

  it('keeps black, mid-grey and white, lifts shadows and recovers highlights on flat areas', () => {
    const flat =
      (level: number): Image =>
      () => [level, level, level];
    for (const level of [0, 0.5, 1])
      expect(run(flat(level), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 })[0]).toBeCloseTo(level, 12);
    expect(run(flat(0.2), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 })[0]).toBeGreaterThan(0.25);
    expect(run(flat(0.8), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 })[0]).toBeLessThan(0.75);
    const dimmer = run(flat(0.2), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 0.3 })[0]!;
    expect(dimmer).toBeGreaterThan(0.2);
    expect(dimmer).toBeLessThan(run(flat(0.2), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 })[0]!);
  });

  it('keeps local detail without boosting it, preserves hue in colour and does not halo across a strong edge', () => {
    const fine: Image = (u) => {
      const level = 0.5 + 0.05 * Math.sin(u * 1280 * 0.7);
      return [level, level, level];
    };
    const u = (Math.PI / 2 / 0.7 + 0.5) / 1280;
    const input = fine(u, 0.5)[0] - 0.5;
    const kept = run(fine, u, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 })[0]! - 0.5;
    expect(Math.abs(kept - input)).toBeLessThan(0.2 * input);
    // HDR 1 with Local contrast 1 is the former HDR 1, detail boost included.
    expect(run(fine, u, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1, localContrast: 1 })[0]! - 0.5).toBeGreaterThan(
      1.6 * input,
    );
    const tinted: Image = () => [0.3, 0.2, 0.1];
    const [red, green, blue] = run(tinted, 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 });
    expect(red! / blue!).toBeCloseTo(3, 10);
    expect(green! / blue!).toBeCloseTo(2, 10);
    const edge: Image = (x) => (x < 0.5 ? [0.1, 0.1, 0.1] : [0.9, 0.9, 0.9]);
    const pixel = 1 / 720 / (16 / 9);
    const near = run(edge, 0.5 - 3 * pixel, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 })[0]!;
    const far = run(edge, 0.2, 0.5, NEUTRAL_DETAIL, 16 / 9, { hdr: 1 })[0]!;
    expect(far).toBeGreaterThan(0.15);
    expect(Math.abs(near - far)).toBeLessThan(1e-3);
  });

  it('routes nonzero or keyed track HDR through the composited exporter', () => {
    const document = project(NEUTRAL_DETAIL);
    const layer = document.layers[0]!;
    expect(needsLayeredExport(document)).toBe(false);
    const withHdr = { ...document, layers: [{ ...layer, colour: { ...layer.colour, hdr: 0.4 } }] };
    expect(needsLayeredExport(projectSchema.parse(withHdr))).toBe(true);
    const keyed = applyCommand(document, {
      type: 'layer-key-toggle',
      layerId: layer.id,
      frame: 5,
      setting: 'hdr',
      value: 0.6,
    });
    expect(keyed.layers[0]!.keyframes[0]!.values.hdr).toBe(0.6);
    expect(sampleTimeline(keyed, 20)[0]!.colour.hdr).toBe(0.6);
    expect(needsLayeredExport(keyed)).toBe(true);
  });
});

describe('track Local contrast', () => {
  const fine: Image = (u) => {
    const level = 0.5 + 0.05 * Math.sin(u * 1280 * 0.7);
    return [level, level, level];
  };
  const crest = (Math.PI / 2 / 0.7 + 0.5) / 1280;

  it('is a bounded keyframable channel outside the per-pixel grade', () => {
    expect(createColourSettings().localContrast).toBe(0);
    for (const invalid of [-1.01, 1.01])
      expect(colourSchema.safeParse({ ...createColourSettings(), localContrast: invalid }).success).toBe(false);
    const { localContrast: _localContrast, ...missing } = createColourSettings();
    expect(colourSchema.safeParse(missing).success).toBe(false);
    const settings = { ...createColourSettings(), localContrast: -0.4 };
    expect(isNeutralColour(settings)).toBe(false);
    const input: RGB = [0.2, 0.4, 0.6];
    expect(gradePixel(input, settings)).toBe(input);
    expect(compileDetail(NEUTRAL_DETAIL, 1, toneOf({ localContrast: 0.01 }), 720)).not.toBeNull();
    for (const invalid of [-1.01, 1.01, Number.NaN])
      expect(() => compileDetail(NEUTRAL_DETAIL, 1, toneOf({ localContrast: invalid }), 720)).toThrow();
  });

  it('matches the transcription alone and added to HDR', () => {
    const cases: [DetailSettings, Tone][] = [
      [NEUTRAL_DETAIL, { localContrast: 1 }],
      [NEUTRAL_DETAIL, { localContrast: -0.7 }],
      [
        { sharpen: 0.35, clarity: 0.4, denoise: 0.8 },
        { hdr: 0.5, localContrast: 0.6, shadows: 0.4 },
      ],
    ];
    for (const [settings, tone] of cases)
      for (const [u, v] of [
        [0.31, 0.43],
        [0.02, 0.97],
        [0.77, 0.12],
      ]) {
        const actual = run(textured, u!, v!, settings, 4 / 3, tone);
        reference(textured, u!, v!, settings, 4 / 3, tone).forEach((channel, index) =>
          expect(actual[index]).toBeCloseTo(channel, 12),
        );
      }
  });

  it("is HDR's former detail boost on its own: flat areas never move", () => {
    for (const level of [0, 0.1, 0.5, 0.9, 1])
      for (const localContrast of [-1, 1])
        expect(run(() => [level, level, level], 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { localContrast })[0]).toBeCloseTo(
          level,
          12,
        );
    const input = fine(crest, 0.5)[0] - 0.5;
    const boosted = run(fine, crest, 0.5, NEUTRAL_DETAIL, 16 / 9, { localContrast: 1 })[0]! - 0.5;
    expect(boosted).toBeGreaterThan(1.6 * input);
    expect(Math.abs(run(fine, crest, 0.5, NEUTRAL_DETAIL, 16 / 9, { localContrast: -1 })[0]! - 0.5)).toBeLessThan(
      0.5 * input,
    );
  });

  it('routes a nonzero value through the composited exporter', () => {
    const document = project(NEUTRAL_DETAIL);
    const layer = document.layers[0]!;
    const edited = { ...document, layers: [{ ...layer, colour: { ...layer.colour, localContrast: -0.2 } }] };
    expect(needsLayeredExport(projectSchema.parse(edited))).toBe(true);
  });
});

describe('local Shadows and Highlights', () => {
  const flat =
    (level: number): Image =>
    () => [level, level, level];
  const grey = encode709(0.18);

  it('skip the per-pixel grade and validate their evaluated amounts', () => {
    const input: RGB = [0.2, 0.4, 0.6];
    for (const setting of ['shadows', 'highlights'] as const) {
      const settings = { ...createColourSettings(), [setting]: -0.6 };
      expect(isNeutralColour(settings)).toBe(false);
      expect(gradePixel(input, settings)).toBe(input);
      expect(compileDetail(NEUTRAL_DETAIL, 1, toneOf({ [setting]: 0.01 }), 720)).not.toBeNull();
      for (const invalid of [-1.01, 1.01, Number.NaN])
        expect(() => compileDetail(NEUTRAL_DETAIL, 1, toneOf({ [setting]: invalid }), 720)).toThrow();
    }
    expect(() => compileDetail(NEUTRAL_DETAIL, 1, toneOf({ shadows: 0.5, exposure: Number.NaN }), 720)).toThrow();
    // Exposure alone is graded per pixel, never in this stage.
    expect(compileDetail(NEUTRAL_DETAIL, 1, toneOf({ exposure: 1 }), 720)).toBeNull();
  });

  it('matches an independent transcription, combined with detail, HDR and Exposure', () => {
    const cases: [DetailSettings, Tone][] = [
      [NEUTRAL_DETAIL, { shadows: 1 }],
      [NEUTRAL_DETAIL, { highlights: -1 }],
      [NEUTRAL_DETAIL, { shadows: -0.6, highlights: 0.8, exposure: -1.2 }],
      [
        { sharpen: 0.35, clarity: 0.4, denoise: 0.8 },
        { shadows: 0.7, highlights: -0.4, hdr: 0.5, exposure: 0.6 },
      ],
    ];
    for (const [settings, tone] of cases)
      for (const [u, v] of [
        [0.31, 0.43],
        [0.02, 0.97],
        [0.77, 0.12],
      ]) {
        const actual = run(textured, u!, v!, settings, 4 / 3, tone);
        reference(textured, u!, v!, settings, 4 / 3, tone).forEach((channel, index) =>
          expect(actual[index]).toBeCloseTo(channel, 12),
        );
      }
  });

  it('keep black, mid-grey and white in place and move tones monotonically on flat areas', () => {
    const at = (level: number, tone: Tone): number => run(flat(level), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, tone)[0]!;
    expect(at(0, { shadows: 1 })).toBe(0);
    expect(at(grey, { shadows: 1, highlights: -1 })).toBeCloseTo(grey, 12);
    expect(at(1, { shadows: 1 })).toBeCloseTo(1, 12);
    // At ±1 the deepest shadows move by two stops; tones above mid-grey are untouched.
    expect(decode709(at(0.02, { shadows: 1 }))).toBeCloseTo(4 * decode709(0.02), 10);
    expect(decode709(at(0.02, { shadows: -1 }))).toBeCloseTo(decode709(0.02) / 4, 10);
    expect(at(0.7, { shadows: 1 })).toBeCloseTo(0.7, 12);
    expect(at(0.3, { highlights: -1 })).toBeCloseTo(0.3, 12);
    expect(at(1, { highlights: -1 })).toBeLessThan(0.75);
    for (const tone of [{ shadows: 1 }, { shadows: -1 }, { highlights: 1 }, { highlights: -1 }]) {
      let previous = -1;
      for (let level = 0; level <= 1; level += 1 / 64) {
        const value = at(level, tone);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
    expect(at(0.2, { shadows: 1 })).toBeGreaterThan(at(0.2, { shadows: 0.3 }));
    expect(at(0.2, { shadows: 0.3 })).toBeGreaterThan(0.2);
  });

  it('choose tones after Exposure', () => {
    // 2.5 stops brighter, encoded 0.1 sits half a stop under mid-grey: Shadows barely touch it.
    const dark = run(flat(0.1), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { shadows: 1 })[0]!;
    const exposed = run(flat(0.1), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { shadows: 1, exposure: 2.5 })[0]!;
    expect(dark - 0.1).toBeGreaterThan(0.05);
    expect(exposed - 0.1).toBeLessThan(0.01);
  });

  it('lift a dark area as a whole, not dark texture within a bright area, without halos at edges', () => {
    const pixel = 1 / 720 / (16 / 9);
    // Two-pixel dark gaps every six pixels in bright grass.
    const grass: Image = (u) => {
      const level = Math.floor(u / pixel) % 6 < 2 ? 0.25 : 0.65;
      return [level, level, level];
    };
    const gap = (Math.floor(0.5 / pixel / 6) * 6 + 0.5) * pixel;
    expect(grass(gap, 0.5)[0]).toBe(0.25);
    const lifted = run(flat(0.25), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { shadows: 1 })[0]!;
    expect(lifted).toBeGreaterThan(0.28);
    expect(run(grass, gap, 0.5, NEUTRAL_DETAIL, 16 / 9, { shadows: 1 })[0]).toBeLessThan(0.255);
    const skyline: Image = (u) => (u < 0.5 ? [0.2, 0.2, 0.2] : [0.85, 0.85, 0.85]);
    const near = run(skyline, 0.5 - 0.5 * pixel, 0.5, NEUTRAL_DETAIL, 16 / 9, { shadows: 1 })[0]!;
    const far = run(flat(0.2), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { shadows: 1 })[0]!;
    expect(Math.abs(near - far)).toBeLessThan(0.005);
    const sky = run(skyline, 0.5 + 0.5 * pixel, 0.5, NEUTRAL_DETAIL, 16 / 9, { highlights: -1 })[0]!;
    expect(Math.abs(sky - run(flat(0.85), 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { highlights: -1 })[0]!)).toBeLessThan(
      0.005,
    );
  });

  it('keep local contrast and colour ratios inside a lifted area', () => {
    const tinted: Image = () => [0.15, 0.1, 0.05];
    const [red, green, blue] = run(tinted, 0.5, 0.5, NEUTRAL_DETAIL, 16 / 9, { shadows: 1 });
    expect(decode709(red!) / decode709(blue!)).toBeCloseTo(decode709(0.15) / decode709(0.05), 10);
    expect(decode709(green!) / decode709(blue!)).toBeCloseTo(decode709(0.1) / decode709(0.05), 10);
  });

  it('route nonzero or keyed Shadows and Highlights through the composited exporter', () => {
    const document = project(NEUTRAL_DETAIL);
    const layer = document.layers[0]!;
    for (const setting of ['shadows', 'highlights'] as const) {
      const edited = { ...document, layers: [{ ...layer, colour: { ...layer.colour, [setting]: -0.2 } }] };
      expect(needsLayeredExport(projectSchema.parse(edited))).toBe(true);
    }
  });
});

function project(detail: DetailSettings): ProjectDocument {
  const base = createProject('detail', 'Detail');
  const clip = { ...createClip('clip', 'media', 0, 30), detail };
  return projectSchema.parse({ ...base, media: { videoIds: ['media'], audioIds: [] }, clips: [clip] });
}

describe('clip detail editing and export routing', () => {
  it('edits one clip without timing changes and copies independent settings to split and duplicated pieces', () => {
    const document = project(NEUTRAL_DETAIL);
    const detail = { sharpen: 0.4, clarity: -0.2, denoise: 0.1 };
    const edited = applyCommand(document, { type: 'detail', clipId: 'clip', detail });
    expect(edited.clips[0]!.detail).toEqual(detail);
    expect(calculateLayout(edited).duration).toBe(calculateLayout(document).duration);
    expect(sampleTimeline(edited, 3)[0]!.detail).toEqual(detail);
    expect(() =>
      applyCommand(document, { type: 'detail', clipId: 'clip', detail: { ...detail, sharpen: 1.5 } }),
    ).toThrow();
    const split = applyCommand(edited, { type: 'split', clipId: 'clip', sourceFrame: 10, newClipId: 'right' });
    expect(split.clips.map((clip) => clip.detail)).toEqual([detail, detail]);
    expect(split.clips[0]!.detail).not.toBe(split.clips[1]!.detail);
    const duplicated = applyCommand(edited, { type: 'duplicate', clipId: 'clip', newClipId: 'copy' });
    expect(duplicated.clips[1]!.detail).toEqual(detail);
  });

  it('routes only nonneutral detail through the composited exporter', () => {
    expect(needsLayeredExport(project(NEUTRAL_DETAIL))).toBe(false);
    expect(needsLayeredExport(project({ sharpen: 0, clarity: 0, denoise: 0.01 }))).toBe(true);
  });
});

function fitted(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    rgb[pixel * 3] = Math.round(127 + 100 * Math.sin(x * 0.9 + y * 0.31));
    rgb[pixel * 3 + 1] = (x * 37 + y * 11) % 256;
    rgb[pixel * 3 + 2] = Math.round(127 + 90 * Math.cos(x * 0.21 - y * 0.77));
  }
  return rgb;
}

/** Exact advanced grade (no LUT), so only RGBA16 rounding separates native from the reference. */
const exactColour = createColourSettings();
exactColour.exposure = 0.15;
exactColour.hsl.blue = { hue: 6, saturation: -0.2, lightness: 0.02 };

function bilinearImage(rgb: Uint8Array, width: number, height: number): Image {
  return (u, v) => {
    const x = u * width - 0.5;
    const y = v * height - 0.5;
    const left = Math.floor(x);
    const top = Math.floor(y);
    const fx = x - left;
    const fy = y - top;
    const at = (column: number, row: number, channel: number): number =>
      rgb[(Math.max(0, Math.min(height - 1, row)) * width + Math.max(0, Math.min(width - 1, column))) * 3 + channel]! /
      255;
    return [0, 1, 2].map(
      (channel) =>
        (at(left, top, channel) * (1 - fx) + at(left + 1, top, channel) * fx) * (1 - fy) +
        (at(left, top + 1, channel) * (1 - fx) + at(left + 1, top + 1, channel) * fx) * fy,
    ) as unknown as RGB;
  };
}

describe('native detail filtering', () => {
  const detail = { sharpen: 0.6, clarity: 0.5, denoise: 0.4 };
  for (const [width, height, rows, tone] of [
    [1280, 720, [0, 1, 359, 718, 719], {}],
    [1280, 720, [0, 359, 719], { hdr: 0.6 }],
    [1280, 720, [0, 359, 719], { shadows: 0.8, highlights: -0.7, exposure: 0.3 }],
    [3840, 2160, [0, 1080, 2159], {}],
    [3840, 2160, [0, 2159], { shadows: 0.5, highlights: -0.5, hdr: 0.6 }],
  ] as const)
    it(`matches the shared reference before grading at ${width}×${height} with ${JSON.stringify(tone)}, including content edges`, () => {
      const rgb = fitted(width, height);
      const image = bilinearImage(rgb, width, height);
      const source: FrameSource = {
        rgb,
        bounds: { x: 0, y: 0, width, height },
        lut: null,
        exactColour,
        detail,
        tone: toneOf(tone),
        multiplier: 65535,
        coverage: 1,
        mapping: compileSpatialMapping(NEUTRAL_SPATIAL_POSE, width * 2, height * 2, width, height),
        fullCanvas: true,
      };
      const output = new Uint16Array(width * height * 4);
      for (const row of rows) composeRows(output, width, [source], row, row + 1);
      let maximum = 0;
      for (const row of rows)
        for (const x of [0, 1, Math.floor(width / 3), width - 2, width - 1]) {
          const u = (x + 0.5) / width;
          const v = (row + 0.5) / height;
          const expected = gradePixel(reference(image, u, v, detail, width / height, tone, height), exactColour);
          for (let channel = 0; channel < 3; channel++)
            maximum = Math.max(
              maximum,
              Math.abs(output[(row * width + x) * 4 + channel]! / 65535 - expected[channel]!) * 255,
            );
          expect(output[(row * width + x) * 4 + 3]).toBe(65535);
        }
      expect(maximum).toBeLessThan(0.01);
    });

  it('filters the same footage alike through the neutral and transformed sampling paths', async () => {
    const target = { width: 64, height: 36 };
    const rgb = Buffer.from(fitted(target.width, target.height));
    const sample = (translateX: number): PreviewLayer => ({
      clipId: 'clip',
      mediaId: 'media',
      layerId: 'row',
      sourceFrame: 0,
      sourcePosition: 0,
      spatial: { ...NEUTRAL_SPATIAL_POSE, translateX },
      detail,
      colour: exactColour,
      weight: 1,
      blendWeight: 1,
      brightness: 1,
      opacity: 1,
    });
    const render = async (translateX: number): Promise<Uint16Array> => {
      const buffer = Buffer.alloc(target.width * target.height * 8);
      await composeLayerFrame(
        buffer,
        target,
        [{ sample: sample(translateX), rgb, bounds: { x: 0, y: 0, ...target }, original: { width: 640, height: 360 } }],
        new ColourLutCache(),
        new AbortController().signal,
      );
      return new Uint16Array(buffer.buffer, buffer.byteOffset, target.width * target.height * 4);
    };
    const neutral = await render(0);
    const transformed = await render(Number.EPSILON);
    let maximum = 0;
    neutral.forEach((value, index) => (maximum = Math.max(maximum, Math.abs(value - transformed[index]!) / 257)));
    expect(maximum).toBeLessThan(0.01);
    const unfiltered = await (async () => {
      const buffer = Buffer.alloc(target.width * target.height * 8);
      await composeLayerFrame(
        buffer,
        target,
        [
          {
            sample: { ...sample(0), detail: { ...NEUTRAL_DETAIL } },
            rgb,
            bounds: { x: 0, y: 0, ...target },
            original: { width: 640, height: 360 },
          },
        ],
        new ColourLutCache(),
        new AbortController().signal,
      );
      return new Uint16Array(buffer.buffer, buffer.byteOffset, target.width * target.height * 4);
    })();
    expect(unfiltered).not.toEqual(neutral);
  });

  it('applies evaluated local tone without clip detail and reuses one scalar LUT while it animates', async () => {
    const target = { width: 48, height: 27 };
    const rgb = Buffer.from(fitted(target.width, target.height));
    const colour = { ...createColourSettings(), exposure: 0.1 };
    const cache = new ColourLutCache();
    const render = async (tone: Tone): Promise<Uint16Array> => {
      const buffer = Buffer.alloc(target.width * target.height * 8);
      const sample: PreviewLayer = {
        clipId: 'clip',
        mediaId: 'media',
        layerId: 'row',
        sourceFrame: 0,
        sourcePosition: 0,
        spatial: { ...NEUTRAL_SPATIAL_POSE },
        detail: { ...NEUTRAL_DETAIL },
        colour: { ...colour, ...tone },
        weight: 1,
        blendWeight: 1,
        brightness: 1,
        opacity: 1,
      };
      await composeLayerFrame(
        buffer,
        target,
        [{ sample, rgb, bounds: { x: 0, y: 0, ...target }, original: { width: 480, height: 270 } }],
        cache,
        new AbortController().signal,
      );
      return new Uint16Array(buffer.buffer, buffer.byteOffset, target.width * target.height * 4);
    };
    const plain = await render({});
    const low = await render({ hdr: 0.3 });
    const high = await render({ hdr: 0.9 });
    const shadows = await render({ shadows: 0.6 });
    const highlights = await render({ highlights: -0.6 });
    const contrast = await render({ localContrast: 0.6 });
    expect(low).not.toEqual(plain);
    expect(high).not.toEqual(low);
    expect(shadows).not.toEqual(plain);
    expect(highlights).not.toEqual(shadows);
    expect(contrast).not.toEqual(plain);
    expect(cache.report.generated).toBe(1);
  });
});
