import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { CompositeClip } from '../../src/preview/compositor.js';
import { NEUTRAL_COLOUR, type RGB } from '../../src/shared/colour.js';
import { compileDetail, type DetailSettings } from '../../src/shared/detail.js';
import { NEUTRAL_SPATIAL_POSE, type SpatialPose } from '../../src/shared/spatial.js';

// Real compositor bundled in memory: no editor, fixtures, media, saved project or API writes.
let compositorScript: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../../src/preview/compositor.ts', import.meta.url)),
        name: 'DetailGpu',
        formats: ['iife'],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  compositorScript = outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .filter((chunk) => chunk.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
  expect(compositorScript.length).toBeGreaterThan(0);
});

// A 720p proxy-sized synthetic texture with fine and coarse structure. uploadPixels
// has flipY=false: row zero is the BOTTOM of the image.
const textureWidth = 1280;
const textureHeight = 720;
const texture = new Uint8Array(textureWidth * textureHeight * 4);
for (let pixel = 0; pixel < textureWidth * textureHeight; pixel++) {
  const x = pixel % textureWidth;
  const bottomY = Math.floor(pixel / textureWidth);
  texture[pixel * 4] = Math.round(127 + 100 * Math.sin(x * 0.9 + bottomY * 0.31));
  texture[pixel * 4 + 1] = (x * 37 + bottomY * 11) % 256;
  texture[pixel * 4 + 2] = Math.round(127 + 90 * Math.cos(x * 0.021 - bottomY * 0.077) + 20 * Math.sin(x * 1.7));
  texture[pixel * 4 + 3] = 255;
}

function bilinear(u: number, t: number, out: Float64Array): void {
  const px = u * textureWidth - 0.5;
  const py = t * textureHeight - 0.5;
  const x = Math.floor(px);
  const y = Math.floor(py);
  const dx = px - x;
  const dy = py - y;
  const at = (column: number, row: number, channel: number): number =>
    texture[
      (Math.max(0, Math.min(textureHeight - 1, row)) * textureWidth + Math.max(0, Math.min(textureWidth - 1, column))) *
        4 +
        channel
    ]! / 255;
  for (let channel = 0; channel < 3; channel++)
    out[channel] =
      (at(x, y, channel) * (1 - dx) + at(x + 1, y, channel) * dx) * (1 - dy) +
      (at(x, y + 1, channel) * (1 - dx) + at(x + 1, y + 1, channel) * dx) * dy;
}

function clip(detail: DetailSettings, pose: Partial<SpatialPose> = {}, hdr = 0): CompositeClip {
  return {
    slot: 0,
    settings: { ...NEUTRAL_COLOUR, hdr },
    aspect: textureWidth / textureHeight,
    spatial: { ...NEUTRAL_SPATIAL_POSE, ...pose },
    detail,
    originalWidth: 3840,
    originalHeight: 2160,
    opacity: 1,
    blendWeight: 1,
    brightness: 1,
  };
}

/** Independent CPU expectation: shared detail kernel on a bilinear sampler, neutral grade, opaque source. */
function expected(source: CompositeClip, x: number, y: number, width: number, height: number): RGB {
  const pose = source.spatial;
  let u = (x + 0.5) / width;
  let v = (y + 0.5) / height;
  if (pose.rotation !== 0 || pose.scale !== 1) {
    const fit = Math.min(width / source.originalWidth, height / source.originalHeight);
    const dx = x + 0.5 - width * (0.5 + pose.translateX);
    const dy = y + 0.5 - height * (0.5 + pose.translateY);
    const angle = (pose.rotation * Math.PI) / 180;
    u = 0.5 + (Math.cos(angle) * dx + Math.sin(angle) * dy) / (fit * source.originalWidth * pose.scale);
    v = 0.5 + (-Math.sin(angle) * dx + Math.cos(angle) * dy) / (fit * source.originalHeight * pose.scale);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return [0, 0, 0];
  }
  const out = new Float64Array(3);
  const sampler = (su: number, sv: number, target: Float64Array): void => bilinear(su, 1 - sv, target);
  const filter = compileDetail(source.detail, source.originalWidth / source.originalHeight, source.settings.hdr);
  if (filter) filter.apply(sampler, u, v, out);
  else sampler(u, v, out);
  return [out[0]!, out[1]!, out[2]!];
}

const cases: { name: string; source: CompositeClip }[] = [
  { name: 'Sharpen', source: clip({ sharpen: 1, clarity: 0, denoise: 0 }) },
  { name: 'Clarity', source: clip({ sharpen: 0, clarity: 0.8, denoise: 0 }) },
  { name: 'negative Clarity', source: clip({ sharpen: 0, clarity: -1, denoise: 0 }) },
  { name: 'Denoise', source: clip({ sharpen: 0, clarity: 0, denoise: 0.7 }) },
  {
    name: 'all three on a rotated, scaled clip',
    source: clip({ sharpen: 0.5, clarity: 0.4, denoise: 0.5 }, { scale: 0.83, rotation: 17 }),
  },
  { name: 'track HDR', source: clip({ sharpen: 0, clarity: 0, denoise: 0 }, {}, 0.8) },
  {
    name: 'track HDR with all three on a rotated, scaled clip',
    source: clip({ sharpen: 0.5, clarity: 0.4, denoise: 0.5 }, { scale: 0.83, rotation: 17 }, 0.6),
  },
];

for (const [width, height] of [
  [1280, 720],
  [3840, 2160],
] as const) {
  test(`detail filters agree with the shared CPU kernel on the GPU at ${width}×${height}`, async ({
    page,
  }, testInfo) => {
    if (width === 3840) test.setTimeout(90_000);
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic GPU only</title>' }),
    );
    await page.goto('/');
    await page.addScriptTag({ content: compositorScript });
    const points = Array.from({ length: 81 }, (_, index) => [
      Math.floor((((index % 9) + 0.31) * width) / 9),
      Math.floor(((Math.floor(index / 9) + 0.43) * height) / 9),
    ]);
    // Edges and corners exercise clamped taps.
    points.push([0, 0], [width - 1, height - 1], [0, height - 1], [width - 1, 0]);
    const result = await page.evaluate(
      ({ width, height, sources, pixels, points, textureWidth, textureHeight }) => {
        const gpu = (globalThis as unknown as { DetailGpu: typeof import('../../src/preview/compositor.js') })
          .DetailGpu;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const compositor = new gpu.Compositor(canvas);
        try {
          const bytes = Uint8Array.from(atob(pixels), (character) => character.charCodeAt(0));
          compositor.uploadPixels(0, bytes, textureWidth, textureHeight);
          const gl = compositor.gl;
          const pixel = new Uint8Array(4);
          const read = () =>
            points.map(([x, y]) => {
              gl.readPixels(x!, height - 1 - y!, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              return Array.from(pixel);
            });
          const rendered = sources.map((source) => {
            compositor.drawFrame([{ clips: [source] }]);
            return read();
          });
          // The dissolve shader carries the same per-source filter as the single-source one.
          compositor.drawFrame([
            {
              clips: [sources[0]!, { ...sources[0]!, blendWeight: 0, detail: { sharpen: 0, clarity: 0, denoise: 0 } }],
            },
          ]);
          const grouped = read();
          return { rendered, grouped, renderer: compositor.renderer, error: gl.getError() };
        } finally {
          compositor.dispose();
          compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      },
      {
        width,
        height,
        sources: cases.map((item) => item.source),
        pixels: Buffer.from(texture).toString('base64'),
        points,
        textureWidth,
        textureHeight,
      },
    );
    expect(result.error).toBe(0);
    let sum = 0;
    let maximum = 0;
    let count = 0;
    const check = (name: string, actual: number[][], source: CompositeClip): void =>
      points.forEach(([x, y], index) => {
        const reference = expected(source, x!, y!, width, height);
        expect(actual[index]![3], `${name} alpha at ${x},${y}`).toBe(255);
        reference.forEach((channel, at) => {
          const error = Math.abs(actual[index]![at]! - channel * 255);
          sum += error;
          count++;
          maximum = Math.max(maximum, error);
          expect(error, `${name} at ${x},${y} channel ${at}`).toBeLessThan(2);
        });
      });
    // The fixture must be sensitive: every filter visibly changes the unfiltered image.
    for (const item of cases) {
      const unfiltered = {
        ...item.source,
        settings: { ...item.source.settings, hdr: 0 },
        detail: { sharpen: 0, clarity: 0, denoise: 0 },
      };
      const change = Math.max(
        ...points.flatMap(([x, y]) => {
          const filtered = expected(item.source, x!, y!, width, height);
          return expected(unfiltered, x!, y!, width, height).map(
            (channel, at) => Math.abs(channel - filtered[at]!) * 255,
          );
        }),
      );
      expect(change, `${item.name} visibly changes the fixture`).toBeGreaterThan(8);
    }
    cases.forEach((item, index) => check(item.name, result.rendered[index]!, item.source));
    check('grouped Sharpen', result.grouped, cases[0]!.source);
    await testInfo.attach('detail-gpu-parity-metrics', {
      contentType: 'application/json',
      body: JSON.stringify({ width, height, renderer: result.renderer, mean: sum / count, maximum }),
    });
    expect(sum / count).toBeLessThan(0.6);
  });
}
