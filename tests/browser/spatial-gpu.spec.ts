import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { CompositeClip, CompositeGroup } from '../../src/preview/compositor.js';
import { gradePixel, NEUTRAL_COLOUR, type RGB } from '../../src/shared/colour.js';
import { NEUTRAL_SPATIAL_POSE, type SpatialPose } from '../../src/shared/spatial.js';

// Bundle the real compositor in memory only: no editor, fixtures, original media,
// saved project, API writes or changes to the output served by other browser tests.
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
        name: 'SpatialGpu',
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

const textureWidth = 9;
const textureHeight = 7;
// uploadPixels has flipY=false. Row zero is the BOTTOM of the texture, unlike a
// video uploaded with flipY=true. Deliberately asymmetric RGB detects both flips.
const textures = [0, 1].map((slot) =>
  Array.from({ length: textureWidth * textureHeight * 4 }, (_, index) => {
    const channel = index % 4;
    const pixel = Math.floor(index / 4);
    const x = pixel % textureWidth;
    const bottomY = Math.floor(pixel / textureWidth);
    return channel === 3
      ? 255
      : 20 + ((x * [13, 7, 17][channel]! + bottomY * [19, 23, 11][channel]! + slot * 37) % 210);
  }),
);

function clip(slot: number, pose: Partial<SpatialPose> = {}, overrides: Partial<CompositeClip> = {}): CompositeClip {
  return {
    slot,
    settings: { ...NEUTRAL_COLOUR },
    aspect: textureWidth / textureHeight,
    // Intentionally NOT the texture aspect: geometry must use original metadata.
    originalWidth: 4031,
    originalHeight: 3017,
    spatial: { ...NEUTRAL_SPATIAL_POSE, ...pose },
    opacity: 1,
    blendWeight: 1,
    brightness: 1,
    ...overrides,
  };
}

function bilinear(slot: number, u: number, v: number): RGB {
  const px = u * textureWidth - 0.5;
  const py = (1 - v) * textureHeight - 0.5;
  const x = Math.floor(px);
  const y = Math.floor(py);
  const dx = px - x;
  const dy = py - y;
  const pixels = textures[slot]!;
  const value = (column: number, row: number, channel: number): number =>
    pixels[
      (Math.max(0, Math.min(textureHeight - 1, row)) * textureWidth + Math.max(0, Math.min(textureWidth - 1, column))) *
        4 +
        channel
    ]! / 255;
  return [0, 1, 2].map(
    (channel) =>
      (value(x, y, channel) * (1 - dx) + value(x + 1, y, channel) * dx) * (1 - dy) +
      (value(x, y + 1, channel) * (1 - dx) + value(x + 1, y + 1, channel) * dx) * dy,
  ) as unknown as RGB;
}

function sample(
  source: CompositeClip,
  x: number,
  y: number,
  width: number,
  height: number,
): { rgb: RGB; mask: number } {
  const pose = source.spatial;
  const neutral = Object.keys(NEUTRAL_SPATIAL_POSE).every(
    (key) => pose[key as keyof SpatialPose] === NEUTRAL_SPATIAL_POSE[key as keyof SpatialPose],
  );
  let u: number;
  let v: number;
  if (neutral) {
    const canvasAspect = width / height;
    u = (x + 0.5) / width;
    v = (y + 0.5) / height;
    if (source.aspect > canvasAspect) v = ((v - 0.5) * source.aspect) / canvasAspect + 0.5;
    else u = ((u - 0.5) * canvasAspect) / source.aspect + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return { rgb: [0, 0, 0], mask: 1 };
  } else {
    // Independent inverse in pixel space, not the GPU's normalized affine rows.
    const fit = Math.min(width / source.originalWidth, height / source.originalHeight);
    const dx = x + 0.5 - width * (0.5 + pose.translateX);
    const dy = y + 0.5 - height * (0.5 + pose.translateY);
    const angle = (pose.rotation * Math.PI) / 180;
    u = 0.5 + (Math.cos(angle) * dx + Math.sin(angle) * dy) / (fit * source.originalWidth * pose.scale);
    v = 0.5 + (-Math.sin(angle) * dx + Math.cos(angle) * dy) / (fit * source.originalHeight * pose.scale);
    if (u < pose.cropLeft || u >= 1 - pose.cropRight || v < pose.cropTop || v >= 1 - pose.cropBottom)
      return { rgb: [0, 0, 0], mask: 0 };
  }
  return { rgb: gradePixel(bilinear(source.slot, u, v), source.settings), mask: 1 };
}

interface BlendPrecision {
  sourceUnorm8: boolean;
  alphaUnorm8: boolean;
}

function reference(
  groups: readonly CompositeGroup[],
  x: number,
  y: number,
  width: number,
  height: number,
  blendPrecision: BlendPrecision,
): RGB {
  let lower: RGB = [0, 0, 0];
  for (const group of groups) {
    const rgb = [0, 0, 0];
    let alpha = 0;
    for (const source of group.clips) {
      const sampled = sample(source, x, y, width, height);
      const coverage = sampled.mask * source.opacity * source.blendWeight;
      alpha += coverage;
      sampled.rgb.forEach((channel, index) => {
        rgb[index]! += channel * coverage * source.brightness;
      });
    }
    // Constant-output probes independently establish whether source RGB/alpha
    // are converted to the normalized buffer's precision BEFORE source-over.
    // Texture sampling, geometry and grade remain independently calculated.
    const blendAlpha = blendPrecision.alphaUnorm8 ? Math.round(alpha * 255) / 255 : alpha;
    lower = rgb.map((channel, index) => {
      const source = blendPrecision.sourceUnorm8 ? Math.round(channel * 255) / 255 : channel;
      return Math.round(Math.min(1, Math.max(0, source + lower[index]! * (1 - blendAlpha))) * 255) / 255;
    }) as unknown as RGB;
  }
  return lower;
}

const cases: { name: string; groups: CompositeGroup[] }[] = [
  { name: 'identity opaque letterbox', groups: [{ clips: [clip(0)] }] },
  {
    name: 'identity letterbox covers lower row',
    groups: [{ clips: [clip(1, {}, { aspect: 16 / 9 })] }, { clips: [clip(0)] }],
  },
  ...[
    ['crop', { cropLeft: 0.17, cropRight: 0.13, cropTop: 0.11, cropBottom: 0.21 }],
    ['scale', { scale: 0.61 }],
    ['translation', { translateX: 0.19, translateY: -0.23 }],
    ['clockwise rotation', { rotation: 37 }],
    ['combined', { scale: 1.31, rotation: -29, translateX: -0.13, translateY: 0.07, cropLeft: 0.14, cropBottom: 0.23 }],
  ].map(([name, pose]) => ({ name: String(name), groups: [{ clips: [clip(0, pose as Partial<SpatialPose>)] }] })),
  {
    name: 'bottom-to-top differing dissolve poses, grade, row opacity and black fade',
    groups: [
      { clips: [clip(1, {}, { opacity: 0.8 })] },
      {
        clips: [
          clip(
            0,
            { scale: 0.83, rotation: 21, cropRight: 0.18 },
            {
              opacity: 0.63,
              blendWeight: 0.37,
              brightness: 0.4,
              settings: { ...NEUTRAL_COLOUR, exposure: 0.4, hue: 19, saturation: 0.8, shadows: 0.1 },
            },
          ),
          clip(
            1,
            { translateX: 0.21, translateY: -0.17, cropTop: 0.23 },
            {
              opacity: 0.63,
              blendWeight: 0.63,
              brightness: 0.7,
              settings: { ...NEUTRAL_COLOUR, exposure: 0.4, hue: 19, saturation: 0.8, shadows: 0.1 },
            },
          ),
        ],
      },
      { clips: [clip(0, { scale: 0.45, translateY: 0.12 }, { opacity: 0.51, brightness: 0 })] },
    ],
  },
];

for (const [width, height] of [
  [1280, 720],
  [3840, 2160],
] as const) {
  test(`pure GPU spatial numeric parity at ${width}×${height}`, async ({ page }, testInfo) => {
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic GPU only</title>' }),
    );
    await page.goto('/');
    await page.addScriptTag({ content: compositorScript });
    const points = Array.from({ length: 81 }, (_, index) => [
      Math.floor((((index % 9) + 0.31) * width) / 9),
      Math.floor(((Math.floor(index / 9) + 0.43) * height) / 9),
    ]);
    const result = await page.evaluate(
      ({ width, height, cases, textures, points, textureWidth, textureHeight, neutralColour }) => {
        const gpu = (globalThis as unknown as { SpatialGpu: typeof import('../../src/preview/compositor.js') })
          .SpatialGpu;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const compositor = new gpu.Compositor(canvas);
        try {
          compositor.uploadPixels(0, new Uint8Array(textures[0]!), textureWidth, textureHeight);
          compositor.uploadPixels(1, new Uint8Array(textures[1]!), textureWidth, textureHeight);
          const gl = compositor.gl;
          const pixel = new Uint8Array(4);
          const rendered = cases.map((fixture) => {
            compositor.drawFrame(fixture.groups);
            return points.map(([x, y]) => {
              gl.readPixels(x!, height - 1 - y!, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              return Array.from(pixel);
            });
          });
          const mixedFixture = cases[cases.length - 1]!;
          const stagePrefixes = mixedFixture.groups.map((_, index) => {
            compositor.drawFrame(mixedFixture.groups.slice(0, index + 1));
            return points.map(([x, y]) => {
              gl.readPixels(x!, height - 1 - y!, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              return Array.from(pixel);
            });
          });
          // Isolate native texture filtering from grade, coverage and later blends.
          // Keep each source's exact aspect/metadata/pose and read unblended bytes.
          const sourcePrefixes = mixedFixture.groups.map((group) =>
            group.clips.map((source) => {
              compositor.drawFrame([
                {
                  clips: [
                    {
                      ...source,
                      opacity: 1,
                      blendWeight: 1,
                      brightness: 1,
                      settings: neutralColour,
                    },
                  ],
                },
              ]);
              return points.map(([x, y]) => {
                gl.readPixels(x!, height - 1 - y!, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                return Array.from(pixel);
              });
            }),
          );
          // Test-only 1-pixel float target: preserve the production shader and
          // uniforms, shifting the full-size viewport to the requested pixel.
          // This reads the fragment output BEFORE normalized-buffer conversion.
          if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float probe target unavailable.');
          const target = gl.createTexture()!;
          const framebuffer = gl.createFramebuffer()!;
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, target);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Float probe framebuffer incomplete.');
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const floating = new Float32Array(4);
          const floatOutput = (groups: typeof mixedFixture.groups) => {
            // Bind the real program, uniforms, textures and VAO without another
            // full-resolution diagnostic raster. The actual 81 probe draws below
            // retain the full viewport coordinates on their 1-pixel float target.
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(0, 0, 0, 0);
            try {
              compositor.drawFrame(groups);
            } finally {
              gl.disable(gl.SCISSOR_TEST);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            const output = points.map(([x, y]) => {
              gl.viewport(-x!, -(height - 1 - y!), width, height);
              gl.drawArrays(gl.TRIANGLES, 0, 3);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, floating);
              return Array.from(floating);
            });
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return output;
          };
          const floatGroups = mixedFixture.groups.map((group) => floatOutput([group]));
          const floatSources = mixedFixture.groups.map((group) =>
            group.clips.map((source) =>
              floatOutput([
                {
                  clips: [
                    {
                      ...source,
                      opacity: 1,
                      blendWeight: 1,
                      brightness: 1,
                      settings: neutralColour,
                    },
                  ],
                },
              ]),
            ),
          );
          // Constant output has NO texture, geometry mapping or grade. Values
          // around half-byte boundaries distinguish preblend conversion from
          // converting only the final source-over result.
          const constantVertex = gl.createShader(gl.VERTEX_SHADER)!;
          gl.shaderSource(
            constantVertex,
            `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0, 1);
}`,
          );
          gl.compileShader(constantVertex);
          const constantFragment = gl.createShader(gl.FRAGMENT_SHADER)!;
          gl.shaderSource(
            constantFragment,
            `#version 300 es
precision highp float;
uniform vec4 value;
uniform highp sampler2D source;
uniform vec2 coordinate;
uniform bool sampleTexture;
out vec4 colour;
void main() { colour = sampleTexture ? texture(source, coordinate) : value; }`,
          );
          gl.compileShader(constantFragment);
          const constantProgram = gl.createProgram()!;
          gl.attachShader(constantProgram, constantVertex);
          gl.attachShader(constantProgram, constantFragment);
          gl.linkProgram(constantProgram);
          if (!gl.getProgramParameter(constantProgram, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(constantProgram)!);
          gl.useProgram(constantProgram);
          gl.viewport(0, 0, 1, 1);
          // clear() ignores the viewport. These independent 1-pixel blend
          // probes must not clear the entire UHD drawing buffer twenty times.
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, 1, 1);
          gl.enable(gl.BLEND);
          const constantBlends = [0.23, 0.3969, 0.51, 0.63, 0.8].flatMap((alpha) =>
            [0.27, 0.49, 0.51, 0.77].map((fraction) => {
              const source = (37 + fraction) / 255;
              const destination = 161 / 255;
              gl.clearColor(destination, destination, destination, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
              gl.uniform4f(gl.getUniformLocation(constantProgram, 'value'), source, source, source, alpha);
              gl.drawArrays(gl.TRIANGLES, 0, 3);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              return { source, destination, alpha, actual: Array.from(pixel) };
            }),
          );
          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
          // Direct texture() probe removes even the neutral grading roundtrip.
          // The source is the existing asymmetric synthetic texture, not data
          // read from a composed fixture or its expected output.
          gl.uniform1i(gl.getUniformLocation(constantProgram, 'source'), 0);
          gl.uniform1i(gl.getUniformLocation(constantProgram, 'sampleTexture'), 1);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          const textureSamples = [
            [0.31, 0.43],
            [0.17, 0.62],
            [0.83, 0.21],
            [0.49, 0.77],
          ].map(([u, v]) => {
            gl.uniform2f(gl.getUniformLocation(constantProgram, 'coordinate'), u!, 1 - v!);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, floating);
            return { u: u!, v: v!, actual: Array.from(floating) };
          });
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(framebuffer);
          gl.deleteTexture(target);
          gl.deleteProgram(constantProgram);
          gl.deleteShader(constantVertex);
          gl.deleteShader(constantFragment);
          return {
            rendered,
            stagePrefixes,
            sourcePrefixes,
            floatGroups,
            floatSources,
            constantBlends,
            textureSamples,
            channelBits: {
              red: gl.getParameter(gl.RED_BITS) as number,
              green: gl.getParameter(gl.GREEN_BITS) as number,
              blue: gl.getParameter(gl.BLUE_BITS) as number,
              alpha: gl.getParameter(gl.ALPHA_BITS) as number,
            },
            renderer: compositor.renderer,
            textureMiB: compositor.gpuTextureMiB,
            error: gl.getError(),
          };
        } finally {
          compositor.dispose();
          compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      },
      { width, height, cases, textures, points, textureWidth, textureHeight, neutralColour: NEUTRAL_COLOUR },
    );
    // Independent Node-side references; diagnostics do not change GPU inputs,
    // tolerances or assertions. Attach before assertions can stop at the first pixel.
    // Test RGB and alpha independently, including the two hybrid hypotheses.
    // No renderer/browser-name branch and no calibration against fixture pixels.
    const blendModels = [false, true]
      .flatMap((sourceUnorm8) => [false, true].map((alphaUnorm8) => ({ sourceUnorm8, alphaUnorm8 })))
      .filter(({ sourceUnorm8, alphaUnorm8 }) =>
        result.constantBlends.every(({ source, destination, alpha, actual }) => {
          const s = sourceUnorm8 ? Math.round(source * 255) / 255 : source;
          const a = alphaUnorm8 ? Math.round(alpha * 255) / 255 : alpha;
          const expected = Math.round((s + destination * (1 - a)) * 255);
          return actual.slice(0, 3).every((channel) => channel === expected) && actual[3] === 255;
        }),
      );
    await testInfo.attach('spatial-gpu-quantization-probes', {
      contentType: 'application/json',
      body: JSON.stringify({
        width,
        height,
        points,
        renderer: result.renderer,
        channelBits: result.channelBits,
        blendModels,
        floatSources: result.floatSources,
        floatGroups: result.floatGroups,
        constantBlends: result.constantBlends,
        textureSamples: result.textureSamples.map((sample) => ({
          ...sample,
          expected: bilinear(0, sample.u, sample.v),
        })),
      }),
    });
    expect(blendModels, 'constant probes must uniquely establish the blend conversion order').toHaveLength(1);
    const blendPrecision = blendModels[0]!;
    result.textureSamples.forEach(({ u, v, actual }) => {
      bilinear(0, u, v).forEach((expected, channel) =>
        expect(Math.abs(actual[channel]! - expected) * 255, `raw texture sample ${u},${v}`).toBeLessThan(2),
      );
      expect(actual[3]).toBe(1);
    });
    const pixelEvidence = cases.map((fixture, caseIndex) =>
      points.map(([x, y], pointIndex) => {
        const expected = [
          ...reference(fixture.groups, x!, y!, width, height, blendPrecision).map((channel) => channel * 255),
          255,
        ];
        const actual = result.rendered[caseIndex]![pointIndex]!;
        return { expected, actual, delta: actual.map((channel, index) => channel - expected[index]!) };
      }),
    );
    const badPixels = pixelEvidence.flatMap((pixels, caseIndex) =>
      pixels.flatMap((pixel, pointIndex) =>
        pixel.actual[3] !== 255 || pixel.delta.slice(0, 3).some((delta) => Math.abs(delta) >= 2)
          ? [{ caseIndex, pointIndex, ...pixel }]
          : [],
      ),
    );
    if (badPixels.length > 0) {
      const mixedFixture = cases[cases.length - 1]!;
      await testInfo.attach('spatial-gpu-failure-evidence', {
        contentType: 'application/json',
        body: JSON.stringify({
          width,
          height,
          renderer: result.renderer,
          channelBits: result.channelBits,
          cases,
          points,
          pixelEvidence,
          badPixels,
          sourcePrefixes: mixedFixture.groups.flatMap((group, groupIndex) =>
            group.clips.map((source, clipIndex) => {
              const neutralSource = {
                ...source,
                opacity: 1,
                blendWeight: 1,
                brightness: 1,
                settings: NEUTRAL_COLOUR,
              };
              return {
                groupIndex,
                clipIndex,
                source: neutralSource,
                pixels: points.map(([x, y], pointIndex) => {
                  // Neutral grading is identity: retain independently bilinear
                  // source RGB * 255, without reference drawing-buffer rounding.
                  const sampled = sample(neutralSource, x!, y!, width, height);
                  const expected = [...sampled.rgb.map((channel) => channel * sampled.mask * 255), 255];
                  const actual = result.sourcePrefixes[groupIndex]![clipIndex]![pointIndex]!;
                  return { expected, actual, delta: actual.map((channel, index) => channel - expected[index]!) };
                }),
              };
            }),
          ),
          stagePrefixes: mixedFixture.groups.map((_, index) => ({
            groupCount: index + 1,
            caseIndex: cases.length - 1,
            pixels: points.map(([x, y], pointIndex) => ({
              expected: [
                ...reference(mixedFixture.groups.slice(0, index + 1), x!, y!, width, height, blendPrecision).map(
                  (channel) => channel * 255,
                ),
                255,
              ],
              actual: result.stagePrefixes[index]![pointIndex]!,
            })),
          })),
        }),
      });
    }
    expect(result.renderer).not.toBe('');
    expect(result.error).toBe(0);
    expect(result.textureMiB).toBe((2 * textureWidth * textureHeight * 4) / 1024 ** 2);
    let sum = 0;
    let maximum = 0;
    cases.forEach((fixture, caseIndex) =>
      points.forEach(([x, y], pointIndex) => {
        const expected = reference(fixture.groups, x!, y!, width, height, blendPrecision);
        const actual = result.rendered[caseIndex]![pointIndex]!;
        expect(actual[3], `${fixture.name} alpha at ${x},${y}`).toBe(255);
        expected.forEach((channel, index) => {
          const error = Math.abs(actual[index]! - channel * 255);
          sum += error;
          maximum = Math.max(maximum, error);
          expect(error, `${fixture.name} at ${x},${y} channel ${index}`).toBeLessThan(2);
        });
      }),
    );
    expect(sum / (cases.length * points.length * 3)).toBeLessThan(0.6);
    expect(maximum).toBeLessThan(2);
    await testInfo.attach('spatial-gpu-parity-metrics', {
      contentType: 'application/json',
      body: JSON.stringify({
        width,
        height,
        renderer: result.renderer,
        blendPrecision,
        mean: sum / (cases.length * points.length * 3),
        maximum,
      }),
    });
  });
}

test('synthetic orientation and dyadic half-open crop edges preserve lower coverage and black fades', async ({
  page,
}) => {
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>GPU edges</title>' }),
  );
  await page.goto('/');
  await page.addScriptTag({ content: compositorScript });
  const result = await page.evaluate(() => {
    const gpu = (globalThis as unknown as { SpatialGpu: typeof import('../../src/preview/compositor.js') }).SpatialGpu;
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const compositor = new gpu.Compositor(canvas);
    const settings = { exposure: 0, brightness: 0, contrast: 1, hue: 0, saturation: 1, highlights: 0, shadows: 0 };
    const spatial = {
      cropLeft: 0,
      cropRight: 0,
      cropTop: 0,
      cropBottom: 0,
      scale: 1,
      translateX: 0,
      translateY: 0,
      rotation: 0,
    };
    const source = {
      slot: 0,
      settings,
      aspect: 1,
      originalWidth: 8,
      originalHeight: 8,
      spatial,
      opacity: 1,
      blendWeight: 1,
      brightness: 1,
    };
    try {
      // Bottom row blue, top row red. Nonneutral mapping must agree with neutral.
      compositor.uploadPixels(0, new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255]), 1, 2);
      compositor.uploadPixels(1, new Uint8Array([0, 255, 0, 255]), 1, 1);
      const gl = compositor.gl;
      const pixel = new Uint8Array(4);
      const read = (x: number, y: number) => {
        gl.readPixels(x, 7 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return Array.from(pixel);
      };
      compositor.drawFrame([{ clips: [source] }]);
      const neutral = [read(3, 0), read(3, 7)];
      compositor.drawFrame([{ clips: [{ ...source, slot: 1 }] }, { clips: [{ ...source, aspect: 2 }] }]);
      const opaqueLetterbox = read(3, 0);
      compositor.drawFrame([
        {
          clips: [
            {
              ...source,
              spatial: { ...spatial, cropLeft: 0.1875, cropRight: 0.3125, cropTop: 0.1875, cropBottom: 0.3125 },
            },
          ],
        },
      ]);
      const transformed = [read(2, 1), read(2, 4), read(2, 5)];
      compositor.drawFrame([
        { clips: [{ ...source, slot: 1 }] },
        {
          clips: [
            {
              ...source,
              spatial: { ...spatial, cropLeft: 0.1875, cropRight: 0.3125, cropTop: 0.1875, cropBottom: 0.3125 },
              brightness: 0,
            },
          ],
        },
      ]);
      const edges = [
        [0, 3],
        [1, 3],
        [4, 3],
        [5, 3],
        [3, 0],
        [3, 1],
        [3, 4],
        [3, 5],
      ].map(([x, y]) => read(x!, y!));
      return { neutral, opaqueLetterbox, transformed, edges, error: gl.getError() };
    } finally {
      compositor.dispose();
      compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  });
  expect(result.error).toBe(0);
  expect(result.neutral).toEqual([
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
  expect(result.opaqueLetterbox).toEqual([0, 0, 0, 255]);
  expect(result.transformed[0]![0]).toBeGreaterThan(result.transformed[0]![2]!);
  expect(result.transformed[1]![2]).toBeGreaterThan(result.transformed[1]![0]!);
  // OUT at y=5 is transparent, not a vertically flipped source image.
  expect(result.transformed[2]).toEqual([0, 0, 0, 255]);
  const green = [0, 255, 0, 255];
  const black = [0, 0, 0, 255];
  expect(result.edges).toEqual([green, black, black, green, green, black, black, green]);
});
