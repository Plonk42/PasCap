import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as files from '../../src/server/files.js';
import { ColourLutCache, sampleColourLut } from '../../src/server/layered-colour.js';
import { renderLayeredExport } from '../../src/server/layered-export.js';
import { composeLayerFrame, fittedContent, type LayerFrameSource } from '../../src/server/layered-frame.js';
import { RawFrameReader, RawVideoPass } from '../../src/server/raw-process.js';
import * as retime from '../../src/server/retime-process.js';
import { gradePixel, NEUTRAL_COLOUR, type ColourSettings, type RGB } from '../../src/shared/colour.js';
import { LAYERED_EXPORT_RESOURCES, planLayeredExport } from '../../src/shared/export.js';
import { mediaAssetSchema } from '../../src/shared/media.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE, type SpatialPose } from '../../src/shared/spatial.js';
import type { PreviewLayer } from '../../src/shared/timeline.js';
import * as timeline from '../../src/shared/timeline.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

// These ownership tests exercise the renderer with in-memory pipes only, never native jobs or disk.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rm: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => vi.restoreAllMocks());

const signal = (): AbortSignal => new AbortController().signal;
const mild: ColourSettings = { ...NEUTRAL_COLOUR, exposure: 0.2, shadows: 0.08, highlights: -0.06 };

function sample(pose: Partial<SpatialPose> = {}, overrides: Partial<PreviewLayer> = {}): PreviewLayer {
  return {
    clipId: 'clip',
    mediaId: 'source',
    layerId: 'row',
    sourceFrame: 7,
    sourcePosition: 7.5,
    spatial: { ...NEUTRAL_SPATIAL_POSE, ...pose },
    colour: { ...NEUTRAL_COLOUR },
    weight: 1,
    blendWeight: 1,
    brightness: 1,
    opacity: 1,
    ...overrides,
  };
}

function patternedSource(
  target: { width: number; height: number },
  original: { width: number; height: number },
  current = sample(),
): LayerFrameSource {
  const bounds = fittedContent(original, target);
  // Poison padding: no bilinear tap may use it, even immediately inside a content edge.
  const rgb = Buffer.alloc(target.width * target.height * 3, 255);
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const offset = (y * target.width + x) * 3;
      rgb[offset] = 30 + ((x * 37 + y * 19) % 150);
      rgb[offset + 1] = 40 + ((x * 23 + y * 31) % 150);
      rgb[offset + 2] = 50 + ((x * 17 + y * 43) % 150);
    }
  }
  return { sample: current, rgb, bounds, original };
}

function rgba(buffer: Buffer): Uint16Array {
  return new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
}

/** Independent inverse geometry: pixel-space undo of translation, clockwise rotation and scale. */
function referenceRgb(
  source: LayerFrameSource,
  target: { width: number; height: number },
  x: number,
  y: number,
): RGB | null {
  const pose = source.sample.spatial;
  const fit = Math.min(target.width / source.original.width, target.height / source.original.height);
  const radians = (pose.rotation * Math.PI) / 180;
  const dx = x + 0.5 - target.width * (0.5 + pose.translateX);
  const dy = y + 0.5 - target.height * (0.5 + pose.translateY);
  const u = 0.5 + (Math.cos(radians) * dx + Math.sin(radians) * dy) / (pose.scale * fit * source.original.width);
  const v = 0.5 + (-Math.sin(radians) * dx + Math.cos(radians) * dy) / (pose.scale * fit * source.original.height);
  if (u < pose.cropLeft || u >= 1 - pose.cropRight || v < pose.cropTop || v >= 1 - pose.cropBottom) return null;
  const bounds = source.bounds;
  const sx = Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, bounds.x + u * bounds.width - 0.5));
  const sy = Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, bounds.y + v * bounds.height - 0.5));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  const pixel = (xx: number, yy: number, channel: number): number =>
    source.rgb[(yy * target.width + xx) * 3 + channel]!;
  const channel = (index: number): number => {
    const x1 = Math.min(x0 + 1, bounds.x + bounds.width - 1);
    const y1 = Math.min(y0 + 1, bounds.y + bounds.height - 1);
    return (
      (pixel(x0, y0, index) * (1 - fx) * (1 - fy) +
        pixel(x1, y0, index) * fx * (1 - fy) +
        pixel(x0, y1, index) * (1 - fx) * fy +
        pixel(x1, y1, index) * fx * fy) /
      255
    );
  };
  return [channel(0), channel(1), channel(2)];
}

describe('native spatial sampling without transformed frame storage', () => {
  it.each([NEUTRAL_COLOUR, mild])(
    'preserves the neutral legacy byte-index path, including opaque ungraded letterbox',
    async (colour) => {
      const target = { width: 8, height: 6 };
      const source = patternedSource(
        target,
        { width: 13, height: 7 },
        sample({}, { colour, opacity: 0.65, brightness: 0.4 }),
      );
      const cache = new ColourLutCache();
      const lut = await cache.get(colour, signal());
      const buffer = Buffer.alloc(target.width * target.height * 8);
      const expected = Buffer.alloc(buffer.length);
      rgba(buffer).fill(12345);
      rgba(expected).fill(12345);
      const graded = new Float64Array(3);
      const output = rgba(expected);
      const { bounds } = source;
      for (let y = 0; y < target.height; y++) {
        for (let x = 0; x < target.width; x++) {
          const pixel = y * target.width + x;
          graded.fill(0);
          if (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height)
            sampleColourLut(
              lut,
              source.rgb[pixel * 3]!,
              source.rgb[pixel * 3 + 1]!,
              source.rgb[pixel * 3 + 2]!,
              graded,
            );
          for (let channel = 0; channel < 3; channel++)
            output[pixel * 4 + channel] = Math.round(graded[channel]! * 0.65 * 0.4 * 65535 + 12345 * 0.35);
          output[pixel * 4 + 3] = Math.round(0.65 * 65535 + 12345 * 0.35);
        }
      }
      await composeLayerFrame(buffer, target, [source], cache, signal());
      expect(buffer).toEqual(expected);
      expect([...rgba(buffer).subarray(0, 4)]).toEqual([4321, 4321, 4321, Math.round(0.65 * 65535 + 12345 * 0.35)]);
    },
  );

  const poses: { name: string; pose: Partial<SpatialPose> }[] = [
    { name: 'crop left', pose: { cropLeft: 0.23 } },
    { name: 'crop right', pose: { cropRight: 0.23 } },
    { name: 'crop top', pose: { cropTop: 0.23 } },
    { name: 'crop bottom', pose: { cropBottom: 0.23 } },
    { name: 'shrink', pose: { scale: 0.63 } },
    { name: 'enlarge', pose: { scale: 1.37 } },
    { name: 'translate X', pose: { translateX: 0.19 } },
    { name: 'translate Y', pose: { translateY: -0.17 } },
    { name: 'clockwise quarter turn', pose: { rotation: 90 } },
    { name: 'counterclockwise turn', pose: { rotation: -37 } },
    {
      name: 'combined',
      pose: {
        cropLeft: 0.13,
        cropRight: 0.07,
        cropTop: 0.11,
        cropBottom: 0.09,
        scale: 1.31,
        translateX: -0.11,
        translateY: 0.13,
        rotation: 29,
      },
    },
  ];
  it.each(poses)('$name uses original-aspect inverse geometry and an independent source mask', async ({ pose }) => {
    const target = { width: 8, height: 6 };
    const source = patternedSource(target, { width: 13, height: 7 }, sample(pose));
    const before = { sample: structuredClone(source.sample), rgb: Buffer.from(source.rgb) };
    const buffer = Buffer.alloc(target.width * target.height * 8);
    await composeLayerFrame(buffer, target, [source], new ColourLutCache(), signal());
    const output = rgba(buffer);
    let covered = 0;
    for (let y = 0; y < target.height; y++) {
      for (let x = 0; x < target.width; x++) {
        const rgb = referenceRgb(source, target, x, y);
        const offset = (y * target.width + x) * 4;
        expect(output[offset + 3]).toBe(rgb ? 65535 : 0);
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(output[offset + channel]! - Math.round((rgb?.[channel] ?? 0) * 65535))).toBeLessThanOrEqual(
            1,
          );
        if (rgb) covered++;
      }
    }
    expect(covered).toBeGreaterThan(0);
    expect(source.rgb).toEqual(before.rgb);
    expect(source.sample).toEqual(before.sample); // No timing, source-frame, source-position or A/V state edits.
  });

  it('uses unrounded original geometry rather than the even-rounded content ratio and clamps padding taps', async () => {
    const target = { width: 8, height: 6 };
    const original = { width: 13, height: 7 };
    const source = patternedSource(target, original, sample({ scale: 1.37, translateY: 0.07 }));
    const wrongAspect = { ...source, original: { width: source.bounds.width, height: source.bounds.height } };
    const output = Buffer.alloc(8 * 6 * 8);
    await composeLayerFrame(output, target, [source], new ColourLutCache(), signal());
    let differences = 0;
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 8; x++) {
        const correct = referenceRgb(source, target, x, y);
        const wrong = referenceRgb(wrongAspect, target, x, y);
        if (JSON.stringify(correct) !== JSON.stringify(wrong)) differences++;
        for (let channel = 0; channel < 3; channel++)
          expect(
            Math.abs(rgba(output)[(y * 8 + x) * 4 + channel]! - Math.round((correct?.[channel] ?? 0) * 65535)),
          ).toBeLessThanOrEqual(1);
      }
    }
    expect(differences).toBeGreaterThan(20);
    // A larger portrait content rectangle exposes taps immediately next to both padding edges.
    const edge = patternedSource(target, { width: 7, height: 13 }, sample({ scale: 2 }));
    edge.rgb.fill(255);
    for (let y = edge.bounds.y; y < edge.bounds.y + edge.bounds.height; y++)
      for (let x = edge.bounds.x; x < edge.bounds.x + edge.bounds.width; x++)
        edge.rgb.fill(60, (y * 8 + x) * 3, (y * 8 + x) * 3 + 3);
    await composeLayerFrame(output.fill(0), target, [edge], new ColourLutCache(), signal());
    for (let pixel = 0; pixel < 48; pixel++) {
      const offset = pixel * 4;
      const covered = rgba(output)[offset + 3] !== 0;
      expect([...rgba(output).subarray(offset, offset + 3)]).toEqual(covered ? [15420, 15420, 15420] : [0, 0, 0]);
    }
  });

  it('does not treat an arbitrarily small non-neutral edit as opaque letterbox identity', async () => {
    const target = { width: 8, height: 6 };
    const source = patternedSource(target, { width: 13, height: 7 }, sample({ translateX: Number.EPSILON }));
    const output = Buffer.alloc(48 * 8);
    await composeLayerFrame(output, target, [source], new ColourLutCache(), signal());
    expect([...rgba(output).subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it('keeps a neutral dissolve source opaque in letterbox while the transformed source supplies no mask there', async () => {
    const target = { width: 8, height: 6 };
    const neutral = patternedSource(target, { width: 13, height: 7 }, sample({}, { blendWeight: 0.4, opacity: 0.5 }));
    const transformed = patternedSource(
      target,
      { width: 13, height: 7 },
      sample(
        { cropLeft: 0.25 },
        {
          clipId: 'transformed',
          blendWeight: 0.6,
          opacity: 0.5,
        },
      ),
    );
    const output = Buffer.alloc(48 * 8);
    rgba(output).fill(20000);
    await composeLayerFrame(output, target, [neutral, transformed], new ColourLutCache(), signal());
    expect([...rgba(output).subarray(0, 4)]).toEqual([16000, 16000, 16000, Math.round(0.2 * 65535 + 16000)]);
  });

  it('preserves constant white resampling exactly and leaves the accumulator byte-identical when fully outside', async () => {
    const target = { width: 8, height: 6 };
    const source = patternedSource(target, target, sample({ scale: 1.37, translateX: 0.07 }));
    source.rgb.fill(255);
    const output = Buffer.alloc(48 * 8);
    const cache = new ColourLutCache();
    await composeLayerFrame(output, target, [source], cache, signal());
    expect([...rgba(output)]).toEqual(Array<number>(48 * 4).fill(65535));
    const before = Buffer.from(output);
    source.sample.spatial.translateX = 2;
    await composeLayerFrame(output, target, [source], cache, signal());
    expect(output).toEqual(before);
  });

  it('merges each dissolve mask independently with sole row opacity and coverage-preserving black fades', async () => {
    const target = { width: 4, height: 4 };
    const left = patternedSource(
      target,
      target,
      sample(
        { cropRight: 0.25 },
        {
          clipId: 'left',
          colour: mild,
          opacity: 0.6,
          blendWeight: 0.4,
          brightness: 0.2,
        },
      ),
    );
    const right = patternedSource(
      target,
      target,
      sample(
        { cropLeft: 0.5 },
        {
          clipId: 'right',
          colour: { ...NEUTRAL_COLOUR, exposure: -1 },
          opacity: 0.6,
          blendWeight: 0.6,
          brightness: 0,
        },
      ),
    );
    const cache = new ColourLutCache();
    const lut = await cache.get(mild, signal());
    const graded = new Float64Array(3);
    const buffer = Buffer.alloc(16 * 8);
    rgba(buffer).fill(20000);
    await composeLayerFrame(buffer, target, [left, right], cache, signal());
    for (let pixel = 0; pixel < 16; pixel++) {
      const column = pixel % 4;
      const leftMask = column < 3 ? 1 : 0;
      const rightMask = column >= 2 ? 1 : 0;
      const alpha = 0.6 * (0.4 * leftMask + 0.6 * rightMask);
      sampleColourLut(lut, left.rgb[pixel * 3]!, left.rgb[pixel * 3 + 1]!, left.rgb[pixel * 3 + 2]!, graded);
      for (let channel = 0; channel < 3; channel++)
        expect(rgba(buffer)[pixel * 4 + channel]).toBe(
          Math.round(graded[channel]! * 0.6 * 0.4 * 0.2 * leftMask * 65535 + 20000 * (1 - alpha)),
        );
      expect(rgba(buffer)[pixel * 4 + 3]).toBe(Math.round(alpha * 65535 + 20000 * (1 - alpha)));
    }
    expect(cache.report).toMatchObject({ peakEntries: 2, bytes: 2 * LAYERED_EXPORT_RESOURCES.lutBytes });
    const standalone = Buffer.alloc(buffer.length);
    await composeLayerFrame(standalone, target, [right], cache, signal());
    expect([...rgba(standalone).subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...rgba(standalone).subarray(12, 16)]).toEqual([0, 0, 0, Math.round(0.36 * 65535)]);
    await expect(
      composeLayerFrame(
        buffer,
        target,
        [left, { ...right, sample: { ...right.sample, opacity: 0.5 } }],
        cache,
        signal(),
      ),
    ).rejects.toThrow('authoritative layer group');
    await expect(
      composeLayerFrame(
        buffer,
        target,
        [left, { ...right, sample: { ...right.sample, layerId: 'other' } }],
        cache,
        signal(),
      ),
    ).rejects.toThrow('authoritative layer group');
    await expect(
      composeLayerFrame(
        buffer,
        target,
        [{ ...left, sample: { ...left.sample, blendWeight: 2 } }, right],
        cache,
        signal(),
      ),
    ).rejects.toThrow('coverage');
  });

  it('reuses the accumulator, preserves lower pixels outside coverage and responds at the existing pixel-batch yield', async () => {
    const target = { width: 256, height: 512 };
    const source = patternedSource(target, target, sample({ cropLeft: 0.25 }));
    const cache = new ColourLutCache();
    await cache.get(source.sample.colour, signal());
    const buffer = Buffer.alloc(target.width * target.height * 8);
    rgba(buffer).fill(10000);
    const controller = new AbortController();
    const pending = composeLayerFrame(buffer, target, [source], cache, controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow('cancelled');
    expect(rgba(buffer)[(100 * 256 + 100) * 4 + 3]).toBe(65535);
    expect(rgba(buffer)[(400 * 256 + 100) * 4 + 3]).toBe(10000);
    const backing = buffer.buffer;
    await composeLayerFrame(buffer, target, [source], cache, signal());
    expect(buffer.buffer).toBe(backing);
    expect([...rgba(buffer).subarray(0, 4)]).toEqual([10000, 10000, 10000, 10000]);
    expect(cache.report).toMatchObject({ peakEntries: 1, generated: 1 });
    const before = Buffer.from(buffer);
    const aborted = new AbortController();
    aborted.abort();
    await expect(composeLayerFrame(buffer, target, [source], cache, aborted.signal)).rejects.toThrow('cancelled');
    expect(buffer).toEqual(before);
  });

  it('rejects invalid authoritative dimensions and out-of-canvas content rectangles', async () => {
    const target = { width: 4, height: 4 };
    const source = patternedSource(target, target, sample({ scale: 1.1 }));
    for (const width of [0, -1, NaN, Infinity])
      await expect(
        composeLayerFrame(
          Buffer.alloc(128),
          target,
          [{ ...source, original: { width, height: 4 } }],
          new ColourLutCache(),
          signal(),
        ),
      ).rejects.toThrow('dimensions');
    await expect(
      composeLayerFrame(
        Buffer.alloc(128),
        target,
        [{ ...source, bounds: { x: 3, y: 0, width: 2, height: 4 } }],
        new ColourLutCache(),
        signal(),
      ),
    ).rejects.toThrow('content rectangle');
  });
});

describe('fractional tetrahedral grade after RGB interpolation', () => {
  it('keeps fractions and endpoints without rounding, across all six tetrahedral orderings', async () => {
    const lut = await new ColourLutCache().get(NEUTRAL_COLOUR, signal());
    const out = new Float64Array(3);
    for (const rgb of [
      [100.1, 100.2, 100.3],
      [100.1, 100.3, 100.2],
      [100.2, 100.1, 100.3],
      [100.2, 100.3, 100.1],
      [100.3, 100.1, 100.2],
      [100.3, 100.2, 100.1],
      [0, 255, 0.00001],
      [254.99999, 0, 255],
    ]) {
      sampleColourLut(lut, rgb[0]!, rgb[1]!, rgb[2]!, out);
      for (let channel = 0; channel < 3; channel++) expect(out[channel]).toBeCloseTo(rgb[channel]! / 255, 7);
    }
    for (const invalid of [NaN, Infinity, -Infinity, -0.00001, 255.00001])
      for (const channel of [0, 1, 2]) {
        const rgb = [10.1, 20.2, 30.3];
        rgb[channel] = invalid;
        expect(() => sampleColourLut(lut, rgb[0]!, rgb[1]!, rgb[2]!, out)).toThrow('finite RGB');
      }
  });

  it('approximates direct CPU grading of bilinear RGB within 0.08 / 255 mean error', async () => {
    const target = { width: 16, height: 12 };
    const source = patternedSource(
      target,
      { width: 13, height: 7 },
      sample({ scale: 1.37, rotation: 13, translateX: 0.09 }, { colour: mild }),
    );
    const buffer = Buffer.alloc(target.width * target.height * 8);
    await composeLayerFrame(buffer, target, [source], new ColourLutCache(), signal());
    let error = 0;
    let channels = 0;
    for (let y = 0; y < target.height; y++)
      for (let x = 0; x < target.width; x++) {
        const rgb = referenceRgb(source, target, x, y);
        if (!rgb) continue;
        const expected = gradePixel(rgb, mild);
        for (let channel = 0; channel < 3; channel++) {
          error += Math.abs(rgba(buffer)[(y * target.width + x) * 4 + channel]! / 65535 - expected[channel]!);
          channels++;
        }
      }
    expect(channels).toBeGreaterThan(100);
    expect(error / channels).toBeLessThan(0.08 / 255);
  });

  it('grades the interpolated RGB, not an interpolation of already graded taps', async () => {
    const target = { width: 4, height: 2 };
    const colour = { ...NEUTRAL_COLOUR, contrast: 2, brightness: 0.1 };
    const source = patternedSource(target, target, sample({ translateX: 0.125 }, { colour }));
    for (let pixel = 0; pixel < 8; pixel++) source.rgb.fill(pixel % 2 ? 255 : 0, pixel * 3, pixel * 3 + 3);
    const output = Buffer.alloc(8 * 8);
    await composeLayerFrame(output, target, [source], new ColourLutCache(), signal());
    const expected = gradePixel([0.5, 0.5, 0.5], colour);
    const black = gradePixel([0, 0, 0], colour);
    const white = gradePixel([1, 1, 1], colour);
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(rgba(output)[4 + channel]! - Math.round(expected[channel]! * 65535))).toBeLessThanOrEqual(1);
      expect(Math.abs(expected[channel]! - (black[channel]! + white[channel]!) / 2)).toBeGreaterThan(0.1);
    }
  });
});

describe('layered renderer metadata and continuous retiming ownership with memory pipes', () => {
  function setup() {
    const target = { width: 8, height: 6, crf: 18, preset: 'medium' as const, level: '3.1' as const };
    const document = createProject('spatial-native', 'Spatial native');
    const clip = createClip('clip', 'source', 7, 9);
    clip.speed = { mode: 'constant', rate: 0.5 };
    clip.spatial.base = { ...NEUTRAL_SPATIAL_POSE, scale: 1.37, translateY: 0.07 };
    document.clips = [clip];
    const asset = mediaAssetSchema.parse({
      id: 'source',
      name: 'Synthetic',
      sourcePath: '/synthetic-not-read.mp4',
      fingerprint: { algorithm: 'sampled-sha256-v1', digest: 'a'.repeat(64), size: 1, mtimeMs: 0, device: 1, inode: 1 },
      metadata: {
        width: 13,
        height: 7,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        frameRate: PROJECT_FPS,
        frameCount: 20,
        durationSeconds: framesToSeconds(20),
        colourRange: 'tv',
        colourSpace: 'bt709',
        colourPrimaries: 'bt709',
        colourTransfer: 'bt709',
        hasAudio: false,
      },
      status: 'registered',
      error: null,
      prepared: null,
    });
    const source = patternedSource(target, asset.metadata, sample(clip.spatial.base));
    const frames: Buffer[] = [];
    const ownedReadBuffers = new Set<Buffer>();
    const ownedWriteBuffers = new Set<Buffer>();
    vi.spyOn(files, 'assertSourceIdentity').mockResolvedValue(undefined);
    vi.spyOn(retime, 'retimeRawVideo').mockImplementation(async (options) => ({
      decodedFrames: options.clip.sourceOut - options.clip.sourceIn,
      outputFrames: options.retiming!.duration,
      frameBytes: options.frameBytes,
      rawFrameBuffers: 1,
      largestReadChunkBytes: options.frameBytes,
    }));
    vi.spyOn(RawVideoPass.prototype, 'reader').mockImplementation(function () {
      const reader = RawFrameReader.create(
        Readable.from([Buffer.concat(Array.from({ length: 4 }, () => source.rgb))]),
        'memory source',
        () => {},
      );
      const requireFrame = reader.requireFrame.bind(reader);
      vi.spyOn(reader, 'requireFrame').mockImplementation(async (buffer) => {
        ownedReadBuffers.add(buffer);
        await requireFrame(buffer);
      });
      return reader;
    });
    vi.spyOn(RawVideoPass.prototype, 'encoder').mockImplementation(
      () =>
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            ownedWriteBuffers.add(chunk);
            frames.push(Buffer.from(chunk));
            callback();
          },
        }),
    );
    return {
      target,
      document,
      source,
      frames,
      ownedReadBuffers,
      ownedWriteBuffers,
      options: {
        document,
        plan: planLayeredExport(document),
        assets: [asset],
        target,
        ffmpeg: '/must-not-start-spatial-unit',
        directory: '/synthetic-not-written',
        context: { id: 'synthetic', signal: signal(), update: () => {} },
      },
    };
  }

  it('supplies actual original dimensions and the same continuous map while retaining four raw buffers / 22 bytes per pixel', async () => {
    const fixture = setup();
    const before = structuredClone(fixture.document);
    const result = await renderLayeredExport(fixture.options);
    expect(result.report).toMatchObject({
      rawFrameBuffers: 4,
      rawBufferBytes: 8 * 6 * 22,
      peakLutEntries: 1,
      lutBytes: LAYERED_EXPORT_RESOURCES.lutBytes,
      originalDecoderProcesses: 1,
      compositeFrames: 4,
    });
    expect(fixture.ownedReadBuffers.size).toBe(1);
    expect(fixture.ownedWriteBuffers.size).toBe(1);
    expect(RawVideoPass.prototype.reader).toHaveBeenCalledTimes(1);
    expect(RawVideoPass.prototype.encoder).toHaveBeenCalledTimes(1);
    expect(fixture.frames).toHaveLength(4);
    const placed = timeline.calculateLayout(fixture.document).clips[0]!;
    expect([0, 1, 2, 3].map((frame) => placed.retiming.sourcePositionAt(frame))).toEqual([7, 7.5, 8, 8.5]);
    const expected = Buffer.alloc(48 * 8);
    await composeLayerFrame(expected, fixture.target, [fixture.source], new ColourLutCache(), signal());
    for (const frame of fixture.frames) expect(frame).toEqual(expected);
    expect(fixture.document).toEqual(before);
  });

  it('changes animated geometry at continuous source positions even while retiming holds the same decoded frame', async () => {
    const fixture = setup();
    fixture.document.clips[0]!.spatial.keyframes = [
      { frame: 7, interpolation: 'linear', values: { ...NEUTRAL_SPATIAL_POSE, scale: 0.8, translateX: -0.1 } },
      { frame: 9, interpolation: 'hold', values: { ...NEUTRAL_SPATIAL_POSE, scale: 1.2, translateX: 0.2 } },
    ];
    fixture.options.plan = planLayeredExport(fixture.document);
    const before = structuredClone(fixture.document);
    const result = await renderLayeredExport(fixture.options);
    expect(result.report.compositeFrames).toBe(4);
    const layout = timeline.calculateLayout(fixture.document);
    const first = timeline.sampleTimeline(fixture.document, 0, layout)[0]!;
    const held = timeline.sampleTimeline(fixture.document, 1, layout)[0]!;
    expect(first.sourceFrame).toBe(held.sourceFrame);
    expect(first.sourcePosition).toBe(7);
    expect(held.sourcePosition).toBe(7.5);
    expect(first.spatial).not.toEqual(held.spatial);
    expect(fixture.frames[0]).not.toEqual(fixture.frames[1]);
    const expected = Buffer.alloc(48 * 8);
    const cache = new ColourLutCache();
    for (let frame = 0; frame < 4; frame++) {
      const current = timeline.sampleTimeline(fixture.document, frame, layout)[0]!;
      await composeLayerFrame(
        expected.fill(0),
        fixture.target,
        [{ ...fixture.source, sample: current }],
        cache,
        signal(),
      );
      expect(fixture.frames[frame]).toEqual(expected);
    }
    expect(fixture.document).toEqual(before);
  });

  it.each([7.25, NaN, Infinity, -Infinity])(
    'rejects mismatched continuous source position %s even with the correct discrete source frame',
    async (position) => {
      const fixture = setup();
      const actual = timeline.sampleTimeline;
      vi.spyOn(timeline, 'sampleTimeline').mockImplementation((...args) =>
        actual(...args).map((item) => ({ ...item, sourcePosition: position })),
      );
      await expect(renderLayeredExport(fixture.options)).rejects.toThrow('continuous source-position map');
      expect(fixture.frames).toEqual([]);
    },
  );
});
