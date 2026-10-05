import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { audioAssetSchema, musicGainAt, type AudioAsset } from '../../src/shared/audio.js';
import { gradePixel, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { removeMarkedRange } from '../../src/shared/rush-editing.js';
import { compileRetiming, type SpeedSettings } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { exportAudioSample, EXPORT_PROFILES } from '../../src/shared/export.js';
import { estimateExportSpace } from '../../src/shared/export-space.js';
import { framesToSeconds } from '../../src/shared/timing.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { renderExport, startExport, type ExportReceipt } from '../../src/server/export.js';
import { fingerprintFile } from '../../src/server/files.js';
import { extractComparisonFrame } from '../../src/server/library.js';
import { probeVideo } from '../../src/server/probe.js';
import { runProcess } from '../../src/server/process.js';
import { preparedFixture } from '../../scripts/fixtures.js';
import { observedJobBytes } from './scratch-observation.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const FRAME_BYTES = 160 * 90 * 3;
const curves = ['linear', 'ease-in', 'ease-out', 'smooth'] as const;
const speeds: SpeedSettings[] = [{ mode: 'constant', rate: 0.5 }, { mode: 'constant', rate: 2 },
  ...curves.flatMap((curve) => [
    { mode: 'ramp' as const, startRate: 0.5, endRate: 2, curve, anchorIn: 0, anchorOut: 26 },
    { mode: 'ramp' as const, startRate: 2, endRate: 0.5, curve, anchorIn: 0, anchorOut: 26 },
  ])];

async function rawVideo(config: ServiceConfig, asset: MediaAsset): Promise<Buffer> {
  return runProcess(config.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '2', '-i', asset.sourcePath, '-map', '0:v:0', '-an',
    '-vf', `scale=160:90:flags=area:in_color_matrix=bt709:out_color_matrix=bt709:in_range=${asset.metadata.colourRange}:out_range=pc,format=rgb24`,
    '-threads', '2', '-filter_threads', '2', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
}
// The existing native colour contract allows MAE <4/255 after 8-bit limited YUV.
// Measured separately: LUT rounding <=1 level, RGB/YUV round-trip another 2–3.
function assertPixels(document: ProjectDocument, frame: number, actual: Uint8Array, originals: Map<string, Buffer>, tolerance = 4): number {
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
function floats(bytes: Buffer): Float32Array { return new Float32Array(Uint8Array.from(bytes).buffer); }
async function rawAudio(config: ServiceConfig, filename: string): Promise<Float32Array> {
  return floats(await runProcess(config.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '2', '-i', filename, '-map', '0:a:0', '-vn',
    '-af', 'pan=mono|c0=c0', '-ar', '48000', '-ac', '1', '-filter_threads', '2', '-threads', '2', '-f', 'f32le', 'pipe:1']));
}

describe.skipIf(!enabled)('production native export · opt-in disposable media only', () => {
  let directory: string;
  let config: ServiceConfig;
  let fixture: Awaited<ReturnType<typeof preparedFixture>>;
  let assets: MediaAsset[];
  let originals: Map<string, Buffer>;
  let audio: AudioAsset;
  let audioSamples: Float32Array;
  let savedDocument: Buffer;
  let successfulDirectory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-export-media-'));
    config = createConfig({ dataDir: directory }); fixture = await preparedFixture(config);
    savedDocument = await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`));
    assets = [];
    for (let index = 0; index < 2; index++) {
      const filename = path.join(directory, 'synthetic-sources', `export-frame-codes-${index}.mp4`);
      // Flat, time-varying colours expose a wrong source frame numerically, without
      // resampling/edge ambiguity. One original contains audio which MUST NOT leak.
      await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-f', 'lavfi', '-i', `nullsrc=size=160x90:rate=30000/1001,geq=lum='40+4*N':cb='${90 + index * 25}+N':cr='${175 - index * 25}-2*N',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
        ...(index === 0 ? ['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000'] : []),
        '-frames:v', '40', '-t', framesToSeconds(40).toFixed(9), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10',
        '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '2', '-bf', '0',
        ...(index === 0 ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-video_track_timescale', '30000', filename]);
      // Deliberately never prepare these assets: production export cannot need a proxy.
      assets.push(await fixture.library.register(filename));
    }
    originals = new Map(await Promise.all(assets.map(async (asset) => [asset.id, await rawVideo(config, asset)] as const)));
    const audioPath = path.join(directory, 'synthetic-sources', 'selected-tone.wav');
    await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${framesToSeconds(6)}`,
      '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${framesToSeconds(12)}`,
      '-f', 'lavfi', '-i', `sine=frequency=1760:sample_rate=48000:duration=${framesToSeconds(6)}`,
      '-filter_complex_threads', '2', '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]', '-map', '[out]',
      '-c:a', 'pcm_s16le', '-threads', '2', '-ar', '48000', audioPath]);
    audioSamples = await rawAudio(config, audioPath);
    audio = audioAssetSchema.parse({ id: 'export-music', name: 'selected-tone.wav', sourcePath: audioPath, fingerprint: await fingerprintFile(audioPath),
      metadata: { codec: 'pcm_s16le', sampleRate: 48000, channels: 1, durationSeconds: audioSamples.length / 48000, frameCount: 23 },
      status: 'registered', error: null, waveform: [] });
  });
  afterAll(async () => { await fixture?.jobs.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  function document(length = 36): ProjectDocument {
    const project = createProject('native-export', 'Native disposable export');
    project.clips = [createClip('one', assets[0]!.id, 0, length)];
    return projectSchema.parse(project);
  }
  async function completed(project: ProjectDocument, profile: 'draft720' | 'final4k' = 'draft720') {
    const job = startExport(project, profile, fixture.library, async (id) => {
      expect(id).toBe(audio.id); return audio;
    });
    const result = await fixture.jobs.wait(job.id);
    expect(result.state, result.message).toBe('completed');
    expect(result.progress).toBe(1); expect(result.outputUrl).toBe(`/api/jobs/${job.id}/export`); expect(result.receiptUrl).toBe(`/api/jobs/${job.id}/receipt`);
    const renderDirectory = path.join(directory, 'renders', job.id);
    expect((await readdir(renderDirectory)).sort()).toEqual(['export.mp4', 'receipt.json']);
    const receipt = JSON.parse(await readFile(path.join(renderDirectory, 'receipt.json'), 'utf8')) as ExportReceipt;
    expect(receipt.profile).toBe(profile); expect(receipt.verification.fullDecode).toBe(true); expect(receipt.verification.faststart).toBe(true);
    expect(receipt.verification.frameCount).toBe(calculateLayout(project).duration);
    expect(receipt.verification).toMatchObject({ width: EXPORT_PROFILES[profile].width, height: EXPORT_PROFILES[profile].height, codec: 'h264', pixelFormat: 'yuv420p', colourRange: 'tv' });
    return { job, filename: path.join(renderDirectory, 'export.mp4'), renderDirectory, receipt };
  }

  it('exports >2 clips, repeated graded originals, slow/fast and both directions of every ramp with exact numeric pixels', async () => {
    const project = createProject('native-many', 'Many clips and every speed curve');
    project.clips = speeds.map((speed, index) => ({
      ...createClip(`instance-${index}`, assets[index % 2]!.id, 1 + index % 4, 19 + index % 4), speed,
      colour: { ...NEUTRAL_COLOUR, brightness: index * 0.008, exposure: index * 0.025, saturation: 0.85 + index * 0.015 },
    }));
    project.layers[0]!.transitions = project.clips.slice(1).map((clip, index) => {
      const pair = { leftId: project.clips[index]!.id, rightId: clip.id };
      if (index % 3 === 0) return { ...pair, type: 'cut' as const, duration: 0 as const };
      return { ...pair, type: index % 3 === 1 ? 'cross-dissolve' as const : 'fade-through-black' as const, duration: index % 3 === 1 ? 4 : 5 };
    });
    project.layers[0]!.openingFade = 3; project.layers[0]!.closingFade = 3;
    const updates: number[] = [];
    const diskSamples: number[] = [];
    const submit = fixture.jobs.submit.bind(fixture.jobs);
    const spy = vi.spyOn(fixture.jobs, 'submit').mockImplementation((kind, label, task, settled = null) => submit(kind, label, async (context) => task({
      ...context, update: (progress, message) => {
        updates.push(progress); context.update(progress, message);
        diskSamples.push(observedJobBytes(path.join(directory, 'renders', context.id)));
      },
    }), settled));
    let result: Awaited<ReturnType<typeof completed>>;
    try { result = await completed(project); } finally { spy.mockRestore(); }
    successfulDirectory = result.renderDirectory;
    expect(Math.max(...diskSamples)).toBeGreaterThan(0);
    console.log(`Native scratch observation (static 720p): maximum ${Math.max(...diskSamples)} allocated file bytes at ${diskSamples.length} progress points; planning allowance ${estimateExportSpace(project, 'draft720').totalBytes} bytes. Directory metadata and between-sample peaks are not measured.`);
    expect(updates.length).toBeGreaterThan(20);
    expect(updates.every((value, index) => index === 0 || value >= updates[index - 1]!)).toBe(true);
    expect(result.receipt.retiming).toHaveLength(speeds.length);
    for (const [index, report] of result.receipt.retiming.entries()) {
      expect(report.decodedFrames).toBe(18); expect(report.outputFrames).toBe(compileRetiming(project.clips[index]!).duration);
      expect(report.rawFrameBuffers).toBe(1); expect(report.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
    }
    expect(result.receipt.verification.hasAudio).toBe(false);
    const output = await rawVideo(config, { ...assets[0]!, sourcePath: result.filename, metadata: { ...assets[0]!.metadata, frameCount: result.receipt.verification.frameCount } });
    expect(output).toHaveLength(calculateLayout(project).duration * FRAME_BYTES);
    // Every output frame, including numeric dissolve midpoints and black boundaries.
    let maxMae = 0;
    for (let frame = 0; frame < result.receipt.verification.frameCount; frame++) {
      maxMae = Math.max(maxMae, assertPixels(project, frame, output.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES), originals));
    }
    console.log(`Native multi-clip map/grade/fade parity: ${result.receipt.verification.frameCount} frames, maximum MAE ${maxMae.toFixed(3)} / 255`);
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
    before.clips[0]!.colour = { ...NEUTRAL_COLOUR, exposure: 0.3, brightness: 0.04, saturation: 0.8 };
    before.clips.push(createClip('two', assets[1]!.id, 2, 10));
    before.clips[1]!.start = 12;
    before.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
    const project = applyCommand(before, removeMarkedRange(before, { clipId: 'one', inFrame: 3, outFrame: 6 }, 'one-right'));
    expect(project.clips).toEqual([
      { ...before.clips[0]!, sourceOut: 6 },
      { ...before.clips[0]!, id: 'one-right', sourceIn: 12, start: 3 },
      { ...before.clips[1]!, start: 9 },
    ]);
    expect(calculateLayout(project).clips.map((placed) => [placed.clip.id, placed.start, placed.end])).toEqual([
      ['one', 0, 3], ['one-right', 3, 9], ['two', 9, 17],
    ]);
    const result = await completed(project);
    expect(result.receipt.snapshot).toEqual(project);
    expect(result.receipt.retiming.map((report) => [report.decodedFrames, report.outputFrames])).toEqual([[6, 3], [12, 6], [8, 8]]);
    expect(result.receipt.verification.hasAudio).toBe(false);
    const output = await rawVideo(config, { ...assets[0]!, sourcePath: result.filename, metadata: { ...assets[0]!.metadata, frameCount: 17 } });
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
      ['one', 0, 6], ['one-right', 6, 12], ['two', 12, 20],
    ]);
    expect(before.clips[0]!.sourceOut).toBe(24);
    for (const asset of assets) {
      expect(asset.prepared).toBeNull();
      expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint);
    }
    expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
  });

  it('supports a one-frame dissolve and clips whose entire output consists of transition tails', async () => {
    const project = document(1); project.clips.push(createClip('two', assets[1]!.id, 8, 9));
    project.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cross-dissolve', duration: 1 }];
    const result = await completed(project);
    expect(result.receipt.timeline.chunks).toHaveLength(1);
    const pixels = await extractComparisonFrame(config, result.filename, 0, 'tv');
    assertPixels(project, 0, pixels, originals);
  });

  it('renders a few genuine UHD frames, grading before output-frame one-frame black fades', async () => {
    const project = document(6); project.clips[0]!.speed = { mode: 'constant', rate: 2 };
    project.clips[0]!.colour = { ...NEUTRAL_COLOUR, brightness: 0.1, shadows: 0.25 };
    project.layers[0]!.openingFade = 1; project.layers[0]!.closingFade = 1;
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
    project.music = { mediaId: audio.id, sourceIn: 6, sourceOut: 12, start: 3, duration: 24, gainDb: -6, fadeIn: 6, fadeOut: 6, loop: true };
    const result = await completed(project); const samples = await rawAudio(config, result.filename);
    expect(result.receipt.verification.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(result.receipt.verification.audio!.durationErrorSeconds).toBeLessThanOrEqual(framesToSeconds(1));
    const start = exportAudioSample(project.music.start);
    const sourceIn = exportAudioSample(project.music.sourceIn); const selected = exportAudioSample(project.music.sourceOut) - sourceIn;
    for (const frame of [1, 6, 9, 15, 24, 29, 33]) {
      const center = exportAudioSample(frame); const first = center - 240; const count = 480;
      let expectedEnergy = 0;
      for (let sample = first; sample < first + count; sample++) {
        const offset = sample - start;
        const original = offset < 0 ? 0 : audioSamples[sourceIn + offset % selected]!;
        const gain = musicGainAt(project.music, sample * 30000 / (48000 * 1001));
        expectedEnergy += (original * gain) ** 2;
      }
      const expected = Math.sqrt(expectedEnergy / count);
      expect(Math.abs(rms(samples, first, count) - expected), `music envelope frame ${frame}`).toBeLessThan(0.004);
    }
    // Selected range contains 880 Hz; looping the whole original would expose 220/1760.
    for (const frame of [10, 16, 22]) {
      const first = exportAudioSample(frame); const count = 2048;
      const strength = (frequency: number): number => {
        let real = 0; let imaginary = 0;
        for (let index = 0; index < count; index++) {
          const phase = 2 * Math.PI * frequency * index / 48000;
          real += samples[first + index]! * Math.cos(phase); imaginary += samples[first + index]! * Math.sin(phase);
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
      project.music = { mediaId: audio.id, sourceIn: 6, sourceOut: 14, start, duration: 8, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false };
      const result = await completed(project); const samples = await rawAudio(config, result.filename);
      expect(result.receipt.verification.hasAudio).toBe(true);
      if (start === 20) expect(rms(samples, 0, exportAudioSample(12))).toBeLessThan(0.0001);
      else {
        expect(rms(samples, exportAudioSample(5), 480)).toBeGreaterThan(0.07);
        expect(rms(samples, exportAudioSample(11), 480)).toBeLessThan(0.001);
      }
    }
  }, 120_000);

  it('cancels an active raw retimer, removes its entire job directory and preserves successful exports and saved edits', async () => {
    const originalSuccessful = await readFile(path.join(successfulDirectory, 'export.mp4'));
    const submit = fixture.jobs.submit.bind(fixture.jobs);
    let cancelled = false;
    const spy = vi.spyOn(fixture.jobs, 'submit').mockImplementation((kind, label, task, settled = null) => submit(kind, label, async (context) => task({
      ...context, update: (progress, message) => {
        context.update(progress, message);
        if (!cancelled && message.startsWith('Retiming original')) { cancelled = true; fixture.jobs.cancel(context.id); }
      },
    }), settled));
    let id = '';
    try {
      const job = startExport(document(36), 'draft720', fixture.library); id = job.id;
      const result = await fixture.jobs.wait(id); expect(result.state, result.message).toBe('cancelled');
      expect(result.outputUrl).toBeNull(); expect(result.receiptUrl).toBeNull(); expect(cancelled).toBe(true);
    } finally { spy.mockRestore(); }
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(id);
    expect(await readFile(path.join(successfulDirectory, 'export.mp4'))).toEqual(originalSuccessful);
    expect(await readFile(path.join(directory, 'projects', `${fixture.document.id}.json`))).toEqual(savedDocument);
  });

  it('cleans failed encodes and refuses to overwrite or remove an existing UUID job directory', async () => {
    const goodBinary = fixture.library.config.ffmpeg;
    let failedId = '';
    try {
      fixture.library.config.ffmpeg = '/nonexistent-pascap-export-ffmpeg';
      const job = startExport(document(3), 'draft720', fixture.library); failedId = job.id;
      expect((await fixture.jobs.wait(job.id)).state).toBe('failed');
    } finally { fixture.library.config.ffmpeg = goodBinary; }
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(failedId);
    const id = path.basename(successfulDirectory);
    const before = await readFile(path.join(successfulDirectory, 'receipt.json'));
    await expect(renderExport(document(3), 'draft720', fixture.library, { id, signal: new AbortController().signal, update: () => {} })).rejects.toThrow('EEXIST');
    expect(await readFile(path.join(successfulDirectory, 'receipt.json'))).toEqual(before);
    const badAudioJob = startExport({ ...document(3), music: { mediaId: audio.id, sourceIn: 0, sourceOut: 100, start: 0, duration: 3,
      gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false } }, 'draft720', fixture.library, () => audio);
    const badAudio = await fixture.jobs.wait(badAudioJob.id); expect(badAudio.state).toBe('failed'); expect(badAudio.message).toContain('source bounds');
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(badAudioJob.id);
    // Direct cancellation before directory creation cannot leave orphan scratch.
    const controller = new AbortController(); controller.abort(); const cancelledId = randomUUID();
    await expect(renderExport(document(3), 'draft720', fixture.library, { id: cancelledId, signal: controller.signal, update: () => {} })).rejects.toThrow('cancelled');
    expect(await readdir(path.join(directory, 'renders'))).not.toContain(cancelledId);
  });
});