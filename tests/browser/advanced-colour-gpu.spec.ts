import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { CompositeClip, CompositeGroup } from '../../src/preview/compositor.js';
import { CURVE_CHANNELS, HSL_BANDS } from '../../src/shared/advanced-colour.js';
import {
  createColourSettings,
  decode709,
  encode709,
  gradePixel,
  type ColourSettings,
  type RGB,
} from '../../src/shared/colour.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';

let script: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../../src/preview/compositor.ts', import.meta.url)),
        name: 'ColourGpu',
        formats: ['iife'],
      },
    },
  });
  script = (Array.isArray(result) ? result : [result])
    .flatMap((output) => ('output' in output ? output.output : []))
    .filter((chunk) => chunk.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
});

test('advanced SDR GPU parity: all eight ranges, four curves, joint grading and maximum uniform arrays', async ({
  page,
}, testInfo) => {
  const grades = HSL_BANDS.map((band, i) => {
    const settings = createColourSettings();
    settings.hsl[band] = { hue: i % 2 ? 30 : -30, saturation: i % 2 ? -1 : 1, lightness: i % 2 ? -0.3 : 0.3 };
    return settings;
  });
  for (const channel of CURVE_CHANNELS) {
    const settings = createColourSettings();
    settings.curves[channel] = [
      { x: 0, y: 0.12 },
      { x: 0.3, y: 0.6 },
      { x: 0.65, y: 0.3 },
      { x: 1, y: 0.92 },
    ];
    grades.push(settings);
  }
  const combined = createColourSettings();
  combined.temperature = 0.85;
  combined.tint = -0.65;
  combined.exposure = 0.4;
  combined.hue = 19;
  combined.saturation = 0.8;
  HSL_BANDS.forEach((band, i) => {
    combined.hsl[band] = { hue: i % 2 ? 8 : -6, saturation: -0.12, lightness: 0.015 };
  });
  CURVE_CHANNELS.forEach((channel, c) => {
    combined.curves[channel] = Array.from({ length: 16 }, (_, i) => ({ x: i / 15, y: (i / 15) ** (0.9 + c * 0.08) }));
  });
  grades.push(combined);
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Advanced colour GPU</title>' }),
  );
  await page.goto('/');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate((grades) => {
    const gpu = (globalThis as unknown as { ColourGpu: typeof import('../../src/preview/compositor.js') }).ColourGpu;
    const compositor = new gpu.Compositor(document.createElement('canvas'));
    const uniforms = compositor.gl.getParameter(compositor.gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number;
    compositor.dispose();
    compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { uniforms, grades: grades.map((grade) => gpu.verifyGpuColour(grade)) };
  }, grades);
  expect(result.uniforms).toBeGreaterThanOrEqual(224);
  for (const grade of result.grades) {
    expect(grade.maxError8Bit).toBeLessThan(2);
    expect(grade.meanAbsoluteError8Bit).toBeLessThan(0.6);
  }
  await testInfo.attach('advanced-colour-gpu', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('real GPU exact greys, near-grey chroma and circular hue boundaries retain strict pixel bounds', async ({
  page,
}, testInfo) => {
  const pixels: number[] = [];
  for (const grey of [0, 1, 63, 127, 128, 192, 254, 255]) pixels.push(grey, grey, grey, 255);
  for (const centre of [0, 30, 60, 120, 180, 240, 270, 300, 360]) {
    for (const delta of [-0.5, 0, 0.5]) {
      for (const chroma of [0.004, 0.05, 0.1, 0.8]) {
        const hue = centre + delta;
        for (const offset of [0, -120, -240]) {
          const k = ((((hue + offset) % 360) + 360) % 360) / 60;
          const component = Math.min(1, Math.max(0, Math.abs(k - 3) - 1));
          pixels.push(Math.round((0.5 + chroma * (component - 0.5)) * 255));
        }
        pixels.push(255);
      }
    }
  }
  const settings = createColourSettings();
  HSL_BANDS.forEach((band, i) => {
    settings.hsl[band] = { hue: i % 2 ? 30 : -30, saturation: i % 2 ? -1 : 1, lightness: i % 2 ? -0.5 : 0.5 };
  });
  const curved = structuredClone(settings);
  CURVE_CHANNELS.forEach((channel, c) => {
    curved.curves[channel] = Array.from({ length: 16 }, (_, i) => ({
      x: i / 15,
      y: i % 2 ? 0.15 + c * 0.03 : 0.85 - c * 0.02,
    }));
  });
  const grades = [createColourSettings(), settings, curved];
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Boundary GPU only</title>' }),
  );
  await page.goto('/');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(
    ({ pixels, grades, spatial }) => {
      const gpu = (globalThis as unknown as { ColourGpu: typeof import('../../src/preview/compositor.js') }).ColourGpu;
      const canvas = document.createElement('canvas');
      canvas.width = pixels.length / 4;
      canvas.height = 1;
      const compositor = new gpu.Compositor(canvas);
      try {
        compositor.uploadPixels(0, new Uint8Array(pixels), canvas.width, 1);
        return {
          renderer: compositor.renderer,
          outputs: grades.map((settings) => {
            compositor.drawFrame([
              {
                clips: [
                  {
                    slot: 0,
                    settings,
                    aspect: canvas.width,
                    spatial,
                    originalWidth: canvas.width,
                    originalHeight: 1,
                    opacity: 1,
                    blendWeight: 1,
                    brightness: 1,
                  },
                ],
              },
            ]);
            return Array.from(compositor.readPixels());
          }),
        };
      } finally {
        compositor.dispose();
        compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    },
    { pixels, grades, spatial: NEUTRAL_SPATIAL_POSE },
  );
  const metrics = grades.map((grade, at) => {
    const errors: number[] = [];
    for (let pixel = 0; pixel < pixels.length / 4; pixel++) {
      const input = pixels.slice(pixel * 4, pixel * 4 + 3).map((value) => value / 255) as unknown as RGB;
      const expected = gradePixel(input, grade);
      expected.forEach((value, channel) =>
        errors.push(Math.abs(result.outputs[at]![pixel * 4 + channel]! - value * 255)),
      );
      expect(result.outputs[at]![pixel * 4 + 3]).toBe(255);
    }
    return { maximum: Math.max(...errors), mean: errors.reduce((a, b) => a + b, 0) / errors.length };
  });
  for (const metric of metrics) {
    expect(metric.maximum).toBeLessThan(2);
    expect(metric.mean).toBeLessThan(0.6);
  }
  for (let i = 0; i < 8 * 4; i++) expect(result.outputs[1]![i]).toBe(pixels[i]);
  await testInfo.attach('exact-grey-circular-boundaries', {
    contentType: 'application/json',
    body: JSON.stringify({ renderer: result.renderer, metrics, pixels: pixels.length / 4 }),
  });
});

test('single-source specialization and grouped paths preserve all sixteen curve points through repeated switches', async ({
  page,
}) => {
  const settings = createColourSettings();
  settings.temperature = -0.75;
  settings.tint = 0.9;
  settings.exposure = 0.4;
  HSL_BANDS.forEach((band, index) => {
    settings.hsl[band] = { hue: index % 2 ? 8 : -6, saturation: -0.12, lightness: 0.015 };
  });
  CURVE_CHANNELS.forEach((channel, index) => {
    settings.curves[channel] = Array.from({ length: 16 }, (_, point) => ({
      x: point / 15,
      y: (point / 15) ** (0.9 + index * 0.08),
    }));
  });
  const neutral = createColourSettings();
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixed GPU paths</title>' }),
  );
  await page.goto('/');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(
    ({ settings, neutral, spatial }) => {
      const gpu = (globalThis as unknown as { ColourGpu: typeof import('../../src/preview/compositor.js') }).ColourGpu;
      const canvas = document.createElement('canvas');
      canvas.width = 17;
      canvas.height = 17;
      const compositor = new gpu.Compositor(canvas);
      try {
        const pixels = Uint8Array.from({ length: 17 * 17 * 4 }, (_, index) =>
          index % 4 === 3 ? 255 : (index * 73) % 256,
        );
        compositor.uploadPixels(0, pixels, 17, 17);
        const source = {
          slot: 0,
          settings,
          spatial,
          aspect: 1,
          originalWidth: 17,
          originalHeight: 17,
          opacity: 0.63,
          brightness: 0.4,
          blendWeight: 1,
        };
        const single: number[][] = [];
        const grouped: number[][] = [];
        for (let index = 0; index < 3; index++) {
          compositor.drawFrame([{ clips: [source] }]);
          single.push(Array.from(compositor.readPixels()));
          compositor.drawFrame([{ clips: [source, { ...source, blendWeight: 0 }] }]);
          grouped.push(Array.from(compositor.readPixels()));
          compositor.drawFrame([{ clips: [{ ...source, settings: neutral }] }]);
        }
        return { single, grouped, error: compositor.gl.getError(), textureMiB: compositor.gpuTextureMiB };
      } finally {
        compositor.dispose();
        compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    },
    { settings, neutral, spatial: NEUTRAL_SPATIAL_POSE },
  );
  expect(result.error).toBe(0);
  expect(result.textureMiB).toBe((17 * 17 * 4 + 4) / 1024 ** 2);
  result.single.forEach((pixels, index) => {
    expect(pixels).toEqual(result.grouped[index]);
    expect(pixels).toEqual(result.single[0]);
    expect(pixels.some((value, channel) => channel % 4 !== 3 && value > 0)).toBe(true);
    expect(pixels.filter((_, channel) => channel % 4 === 3).every((value) => value === 255)).toBe(true);
  });
});

test('Temperature/Tint GPU extremes tint greys with normalized linear gains before exposure and clipping', async ({
  page,
}, testInfo) => {
  const axes = [
    { temperature: 0, tint: 0, exposure: 0 },
    { temperature: 1, tint: 0, exposure: 0 },
    { temperature: -1, tint: 0, exposure: 0 },
    { temperature: 0, tint: 1, exposure: 0 },
    { temperature: 0, tint: -1, exposure: 0 },
    { temperature: 1, tint: 1, exposure: 0 },
    { temperature: 1, tint: -1, exposure: 0 },
    { temperature: -1, tint: 1, exposure: 0 },
    { temperature: -1, tint: -1, exposure: 0 },
    { temperature: 1, tint: 1, exposure: -1 },
    { temperature: -1, tint: -1, exposure: -1 },
    { temperature: 0.65, tint: -0.45, exposure: 0.4 },
  ];
  const grades = axes.map((axis) => ({ ...createColourSettings(), ...axis }));
  const pixels = Array.from({ length: 17 * 17 * 4 }, (_, index) =>
    index % 4 === 3 ? 255 : (Math.floor(index / 4) * [73, 157, 29][index % 4]!) % 256,
  );
  const greys = [0, 16, 64, 96, 127, 128, 192, 254, 255];
  greys.forEach((grey, index) => pixels.splice(index * 4, 4, grey, grey, grey, 255));
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Temperature/Tint GPU</title>' }),
  );
  await page.goto('/');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(
    ({ grades, pixels, spatial }) => {
      const gpu = (globalThis as unknown as { ColourGpu: typeof import('../../src/preview/compositor.js') }).ColourGpu;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 17;
      const compositor = new gpu.Compositor(canvas);
      try {
        compositor.uploadPixels(0, new Uint8Array(pixels), 17, 17);
        const outputs = grades.map((settings) => {
          compositor.drawFrame([
            {
              clips: [
                {
                  slot: 0,
                  settings,
                  spatial,
                  aspect: 1,
                  originalWidth: 17,
                  originalHeight: 17,
                  opacity: 1,
                  blendWeight: 1,
                  brightness: 1,
                },
              ],
            },
          ]);
          return Array.from(compositor.readPixels());
        });
        return { outputs, renderer: compositor.renderer, error: compositor.gl.getError() };
      } finally {
        compositor.dispose();
        compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    },
    { grades, pixels, spatial: NEUTRAL_SPATIAL_POSE },
  );
  expect(result.error).toBe(0);
  expect(result.outputs[0]).toEqual(pixels);
  const metrics = axes.map(({ temperature, tint, exposure }, at) => {
    // Independent gain oracle: neither the production gain helper nor gradePixel
    // can make a shared CPU/GPU normalization or premature-clipping error pass.
    const raw = [2 ** (temperature / 2 + tint / 4), 2 ** (-tint / 4), 2 ** (-temperature / 2 + tint / 4)];
    const whiteLuma = 0.2126 * raw[0]! + 0.7152 * raw[1]! + 0.0722 * raw[2]!;
    const errors: number[] = [];
    for (let pixel = 0; pixel < 17 * 17; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        const linear = decode709(pixels[pixel * 4 + channel]! / 255) * (raw[channel]! / whiteLuma) * 2 ** exposure;
        const expected = encode709(Math.max(0, Math.min(1, linear))) * 255;
        errors.push(Math.abs(result.outputs[at]![pixel * 4 + channel]! - expected));
      }
      expect(result.outputs[at]![pixel * 4 + 3]).toBe(255);
    }
    return {
      temperature,
      tint,
      exposure,
      maximum: Math.max(...errors),
      mean: errors.reduce((a, b) => a + b, 0) / errors.length,
    };
  });
  for (const metric of metrics) {
    expect(metric.maximum, JSON.stringify(metric)).toBeLessThan(2);
    expect(metric.mean, JSON.stringify(metric)).toBeLessThan(0.6);
  }
  const grey = result.outputs.map((output) => output.slice(3 * 4, 3 * 4 + 3));
  expect(grey[1]![0]).toBeGreaterThan(grey[1]![1]!);
  expect(grey[1]![1]).toBeGreaterThan(grey[1]![2]!);
  expect(grey[2]![2]).toBeGreaterThan(grey[2]![1]!);
  expect(grey[2]![1]).toBeGreaterThan(grey[2]![0]!);
  expect(grey[3]![0]).toBe(grey[3]![2]);
  expect(grey[3]![0]).toBeGreaterThan(grey[3]![1]!);
  expect(grey[4]![0]).toBe(grey[4]![2]);
  expect(grey[4]![1]).toBeGreaterThan(grey[4]![0]!);
  await testInfo.attach('temperature-tint-extremes', {
    body: JSON.stringify({ renderer: result.renderer, metrics, grey }),
    contentType: 'application/json',
  });
});

test('Temperature/Tint: scalar/single/full switches preserve opacity and fades', async ({ page }, testInfo) => {
  const scalarLeft = {
    ...createColourSettings(),
    temperature: 1,
    tint: -0.7,
    exposure: -0.2,
    brightness: 0.025,
    contrast: 0.95,
  };
  const scalarRight = {
    ...createColourSettings(),
    temperature: -0.9,
    tint: 1,
    exposure: 0.15,
    hue: -13,
    saturation: 0.85,
    shadows: 0.1,
    highlights: -0.15,
  };
  const advancedLeft = structuredClone(scalarLeft);
  const advancedRight = structuredClone(scalarRight);
  HSL_BANDS.forEach((band, index) => {
    advancedLeft.hsl[band] = { hue: index % 2 ? 8 : -6, saturation: -0.12, lightness: 0.015 };
    advancedRight.hsl[band] = { hue: index % 2 ? -5 : 9, saturation: 0.08, lightness: -0.02 };
  });
  CURVE_CHANNELS.forEach((channel, index) => {
    advancedLeft.curves[channel] = Array.from({ length: 16 }, (_, point) => ({
      x: point / 15,
      y: (point / 15) ** (0.9 + index * 0.08),
    }));
    advancedRight.curves[channel] = Array.from({ length: 16 }, (_, point) => ({
      x: point / 15,
      y: (point / 15) ** (1.15 - index * 0.06),
    }));
  });
  const source = (slot: number, settings: ColourSettings, changes: Partial<CompositeClip> = {}): CompositeClip => ({
    slot,
    settings,
    spatial: NEUTRAL_SPATIAL_POSE,
    aspect: 1,
    originalWidth: 17,
    originalHeight: 17,
    opacity: 0.63,
    blendWeight: 1,
    brightness: 0.4,
    ...changes,
  });
  const left = source(0, advancedLeft, { blendWeight: 0.35 });
  const right = source(1, advancedRight, { blendWeight: 0.65, brightness: 0.8 });
  const lower = source(
    1,
    { ...createColourSettings(), temperature: -0.35, tint: 0.45 },
    { opacity: 0.61, brightness: 0.7 },
  );
  const cases: { name: string; path: 'scalar' | 'single' | 'full'; groups: CompositeGroup[] }[] = [
    {
      name: 'scalar gains',
      path: 'scalar',
      groups: [
        {
          clips: [
            { ...left, settings: scalarLeft },
            { ...right, settings: scalarRight },
          ],
        },
      ],
    },
    {
      name: 'scalar swapped sources',
      path: 'scalar',
      groups: [
        {
          clips: [
            { ...right, settings: scalarRight },
            { ...left, settings: scalarLeft },
          ],
        },
      ],
    },
    { name: 'single left grade', path: 'single', groups: [{ clips: [source(0, advancedLeft)] }] },
    { name: 'single right grade', path: 'single', groups: [{ clips: [source(1, advancedRight)] }] },
    { name: 'full independent grades', path: 'full', groups: [{ clips: [left, right] }] },
    { name: 'full swapped sources', path: 'full', groups: [{ clips: [right, left] }] },
    {
      name: 'full left endpoint',
      path: 'full',
      groups: [
        {
          clips: [
            { ...left, blendWeight: 1 },
            { ...right, blendWeight: 0 },
          ],
        },
      ],
    },
    {
      name: 'full right endpoint',
      path: 'full',
      groups: [
        {
          clips: [
            { ...left, blendWeight: 0 },
            { ...right, blendWeight: 1 },
          ],
        },
      ],
    },
    { name: 'composed dissolve', path: 'full', groups: [{ clips: [lower] }, { clips: [left, right] }] },
    {
      name: 'black fade retains coverage',
      path: 'full',
      groups: [
        { clips: [lower] },
        {
          clips: [
            { ...left, brightness: 0 },
            { ...right, brightness: 0 },
          ],
        },
      ],
    },
    {
      name: 'zero opacity reveals lower',
      path: 'scalar',
      groups: [{ clips: [lower] }, { clips: [source(0, scalarLeft, { opacity: 0 })] }],
    },
    {
      name: 'neutral scalar clears gains',
      path: 'scalar',
      groups: [{ clips: [source(0, createColourSettings(), { opacity: 1, brightness: 1 })] }],
    },
  ];
  const pixels = [0, 1].map((slot) =>
    Array.from({ length: 17 * 17 * 4 }, (_, index) =>
      index % 4 === 3 ? 255 : (Math.floor(index / 4) * [73, 157, 29][index % 4]! + slot * 47) % 256,
    ),
  );
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Per-source gain GPU paths</title>' }),
  );
  await page.goto('/');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(
    ({ cases, pixels }) => {
      const gpu = (globalThis as unknown as { ColourGpu: typeof import('../../src/preview/compositor.js') }).ColourGpu;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 17;
      const compositor = new gpu.Compositor(canvas);
      try {
        compositor.uploadPixels(0, new Uint8Array(pixels[0]!), 17, 17);
        compositor.uploadPixels(1, new Uint8Array(pixels[1]!), 17, 17);
        const programs = new Map<WebGLProgram, number>();
        const outputs: { at: number; repeat: number; program: number; pixels: number[] }[] = [];
        for (let repeat = 0; repeat < 3; repeat++) {
          cases.forEach(({ groups }, at) => {
            compositor.drawFrame(groups);
            const program = compositor.gl.getParameter(compositor.gl.CURRENT_PROGRAM) as WebGLProgram | null;
            if (!program) throw new Error('A real compositor program must be active after drawing.');
            if (!programs.has(program)) programs.set(program, programs.size);
            outputs.push({ at, repeat, program: programs.get(program)!, pixels: Array.from(compositor.readPixels()) });
          });
        }
        return {
          outputs,
          renderer: compositor.renderer,
          error: compositor.gl.getError(),
          textureMiB: compositor.gpuTextureMiB,
        };
      } finally {
        compositor.dispose();
        compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    },
    { cases, pixels },
  );
  expect(result.error).toBe(0);
  expect(result.textureMiB).toBe((2 * 17 * 17 * 4) / 1024 ** 2);
  expect(result.outputs).toHaveLength(cases.length * 3);
  const metrics = result.outputs.map((output) => {
    const fixture = cases[output.at]!;
    expect(output.pixels).toEqual(result.outputs[output.at]!.pixels);
    const errors: number[] = [];
    for (let pixel = 0; pixel < 17 * 17; pixel++) {
      const expected = [0, 0, 0];
      for (const group of fixture.groups) {
        const rgb = [0, 0, 0];
        let alpha = 0;
        for (const clip of group.clips) {
          const input = pixels[clip.slot]!.slice(pixel * 4, pixel * 4 + 3).map(
            (value) => value / 255,
          ) as unknown as RGB;
          const grade = gradePixel(input, clip.settings);
          const coverage = clip.opacity * clip.blendWeight;
          alpha += coverage;
          for (let channel = 0; channel < 3; channel++) rgb[channel]! += grade[channel]! * coverage * clip.brightness;
        }
        for (let channel = 0; channel < 3; channel++)
          expected[channel] = rgb[channel]! + expected[channel]! * (1 - alpha);
      }
      for (let channel = 0; channel < 3; channel++)
        errors.push(Math.abs(output.pixels[pixel * 4 + channel]! - expected[channel]! * 255));
      expect(output.pixels[pixel * 4 + 3]).toBe(255);
    }
    return {
      name: fixture.name,
      repeat: output.repeat,
      program: output.program,
      maximum: Math.max(...errors),
      mean: errors.reduce((a, b) => a + b, 0) / errors.length,
    };
  });
  const programIds = ['scalar', 'single', 'full'].map((path) => {
    const ids = new Set(
      result.outputs.filter((output) => cases[output.at]!.path === path).map((output) => output.program),
    );
    expect(ids.size, `${path} keeps one real program through repeated switches`).toBe(1);
    return [...ids][0]!;
  });
  expect(new Set(programIds).size, 'scalar, single and full must exercise three distinct real programs').toBe(3);
  for (const metric of metrics) {
    expect(metric.maximum, JSON.stringify(metric)).toBeLessThan(2);
    expect(metric.mean, JSON.stringify(metric)).toBeLessThan(0.6);
  }
  await testInfo.attach('temperature-tint-program-composition', {
    body: JSON.stringify({ renderer: result.renderer, textureMiB: result.textureMiB, metrics }),
    contentType: 'application/json',
  });
});
