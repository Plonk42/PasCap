import { describe, expect, it } from 'vitest';
import { analyseAutoAdjust, autoAdjustFrames, scaleCorrection } from '../../src/shared/auto-adjust.js';
import { applyCommand } from '../../src/shared/commands.js';
import {
  DETAIL_ESTIMATE,
  detailFrames,
  frameBlur,
  frameNoise,
  measureDetail,
  suggestDetail,
  type LumaFrame,
} from '../../src/shared/detail-estimate.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  frameIlluminant,
  poolWhiteBalance,
  whiteBalanceWindow,
  type AnalysisFrame,
} from '../../src/shared/white-balance.js';
import { runners } from '../../src/server/operations/index.js';

type Context = Parameters<typeof runners.estimate>[0];

/** A deterministic pseudo-random number in [0, 1). */
function hash(value: number): number {
  const x = Math.sin(value * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

/** Coloured patches under a blue cast, darker and flatter as `seed` grows a little. */
function patches(seed: number, width = 64, height = 36): AnalysisFrame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const patch = Math.floor(x / 8) * 7 + Math.floor(y / 6) * 3;
      const level = 70 + 90 * hash(patch) - seed;
      const offset = (y * width + x) * 4;
      data[offset] = Math.round(level * (0.7 + 0.5 * hash(patch + 1)));
      data[offset + 1] = Math.round(level * (0.8 + 0.4 * hash(patch + 2)));
      data[offset + 2] = Math.min(255, Math.round(level * (1 + 0.5 * hash(patch + 3))));
      data[offset + 3] = 255;
    }
  return { width, height, data };
}

/** A 720-line luma frame of patches with texture, blurred by `sigma` pixels, with Gaussian `noise` (0–1). */
function luma(sigma: number, noise: number, seed = 1, width = 320, height = 180): LumaFrame {
  const base = new Float64Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const patch = Math.floor(x / 20) * 5 + Math.floor(y / 18) * 3;
      base[y * width + x] = 40 + 170 * hash(patch);
    }
  const blurred = sigma ? gaussian(base, width, height, sigma) : base;
  const data = new Uint8Array(width * height);
  for (let index = 0; index < data.length; index++) {
    const u = hash(index * 2 + seed * 7919) || 1e-9;
    const v = hash(index * 2 + 1 + seed * 7919);
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    data[index] = Math.max(0, Math.min(255, Math.round(blurred[index]! + normal * noise * 255)));
  }
  return { width, height, data };
}

function gaussian(image: Float64Array, width: number, height: number, sigma: number): Float64Array {
  const radius = Math.ceil(3 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma ** 2)));
  const total = kernel.reduce((sum, value) => sum + value, 0);
  const pass = (input: Float64Array, horizontal: boolean): Float64Array => {
    const output = new Float64Array(input.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
          sum += input[sy * width + sx]! * kernel[k + radius]!;
        }
        output[y * width + x] = sum / total;
      }
    return output;
  };
  return pass(pass(image, true), false);
}

describe('detail estimate', () => {
  it('measures noise and softness in order, ignoring texture, and suggests nothing on clean sharp footage', () => {
    const noises = [0, 0.005, 0.01, 0.02].map((noise) => frameNoise(luma(0, noise))!);
    expect(noises[0]).toBeLessThan(DETAIL_ESTIMATE.noiseFloor);
    for (const [index, noise] of [0, 0.005, 0.01, 0.02].entries()) expect(noises[index]).toBeCloseTo(noise, 2);
    // Heavy noise hides the gentle slopes of heavily blurred edges: up to 2-pixel blur there.
    for (const [noise, sigmas] of [
      [0, [0, 1, 2, 4]],
      [0.005, [0, 1, 2, 4]],
      [0.01, [0, 1, 2]],
      [0.02, [0, 1, 2]],
    ] as const) {
      const blurs = sigmas.map((sigma) => {
        const frame = luma(sigma, noise);
        return frameBlur(frame, frameNoise(frame))!;
      });
      for (let index = 1; index < blurs.length; index++) expect(blurs[index]).toBeGreaterThan(blurs[index - 1]!);
    }
    expect(suggestDetail(measureDetail([luma(0, 0)]))).toEqual({ sharpen: 0, clarity: 0, denoise: 0 });
    const noisy = suggestDetail(measureDetail([luma(0, 0.01), luma(0, 0.01, 2)]));
    const soft = suggestDetail(measureDetail([luma(2, 0), luma(2, 0, 2)]));
    expect(noisy).toMatchObject({ sharpen: 0, clarity: 0 });
    expect(noisy.denoise).toBeGreaterThan(0.1);
    expect(soft).toMatchObject({ clarity: 0, denoise: 0 });
    expect(soft.sharpen).toBeGreaterThan(0.2);
    expect(suggestDetail(measureDetail([luma(0, 0.05)])).denoise).toBe(DETAIL_ESTIMATE.denoiseMax);
  });

  it('cannot judge uniform or clipped frames', () => {
    const uniform: LumaFrame = { width: 64, height: 64, data: new Uint8Array(64 * 64).fill(128) };
    const black: LumaFrame = { width: 64, height: 64, data: new Uint8Array(64 * 64) };
    expect(frameBlur(uniform, 0)).toBeNull();
    expect(frameNoise(black)).toBeNull();
    expect(measureDetail([black])).toEqual({ noise: null, blur: null });
    expect(suggestDetail({ noise: null, blur: null })).toEqual({ sharpen: 0, clarity: 0, denoise: 0 });
    expect(detailFrames(100, 104)).toEqual([100, 101, 102, 103]);
    expect(detailFrames(0, 800)).toHaveLength(DETAIL_ESTIMATE.frames);
  });
});

describe('estimate operation', () => {
  const base = createProject('estimate', 'Estimate');
  const project: ProjectDocument = projectSchema.parse({
    ...base,
    media: { videoIds: ['rec-1', 'rec-2'], audioIds: [] },
    clips: [createClip('a', 'rec-1', 0, 300), { ...createClip('b', 'rec-2', 100, 200), start: 300 }],
    layers: [{ ...base.layers[0]!, transitions: [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }] }],
  });
  const layerId = project.layers[0]!.id;
  const reads: { mediaId: string; frames: number[] }[] = [];
  const lumaReads: number[][] = [];
  const context = {
    projects: { load: async () => project },
    library: { get: (id: string) => ({ id, name: `${id}.MP4`, metadata: { frameCount: 600 } }) },
    stills: {
      analysisFrames: async (mediaId: string, frames: number[]) => {
        reads.push({ mediaId, frames });
        return new Map(frames.map((frame) => [frame, patches(frame / 30)]));
      },
      lumaFrames: async (_: string, frames: number[]) => {
        lumaReads.push(frames);
        return frames.map((frame) => luma(0, 0.01, frame));
      },
    },
  } as unknown as Context;
  const input = { projectId: 'estimate', applyAs: 'values', intensity: 80 } as const;

  it('fits Auto adjust to the frames the editor analyses and returns the edit that applies it', async () => {
    reads.length = 0;
    const result = await runners.estimate(context, { ...input, kind: 'auto-adjust', clipId: 'a' });
    const sourceFrames = autoAdjustFrames(0, 300);
    expect(reads).toEqual([{ mediaId: 'rec-1', frames: sourceFrames }]);
    const expected = scaleCorrection(analyseAutoAdjust(sourceFrames.map((frame) => patches(frame / 30)))!, 0.8);
    expect(result.correction).toEqual(expected);
    expect(result.analysed).toEqual({ description: 'the whole clip a', frames: 16 });
    expect(result.unchanged).toEqual([]);
    const edited = applyCommand(project, result.commands[0]!);
    expect(edited.layers[0]!.colour).toMatchObject(expected);

    const half = await runners.estimate(context, { ...input, kind: 'auto-adjust', clipId: 'a', intensity: 40 });
    expect(half.correction!['tint']).toBeCloseTo(expected.tint / 2, 2);

    // A keyframe at a frame analyses the second around it and keys the eleven settings there.
    const keyed = await runners.estimate(context, {
      ...input,
      kind: 'auto-adjust',
      clipId: 'a',
      frame: 100,
      applyAs: 'keyframe',
    });
    expect(keyed.analysed.frames).toBe(16);
    let next = project;
    for (const command of keyed.commands) next = applyCommand(next, command);
    expect(next.layers[0]!.keyframes).toHaveLength(1);
    expect(next.layers[0]!.keyframes[0]).toMatchObject({
      frame: 100,
      values: { exposure: keyed.correction!['exposure'] },
    });
    expect(next.layers[0]!.colour).toEqual(project.layers[0]!.colour);
  });

  it('estimates Temperature and Tint like Auto white balance, from each project frame of the window', async () => {
    reads.length = 0;
    const result = await runners.estimate(context, { ...input, kind: 'white-balance', clipId: 'b', frame: 310 });
    const clip = calculateLayout(project).clips.find((item) => item.clip.id === 'b')!;
    const sourceFrames = whiteBalanceWindow(clip, 310).map((frame) => clip.retiming.sourceAt(frame - clip.start));
    const expected = poolWhiteBalance(sourceFrames.map((frame) => frameIlluminant(patches(frame / 30))))!;
    expect(result.whiteBalance).toEqual(expected);
    expect(result.commands).toEqual([
      { type: 'colour', layerId, colour: { ...project.layers[0]!.colour, ...expected } },
    ]);
  });

  it('analyses every clip of a track by duration, and a recording range without commands', async () => {
    reads.length = 0;
    const track = await runners.estimate(context, { ...input, kind: 'auto-adjust', layerId });
    expect(reads.map((read) => read.mediaId)).toEqual(['rec-1', 'rec-2']);
    expect(reads[0]!.frames.length).toBeGreaterThan(reads[1]!.frames.length);
    expect(track.commands).toHaveLength(1);
    const range = await runners.estimate(context, {
      ...input,
      kind: 'white-balance',
      mediaId: 'rec-2',
      sourceIn: 0,
      sourceOut: 600,
    });
    expect(range.commands).toEqual([]);
    expect(range.whiteBalance).toBeDefined();
  });

  it("measures a clip's detail on proxy luma and returns its detail edit", async () => {
    lumaReads.length = 0;
    const result = await runners.estimate(context, { ...input, kind: 'detail', clipId: 'b' });
    expect(lumaReads).toEqual([detailFrames(100, 200)]);
    expect(result.detail!.noise).toBeCloseTo(0.01, 2);
    expect(result.detail!.suggested.denoise).toBeGreaterThan(0);
    expect(result.commands).toEqual([{ type: 'detail', clipId: 'b', detail: result.detail!.suggested }]);
  });

  it('rejects ambiguous, misplaced and unsupported targets', async () => {
    const rejects = (fields: Record<string, unknown>, statusCode: number) =>
      expect(
        runners.estimate(context, { ...input, kind: 'auto-adjust', ...fields } as Parameters<
          typeof runners.estimate
        >[1]),
      ).rejects.toMatchObject({ statusCode });
    await rejects({}, 422);
    await rejects({ clipId: 'a', layerId }, 422);
    await rejects({ clipId: 'a', frame: 400 }, 422);
    await rejects({ layerId, frame: 10 }, 422);
    await rejects({ clipId: 'a', applyAs: 'keyframe' }, 422);
    await rejects({ clipId: 'z' }, 404);
    await rejects({ layerId, kind: 'detail' }, 422);
    await rejects({ mediaId: 'rec-9', sourceIn: 0, sourceOut: 10 }, 404);
    await rejects({ mediaId: 'rec-1', sourceIn: 10, sourceOut: 10 }, 422);
    await rejects({ mediaId: 'rec-1', sourceIn: 0, sourceOut: 601 }, 422);
  });
});
