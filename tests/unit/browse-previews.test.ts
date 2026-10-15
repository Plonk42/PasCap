import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { BrowsePreviews, PREVIEW_LIMITS } from '../../src/server/browse-previews.js';
import { createConfig } from '../../src/server/config.js';
import { ServiceError } from '../../src/server/errors.js';
import { runProcess } from '../../src/server/process.js';

// No unit test launches FFmpeg/FFprobe or touches a user's recordings.
vi.mock('../../src/server/process.js', () => ({ runProcess: vi.fn() }));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const temporary: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const host = { host: '127.0.0.1:4318' };

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pascap-previews-unit-'));
  temporary.push(root);
  const sources = path.join(root, 'recordings');
  const dataDir = path.join(root, 'cache');
  await fs.mkdir(sources);
  const config = createConfig({
    dataDir,
    mediaRoots: [sources],
    webDir: path.join(root, 'absent-web'),
    port: 4318,
    ffmpeg: '/unit-tests-never-run-ffmpeg',
    ffprobe: '/unit-tests-never-run-ffprobe',
    allowedHosts: new Set(['127.0.0.1:4318']),
    allowedOrigins: new Set(['http://127.0.0.1:4318']),
  });
  return { root, sources, dataDir, config };
}

async function service() {
  const fixture = await setup();
  const created = await createApp(fixture.config);
  services.push(created);
  return { ...fixture, app: created.app };
}

async function original(directory: string, name = 'DJI_0468.MP4'): Promise<string> {
  const filename = path.join(directory, name);
  await fs.writeFile(filename, `disposable original bytes: ${name}`);
  return filename;
}

function previewUrl(filename: string): string {
  return `/api/footage/preview?${new URLSearchParams({ path: filename })}`;
}

function fakeNative(duration = '8.000000\n') {
  return async (binary: string, _args: string[], options: Parameters<typeof runProcess>[2] = {}) => {
    options.signal?.throwIfAborted();
    return Buffer.from(binary.endsWith('ffprobe') ? duration : JPEG);
  };
}

/** Native calls that run until cancelled, to observe the concurrency bound. */
function hangingNative() {
  const started: { binary: string; file: string; signal: AbortSignal | undefined; finish: () => void }[] = [];
  vi.mocked(runProcess).mockImplementation(
    (binary, args, options = {}) =>
      new Promise<Buffer>((resolve, reject) => {
        const finish = (): void => resolve(Buffer.from(binary.endsWith('ffprobe') ? '4\n' : JPEG));
        started.push({
          binary,
          file: args.at(binary.endsWith('ffprobe') ? -1 : args.indexOf('-i') + 1)!,
          signal: options.signal,
          finish,
        });
        options.signal?.addEventListener('abort', () => reject(new ServiceError('Job cancelled.', 499)), {
          once: true,
        });
      }),
  );
  return started;
}

async function listFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(directory, { recursive: true })).map(String).sort();
}

beforeEach(() => {
  vi.mocked(runProcess).mockReset().mockImplementation(fakeNative());
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((created) => created.app.close()));
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('Import dialog recording previews', () => {
  it('reads one keyframe near the middle, caches the JPEG outside the footage and revalidates by identity', async () => {
    const { app, sources, dataDir } = await service();
    const filename = await original(sources);
    const bytes = await fs.readFile(filename);
    const sourcesBefore = await listFiles(sources);

    const first = await app.inject({ method: 'GET', url: previewUrl(filename), headers: host });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.rawPayload.equals(JPEG)).toBe(true);
    const [probe, extract] = vi.mocked(runProcess).mock.calls;
    expect(probe?.[0]).toBe('/unit-tests-never-run-ffprobe');
    expect(probe?.[1]).toEqual(expect.arrayContaining(['format=duration', filename]));
    expect(extract?.[0]).toBe('/unit-tests-never-run-ffmpeg');
    const args = extract![1];
    // Seek in the input to the middle and demux keyframes only: the original is never read through.
    expect(args.slice(args.indexOf('-discard'), args.indexOf('-i') + 2)).toEqual([
      '-discard',
      'nokey',
      '-noaccurate_seek',
      '-copyts',
      '-ss',
      '4.000',
      '-i',
      filename,
    ]);
    expect(args).toEqual(expect.arrayContaining(['-frames:v', '1', '-threads', '1']));
    expect(args.at(-1)).toBe('pipe:1');
    expect(extract?.[2]?.maxBytes).toBe(PREVIEW_LIMITS.imageBytes);

    const cached = await app.inject({ method: 'GET', url: previewUrl(filename), headers: host });
    expect(cached.rawPayload.equals(JPEG)).toBe(true);
    expect(cached.headers['etag']).toBe(first.headers['etag']);
    const unchanged = await app.inject({
      method: 'GET',
      url: previewUrl(filename),
      headers: { ...host, 'if-none-match': String(first.headers['etag']) },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload).toHaveLength(0);
    expect(runProcess).toHaveBeenCalledTimes(2);

    // Browsing never writes next to the originals, registers or prepares anything.
    expect(await listFiles(sources)).toEqual(sourcesBefore);
    expect((await fs.readFile(filename)).equals(bytes)).toBe(true);
    expect((await listFiles(path.join(dataDir, 'browse-previews'))).filter((name) => name.endsWith('.jpg'))).toEqual([
      `${String(first.headers['etag']).slice(1, -1)}.jpg`,
    ]);
    expect((await app.inject({ method: 'GET', url: '/api/media', headers: host })).json()).toEqual({
      assets: [],
      missing: [],
    });
    expect((await app.inject({ method: 'GET', url: '/api/jobs', headers: host })).json()).toEqual({ jobs: [] });

    await fs.appendFile(filename, ' replaced');
    const replaced = await app.inject({
      method: 'GET',
      url: previewUrl(filename),
      headers: { ...host, 'if-none-match': String(first.headers['etag']) },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.headers['etag']).not.toBe(first.headers['etag']);
    expect(runProcess).toHaveBeenCalledTimes(4);
  });

  it('keeps previews inside approved roots, to regular video files, before running any native tool', async () => {
    const { app, root, sources, dataDir } = await service();
    const outside = await original(root, 'Outside.mp4');
    const notVideo = await original(sources, 'Notes.txt');
    const target = await original(sources, 'Target.mp4');
    await fs.symlink(target, path.join(sources, 'Link.mp4'));
    await fs.mkdir(path.join(sources, 'Folder.mp4'));
    const cases: [string, number][] = [
      [outside, 403],
      [notVideo, 400],
      [path.join(sources, 'Missing.mp4'), 404],
      [path.join(sources, 'Link.mp4'), 422],
      [path.join(sources, 'Folder.mp4'), 422],
      [`${sources}/../recordings/Target.mp4`, 400],
      ['relative/Target.mp4', 400],
      [path.join(dataDir, 'browse-previews', 'x.mp4'), 403],
    ];
    for (const [filename, status] of cases) {
      const response = await app.inject({ method: 'GET', url: previewUrl(filename), headers: host });
      expect(response.statusCode, filename).toBe(status);
      expect(response.json()).toEqual({ error: expect.any(String) });
    }
    expect((await app.inject({ method: 'GET', url: '/api/footage/preview', headers: host })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: previewUrl(target),
          headers: { host: '127.0.0.1:4318', 'sec-fetch-site': 'cross-site' },
        })
      ).statusCode,
    ).toBe(403);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('reports undecodable files once, with an explicit reason, and does not cache a picture for them', async () => {
    const { app, sources, dataDir } = await service();
    const broken = await original(sources, 'DJI_0999.MP4');
    const empty = await original(sources, 'Empty.mp4');
    vi.mocked(runProcess).mockImplementation(async (binary, args) => {
      if (binary.endsWith('ffprobe') && args.includes(broken))
        throw new ServiceError('/unit-tests-never-run-ffprobe exited 1: moov atom not found', 422);
      return Buffer.from(binary.endsWith('ffprobe') ? 'N/A\n' : '');
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({ method: 'GET', url: previewUrl(broken), headers: host });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'No preview: this file could not be decoded as video.' });
    }
    expect(runProcess).toHaveBeenCalledTimes(1);
    // Unknown durations seek to the start; no decoded picture is a failure too.
    const response = await app.inject({ method: 'GET', url: previewUrl(empty), headers: host });
    expect(response.statusCode).toBe(422);
    expect(vi.mocked(runProcess).mock.calls[2]?.[1]).toEqual(expect.arrayContaining(['-ss', '0.000']));
    await expect(fs.readdir(path.join(dataDir, 'browse-previews'))).rejects.toThrow();
  });

  it('does not remember failures that are not about the file, such as a missing FFmpeg', async () => {
    const { app, sources } = await service();
    const filename = await original(sources);
    vi.mocked(runProcess).mockRejectedValueOnce(new ServiceError('Cannot start ffprobe: ENOENT', 503));
    const missing = await app.inject({ method: 'GET', url: previewUrl(filename), headers: host });
    expect(missing.statusCode).toBe(503);
    const retried = await app.inject({ method: 'GET', url: previewUrl(filename), headers: host });
    expect(retried.statusCode).toBe(200);
  });

  it('refuses a recording that changed while its preview was read', async () => {
    const { app, sources, dataDir } = await service();
    const filename = await original(sources);
    vi.mocked(runProcess).mockImplementation(async (binary) => {
      if (binary.endsWith('ffprobe')) return Buffer.from('4\n');
      await fs.appendFile(filename, ' still recording');
      return JPEG;
    });
    const response = await app.inject({ method: 'GET', url: previewUrl(filename), headers: host });
    expect(response.statusCode).toBe(409);
    await expect(fs.readdir(path.join(dataDir, 'browse-previews'))).rejects.toThrow();
  });

  it('runs at most two reads at once, queues a bounded number and cancels queued or running reads', async () => {
    const { config, sources } = await setup();
    const previews = new BrowsePreviews(config);
    const started = hangingNative();
    const files = await Promise.all(
      Array.from({ length: PREVIEW_LIMITS.active + PREVIEW_LIMITS.waiting + 1 }, (_, index) =>
        original(sources, `Clip ${index}.mp4`),
      ),
    );
    const controllers = files.map(() => new AbortController());
    const settled = new Map<number, unknown>();
    const results = files.map((filename, index) =>
      previews.get(filename, controllers[index]!.signal).then(
        () => settled.set(index, 'ready').get(index),
        (error: unknown) => settled.set(index, error instanceof ServiceError ? error.statusCode : error).get(index),
      ),
    );
    await vi.waitFor(() => expect([...settled.values()]).toEqual([503]));
    expect(started).toHaveLength(PREVIEW_LIMITS.active);
    const running = started.map((process) => files.indexOf(process.file));
    const queued = files.map((_, index) => index).filter((index) => !running.includes(index) && !settled.has(index));
    expect(queued).toHaveLength(PREVIEW_LIMITS.waiting);

    controllers[queued[0]!]!.abort();
    expect(await results[queued[0]!]).toBe(499);
    controllers[running[0]!]!.abort();
    expect(started[0]!.signal?.aborted).toBe(true);
    expect(await results[running[0]!]).toBe(499);
    // The freed slot goes to the next queued read, not the cancelled one.
    await vi.waitFor(() => expect(started).toHaveLength(PREVIEW_LIMITS.active + 1));
    expect(queued.slice(1)).toContain(files.indexOf(started.at(-1)!.file));

    started[1]!.finish();
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(PREVIEW_LIMITS.active + 1));
    started.at(-1)!.finish();
    controllers.forEach((controller) => controller.abort());
    expect(await results[running[1]!]).toBe('ready');
    await Promise.all(results);
  });

  it('evicts the least recently shown previews beyond the cache limit', async () => {
    const { config, sources, dataDir } = await setup();
    const directory = path.join(dataDir, 'browse-previews');
    await fs.mkdir(directory, { recursive: true });
    const old = new Date('2026-01-01T00:00:00Z');
    await Promise.all(
      Array.from({ length: PREVIEW_LIMITS.cached }, async (_, index) => {
        const filename = path.join(directory, `${String(index).padStart(64, '0')}.jpg`);
        await fs.writeFile(filename, JPEG);
        await fs.utimes(filename, old, new Date(old.getTime() + index * 1000));
      }),
    );
    const preview = await new BrowsePreviews(config).get(await original(sources), new AbortController().signal);
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(Math.floor(PREVIEW_LIMITS.cached * 0.9));
    expect(names).toContain(`${preview.tag}.jpg`);
    expect(names).not.toContain(`${'0'.repeat(64)}.jpg`);
    expect(names).toContain(`${String(PREVIEW_LIMITS.cached - 1).padStart(64, '0')}.jpg`);
  });
});
