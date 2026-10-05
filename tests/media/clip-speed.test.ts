import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { startExport, type ExportReceipt } from '../../src/server/export.js';
import { fingerprintFile } from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';
import { compositePixel } from '../../src/shared/composition.js';
import { EXPORT_PROFILES, type ExportProfile } from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';
import type { SpeedCurve } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const FRAME_BYTES = 160 * 90 * 3;

describe.skipIf(!enabled)('clip speed curves · exact native maps on disposable originals', () => {
  let root: string; let config: ServiceConfig; let library: MediaLibrary; let jobs: JobQueue;
  let assets: MediaAsset[]; let originals: Map<string, Buffer>; let originalBytes: Buffer[];
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pascap-clip-curves-'));
    const sources = path.join(root, 'sources'); await mkdir(sources);
    config = createConfig({ dataDir: path.join(root, 'cache') }); jobs = new JobQueue(); library = new MediaLibrary(config, jobs); await library.initialise();
    assets = [];
    for (let index = 0; index < 2; index++) {
      const filename = path.join(sources, `coded-${index}.mp4`);
      await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
        `nullsrc=size=160x90:rate=30000/1001,geq=lum='40+5*N':cb='${100 + index * 15}+N':cr='${175 - index * 15}-2*N',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
        '-frames:v', '32', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-bf', '0',
        '-threads', '2', '-filter_threads', '2', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-video_track_timescale', '30000', filename]);
      assets.push(await library.register(filename));
    }
    originalBytes = await Promise.all(assets.map((asset) => readFile(asset.sourcePath)));
    originals = new Map(await Promise.all(assets.map(async (asset) => [asset.id, await raw(asset.sourcePath)] as const)));
  });
  afterAll(async () => { await jobs?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  async function raw(filename: string): Promise<Buffer> {
    return runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-i', filename, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-filter_threads', '2', '-vf', 'scale=160:90:flags=area:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24',
      '-fps_mode', 'passthrough', '-threads', '2', '-f', 'rawvideo', 'pipe:1']);
  }
  async function completed(document: ProjectDocument, profile: ExportProfile = 'draft720') {
    const job = startExport(document, profile, library); const result = await jobs.wait(job.id);
    expect(result.state, result.message).toBe('completed');
    const directory = path.join(config.dataDir, 'renders', job.id);
    expect((await readdir(directory)).sort()).toEqual(['export.mp4', 'receipt.json']);
    const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8')) as ExportReceipt;
    expect(receipt.snapshot).toEqual(document); expect(receipt.verification).toMatchObject({ frameCount: calculateLayout(document).duration, fullDecode: true, faststart: true, width: EXPORT_PROFILES[profile].width, height: EXPORT_PROFILES[profile].height });
    const actual = await raw(path.join(directory, 'export.mp4')); const layout = calculateLayout(document);
    expect(actual).toHaveLength(layout.duration * FRAME_BYTES);
    let maximum = 0;
    for (let frame = 0; frame < layout.duration; frame++) {
      const samples = sampleTimeline(document, frame, layout); let error = 0;
      for (let pixel = 0; pixel < 160 * 90; pixel++) {
        const expected = compositePixel(samples, (sample) => {
          const bytes = originals.get(sample.mediaId)!; const offset = sample.sourceFrame * FRAME_BYTES + pixel * 3;
          return [bytes[offset]! / 255, bytes[offset + 1]! / 255, bytes[offset + 2]! / 255];
        });
        for (let channel = 0; channel < 3; channel++) error += Math.abs(actual[frame * FRAME_BYTES + pixel * 3 + channel]! - expected[channel]! * 255);
      }
      const mae = error / FRAME_BYTES; expect(mae, `Mapped native clip curve frame ${frame}`).toBeLessThan(4); maximum = Math.max(maximum, mae);
    }
    for (const [index, asset] of assets.entries()) {
      expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint); expect(await readFile(asset.sourcePath)).toEqual(originalBytes[index]);
      expect(library.get(asset.id).prepared).toBeNull();
    }
    console.log(`Native clip curves ${receipt.settings.pipeline}: ${layout.duration} frames; maximum RGB MAE ${maximum.toFixed(4)} / 255; exact maps, no proxy work.`);
    return receipt;
  }

  it('exports linear, eased and one-frame-held clip curves across a dissolve with exact source/colour/frame parity', async () => {
    const document = createProject('native-clip-curves', 'Disposable custom clip curves');
    const speeds: SpeedCurve[] = [
      { mode: 'curve', keyframes: [{ frame: 0, rate: 0.5, interpolation: 'linear' }, { frame: 32, rate: 2, interpolation: 'hold' }] },
      { mode: 'curve', keyframes: [{ frame: 0, rate: 1, interpolation: 'smooth' }, { frame: 12, rate: 0.25, interpolation: 'ease-out' }, { frame: 32, rate: 3, interpolation: 'hold' }] },
      { mode: 'curve', keyframes: [{ frame: 0, rate: 2, interpolation: 'hold' }, { frame: 12, rate: 0.1, interpolation: 'hold' }, { frame: 13, rate: 2, interpolation: 'hold' }, { frame: 32, rate: 2, interpolation: 'hold' }] },
    ];
    document.clips = speeds.map((speed, index) => ({ ...createClip(`curve-${index}`, assets[index % 2]!.id, 4, 24), speed }));
    document.layers[0]!.transitions = [{ leftId: 'curve-0', rightId: 'curve-1', type: 'cross-dissolve', duration: 3 }, { leftId: 'curve-1', rightId: 'curve-2', type: 'cut', duration: 0 }];
    const receipt = await completed(document);
    expect(receipt.settings.pipeline).toBe('static-single-layer'); expect(receipt.retiming).toHaveLength(3);
    receipt.retiming.forEach((report, index) => {
      expect(report.decodedFrames).toBe(20); expect(report.outputFrames).toBe(calculateLayout(document).clips[index]!.duration);
      expect(report.rawFrameBuffers).toBe(1); expect(report.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
    });
  }, 120_000);

  it('uses custom clip maps in layered export while an overlay row Speed overrides only its own saved clip base', async () => {
    const document = createProject('layered-clip-curves', 'Disposable layered custom speed');
    const speed: SpeedCurve = { mode: 'curve', keyframes: [{ frame: 0, rate: 0.5, interpolation: 'smooth' }, { frame: 16, rate: 2, interpolation: 'ease-in' }, { frame: 32, rate: 0.5, interpolation: 'hold' }] };
    document.clips = [{ ...createClip('base', assets[0]!.id, 2, 22), speed }, { ...createClip('upper', assets[1]!.id, 10, 20), layerId: 'upper', start: 3, opacity: 0.6, speed }];
    document.layers.push({
      ...createLayer('upper', 'Upper', false), opacity: 0.8, keyframes: [
        { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: 2 } },
        { frame: 20, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 0.5 } },
      ]
    });
    const receipt = await completed(document); const report = receipt.settings.layered!;
    expect(receipt.settings.pipeline).toBe('sequential-layered');
    expect(report.peakOriginalVideoDecoders).toBe(1); expect(report.peakIntermediateVideoDecoders).toBeLessThanOrEqual(2);
    expect(report.peakVideoEncoders).toBe(1); expect(report.peakNativeVideoChildren).toBeLessThanOrEqual(3);
    receipt.retiming.forEach((retiming, index) => {
      expect(retiming.decodedFrames).toBe(document.clips[index]!.sourceOut - document.clips[index]!.sourceIn);
      expect(retiming.outputFrames).toBe(calculateLayout(document).clips[index]!.duration);
    });
    expect(receipt.snapshot.clips[1]!.speed).toEqual(speed);
  }, 120_000);

  it('exports three UHD frames with the exact custom linear map rather than dropping curve keys at final quality', async () => {
    const document = createProject('uhd-clip-curve', 'Disposable UHD clip curve');
    document.clips = [{
      ...createClip('uhd', assets[0]!.id, 0, 6), speed: {
        mode: 'curve', keyframes: [
          { frame: 0, rate: 1, interpolation: 'linear' }, { frame: 6, rate: 4, interpolation: 'hold' },
        ]
      }
    }];
    const receipt = await completed(document, 'final4k');
    expect(receipt.verification.frameCount).toBe(3); expect(receipt.profile).toBe('final4k');
    expect(receipt.retiming[0]).toMatchObject({ decodedFrames: 6, outputFrames: 3, rawFrameBuffers: 1 });
  }, 120_000);
});