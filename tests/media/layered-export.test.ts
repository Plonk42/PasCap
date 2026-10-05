import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { renderExport, startExport, type ExportReceipt } from '../../src/server/export.js';
import { fingerprintFile } from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { renderLayeredExport } from '../../src/server/layered-export.js';
import { MediaLibrary } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';
import { renderReference, validateReference } from '../../src/server/reference.js';
import { ProjectStore } from '../../src/server/storage.js';
import { audioAssetSchema, type AudioAsset } from '../../src/shared/audio.js';
import { COLOUR_CONTROLS, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { compositePixel } from '../../src/shared/composition.js';
import { EXPORT_PROFILES, LAYERED_EXPORT_RESOURCES, needsLayeredExport, planExport, planLayeredExport } from '../../src/shared/export.js';
import { estimateExportSpace } from '../../src/shared/export-space.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS, evaluateLayerSetting, hasLayerKeys, type Interpolation, type LayerKeyframe, type LayerKeyValues } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument, type VideoLayer } from '../../src/shared/model.js';
import { compileRetiming } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline, type PreviewLayer, type TimelineLayout } from '../../src/shared/timeline.js';
import { framesToSeconds } from '../../src/shared/timing.js';
import { observedJobBytes } from './scratch-observation.js';

// Observe actual native children; do not stub decoding, pipe backpressure or exits.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const WIDTH = 160; const HEIGHT = 90; const PIXELS = WIDTH * HEIGHT; const FRAME_BYTES = PIXELS * 3;
// Existing positioned fixtures must keep their independent starts and widths.
function layer(id: string, opacity = 1): VideoLayer { return { ...createLayer(id, id, false), opacity }; }
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}

async function rawRgb(config: ServiceConfig, filename: string, range = 'tv'): Promise<Buffer> {
  return runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-i', filename,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2', '-vf',
    `scale=${WIDTH}:${HEIGHT}:flags=area:in_color_matrix=bt709:out_color_matrix=bt709:in_range=${range}:out_range=pc,format=rgb24`,
    '-threads', '2', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
}

function pixelError(project: ProjectDocument, frame: number, actual: Uint8Array, originals: Map<string, Buffer>, layout: TimelineLayout): number {
  const samples = sampleTimeline(project, frame, layout);
  let error = 0;
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const expected = compositePixel(samples, (sample) => {
      const bytes = originals.get(sample.mediaId)!;
      const offset = sample.sourceFrame * FRAME_BYTES + pixel * 3;
      return [bytes[offset]! / 255, bytes[offset + 1]! / 255, bytes[offset + 2]! / 255];
    });
    for (let channel = 0; channel < 3; channel++) error += Math.abs(actual[pixel * 3 + channel]! - expected[channel]! * 255);
  }
  return error / FRAME_BYTES;
}

function coverage(samples: PreviewLayer[]): number {
  let result = 0;
  for (const id of new Set(samples.map((sample) => sample.layerId))) {
    const group = samples.filter((sample) => sample.layerId === id);
    const alpha = group.reduce((sum, sample) => sum + sample.opacity * sample.blendWeight, 0) * group[0]!.layerOpacity;
    result = alpha + result * (1 - alpha);
  }
  return result;
}

describe.skipIf(!enabled)('schema-6 layered native export · disposable synthetic sources only', () => {
  let root: string;
  let config: ServiceConfig;
  let jobs: JobQueue;
  let library: MediaLibrary;
  let assets: MediaAsset[];
  let originals: Map<string, Buffer>;
  let originalBytes: Buffer[];
  let music: AudioAsset;
  let savedPath: string;
  let savedBytes: Buffer;
  let successfulDirectory = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pascap-layered-media-'));
    const sources = path.join(root, 'sources'); await mkdir(sources);
    config = createConfig({ dataDir: path.join(root, 'cache') });
    jobs = new JobQueue(); library = new MediaLibrary(config, jobs); await library.initialise();
    assets = [];
    for (let index = 0; index < 3; index++) {
      const filename = path.join(sources, `pattern-${index}.mp4`);
      // Four broad patches and large per-frame steps reveal wrong source sampling.
      // Native tags are attached to lavfi frames as well as to the encoder.
      await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
        `nullsrc=size=${WIDTH}x${HEIGHT}:rate=30000/1001,geq=lum='45+7*N+12*gte(X,80)+7*gte(Y,45)':cb='${100 + index * 12}+N+8*lt(X,80)':cr='${165 - index * 12}-2*N-7*gte(Y,45)',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
        '-frames:v', '20', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-threads', '2',
        '-filter_threads', '2', '-bf', '0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
        '-video_track_timescale', '30000', filename]);
      assets.push(await library.register(filename));
    }
    originals = new Map(await Promise.all(assets.map(async (asset) => [asset.id, await rawRgb(config, asset.sourcePath)] as const)));
    originalBytes = await Promise.all(assets.map((asset) => readFile(asset.sourcePath)));
    const store = new ProjectStore(config.dataDir);
    const saved = createProject('saved-edits', 'User edits remain read-only');
    saved.clips = [createClip('saved-instance', assets[0]!.id, 2, 8)];
    const persisted = await store.save(saved, 0);
    savedPath = path.join(config.dataDir, 'projects', `${persisted.id}.json`); savedBytes = await readFile(savedPath);
    const musicPath = path.join(sources, 'short-selected-music.wav');
    await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
      `sine=frequency=880:sample_rate=48000:duration=${framesToSeconds(20)}`, '-threads', '2', '-c:a', 'pcm_s16le', musicPath]);
    music = audioAssetSchema.parse({
      id: 'layered-music', name: 'short-selected-music.wav', sourcePath: musicPath,
      fingerprint: await fingerprintFile(musicPath), metadata: {
        codec: 'pcm_s16le', sampleRate: 48000, channels: 1,
        durationSeconds: framesToSeconds(20), frameCount: 20
      }, status: 'registered', error: null, waveform: []
    });
  });
  afterAll(async () => { vi.restoreAllMocks(); await jobs?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  function simple(frames = 4): ProjectDocument {
    const project = createProject('native-layered', 'Disposable layered export');
    project.layers.push(layer('video-2', 0.6));
    project.clips = [createClip('base', assets[0]!.id, 0, frames),
    { ...createClip('overlay', assets[1]!.id, 8, 10), layerId: 'video-2', start: 1, opacity: 0.5 }];
    return projectSchema.parse(project);
  }
  async function complete(project: ProjectDocument, profile: 'draft720' | 'final4k' = 'draft720') {
    const job = startExport(project, profile, library, (id) => { expect(id).toBe(music.id); return music; });
    const result = await jobs.wait(job.id);
    expect(result.state, result.message).toBe('completed');
    const directory = path.join(config.dataDir, 'renders', job.id);
    expect((await readdir(directory)).sort()).toEqual(['export.mp4', 'receipt.json']);
    const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8')) as ExportReceipt;
    expect(receipt.snapshot).toEqual(project); expect(receipt.verification.frameCount).toBe(calculateLayout(project).duration);
    expect(receipt.verification).toMatchObject({
      width: EXPORT_PROFILES[profile].width, height: EXPORT_PROFILES[profile].height,
      codec: 'h264', pixelFormat: 'yuv420p', colourRange: 'tv', fullDecode: true, faststart: true
    });
    return { directory, filename: path.join(directory, 'export.mp4'), receipt };
  }
  async function parity(project: ProjectDocument, filename: string): Promise<number> {
    const actual = await rawRgb(config, filename); const layout = calculateLayout(project); const duration = layout.duration;
    expect(actual).toHaveLength(duration * FRAME_BYTES);
    let maximum = 0;
    for (let frame = 0; frame < duration; frame++) {
      const mae = pixelError(project, frame, actual.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES), originals, layout);
      expect(mae, `frame ${frame}: shared compositePixel RGB MAE ${mae} / 255`).toBeLessThan(4);
      maximum = Math.max(maximum, mae);
    }
    return maximum;
  }
  function bounds(receipt: ExportReceipt): void {
    expect(receipt.settings.pipeline).toBe('sequential-layered');
    expect(receipt.settings.resources).toEqual(LAYERED_EXPORT_RESOURCES);
    const report = receipt.settings.layered!;
    expect(report.peakOriginalVideoDecoders).toBeLessThanOrEqual(1);
    expect(report.peakIntermediateVideoDecoders).toBeLessThanOrEqual(2);
    expect(report.peakVideoEncoders).toBe(1);
    expect(report.peakNativeVideoChildren).toBeLessThanOrEqual(3);
    expect(report.peakLosslessClipFiles).toBeLessThanOrEqual(2);
    expect(report.peakLosslessTimelineRepresentations).toBeLessThanOrEqual(3);
    expect(report.rawFrameBuffers).toBe(4);
    expect(report.rawBufferBytes).toBe(receipt.verification.width * receipt.verification.height * 22);
    expect(report.peakLutEntries).toBeLessThanOrEqual(2);
    expect(report.lutBytes).toBeLessThanOrEqual(LAYERED_EXPORT_RESOURCES.lutBytes * 2);
    expect(report.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
    const groups = receipt.snapshot.layers.filter((row) => row.enabled && receipt.snapshot.clips.some((clip) => clip.layerId === row.id)).length;
    expect(report.layerPasses).toBe(groups);
    expect(report.sourceOverPasses).toBe(Math.max(0, groups - 1));
    expect(LAYERED_EXPORT_RESOURCES).toMatchObject({
      maxOriginalVideoDecoders: 1, maxIntermediateVideoDecoders: 2, maxVideoEncoders: 1,
      maxNativeVideoChildrenPerPass: 3, maxLosslessClipsOnDisk: 2, maxLosslessTimelineRepresentations: 3,
      rawFrameBuffers: 4, rawBytesPerPixel: 22, maxInMemoryLuts: 2, lutBytes: 3_295_500,
    });
    const layout = calculateLayout(receipt.snapshot);
    expect(report.renderedClipIds).toEqual(layout.clips.filter((placed) => receipt.snapshot.layers.find((row) => row.id === placed.clip.layerId)!.enabled).map((placed) => placed.clip.id));
    expect(receipt.retiming).toHaveLength(report.renderedClipIds.length);
    expect(report.compositeFrames).toBe(layout.duration * Math.max(1, 2 * groups - 1));
    for (const [index, report] of receipt.retiming.entries()) {
      const placed = layout.clips.find((item) => item.clip.id === receipt.settings.layered!.renderedClipIds[index])!;
      const clip = placed.clip;
      expect(report.decodedFrames).toBe(clip.sourceOut - clip.sourceIn);
      expect(report.outputFrames).toBe(placed.retiming.duration);
      expect(report.rawFrameBuffers).toBe(1);
    }
  }
  async function unchanged(): Promise<void> {
    expect(await readFile(savedPath)).toEqual(savedBytes);
    for (const [index, asset] of assets.entries()) {
      expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint);
      expect(await readFile(asset.sourcePath)).toEqual(originalBytes[index]);
    }
  }

  function concurrentTracks(count: 2 | 3): ProjectDocument {
    const project = createProject(`concurrent-${count}`, 'Synthetic independent track dissolves');
    const packed = { ...createLayer('packed-track', 'Ripple track', true), opacity: 0.75, openingFade: 1, closingFade: 1 };
    packed.keyframes = [
      point(2, { speed: 0.5, layerOpacity: 0.75, clipOpacity: 0.35, exposure: -0.3, brightness: 0.015, hue: -20, shadows: 0.2 }),
      point(6, { speed: 1.5, layerOpacity: 0.45, clipOpacity: 0.85, exposure: 0.25, brightness: 0.06, hue: 20, shadows: -0.1 }, 'smooth'),
      point(14, { speed: 0.75, layerOpacity: 0.7, clipOpacity: 0.55, exposure: -0.1, brightness: 0.025, hue: -5, shadows: 0.1 }, 'hold'),
    ];
    const packedLeft = { ...createClip('packed-left', assets[0]!.id, 2, 8, packed.id), start: 2, opacity: 0.6 };
    const packedRight = { ...createClip('packed-right', assets[1]!.id, 8, 14, packed.id), opacity: 0.4 };
    packedLeft.speed = { mode: 'constant', rate: 4 }; packedRight.speed = { mode: 'constant', rate: 4 };
    packedLeft.colour = { ...NEUTRAL_COLOUR, contrast: 0.9, saturation: 0.8, highlights: -0.2 };
    packedRight.colour = { ...NEUTRAL_COLOUR, contrast: 1.2, saturation: 1.1, highlights: 0.15 };
    packed.transitions = [{ leftId: packedLeft.id, rightId: packedRight.id, type: 'cross-dissolve', duration: 2 }];
    project.layers = [packed]; project.clips = [packedLeft, packedRight];
    const overlap = calculateLayout(project).transitions[0]!;
    packedRight.start = overlap.start;

    const positioned = { ...createLayer('positioned-track', 'Independent track', false), opacity: 0.65, openingFade: 1, closingFade: 1 };
    positioned.keyframes = [point(2, { exposure: -0.2, hue: 25, layerOpacity: 0.3 }, 'ease-in'),
      point(9, { exposure: 0.3, hue: -20, layerOpacity: 0.8 }, 'hold')];
    const positionedLeft = { ...createClip('positioned-left', assets[1]!.id, 1, 5, positioned.id), start: overlap.end - 4, opacity: 0.4 };
    const positionedRight = { ...createClip('positioned-right', assets[0]!.id, 11, 15, positioned.id), start: overlap.start, opacity: 0.75 };
    positionedLeft.colour = { ...NEUTRAL_COLOUR, brightness: 0.025, contrast: 1.1, saturation: 0.7, shadows: 0.2 };
    positionedRight.colour = { ...NEUTRAL_COLOUR, brightness: 0.05, contrast: 0.9, saturation: 1.2, highlights: -0.2 };
    const afterGap = { ...createClip('after-gap', assets[1]!.id, 17, 19, positioned.id), start: positionedRight.start + 6, opacity: 0.6 };
    afterGap.colour = { ...NEUTRAL_COLOUR, brightness: 0.035, saturation: 0.85, shadows: 0.1 };
    positioned.transitions = [{ leftId: positionedLeft.id, rightId: positionedRight.id, type: 'cross-dissolve', duration: 2 },
      { leftId: positionedRight.id, rightId: afterGap.id, type: 'cut', duration: 0 }];

    const third = { ...createLayer('third-track', 'Another Ripple track', true), opacity: 0.7, openingFade: 1, closingFade: 1 };
    third.keyframes = [point(3, { clipOpacity: 0.2, brightness: 0.015 }), point(9, { clipOpacity: 0.75, brightness: 0.07 }, 'hold')];
    const thirdLeft = { ...createClip('third-left', assets[0]!.id, 4, 8, third.id), start: positionedLeft.start, opacity: 0.55 };
    const thirdRight = { ...createClip('third-right', assets[1]!.id, 12, 16, third.id), start: overlap.start, opacity: 0.8 };
    thirdLeft.colour = { ...NEUTRAL_COLOUR, exposure: -0.2, hue: -15, saturation: 1.1 };
    thirdRight.colour = { ...NEUTRAL_COLOUR, exposure: 0.15, hue: 30, saturation: 0.8 };
    third.transitions = [{ leftId: thirdLeft.id, rightId: thirdRight.id, type: 'cross-dissolve', duration: 2 }];
    const empty = { ...createLayer('empty-track', 'Dormant timing', false), openingFade: 7, closingFade: 9 };
    const hidden = { ...createLayer('hidden-track', 'Hidden tail', false), enabled: false };
    // Exercise a positioned first track as well as a different arbitrary stack.
    project.layers = count === 2 ? [positioned, packed, empty, hidden] : [packed, third, positioned, empty, hidden];
    project.clips = [positionedRight, packedLeft, ...(count === 3 ? [thirdLeft] : []), afterGap,
      packedRight, positionedLeft, ...(count === 3 ? [thirdRight] : [])];
    project.clips.push({ ...createClip('hidden-tail', assets[2]!.id, 17, 19, hidden.id), start: calculateLayout(project).duration + 2 });
    return projectSchema.parse(project);
  }

  function assertSharedSamples(project: ProjectDocument): void {
    const layout = calculateLayout(project);
    for (let frame = 0; frame < layout.duration; frame++) {
      for (const sample of sampleTimeline(project, frame, layout)) {
        const placed = layout.clips.find((item) => item.clip.id === sample.clipId)!;
        const row = project.layers.find((item) => item.id === sample.layerId)!;
        expect(sample.sourceFrame).toBe(placed.retiming.sourceAt(frame - placed.start));
        expect(Number.isSafeInteger(sample.sourceFrame)).toBe(true);
        expect(sample.sourceFrame).toBeGreaterThanOrEqual(placed.clip.sourceIn);
        expect(sample.sourceFrame).toBeLessThan(placed.clip.sourceOut);
        expect(sample.opacity).toBe(evaluateLayerSetting(row, 'clipOpacity', frame, placed.clip.opacity));
        expect(sample.layerOpacity).toBe(evaluateLayerSetting(row, 'layerOpacity', frame, row.opacity));
        for (const { key } of COLOUR_CONTROLS) expect(sample.colour[key]).toBe(evaluateLayerSetting(row, key, frame, placed.clip.colour[key]));
        if (hasLayerKeys(row, 'speed')) expect(placed.retiming.rateAt(frame - placed.start)).toBeCloseTo(evaluateLayerSetting(row, 'speed', frame, 1));
      }
    }
  }

  function expectedLutGenerations(project: ProjectDocument): number {
    const layout = calculateLayout(project); const keys: string[] = []; let generated = 0;
    // Grades are requested only while independently rendering each group, in
    // chronological source order. RGBA16 source-over must request no further LUT.
    for (const row of project.layers.filter((row) => row.enabled)) {
      for (let frame = 0; frame < layout.duration; frame++) {
        const samples = sampleTimeline(project, frame, layout).filter((sample) => sample.layerId === row.id);
        if (coverage(samples) === 0) continue;
        for (const sample of samples) {
          const key = JSON.stringify(sample.colour); const previous = keys.indexOf(key);
          if (previous >= 0) keys.splice(previous, 1);
          else { generated++; if (keys.length === 2) keys.shift(); }
          keys.push(key);
        }
      }
    }
    return generated;
  }

  async function losslessParity(project: ProjectDocument, filename: string): Promise<number> {
    const bytes = await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-i', filename,
      '-map', '0:v:0', '-an', '-filter_threads', '2', '-threads', '2', '-pix_fmt', 'rgba64le', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
    const actual = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2); const layout = calculateLayout(project);
    expect(bytes).toHaveLength(layout.duration * PIXELS * 8);
    let maximum = 0;
    for (let frame = 0; frame < layout.duration; frame++) {
      const samples = sampleTimeline(project, frame, layout); const expectedAlpha = coverage(samples); let error = 0;
      for (let pixel = 0; pixel < PIXELS; pixel++) {
        const expected = compositePixel(samples, (sample) => {
          const original = originals.get(sample.mediaId)!; const offset = sample.sourceFrame * FRAME_BYTES + pixel * 3;
          return [original[offset]! / 255, original[offset + 1]! / 255, original[offset + 2]! / 255];
        });
        const offset = (frame * PIXELS + pixel) * 4;
        for (let channel = 0; channel < 3; channel++) error += Math.abs(actual[offset + channel]! / 65535 - expected[channel]!) * 255;
        expect(Math.abs(actual[offset + 3]! - Math.round(expectedAlpha * 65535))).toBeLessThanOrEqual(2);
        if (!samples.length) expect(Array.from(actual.subarray(offset, offset + 4))).toEqual([0, 0, 0, 0]);
      }
      const mae = error / FRAME_BYTES;
      expect(mae, `Lossless shared track-group RGB frame ${frame}`).toBeLessThan(1);
      maximum = Math.max(maximum, mae);
    }
    return maximum;
  }

  async function exactPackets(filename: string, duration: number): Promise<void> {
    const bytes = await runProcess(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_entries', 'packet=pts,dts,duration', '-of', 'json', filename]);
    const packets = (JSON.parse(bytes.toString('utf8')) as { packets: { pts: number; dts: number; duration: number }[] }).packets;
    expect(packets).toHaveLength(duration);
    for (const [frame, packet] of packets.entries()) expect(packet).toEqual({ pts: frame * 1001, dts: frame * 1001, duration: 1001 });
  }

  it.each([2, 3] as const)('renders %i simultaneous arbitrary-track dissolves with independent Ripple, source maps, grades and transparent holds', async (count) => {
    const project = concurrentTracks(count); const captured = structuredClone(project); const layout = calculateLayout(project);
    const active = project.layers.filter((row) => row.enabled && layout.clips.some((placed) => placed.clip.layerId === row.id));
    const overlap = layout.transitions.find((item) => item.layerId === 'packed-track')!;
    expect(project.layers.map((row) => row.ripple)).toContain(false); expect(project.layers.map((row) => row.ripple)).toContain(true);
    expect(project.layers.some((row) => row.id === 'video-1')).toBe(false);
    expect(active).toHaveLength(count);
    expect(layout.clips.find((placed) => placed.clip.id === 'packed-left')!.start).toBe(2);
    expect(layout.clips.find((placed) => placed.clip.id === 'positioned-left')!.start).toBe(project.clips.find((clip) => clip.id === 'positioned-left')!.start);
    const gapLeft = layout.clips.find((placed) => placed.clip.id === 'positioned-right')!;
    const gapRight = layout.clips.find((placed) => placed.clip.id === 'after-gap')!;
    expect(gapRight.start - gapLeft.end).toBe(2);
    expect(layout.duration).toBe(layout.clips.find((placed) => placed.clip.id === 'hidden-tail')!.end);
    for (const row of active) {
      const transition = layout.transitions.find((item) => item.layerId === row.id && item.transition.type === 'cross-dissolve')!;
      expect([transition.start, transition.end]).toEqual([overlap.start, overlap.end]);
      const clips = layout.clips.filter((placed) => placed.clip.layerId === row.id);
      for (const frame of [clips[0]!.start, clips.at(-1)!.end - 1]) {
        const group = sampleTimeline(project, frame, layout).filter((sample) => sample.layerId === row.id);
        expect(group).toHaveLength(1); expect(group[0]!.brightness).toBe(0);
        expect(group[0]!.blendWeight).toBe(1); expect(coverage(group)).toBeGreaterThan(0);
      }
      for (let frame = overlap.start; frame < overlap.end; frame++) {
        const group = sampleTimeline(project, frame, layout).filter((sample) => sample.layerId === row.id);
        expect(group).toHaveLength(2);
        expect(group.map((sample) => sample.clipId)).toEqual([transition.transition.leftId, transition.transition.rightId]);
        expect(group.map((sample) => sample.blendWeight)).toEqual([1 - (frame - overlap.start) / 2, (frame - overlap.start) / 2]);
      }
    }
    expect(sampleTimeline(project, overlap.start + 1, layout)).toHaveLength(count * 2);
    for (const placed of layout.clips.filter((placed) => placed.clip.layerId === 'packed-track')) expect(placed.duration).not.toBe(compileRetiming(placed.clip).duration);
    assertSharedSamples(project);
    const plan = planLayeredExport(project);
    expect(plan).not.toHaveProperty('primary'); expect(plan).not.toHaveProperty('baseDuration');
    expect(plan.layers.map((row) => row.id)).toEqual(project.layers.map((row) => row.id));
    for (const row of plan.layers) {
      expect(row.plan.duration).toBe(layout.clips.filter((placed) => placed.clip.layerId === row.id).at(-1)?.end ?? 0);
      expect(row.plan.clips.map((clip) => clip.clipId)).toEqual(row.clips.map((clip) => clip.clipId));
      for (const chunk of row.plan.chunks.filter((chunk) => chunk.kind === 'dissolve')) {
        expect(chunk.start).toBe(overlap.start); expect(chunk.duration).toBe(2);
        expect(project.clips[chunk.leftIndex]!.layerId).toBe(row.id); expect(project.clips[chunk.rightIndex]!.layerId).toBe(row.id);
      }
    }
    const work = await mkdtemp(path.join(root, 'concurrent-lossless-'));
    try {
      const result = await renderLayeredExport({ document: project, plan, assets: project.clips.map((clip) => library.get(clip.mediaId)),
        ffmpeg: config.ffmpeg, directory: work, target: { ...EXPORT_PROFILES.draft720, width: WIDTH, height: HEIGHT },
        context: { id: randomUUID(), signal: new AbortController().signal, update: () => {} } });
      expect(await readdir(work)).toEqual([result.filename]);
      expect(result.report).toMatchObject({ layerPasses: count, sourceOverPasses: count - 1,
        peakOriginalVideoDecoders: 1, peakIntermediateVideoDecoders: 2, peakVideoEncoders: 1, peakNativeVideoChildren: 3,
        peakLosslessClipFiles: 2, peakLosslessTimelineRepresentations: 3, rawFrameBuffers: 4, rawBufferBytes: PIXELS * 22,
        peakLutEntries: 2, lutBytes: 6_591_000, lutsGenerated: expectedLutGenerations(project),
        compositeFrames: layout.duration * (2 * count - 1), compositePixels: layout.duration * (2 * count - 1) * PIXELS,
      });
      expect(result.report.renderedClipIds).toEqual(layout.clips.filter((placed) => active.some((row) => row.id === placed.clip.layerId)).map((placed) => placed.clip.id));
      expect(result.report.skippedLayerIds).toEqual(['hidden-track']);
      expect(result.retiming).toHaveLength(count * 2 + 1);
      for (const [index, report] of result.retiming.entries()) {
        const placed = layout.clips.find((placed) => placed.clip.id === result.report.renderedClipIds[index])!;
        expect(report).toMatchObject({ decodedFrames: placed.clip.sourceOut - placed.clip.sourceIn,
          outputFrames: placed.duration, rawFrameBuffers: 1, frameBytes: FRAME_BYTES });
        expect(report.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
      }
      await losslessParity(project, path.join(work, result.filename));
    } finally { await rm(work, { recursive: true, force: true }); }
    const result = await complete(project); bounds(result.receipt); await parity(project, result.filename);
    await exactPackets(result.filename, layout.duration);
    expect(result.receipt.settings.layered!.lutsGenerated).toBe(expectedLutGenerations(project));
    expect(result.receipt.settings.layered!.compositeFrames).toBe(layout.duration * (2 * count - 1));
    expect(result.receipt.sources.map((source) => source.id).sort()).toEqual(assets.map((asset) => asset.id).sort());
    expect(result.receipt.verification.hasAudio).toBe(false);
    const pixels = await rawRgb(config, result.filename);
    const tail = layout.clips.filter((placed) => active.some((row) => row.id === placed.clip.layerId)).reduce((end, placed) => Math.max(end, placed.end), 0);
    for (const frame of [0, 1, gapLeft.end, gapLeft.end + 1, ...Array.from({ length: layout.duration - tail }, (_, index) => tail + index)]) {
      expect(sampleTimeline(project, frame, layout)).toHaveLength(0);
      const bytes = pixels.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES);
      expect(bytes.reduce((sum, value) => sum + value, 0) / FRAME_BYTES).toBeLessThan(1);
    }
    expect(project).toEqual(captured); await unchanged();
  }, 120_000);

  it('exports shared row speed/opacity and seven independently participating colour channels across dissolves, gaps and hidden black holds', async () => {
    const project = createProject('native-compound', 'Compound keyed layers');
    project.layers.push(layer('video-2', 0.85), layer('video-3', 0.55), { ...layer('video-4'), enabled: false });
    project.layers[0]!.keyframes = [
      point(0, { layerOpacity: 0.8, clipOpacity: 0.3, speed: 0.75, exposure: -0.5, hue: -25, saturation: 0.7, highlights: 0.1, shadows: 0.2 }, 'smooth'),
      point(4, { brightness: 0.02, contrast: 1.1 }, 'ease-in'),
      point(8, { layerOpacity: 0.45, clipOpacity: 0.8, speed: 1.5, exposure: 0.4, hue: 30, saturation: 1.2, highlights: -0.35 }, 'ease-out'),
      point(12, { clipOpacity: 0.4, brightness: 0.06, contrast: 1.25, shadows: -0.1 }),
      point(18, { layerOpacity: 0.9, speed: 0.6, shadows: 0.15, highlights: 0.2 }, 'hold'),
    ];
    project.layers[1]!.keyframes = [
      point(0, { layerOpacity: 0.25, clipOpacity: 0.2, speed: 0.7, hue: 40, highlights: -0.3 }, 'ease-in'),
      point(6, { clipOpacity: 0.85, exposure: 0.2, shadows: 0.15 }, 'smooth'),
      point(10, { layerOpacity: 0.8, speed: 2, hue: -35, exposure: 0.4, highlights: -0.1 }, 'smooth'),
      point(24, { layerOpacity: 0.45, speed: 0.8, clipOpacity: 0.45, hue: 15, shadows: -0.2 }, 'hold'),
    ];
    project.layers[2]!.keyframes = [
      point(0, { brightness: 0.08, hue: -15 }, 'ease-out'),
      point(12, { exposure: -0.2, shadows: 0.4, saturation: 1.3, brightness: -0.02, hue: 40 }, 'hold'),
    ];
    for (const { key } of COLOUR_CONTROLS) {
      expect(hasLayerKeys(project.layers[0]!, key)).toBe(true);
      expect(project.layers[0]!.keyframes.filter((keyframe) => keyframe.values[key] !== null).length).toBeGreaterThanOrEqual(2);
    }
    const left = createClip('left', assets[0]!.id, 2, 10);
    const right = createClip('right', assets[1]!.id, 3, 11);
    left.speed = { mode: 'constant', rate: 0.5 }; right.speed = { mode: 'constant', rate: 2 };
    for (const [index, clip] of [left, right].entries()) {
      clip.opacity = 0.7;
      clip.colour = { ...NEUTRAL_COLOUR, exposure: index * 0.2, brightness: index * 0.015, shadows: 0.05 };
    }
    project.clips = [left, right]; project.layers[0]!.transitions = [{ leftId: left.id, rightId: right.id, type: 'cross-dissolve', duration: 2 }];
    project.layers[0]!.openingFade = 1; project.layers[0]!.closingFade = 1;
    const baseEnd = calculateLayout(project).duration;
    const early = { ...createClip('early-overlay', assets[0]!.id, 1, 6), layerId: 'video-2', start: 2, opacity: 0.6 };
    const late = { ...createClip('late-overlay', assets[1]!.id, 9, 13), layerId: 'video-2', start: baseEnd + 2, opacity: 0.7 };
    late.speed = { mode: 'constant', rate: 1.25 }; late.colour = { ...NEUTRAL_COLOUR, exposure: 0.25, saturation: 0.6 };
    const top = { ...createClip('top-overlay', assets[0]!.id, 4, 9), layerId: 'video-3', start: 4, opacity: 0.45 };
    project.clips = [late, left, top, early, right]; // Flat indices deliberately differ from track/chronological order.
    project.layers[1]!.transitions = [{ leftId: early.id, rightId: late.id, type: 'cut', duration: 0 }];
    const hiddenStart = calculateLayout(project).clips.find((placed) => placed.clip.id === late.id)!.end + 2;
    const hidden = { ...createClip('hidden-only-source', assets[2]!.id, 17, 19), layerId: 'video-4', start: hiddenStart };
    project.clips.push(hidden);
    const layout = calculateLayout(project);
    const earlyPlaced = layout.clips.find((placed) => placed.clip.id === early.id)!;
    expect(late.start).toBeGreaterThan(earlyPlaced.end);
    for (let frame = 0; frame < layout.duration; frame++) {
      for (const sample of sampleTimeline(project, frame, layout)) {
        const placed = layout.clips.find((placed) => placed.clip.id === sample.clipId)!;
        const row = project.layers.find((row) => row.id === sample.layerId)!;
        expect(sample.sourceFrame).toBe(placed.retiming.sourceAt(frame - placed.start));
        for (const { key } of COLOUR_CONTROLS) expect(sample.colour[key]).toBe(evaluateLayerSetting(row, key, frame, placed.clip.colour[key]));
        if (hasLayerKeys(row, 'speed')) expect(placed.retiming.rateAt(frame - placed.start)).toBeCloseTo(evaluateLayerSetting(row, 'speed', frame, 1));
      }
    }
    const updates: number[] = []; let peakObservedClipFiles = 0; let sawLutFile = false;
    const diskSamples: number[] = [];
    const submit = jobs.submit.bind(jobs);
    const spy = vi.spyOn(jobs, 'submit').mockImplementation((kind, label, task, settled = null) => submit(kind, label, async (context) => task({
      ...context, update: (progress, message) => {
        updates.push(progress); context.update(progress, message);
        diskSamples.push(observedJobBytes(path.join(config.dataDir, 'renders', context.id)));
        const work = path.join(config.dataDir, 'renders', context.id, 'work');
        try {
          const names = readdirSync(work); peakObservedClipFiles = Math.max(peakObservedClipFiles, names.filter((name) => /^clip-\d+\.nut$/.test(name)).length);
          sawLutFile ||= names.some((name) => name.endsWith('.cube'));
        } catch { /* Work has been removed before successful publication. */ }
      },
    }), settled));
    let result: Awaited<ReturnType<typeof complete>>;
    try { result = await complete(project); } finally { spy.mockRestore(); }
    successfulDirectory = result.directory; bounds(result.receipt);
    expect(Math.max(...diskSamples)).toBeGreaterThan(0);
    console.log(`Native scratch observation (layered 720p): maximum ${Math.max(...diskSamples)} allocated file bytes at ${diskSamples.length} progress points; planning allowance ${estimateExportSpace(project, 'draft720').totalBytes} bytes. Directory metadata and between-sample peaks are not measured.`);
    const maximumMae = await parity(project, result.filename);
    expect(result.receipt.settings.layered!.renderedClipIds).toEqual(['left', 'right', 'early-overlay', 'late-overlay', 'top-overlay']);
    expect(result.receipt.settings.layered!.skippedLayerIds).toEqual(['video-4']);
    expect(result.receipt.sources.map((source) => source.id).sort()).toEqual(assets.map((asset) => asset.id).sort());
    expect(result.receipt.settings.layered!.peakIntermediateVideoDecoders).toBe(2);
    expect(result.receipt.settings.layered!.peakLosslessTimelineRepresentations).toBe(3);
    expect(result.receipt.settings.layered!.peakLosslessClipFiles).toBe(2);
    expect(peakObservedClipFiles).toBeLessThanOrEqual(2); expect(sawLutFile).toBe(false);
    expect(updates.every((value, index) => index === 0 || value >= updates[index - 1]!)).toBe(true);
    const pixels = await rawRgb(config, result.filename);
    for (let frame = hiddenStart - 2; frame < result.receipt.verification.frameCount; frame++) {
      expect(sampleTimeline(project, frame)).toHaveLength(0);
      const bytes = pixels.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES);
      expect(bytes.reduce((sum, value) => sum + value, 0) / FRAME_BYTES).toBeLessThan(1);
    }
    await unchanged();
    console.log(`Layered compound RGB parity: ${result.receipt.verification.frameCount} frames, maximum MAE ${maximumMae.toFixed(4)} / 255; ${JSON.stringify(result.receipt.settings.layered)}`);
  }, 120_000);

  it('retains shared speed points/easing across different clips and a dissolve using absolute row maps without UI state', async () => {
    const project = createProject('native-row-boundary', 'Row speed across clip boundaries');
    const authored = [point(0, { speed: 0.5 }, 'smooth'), point(4, { speed: 1 }, 'ease-in'),
      point(10, { speed: 2 }, 'ease-out'), point(16, { speed: 0.75 }), point(24, { speed: 1.25 }, 'hold')];
    project.layers[0]!.keyframes = structuredClone(authored);
    project.clips = [createClip('row-left', assets[0]!.id, 3, 15), createClip('row-right', assets[1]!.id, 6, 18),
      createClip('row-tail', assets[0]!.id, 10, 18)];
    project.clips[0]!.speed = { mode: 'constant', rate: 0.5 };
    project.clips[1]!.speed = { mode: 'constant', rate: 2 };
    project.clips[2]!.speed = { mode: 'ramp', startRate: 3, endRate: 4, curve: 'ease-out', anchorIn: 0, anchorOut: 20 };
    project.clips[1]!.colour = { ...NEUTRAL_COLOUR, brightness: 0.04 };
    project.layers[0]!.transitions = [{ leftId: 'row-left', rightId: 'row-right', type: 'cross-dissolve', duration: 2 },
      { leftId: 'row-right', rightId: 'row-tail', type: 'cut', duration: 0 }];
    expect(needsLayeredExport(project)).toBe(true);
    expect(needsLayeredExport({ ...project, layers: [{ ...project.layers[0]!, keyframes: [] }] })).toBe(false);
    expect(() => planExport(project)).toThrow('layered exporter');
    const layout = calculateLayout(project);
    const boundary = layout.clips[1]!.start;
    expect(boundary).toBeGreaterThan(authored[1]!.frame); expect(boundary).toBeLessThan(authored[2]!.frame);
    for (const placed of layout.clips) {
      expect(placed.duration).not.toBe(compileRetiming(placed.clip).duration);
      const rates = Array.from({ length: placed.duration }, (_, offset) => placed.retiming.rateAt(offset));
      expect(new Set(rates).size).toBeGreaterThan(1);
    }
    for (let frame = 0; frame < layout.duration; frame++) {
      const samples = sampleTimeline(project, frame, layout);
      expect(samples).toHaveLength(frame >= boundary && frame < boundary + 2 ? 2 : 1);
      for (const sample of samples) {
        const placed = layout.clips.find((placed) => placed.clip.id === sample.clipId)!;
        expect(sample.sourceFrame).toBe(placed.retiming.sourceAt(frame - placed.start));
        expect(placed.retiming.rateAt(frame - placed.start)).toBeCloseTo(evaluateLayerSetting(project.layers[0]!, 'speed', frame, 1));
      }
    }
    const result = await complete(project); bounds(result.receipt); await parity(project, result.filename);
    expect(result.receipt.snapshot.layers[0]!.keyframes).toEqual(authored);
    expect(project.layers[0]!.keyframes).toEqual(authored);
    expect(result.receipt.settings.grading).toContain('absolute project frames');
    await unchanged();
  }, 120_000);

  it('rejects every shared setting even at neutral values and keeps the two-clip 1x diagnostic restricted and read-only', async () => {
    const plain = createProject('native-reference-guard', 'Plain diagnostic validation');
    plain.clips = [createClip('reference-left', assets[0]!.id, 2, 6), createClip('reference-right', assets[1]!.id, 3, 7)];
    plain.layers[0]!.transitions = [{ leftId: 'reference-left', rightId: 'reference-right', type: 'cut', duration: 0 }];
    expect(validateReference(plain, library).clips).toHaveLength(2);
    const neutral: LayerKeyValues = { ...NEUTRAL_COLOUR, layerOpacity: 1, clipOpacity: 1, speed: 1 };
    const variants: ((document: ProjectDocument) => void)[] = [
      ...KEYFRAME_SETTINGS.map(({ key }) => (document: ProjectDocument) => {
        document.layers[0]!.keyframes = [point(20, { [key]: neutral[key]! }, 'smooth')];
      }),
      (document) => { document.layers[0]!.enabled = false; },
      (document) => { document.layers[0]!.opacity = 0.6; },
      (document) => { document.layers.push(layer('video-2')); },
      (document) => { document.clips[0]!.opacity = 0.5; },
    ];
    const before = jobs.list();
    for (const change of variants) {
      const document = structuredClone(plain); change(document); const id = randomUUID();
      expect(needsLayeredExport(document)).toBe(true);
      expect(() => validateReference(document, library)).toThrow(/diagnostic reference/i);
      await expect(renderReference(document, library, { id, signal: new AbortController().signal, update: () => { } })).rejects.toThrow(/diagnostic reference/i);
      await expect(readdir(path.join(config.dataDir, 'renders', id))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(jobs.list()).toEqual(before); await unchanged();
  });

  it('preserves RGBA16 premultiplied colour/coverage before H.264, including group opacity and transparent gaps', async () => {
    const project = simple(3);
    project.clips[0]!.sourceOut = 2;
    const right = createClip('right', assets[1]!.id, 5, 7); project.clips.push(right);
    project.layers[0]!.transitions = [{ leftId: 'base', rightId: 'right', type: 'cross-dissolve', duration: 1 }];
    project.layers[0]!.openingFade = 1; project.layers[0]!.closingFade = 1;
    project.layers[0]!.opacity = 0.55; project.clips[0]!.opacity = 0.7; right.opacity = 0.8;
    project.clips[1]!.colour = { ...NEUTRAL_COLOUR, exposure: 0.2, brightness: 0.02, hue: -30, shadows: 0.2 };
    project.layers[1]!.keyframes = [point(0, { clipOpacity: 0.2 }), point(4, { clipOpacity: 0.9 }, 'hold')];
    const work = path.join(config.dataDir, `raw-layered-${randomUUID()}`); await mkdir(work);
    try {
      const result = await renderLayeredExport({
        document: project, plan: planLayeredExport(project), assets: project.clips.map((clip) => library.get(clip.mediaId)),
        ffmpeg: config.ffmpeg, directory: work, target: { ...EXPORT_PROFILES.draft720, width: WIDTH, height: HEIGHT },
        context: { id: randomUUID(), signal: new AbortController().signal, update: () => { } }
      });
      expect(await readdir(work)).toEqual([result.filename]);
      const bytes = await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-i', path.join(work, result.filename),
        '-map', '0:v:0', '-an', '-filter_threads', '2', '-threads', '2', '-pix_fmt', 'rgba64le', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
      const actual = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2); const duration = calculateLayout(project).duration;
      expect(bytes).toHaveLength(duration * PIXELS * 8);
      let maximumMae = 0;
      for (let frame = 0; frame < duration; frame++) {
        const samples = sampleTimeline(project, frame); const expectedAlpha = coverage(samples);
        let error = 0;
        for (let pixel = 0; pixel < PIXELS; pixel++) {
          const expected = compositePixel(samples, (sample) => {
            const original = originals.get(sample.mediaId)!; const offset = sample.sourceFrame * FRAME_BYTES + pixel * 3;
            return [original[offset]! / 255, original[offset + 1]! / 255, original[offset + 2]! / 255];
          });
          const offset = (frame * PIXELS + pixel) * 4;
          for (let channel = 0; channel < 3; channel++) error += Math.abs(actual[offset + channel]! / 65535 - expected[channel]!) * 255;
          expect(Math.abs(actual[offset + 3]! - Math.round(expectedAlpha * 65535))).toBeLessThanOrEqual(2);
        }
        maximumMae = Math.max(maximumMae, error / FRAME_BYTES);
      }
      expect(maximumMae).toBeLessThan(1);
      expect(result.report.nativeVideoProcesses).toBeLessThan(40);
      console.log(`Lossless premultiplied RGBA16 maximum RGB MAE: ${maximumMae.toFixed(5)} / 255`);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  it('samples fade-through-black in output frames after animated grading without changing coverage', async () => {
    const project = simple(4);
    project.clips.push(createClip('right', assets[1]!.id, 11, 15));
    project.layers[0]!.transitions = [{ leftId: 'base', rightId: 'right', type: 'fade-through-black', duration: 5 }];
    project.layers[0]!.openingFade = 1; project.layers[0]!.closingFade = 1;
    project.layers[0]!.keyframes = [point(0, { brightness: 0.05, shadows: 0.5 }), point(3, { exposure: -0.2 }),
      point(6, { brightness: 0.1, exposure: 0.5, hue: 25, shadows: 0.3 }, 'hold')];
    project.clips[2]!.colour = { ...NEUTRAL_COLOUR, brightness: 0.1, exposure: 0.4, highlights: -0.2 };
    const result = await complete(project); bounds(result.receipt); await parity(project, result.filename);
    for (const frame of [3, 4]) {
      const base = sampleTimeline(project, frame).find((sample) => sample.layerId === 'video-1')!;
      expect(base.brightness).toBe(0); expect(base.blendWeight).toBe(1); expect(base.opacity).toBe(1);
    }
  });

  it('renders single-layer animated grade/opacity and sampled source holds rather than silently taking the static path', async () => {
    const project = createProject('native-single-animated', 'Animated single layer');
    const clip = createClip('animated', assets[0]!.id, 5, 9); project.clips = [clip];
    clip.speed = { mode: 'constant', rate: 0.5 };
    project.layers[0]!.keyframes = [
      point(0, { exposure: -1, hue: -20, brightness: 0, saturation: 1, clipOpacity: 0.2, layerOpacity: 1 }, 'smooth'),
      point(4, { exposure: 0.1, hue: 10, brightness: 0.03, saturation: 0.9 }),
      point(7, { layerOpacity: 0.4, clipOpacity: 0.9, exposure: 0.7, hue: 40, brightness: 0.06, saturation: 0.8 }, 'hold'),
    ];
    expect(needsLayeredExport(project)).toBe(true);
    const result = await complete(project); bounds(result.receipt); await parity(project, result.filename);
    expect(result.receipt.retiming[0]).toMatchObject({ decodedFrames: 4, outputFrames: 8 });
    // The same held original frame receives different grades at distinct project frames.
    expect(result.receipt.settings.layered!.lutsGenerated).toBe(8);
  });

  it('supports overlay-only projects, hidden primary footage and final opaque-black empty holds', async () => {
    for (const hiddenPrimary of [false, true]) {
      const project = createProject(`native-no-primary-${hiddenPrimary}`, 'Overlay only / hidden primary');
      project.layers.push(layer('video-2', 0.6));
      project.clips = [{ ...createClip('overlay', assets[1]!.id, 5, 7), layerId: 'video-2', start: 2, opacity: 0.7 }];
      if (hiddenPrimary) {
        project.layers[0]!.enabled = false; project.clips.push(createClip('hidden-base', assets[0]!.id, 0, 7));
      }
      const result = await complete(project); bounds(result.receipt); await parity(project, result.filename);
      expect(result.receipt.settings.layered!.renderedClipIds).toEqual(['overlay']);
      expect(result.receipt.verification.frameCount).toBe(hiddenPrimary ? 7 : 4);
    }
    const project = simple(3); project.layers.forEach((layer) => { layer.enabled = false; });
    project.clips[1]!.start = 5;
    const result = await complete(project); bounds(result.receipt); await parity(project, result.filename);
    expect(result.receipt.retiming).toEqual([]);
    expect(result.receipt.settings.layered).toMatchObject({ peakOriginalVideoDecoders: 0, originalDecoderProcesses: 0, lutsGenerated: 0, lutBytes: 0 });
  });

  it('renders three genuine UHD frames with three layers and bounded reusable raw/LUT memory', async () => {
    const uhdPath = path.join(root, 'sources', 'uhd-three-frames.mp4');
    await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
      'nullsrc=size=3840x2160:rate=30000/1001,geq=lum=\'60+20*N+8*gte(X,1920)\':cb=\'100+N\':cr=\'165-2*N\',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-frames:v', '3', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '2', '-bf', '0',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-video_track_timescale', '30000', uhdPath]);
    const uhd = await library.register(uhdPath);
    originals.set(uhd.id, await rawRgb(config, uhdPath));
    const project = simple(3); project.layers.push(layer('video-3', 0.75));
    project.clips[0]!.mediaId = uhd.id;
    project.layers[0]!.opacity = 0.9;
    project.clips[0]!.opacity = 0.8; project.clips[0]!.colour = { ...NEUTRAL_COLOUR, exposure: 0.15, shadows: 0.25 };
    project.layers[1]!.keyframes = [point(1, { layerOpacity: 0.7 }), point(2, { layerOpacity: 0.3 }, 'hold')];
    const top = { ...createClip('uhd-top', assets[1]!.id, 4, 5), layerId: 'video-3', start: 2, opacity: 0.6 };
    project.layers[2]!.keyframes = [point(3, { ...NEUTRAL_COLOUR, brightness: 0.08, hue: -30 }),
      point(6, { ...NEUTRAL_COLOUR, exposure: -0.3, saturation: 0.6 }, 'hold')];
    project.clips.push(top);
    const started = performance.now(); const result = await complete(project, 'final4k');
    const elapsed = performance.now() - started; bounds(result.receipt);
    expect(result.receipt.verification.frameCount).toBe(3);
    expect(result.receipt.settings.layered!.rawBufferBytes).toBe(182_476_800);
    const maximumMae = await parity(project, result.filename);
    expect(uhd.metadata).toMatchObject({ width: 3840, height: 2160, frameCount: 3 });
    expect(await fingerprintFile(uhdPath)).toEqual(uhd.fingerprint);
    console.log(`Layered UHD: 3 frames, ${elapsed.toFixed(0)} ms end-to-end, maximum MAE ${maximumMae.toFixed(4)} / 255, raw ${result.receipt.settings.layered!.rawBufferBytes} bytes + LUT ${result.receipt.settings.layered!.lutBytes} bytes; ${JSON.stringify(result.receipt.settings.layered)}`);
    const draft = await complete(project, 'draft720'); bounds(draft.receipt);
    const draftMae = await parity(project, draft.filename);
    console.log(`UHD original downscaled/tagged BT.709 before animated grade: maximum 720p MAE ${draftMae.toFixed(4)} / 255`);
  }, 120_000);

  it('exports all eight video layers without multiplying decoder or raw-buffer peaks', async () => {
    const project = createProject('native-eight-layers', 'Eight synthetic video layers');
    for (let index = 1; index < 8; index++) project.layers.push(layer(`video-${index + 1}`, 0.3 + index * 0.07));
    project.clips = project.layers.map((row, index) => ({
      ...createClip(`eight-${index}`, assets[index % 2]!.id, index + 1, index + 3), layerId: row.id, opacity: 0.4 + index * 0.06,
      colour: { ...NEUTRAL_COLOUR, exposure: index * 0.025, brightness: index * 0.003, saturation: 0.8 + index * 0.02 },
    }));
    const result = await complete(project); bounds(result.receipt);
    const maximumMae = await parity(project, result.filename);
    expect(result.receipt.settings.layered!.layerPasses).toBe(8);
    expect(result.receipt.settings.layered!.sourceOverPasses).toBe(7);
    expect(result.receipt.settings.layered!.originalDecoderProcesses).toBe(8);
    expect(result.receipt.settings.layered!.peakLosslessClipFiles).toBe(1);
    expect(result.receipt.settings.layered!.peakLosslessTimelineRepresentations).toBe(3);
    expect(result.receipt.settings.layered!.rawBufferBytes).toBe(1280 * 720 * 22);
    console.log(`Eight-layer maximum RGB MAE: ${maximumMae.toFixed(4)} / 255; decoder peaks remain 1 original / 2 intermediate`);
  });

  it('reuses the selected-range 48 kHz music/mux/verification path for an extended layered duration', async () => {
    const project = simple(4); project.clips[1]!.start = 5;
    project.music = { mediaId: music.id, sourceIn: 2, sourceOut: 6, start: 1, duration: 5, gainDb: -6, fadeIn: 1, fadeOut: 1, loop: true };
    const result = await complete(project); bounds(result.receipt); await parity(project, result.filename);
    expect(result.receipt.verification.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(result.receipt.verification.audio!.durationErrorSeconds).toBeLessThanOrEqual(framesToSeconds(1));
    expect(result.receipt.musicSource).toEqual(music);
    expect(await fingerprintFile(music.sourcePath)).toEqual(music.fingerprint);
  });

  it('owns the queued immutable snapshot without modifying originals or saved user edits', async () => {
    const project = simple(4); project.layers[1]!.keyframes = [point(8, { clipOpacity: 0.4 }, 'hold')];
    const captured = structuredClone(project);
    let release = (): void => { };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const busy = jobs.submit('prepare', 'unit-only scheduling gate', async () => gate);
    let id = '';
    try {
      const job = startExport(project, 'draft720', library); id = job.id;
      expect(job.state).toBe('queued');
      project.title = 'Later user edit'; project.layers[1]!.opacity = 0;
      project.layers[1]!.keyframes[0]!.values.clipOpacity = 1;
      release(); await jobs.wait(busy.id);
      const result = await jobs.wait(id); expect(result.state, result.message).toBe('completed');
      const receipt = JSON.parse(await readFile(path.join(config.dataDir, 'renders', id, 'receipt.json'), 'utf8')) as ExportReceipt;
      expect(receipt.snapshot).toEqual(captured);
      expect(project.title).toBe('Later user edit'); expect(project.layers[1]!.opacity).toBe(0);
      await unchanged();
    } finally { release(); }
  });

  it.each(['rgb-group', 'rgba-merge'] as const)('cancels concurrent dissolves during %s, closes every real native child and preserves unrelated scratch/outputs', async (stage) => {
    if (!successfulDirectory) successfulDirectory = (await complete(simple())).directory;
    const successfulMp4 = await readFile(path.join(successfulDirectory, 'export.mp4'));
    const successfulReceipt = await readFile(path.join(successfulDirectory, 'receipt.json'));
    const project = concurrentTracks(2); const captured = structuredClone(project); const layout = calculateLayout(project);
    const overlap = layout.transitions.find((item) => item.layerId === 'packed-track')!;
    const renderRoot = path.join(config.dataDir, 'renders');
    const unrelated = await mkdtemp(path.join(renderRoot, 'unrelated-scratch-'));
    // The store writes only this disposable sentinel, never an owner project.
    const sentinelStore = new ProjectStore(unrelated); await sentinelStore.save(createProject('sentinel', 'Unrelated scratch'), 0);
    const sentinelPath = path.join(unrelated, 'projects', 'sentinel.json'); const sentinelBytes = await readFile(sentinelPath);
    const before = (await readdir(renderRoot)).sort();
    const spawnOffset = vi.mocked(spawn).mock.calls.length;
    const observed: ChildProcess[] = []; const closed = new Set<ChildProcess>();
    const submit = jobs.submit.bind(jobs); let cancelled = false; let liveFiles: string[] = [];
    const targetMessage = stage === 'rgb-group'
      ? `Rendering track group packed-track: project frame ${overlap.start + 1} / ${layout.duration}`
      : `Compositing track packed-track: 1 / ${layout.duration} frames`;
    const spy = vi.spyOn(jobs, 'submit').mockImplementation((kind, label, task, settled = null) => submit(kind, label, async (context) => task({
      ...context, update: (progress, message) => {
        context.update(progress, message);
        if (cancelled || message !== targetMessage) return;
        const work = path.join(renderRoot, context.id, 'work');
        const native = vi.mocked(spawn);
        for (let index = spawnOffset; index < native.mock.calls.length; index++) {
          const call = native.mock.calls[index]!; const result = native.mock.results[index]!;
          if (call[0] !== config.ffmpeg || call[2]?.cwd !== work || result.type !== 'return') continue;
          const child = result.value as ChildProcess;
          if (child.exitCode !== null || child.signalCode !== null) continue;
          observed.push(child); child.once('close', () => { closed.add(child); });
        }
        expect(observed).toHaveLength(3);
        const readers = observed.filter((child) => child.stdout !== null);
        const encoders = observed.filter((child) => child.stdin !== null);
        expect(readers).toHaveLength(2); expect(encoders).toHaveLength(1);
        for (const child of readers) {
          const args = native.mock.calls[native.mock.results.findIndex((result) => result.type === 'return' && result.value === child)]![1]!;
          expect(args).toContain(stage === 'rgb-group' ? 'rgb24' : 'rgba64le');
        }
        liveFiles = readdirSync(work);
        if (stage === 'rgb-group') expect(liveFiles.filter((name) => /^clip-\d+\.nut$/.test(name))).toHaveLength(2);
        else {
          expect(liveFiles).toContain('group-0.nut'); expect(liveFiles).toContain('group-1.nut');
          expect(liveFiles.filter((name) => /^clip-\d+\.nut$/.test(name))).toHaveLength(0);
        }
        cancelled = true; jobs.cancel(context.id);
      },
    }), settled));
    let id = '';
    try {
      const job = startExport(project, 'draft720', library); id = job.id;
      const result = await jobs.wait(id);
      expect(result.state, result.message).toBe('cancelled'); expect(cancelled).toBe(true);
      expect(result.outputUrl).toBeNull(); expect(result.receiptUrl).toBeNull();
      expect(liveFiles.length).toBeGreaterThan(0);
      expect(closed.size).toBe(3);
      for (const child of observed) {
        expect(closed.has(child)).toBe(true);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      }
      await expect(readdir(path.join(renderRoot, id))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(renderRoot)).sort()).toEqual(before);
      expect(await readFile(path.join(successfulDirectory, 'export.mp4'))).toEqual(successfulMp4);
      expect(await readFile(path.join(successfulDirectory, 'receipt.json'))).toEqual(successfulReceipt);
      expect(await readFile(sentinelPath)).toEqual(sentinelBytes);
      expect(project).toEqual(captured); await unchanged();
      expect(jobs.list().some((job) => job.state === 'queued' || job.state === 'running')).toBe(false);
    } finally { spy.mockRestore(); await rm(unrelated, { recursive: true, force: true }); }
  }, 120_000);

  it('cancels active layer composition, reaps native pipes and removes only the owned render directory', async () => {
    if (!successfulDirectory) successfulDirectory = (await complete(simple())).directory;
    const before = await readFile(path.join(successfulDirectory, 'export.mp4'));
    const submit = jobs.submit.bind(jobs); let cancelled = false;
    const spy = vi.spyOn(jobs, 'submit').mockImplementation((kind, label, task, settled = null) => submit(kind, label, async (context) => task({
      ...context, update: (progress, message) => {
        context.update(progress, message);
        if (!cancelled && message.startsWith('Compositing track')) { cancelled = true; jobs.cancel(context.id); }
      },
    }), settled));
    let id = '';
    try {
      const job = startExport(simple(12), 'draft720', library); id = job.id;
      const result = await jobs.wait(id);
      expect(result.state, result.message).toBe('cancelled'); expect(cancelled).toBe(true);
      expect(result.outputUrl).toBeNull(); expect(result.receiptUrl).toBeNull();
    } finally { spy.mockRestore(); }
    expect(await readdir(path.join(config.dataDir, 'renders'))).not.toContain(id);
    expect(await readFile(path.join(successfulDirectory, 'export.mp4'))).toEqual(before);
    await unchanged();
  });

  it('cleans failed native work, checks even hidden source identities, and refuses to overwrite an existing UUID', async () => {
    const ffmpeg = config.ffmpeg; let failedId = '';
    try {
      config.ffmpeg = '/no-such-layered-ffmpeg';
      const job = startExport(simple(), 'draft720', library); failedId = job.id;
      expect((await jobs.wait(job.id)).state).toBe('failed');
    } finally { config.ffmpeg = ffmpeg; }
    expect(await readdir(path.join(config.dataDir, 'renders'))).not.toContain(failedId);
    const project = simple(); project.layers.push({ ...layer('video-3'), enabled: false });
    project.clips.push({ ...createClip('hidden', assets[2]!.id, 0, 1), layerId: 'video-3', start: 6 });
    const get = library.get.bind(library);
    const spy = vi.spyOn(library, 'get').mockImplementation((id) => {
      const asset = get(id); return id === assets[2]!.id ? { ...asset, fingerprint: { ...asset.fingerprint, digest: 'f'.repeat(64) } } : asset;
    });
    let hiddenId = '';
    try {
      const job = startExport(project, 'draft720', library); hiddenId = job.id;
      const result = await jobs.wait(job.id); expect(result.state).toBe('failed'); expect(result.message).toMatch(/changed|identity|fingerprint/i);
    } finally { spy.mockRestore(); }
    expect(await readdir(path.join(config.dataDir, 'renders'))).not.toContain(hiddenId);
    if (!successfulDirectory) successfulDirectory = (await complete(simple())).directory;
    const receipt = await readFile(path.join(successfulDirectory, 'receipt.json'));
    await expect(renderExport(simple(), 'draft720', library, { id: path.basename(successfulDirectory), signal: new AbortController().signal, update: () => { } })).rejects.toThrow('EEXIST');
    expect(await readFile(path.join(successfulDirectory, 'receipt.json'))).toEqual(receipt);
    await unchanged();
  });
});