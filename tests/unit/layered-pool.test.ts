import { afterAll, describe, expect, it } from 'vitest';
import { ColourLutCache } from '../../src/server/layered-colour.js';
import { composeLayerFrame, fittedContent, type LayerFrameSource } from '../../src/server/layered-frame.js';
import { CompositorPool, MAX_COMPOSITOR_THREADS } from '../../src/server/layered-pool.js';
import {
  compileGradeInto,
  createColourSettings,
  gradePixel,
  NEUTRAL_COLOUR,
  type ColourSettings,
} from '../../src/shared/colour.js';
import { NEUTRAL_SPATIAL_POSE, type SpatialPose } from '../../src/shared/spatial.js';

const target = { width: 37, height: 23 };
const original = { width: 64, height: 48 };
const signal = new AbortController().signal;
const pool = CompositorPool.forHost(4)!;
afterAll(() => pool.close());

function shared(bytes: number): Buffer {
  return Buffer.from(new SharedArrayBuffer(bytes));
}

function source(
  colour: ColourSettings,
  pose: Partial<SpatialPose> = {},
  seed = 1,
  blendWeight = 1,
  rgb = shared(target.width * target.height * 3),
): LayerFrameSource {
  for (let index = 0; index < rgb.length; index++) rgb[index] = ((index + seed) * 2654435761) >>> 24;
  return {
    sample: {
      clipId: `clip-${seed}`,
      mediaId: 'media',
      layerId: 'row',
      sourceFrame: 3,
      sourcePosition: 3.25,
      spatial: { ...NEUTRAL_SPATIAL_POSE, ...pose },
      colour,
      weight: blendWeight,
      blendWeight,
      brightness: 0.8,
      opacity: 0.9,
    },
    rgb,
    bounds: fittedContent(original, target),
    original,
  };
}

const advanced = createColourSettings();
Object.assign(advanced, { temperature: -0.4, tint: 0.2, exposure: 0.3, hue: 14, saturation: 1.3, shadows: 0.2 });
advanced.hsl.blue = { hue: 9, saturation: 1, lightness: -0.05 };
advanced.curves.master = [
  { x: 0, y: 0.03 },
  { x: 0.5 - 1e-7, y: 0.2 },
  { x: 0.5, y: 0.8 },
  { x: 1, y: 0.97 },
];
const scalar: ColourSettings = { ...NEUTRAL_COLOUR, temperature: 0.3, exposure: -0.2, contrast: 1.2 };
const moved = { translateX: 0.08, translateY: -0.11, rotation: -23, scale: 1.4, cropTop: 0.1 };

describe('worker compositing over shared frame memory', () => {
  it('bounds threads by spare host cores and composites in process without two spare cores', async () => {
    expect(CompositorPool.forHost(2)).toBeNull();
    const capped = CompositorPool.forHost(64)!;
    expect(capped.threads).toBe(MAX_COMPOSITOR_THREADS);
    await capped.close();
    expect(pool.threads).toBe(3);
  });

  it.each([
    ['exact advanced colour, neutral pose', [source(advanced)]],
    ['exact advanced colour, transformed pose', [source(advanced, moved)]],
    ['scalar LUT colour, neutral pose', [source(scalar)]],
    ['scalar LUT colour, transformed pose', [source(scalar, moved)]],
    ['dissolve with exact and LUT sources', [source(advanced, {}, 1, 0.35), source(scalar, moved, 7, 0.65)]],
  ])('writes the same RGBA16 bytes as in-process compositing: %s', async (_, sources) => {
    const expected = Buffer.alloc(target.width * target.height * 8, 0x35);
    await composeLayerFrame(expected, target, sources, new ColourLutCache(), signal);
    const actual = shared(expected.length).fill(0x35);
    await composeLayerFrame(actual, target, sources, new ColourLutCache(), signal, pool);
    expect(actual.equals(expected)).toBe(true);
  });

  it('fills the same LUT in worker slices as in process', async () => {
    const inProcess = await new ColourLutCache().get(scalar, signal);
    const pooled = await new ColourLutCache().get(scalar, signal, pool);
    expect(pooled.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(Buffer.from(pooled.buffer).equals(Buffer.from(inProcess.buffer))).toBe(true);
  });

  it('never copies frames: unshared buffers are rejected before any worker runs', async () => {
    const unshared = source(advanced, {}, 1, 1, Buffer.alloc(target.width * target.height * 3));
    await expect(
      composeLayerFrame(
        shared(target.width * target.height * 8),
        target,
        [unshared],
        new ColourLutCache(),
        signal,
        pool,
      ),
    ).rejects.toThrow('requires shared frame and LUT memory');
    await expect(
      composeLayerFrame(
        Buffer.alloc(target.width * target.height * 8),
        target,
        [source(advanced)],
        new ColourLutCache(),
        signal,
        pool,
      ),
    ).rejects.toThrow('requires shared frame and LUT memory');
  });

  it('reports a worker failure only after every band settles, and remains usable', async () => {
    const output = new Uint16Array(new SharedArrayBuffer(target.width * target.height * 8));
    const broken = {
      rgb: new Uint8Array(new SharedArrayBuffer(target.width * target.height * 3)),
      bounds: fittedContent(original, target),
      lut: null,
      exactColour: null,
      multiplier: 1,
      coverage: 1,
      mapping: { neutral: true },
      fullCanvas: false,
    } as never;
    await expect(pool.composeRows(output, target, [broken])).rejects.toThrow();
    const recovered = shared(target.width * target.height * 8);
    await composeLayerFrame(recovered, target, [source(advanced)], new ColourLutCache(), signal, pool);
    expect(recovered.some((byte) => byte !== 0)).toBe(true);
  });

  it('rejects instead of hanging once its workers have exited', async () => {
    const closed = CompositorPool.forHost(3)!;
    await closed.close();
    await expect(
      composeLayerFrame(
        shared(target.width * target.height * 8),
        target,
        [source(advanced)],
        new ColourLutCache(),
        signal,
        closed,
      ),
    ).rejects.toThrow('Compositor worker exited');
  });
});

describe('tabulated byte grading', () => {
  it('is bitwise identical to grading code / 255, with and without scalar stages', () => {
    for (const settings of [advanced, scalar, { ...advanced, ...NEUTRAL_COLOUR, hsl: advanced.hsl }]) {
      const grade = compileGradeInto(settings);
      const fromBytes = new Float64Array(3);
      for (let code = 0; code < 256 * 7; code++) {
        const red = code % 256;
        const green = (code * 37) % 256;
        const blue = (code * 101) % 256;
        grade.bytes(red, green, blue, fromBytes);
        expect([...fromBytes]).toEqual(gradePixel([red / 255, green / 255, blue / 255], settings));
      }
    }
  });
});
