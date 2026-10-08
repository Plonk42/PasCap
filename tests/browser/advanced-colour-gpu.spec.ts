import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { CURVE_CHANNELS, HSL_BANDS } from '../../src/shared/advanced-colour.js';
import { createColourSettings, gradePixel, type RGB } from '../../src/shared/colour.js';
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
