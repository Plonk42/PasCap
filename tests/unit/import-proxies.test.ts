import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { ServiceError } from '../../src/server/errors.js';
import * as files from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary, MediaQueueError, type AddForEditingResult, type ImportForEditingResult } from '../../src/server/library.js';
import { probeVideo } from '../../src/server/probe.js';
import { runProcess } from '../../src/server/process.js';
import * as storage from '../../src/server/storage.js';
import { mediaAssetSchema, registrySchema, type MediaAsset, type VideoMetadata } from '../../src/shared/media.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

// No test in this file can launch FFmpeg/FFprobe. File identity, discovery,
// persistence and the one-worker JobQueue remain real, in disposable directories.
vi.mock('../../src/server/process.js', () => ({ runProcess: vi.fn() }));
vi.mock('../../src/server/probe.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../src/server/probe.js')>(),
    probeVideo: vi.fn(),
}));

const roots: string[] = [];
const queues: JobQueue[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const releases: (() => void)[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

function metadata(): VideoMetadata {
    return {
        width: 160, height: 90, codec: 'h264', pixelFormat: 'yuv420p', frameRate: { ...PROJECT_FPS },
        frameCount: 12, durationSeconds: framesToSeconds(12), colourPrimaries: 'bt709',
        colourTransfer: 'bt709', colourSpace: 'bt709', colourRange: 'tv', hasAudio: false,
    };
}
function prepared(): NonNullable<MediaAsset['prepared']> {
    return {
        profile: 'h264-720p-bt709-gop15-v1', width: 160, height: 90, thumbnailFrames: [0, 3, 6, 9, 11],
        verification: { frameCount: 12, samples: [0, 5, 11].map((frame) => ({ frame, meanAbsoluteError8Bit: 0 })), verifiedAt: '2026-10-03T00:00:00.000Z' },
    };
}
function deferred() {
    let resolve = (): void => { };
    const promise = new Promise<void>((done) => { resolve = done; });
    releases.push(resolve);
    return { promise, resolve };
}
function untilReleased(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = (): void => { reject(new ServiceError('Job cancelled.', 499)); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
    });
}
function blockWorker(jobs: JobQueue) {
    const gate = deferred();
    const job = jobs.submit('reference', 'test-only worker gate', async (context) => untilReleased(gate.promise, context.signal));
    return { job, release: gate.resolve };
}
async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-import-proxies-unit-'));
    roots.push(root);
    const sources = path.join(root, 'sources');
    const dataDir = path.join(root, 'cache');
    await Promise.all([mkdir(sources), mkdir(dataDir)]);
    const config = createConfig({
        dataDir, webDir: path.join(root, 'absent-web'), port: 4318,
        ffmpeg: '/unit-tests-never-run-ffmpeg', ffprobe: '/unit-tests-never-run-ffprobe',
        allowedHosts: new Set(['127.0.0.1:4318']), allowedOrigins: new Set(['http://127.0.0.1:4318']),
    });
    return { root, sources, config };
}
async function fixture() {
    const directories = await setup();
    const jobs = new JobQueue(); queues.push(jobs);
    const library = new MediaLibrary(directories.config, jobs);
    await library.initialise();
    return { ...directories, library, jobs };
}
async function serviceFixture() {
    const directories = await setup();
    const service = await createApp(directories.config); services.push(service);
    return { ...directories, ...service };
}
async function source(directory: string, name = 'clip.mp4'): Promise<string> {
    const filename = path.join(directory, name);
    await writeFile(filename, `disposable original bytes: ${name}`);
    return filename;
}
async function savedAssets(directory: string): Promise<MediaAsset[]> {
    return registrySchema.parse(JSON.parse(await readFile(path.join(directory, 'library.json'), 'utf8'))).assets;
}
async function fakeProcess(_binary: string, args: string[], options: NonNullable<Parameters<typeof runProcess>[2]> = {}): Promise<Buffer> {
    if (options.signal?.aborted) throw new ServiceError('Job cancelled.', 499);
    const output = args.at(-1);
    if (!output) throw new Error('Expected an output argument.');
    if (output === 'pipe:1') return Buffer.alloc(160 * 90 * 3, 64);
    await writeFile(output, args.includes('-progress') ? 'mock verified proxy' : 'mock thumbnail');
    return Buffer.alloc(0);
}

beforeEach(() => {
    vi.mocked(probeVideo).mockReset().mockResolvedValue(metadata());
    vi.mocked(runProcess).mockReset().mockImplementation(fakeProcess);
});
afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.all(services.splice(0).map((service) => service.app.close()));
    await Promise.all(queues.splice(0).map((queue) => queue.close()));
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('raw registration and startup stay non-queuing', () => {
    it('preserves the raw register/importFolder contract for setup scripts', async () => {
        const { sources, library, jobs } = await fixture();
        const [first] = await Promise.all([source(sources, 'a.mp4'), source(sources, 'b.mov')]);
        expect((await library.register(first!)).status).toBe('registered');
        const imported = await library.importFolder(sources);
        expect(Object.keys(imported).sort()).toEqual(['assets', 'errors', 'ignored']);
        expect(imported.assets.map((asset) => asset.status)).toEqual(['registered', 'registered']);
        expect(imported.errors).toEqual([]);
        expect(jobs.list()).toEqual([]);
        expect(runProcess).not.toHaveBeenCalled();
    });

    it('does not probe or enqueue any existing registry entry on application startup', async () => {
        const { sources, config, library } = await fixture();
        const statuses: MediaAsset['status'][] = ['registered', 'queued', 'preparing', 'error', 'ready'];
        const assets = await Promise.all(statuses.map(async (status, index) => {
            const asset = await library.register(await source(sources, `${index}.mp4`));
            return mediaAssetSchema.parse({ ...asset, status, error: status === 'error' ? 'Previous failure' : null, prepared: status === 'ready' || status === 'preparing' ? prepared() : null });
        }));
        const contents = JSON.stringify(registrySchema.parse({ version: 1, assets }));
        await writeFile(path.join(config.dataDir, 'library.json'), contents);
        vi.mocked(probeVideo).mockClear();
        const service = await createApp(config); services.push(service);
        expect(service.jobs.list()).toEqual([]);
        expect(service.library.list().map((asset) => asset.status)).toEqual(['registered', 'error', 'error', 'error', 'ready']);
        expect(service.library.get(assets[1]!.id).error).toContain('Retry explicitly');
        expect(await readFile(path.join(config.dataDir, 'library.json'), 'utf8')).toBe(contents);
        expect(probeVideo).not.toHaveBeenCalled();
        expect(runProcess).not.toHaveBeenCalled();
    });
});

describe('editing import partial-result contract', () => {
    it('separates rejected sources from queue failures and preserves registered additions', async () => {
        const { sources, config, library, jobs } = await fixture();
        blockWorker(jobs);
        await Promise.all([source(sources, 'a-queue-error.mp4'), source(sources, 'b-good.mp4'), source(sources, 'c-rejected.mov'), source(sources, 'notes.txt')]);
        vi.mocked(probeVideo).mockImplementation(async (_config, filename) => {
            if (filename.endsWith('c-rejected.mov')) throw new ServiceError('Unsupported timing.', 422);
            return metadata();
        });
        const submit = vi.spyOn(jobs, 'submit').mockImplementationOnce(() => { throw new ServiceError('Worker unavailable.', 503); });
        const imported = await library.importForEditing(sources);
        expect(Object.keys(imported).sort()).toEqual(['added', 'assets', 'errors', 'existing', 'ignored', 'jobs', 'queueErrors']);
        expect(imported).toMatchObject({ added: 2, existing: 0, ignored: 1 });
        expect(imported.assets.map((asset) => [asset.name, asset.status])).toEqual([['a-queue-error.mp4', 'error'], ['b-good.mp4', 'queued']]);
        expect(imported.errors).toEqual([{ path: path.join(sources, 'c-rejected.mov'), message: 'Unsupported timing.' }]);
        expect(imported.queueErrors).toEqual([{ mediaId: imported.assets[0]!.id, message: expect.stringContaining('Worker unavailable') }]);
        expect(imported.jobs).toHaveLength(1);
        expect(imported.jobs[0]).toMatchObject({ kind: 'prepare', label: 'b-good.mp4', state: 'queued' });
        expect((await savedAssets(config.dataDir)).map((asset) => asset.id)).toEqual(imported.assets.map((asset) => asset.id));
        expect(runProcess).not.toHaveBeenCalled();

        const repeated = await library.importForEditing(sources);
        expect(repeated).toMatchObject({ added: 0, existing: 2, queueErrors: [] });
        expect(repeated.jobs.map((job) => job.id)).toEqual(imported.jobs.map((job) => job.id));
        expect(submit).toHaveBeenCalledTimes(2);
    });

    it('keeps discovery errors and ignored counts alongside accepted sources', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources);
        blockWorker(jobs);
        const errors = [{ path: path.join(sources, 'unreadable-folder'), message: 'Permission denied.' }];
        vi.spyOn(files, 'discoverVideos').mockResolvedValue({ files: [filename], errors, ignored: 3 });
        const result = await library.importForEditing(sources);
        expect(result).toMatchObject({ errors, ignored: 3, added: 1, existing: 0, queueErrors: [] });
        expect(result.assets).toHaveLength(1);
        expect(result.jobs).toHaveLength(1);
        expect(errors).toHaveLength(1);
    });

    it('reports admission identity failures as queue errors without losing source registration', async () => {
        const { sources, library, jobs } = await fixture();
        const asset = await library.register(await source(sources));
        blockWorker(jobs);
        vi.spyOn(files, 'assertSourceIdentity').mockRejectedValueOnce(new ServiceError('Original identity rejected.', 409));
        const result = await library.importForEditing(sources);
        expect(result).toMatchObject({ added: 0, existing: 1, errors: [], jobs: [] });
        expect(result.assets).toHaveLength(1);
        expect(result.assets[0]).toMatchObject({ id: asset.id, status: 'error' });
        expect(result.queueErrors).toEqual([{ mediaId: asset.id, message: expect.stringContaining('Original identity rejected') }]);
        expect((await library.importForEditing(sources)).jobs).toEqual([]);
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toEqual([]);
        expect((await library.prepare(asset.id)).state).toBe('queued');
    });

    it('excludes a source that changes between fingerprinting and probe completion', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources);
        const entered = deferred(); const gate = deferred();
        vi.mocked(probeVideo).mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return metadata(); });
        const request = library.importForEditing(sources);
        await entered.promise;
        await writeFile(filename, 'replacement recording with different bytes and a different size');
        gate.resolve();
        const result = await request;
        expect(result).toMatchObject({ assets: [], added: 0, existing: 0, jobs: [], queueErrors: [] });
        expect(result.errors).toEqual([{ path: filename, message: expect.stringContaining('changed') }]);
        expect(library.list()).toEqual([]);
        expect(jobs.list()).toEqual([]);
        expect(runProcess).not.toHaveBeenCalled();
    });

    it('returns unique active jobs even when two paths identify the same original', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources, 'a.mp4');
        await link(filename, path.join(sources, 'b.mp4'));
        blockWorker(jobs);
        const result = await library.importForEditing(sources);
        expect(result).toMatchObject({ added: 1, existing: 1, errors: [], queueErrors: [] });
        expect(new Set(result.assets.map((asset) => asset.id)).size).toBe(1);
        expect(result.jobs).toHaveLength(1);
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    });

    it('refreshes asset statuses and excludes jobs completed during later probes', async () => {
        const { sources, library, jobs } = await fixture();
        const [first, second] = await Promise.all([source(sources, 'a.mp4'), source(sources, 'b.mp4')]);
        const gate = deferred();
        vi.mocked(probeVideo).mockImplementation(async (_config, filename) => {
            if (filename === second) await jobs.wait(jobs.list().find((job) => job.kind === 'prepare' && job.label === 'a.mp4')!.id);
            return metadata();
        });
        vi.mocked(runProcess).mockImplementation(async (binary, args, options = {}) => {
            if (args.includes('-progress') && args[args.indexOf('-i') + 1] === second) await untilReleased(gate.promise, options.signal!);
            return fakeProcess(binary, args, options);
        });
        const result = await library.importForEditing(sources);
        expect(result.assets.find((asset) => asset.sourcePath === first)?.status).toBe('ready');
        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0]!.label).toBe('b.mp4');
        expect(['queued', 'running']).toContain(result.jobs[0]!.state);
    });

    it('does not create any job on repeated ready imports and keeps the completed cache', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources);
        const accepted = await library.addForEditing(filename);
        expect((await jobs.wait(accepted.job!.id)).state).toBe('completed');
        const ready = library.get(accepted.asset.id);
        const proxy = await readFile(library.proxyPath(ready));
        const submit = vi.spyOn(jobs, 'submit');
        vi.mocked(runProcess).mockClear(); vi.mocked(probeVideo).mockClear();
        const repeated = await library.importForEditing(sources);
        expect(repeated).toEqual({ assets: [ready], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] });
        expect(await library.addForEditing(filename)).toEqual({ asset: ready, job: null });
        expect(await library.register(filename)).toEqual(ready);
        expect(await readFile(library.proxyPath(ready))).toEqual(proxy);
        expect(submit).not.toHaveBeenCalled();
        expect(runProcess).not.toHaveBeenCalled();
        expect(probeVideo).not.toHaveBeenCalled();
    });

    it('reuses a verified cached proxy during an explicit prepare without re-encoding', async () => {
        const { sources, library, jobs } = await fixture();
        const accepted = await library.addForEditing(await source(sources));
        await jobs.wait(accepted.job!.id);
        const ready = library.get(accepted.asset.id);
        vi.mocked(runProcess).mockClear(); vi.mocked(probeVideo).mockClear();
        const retry = await library.prepare(ready.id);
        expect((await jobs.wait(retry.id)).state).toBe('completed');
        expect(library.get(ready.id).prepared).toEqual(ready.prepared);
        expect(probeVideo).toHaveBeenCalledWith(library.config, library.proxyPath(ready), expect.any(AbortSignal));
        expect(runProcess).not.toHaveBeenCalled();
    });
});

describe('registration and preparation admission races', () => {
    it('coalesces concurrent new imports, raw registration and single additions without overwriting queued state', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources);
        const fingerprint = await files.fingerprintFile(filename);
        vi.spyOn(files, 'fingerprintFile').mockResolvedValue(fingerprint);
        blockWorker(jobs);
        const entered = deferred(); const gate = deferred();
        vi.mocked(probeVideo).mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return metadata(); });
        const first = library.importForEditing(sources);
        await entered.promise;
        const second = library.importForEditing(sources);
        const raw = library.register(filename);
        const single = library.addForEditing(filename);
        gate.resolve();
        const [a, b, registered, added] = await Promise.all([first, second, raw, single]);
        expect(a.added + b.added).toBe(1);
        expect(a.existing + b.existing).toBe(1);
        expect(a.jobs.map((job) => job.id)).toEqual(b.jobs.map((job) => job.id));
        expect(added.job!.id).toBe(a.jobs[0]!.id);
        expect(registered.id).toBe(added.asset.id);
        expect(library.list()).toHaveLength(1);
        expect(library.get(registered.id).status).toBe('queued');
        expect(probeVideo).toHaveBeenCalledTimes(1);
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    });

    it('installs one prepare Promise before async identity validation and shares it with repeat imports', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources);
        const asset = await library.register(filename);
        blockWorker(jobs);
        const entered = deferred(); const gate = deferred();
        const identity = files.assertSourceIdentity;
        const validate = vi.spyOn(files, 'assertSourceIdentity').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; await identity(...args); });
        const first = library.prepare(asset.id);
        const second = library.prepare(asset.id);
        expect(second).toBe(first);
        await entered.promise;
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toEqual([]);
        const imported = library.importForEditing(sources);
        const repeated = library.importForEditing(sources);
        const single = library.addForEditing(filename);
        gate.resolve();
        const [a, b, c, d, e] = await Promise.all([first, second, imported, repeated, single]);
        expect(a.id).toBe(b.id);
        expect(c.jobs.map((job) => job.id)).toEqual([a.id]);
        expect(d.jobs.map((job) => job.id)).toEqual([a.id]);
        expect(e.job!.id).toBe(a.id);
        expect(validate).toHaveBeenCalledTimes(1);
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    });

    it('also coalesces requests while the queued-state save is pending', async () => {
        const { sources, library, jobs } = await fixture();
        const asset = await library.register(await source(sources));
        blockWorker(jobs);
        const entered = deferred(); const gate = deferred();
        const write = storage.atomicWrite;
        vi.spyOn(storage, 'atomicWrite').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; await write(...args); });
        const first = library.prepare(asset.id);
        await entered.promise;
        const second = library.prepare(asset.id);
        expect(second).toBe(first);
        const imported = library.importForEditing(sources);
        gate.resolve();
        const [a, b, c] = await Promise.all([first, second, imported]);
        expect(a.id).toBe(b.id);
        expect(c.jobs.map((job) => job.id)).toEqual([a.id]);
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    });

    it('removes rejected raw registration requests and rolls back an unsaved new entry', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources);
        vi.spyOn(files, 'fingerprintFile').mockResolvedValue(await files.fingerprintFile(filename));
        vi.spyOn(storage, 'atomicWrite').mockRejectedValueOnce(new Error('Registry write rejected.'));
        const results = await Promise.allSettled([library.register(filename), library.register(filename)]);
        expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
        expect(library.list()).toEqual([]);
        expect(probeVideo).toHaveBeenCalledTimes(1);
        expect((await library.register(filename)).status).toBe('registered');
        expect(library.list()).toHaveLength(1);
        expect(jobs.list()).toEqual([]);
    });

    it('does not persist a rejected registration through another concurrent successful save', async () => {
        const { sources, config, library } = await fixture();
        const [first, second] = await Promise.all([source(sources, 'a.mp4'), source(sources, 'b.mp4')]);
        const entered = deferred(); const gate = deferred(); const validated = deferred();
        const identity = files.assertSourceIdentity;
        vi.spyOn(files, 'assertSourceIdentity').mockImplementation(async (...args) => { await identity(...args); if (args[0] === second) validated.resolve(); });
        vi.spyOn(storage, 'atomicWrite').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; throw new Error('First registration write rejected.'); });
        const a = library.register(first!);
        await entered.promise;
        const b = library.register(second!);
        const settled = Promise.allSettled([a, b]);
        await validated.promise;
        // Allow the second registration's continuation to submit its writer work.
        await Promise.resolve();
        gate.resolve();
        expect((await settled).map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
        expect(library.list().map((asset) => asset.name)).toEqual(['b.mp4']);
        expect((await savedAssets(config.dataDir)).map((asset) => asset.name)).toEqual(['b.mp4']);
    });

    it('cleans a rejected preparation Promise, preserves registration and requires explicit retry', async () => {
        const { sources, config, library, jobs } = await fixture();
        const asset = await library.register(await source(sources));
        blockWorker(jobs);
        vi.spyOn(storage, 'atomicWrite').mockRejectedValueOnce(new Error('Queued-state write rejected.'));
        const first = library.prepare(asset.id); const second = library.prepare(asset.id);
        expect(first).toBe(second);
        expect((await Promise.allSettled([first, second])).map((result) => result.status)).toEqual(['rejected', 'rejected']);
        expect(library.get(asset.id)).toMatchObject({ status: 'error', error: expect.stringContaining('Queued-state write rejected') });
        expect(await savedAssets(config.dataDir)).toHaveLength(1);
        expect((await library.importForEditing(sources)).jobs).toEqual([]);
        const retry = await library.prepare(asset.id);
        expect(retry.state).toBe('queued');
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    });

    it('keeps the active map through settlement and cleans it even when final persistence fails', async () => {
        const { sources, library, jobs } = await fixture();
        const entered = deferred(); const gate = deferred();
        const write = storage.atomicWrite; let held = false;
        vi.spyOn(storage, 'atomicWrite').mockImplementation(async (filename, contents) => {
            if (!held && filename.endsWith('library.json') && registrySchema.parse(JSON.parse(contents)).assets.some((asset) => asset.status === 'ready')) {
                held = true; entered.resolve(); await gate.promise; throw new Error('Final status write rejected.');
            }
            await write(filename, contents);
        });
        const accepted = await library.addForEditing(await source(sources));
        await entered.promise;
        expect((await library.prepare(accepted.asset.id)).id).toBe(accepted.job!.id);
        expect((await library.importForEditing(sources)).jobs).toEqual([]);
        expect(jobs.list()).toHaveLength(1);
        gate.resolve();
        expect((await jobs.wait(accepted.job!.id)).state).toBe('failed');
        expect(library.get(accepted.asset.id)).toMatchObject({ status: 'error', prepared: null });
        const retry = await library.prepare(accepted.asset.id);
        expect(retry.id).not.toBe(accepted.job!.id);
        expect((await jobs.wait(retry.id)).state).toBe('completed');
    });
});

describe('one worker, cancellation and explicit retry', () => {
    it('runs one encoder, cancels running/queued jobs, and never retries them on re-import', async () => {
        const { sources, library, jobs } = await fixture();
        const filenames = await Promise.all([source(sources, 'a.mp4'), source(sources, 'b.mp4')]);
        const originals = await Promise.all(filenames.map((filename) => readFile(filename)));
        const entered = deferred(); const gate = deferred();
        let starts = 0; let active = 0; let maximum = 0;
        vi.mocked(runProcess).mockImplementation(async (binary, args, options = {}) => {
            if (!args.includes('-progress')) return fakeProcess(binary, args, options);
            starts++; active++; maximum = Math.max(maximum, active);
            try {
                if (starts === 1) {
                    await writeFile(args.at(-1)!, 'partial proxy');
                    entered.resolve(); await untilReleased(gate.promise, options.signal!);
                }
                return await fakeProcess(binary, args, options);
            } finally { active--; }
        });
        const imported = await library.importForEditing(sources);
        await entered.promise;
        expect(imported.jobs).toHaveLength(2);
        expect(starts).toBe(1);
        expect(runProcess).toHaveBeenCalledTimes(1);
        const first = imported.jobs.find((job) => job.label === 'a.mp4')!;
        const second = imported.jobs.find((job) => job.label === 'b.mp4')!;
        expect(jobs.get(first.id).state).toBe('running');
        expect(jobs.get(second.id).state).toBe('queued');
        jobs.cancel(first.id); jobs.cancel(second.id);
        expect((await Promise.all([jobs.wait(first.id), jobs.wait(second.id)])).map((job) => job.state)).toEqual(['cancelled', 'cancelled']);
        expect(library.list().every((asset) => asset.status === 'error' && asset.prepared === null)).toBe(true);
        expect(await readdir(library.assetDir(imported.assets[0]!))).toEqual([]);
        expect((await library.importForEditing(sources)).jobs).toEqual([]);
        expect((await library.addForEditing(filenames[0]!)).job).toBeNull();
        expect(jobs.list()).toHaveLength(2);
        const request = library.prepare(imported.assets[0]!.id);
        const duplicate = library.prepare(imported.assets[0]!.id);
        const other = library.prepare(imported.assets[1]!.id);
        const [retry, reused, next] = await Promise.all([request, duplicate, other]);
        expect(retry.id).toBe(reused.id);
        expect(retry.id).not.toBe(next.id);
        expect((await Promise.all([jobs.wait(retry.id), jobs.wait(next.id)])).map((job) => job.state)).toEqual(['completed', 'completed']);
        expect(starts).toBe(3);
        expect(maximum).toBe(1);
        expect(await Promise.all(filenames.map((filename) => readFile(filename)))).toEqual(originals);
    });

    it('skips a failed encode until an explicit prepare request retries it', async () => {
        const { sources, library, jobs } = await fixture();
        vi.mocked(runProcess).mockRejectedValueOnce(new ServiceError('Encoder rejected the source.', 422));
        const accepted = await library.addForEditing(await source(sources));
        expect((await jobs.wait(accepted.job!.id)).state).toBe('failed');
        const repeated = await library.importForEditing(sources);
        expect(repeated).toMatchObject({ added: 0, existing: 1, jobs: [], queueErrors: [] });
        expect(repeated.assets[0]).toMatchObject({ status: 'error', error: 'Encoder rejected the source.' });
        expect(jobs.list()).toHaveLength(1);
        const retry = await library.prepare(accepted.asset.id);
        expect((await jobs.wait(retry.id)).state).toBe('completed');
    });
});

describe('source and cache safety for automatic admissions', () => {
    it('rejects leaf/parent symlinks and caches inside sources before queueing', async () => {
        const { root, sources, config, library, jobs } = await fixture();
        const filename = await source(sources);
        const leaf = path.join(sources, 'linked.mp4'); const parent = path.join(root, 'linked-sources');
        await symlink(filename, leaf); await symlink(sources, parent);
        await expect(library.addForEditing(leaf)).rejects.toThrow('Symlinks');
        await expect(library.addForEditing(path.join(parent, 'clip.mp4'))).rejects.toThrow('Symlinks');
        await expect(library.importForEditing(root)).rejects.toThrow('cache must be outside');
        const unsafe = new MediaLibrary({ ...config, dataDir: sources }, jobs);
        await expect(unsafe.addForEditing(filename)).rejects.toThrow('cache must be outside');
        expect(jobs.list()).toEqual([]);
        expect(probeVideo).not.toHaveBeenCalled();
        expect(runProcess).not.toHaveBeenCalled();
    });

    it('rechecks originals at worker start and never reassociates a changed recording', async () => {
        const { sources, library, jobs } = await fixture();
        const filename = await source(sources);
        const blocker = blockWorker(jobs);
        const accepted = await library.addForEditing(filename);
        await writeFile(filename, 'a replacement source with different size, bytes and identity');
        blocker.release();
        const result = await jobs.wait(accepted.job!.id);
        expect(result).toMatchObject({ state: 'failed', message: expect.stringContaining('changed') });
        expect(runProcess).not.toHaveBeenCalled();
        const replacement = await library.register(filename);
        expect(replacement.id).not.toBe(accepted.asset.id);
        expect(library.get(accepted.asset.id).fingerprint).toEqual(accepted.asset.fingerprint);
        expect(library.get(accepted.asset.id).status).toBe('error');
        expect(replacement.status).toBe('registered');
    });

    it.each(['proxy', 'thumbnail', 'directory'] as const)('refuses a symlinked %s cache output without touching originals', async (target) => {
        const { root, sources, config, library, jobs } = await fixture();
        const filename = await source(sources);
        const original = await readFile(filename);
        const blocker = blockWorker(jobs);
        const accepted = await library.addForEditing(filename);
        if (target === 'directory') {
            const assets = path.join(config.dataDir, 'assets');
            const outside = path.join(root, 'outside');
            await Promise.all([mkdir(assets), mkdir(outside)]);
            await symlink(outside, path.join(assets, accepted.asset.fingerprint.digest));
        } else {
            await mkdir(library.assetDir(accepted.asset), { recursive: true });
            await symlink(filename, target === 'proxy' ? library.proxyPath(accepted.asset) : library.thumbnailPath(accepted.asset, 0));
        }
        blocker.release();
        expect((await jobs.wait(accepted.job!.id)).state).toBe('failed');
        expect(library.get(accepted.asset.id).error).toContain('Symlinks');
        expect(runProcess).not.toHaveBeenCalled();
        expect(await readFile(filename)).toEqual(original);
    });

    it('retains a registered asset in the helper error when queue submission is rejected', async () => {
        const { sources, config, library, jobs } = await fixture();
        vi.spyOn(jobs, 'submit').mockImplementationOnce(() => { throw new Error('Queue rejected admission.'); });
        await expect(library.addForEditing(await source(sources))).rejects.toBeInstanceOf(MediaQueueError);
        expect(library.list()).toHaveLength(1);
        expect(library.list()[0]).toMatchObject({ status: 'error', error: expect.stringContaining('Queue rejected admission') });
        expect(await savedAssets(config.dataDir)).toHaveLength(1);
        expect(jobs.list()).toEqual([]);
    });
});

describe('automatic editing import/register HTTP responses', () => {
    it('returns HTTP 202 after probes/admission, and reuses accepted jobs for single-register requests', async () => {
        const { sources, app, library, jobs } = await serviceFixture();
        const filenames = await Promise.all([source(sources, 'a.mp4'), source(sources, 'b.mp4')]);
        blockWorker(jobs);
        const response = await app.inject({ method: 'POST', url: '/api/media/import', headers, payload: { directory: sources } });
        expect(response.statusCode).toBe(202);
        const body = response.json<ImportForEditingResult>();
        expect(Object.keys(body).sort()).toEqual(['added', 'assets', 'errors', 'existing', 'ignored', 'jobs', 'queueErrors']);
        expect(body).toMatchObject({ added: 2, existing: 0, ignored: 0, errors: [], queueErrors: [] });
        expect(body.assets.every((asset) => asset.status === 'queued')).toBe(true);
        expect(body.jobs).toHaveLength(2);
        expect(runProcess).not.toHaveBeenCalled();
        const registered = await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: filenames[0] } });
        expect(registered.statusCode).toBe(202);
        const single = registered.json<AddForEditingResult>();
        expect(Object.keys(single).sort()).toEqual(['asset', 'job']);
        expect(single.asset).toEqual(library.get(body.assets[0]!.id));
        expect(single.job!.id).toBe(body.jobs.find((job) => job.label === 'a.mp4')!.id);
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(2);
    });

    it('auto-queues an explicitly re-imported registered asset, but not a ready entry', async () => {
        const { sources, app, library, jobs } = await serviceFixture();
        const filename = await source(sources);
        const raw = await library.register(filename);
        expect(jobs.list()).toEqual([]);
        const response = await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: filename } });
        expect(response.statusCode).toBe(202);
        const accepted = response.json<AddForEditingResult>();
        expect(accepted.asset.id).toBe(raw.id);
        await jobs.wait(accepted.job!.id);
        const repeated = await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: filename } });
        expect(repeated.statusCode).toBe(202);
        expect(repeated.json<AddForEditingResult>()).toMatchObject({ asset: { status: 'ready' }, job: null });
        expect(jobs.list()).toHaveLength(1);
    });

    it('reports queue failure with media identity and the preserved asset instead of fake completion', async () => {
        const { sources, config, app, library, jobs } = await serviceFixture();
        const filename = await source(sources);
        blockWorker(jobs);
        vi.spyOn(jobs, 'submit').mockImplementationOnce(() => { throw new ServiceError('Worker admission rejected.', 503); });
        const response = await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: filename } });
        expect(response.statusCode).toBe(503);
        const body = response.json<{ error: string; mediaId: string; asset: MediaAsset; job: null }>();
        expect(body).toMatchObject({ asset: { status: 'error' }, job: null });
        expect(body.error).toContain('Worker admission rejected');
        expect(body.error).toContain(body.mediaId);
        expect(body.asset).toEqual(library.get(body.mediaId));
        expect(await savedAssets(config.dataDir)).toHaveLength(1);
        const repeated = await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: filename } });
        expect(repeated.statusCode).toBe(202);
        expect(repeated.json<AddForEditingResult>().job).toBeNull();
        const retry = await app.inject({ method: 'POST', url: `/api/media/${body.mediaId}/prepare`, headers, payload: {} });
        expect(retry.statusCode).toBe(200);
        expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    });

    it('keeps strict input bodies and excludes unsupported single-register sources', async () => {
        const { sources, app, library, jobs } = await serviceFixture();
        expect((await app.inject({ method: 'POST', url: '/api/media/import', headers, payload: { directory: sources, prepare: true } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: 42 } })).statusCode).toBe(400);
        vi.mocked(probeVideo).mockRejectedValueOnce(new ServiceError('Unsupported SDR metadata.', 422));
        const response = await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: await source(sources) } });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ error: 'Unsupported SDR metadata.' });
        expect(library.list()).toEqual([]);
        expect(jobs.list()).toEqual([]);
    });
});