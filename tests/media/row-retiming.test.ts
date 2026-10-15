import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { fingerprintFile } from '../../src/server/files.js';
import { runProcess } from '../../src/server/process.js';
import {
  excerptFilter,
  excerptInputArgs,
  retimeRawVideo,
  type RawRetimingOptions,
} from '../../src/server/retime-process.js';
import { createClip, createLayer, createProject, projectSchema, type VideoClip } from '../../src/shared/model.js';
import { compileRetiming, type Retiming, type SpeedCurve } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
// Three 16×8 RGB frames per reversed decoder chunk, so short clips exercise several seeked chunks.
vi.mock('../../src/shared/export.js', async (original) => {
  const actual = await original<typeof import('../../src/shared/export.js')>();
  return { ...actual, EXPORT_RESOURCES: { ...actual.EXPORT_RESOURCES, reverseChunkBytes: 3 * 16 * 8 * 3 } };
});
const WIDTH = 16;
const HEIGHT = 8;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
const RGB_FILTER = 'scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24';
const BASE = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];

describe.skipIf(!enabled)('supplied clip retiming maps · native pipes and disposable frame-coded originals', () => {
  let root: string;
  let config: ServiceConfig;
  let sourcePath: string;
  let originalBytes: Buffer;
  let originalRgb: Buffer;
  let fingerprint: Awaited<ReturnType<typeof fingerprintFile>>;
  /** Six-frame GOPs with B-frames, so reversed chunk seeks land mid-GOP and between reordered frames. */
  let reorderedPath: string;
  let reorderedRgb: Buffer;
  const encode = (filename: string, gop: readonly string[]): Promise<Buffer> =>
    runProcess(config.ffmpeg, [
      ...BASE,
      '-f',
      'lavfi',
      '-i',
      `nullsrc=size=${WIDTH}x${HEIGHT}:rate=30000/1001,geq=lum='40+6*N+8*gte(X,8)':cb='100+N':cr='165-2*N',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
      '-frames:v',
      '20',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '8',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      ...gop,
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      '-video_track_timescale',
      '30000',
      filename,
    ]);
  const decodeAll = (filename: string): Promise<Buffer> =>
    runProcess(config.ffmpeg, [
      ...BASE,
      '-threads',
      '2',
      '-i',
      filename,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-filter_threads',
      '2',
      '-vf',
      RGB_FILTER,
      '-fps_mode',
      'passthrough',
      '-c:v',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-threads',
      '2',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pascap-row-retiming-media-'));
    config = createConfig({ dataDir: path.join(root, 'unused-cache') });
    sourcePath = path.join(root, 'generated-frame-codes.mp4');
    await encode(sourcePath, ['-bf', '0']);
    originalBytes = await readFile(sourcePath);
    fingerprint = await fingerprintFile(sourcePath);
    originalRgb = await decodeAll(sourcePath);
    expect(originalRgb).toHaveLength(20 * FRAME_BYTES);
    reorderedPath = path.join(root, 'generated-reordered-frame-codes.mp4');
    await encode(reorderedPath, ['-bf', '2', '-g', '6', '-keyint_min', '6', '-sc_threshold', '0']);
    reorderedRgb = await decodeAll(reorderedPath);
    expect(reorderedRgb).toHaveLength(20 * FRAME_BYTES);
    const types = await runProcess(config.ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=pict_type',
      '-of',
      'csv=p=0',
      reorderedPath,
    ]);
    expect(types.toString('utf8')).toContain('B');
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function options(
    clip: VideoClip,
    cwd: string,
    filename: string,
    signal: AbortSignal,
    source = sourcePath,
  ): RawRetimingOptions {
    return {
      ffmpeg: config.ffmpeg,
      cwd,
      clip,
      frameBytes: FRAME_BYTES,
      signal,
      decodeArgs: (excerpt) => [
        ...BASE,
        '-xerror',
        '-err_detect',
        'explode',
        '-threads',
        '2',
        '-noautorotate',
        ...excerptInputArgs(excerpt),
        '-i',
        source,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-filter_threads',
        '2',
        '-vf',
        excerptFilter(excerpt, RGB_FILTER),
        '-frames:v',
        String(excerpt.sourceOut - excerpt.sourceIn),
        '-fps_mode',
        'passthrough',
        '-c:v',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-threads',
        '2',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      encodeArgs: [
        ...BASE,
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgb24',
        '-video_size',
        `${WIDTH}x${HEIGHT}`,
        '-framerate',
        '30000/1001',
        '-threads',
        '2',
        '-i',
        'pipe:0',
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-filter_threads',
        '2',
        '-fps_mode',
        'passthrough',
        '-c:v',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-threads',
        '2',
        '-f',
        'rawvideo',
        filename,
      ],
    };
  }
  async function unchanged(): Promise<void> {
    expect(await readFile(sourcePath)).toEqual(originalBytes);
    expect(await fingerprintFile(sourcePath)).toEqual(fingerprint);
  }

  it.each(['hold', 'linear', 'ease-in', 'ease-out', 'smooth'] as const)(
    'streams every exact clip-curve source frame for %s and owns the captured map',
    async (interpolation) => {
      const work = await mkdtemp(path.join(root, 'mapped-'));
      try {
        const project = createProject(`native-curve-${interpolation}`, 'No UI state is involved');
        const row = createLayer('video-2', 'Placed row', false);
        project.layers.push(row);
        const speed: SpeedCurve = {
          mode: 'curve',
          keyframes: [
            { frame: 4, rate: 0.35, interpolation },
            { frame: 11, rate: 3, interpolation: 'ease-out' },
            { frame: 14, rate: 0.7, interpolation: 'smooth' },
            { frame: 17, rate: 2, interpolation: 'hold' },
          ],
        };
        const clip: VideoClip = {
          ...createClip('placed-curve-clip', 'generated-original', 7, 19),
          layerId: row.id,
          start: 9,
          speed,
        };
        project.clips = [clip];
        const captured = projectSchema.parse(project);
        const layout = calculateLayout(captured);
        const placed = layout.clips[0]!;
        const map = placed.retiming;
        const expected = Array.from({ length: map.duration }, (_, output) => map.sourceAt(output));
        expect(map.duration).toBe(compileRetiming(clip).duration);
        expect(Object.isFrozen(map)).toBe(true);
        const frameBuffer = Buffer.alloc(FRAME_BYTES);
        let mutated = false;
        const report = await retimeRawVideo({
          ...options(clip, work, 'mapped.rgb', new AbortController().signal),
          retiming: map,
          frameBuffer,
          onProgress: (_frames, total) => {
            expect(total).toBe(expected.length);
            if (mutated) return;
            mutated = true;
            clip.sourceIn = 8;
            speed.keyframes[0]!.rate = 8;
            speed.keyframes[1]!.frame = 12;
            clip.speed = { mode: 'constant', rate: 8 };
          },
        });
        expect(mutated).toBe(true);
        const actual = await readFile(path.join(work, 'mapped.rgb'));
        expect(actual).toHaveLength(map.duration * FRAME_BYTES);
        expect(report).toMatchObject({
          decodedFrames: 12,
          outputFrames: map.duration,
          frameBytes: FRAME_BYTES,
          rawFrameBuffers: 1,
        });
        expect(report.largestReadChunkBytes).toBeLessThanOrEqual(12 * FRAME_BYTES);
        expect(frameBuffer).toHaveLength(FRAME_BYTES);
        for (const [output, source] of expected.entries()) {
          expect(Number.isSafeInteger(source)).toBe(true);
          expect(source).toBeGreaterThanOrEqual(7);
          expect(source).toBeLessThan(19);
          if (output > 0) expect(source).toBeGreaterThanOrEqual(expected[output - 1]!);
          expect(actual.subarray(output * FRAME_BYTES, (output + 1) * FRAME_BYTES)).toEqual(
            originalRgb.subarray(source * FRAME_BYTES, (source + 1) * FRAME_BYTES),
          );
          const sample = sampleTimeline(captured, placed.start + output, layout)[0]!;
          expect(sample.sourceFrame).toBe(source);
        }
        await unchanged();
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );

  it.each(
    [false, true].flatMap((reordered) =>
      [
        { name: '1×', speed: { mode: 'constant', rate: 1 } as const, sourceIn: 0 },
        { name: '0.6× from a seek', speed: { mode: 'constant', rate: 0.6 } as const, sourceIn: 3 },
        {
          name: 'a slow-motion curve',
          speed: {
            mode: 'curve',
            keyframes: [
              { frame: 5, rate: 2, interpolation: 'linear' },
              { frame: 10, rate: 0.3, interpolation: 'smooth' },
              { frame: 15, rate: 1.5, interpolation: 'hold' },
            ],
          } as SpeedCurve,
          sourceIn: 2,
        },
      ].map((item) => ({ ...item, reordered, gop: reordered ? 'B-frame GOP 6' : 'P-only' })),
    ),
  )(
    'reverses $name ($gop) in seeked three-frame chunks with exact frame identity',
    async ({ speed, sourceIn, reordered }) => {
      const work = await mkdtemp(path.join(root, 'reversed-'));
      const [source, rgb] = reordered ? [reorderedPath, reorderedRgb] : [sourcePath, originalRgb];
      try {
        const clip: VideoClip = {
          ...createClip('reversed-clip', 'generated-original', sourceIn, 19),
          speed,
          reverse: true,
        };
        const map = compileRetiming(clip);
        const expected = Array.from({ length: map.duration }, (_, output) => map.sourceAt(output));
        expect(expected[0]).toBe(18);
        const report = await retimeRawVideo(options(clip, work, 'reversed.rgb', new AbortController().signal, source));
        const actual = await readFile(path.join(work, 'reversed.rgb'));
        expect(actual).toHaveLength(map.duration * FRAME_BYTES);
        expect(report).toMatchObject({
          decodedFrames: 19 - sourceIn,
          outputFrames: map.duration,
          rawFrameBuffers: 1,
          decoderProcesses: Math.ceil((19 - sourceIn) / 3),
        });
        for (const [output, source] of expected.entries()) {
          if (output > 0) expect(source).toBeLessThanOrEqual(expected[output - 1]!);
          expect(actual.subarray(output * FRAME_BYTES, (output + 1) * FRAME_BYTES)).toEqual(
            rgb.subarray(source * FRAME_BYTES, (source + 1) * FRAME_BYTES),
          );
        }
        await unchanged();
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );

  it('rejects invalid supplied durations/query APIs before starting children instead of falling back to static speed', async () => {
    const work = await mkdtemp(path.join(root, 'invalid-map-'));
    try {
      const clip = createClip('invalid', 'generated-original', 7, 19);
      const baseline = compileRetiming(clip);
      for (const duration of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
        await expect(
          retimeRawVideo({
            ...options(clip, work, 'must-not-exist.rgb', new AbortController().signal),
            ffmpeg: '/must-not-run-invalid-row-map',
            retiming: { ...baseline, duration },
          }),
        ).rejects.toThrow('map duration');
      }
      await expect(
        retimeRawVideo({
          ...options(clip, work, 'must-not-exist.rgb', new AbortController().signal),
          ffmpeg: '/must-not-run-invalid-row-map',
          retiming: null as unknown as Retiming,
        }),
      ).rejects.toThrow('map duration');
      await expect(
        retimeRawVideo({
          ...options(clip, work, 'must-not-exist.rgb', new AbortController().signal),
          ffmpeg: '/must-not-run-invalid-row-map',
          retiming: { ...baseline, sourceAt: null } as unknown as Retiming,
        }),
      ).rejects.toThrow('sourceAt, sourcePositionAt and outputAt');
      expect(await readdir(work)).toEqual([]);
      await unchanged();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects descending, out-of-range, fractional and nonfinite maps while reaping native companions', async () => {
    const clip = createClip('invalid-source', 'generated-original', 7, 19);
    const maps = [
      [7, 9, 8, 10],
      [7, 6, 8, 9],
      [7, 19, 19, 19],
      [7, 7.5, 8, 9],
      [7, NaN, 8, 9],
      [7, Infinity, 8, 9],
    ];
    for (const sources of maps) {
      const work = await mkdtemp(path.join(root, 'invalid-source-'));
      try {
        const retiming: Retiming = {
          duration: sources.length,
          sourceAt: (output) => sources[output]!,
          sourcePositionAt: (output) => 7 + Math.max(0, Math.min(1, output / sources.length)) * 12,
          outputAt: () => 0,
        };
        await expect(
          retimeRawVideo({ ...options(clip, work, 'partial.rgb', new AbortController().signal), retiming }),
        ).rejects.toThrow('monotonic, in-range discrete source-frame map');
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    await unchanged();
  });

  it('cancels a supplied clip map during backpressured native writes without changing the original', async () => {
    const work = await mkdtemp(path.join(root, 'cancelled-'));
    const controller = new AbortController();
    try {
      const project = createProject('cancelled-clip', 'Disposable clip-map cancellation');
      project.clips = [
        { ...createClip('slow-clip', 'generated-original', 7, 19), speed: { mode: 'constant', rate: 0.1 } },
      ];
      const placed = calculateLayout(project).clips[0]!;
      let progress = false;
      expect(placed.duration).toBe(120);
      await expect(
        retimeRawVideo({
          ...options(placed.clip, work, 'partial.rgb', controller.signal),
          retiming: placed.retiming,
          onProgress: () => {
            progress = true;
            controller.abort();
          },
        }),
      ).rejects.toThrow('cancelled');
      expect(progress).toBe(true);
      await unchanged();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
