import { describe, expect, it } from 'vitest';
import { analyzeAutoAdjust, autoAdjustFrames, scaleCorrection } from '../../src/shared/auto-adjust.js';
import { applyCommand } from '../../src/shared/commands.js';
import { createColorSettings } from '../../src/shared/color.js';
import { matchFrame, matchStyle, measureLook, towardsMatch } from '../../src/shared/look-match.js';
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

/** Colored patches under a blue cast, darker and flatter as `seed` grows a little. */
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
  const input = { projectId: 'estimate', applyAs: 'values', intensity: 80, commands: true } as const;
  /** A match's Intensity defaults to 100%, the match itself. */
  const matchInput = { projectId: 'estimate', applyAs: 'values', commands: true } as const;

  it('fits Auto adjust to the frames the editor analyzes and returns the edit that applies it', async () => {
    reads.length = 0;
    const result = await runners.estimate(context, { ...input, kind: 'auto-adjust', clipId: 'a' });
    const sourceFrames = autoAdjustFrames(0, 300);
    expect(reads).toEqual([{ mediaId: 'rec-1', frames: sourceFrames }]);
    const expected = scaleCorrection(analyzeAutoAdjust(sourceFrames.map((frame) => patches(frame / 30)))!, 0.8);
    expect(result.correction).toEqual(expected);
    expect(result.analyzed).toEqual({ description: 'the whole clip a', frames: 16 });
    expect(result.revision).toBe(project.revision);
    expect(result.unchanged).toEqual([]);
    expect(result.commands).toEqual([{ type: 'color-patch', clipIds: ['a'], settings: expected }]);
    const edited = applyCommand(project, result.commands[0]!);
    expect(edited.clips[0]!.grade.color).toMatchObject(expected);
    expect(edited.clips[1]!.grade).toEqual(project.clips[1]!.grade);
    expect(edited.layers).toEqual(project.layers);

    const half = await runners.estimate(context, { ...input, kind: 'auto-adjust', clipId: 'a', intensity: 40 });
    expect(half.correction!['tint']).toBeCloseTo(expected.tint / 2, 2);
    const valuesOnly = await runners.estimate(context, { ...input, kind: 'auto-adjust', clipId: 'a', commands: false });
    expect(valuesOnly).toMatchObject({ correction: expected, commands: [] });

    // A keyframe at a frame analyzes the second around it and keys the eleven settings of the clip grade at the
    // source frame shown there.
    const keyed = await runners.estimate(context, {
      ...input,
      kind: 'auto-adjust',
      clipId: 'a',
      frame: 100,
      applyAs: 'keyframe',
    });
    expect(keyed.analyzed.frames).toBe(16);
    let next = project;
    for (const command of keyed.commands) next = applyCommand(next, command);
    expect(next.clips[0]!.grade.keyframes).toHaveLength(1);
    expect(next.clips[0]!.grade.keyframes[0]).toMatchObject({
      frame: 100,
      values: { exposure: keyed.correction!['exposure'] },
    });
    expect(next.clips[0]!.grade.color).toEqual(project.clips[0]!.grade.color);
    expect(next.layers).toEqual(project.layers);
    const later = await runners.estimate(context, {
      ...input,
      kind: 'auto-adjust',
      clipId: 'b',
      frame: 310,
      applyAs: 'keyframe',
    });
    for (const command of later.commands) next = applyCommand(next, command);
    // Clip b starts at frame 300 on source frame 100.
    expect(next.clips[1]!.grade.keyframes.map((key) => key.frame)).toEqual([110]);
  });

  it('estimates Temperature and Tint like Auto white balance, from each project frame of the window', async () => {
    reads.length = 0;
    const result = await runners.estimate(context, { ...input, kind: 'white-balance', clipId: 'b', frame: 310 });
    const clip = calculateLayout(project).clips.find((item) => item.clip.id === 'b')!;
    const sourceFrames = whiteBalanceWindow(clip, 310).map((frame) => clip.retiming.sourceAt(frame - clip.start));
    const expected = poolWhiteBalance(sourceFrames.map((frame) => frameIlluminant(patches(frame / 30))))!;
    expect(result.whiteBalance).toEqual(expected);
    expect(result.commands).toEqual([
      { type: 'color-patch', clipIds: ['b'], settings: { temperature: expected.temperature, tint: expected.tint } },
    ]);
  });

  it('analyzes every clip of a track by duration for one compromise, and a recording range, without commands', async () => {
    reads.length = 0;
    const track = await runners.estimate(context, { ...input, kind: 'auto-adjust', layerId, commands: false });
    expect(reads.map((read) => read.mediaId)).toEqual(['rec-1', 'rec-2']);
    expect(reads[0]!.frames.length).toBeGreaterThan(reads[1]!.frames.length);
    expect(track.correction).toBeDefined();
    expect(track.commands).toEqual([]);
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
    expect(result.commands).toEqual([{ type: 'detail-patch', clipIds: ['b'], settings: result.detail!.suggested }]);
  });

  it('writes each clip its own whole-clip correction into its clip grade, keeping its keyframes', async () => {
    reads.length = 0;
    const third = { ...createClip('c', 'rec-1', 400, 500), start: 0 };
    const dissolved = applyCommand(
      projectSchema.parse({
        ...project,
        clips: [...project.clips, third],
        layers: [
          {
            ...project.layers[0]!,
            transitions: [
              { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 20 },
              { leftId: 'b', rightId: 'c', type: 'cut', duration: 0 },
            ],
          },
        ],
      }),
      { type: 'layer-key-set', clipId: 'b', frame: 150, values: { hue: 10 } },
    );
    const shots = { ...context, projects: { load: async () => dissolved } } as unknown as Context;
    const result = await runners.estimate(shots, { ...input, kind: 'auto-adjust', layerId, applyAs: 'shots' });
    expect(reads.map((read) => read.frames)).toEqual([
      autoAdjustFrames(0, 300),
      autoAdjustFrames(100, 200),
      autoAdjustFrames(400, 500),
    ]);
    expect(result.correction).toBeUndefined();
    expect(result.clips!.map((clip) => clip.clipId)).toEqual(['a', 'b', 'c']);
    // Only the values each clip's grade does not animate: clip b keys Hue.
    expect(result.commands).toEqual(
      result.clips!.map((clip) => ({
        type: 'color-patch',
        clipIds: [clip.clipId],
        settings: Object.fromEntries(
          Object.entries(clip.correction!).filter(([setting]) => clip.clipId !== 'b' || setting !== 'hue'),
        ),
      })),
    );
    let graded = dissolved;
    for (const command of result.commands) graded = applyCommand(graded, command);
    expect(graded.layers).toEqual(dissolved.layers);
    expect(graded.adjustments).toEqual([]);
    expect(graded.clips.map((clip) => clip.grade.color.exposure)).toEqual(
      result.clips!.map((clip) => clip.correction!.exposure),
    );
    expect(graded.clips.find((clip) => clip.id === 'b')!.grade.keyframes).toHaveLength(1);

    // One clip of a list, on its own: only its Temperature and Tint change.
    const one = await runners.estimate(shots, { ...input, kind: 'white-balance', clipIds: ['b'], applyAs: 'shots' });
    expect(one.commands).toEqual([{ type: 'color-patch', clipIds: ['b'], settings: one.clips![0]!.whiteBalance }]);
  });

  it('measures the detail of several clips, each on its own, in one call', async () => {
    lumaReads.length = 0;
    const listed = await runners.estimate(context, { ...input, kind: 'detail', clipIds: ['b', 'a'] });
    expect(lumaReads).toEqual([detailFrames(0, 300), detailFrames(100, 200)]);
    expect(listed.clips!.map((clip) => clip.clipId)).toEqual(['a', 'b']);
    expect(listed.commands).toEqual(
      listed.clips!.map((clip) => ({
        type: 'detail-patch',
        clipIds: [clip.clipId],
        settings: clip.detail!.suggested,
      })),
    );
    const track = await runners.estimate(context, { ...input, kind: 'detail', layerId });
    expect(track.commands).toEqual(listed.commands);
  });

  it('matches a clip frame to a hero frame as its grade shows it, never changing the hero', async () => {
    const graded = applyCommand(project, {
      type: 'color-patch',
      clipIds: ['a'],
      settings: { exposure: 0.4, saturation: 1.2 },
    });
    const heroed = { ...context, projects: { load: async () => graded } } as unknown as Context;
    reads.length = 0;
    const result = await runners.estimate(heroed, { ...matchInput, kind: 'match', clipId: 'b', referenceClipId: 'a' });
    // Each clip at its middle frame: clip a (0–300) at source frame 150, clip b (100–200) at 150 too.
    expect(reads).toEqual([
      { mediaId: 'rec-1', frames: [150] },
      { mediaId: 'rec-2', frames: [150] },
    ]);
    const heroColor = graded.clips[0]!.grade.color;
    const shotColor = graded.clips[1]!.grade.color;
    const matched = matchFrame({ frame: patches(5), color: heroColor }, { frame: patches(5), color: shotColor })!;
    const expected = towardsMatch(shotColor, matched.correction, 1);
    expect(result).toMatchObject({
      kind: 'match',
      reference: { clipId: 'a', mediaId: 'rec-1', sourceFrame: 150 },
      analyzed: { description: 'source frame 150 of clip b', frames: 1 },
      correction: expected,
      likeness: 1,
      commands: [{ type: 'color-patch', clipIds: ['b'], settings: expected }],
    });
    // The same picture takes the hero's grade.
    expect(result.correction!['exposure']).toBeCloseTo(0.4, 2);
    expect(result.correction!['saturation']).toBeCloseTo(1.2, 2);
    const half = await runners.estimate(heroed, {
      ...matchInput,
      kind: 'match',
      clipId: 'b',
      referenceClipId: 'a',
      intensity: 50,
    });
    expect(half.correction).toEqual(towardsMatch(shotColor, matched.correction, 0.5));

    // Every clip of the track but the hero, each at its middle frame.
    reads.length = 0;
    const track = await runners.estimate(heroed, {
      ...matchInput,
      kind: 'match',
      layerId,
      applyAs: 'shots',
      referenceClipId: 'a',
    });
    expect(track.reference).toEqual({ clipId: 'a', mediaId: 'rec-1', sourceFrame: 150 });
    expect(track.clips!.map((clip) => clip.clipId)).toEqual(['b']);
    expect(track.clips![0]!).toMatchObject({ correction: expected, likeness: 1, frames: 1 });
    expect(track.commands).toEqual([{ type: 'color-patch', clipIds: ['b'], settings: expected }]);

    // The hero playing at a frame, and the clip at a frame.
    reads.length = 0;
    const framed = await runners.estimate(heroed, {
      ...matchInput,
      kind: 'match',
      clipId: 'a',
      frame: 100,
      referenceFrame: 310,
      commands: false,
    });
    expect(reads).toEqual([
      { mediaId: 'rec-2', frames: [110] },
      { mediaId: 'rec-1', frames: [100] },
    ]);
    expect(framed.reference).toEqual({ clipId: 'b', mediaId: 'rec-2', sourceFrame: 110 });

    // A recording's frame as shot.
    reads.length = 0;
    const shot = await runners.estimate(heroed, {
      ...matchInput,
      kind: 'match',
      clipId: 'b',
      referenceMediaId: 'rec-1',
      referenceSourceFrame: 300,
    });
    expect(reads[0]).toEqual({ mediaId: 'rec-1', frames: [300] });
    expect(shot.reference).toEqual({ mediaId: 'rec-1', sourceFrame: 300 });
    const asShot = matchFrame(
      { frame: patches(10), color: createColorSettings() },
      { frame: patches(5), color: shotColor },
    )!;
    expect(shot.correction).toEqual(towardsMatch(shotColor, asShot.correction, 1));
  });

  it('matches a clip to a registered style', async () => {
    const look = measureLook([patches(2), patches(4)])!;
    const style = { id: 'bright', name: 'Bright edits', look };
    const styled = {
      ...context,
      styles: {
        get: async (id: string) => {
          if (id !== style.id) throw Object.assign(new Error('No such style.'), { statusCode: 404 });
          return style;
        },
      },
    } as unknown as Context;
    reads.length = 0;
    const result = await runners.estimate(styled, { ...matchInput, kind: 'match', clipId: 'a', style: 'bright' });
    expect(reads).toEqual([{ mediaId: 'rec-1', frames: [150] }]);
    const color = project.clips[0]!.grade.color;
    const expected = towardsMatch(color, matchStyle(look, { frame: patches(5), color })!, 1);
    expect(result).toMatchObject({
      style: { id: 'bright', name: 'Bright edits' },
      correction: expected,
      commands: [{ type: 'color-patch', clipIds: ['a'], settings: expected }],
    });
    expect(result.likeness).toBeUndefined();
    await expect(
      runners.estimate(styled, { ...matchInput, kind: 'auto-adjust', clipId: 'a', style: 'bright' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      runners.estimate(styled, { ...matchInput, kind: 'match', clipId: 'a', style: 'gone' }),
    ).rejects.toMatchObject({ statusCode: 404 });
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
    // A track has no Color of its own to write.
    await rejects({ layerId }, 422);
    await rejects({ clipId: 'a', clipIds: ['b'] }, 422);
    await rejects({ clipId: 'a', frame: 400 }, 422);
    await rejects({ layerId, frame: 10 }, 422);
    await rejects({ clipId: 'a', applyAs: 'keyframe' }, 422);
    await rejects({ clipId: 'z' }, 404);
    await rejects({ clipIds: ['a', 'z'], applyAs: 'shots' }, 404);
    await rejects({ clipIds: ['a', 'a'], applyAs: 'shots' }, 422);
    await rejects({ clipIds: ['a', 'b'] }, 422);
    await rejects({ clipId: 'a', frame: 10, applyAs: 'shots' }, 422);
    await rejects({ clipIds: ['a'], kind: 'detail', applyAs: 'shots' }, 422);
    await rejects({ mediaId: 'rec-9', sourceIn: 0, sourceOut: 10 }, 404);
    await rejects({ mediaId: 'rec-1', sourceIn: 10, sourceOut: 10 }, 422);
    await rejects({ mediaId: 'rec-1', sourceIn: 0, sourceOut: 601 }, 422);
    // A match needs one reference, which never changes.
    await rejects({ kind: 'match', clipId: 'b' }, 422);
    await rejects({ clipId: 'b', referenceClipId: 'a' }, 422);
    await rejects({ kind: 'match', clipId: 'b', referenceClipId: 'a', referenceMediaId: 'rec-1' }, 422);
    await rejects({ kind: 'match', clipId: 'a', referenceClipId: 'a' }, 422);
    await rejects({ kind: 'match', clipIds: ['a', 'b'], applyAs: 'shots', referenceClipId: 'b' }, 422);
    await rejects({ kind: 'match', clipId: 'b', referenceClipId: 'z' }, 404);
    await rejects({ kind: 'match', clipId: 'b', referenceClipId: 'a', referenceFrame: 310 }, 422);
    await rejects({ kind: 'match', clipId: 'b', referenceFrame: 9000 }, 422);
    await rejects({ kind: 'match', clipId: 'b', referenceMediaId: 'rec-1' }, 422);
    await rejects({ kind: 'match', clipId: 'b', referenceMediaId: 'rec-1', referenceSourceFrame: 600 }, 422);
    await rejects({ kind: 'match', clipId: 'b', referenceMediaId: 'rec-9', referenceSourceFrame: 0 }, 404);
    await rejects({ kind: 'match', layerId, referenceClipId: 'a', commands: false }, 422);
  });
});
