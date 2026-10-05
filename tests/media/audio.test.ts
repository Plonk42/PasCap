import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioAssetSchema, type AudioAsset } from '../../src/shared/audio.js';
import { jobSchema } from '../../src/shared/media.js';
import { createApp } from '../../src/server/app.js';
import { AudioLibrary, probeAudio } from '../../src/server/audio.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { JobQueue } from '../../src/server/jobs.js';
import * as processes from '../../src/server/process.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

describe.skipIf(!enabled)('registered music · disposable lavfi audio only', () => {
  let directory: string;
  let sources: string;
  let config: ServiceConfig;
  let service: Awaited<ReturnType<typeof createApp>>;
  let tonePath: string;
  let silencePath: string;
  let cancelledPath: string;
  let changedPath: string;
  let original: Buffer;
  let tone: AudioAsset | null = null;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-audio-'));
    sources = path.join(directory, 'synthetic-sources');
    await mkdir(sources);
    tonePath = path.join(sources, 'tone.wav');
    silencePath = path.join(sources, 'silence.wav');
    cancelledPath = path.join(sources, 'cancelled.wav');
    changedPath = path.join(sources, 'changed.wav');
    config = createConfig({ dataDir: path.join(directory, 'cache'), webDir: path.join(directory, 'absent-web') });
    await processes.runProcess(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=44100:duration=2.2',
      '-c:a', 'pcm_s16le', '-threads', '2', tonePath,
    ]);
    await processes.runProcess(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '0.4',
      '-c:a', 'pcm_s16le', '-threads', '2', silencePath,
    ]);
    await copyFile(tonePath, cancelledPath);
    await copyFile(tonePath, changedPath);
    original = await readFile(tonePath);
    service = await createApp(config);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await service?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function registerReady(filename: string): Promise<AudioAsset> {
    const response = await service.app.inject({ method: 'POST', url: '/api/audio/register', headers, payload: { path: filename } });
    expect(response.statusCode, response.body).toBe(202);
    const registered = audioAssetSchema.parse(response.json().asset);
    const job = jobSchema.parse(response.json().job);
    expect(job.kind).toBe('audio');
    const finished = await service.jobs.wait(job.id);
    expect(finished.state, finished.message).toBe('completed');
    return service.audio.get(registered.id);
  }
  async function readyTone(): Promise<AudioAsset> {
    tone ??= await registerReady(tonePath);
    return tone;
  }

  it('registers and explicitly prepares AAC 48 kHz stereo plus bounded sample peaks without changing the source', async () => {
    const asset = await readyTone();
    expect(asset.status).toBe('ready');
    expect(asset.metadata.codec).toBe('pcm_s16le');
    expect(asset.metadata.sampleRate).toBe(44_100);
    expect(asset.metadata.channels).toBe(1);
    expect(asset.metadata.durationSeconds).toBeCloseTo(2.2, 6);
    expect(asset.metadata.frameCount).toBe(Math.floor(2.2 * 30_000 / 1001));
    const playback = service.audio.playbackPath(asset);
    expect(path.relative(config.dataDir, playback).startsWith('audio-assets/')).toBe(true);
    const metadata = await probeAudio(config, playback);
    expect(metadata.codec).toBe('aac');
    expect(metadata.sampleRate).toBe(48_000);
    expect(metadata.channels).toBe(2);
    expect(Math.abs(metadata.durationSeconds - asset.metadata.durationSeconds)).toBeLessThan(0.1);
    expect(asset.waveform.length).toBeGreaterThan(0);
    expect(asset.waveform.length).toBeLessThanOrEqual(2048);
    expect(asset.waveform.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1)).toBe(true);
    expect(Math.max(...asset.waveform)).toBeGreaterThan(0.03);
    expect(await readFile(tonePath)).toEqual(original);
    expect((await readdir(sources)).sort()).toEqual(['cancelled.wav', 'changed.wav', 'silence.wav', 'tone.wav']);
    expect(service.library.list()).toEqual([]);
    expect(service.audio.jobs).toBe(service.jobs);
  });

  it('serves only registered ready playback with safe GET/HEAD, suffix ranges and waveform metadata', async () => {
    const asset = await readyTone();
    const bytes = await readFile(service.audio.playbackPath(asset));
    const url = `/api/audio/${asset.id}/playback`;
    const head = await service.app.inject({ method: 'HEAD', url, headers });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-type']).toContain('audio/mp4');
    expect(head.headers['content-length']).toBe(String(bytes.length));
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(head.headers['x-content-type-options']).toBe('nosniff');
    const range = await service.app.inject({ url, headers: { ...headers, range: 'bytes=0-15' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 0-15/${bytes.length}`);
    expect(range.rawPayload).toEqual(bytes.subarray(0, 16));
    const rangeHead = await service.app.inject({ method: 'HEAD', url, headers: { ...headers, range: 'bytes=0-15' } });
    expect(rangeHead.statusCode).toBe(206);
    expect(rangeHead.body).toBe('');
    expect(rangeHead.headers['content-length']).toBe('16');
    const suffix = await service.app.inject({ url, headers: { ...headers, range: 'bytes=-8' } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload).toEqual(bytes.subarray(-8));
    const invalid = await service.app.inject({ url, headers: { ...headers, range: 'bytes=0-1,4-5' } });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe(`bytes */${bytes.length}`);
    expect((await service.app.inject({ url: `/api/audio/${asset.id}/waveform`, headers })).json()).toEqual({ waveform: asset.waveform });
    expect((await service.app.inject({ url, headers: { ...headers, origin: 'https://hostile.example' } })).statusCode).toBe(403);
    expect((await service.app.inject({ url: '/api/audio/bad%2Fid/playback', headers })).statusCode).toBe(400);
    expect((await service.app.inject({ url: '/api/audio/unregistered/playback', headers })).statusCode).toBe(404);
  });

  it('generates zero-valued peaks for silence and reloads ready metadata without starting work', async () => {
    const asset = await registerReady(silencePath);
    expect(asset.waveform.length).toBeGreaterThan(0);
    expect(asset.waveform.every((peak) => peak === 0)).toBe(true);
    const registry = JSON.parse(await readFile(path.join(config.dataDir, 'audio.json'), 'utf8'));
    expect(registry.version).toBe(1);
    const queue = new JobQueue();
    try {
      const reloaded = new AudioLibrary(config, queue);
      await reloaded.initialise();
      expect(reloaded.get(asset.id)).toEqual(asset);
      expect(queue.list()).toEqual([]);
      const external = reloaded.get(asset.id);
      external.metadata.channels = 99;
      external.waveform[0] = 1;
      expect(reloaded.get(asset.id)).toEqual(asset);
    } finally { await queue.close(); }
  });

  it('deduplicates concurrent preparations on the one shared queue, persists queued cancellation, and retries explicitly', async () => {
    const asset = await readyTone();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = service.jobs.submit('reference', 'Disposable queue gate', async () => gate);
    let queuedId = '';
    try {
      const [first, second] = await Promise.all([service.audio.prepare(asset.id), service.audio.prepare(asset.id)]);
      queuedId = first.id;
      expect(second.id).toBe(first.id);
      expect(first.state).toBe('queued');
      expect(service.jobs.list().filter((job) => job.state === 'running')).toHaveLength(1);
      expect(service.audio.get(asset.id).status).toBe('queued');
      const saved = JSON.parse(await readFile(path.join(config.dataDir, 'audio.json'), 'utf8'));
      expect(saved.assets.find((entry: AudioAsset) => entry.id === asset.id).status).toBe('queued');
      service.jobs.cancel(first.id);
    } finally { release(); }
    await service.jobs.wait(blocker.id);
    expect((await service.jobs.wait(queuedId)).state).toBe('cancelled');
    expect(service.audio.get(asset.id).status).toBe('error');
    expect(service.audio.get(asset.id).waveform).toEqual([]);
    const retry = await service.app.inject({ method: 'POST', url: `/api/audio/${asset.id}/prepare`, headers, payload: {} });
    expect(retry.statusCode, retry.body).toBe(202);
    const result = await service.jobs.wait(jobSchema.parse(retry.json().job).id);
    expect(result.state, result.message).toBe('completed');
    tone = service.audio.get(asset.id);
    expect(tone.metadata).toEqual(asset.metadata);
    expect((await readdir(service.audio.assetDir(asset))).some((name) => name.includes('.partial') || name.endsWith('.tmp'))).toBe(false);
    expect(await readFile(tonePath)).toEqual(original);
  });

  it('cancels a running native encode, removes partial output, persists the error and can retry', async () => {
    const actualRunProcess = processes.runProcess;
    let cancelled = false;
    const spy = vi.spyOn(processes, 'runProcess').mockImplementation((binary, args, options) => {
      const result = actualRunProcess(binary, args, options);
      if (binary === config.ffmpeg && args.includes('aac')) {
        const running = service.jobs.list().find((job) => job.kind === 'audio' && job.state === 'running');
        if (running) { cancelled = true; service.jobs.cancel(running.id); }
      }
      return result;
    });
    let asset: AudioAsset;
    try {
      const registered = await service.audio.register(cancelledPath);
      const finished = await service.jobs.wait(registered.job.id);
      expect(cancelled).toBe(true);
      expect(finished.state, finished.message).toBe('cancelled');
      asset = service.audio.get(registered.asset.id);
      expect(asset.status).toBe('error');
      expect(asset.waveform).toEqual([]);
      expect(await readdir(service.audio.assetDir(asset))).toEqual([]);
      const saved = JSON.parse(await readFile(path.join(config.dataDir, 'audio.json'), 'utf8'));
      expect(saved.assets.find((entry: AudioAsset) => entry.id === asset.id).status).toBe('error');
      expect(await readFile(cancelledPath)).toEqual(original);
    } finally { spy.mockRestore(); }
    const retry = await service.audio.prepare(asset.id);
    const finished = await service.jobs.wait(retry.id);
    expect(finished.state, finished.message).toBe('completed');
    expect(service.audio.get(asset.id).metadata).toEqual(asset.metadata);
  });

  it('accepts MP3 cover artwork, prepares audio-only playback and preserves original bytes', async () => {
    const filename = path.join(sources, 'covered.mp3');
    const silent = path.join(sources, 'silent.mp3');
    const cover = path.join(sources, 'cover.jpg');
    // Twenty silent MPEG-1 Layer III frames: 128 kb/s, 44.1 kHz, mono,
    // no padding, zero side information/main data. No optional MP3 encoder.
    const frame = Buffer.alloc(417);
    frame.set([0xff, 0xfb, 0x90, 0xc4]);
    await writeFile(silent, Buffer.concat(Array.from({ length: 20 }, () => frame)));
    await processes.runProcess(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32',
      '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '2', '-filter_threads', '2', cover,
    ]);
    await processes.runProcess(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', silent, '-i', cover,
      '-map', '0:a:0', '-map', '1:v:0', '-c', 'copy', '-disposition:v:0', 'attached_pic', filename,
    ]);
    const sourceProbe = JSON.parse((await processes.runProcess(config.ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_type:stream_disposition=attached_pic', '-of', 'json', filename,
    ])).toString('utf8'));
    expect(sourceProbe.streams).toEqual([
      { codec_type: 'audio', disposition: { attached_pic: 0 } },
      { codec_type: 'video', disposition: { attached_pic: 1 } },
    ]);
    const bytes = await readFile(filename);
    const asset = await registerReady(filename);
    expect(asset.metadata.codec).toBe('mp3');
    expect(asset.status).toBe('ready');
    expect(asset.waveform.length).toBeGreaterThan(0);
    const playback = JSON.parse((await processes.runProcess(config.ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', service.audio.playbackPath(asset),
    ])).toString('utf8'));
    expect(playback.streams).toEqual([{ codec_type: 'audio' }]);
    expect(await readFile(filename)).toEqual(bytes);
  });

  it('rejects video soundtracks, multi-audio streams and sub-frame sources without registering or preparing them', async () => {
    const multiple = path.join(sources, 'two-streams.mka');
    const short = path.join(sources, 'too-short.wav');
    const video = path.join(sources, 'soundtrack.mp4');
    await processes.runProcess(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=duration=0.2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=0.2', '-map', '0:a:0', '-map', '1:v:0',
      '-c:a', 'aac', '-c:v', 'libx264', '-threads', '2', '-filter_threads', '2', video,
    ]);
    await processes.runProcess(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.2', '-map', '0:a:0', '-map', '1:a:0', '-c:a', 'pcm_s16le', '-threads', '2', multiple,
    ]);
    await processes.runProcess(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=duration=0.01', '-c:a', 'pcm_s16le', '-threads', '2', short,
    ]);
    const before = service.audio.list();
    const jobs = service.jobs.list();
    const response = await service.app.inject({ method: 'POST', url: '/api/audio/register', headers, payload: { path: multiple } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('exactly one audio stream');
    const videoResponse = await service.app.inject({ method: 'POST', url: '/api/audio/register', headers, payload: { path: video } });
    expect(videoResponse.statusCode).toBe(422);
    expect(videoResponse.json().error).toContain('no video footage');
    expect((await service.app.inject({ method: 'POST', url: '/api/audio/register', headers, payload: { path: short } })).statusCode).toBe(422);
    expect(service.audio.list()).toEqual(before);
    expect(service.jobs.list()).toEqual(jobs);
  });

  it('rejects source symlinks and caches inside the source tree, and never serves cached symlinks', async () => {
    const asset = await readyTone();
    const links = path.join(directory, 'synthetic-links');
    await mkdir(links);
    const sourceLink = path.join(links, 'tone-link.wav');
    const folderLink = path.join(links, 'source-link');
    await symlink(tonePath, sourceLink);
    await symlink(sources, folderLink);
    await expect(service.audio.register(sourceLink)).rejects.toThrow('Symlinks');
    await expect(service.audio.register(path.join(folderLink, 'tone.wav'))).rejects.toThrow('Symlinks');
    const queue = new JobQueue();
    try {
      const unsafe = new AudioLibrary(createConfig({ dataDir: path.join(sources, 'must-not-exist') }), queue);
      await expect(unsafe.register(tonePath)).rejects.toThrow('cache must be outside');
      expect((await readdir(sources)).includes('must-not-exist')).toBe(false);
    } finally { await queue.close(); }
    const playback = service.audio.playbackPath(asset);
    const backup = `${playback}.synthetic-backup`;
    await rename(playback, backup);
    await symlink(tonePath, playback);
    try {
      expect((await service.app.inject({ url: `/api/audio/${asset.id}/playback`, headers })).statusCode).toBe(422);
      expect((await service.app.inject({ method: 'HEAD', url: `/api/audio/${asset.id}/playback`, headers })).statusCode).toBe(422);
      expect((await lstat(playback)).isSymbolicLink()).toBe(true);
      expect(await readFile(tonePath)).toEqual(original);
    } finally { await rm(playback, { force: true }); await rename(backup, playback); }
  });

  it('rebuilds missing or damaged regular caches only on an explicit retry', async () => {
    const asset = await readyTone();
    const playback = service.audio.playbackPath(asset);
    await rm(playback);
    expect((await service.app.inject({ url: `/api/audio/${asset.id}/playback`, headers })).statusCode).toBe(409);
    const missing = await service.audio.prepare(asset.id);
    expect((await service.jobs.wait(missing.id)).state).toBe('completed');
    await writeFile(playback, 'damaged disposable cached audio');
    const damaged = await service.audio.prepare(asset.id);
    const result = await service.jobs.wait(damaged.id);
    expect(result.state, result.message).toBe('completed');
    tone = service.audio.get(asset.id);
    expect(tone.status).toBe('ready');
    expect(tone.metadata).toEqual(asset.metadata);
    expect(await readFile(tonePath)).toEqual(original);
  });

  it('rejects changed source identities for playback, waveform and retry without mutating registered metadata', async () => {
    const asset = await registerReady(changedPath);
    await appendFile(changedPath, '\0changed disposable source');
    const before = service.jobs.list();
    expect((await service.app.inject({ url: `/api/audio/${asset.id}/playback`, headers })).statusCode).toBe(409);
    expect((await service.app.inject({ method: 'HEAD', url: `/api/audio/${asset.id}/playback`, headers })).statusCode).toBe(409);
    expect((await service.app.inject({ url: `/api/audio/${asset.id}/waveform`, headers })).statusCode).toBe(409);
    expect((await service.app.inject({ method: 'POST', url: `/api/audio/${asset.id}/prepare`, headers, payload: {} })).statusCode).toBe(409);
    expect(service.audio.get(asset.id)).toEqual(asset);
    expect(service.jobs.list()).toEqual(before);
  });
});