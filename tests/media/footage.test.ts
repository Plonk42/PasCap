import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { ServiceError } from '../../src/server/errors.js';
import { assertSourceIdentity, fingerprintFile } from '../../src/server/files.js';
import type { JobQueue } from '../../src/server/jobs.js';
import type { ImportForEditingResult } from '../../src/server/library.js';
import { probeVideo } from '../../src/server/probe.js';
import { runProcess } from '../../src/server/process.js';
import { footageDirectorySchema, footageRootSchema, type FootageRoot } from '../../src/shared/footage.js';
import { registrySchema } from '../../src/shared/media.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const temporary: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const releases: (() => void)[] = [];
const permissions: { filename: string; mode: number }[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-footage-native-'));
  temporary.push(root);
  const sources = path.join(root, 'readonly originals'); await mkdir(sources);
  const config = createConfig({
    dataDir: path.join(root, 'cache'), mediaRoots: [sources], webDir: path.join(root, 'absent-web'), port: 4318,
    allowedHosts: new Set(['127.0.0.1:4318']), allowedOrigins: new Set(['http://127.0.0.1:4318']),
  });
  const service = await createApp(config); services.push(service);
  return { root, sources, ...service };
}

/** Twelve disposable 160x90 SDR lavfi frames, always outside the service cache. */
async function syntheticOriginal(config: ServiceConfig, filename: string): Promise<void> {
  await runProcess(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi',
    '-i', 'testsrc2=size=160x90:rate=30000/1001', '-frames:v', '12',
    '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-g', '15', '-bf', '0', '-threads', '2', '-filter_threads', '2',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-video_track_timescale', '30000', '-movflags', '+faststart', filename,
  ]);
}

function blockWorker(jobs: JobQueue) {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  jobs.submit('reference', 'native-footage worker gate', async (context) => new Promise<void>((resolve, reject) => {
    const abort = (): void => { reject(new ServiceError('Job cancelled.', 499)); };
    if (context.signal.aborted) { abort(); return; }
    context.signal.addEventListener('abort', abort, { once: true });
    void gate.then(() => { context.signal.removeEventListener('abort', abort); resolve(); });
  }));
  return release;
}

describe.skipIf(!enabled)('approved-root no-copy import · disposable native proof', () => {
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.all(permissions.splice(0).map(({ filename, mode }) => chmod(filename, mode)));
    await Promise.all(services.splice(0).map((service) => service.app.close()));
    await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('browses and registers a readonly original over JSON HTTP, verifies its proxy and reuses it across restart without copying', async () => {
    const { sources, config, app, library, jobs } = await fixture();
    const filename = path.join(sources, 'Camera 2.MP4');
    await syntheticOriginal(config, filename);
    permissions.push({ filename, mode: 0o600 }, { filename: sources, mode: 0o700 });
    await chmod(filename, 0o444); await chmod(sources, 0o555);
    const original = await readFile(filename); const identity = await fingerprintFile(filename);
    const expectedMetadata = await probeVideo(config, filename);
    const release = blockWorker(jobs);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing native-test HTTP port.');
    const base = `http://127.0.0.1:${address.port}`;
    config.allowedHosts.add(new URL(base).host); config.allowedOrigins.add(base);
    const requestHeaders = { 'x-pascap-client': 'preview-lab', origin: base, 'content-type': 'application/json' };
    const rootsResponse = await fetch(`${base}/api/footage/roots`);
    expect(rootsResponse.status).toBe(200);
    const roots = (await rootsResponse.json() as { roots: FootageRoot[] }).roots.map((entry) => footageRootSchema.parse(entry));
    expect(roots).toEqual([{ id: 'root-0', name: 'readonly originals', path: sources, available: true, error: null }]);
    const listed = footageDirectorySchema.parse(await (await fetch(`${base}/api/footage?rootId=root-0`)).json());
    expect(listed).toEqual({ rootId: 'root-0', directory: sources, parent: null, entries: [{ name: 'Camera 2.MP4', path: filename, kind: 'video', size: original.length }], ignored: 0, truncated: false, warnings: [] });
    expect(library.list()).toEqual([]); expect(jobs.list().filter((job) => job.kind === 'prepare')).toEqual([]);

    const response = await fetch(`${base}/api/media/register-paths`, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ paths: [filename] }) });
    expect(response.status).toBe(202);
    const imported = await response.json() as ImportForEditingResult;
    expect(imported).toMatchObject({ added: 1, existing: 0, ignored: 0, errors: [], queueErrors: [] });
    expect(imported.assets).toHaveLength(1); expect(imported.jobs).toHaveLength(1);
    const asset = imported.assets[0]!;
    expect(asset).toMatchObject({ name: 'Camera 2.MP4', sourcePath: filename, fingerprint: identity, metadata: expectedMetadata, status: 'queued', prepared: null });
    expect(imported.jobs[0]).toMatchObject({ kind: 'prepare', state: 'queued' });
    const active = await fetch(`${base}/api/media/register-paths`, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ paths: [filename] }) });
    expect(active.status).toBe(202);
    expect(await active.json()).toMatchObject({ added: 0, existing: 1, jobs: imported.jobs });
    release();
    const completed = await jobs.wait(imported.jobs[0]!.id);
    expect(completed.state, completed.message).toBe('completed');
    const ready = library.get(asset.id);
    expect(ready).toMatchObject({ sourcePath: filename, fingerprint: identity, status: 'ready', prepared: { verification: { frameCount: 12 } } });
    expect(ready.prepared!.verification.samples.every((sample) => sample.meanAbsoluteError8Bit <= 6)).toBe(true);
    expect((await probeVideo(config, library.proxyPath(ready))).frameCount).toBe(12);
    const proxy = await readFile(library.proxyPath(ready));
    const repeatedResponse = await fetch(`${base}/api/media/register-paths`, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ paths: [filename] }) });
    expect(repeatedResponse.status).toBe(202);
    expect(await repeatedResponse.json()).toEqual({ assets: [ready], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] });
    expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    const served = await fetch(`${base}/api/media/${asset.id}/source`);
    expect(served.status).toBe(200); expect(Buffer.from(await served.arrayBuffer())).toEqual(original);
    const servedProxy = await fetch(`${base}/api/media/${asset.id}/proxy`);
    expect(servedProxy.status).toBe(200); expect(Buffer.from(await servedProxy.arrayBuffer())).toEqual(proxy);
    await assertSourceIdentity(filename, identity, true);
    expect(await readFile(filename)).toEqual(original);
    expect(await fingerprintFile(filename)).toEqual(identity); // Includes size, mtime, device and inode.
    expect((await stat(filename)).mode & 0o777).toBe(0o444);
    expect((await stat(sources)).mode & 0o777).toBe(0o555);
    expect(await readdir(sources)).toEqual(['Camera 2.MP4']);
    expect((await readdir(config.dataDir)).sort()).toEqual(['assets', 'audio.json', 'library.json']);
    expect(registrySchema.parse(JSON.parse(await readFile(path.join(config.dataDir, 'library.json'), 'utf8'))).assets).toEqual([ready]);

    await app.close();
    const restarted = await createApp(config); services.push(restarted);
    expect(restarted.library.get(asset.id)).toEqual(ready); expect(restarted.jobs.list()).toEqual([]);
    const reimported = await restarted.app.inject({ method: 'POST', url: '/api/media/register-paths', headers, payload: { paths: [filename] } });
    expect(reimported.statusCode).toBe(202);
    expect(reimported.json<ImportForEditingResult>()).toEqual({ assets: [ready], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] });
    expect(restarted.jobs.list()).toEqual([]);
    expect((await restarted.app.inject({ url: `/api/media/${asset.id}/source`, headers })).rawPayload).toEqual(original);
    expect((await restarted.app.inject({ url: `/api/media/${asset.id}/proxy`, headers })).rawPayload).toEqual(proxy);
    expect(await fingerprintFile(filename)).toEqual(identity);
  });

  it('reports real probe/missing-file failures without copying, removing or changing rejected originals', async () => {
    const { sources, config, app, library, jobs } = await fixture();
    const filename = path.join(sources, 'Not actually video.mov'); const missing = path.join(sources, 'Disconnected.mp4');
    const bytes = Buffer.from('not a video despite the supported filename'); await writeFile(filename, bytes);
    const identity = await fingerprintFile(filename);
    const response = await app.inject({ method: 'POST', url: '/api/media/register-paths', headers, payload: { paths: [filename, missing] } });
    expect(response.statusCode).toBe(202);
    const result = response.json<ImportForEditingResult>();
    expect(result).toMatchObject({ assets: [], added: 0, existing: 0, ignored: 0, jobs: [], queueErrors: [] });
    expect(result.errors).toEqual([{ path: filename, message: expect.any(String) }, { path: missing, message: expect.any(String) }]);
    expect(library.list()).toEqual([]); expect(jobs.list()).toEqual([]);
    expect(await readFile(filename)).toEqual(bytes); expect(await fingerprintFile(filename)).toEqual(identity);
    expect(await readdir(sources)).toEqual(['Not actually video.mov']); expect(await readdir(config.dataDir)).toEqual(['audio.json']);
  });
});