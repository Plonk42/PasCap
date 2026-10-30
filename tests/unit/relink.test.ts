import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { AudioLibrary } from '../../src/server/audio.js';
import { createConfig } from '../../src/server/config.js';
import { ServiceError } from '../../src/server/errors.js';
import { fingerprintFile, hashFile } from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary } from '../../src/server/library.js';
import { probeVideo } from '../../src/server/probe.js';
import { runProcess } from '../../src/server/process.js';
import * as storage from '../../src/server/storage.js';
import { audioAssetSchema } from '../../src/shared/audio.js';
import { registrySchema, type VideoMetadata } from '../../src/shared/media.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

// FFmpeg/FFprobe never run; hashing, identity, persistence and the job queue are real.
vi.mock('../../src/server/process.js', () => ({ runProcess: vi.fn() }));
vi.mock('../../src/server/probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/probe.js')>()),
  probeVideo: vi.fn(),
}));

const roots: string[] = [];
const queues: JobQueue[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

function metadata(): VideoMetadata {
  return {
    width: 160,
    height: 90,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    frameRate: { ...PROJECT_FPS },
    frameCount: 12,
    durationSeconds: framesToSeconds(12),
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorSpace: 'bt709',
    colorRange: 'tv',
    hasAudio: false,
  };
}
async function fakeProcess(
  _binary: string,
  args: string[],
  options: NonNullable<Parameters<typeof runProcess>[2]> = {},
): Promise<Buffer> {
  if (options.signal?.aborted) throw new ServiceError('Job canceled.', 499);
  const output = args.at(-1)!;
  if (output === 'pipe:1') return Buffer.alloc(160 * 90 * 3, 64);
  await writeFile(output, args.includes('-progress') ? 'mock verified proxy' : 'mock thumbnail');
  return Buffer.alloc(0);
}
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-relink-unit-'));
  roots.push(root);
  const [card, drive, dataDir] = ['card', 'drive', 'cache'].map((name) => path.join(root, name));
  await Promise.all([mkdir(card!), mkdir(drive!), mkdir(dataDir!)]);
  const config = createConfig({
    dataDir: dataDir!,
    webDir: path.join(root, 'absent-web'),
    port: 4318,
    ffmpeg: '/unit-tests-never-run-ffmpeg',
    ffprobe: '/unit-tests-never-run-ffprobe',
    allowedHosts: new Set(['127.0.0.1:4318']),
    allowedOrigins: new Set(['http://127.0.0.1:4318']),
    mediaRoots: [root],
  });
  return { card: card!, drive: drive!, config };
}
async function videoFixture() {
  const directories = await setup();
  const jobs = new JobQueue();
  queues.push(jobs);
  const library = new MediaLibrary(directories.config, jobs);
  await library.initialize();
  const original = path.join(directories.card, 'DJI_0523.MP4');
  const bytes = Buffer.from('disposable original bytes: flight over the ridge');
  await writeFile(original, bytes);
  const accepted = await library.addForEditing(original);
  expect((await jobs.wait(accepted.job!.id)).state).toBe('completed');
  return { ...directories, jobs, library, original, bytes, id: accepted.asset.id };
}
async function moveToDrive(original: string, drive: string): Promise<string> {
  const moved = path.join(drive, 'Flights', path.basename(original));
  await mkdir(path.dirname(moved));
  await copyFile(original, moved);
  await rm(original);
  return moved;
}

beforeEach(() => {
  vi.mocked(probeVideo).mockReset().mockResolvedValue(metadata());
  vi.mocked(runProcess).mockReset().mockImplementation(fakeProcess);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.app.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('full-content checksum', () => {
  it('hashes every byte and reports progress', async () => {
    const { card } = await setup();
    const filename = path.join(card, 'large.mp4');
    const bytes = Buffer.alloc(150 * 1024 * 1024 + 7, 3);
    bytes[bytes.length - 1] = 9;
    await writeFile(filename, bytes);
    const progress: number[] = [];
    expect(await hashFile(filename, undefined, (fraction) => progress.push(fraction))).toEqual({
      algorithm: 'sha256-full-v1',
      digest: sha256(bytes),
      size: bytes.length,
    });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((fraction) => fraction > 0 && fraction <= 1)).toBe(true);
  });

  it('stops when canceled', async () => {
    const { card } = await setup();
    const filename = path.join(card, 'clip.mp4');
    await writeFile(filename, Buffer.alloc(4 * 1024 * 1024));
    const controller = new AbortController();
    controller.abort();
    await expect(hashFile(filename, controller.signal)).rejects.toThrow('canceled');
  });

  it('is recorded and persisted by the first preparation', async () => {
    const { library, id, bytes, config } = await videoFixture();
    const expected = { algorithm: 'sha256-full-v1', digest: sha256(bytes), size: bytes.length };
    expect(library.get(id).content).toEqual(expected);
    const saved = registrySchema.parse(JSON.parse(await readFile(path.join(config.dataDir, 'videos.json'), 'utf8')));
    expect(saved.assets[0]!.content).toEqual(expected);
  });
});

describe('video relink', () => {
  it('points the recording at a verified moved copy, keeping its ID and proxy', async () => {
    const { library, jobs, id, original, drive, config } = await videoFixture();
    const before = library.get(id);
    const proxy = library.proxyPath(before);
    const moved = await moveToDrive(original, drive);
    expect(await library.missing()).toEqual([id]);

    const job = library.relink(id, moved);
    expect(job.kind).toBe('relink');
    const finished = await jobs.wait(job.id);
    expect(finished.state, finished.message).toBe('completed');

    const after = library.get(id);
    expect(after).toEqual({
      ...before,
      name: 'DJI_0523.MP4',
      sourcePath: moved,
      fingerprint: await fingerprintFile(moved),
    });
    expect(library.proxyPath(after)).toBe(proxy);
    expect(await library.missing()).toEqual([]);
    const saved = registrySchema.parse(JSON.parse(await readFile(path.join(config.dataDir, 'videos.json'), 'utf8')));
    expect(saved.assets[0]!.sourcePath).toBe(moved);
    // Importing the new location afterwards finds the same recording.
    expect((await library.addForEditing(moved)).asset.id).toBe(id);
    expect(library.list()).toHaveLength(1);
  });

  it('rejects same-name files with other content and keeps the old association', async () => {
    const { library, jobs, id, original, bytes, drive } = await videoFixture();
    const before = library.get(id);
    await rm(original);
    const sameSize = path.join(drive, 'DJI_0523.MP4');
    const altered = Buffer.from(bytes);
    altered[0] = 0;
    await writeFile(sameSize, altered);
    const failed = await jobs.wait(library.relink(id, sameSize).id);
    expect(failed.state).toBe('failed');
    expect(failed.message).toContain('different content');

    const shorter = path.join(drive, 'shorter.MP4');
    await writeFile(shorter, bytes.subarray(1));
    const rejected = await jobs.wait(library.relink(id, shorter).id);
    expect(rejected.message).toContain('different recording');
    expect(library.get(id)).toEqual(before);
  });

  it('keeps the old association when the registry write fails', async () => {
    const { library, jobs, id, original, drive } = await videoFixture();
    const before = library.get(id);
    const moved = await moveToDrive(original, drive);
    vi.spyOn(storage, 'atomicWrite').mockRejectedValueOnce(new Error('Disk full.'));
    const failed = await jobs.wait(library.relink(id, moved).id);
    expect(failed.state).toBe('failed');
    expect(library.get(id)).toEqual(before);
  });

  it('needs a recorded checksum', async () => {
    const { card, config } = await setup();
    const jobs = new JobQueue();
    queues.push(jobs);
    const library = new MediaLibrary(config, jobs);
    await library.initialize();
    const original = path.join(card, 'never-prepared.mp4');
    await writeFile(original, 'unprepared bytes');
    const asset = await library.register(original);
    expect(asset.content).toBeNull();
    expect(() => library.relink(asset.id, original)).toThrow('never prepared');
    expect(jobs.list()).toEqual([]);
  });

  it('refuses to register the old location again as the same recording', async () => {
    const { library, jobs, id, original, drive } = await videoFixture();
    const copy = path.join(drive, 'copy.MP4');
    await copyFile(original, copy);
    expect((await jobs.wait(library.relink(id, copy).id)).state).toBe('completed');
    // The old drive is reconnected: its unchanged file has the recording's first identity.
    await expect(library.addForEditing(original)).rejects.toThrow(`relinked to ${copy}`);
    expect(library.list()).toHaveLength(1);
  });

  it('is offered through the HTTP service', async () => {
    const { card, drive, config } = await setup();
    const service = await createApp(config);
    services.push(service);
    const original = path.join(card, 'clip.mp4');
    await writeFile(original, 'service original');
    const accepted = await service.library.addForEditing(original);
    await service.jobs.wait(accepted.job!.id);
    const moved = await moveToDrive(original, drive);
    const listed = await service.app.inject({ url: '/api/media', headers });
    expect(listed.json().missing).toEqual([accepted.asset.id]);
    const response = await service.app.inject({
      method: 'POST',
      url: `/api/media/${accepted.asset.id}/relink`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { path: moved },
    });
    expect(response.statusCode).toBe(202);
    expect((await service.jobs.wait(response.json().job.id)).state).toBe('completed');
    expect((await service.app.inject({ url: '/api/media', headers })).json().missing).toEqual([]);
  });
});

describe('music relink', () => {
  it('verifies the moved copy against the recorded checksum', async () => {
    const { card, drive, config } = await setup();
    const original = path.join(card, 'song.wav');
    const bytes = Buffer.from('disposable music bytes');
    await writeFile(original, bytes);
    const asset = audioAssetSchema.parse({
      id: 'audio-relink',
      name: 'song.wav',
      sourcePath: original,
      fingerprint: await fingerprintFile(original),
      content: await hashFile(original),
      metadata: { codec: 'pcm_s16le', sampleRate: 48000, channels: 2, durationSeconds: 1, frameCount: 30 },
      status: 'ready',
      error: null,
      waveform: [0.5],
    });
    await storage.atomicWrite(path.join(config.dataDir, 'music.json'), JSON.stringify({ version: 2, assets: [asset] }));
    const jobs = new JobQueue();
    queues.push(jobs);
    const audio = new AudioLibrary(config, jobs);
    await audio.initialize();
    const playback = audio.playbackPath(asset);
    const moved = await moveToDrive(original, drive);
    expect(await audio.missing()).toEqual([asset.id]);

    const wrong = path.join(drive, 'other.wav');
    await writeFile(wrong, 'other music bytes, same?');
    expect((await jobs.wait((await audio.relink(asset.id, wrong)).id)).state).toBe('failed');
    expect(audio.get(asset.id).sourcePath).toBe(original);

    const finished = await jobs.wait((await audio.relink(asset.id, moved)).id);
    expect(finished.state, finished.message).toBe('completed');
    expect(audio.get(asset.id)).toMatchObject({ id: asset.id, sourcePath: moved, waveform: [0.5] });
    expect(audio.playbackPath(audio.get(asset.id))).toBe(playback);
    expect(await audio.missing()).toEqual([]);
  });
});

describe('folder relink', () => {
  /** A service whose card folder holds prepared videos and one prepared music file. */
  async function folderFixture(videos: Record<string, string>) {
    const directories = await setup();
    const song = path.join(directories.card, 'Music', 'song.wav');
    await mkdir(path.dirname(song));
    await writeFile(song, 'disposable music bytes');
    const music = audioAssetSchema.parse({
      id: 'audio-folder',
      name: 'song.wav',
      sourcePath: song,
      fingerprint: await fingerprintFile(song),
      content: await hashFile(song),
      metadata: { codec: 'pcm_s16le', sampleRate: 48000, channels: 2, durationSeconds: 1, frameCount: 30 },
      status: 'ready',
      error: null,
      waveform: [0.5],
    });
    await storage.atomicWrite(
      path.join(directories.config.dataDir, 'music.json'),
      JSON.stringify({ version: 2, assets: [music] }),
    );
    const service = await createApp(directories.config);
    services.push(service);
    const ids: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(videos)) {
      await writeFile(path.join(directories.card, name), bytes);
      const accepted = await service.library.addForEditing(path.join(directories.card, name));
      await service.jobs.wait(accepted.job!.id);
      ids[name] = accepted.asset.id;
    }
    return { ...directories, service, ids, musicId: music.id };
  }
  async function relinkFolder(service: Awaited<ReturnType<typeof createApp>>, directory: string) {
    const response = await service.app.inject({
      method: 'POST',
      url: '/api/relink-folder',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { directory },
    });
    expect(response.statusCode, response.body).toBe(202);
    return service.jobs.wait(response.json().job.id);
  }

  it('relinks every missing video and music file found below the folder in one job', async () => {
    const { card, drive, service, ids, musicId } = await folderFixture({ 'a.mp4': 'flight a', 'b.mp4': 'flight b' });
    const moved = path.join(drive, 'Archive', '2026');
    await mkdir(path.dirname(moved));
    await rename(card, moved);
    expect((await service.library.missing()).sort()).toEqual(Object.values(ids).sort());

    const finished = await relinkFolder(service, drive);
    expect(finished.state, finished.message).toBe('completed');
    expect(finished.kind).toBe('relink');
    expect(finished.message).toBe('Relinked all 3 missing recordings');
    expect(service.library.get(ids['a.mp4']!).sourcePath).toBe(path.join(moved, 'a.mp4'));
    expect(service.library.get(ids['b.mp4']!).sourcePath).toBe(path.join(moved, 'b.mp4'));
    expect(service.audio.get(musicId).sourcePath).toBe(path.join(moved, 'Music', 'song.wav'));
    expect(await service.library.missing()).toEqual([]);
    expect(await service.audio.missing()).toEqual([]);
  });

  it('keeps each recording on its own same-name copy and reports what was not found', async () => {
    const { card, drive, service, ids } = await folderFixture({
      'a.mp4': 'same bytes',
      'b.mp4': 'same bytes',
      'c.mp4': 'flight c',
    });
    await Promise.all(['a.mp4', 'b.mp4'].map((name) => copyFile(path.join(card, name), path.join(drive, name))));
    // Same name and size as c.mp4, other content: never accepted.
    await writeFile(path.join(drive, 'c.mp4'), 'flight C');
    await rm(card, { recursive: true });

    const finished = await relinkFolder(service, drive);
    expect(finished.state, finished.message).toBe('completed');
    expect(finished.message).toBe('Relinked 2 of 4 missing recordings. Not found: c.mp4, song.wav');
    expect(service.library.get(ids['a.mp4']!).sourcePath).toBe(path.join(drive, 'a.mp4'));
    expect(service.library.get(ids['b.mp4']!).sourcePath).toBe(path.join(drive, 'b.mp4'));
    expect(service.library.get(ids['c.mp4']!).sourcePath).toBe(path.join(card, 'c.mp4'));
  });

  it('changes nothing when no missing recording is in the folder', async () => {
    const { card, drive, service, ids } = await folderFixture({ 'a.mp4': 'flight a' });
    await writeFile(path.join(drive, 'other.mp4'), 'flight z');
    await rm(card, { recursive: true });
    const finished = await relinkFolder(service, drive);
    expect(finished.state).toBe('failed');
    expect(finished.message).toContain('None of the 2 missing recordings');
    expect(service.library.get(ids['a.mp4']!).sourcePath).toBe(path.join(card, 'a.mp4'));
  });

  it('refuses a folder that does not exist', async () => {
    const { drive, service } = await folderFixture({});
    const response = await service.app.inject({
      method: 'POST',
      url: '/api/relink-folder',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { directory: path.join(drive, 'absent') },
    });
    expect(response.statusCode).toBe(404);
    expect(service.jobs.list()).toEqual([]);
  });
});
