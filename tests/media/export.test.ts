import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { preparedFixture } from '../../scripts/fixtures.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { renderExport, startExport, type ExportReceipt } from '../../src/server/export.js';
import { fingerprintFile } from '../../src/server/files.js';
import { extractComparisonFrame } from '../../src/server/library.js';
import { probeVideo } from '../../src/server/probe.js';
import * as nativeProcesses from '../../src/server/process.js';
import { runProcess } from '../../src/server/process.js';
import { audioAssetSchema, musicGainAt, type AudioAsset } from '../../src/shared/audio.js';
import { gradePixel, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import { estimateExportSpace } from '../../src/shared/export-space.js';
import {
  EXPORT_PROFILES,
  EXPORT_RESOURCES,
  exportAudioSample,
  needsLayeredExport,
  planExportMusic,
  type ExportMusicPlan,
} from '../../src/shared/export.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { removeMarkedRange } from '../../src/shared/rush-editing.js';
import { forEachSerial } from '../../src/shared/serial.js';
import { compileRetiming, type SpeedSettings } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { framesToSeconds } from '../../src/shared/timing.js';
import { observedJobBytes } from './scratch-observation.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const FRAME_BYTES = 160 * 90 * 3;
const curves = ['linear', 'ease-in', 'ease-out', 'smooth'] as const;
const speeds: SpeedSettings[] = [
  { mode: 'constant', rate: 0.5 },
  { mode: 'constant', rate: 2 },
  ...curves.flatMap((interpolation) =>
    [
      [0.5, 2],
      [2, 0.5],
    ].map(([start, end]): SpeedSettings => ({
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: start!, interpolation },
        { frame: 26, rate: end!, interpolation: 'hold' },
      ],
    })),
  ),
];

async function rawVideo(config: ServiceConfig, asset: MediaAsset): Promise<Buffer> {
  return runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-nostdin',
    '-threads',
    '2',
    '-i',
    asset.sourcePath,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    `scale=160:90:flags=area:in_color_matrix=bt709:out_color_matrix=bt709:in_range=${asset.metadata.colourRange}:out_range=pc,format=rgb24`,
    '-threads',
    '2',
    '-filter_threads',
    '2',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
}
// The existing native colour contract allows MAE <4/255 after 8-bit limited YUV.
// Measured separately: LUT rounding <=1 level, RGB/YUV round-trip another 2–3.
function assertPixels(
  document: ProjectDocument,
  frame: number,
  actual: Uint8Array,
  originals: Map<string, Buffer>,
  tolerance = 4,
): number {
  const expected = new Float64Array(FRAME_BYTES);
  for (const layer of sampleTimeline(document, frame)) {
    const source = originals.get(layer.mediaId)!;
    const pixels = source.subarray(layer.sourceFrame * FRAME_BYTES, (layer.sourceFrame + 1) * FRAME_BYTES);
    for (let index = 0; index < FRAME_BYTES; index += 3) {
      const rgb = gradePixel([pixels[index]! / 255, pixels[index + 1]! / 255, pixels[index + 2]! / 255], layer.colour);
      for (let channel = 0; channel < 3; channel++) expected[index + channel]! += rgb[channel]! * 255 * layer.weight;
    }
  }
  const mae = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]!), 0) / actual.length;
  expect(mae, `frame ${frame}, shared sourceAt + grade + transition MAE ${mae}`).toBeLessThan(tolerance);
  return mae;
}
function rms(samples: Float32Array, start: number, count: number): number {
  let energy = 0;
  for (let sample = start; sample < start + count; sample++) energy += (samples[sample] ?? 0) ** 2;
  return Math.sqrt(energy / count);
}
function floats(bytes: Buffer): Float32Array {
  return new Float32Array(Uint8Array.from(bytes).buffer);
}
async function rawAudio(config: ServiceConfig, filename: string): Promise<Float32Array> {
  return floats(
    await runProcess(config.ffmpeg, [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-i',
      filename,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      'pan=mono|c0=c0',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-filter_threads',
      '2',
      '-threads',
      '2',
      '-f',
      'f32le',
      'pipe:1',
    ]),
  );
}

/** Bounded disposable PCM evidence, both channels, before lossy AAC encoding. */
async function stereoPCM(config: ServiceConfig, filename: string): Promise<Float64Array> {
  const bytes = await runProcess(
    config.ffmpeg,
    [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-i',
      filename,
      '-map',
      '0:a:0',
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-filter_threads',
      '2',
      '-threads',
      '2',
      '-f',
      'f64le',
      'pipe:1',
    ],
    { maxBytes: 2 * 1024 * 1024 },
  );
  return new Float64Array(Uint8Array.from(bytes).buffer);
}

/** Independent integer-sample oracle: no FFmpeg envelopes/mix/clamp filters. */
function expectedMusicPCM(plans: readonly ExportMusicPlan[], sources: ReadonlyMap<string, Float64Array>): Float64Array {
  const expected = new Float64Array(plans[0]!.videoSamples * 2);
  for (const plan of plans) {
    const source = sources.get(plan.mediaId)!;
    const selected = plan.sourceOutSamples - plan.sourceInSamples;
    for (let offset = 0; offset < plan.activeSamples; offset++) {
      // Independently rounded IN/OUT can select one fewer sample than duration.
      // Non-looping audio pads that sample with silence, never reads beyond OUT.
      if (!plan.loop && offset >= selected) continue;
      const envelope =
        plan.gain *
        (plan.fadeInSamples && offset < plan.fadeInSamples ? offset / plan.fadeInSamples : 1) *
        (plan.fadeOutSamples && offset >= plan.durationSamples - plan.fadeOutSamples
          ? (plan.durationSamples - offset) / plan.fadeOutSamples
          : 1);
      const original = plan.sourceInSamples + (plan.loop ? offset % selected : offset);
      for (let channel = 0; channel < 2; channel++) {
        const value = source[original * 2 + channel];
        expect(value, `registered source sample ${original}, channel ${channel}`).toBeDefined();
        expected[(plan.startSamples + offset) * 2 + channel]! += value! * envelope;
      }
    }
  }
  return expected;
}

function assertPCM(actual: Float64Array, expected: Float64Array, label: string): void {
  expect(actual, `${label} exact stereo sample count`).toHaveLength(expected.length);
  let maximum = 0;
  let worst = 0;
  for (let index = 0; index < expected.length; index++) {
    if (!Number.isFinite(actual[index]) || !Number.isFinite(expected[index])) {
      maximum = Infinity;
      worst = index;
      break;
    }
    const error = Math.abs(actual[index]! - expected[index]!);
    if (error > maximum) {
      maximum = error;
      worst = index;
    }
  }
  expect(maximum, `${label} sample ${Math.floor(worst / 2)}, channel ${worst % 2}`).toBeLessThan(1e-12);
}

/** Encode independently reconstructed final Float32 PCM with the same AAC codec.
 * This deliberately does not use the production accumulator or clamp graph.
 */
async function referenceAAC(
  config: ServiceConfig,
  directory: string,
  expected: Float64Array,
  frames: number,
): Promise<Float64Array> {
  const name = randomUUID();
  const pcm = path.join(directory, `${name}.f32`);
  const encoded = path.join(directory, `${name}.m4a`);
  const final = Float32Array.from(expected, (value) => Math.max(-1, Math.min(1, value)));
  await writeFile(pcm, new Uint8Array(final.buffer));
  try {
    await runProcess(config.ffmpeg, [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'f32le',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-i',
      pcm,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-threads:a',
      '2',
      '-t',
      framesToSeconds(frames).toFixed(9),
      encoded,
    ]);
    return await stereoPCM(config, encoded);
  } finally {
    await rm(pcm, { force: true });
    await rm(encoded, { force: true });
  }
}

describe.skipIf(!enabled)('production native export · opt-in disposable media only', () => {
  let directory: string;
  let config: ServiceConfig;
  let fixture: Awaited<ReturnType<typeof preparedFixture>>;
  let assets: MediaAsset[];
  let originals: Map<string, Buffer>;
  let audio: AudioAsset;
  let mixSources: AudioAsset[];
  let audioSamples: Float32Array;
  let sourcePCM: Map<string, Float64Array>;
  let savedDocument: Buffer;
  let successfulDirectory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-export-media-'));
    config = createConfig({ dataDir: directory });
    fixture = await preparedFixture(config);
    savedDocument = await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`));
    assets = [];
    for (let index = 0; index < 2; index++) {
      const filename = path.join(directory, 'synthetic-sources', `export-frame-codes-${index}.mp4`);
      // Flat, time-varying colours expose a wrong source frame numerically, without
      // resampling/edge ambiguity. One original contains audio which MUST NOT leak.
      await runProcess(config.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-n',
        '-f',
        'lavfi',
        '-i',
        `nullsrc=size=160x90:rate=30000/1001,geq=lum='40+4*N':cb='${90 + index * 25}+N':cr='${175 - index * 25}-2*N',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
        ...(index === 0 ? ['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000'] : []),
        '-frames:v',
        '40',
        '-t',
        framesToSeconds(40).toFixed(9),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '10',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '2',
        '-filter_threads',
        '2',
        '-bf',
        '0',
        ...(index === 0 ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
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
      // Deliberately never prepare these assets: production export cannot need a proxy.
      assets.push(await fixture.library.register(filename));
    }
    originals = new Map(
      await Promise.all(assets.map(async (asset) => [asset.id, await rawVideo(config, asset)] as const)),
    );
    const audioPath = path.join(directory, 'synthetic-sources', 'selected-tone.wav');
    await runProcess(config.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=220:sample_rate=48000:duration=${framesToSeconds(6)}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=880:sample_rate=48000:duration=${framesToSeconds(12)}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=1760:sample_rate=48000:duration=${framesToSeconds(6)}`,
      '-filter_complex_threads',
      '2',
      '-filter_complex',
      '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
      '-map',
      '[out]',
      '-c:a',
      'pcm_s16le',
      '-threads',
      '2',
      '-ar',
      '48000',
      audioPath,
    ]);
    audioSamples = await rawAudio(config, audioPath);
    audio = audioAssetSchema.parse({
      id: 'export-music',
      name: 'selected-tone.wav',
      sourcePath: audioPath,
      fingerprint: await fingerprintFile(audioPath),
      metadata: {
        codec: 'pcm_s16le',
        sampleRate: 48000,
        channels: 1,
        durationSeconds: audioSamples.length / 48000,
        frameCount: 23,
      },
      status: 'registered',
      error: null,
      waveform: [],
    });
    mixSources = [audio];
    sourcePCM = new Map([
      [
        audio.id,
        Float64Array.from({ length: audioSamples.length * 2 }, (_, index) => audioSamples[Math.floor(index / 2)]!),
      ],
    ]);
    await forEachSerial([1, -1], async (polarity) => {
      const filename = path.join(directory, 'synthetic-sources', `opposing-${polarity}.wav`);
      await runProcess(config.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-n',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=${polarity}*0.5*sin(2*PI*880*t)|${-polarity}*0.5*sin(2*PI*880*t):s=48000:d=${framesToSeconds(24)}`,
        '-c:a',
        'pcm_s16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-threads',
        '2',
        filename,
      ]);
      const samples = await rawAudio(config, filename);
      mixSources.push(
        audioAssetSchema.parse({
          ...audio,
          id: polarity > 0 ? 'positive-music' : 'negative-music',
          name: path.basename(filename),
          sourcePath: filename,
          fingerprint: await fingerprintFile(filename),
          metadata: { ...audio.metadata, channels: 2, durationSeconds: samples.length / 48000, frameCount: 23 },
        }),
      );
      sourcePCM.set(mixSources.at(-1)!.id, await stereoPCM(config, filename));
    });
  });
  afterAll(async () => {
    await fixture?.jobs.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function document(length = 36): ProjectDocument {
    const project = createProject('native-export', 'Native disposable export');
    project.clips = [createClip('one', assets[0]!.id, 0, length)];
    return projectSchema.parse(project);
  }
  async function completed(project: ProjectDocument, profile: 'draft720' | 'final4k' = 'draft720') {
    const job = startExport(project, profile, fixture.library, async (id) => {
      const source = mixSources.find((item) => item.id === id);
      expect(source, `captured audio source ${id}`).toBeDefined();
      return source!;
    });
    const result = await fixture.jobs.wait(job.id);
    expect(result.state, result.message).toBe('completed');
    expect(result.progress).toBe(1);
    expect(result.outputUrl).toBe(`/api/jobs/${job.id}/export`);
    expect(result.receiptUrl).toBe(`/api/jobs/${job.id}/receipt`);
    const renderDirectory = path.join(directory, 'renders', job.id);
    expect((await readdir(renderDirectory)).sort()).toEqual(['export.mp4', 'receipt.json']);
    const receipt = JSON.parse(await readFile(path.join(renderDirectory, 'receipt.json'), 'utf8')) as ExportReceipt;
    expect(receipt.profile).toBe(profile);
    expect(receipt.outputName).toBe(result.label);
    expect(receipt.verification.fullDecode).toBe(true);
    expect(receipt.verification.faststart).toBe(true);
    expect(receipt.verification.frameCount).toBe(calculateLayout(project).duration);
    expect(receipt.verification).toMatchObject({
      width: EXPORT_PROFILES[profile].width,
      height: EXPORT_PROFILES[profile].height,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      colourRange: 'tv',
    });
    return { job, filename: path.join(renderDirectory, 'export.mp4'), renderDirectory, receipt };
  }

  it.each([
    { temperature: -1, tint: -1 },
    { temperature: -1, tint: 1 },
    { temperature: 1, tint: -1 },
    { temperature: 1, tint: 1 },
  ])(
    'exports static Temperature $temperature / Tint $tint through the native LUT with unchanged frames/fades/resources',
    async ({ temperature, tint }) => {
      const project = document(6);
      project.layers[0]!.colour = {
        ...NEUTRAL_COLOUR,
        temperature,
        tint,
        exposure: -0.25,
        brightness: 0.015,
        contrast: 1.05,
        saturation: 0.9,
        hue: 7,
        highlights: -0.1,
        shadows: 0.08,
      };
      project.layers[0]!.openingFade = 1;
      project.layers[0]!.closingFade = 1;
      const captured = structuredClone(project);
      expect(needsLayeredExport(project)).toBe(false);
      const result = await completed(project);
      expect(result.receipt.snapshot).toEqual(captured);
      expect(result.receipt.snapshot.schemaVersion).toBe(14);
      expect(result.receipt.settings.pipeline).toBe('static-single-layer');
      expect(result.receipt.settings.resources).toEqual(EXPORT_RESOURCES);
      expect(result.receipt.settings.layered).toBeNull();
      expect(result.receipt.settings.lutInterpolation).toBe('tetrahedral');
      expect(result.receipt.retiming).toHaveLength(1);
      expect(result.receipt.retiming[0]).toMatchObject({ decodedFrames: 6, outputFrames: 6, rawFrameBuffers: 1 });
      expect(result.receipt.retiming[0]!.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
      expect(result.receipt.verification.hasAudio).toBe(false);
      const pixels = await rawVideo(config, { ...assets[0]!, sourcePath: result.filename });
      expect(pixels).toHaveLength(6 * FRAME_BYTES);
      for (let frame = 0; frame < 6; frame++) {
        const actual = pixels.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES);
        assertPixels(project, frame, actual, originals);
        if (frame === 0 || frame === 5)
          expect(actual.reduce((sum, value) => sum + value, 0) / FRAME_BYTES).toBeLessThan(1);
      }
      expect(project).toEqual(captured);
      expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
      for (const asset of assets) {
        expect(asset.prepared).toBeNull();
        expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint);
      }
    },
  );

  it('exports >2 clips, repeated graded originals, slow/fast and both directions of every ramp-shaped curve with exact numeric pixels', async () => {
    const project = createProject('native-many', 'Many clips and every speed curve');
    project.layers[0]!.colour = {
      ...NEUTRAL_COLOUR,
      contrast: 1.05,
      shadows: 0.05,
      hue: 10,
      exposure: 0.2,
      brightness: 0.04,
      saturation: 0.85,
    };
    project.clips = speeds.map((speed, index) => ({
      ...createClip(`instance-${index}`, assets[index % 2]!.id, 1 + (index % 4), 19 + (index % 4)),
      speed,
    }));
    project.layers[0]!.transitions = project.clips.slice(1).map((clip, index) => {
      const pair = { leftId: project.clips[index]!.id, rightId: clip.id };
      if (index % 3 === 0) return { ...pair, type: 'cut' as const, duration: 0 as const };
      return {
        ...pair,
        type: index % 3 === 1 ? ('cross-dissolve' as const) : ('fade-through-black' as const),
        duration: index % 3 === 1 ? 4 : 5,
      };
    });
    project.layers[0]!.openingFade = 3;
    project.layers[0]!.closingFade = 3;
    const updates: number[] = [];
    const diskSamples: number[] = [];
    const submit = fixture.jobs.submit.bind(fixture.jobs);
    const spy = vi.spyOn(fixture.jobs, 'submit').mockImplementation((kind, label, task, settled = null) =>
      submit(
        kind,
        label,
        async (context) =>
          task({
            ...context,
            update: (progress, message) => {
              updates.push(progress);
              context.update(progress, message);
              diskSamples.push(observedJobBytes(path.join(directory, 'renders', context.id)));
            },
          }),
        settled,
      ),
    );
    let result: Awaited<ReturnType<typeof completed>>;
    try {
      result = await completed(project);
    } finally {
      spy.mockRestore();
    }
    successfulDirectory = result.renderDirectory;
    expect(Math.max(...diskSamples)).toBeGreaterThan(0);
    console.log(
      `Native scratch observation (static 720p): maximum ${Math.max(...diskSamples)} allocated file bytes at ${diskSamples.length} progress points; planning allowance ${estimateExportSpace(project, 'draft720').totalBytes} bytes. Directory metadata and between-sample peaks are not measured.`,
    );
    expect(updates.length).toBeGreaterThan(20);
    expect(updates.every((value, index) => index === 0 || value >= updates[index - 1]!)).toBe(true);
    expect(result.receipt.retiming).toHaveLength(speeds.length);
    for (const [index, report] of result.receipt.retiming.entries()) {
      expect(report.decodedFrames).toBe(18);
      expect(report.outputFrames).toBe(compileRetiming(project.clips[index]!).duration);
      expect(report.rawFrameBuffers).toBe(1);
      expect(report.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
    }
    expect(result.receipt.verification.hasAudio).toBe(false);
    const output = await rawVideo(config, {
      ...assets[0]!,
      sourcePath: result.filename,
      metadata: { ...assets[0]!.metadata, frameCount: result.receipt.verification.frameCount },
    });
    expect(output).toHaveLength(calculateLayout(project).duration * FRAME_BYTES);
    // Every output frame, including numeric dissolve midpoints and black boundaries.
    let maxMae = 0;
    for (let frame = 0; frame < result.receipt.verification.frameCount; frame++) {
      maxMae = Math.max(
        maxMae,
        assertPixels(project, frame, output.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES), originals),
      );
    }
    console.log(
      `Native multi-clip map/grade/fade parity: ${result.receipt.verification.frameCount} frames, maximum MAE ${maxMae.toFixed(3)} / 255`,
    );
    for (const frame of [0, result.receipt.verification.frameCount - 1]) {
      const pixels = output.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES);
      expect(pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length).toBeLessThan(1);
    }
    expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
    for (const asset of assets) expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint);
  }, 180_000);

  it('exports a ripple cut as independent recoverable excerpts with the removed source interval absent from every output frame', async () => {
    const before = document(24);
    before.clips[0]!.speed = { mode: 'constant', rate: 2 };
    before.layers[0]!.colour = { ...NEUTRAL_COLOUR, exposure: 0.3, brightness: 0.04, saturation: 0.8 };
    before.clips.push(createClip('two', assets[1]!.id, 2, 10));
    before.clips[1]!.start = 12;
    before.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
    const project = applyCommand(
      before,
      removeMarkedRange(before, { clipId: 'one', inFrame: 3, outFrame: 6 }, 'one-right'),
    );
    expect(project.clips).toEqual([
      { ...before.clips[0]!, sourceOut: 6 },
      { ...before.clips[0]!, id: 'one-right', sourceIn: 12, start: 3 },
      { ...before.clips[1]!, start: 9 },
    ]);
    expect(calculateLayout(project).clips.map((placed) => [placed.clip.id, placed.start, placed.end])).toEqual([
      ['one', 0, 3],
      ['one-right', 3, 9],
      ['two', 9, 17],
    ]);
    const result = await completed(project);
    expect(result.receipt.snapshot).toEqual(project);
    expect(result.receipt.retiming.map((report) => [report.decodedFrames, report.outputFrames])).toEqual([
      [6, 3],
      [12, 6],
      [8, 8],
    ]);
    expect(result.receipt.verification.hasAudio).toBe(false);
    const output = await rawVideo(config, {
      ...assets[0]!,
      sourcePath: result.filename,
      metadata: { ...assets[0]!.metadata, frameCount: 17 },
    });
    expect(output).toHaveLength(17 * FRAME_BYTES);
    for (let frame = 0; frame < 17; frame++) {
      const sampled = sampleTimeline(project, frame);
      expect(sampled).toHaveLength(1);
      if (frame < 9) expect(sampled[0]!.sourceFrame < 6 || sampled[0]!.sourceFrame >= 12).toBe(true);
      assertPixels(project, frame, output.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES), originals);
    }
    const restored = applyCommand(project, { type: 'trim', clipId: 'one', sourceIn: 0, sourceOut: 12 });
    expect(restored.clips[1]).toEqual({ ...project.clips[1]!, start: 6 });
    expect(calculateLayout(restored).clips.map((placed) => [placed.clip.id, placed.start, placed.end])).toEqual([
      ['one', 0, 6],
      ['one-right', 6, 12],
      ['two', 12, 20],
    ]);
    expect(before.clips[0]!.sourceOut).toBe(24);
    for (const asset of assets) {
      expect(asset.prepared).toBeNull();
      expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint);
    }
    expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
  });

  it('supports a one-frame dissolve and clips whose entire output consists of transition tails', async () => {
    const project = document(1);
    project.clips.push(createClip('two', assets[1]!.id, 8, 9));
    project.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cross-dissolve', duration: 1 }];
    const result = await completed(project);
    expect(result.receipt.timeline.chunks).toHaveLength(1);
    const pixels = await extractComparisonFrame(config, result.filename, 0, 'tv');
    assertPixels(project, 0, pixels, originals);
  });

  it('renders a few genuine UHD frames, grading before output-frame one-frame black fades', async () => {
    const project = document(6);
    project.clips[0]!.speed = { mode: 'constant', rate: 2 };
    project.layers[0]!.colour = { ...NEUTRAL_COLOUR, brightness: 0.1, shadows: 0.25 };
    project.layers[0]!.openingFade = 1;
    project.layers[0]!.closingFade = 1;
    const result = await completed(project, 'final4k');
    expect(result.receipt.verification.frameCount).toBe(3);
    for (const frame of [0, 1, 2]) {
      const pixels = await extractComparisonFrame(config, result.filename, frame, 'tv');
      assertPixels(project, frame, pixels, originals);
      if (frame !== 1) expect(pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length).toBeLessThan(1);
    }
    expect((await probeVideo(config, result.filename)).width).toBe(3840);
  }, 120_000);

  it('places, loops ONLY the selected music range, applies linear fades/gain and pads AAC to the complete video', async () => {
    const project = document(36);
    project.music = [
      {
        id: 'music-instance',
        mediaId: audio.id,
        sourceIn: 6,
        sourceOut: 12,
        start: 3,
        duration: 24,
        gainDb: -6,
        fadeIn: 6,
        fadeOut: 6,
        loop: true,
      },
    ];
    const result = await completed(project);
    const samples = await rawAudio(config, result.filename);
    expect(result.receipt.verification.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(result.receipt.verification.audio!.durationErrorSeconds).toBeLessThanOrEqual(framesToSeconds(1));
    const track = project.music[0]!;
    const start = exportAudioSample(track.start);
    const sourceIn = exportAudioSample(track.sourceIn);
    const selected = exportAudioSample(track.sourceOut) - sourceIn;
    for (const frame of [1, 6, 9, 15, 24, 29, 33]) {
      const center = exportAudioSample(frame);
      const first = center - 240;
      const count = 480;
      let expectedEnergy = 0;
      for (let sample = first; sample < first + count; sample++) {
        const offset = sample - start;
        const original = offset < 0 ? 0 : audioSamples[sourceIn + (offset % selected)]!;
        const gain = musicGainAt(track, (sample * 30000) / (48000 * 1001));
        expectedEnergy += (original * gain) ** 2;
      }
      const expected = Math.sqrt(expectedEnergy / count);
      expect(Math.abs(rms(samples, first, count) - expected), `music envelope frame ${frame}`).toBeLessThan(0.004);
    }
    // Selected range contains 880 Hz; looping the whole original would expose 220/1760.
    for (const frame of [10, 16, 22]) {
      const first = exportAudioSample(frame);
      const count = 2048;
      const strength = (frequency: number): number => {
        let real = 0;
        let imaginary = 0;
        for (let index = 0; index < count; index++) {
          const phase = (2 * Math.PI * frequency * index) / 48000;
          real += samples[first + index]! * Math.cos(phase);
          imaginary += samples[first + index]! * Math.sin(phase);
        }
        return Math.hypot(real, imaginary);
      };
      expect(strength(880)).toBeGreaterThan(10 * Math.max(strength(220), strength(1760)));
    }
    expect(await fingerprintFile(audio.sourcePath)).toEqual(audio.fingerprint);
  }, 120_000);

  it('also supports non-looping music and a music placement entirely after the video', async () => {
    for (const start of [2, 20]) {
      const project = document(12);
      project.music = [
        {
          id: 'music-instance',
          mediaId: audio.id,
          sourceIn: 6,
          sourceOut: 14,
          start,
          duration: 8,
          gainDb: 0,
          fadeIn: 0,
          fadeOut: 0,
          loop: false,
        },
      ];
      const result = await completed(project);
      const samples = await rawAudio(config, result.filename);
      expect(result.receipt.verification.hasAudio).toBe(true);
      if (start === 20) {
        expect(result.receipt.verification.frameCount).toBe(28);
        expect(result.receipt.settings.pipeline).toBe('sequential-layered');
        expect(result.receipt.settings.audio[0]!.activeSamples).toBe(exportAudioSample(8));
        expect(result.receipt.settings.audio[0]!.videoSamples).toBe(exportAudioSample(28));
        expect(rms(samples, 0, exportAudioSample(19))).toBeLessThan(0.0001);
        expect(rms(samples, exportAudioSample(22), 480)).toBeGreaterThan(0.07);
        for (const frame of [12, 19, 22, 27]) {
          const pixels = await extractComparisonFrame(config, result.filename, frame, 'tv');
          expect(
            pixels.every((value) => value <= 1),
            `black music-only frame ${frame}`,
          ).toBe(true);
        }
      } else {
        expect(rms(samples, exportAudioSample(5), 480)).toBeGreaterThan(0.07);
        expect(rms(samples, exportAudioSample(11), 480)).toBeLessThan(0.001);
      }
    }
  }, 120_000);

  it.each([
    { profile: 'draft720' as const, videoFrames: 6, projectFrames: 36, fadeOut: 6 },
    { profile: 'final4k' as const, videoFrames: 3, projectFrames: 6, fadeOut: 2 },
  ])(
    'exports an immutable $profile music conclusion with exact black-tail frames and independently ending fades',
    async ({ profile, videoFrames, projectFrames, fadeOut }) => {
      const project = document(videoFrames);
      project.layers[0]!.closingFade = profile === 'final4k' ? 1 : 2;
      const long = {
        id: 'longest-first',
        mediaId: audio.id,
        sourceIn: 6,
        sourceOut: 12,
        start: 0,
        duration: projectFrames,
        gainDb: -6,
        fadeIn: 0,
        fadeOut,
        loop: true,
      };
      project.music = [
        long,
        { ...long, id: 'shorter-last', start: 1, duration: 1, fadeOut: 1, gainDb: -12, loop: false },
      ];
      const captured = structuredClone(project);
      const capturedLong = captured.music[0]!;
      const plans = captured.music.map((track) => planExportMusic(track, projectFrames));
      const originalRun = nativeProcesses.runProcess;
      const accumulators: number[] = [];
      const processSpy = vi
        .spyOn(nativeProcesses, 'runProcess')
        .mockImplementation(async (binary, args, options = {}) => {
          const result = await originalRun(binary, args, options);
          const match = /^music-accumulator-(\d+)\.wav$/.exec(args.at(-1)!);
          if (binary === config.ffmpeg && match) {
            const index = Number(match[1]);
            const actual = await stereoPCM(config, path.join(options.cwd!, args.at(-1)!));
            assertPCM(
              actual,
              expectedMusicPCM(plans.slice(0, index + 1), sourcePCM),
              `${profile} accumulator ${index}`,
            );
            accumulators.push(index);
          }
          return result;
        });
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const busy = fixture.jobs.submit('prepare', 'Synthetic scheduling gate', async () => gate);
      let jobId = '';
      try {
        const job = startExport(project, profile, fixture.library, () => audio);
        jobId = job.id;
        expect(job.state).toBe('queued');
        project.title = 'Later editor changes';
        project.music[0]!.duration += 5;
        project.music[1]!.gainDb = -30;
        project.clips[0]!.sourceOut++;
        release();
        await fixture.jobs.wait(busy.id);
        const result = await fixture.jobs.wait(jobId);
        expect(result.state, result.message).toBe('completed');
        const outputDirectory = path.join(directory, 'renders', jobId);
        expect((await readdir(outputDirectory)).sort()).toEqual(['export.mp4', 'receipt.json']);
        const receipt = JSON.parse(await readFile(path.join(outputDirectory, 'receipt.json'), 'utf8')) as ExportReceipt;
        expect(receipt.snapshot).toEqual(captured);
        expect(receipt.timeline.duration).toBe(projectFrames);
        expect(receipt.verification).toMatchObject({
          width: EXPORT_PROFILES[profile].width,
          height: EXPORT_PROFILES[profile].height,
          frameCount: projectFrames,
          fullDecode: true,
          faststart: true,
          hasAudio: true,
          codec: 'h264',
          pixelFormat: 'yuv420p',
          colourRange: 'tv',
        });
        expect(receipt.verification.audio!.durationErrorSeconds).toBeLessThanOrEqual(framesToSeconds(1));
        expect(receipt.settings.pipeline).toBe('sequential-layered');
        const layered = receipt.settings.layered!;
        expect(layered.layerPasses).toBe(1);
        expect(layered.peakOriginalVideoDecoders).toBe(1);
        expect(layered.peakIntermediateVideoDecoders).toBeLessThanOrEqual(2);
        expect(layered.peakNativeVideoChildren).toBeLessThanOrEqual(3);
        expect(layered.rawFrameBuffers).toBe(4);
        expect(layered.rawBufferBytes).toBe(EXPORT_PROFILES[profile].width * EXPORT_PROFILES[profile].height * 22);
        expect(layered.peakLosslessTimelineRepresentations).toBeLessThanOrEqual(3);
        expect(receipt.retiming[0]).toMatchObject({ decodedFrames: videoFrames, outputFrames: videoFrames });
        expect(receipt.settings.audio.map((track) => [track.id, track.activeSamples, track.videoSamples])).toEqual([
          [long.id, exportAudioSample(projectFrames), exportAudioSample(projectFrames)],
          ['shorter-last', exportAudioSample(1), exportAudioSample(projectFrames)],
        ]);
        expect(receipt.musicSources).toEqual([audio]);
        expect(accumulators).toEqual([0, 1]);
        const filename = path.join(outputDirectory, 'export.mp4');
        const rgb = await rawVideo(config, { ...assets[0]!, sourcePath: filename });
        expect(rgb).toHaveLength(projectFrames * FRAME_BYTES);
        for (let frame = 0; frame < projectFrames; frame++) {
          const pixels = rgb.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES);
          assertPixels(captured, frame, pixels, originals);
          if (frame >= videoFrames - 1)
            expect(
              pixels.every((value) => value <= 1),
              `black conclusion frame ${frame}`,
            ).toBe(true);
        }
        const samples = await rawAudio(config, filename);
        const sourceIn = exportAudioSample(capturedLong.sourceIn);
        const selected = exportAudioSample(capturedLong.sourceOut) - sourceIn;
        for (const frame of [videoFrames, projectFrames - 1]) {
          const first = exportAudioSample(frame) - 240;
          let expectedEnergy = 0;
          for (let sample = first; sample < first + 480; sample++) {
            const expected =
              audioSamples[sourceIn + (sample % selected)]! *
              musicGainAt(capturedLong, (sample * 30000) / (48000 * 1001));
            expectedEnergy += expected ** 2;
          }
          expect(
            Math.abs(rms(samples, first, 480) - Math.sqrt(expectedEnergy / 480)),
            `audible tail/fade frame ${frame}`,
          ).toBeLessThan(0.004);
        }
        expect(rms(samples, exportAudioSample(videoFrames), 480)).toBeGreaterThan(0.03);
        expect(rms(samples, exportAudioSample(projectFrames - 1) - 240, 480)).toBeLessThan(
          rms(samples, exportAudioSample(videoFrames), 480),
        );
        expect(project.title).toBe('Later editor changes');
        await forEachSerial([...assets, ...mixSources], async (source) =>
          expect(await fingerprintFile(source.sourcePath)).toEqual(source.fingerprint),
        );
        expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
      } finally {
        release();
        processSpy.mockRestore();
      }
    },
    120_000,
  );

  it('mixes eight instances with serial native children, three scratch files and no intermediate clipping or normalization', async () => {
    const project = document(36);
    const positive = mixSources[1]!;
    const negative = mixSources[2]!;
    const base = {
      id: 'mix',
      mediaId: positive.id,
      sourceIn: 0,
      sourceOut: 12,
      start: 0,
      duration: 36,
      gainDb: 12,
      fadeIn: 0,
      fadeOut: 0,
      loop: true,
    };
    project.music = [
      ...Array.from({ length: 6 }, (_, index) => ({
        ...base,
        id: `opposing-${index}`,
        mediaId: index < 3 ? positive.id : negative.id,
      })),
      {
        ...base,
        id: 'retained-tone',
        mediaId: audio.id,
        sourceIn: 6,
        sourceOut: 12,
        start: 3,
        duration: 24,
        gainDb: -6,
        fadeIn: 6,
        fadeOut: 6,
      },
      {
        ...base,
        id: 'late-conclusion',
        mediaId: audio.id,
        sourceIn: 6,
        sourceOut: 12,
        start: 40,
        duration: 6,
        gainDb: -6,
        fadeOut: 2,
        loop: false,
      },
    ];
    const captured = structuredClone(project.music);
    const updates: number[] = [];
    const submit = fixture.jobs.submit.bind(fixture.jobs);
    const progressSpy = vi.spyOn(fixture.jobs, 'submit').mockImplementation((kind, label, task, settled = null) =>
      submit(
        kind,
        label,
        async (context) =>
          task({
            ...context,
            update: (progress, message) => {
              updates.push(progress);
              context.update(progress, message);
            },
          }),
        settled,
      ),
    );
    const originalRun = nativeProcesses.runProcess;
    let activeAudioChildren = 0;
    let peakAudioChildren = 0;
    let peakFiles = 0;
    const audioInputs: number[] = [];
    const decoded: string[] = [];
    const intermediatePeaks: number[] = [];
    let mixed: Float32Array | null = null;
    const processSpy = vi
      .spyOn(nativeProcesses, 'runProcess')
      .mockImplementation(async (binary, args, options = {}) => {
        const output = args.at(-1)!;
        const audioPass =
          binary === config.ffmpeg && (output === 'music.wav' || /^music-accumulator-\d+\.wav$/.test(output));
        const inputs = args.flatMap((value, index) => (value === '-i' ? [args[index + 1]!] : []));
        if (audioPass) {
          activeAudioChildren++;
          peakAudioChildren = Math.max(peakAudioChildren, activeAudioChildren);
          audioInputs.push(inputs.length);
          if (output === 'music.wav') {
            expect(inputs).toHaveLength(1);
            decoded.push(inputs[0]!);
          } else
            expect(
              inputs.every((filename) => filename === 'music.wav' || filename.startsWith('music-accumulator-')),
            ).toBe(true);
          expect(args).not.toContain('adelay');
          const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
          expect(graph).not.toContain('clip(');
          if (inputs.length === 2)
            expect(graph).toContain('amix=inputs=2:duration=longest:dropout_transition=0:normalize=0');
        }
        if (binary === config.ffmpeg && output.endsWith('export.partial.mp4')) {
          expect(inputs).toHaveLength(2);
          expect(inputs[0]).toBe('chunks.ffconcat');
          expect(inputs[1]).toMatch(/^music-accumulator-/);
          expect(args[args.indexOf('-filter_complex') + 1]).toContain('clip(val(0),-1,1)|clip(val(1),-1,1)');
          mixed = await rawAudio(config, path.join(options.cwd!, inputs[1]!));
        }
        try {
          const result = await originalRun(binary, args, options);
          if (audioPass) {
            const filenames = readdirSync(options.cwd!).filter(
              (name) => name === 'music.wav' || name.startsWith('music-accumulator-'),
            );
            peakFiles = Math.max(peakFiles, filenames.length);
            expect(filenames.length).toBeLessThanOrEqual(3);
            if (output.startsWith('music-accumulator-')) {
              const samples = await rawAudio(config, path.join(options.cwd!, output));
              intermediatePeaks.push(samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0));
              const index = Number(/^music-accumulator-(\d+)\.wav$/.exec(output)![1]);
              assertPCM(
                await stereoPCM(config, path.join(options.cwd!, output)),
                expectedMusicPCM(
                  captured.slice(0, index + 1).map((track) => planExportMusic(track, 46)),
                  sourcePCM,
                ),
                `eight-instance accumulator ${index}`,
              );
            }
          }
          return result;
        } finally {
          if (audioPass) activeAudioChildren--;
        }
      });
    let result: Awaited<ReturnType<typeof completed>>;
    try {
      result = await completed(project);
    } finally {
      processSpy.mockRestore();
      progressSpy.mockRestore();
    }
    expect(peakAudioChildren).toBe(1);
    expect(peakFiles).toBe(3);
    expect(Math.max(...audioInputs)).toBe(2);
    expect(decoded).toEqual([
      positive.sourcePath,
      positive.sourcePath,
      positive.sourcePath,
      negative.sourcePath,
      negative.sourcePath,
      negative.sourcePath,
      audio.sourcePath,
      audio.sourcePath,
    ]);
    expect(intermediatePeaks[2]).toBeGreaterThan(5.9);
    expect(intermediatePeaks[5]).toBeLessThan(0.00001);
    expect(updates.every((value, index) => index === 0 || value >= updates[index - 1]!)).toBe(true);
    expect(project.music).toEqual(captured);
    expect(result.receipt.snapshot.music).toEqual(captured);
    expect(result.receipt.musicSources.map((source) => source.id)).toEqual([positive.id, negative.id, audio.id]);
    expect(result.receipt.settings.audio.map((plan) => plan.id)).toEqual(captured.map((track) => track.id));
    expect(result.receipt.settings.resources).toMatchObject({
      maxMusicTracks: 8,
      maxOriginalAudioDecoders: 1,
      maxIntermediateAudioInputs: 2,
      maxNativeAudioChildrenPerPass: 1,
      maxAudioScratchFiles: 3,
      audioAccumulatorBits: 64,
    });
    expect(result.receipt.timeline.duration).toBe(46);
    expect(result.receipt.settings.pipeline).toBe('sequential-layered');
    expect(result.receipt.settings.audio[7]).toMatchObject({
      sourceInSamples: 9610,
      sourceOutSamples: 19219,
      startSamples: 64064,
      durationSamples: 9610,
      fadeOutSamples: 3203,
      videoSamples: 73674,
    });
    const accumulated = mixed as unknown as Float32Array;
    expect(accumulated).toHaveLength(exportAudioSample(46));
    expect(accumulated[73673], 'non-looping source OUT pads the final unmatched sample').toBe(0);
    for (let sample = 0; sample < accumulated.length; sample++) {
      const frame = sample / ((48000 * 1001) / 30000);
      const expected = captured.slice(6).reduce((sum, track) => {
        const selectedStart = exportAudioSample(track.sourceIn);
        const selectedLength = exportAudioSample(track.sourceOut) - selectedStart;
        const offset = sample - exportAudioSample(track.start);
        const source =
          offset >= 0 && offset < exportAudioSample(track.duration) && (track.loop || offset < selectedLength)
            ? audioSamples[selectedStart + (offset % selectedLength)]!
            : 0;
        return sum + source * musicGainAt(track, frame);
      }, 0);
      expect(accumulated[sample], `unclipped mixed sample ${sample}`).toBeCloseTo(expected, 4);
    }
    const encoded = await rawAudio(config, result.filename);
    for (const frame of [1, 6, 9, 15, 24, 29, 33, 41, 44, 45]) {
      const first = exportAudioSample(frame) - 240;
      expect(Math.abs(rms(encoded, first, 480) - rms(accumulated, first, 480))).toBeLessThan(0.004);
    }
    for (const frame of [0, 18, 35, 36, 40, 45])
      assertPixels(project, frame, await extractComparisonFrame(config, result.filename, frame, 'tv'), originals);
    await forEachSerial(mixSources, async (source) =>
      expect(await fingerprintFile(source.sourcePath)).toEqual(source.fingerprint),
    );
    expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
  }, 120_000);

  it('clamps only the completed native sum before AAC, including positive and negative stereo overflow', async () => {
    const project = document(12);
    project.music = Array.from({ length: 2 }, (_, index) => ({
      id: `overflow-${index}`,
      mediaId: mixSources[1]!.id,
      sourceIn: 0,
      sourceOut: 12,
      start: 0,
      duration: 12,
      gainDb: 12,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    }));
    const originalRun = nativeProcesses.runProcess;
    let peak = 0;
    let clamped: Float32Array | null = null;
    const expectedPCM = expectedMusicPCM(
      project.music.map((track) => planExportMusic(track, 12)),
      sourcePCM,
    );
    const intermediateIndices: number[] = [];
    const processSpy = vi
      .spyOn(nativeProcesses, 'runProcess')
      .mockImplementation(async (binary, args, options = {}) => {
        if (binary === config.ffmpeg && args.at(-1)!.endsWith('export.partial.mp4')) {
          const mix = args[args.lastIndexOf('-i') + 1]!;
          const source = await rawAudio(config, path.join(options.cwd!, mix));
          assertPCM(await stereoPCM(config, path.join(options.cwd!, mix)), expectedPCM, 'overflow final accumulator');
          peak = source.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
          const graph = args[args.indexOf('-filter_complex') + 1]!;
          expect(graph).toContain('clip(val(0),-1,1)|clip(val(1),-1,1)');
          const bytes = await originalRun(
            binary,
            [
              '-v',
              'error',
              '-nostdin',
              '-i',
              mix,
              '-af',
              "aeval=exprs='clip(val(0),-1,1)|clip(val(1),-1,1)'",
              '-f',
              'f32le',
              'pipe:1',
            ],
            { cwd: options.cwd! },
          );
          clamped = floats(bytes);
          expect(clamped).toHaveLength(source.length * 2);
          for (let sample = 0; sample < source.length; sample++) {
            for (let channel = 0; channel < 2; channel++) {
              const index = sample * 2 + channel;
              const expected = Math.fround(Math.max(-1, Math.min(1, expectedPCM[index]!)));
              expect(clamped[index], `sole final clamp sample ${sample}, channel ${channel}`).toBe(expected);
            }
          }
        }
        const result = await originalRun(binary, args, options);
        const match = /^music-accumulator-(\d+)\.wav$/.exec(args.at(-1)!);
        if (binary === config.ffmpeg && match) {
          const index = Number(match[1]);
          assertPCM(
            await stereoPCM(config, path.join(options.cwd!, args.at(-1)!)),
            expectedMusicPCM(
              project.music.slice(0, index + 1).map((track) => planExportMusic(track, 12)),
              sourcePCM,
            ),
            `overflow accumulator ${index}`,
          );
          intermediateIndices.push(index);
        }
        return result;
      });
    let result: Awaited<ReturnType<typeof completed>>;
    try {
      result = await completed(project);
    } finally {
      processSpy.mockRestore();
    }
    expect(peak).toBeGreaterThan(3.9);
    expect(intermediateIndices).toEqual([0, 1]);
    const encoded = await rawAudio(config, result.filename);
    const expected = clamped as unknown as Float32Array;
    const firstChannel = Float32Array.from({ length: expected.length / 2 }, (_, index) => expected[index * 2]!);
    const reference = await referenceAAC(config, directory, expectedPCM, 12);
    const actualStereo = await stereoPCM(config, result.filename);
    assertPCM(actualStereo, reference, 'same-AAC independently reconstructed final clamp');
    const referenceChannel = Float32Array.from({ length: reference.length / 2 }, (_, index) => reference[index * 2]!);
    // Independently encoding this clipped anti-phase signal reproduces substantial
    // codec loss: PCM RMS parity is not an AAC contract. Keep the 0.004 gate
    // against the same-codec reference AND exact sample gates before encoding.
    expect(
      Math.abs(rms(referenceChannel, exportAudioSample(3), 2048) - rms(firstChannel, exportAudioSample(3), 2048)),
    ).toBeGreaterThan(0.05);
    for (const frame of [3, 6, 9])
      expect(
        Math.abs(rms(encoded, exportAudioSample(frame), 2048) - rms(referenceChannel, exportAudioSample(frame), 2048)),
      ).toBeLessThan(0.004);
  }, 120_000);

  it('fails a missing second original and cancels its active decode without changing originals, saved edits or successful outputs', async () => {
    const positive = mixSources[1]!;
    const negative = mixSources[2]!;
    const project = document(12);
    project.music = [positive, negative].map((source, index) => ({
      id: `cancel-${index}`,
      mediaId: source.id,
      sourceIn: 0,
      sourceOut: 12,
      start: 0,
      duration: 12,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    }));
    const successful = await readFile(path.join(successfulDirectory, 'export.mp4'));
    const failed = startExport(project, 'draft720', fixture.library, (id) =>
      id === positive.id ? positive : { ...negative, sourcePath: path.join(directory, 'missing-second.wav') },
    );
    const failure = await fixture.jobs.wait(failed.id);
    expect(failure.state).toBe('failed');
    expect(failure.outputUrl).toBeNull();
    expect(failure.receiptUrl).toBeNull();
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(failed.id);
    const originalRun = nativeProcesses.runProcess;
    let cancelled = false;
    let jobId = '';
    const processSpy = vi.spyOn(nativeProcesses, 'runProcess').mockImplementation((binary, args, options = {}) => {
      const pending = originalRun(binary, args, options);
      if (binary === config.ffmpeg && args.at(-1) === 'music.wav' && args.includes(negative.sourcePath)) {
        cancelled = true;
        fixture.jobs.cancel(jobId);
      }
      return pending;
    });
    try {
      const job = startExport(project, 'draft720', fixture.library, (id) => (id === positive.id ? positive : negative));
      jobId = job.id;
      const result = await fixture.jobs.wait(job.id);
      expect(result.state, result.message).toBe('cancelled');
      expect(cancelled).toBe(true);
      expect(result.outputUrl).toBeNull();
      expect(result.receiptUrl).toBeNull();
    } finally {
      processSpy.mockRestore();
    }
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(jobId);
    expect(await readFile(path.join(successfulDirectory, 'export.mp4'))).toEqual(successful);
    expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
    await forEachSerial(mixSources, async (source) =>
      expect(await fingerprintFile(source.sourcePath)).toEqual(source.fingerprint),
    );
  }, 120_000);

  it('cancels an active raw retimer, removes its entire job directory and preserves successful exports and saved edits', async () => {
    const originalSuccessful = await readFile(path.join(successfulDirectory, 'export.mp4'));
    const submit = fixture.jobs.submit.bind(fixture.jobs);
    let cancelled = false;
    const spy = vi.spyOn(fixture.jobs, 'submit').mockImplementation((kind, label, task, settled = null) =>
      submit(
        kind,
        label,
        async (context) =>
          task({
            ...context,
            update: (progress, message) => {
              context.update(progress, message);
              if (!cancelled && message.startsWith('Retiming original')) {
                cancelled = true;
                fixture.jobs.cancel(context.id);
              }
            },
          }),
        settled,
      ),
    );
    let id = '';
    try {
      const job = startExport(document(36), 'draft720', fixture.library);
      id = job.id;
      const result = await fixture.jobs.wait(id);
      expect(result.state, result.message).toBe('cancelled');
      expect(result.outputUrl).toBeNull();
      expect(result.receiptUrl).toBeNull();
      expect(cancelled).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(id);
    expect(await readFile(path.join(successfulDirectory, 'export.mp4'))).toEqual(originalSuccessful);
    expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
  });

  it('cleans failed encodes and refuses to overwrite or remove an existing UUID job directory', async () => {
    const goodBinary = fixture.library.config.ffmpeg;
    let failedId = '';
    try {
      fixture.library.config.ffmpeg = '/nonexistent-pascap-export-ffmpeg';
      const job = startExport(document(3), 'draft720', fixture.library);
      failedId = job.id;
      expect((await fixture.jobs.wait(job.id)).state).toBe('failed');
    } finally {
      fixture.library.config.ffmpeg = goodBinary;
    }
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(failedId);
    const id = path.basename(successfulDirectory);
    const before = await readFile(path.join(successfulDirectory, 'receipt.json'));
    await expect(
      renderExport(document(3), 'draft720', fixture.library, {
        id,
        signal: new AbortController().signal,
        update: () => {},
      }),
    ).rejects.toThrow('EEXIST');
    expect(await readFile(path.join(successfulDirectory, 'receipt.json'))).toEqual(before);
    const badAudioJob = startExport(
      {
        ...document(3),
        music: [
          {
            id: 'invalid-music-instance',
            mediaId: audio.id,
            sourceIn: 0,
            sourceOut: 100,
            start: 0,
            duration: 3,
            gainDb: 0,
            fadeIn: 0,
            fadeOut: 0,
            loop: false,
          },
        ],
      },
      'draft720',
      fixture.library,
      () => audio,
    );
    const badAudio = await fixture.jobs.wait(badAudioJob.id);
    expect(badAudio.state).toBe('failed');
    expect(badAudio.message).toContain('source bounds');
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(badAudioJob.id);
    // Direct cancellation before directory creation cannot leave orphan scratch.
    const controller = new AbortController();
    controller.abort();
    const cancelledId = randomUUID();
    await expect(
      renderExport(document(3), 'draft720', fixture.library, {
        id: cancelledId,
        signal: controller.signal,
        update: () => {},
      }),
    ).rejects.toThrow('cancelled');
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(cancelledId);
  });
});
