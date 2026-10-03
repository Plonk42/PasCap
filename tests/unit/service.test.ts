import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../../src/shared/model.js';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { assertCacheOutsideSource, assertSourceIdentity, discoverVideos, fingerprintFile, parseByteRange } from '../../src/server/files.js';
import { ProjectStore } from '../../src/server/storage.js';
import { JobQueue } from '../../src/server/jobs.js';

const temporary: string[] = [];
async function temp() { const directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-unit-')); temporary.push(directory); return directory; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('HTTP byte ranges', () => {
  it('accepts bounded, open-ended and suffix ranges', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=0-999', 100)).toEqual({ start: 0, end: 99 });
  });
  it('rejects malformed, multi-range and unsatisfiable requests', () => {
    for (const header of ['bytes=100-', 'bytes=30-20', 'bytes=-0', 'bytes=-', 'bytes=0-2,5-8', 'frames=0-10']) expect(parseByteRange(header, 100)).toBeNull();
  });
});

describe('source safety', () => {
  it('rejects a cache equal to or inside the source folder', () => {
    expect(() => assertCacheOutsideSource('/recordings/flight', '/recordings/flight')).toThrow('cache must be outside');
    expect(() => assertCacheOutsideSource('/recordings/flight', '/recordings/flight/cache')).toThrow('cache must be outside');
  });
  it('accepts sibling caches and disposable sources in a dedicated subfolder', () => {
    expect(() => assertCacheOutsideSource('/recordings/flight', '/recordings/editor-cache')).not.toThrow();
    expect(() => assertCacheOutsideSource('/cache/synthetic-sources', '/cache')).not.toThrow();
  });
  it('discovers video only without following leaf or directory symlinks', async () => {
    const directory = await temp();
    await mkdir(path.join(directory, 'flight'));
    await writeFile(path.join(directory, 'flight', 'clip.MP4'), 'source');
    await writeFile(path.join(directory, 'photo.JPG'), 'photo');
    await symlink(path.join(directory, 'flight'), path.join(directory, 'linked-flight'));
    const result = await discoverVideos(directory);
    expect(result.files).toEqual([path.join(directory, 'flight', 'clip.MP4')]);
    expect(result.ignored).toBe(2);
    await expect(discoverVideos(path.join(directory, 'linked-flight'))).rejects.toThrow('Symlinks');
  });
  it('detects replacement/changed sources, never reassociates a path', async () => {
    const file = path.join(await temp(), 'video.mp4'); await writeFile(file, 'original bytes');
    const identity = await fingerprintFile(file);
    await assertSourceIdentity(file, identity, true);
    await writeFile(file, 'different bytes and size');
    await expect(assertSourceIdentity(file, identity, true)).rejects.toThrow('changed');
  });
  it('reports a missing original explicitly', async () => {
    const file = path.join(await temp(), 'video.mp4'); await writeFile(file, 'original bytes');
    const identity = await fingerprintFile(file); await rm(file);
    await expect(assertSourceIdentity(file, identity)).rejects.toThrow('original recording is missing');
  });
});

describe('atomic revision persistence', () => {
  it('increments revisions and rejects concurrent stale saves', async () => {
    const directory = await temp(); const store = new ProjectStore(directory); const project = createProject('flight', 'Flight');
    const results = await Promise.allSettled([store.save(project, 0), store.save(project, 0)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const saved = await store.load('flight'); expect(saved.revision).toBe(1);
    expect(JSON.parse(await readFile(path.join(directory, 'projects', 'flight.json'), 'utf8')).title).toBe('Flight');
    expect((await store.save({ ...saved, title: 'Renamed' }, 1)).revision).toBe(2);
  });
});

describe('loopback API boundary', () => {
  it('rejects hostile Host/Origin, arbitrary path downloads and invalid bodies', async () => {
    const service = await createApp(createConfig({ dataDir: await temp(), webDir: '/nonexistent-pascap-assets' }));
    try {
      expect((await service.app.inject({ url: '/api/health', headers: { host: 'evil.example' } })).statusCode).toBe(403);
      expect((await service.app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4318', origin: 'https://evil.example' } })).statusCode).toBe(403);
      expect((await service.app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4318' } })).statusCode).toBe(200);
      expect((await service.app.inject({ url: '/api/file?path=/etc/passwd', headers: { host: '127.0.0.1:4318' } })).statusCode).toBe(404);
      expect((await service.app.inject({ method: 'POST', url: '/api/media/import', headers: { host: '127.0.0.1:4318' }, payload: { directory: '/tmp' } })).statusCode).toBe(403);
      expect((await service.app.inject({ method: 'POST', url: '/api/media/import', headers: { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' }, payload: { directory: 42 } })).statusCode).toBe(400);
    } finally { await service.app.close(); }
  });
});

describe('bounded media queue', () => {
  it('serialises heavy jobs and cancels queued work', async () => {
    const queue = new JobQueue(); const order: string[] = []; let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.submit('prepare', 'first', async () => { order.push('first'); await gate; });
    const second = queue.submit('prepare', 'second', async () => { order.push('second'); });
    queue.cancel(second.id); release();
    expect((await queue.wait(first.id)).state).toBe('completed');
    expect((await queue.wait(second.id)).state).toBe('cancelled');
    expect(order).toEqual(['first']); await queue.close();
  });
  it('persists cancellation even when queued work never starts', async () => {
    const queue = new JobQueue(); let release = (): void => {}; let state = '';
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.submit('prepare', 'first', async () => gate);
    const second = queue.submit('prepare', 'second', async () => { throw new Error('Must not run'); }, async (job) => { state = job.state; });
    queue.cancel(second.id); release(); await queue.wait(first.id); await queue.wait(second.id);
    expect(state).toBe('cancelled'); await queue.close();
  });
});