import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { fingerprintFile } from '../../src/server/files.js';
import { runProcess } from '../../src/server/process.js';
import { retimeRawVideo, type RawRetimingOptions } from '../../src/server/retime-process.js';
import { EMPTY_KEY_VALUES, evaluateLayerSetting, type Interpolation, type LayerKeyframe, type LayerKeyValues } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type VideoClip } from '../../src/shared/model.js';
import { compileRetiming, type Retiming } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const WIDTH = 16; const HEIGHT = 8; const FRAME_BYTES = WIDTH * HEIGHT * 3;
const RGB_FILTER = 'scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24';
const BASE = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}

describe.skipIf(!enabled)('schema-4 supplied row maps · native pipes and disposable frame-coded originals', () => {
  let root: string;
  let config: ServiceConfig;
  let sourcePath: string;
  let originalBytes: Buffer;
  let originalRgb: Buffer;
  let fingerprint: Awaited<ReturnType<typeof fingerprintFile>>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pascap-row-retiming-media-'));
    config = createConfig({ dataDir: path.join(root, 'unused-cache') });
    sourcePath = path.join(root, 'generated-frame-codes.mp4');
    await runProcess(config.ffmpeg, [...BASE, '-f', 'lavfi', '-i',
      `nullsrc=size=${WIDTH}x${HEIGHT}:rate=30000/1001,geq=lum='40+6*N+8*gte(X,8)':cb='100+N':cr='165-2*N',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
      '-frames:v', '20', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p',
      '-threads', '2', '-filter_threads', '2', '-bf', '0', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-colorspace', 'bt709', '-color_range', 'tv', '-video_track_timescale', '30000', sourcePath]);
    originalBytes = await readFile(sourcePath); fingerprint = await fingerprintFile(sourcePath);
    originalRgb = await runProcess(config.ffmpeg, [...BASE, '-threads', '2', '-i', sourcePath, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-filter_threads', '2', '-vf', RGB_FILTER, '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24',
      '-threads', '2', '-f', 'rawvideo', 'pipe:1']);
    expect(originalRgb).toHaveLength(20 * FRAME_BYTES);
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  function options(clip: VideoClip, cwd: string, filename: string, signal: AbortSignal): RawRetimingOptions {
    return {
      ffmpeg: config.ffmpeg, cwd, clip, frameBytes: FRAME_BYTES, signal,
      decodeArgs: [...BASE, '-xerror', '-err_detect', 'explode', '-threads', '2', '-noautorotate', '-i', sourcePath,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2', '-vf',
        `trim=start_frame=${clip.sourceIn}:end_frame=${clip.sourceOut},setpts=PTS-STARTPTS,${RGB_FILTER}`,
        '-frames:v', String(clip.sourceOut - clip.sourceIn), '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24',
        '-threads', '2', '-f', 'rawvideo', 'pipe:1'],
      encodeArgs: [...BASE, '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', '30000/1001',
        '-threads', '2', '-i', 'pipe:0', '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2',
        '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '2', '-f', 'rawvideo', filename],
    };
  }
  async function unchanged(): Promise<void> {
    expect(await readFile(sourcePath)).toEqual(originalBytes);
    expect(await fingerprintFile(sourcePath)).toEqual(fingerprint);
  }

  it.each(['hold', 'linear', 'ease-in', 'ease-out', 'smooth'] as const)('streams every exact contextual source frame for %s and owns the captured map', async (interpolation) => {
    const work = await mkdtemp(path.join(root, 'mapped-'));
    try {
      const project = createProject(`native-row-${interpolation}`, 'No UI state is involved');
      const row = { id: 'video-2', name: 'Contextual row', enabled: true, opacity: 1, keyframes: [
        point(4, { speed: 0.35 }, interpolation), point(11, { hue: 75 }, 'hold'),
        point(26, { speed: 3 }, 'ease-out'), point(35, { speed: 0.7 }, 'smooth'), point(50, { speed: 2 }, 'hold'),
      ] };
      project.layers.push(row);
      const clip = { ...createClip('placed-row-clip', 'generated-original', 7, 19), layerId: row.id, start: 9,
        speed: { mode: 'constant' as const, rate: 4 } };
      project.clips = [clip];
      const captured = projectSchema.parse(project); const layout = calculateLayout(captured); const placed = layout.clips[0]!;
      const map = placed.retiming; const expected = Array.from({ length: map.duration }, (_, output) => map.sourceAt(output));
      expect(map.duration).not.toBe(compileRetiming(clip).duration);
      expect(Object.isFrozen(map)).toBe(true);
      const frameBuffer = Buffer.alloc(FRAME_BYTES); let mutated = false;
      const report = await retimeRawVideo({
        ...options(clip, work, 'mapped.rgb', new AbortController().signal), retiming: map, frameBuffer,
        onProgress: (_frames, total) => {
          expect(total).toBe(expected.length);
          if (mutated) return;
          mutated = true; clip.sourceIn = 8; clip.speed = { mode: 'constant', rate: 8 };
          row.keyframes[0]!.values.speed = 8; row.keyframes[1]!.frame = 12;
        },
      });
      expect(mutated).toBe(true);
      const actual = await readFile(path.join(work, 'mapped.rgb'));
      expect(actual).toHaveLength(map.duration * FRAME_BYTES);
      expect(report).toMatchObject({ decodedFrames: 12, outputFrames: map.duration, frameBytes: FRAME_BYTES, rawFrameBuffers: 1 });
      expect(report.largestReadChunkBytes).toBeLessThanOrEqual(12 * FRAME_BYTES);
      expect(frameBuffer).toHaveLength(FRAME_BYTES);
      for (const [output, source] of expected.entries()) {
        expect(Number.isSafeInteger(source)).toBe(true); expect(source).toBeGreaterThanOrEqual(7); expect(source).toBeLessThan(19);
        if (output > 0) expect(source).toBeGreaterThanOrEqual(expected[output - 1]!);
        expect(actual.subarray(output * FRAME_BYTES, (output + 1) * FRAME_BYTES)).toEqual(originalRgb.subarray(source * FRAME_BYTES, (source + 1) * FRAME_BYTES));
        const sample = sampleTimeline(captured, placed.start + output, layout)[0]!;
        expect(sample.sourceFrame).toBe(source);
        expect(map.rateAt(output)).toBeCloseTo(evaluateLayerSetting(captured.layers[1]!, 'speed', placed.start + output, 1));
      }
      await unchanged();
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it('rejects invalid supplied durations/query APIs before starting children instead of falling back to static speed', async () => {
    const work = await mkdtemp(path.join(root, 'invalid-map-'));
    try {
      const clip = createClip('invalid', 'generated-original', 7, 19); const baseline = compileRetiming(clip);
      for (const duration of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
        await expect(retimeRawVideo({ ...options(clip, work, 'must-not-exist.rgb', new AbortController().signal),
          ffmpeg: '/must-not-run-invalid-row-map', retiming: { ...baseline, duration } })).rejects.toThrow('map duration');
      }
      await expect(retimeRawVideo({ ...options(clip, work, 'must-not-exist.rgb', new AbortController().signal),
        ffmpeg: '/must-not-run-invalid-row-map', retiming: null as unknown as Retiming })).rejects.toThrow('map duration');
      await expect(retimeRawVideo({ ...options(clip, work, 'must-not-exist.rgb', new AbortController().signal),
        ffmpeg: '/must-not-run-invalid-row-map', retiming: { ...baseline, sourceAt: null } as unknown as Retiming })).rejects.toThrow('sourceAt, outputAt and rateAt');
      expect(await readdir(work)).toEqual([]); await unchanged();
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it('rejects descending, out-of-range, fractional and nonfinite maps while reaping native companions', async () => {
    const clip = createClip('invalid-source', 'generated-original', 7, 19);
    const maps = [[7, 9, 8, 10], [7, 6, 8, 9], [7, 19, 19, 19], [7, 7.5, 8, 9], [7, NaN, 8, 9], [7, Infinity, 8, 9]];
    for (const sources of maps) {
      const work = await mkdtemp(path.join(root, 'invalid-source-'));
      try {
        const retiming: Retiming = { duration: sources.length, sourceAt: (output) => sources[output]!, outputAt: () => 0, rateAt: () => 1 };
        await expect(retimeRawVideo({ ...options(clip, work, 'partial.rgb', new AbortController().signal), retiming }))
          .rejects.toThrow('monotonic, in-range discrete source-frame map');
      } finally { await rm(work, { recursive: true, force: true }); }
    }
    await unchanged();
  });

  it('cancels a supplied row map during backpressured native writes without changing the original', async () => {
    const work = await mkdtemp(path.join(root, 'cancelled-')); const controller = new AbortController();
    try {
      const project = createProject('cancelled-row', 'Disposable contextual cancellation');
      project.layers[0]!.keyframes = [point(0, { speed: 0.1 })];
      project.clips = [createClip('slow-row', 'generated-original', 7, 19)];
      const placed = calculateLayout(project).clips[0]!; let progress = false;
      expect(placed.duration).toBe(120);
      await expect(retimeRawVideo({ ...options(placed.clip, work, 'partial.rgb', controller.signal), retiming: placed.retiming,
        onProgress: () => { progress = true; controller.abort(); } })).rejects.toThrow('cancelled');
      expect(progress).toBe(true); await unchanged();
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});