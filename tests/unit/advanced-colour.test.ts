import { describe, expect, it } from 'vitest';
import { ColourLutCache, sampleColourLut } from '../../src/server/layered-colour.js';
import { composeLayerFrame, type LayerFrameSource } from '../../src/server/layered-frame.js';
import {
  applyHsl,
  colourCurveSchema,
  CURVE_CHANNELS,
  evaluateColourCurve,
  HSL_BANDS,
  HSL_CENTRES,
} from '../../src/shared/advanced-colour.js';
import {
  colourSchema,
  compilePixelGrade,
  createColourSettings,
  generateCube,
  gradePixel,
  NEUTRAL_COLOUR,
  type RGB,
} from '../../src/shared/colour.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { colourAt } from '../../src/shared/composition.js';
import { needsLayeredExport, planExport } from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { colourResetCommands } from '../../src/web/colour-reset.js';

function hueRgb(hue: number): RGB {
  const value = (offset: number): number =>
    Math.max(0, Math.min(1, Math.abs(((hue + offset + 720) % 360) / 60 - 3) - 1));
  return [value(0), value(-120), value(-240)];
}

describe('strict 11 static advanced row colour', () => {
  it('creates deeply independent bands and curves for settings, rows and projects', () => {
    const a = createColourSettings(),
      b = createColourSettings();
    a.hsl.red.hue = 12;
    a.curves.master[0]!.y = 0.2;
    expect(b).toEqual(NEUTRAL_COLOUR);
    const project = createProject('p', 'P');
    project.layers.push(createLayer('other', 'Other'));
    project.layers[0]!.colour.hsl.blue.saturation = -0.3;
    project.layers[0]!.colour.curves.red[1]!.y = 0.8;
    expect(project.layers[1]!.colour).toEqual(NEUTRAL_COLOUR);
    expect(createProject('b', 'B').layers[0]!.colour).toEqual(NEUTRAL_COLOUR);
  });
  it('requires every field and rejects old schemas, unknown entries and nonfinite data without repair', () => {
    const document = createProject('p', 'P');
    for (let schemaVersion = 1; schemaVersion <= 10; schemaVersion++)
      expect(projectSchema.safeParse({ ...document, schemaVersion }).success).toBe(false);
    for (const field of ['hsl', 'curves'] as const) {
      const value = { ...document.layers[0]!.colour };
      delete (value as Partial<typeof value>)[field];
      expect(colourSchema.safeParse(value).success).toBe(false);
    }
    for (const band of HSL_BANDS) {
      const colour = createColourSettings();
      delete (colour.hsl as Partial<typeof colour.hsl>)[band];
      expect(colourSchema.safeParse(colour).success).toBe(false);
      for (const value of [NaN, Infinity, 30.1, -30.1])
        expect(
          colourSchema.safeParse({
            ...NEUTRAL_COLOUR,
            hsl: { ...NEUTRAL_COLOUR.hsl, [band]: { hue: value, saturation: 0, lightness: 0 } },
          }).success,
        ).toBe(false);
    }
    expect(KEYFRAME_SETTINGS).toHaveLength(9);
    expect(
      projectSchema.safeParse({ ...document, clips: [{ ...createClip('c', 'm', 0, 2), colour: NEUTRAL_COLOUR }] })
        .success,
    ).toBe(false);
  });
  it.each([
    [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
    ],
    [
      { x: 0.1, y: 0 },
      { x: 1, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 0.9, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: NaN },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 1.1 },
    ],
    Array.from({ length: 17 }, (_, i) => ({ x: i / 16, y: i / 16 })),
  ])('rejects malformed curve %#', (...points) => {
    expect(colourCurveSchema.safeParse(points).success).toBe(false);
  });
  it('accepts nonmonotonic outputs and editable endpoint outputs, and interpolates master before channel', () => {
    const settings = createColourSettings();
    settings.curves.master = [
      { x: 0, y: 0.2 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 0.4 },
    ];
    settings.curves.red = [
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ];
    expect(colourSchema.parse(settings)).toEqual(settings);
    const result = gradePixel([0.25, 0.25, 0.25], settings);
    expect(result[0]).toBeCloseTo(0.5, 12);
    expect(result[1]).toBeCloseTo(0.5, 12);
    expect(gradePixel([0, 1, 0], settings)).toEqual([0.8, 0.4, 0.2]);
  });
  it('preserves exact identity for all-neutral grading and any identity curve point count', () => {
    const settings = createColourSettings();
    for (const channel of CURVE_CHANNELS)
      settings.curves[channel] = Array.from({ length: 16 }, (_, i) => ({ x: i / 15, y: i / 15 }));
    const input: RGB = [0.123456789012, 0.9999999, 0.004];
    expect(gradePixel(input, settings)).toBe(input);
    expect(evaluateColourCurve(settings.curves.master, input[0])).toBe(input[0]);
  });
  it('protects exact greys, black and white under all extreme HSL offsets', () => {
    const settings = createColourSettings();
    for (const band of HSL_BANDS) settings.hsl[band] = { hue: 30, saturation: 1, lightness: 0.5 };
    for (const value of [0, 0.0001, 0.04, 0.5, 0.9999, 1]) {
      const rgb: RGB = [value, value, value];
      expect(applyHsl(rgb, settings.hsl)).toBe(rgb);
    }
  });
  it('compiled per-frame grading matches the reference exactly for every stage combination', () => {
    for (let mask = 0; mask < 8; mask++) {
      const settings = createColourSettings();
      if (mask & 1) Object.assign(settings, { exposure: 0.37, hue: -23, saturation: 0.8, shadows: 0.12 });
      if (mask & 2) settings.hsl.red = { hue: 17, saturation: -0.3, lightness: 0.04 };
      if (mask & 4)
        settings.curves.master = [
          { x: 0, y: 0.02 },
          { x: 0.5 - 1e-7, y: 0.1 },
          { x: 0.5, y: 0.9 },
          { x: 1, y: 0.98 },
        ];
      const compiled = compilePixelGrade(settings);
      for (const input of [
        [0, 0, 0],
        [1, 1, 1],
        [0.5, 0.5, 0.5],
        [0.49999995, 0.7, 0.2],
        [0.8, 0.1, 0.05],
      ] as const)
        expect(compiled(input)).toEqual(gradePixel(input, settings));
    }
    const input: RGB = [0.123456789012, 0.9999999, 0.004];
    expect(compilePixelGrade(createColourSettings())(input)).toBe(input);
  });
  it('uses incoming complementary circular neighbours with continuous band boundaries and grey influence', () => {
    const settings = createColourSettings();
    HSL_BANDS.forEach((band, i) => {
      settings.hsl[band] = { hue: i % 2 ? 30 : -30, saturation: i % 2 ? -0.6 : 0.3, lightness: i % 2 ? -0.1 : 0.1 };
    });
    for (const centre of HSL_CENTRES) {
      const a = applyHsl(hueRgb(centre - 0.00001), settings.hsl),
        b = applyHsl(hueRgb(centre + 0.00001), settings.hsl);
      a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(0.000002));
    }
    const nearGrey = applyHsl([0.5 + 1e-7, 0.5, 0.5], settings.hsl);
    expect(Math.abs(nearGrey[0] - 0.5)).toBeLessThan(2e-7);
  });
  it('keeps advanced settings with scalar keys and reset-keys; advanced static edits are one Undo and require exact layered export', () => {
    const project = createProject('p', 'P');
    project.clips = [createClip('c', 'source', 0, 4)];
    const layer = project.layers[0]!;
    layer.colour.hsl.red.hue = 12;
    layer.colour.curves.master[0]!.y = 0.1;
    expect(needsLayeredExport(project)).toBe(true);
    expect(() => planExport(project)).toThrow('layered exporter');
    layer.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, exposure: 1, opacity: 0.7 } },
    ];
    expect(colourAt(layer, 2)).toMatchObject({ exposure: 1, hsl: layer.colour.hsl, curves: layer.colour.curves });
    const history = new EditHistory(project);
    const before = structuredClone(project);
    history.replace(
      colourResetCommands(layer, 0).reduce((document, command) => applyCommand(document, command), history.current),
    );
    expect(history.current.layers[0]!.colour).toEqual(before.layers[0]!.colour);
    expect(history.undo()).toEqual(before);
    history.commit({
      type: 'colour',
      layerId: layer.id,
      colour: { ...layer.colour, hsl: { ...layer.colour.hsl, red: { hue: 0, saturation: 0, lightness: 0 } } },
    });
    expect(history.current.layers[0]!.keyframes).toEqual(layer.keyframes);
    expect(history.undo()).toEqual(before);
    expect(
      applyCommand(project, { type: 'colour', layerId: layer.id, colour: createColourSettings() }).layers[0]!.keyframes,
    ).toEqual(layer.keyframes);
  });
  it('routes every nonneutral band/curve through layered export and preserves neutral advanced static eligibility', () => {
    const project = createProject('dispatch', 'Dispatch');
    project.clips = [createClip('c', 'source', 0, 4)];
    project.layers[0]!.colour.exposure = 0.7;
    for (const channel of CURVE_CHANNELS)
      project.layers[0]!.colour.curves[channel] = Array.from({ length: 16 }, (_, i) => ({ x: i / 15, y: i / 15 }));
    const neutral = structuredClone(project.layers[0]!.colour);
    expect(needsLayeredExport(project)).toBe(false);
    expect(planExport(project).duration).toBe(4);
    for (const band of HSL_BANDS) {
      project.layers[0]!.colour = structuredClone(neutral);
      project.layers[0]!.colour.hsl[band].hue = 0.000001;
      expect(needsLayeredExport(project)).toBe(true);
      expect(() => planExport(project)).toThrow('layered exporter');
    }
    for (const channel of CURVE_CHANNELS) {
      project.layers[0]!.colour = structuredClone(neutral);
      project.layers[0]!.colour.curves[channel][1]!.y += 0.000001;
      expect(needsLayeredExport(project)).toBe(true);
      expect(() => planExport(project)).toThrow('layered exporter');
    }
  });
  it('retains the full-appearance cube helper and bounded LUT API without making it the advanced production path', async () => {
    const cache = new ColourLutCache();
    const signal = new AbortController().signal,
      sample = new Float64Array(3);
    const settings = createColourSettings();
    HSL_BANDS.forEach((band, i) => {
      settings.hsl[band] = { hue: i % 2 ? 8 : -6, saturation: -0.12, lightness: 0.015 };
    });
    settings.curves.master = [
      { x: 0, y: 0.02 },
      { x: 0.35, y: 0.4 },
      { x: 0.7, y: 0.75 },
      { x: 1, y: 0.98 },
    ];
    const first = await cache.get(settings, signal);
    expect(await cache.get(settings, signal)).toBe(first);
    let sum = 0,
      maximum = 0;
    for (let i = 0; i < 512; i++) {
      const rgb: RGB = [((i * 73) % 256) / 255, ((i * 157) % 256) / 255, ((i * 29) % 256) / 255];
      sampleColourLut(first, rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, sample);
      const expected = gradePixel(rgb, settings);
      expected.forEach((v, channel) => {
        const error = Math.abs(v - sample[channel]!) * 255;
        sum += error;
        maximum = Math.max(maximum, error);
      });
    }
    expect(sum / (512 * 3)).toBeLessThan(0.6);
    expect(maximum).toBeLessThan(4);
    await cache.get(NEUTRAL_COLOUR, signal);
    await cache.get({ ...settings, exposure: 0.3 }, signal);
    expect(cache.report).toMatchObject({ peakEntries: 2, bytes: 6_591_000, generated: 3 });
    expect(generateCube(settings, 2)).toContain(
      gradePixel([0, 0, 0], settings)
        .map((v) => v.toFixed(9))
        .join(' '),
    );
  });
  it.each(['byte', 'fractional'] as const)(
    'renders a valid sub-cell sharp knee exactly before H264 from %s RGB',
    async (kind) => {
      const settings = createColourSettings();
      const value = kind === 'byte' ? 128 / 255 : 0.500002;
      settings.curves.master = [
        { x: 0, y: 0 },
        { x: value - 0.000001, y: 0 },
        { x: value, y: 1 },
        { x: 1, y: 1 },
      ];
      const target = { width: 4, height: 2 };
      const rgb = Buffer.from([127, 127, 127, 128, 128, 128, 200, 200, 200, 240, 240, 240]);
      const source: LayerFrameSource = {
        sample: {
          clipId: 'knee',
          mediaId: 'synthetic',
          layerId: 'row',
          sourceFrame: 0,
          sourcePosition: 0,
          spatial: { ...NEUTRAL_SPATIAL_POSE, translateX: kind === 'byte' ? 0 : (128 - value * 255) / 4 },
          colour: colourSchema.parse(settings),
          weight: 1,
          blendWeight: 1,
          brightness: 1,
          opacity: 1,
        },
        rgb: Buffer.concat([rgb, rgb]),
        bounds: { x: 0, y: 0, ...target },
        original: target,
      };
      const cache = new ColourLutCache();
      const buffer = Buffer.alloc(target.width * target.height * 8);
      await composeLayerFrame(buffer, target, [source], cache, new AbortController().signal);
      const output = new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
      expect([...output.subarray(4, 8)]).toEqual([65535, 65535, 65535, 65535]);
      expect(cache.report).toMatchObject({ peakEntries: 0, bytes: 0, generated: 0 });
    },
  );
  it.each([false, true])(
    'grades sharp maximum-point curves after fractional sampling and before fade/dissolve/source-over (scalar+HSL=%s)',
    async (combined) => {
      const target = { width: 4, height: 2 };
      const settings = createColourSettings();
      if (combined) {
        Object.assign(settings, {
          exposure: 0.3,
          brightness: -0.02,
          contrast: 1.1,
          hue: 12,
          saturation: 0.8,
          shadows: 0.1,
          highlights: -0.2,
        });
        HSL_BANDS.forEach((band, i) => {
          settings.hsl[band] = { hue: i % 2 ? 8 : -6, saturation: -0.12, lightness: 0.015 };
        });
      }
      const leftRgb: RGB = [127.75 / 255, 81.75 / 255, 42.75 / 255];
      const beforeCurves = gradePixel(leftRgb, settings);
      // All sixteen points are valid, including a knee far narrower than one LUT cell.
      settings.curves.red = [
        ...Array.from({ length: 7 }, (_, i) => ({ x: (beforeCurves[0] * i) / 8, y: i % 2 ? 0.2 : 0.1 })),
        { x: beforeCurves[0] - 1e-7, y: 0 },
        { x: beforeCurves[0] + 1e-7, y: 1 },
        ...Array.from({ length: 6 }, (_, i) => ({
          x: beforeCurves[0] + ((1 - beforeCurves[0]) * (i + 1)) / 7,
          y: i % 2 ? 0.8 : 0.9,
        })),
        { x: 1, y: 0.9 },
      ];
      settings.curves.green = [
        { x: 0, y: 1 },
        { x: 1, y: 0 },
      ];
      settings.curves.blue = [
        { x: 0, y: 0.05 },
        { x: 0.4, y: 0.7 },
        { x: 1, y: 0.8 },
      ];
      colourSchema.parse(settings);
      const makeSource = (id: string, rgb: Buffer, blendWeight: number, brightness: number): LayerFrameSource => ({
        sample: {
          clipId: id,
          mediaId: id,
          layerId: 'row',
          sourceFrame: 0,
          sourcePosition: 0,
          spatial: { ...NEUTRAL_SPATIAL_POSE, translateX: 0.0625 },
          colour: settings,
          weight: blendWeight,
          blendWeight,
          brightness,
          opacity: 0.65,
        },
        rgb: Buffer.concat([rgb, rgb]),
        bounds: { x: 0, y: 0, ...target },
        original: target,
      });
      const sources = [
        makeSource('left', Buffer.from([127, 81, 42, 128, 82, 43, 200, 160, 80, 240, 200, 150]), 0.4, 0.3),
        makeSource('right', Buffer.from([20, 180, 90, 40, 160, 100, 70, 140, 110, 100, 120, 130]), 0.6, 0.7),
      ];
      const cache = new ColourLutCache();
      const buffer = Buffer.alloc(64);
      const output = new Uint16Array(buffer.buffer, buffer.byteOffset, 32);
      for (let pixel = 0; pixel < 8; pixel++) output.set([10000, 20000, 30000, 65535], pixel * 4);
      await composeLayerFrame(buffer, target, sources, cache, new AbortController().signal);
      const grades = [gradePixel(leftRgb, settings), gradePixel([35 / 255, 165 / 255, 97.5 / 255], settings)];
      const expected = [10000, 20000, 30000].map((lower, channel) =>
        Math.round(lower * 0.35 + 65535 * 0.65 * (grades[0]![channel]! * 0.4 * 0.3 + grades[1]![channel]! * 0.6 * 0.7)),
      );
      expect([...output.subarray(4, 8)]).toEqual([...expected, 65535]);
      expect(cache.report).toMatchObject({ peakEntries: 0, bytes: 0, generated: 0 });
    },
  );
});
