import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { ServiceError } from '../../src/server/errors.js';
import { fingerprintFile } from '../../src/server/files.js';
import type { JobQueue } from '../../src/server/jobs.js';
import type { AddForEditingResult, ImportForEditingResult } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';
import type { MediaJob } from '../../src/shared/media.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const roots: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const releases: (() => void)[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-import-proxies-native-'));
  roots.push(root);
  const sources = path.join(root, 'sources');
  await mkdir(sources);
  const config = createConfig({
    dataDir: path.join(root, 'cache'),
    webDir: path.join(root, 'absent-web'),
    port: 4318,
    allowedHosts: new Set(['127.0.0.1:4318']),
    allowedOrigins: new Set(['http://127.0.0.1:4318']),
  });
  const service = await createApp(config);
  services.push(service);
  return { sources, ...service };
}

/** Twelve 160x90 lavfi frames only; no real recordings or shared cache. */
async function pattern(config: ServiceConfig, filename: string): Promise<void> {
  await runProcess(config.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=30000/1001',
    '-frames:v',
    '12',
    '-vf',
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '15',
    '-bf',
    '0',
    '-threads',
    '2',
    '-filter_threads',
    '2',
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
    '-movflags',
    '+faststart',
    filename,
  ]);
}

function blockWorker(jobs: JobQueue) {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  const job = jobs.submit(
    'reference',
    'native-test worker gate',
    async (context) =>
      new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          reject(new ServiceError('Job cancelled.', 499));
        };
        if (context.signal.aborted) {
          abort();
          return;
        }
        context.signal.addEventListener('abort', abort, { once: true });
        void gate.then(() => {
          context.signal.removeEventListener('abort', abort);
          resolve();
        });
      }),
  );
  return { job, release };
}

describe.skipIf(!enabled)('automatic video proxy imports · disposable native fixtures', () => {
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.all(services.splice(0).map((service) => service.app.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('admits valid imports with partial errors, returns before encoding, and reuses active/ready proxies', async () => {
    const { sources, config, app, library, jobs } = await fixture();
    const filenames = [path.join(sources, 'a.mp4'), path.join(sources, 'b.mp4')];
    await filenames.reduce(async (previous, filename) => {
      await previous;
      await pattern(config, filename);
    }, Promise.resolve());
    const originals = await Promise.all(filenames.map((filename) => readFile(filename)));
    const identities = await Promise.all(filenames.map((filename) => fingerprintFile(filename)));
    await Promise.all([
      writeFile(path.join(sources, 'c-rejected.mp4'), 'not a video'),
      writeFile(path.join(sources, 'notes.txt'), 'ignored'),
    ]);
    const blocker = blockWorker(jobs);
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/import',
      headers,
      payload: { directory: sources },
    });
    expect(response.statusCode).toBe(202);
    const imported = response.json<ImportForEditingResult>();
    expect(imported).toMatchObject({ added: 2, existing: 0, ignored: 1, queueErrors: [] });
    expect(imported.assets).toHaveLength(2);
    expect(imported.assets.every((asset) => asset.status === 'queued' && asset.prepared === null)).toBe(true);
    expect(imported.errors).toEqual([{ path: path.join(sources, 'c-rejected.mp4'), message: expect.any(String) }]);
    expect(imported.jobs).toHaveLength(2);
    expect(imported.jobs.every((job) => job.kind === 'prepare' && job.state === 'queued')).toBe(true);

    const repeat = await app.inject({
      method: 'POST',
      url: '/api/media/import',
      headers,
      payload: { directory: sources },
    });
    const repeated = repeat.json<ImportForEditingResult>();
    expect(repeat.statusCode).toBe(202);
    expect(repeated).toMatchObject({ added: 0, existing: 2, queueErrors: [] });
    expect(repeated.jobs.map((job) => job.id)).toEqual(imported.jobs.map((job) => job.id));
    const registered = await app.inject({
      method: 'POST',
      url: '/api/media/register',
      headers,
      payload: { path: filenames[0] },
    });
    expect(registered.statusCode).toBe(202);
    expect(registered.json<AddForEditingResult>().job!.id).toBe(imported.jobs[0]!.id);
    expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(2);

    blocker.release();
    const completed = await Promise.all(imported.jobs.map((job) => jobs.wait(job.id)));
    completed.forEach((job) => {
      expect(job.state, job.message).toBe('completed');
    });
    const ready = library.list();
    expect(ready.every((asset) => asset.status === 'ready' && asset.prepared?.verification.frameCount === 12)).toBe(
      true,
    );
    const proxies = await Promise.all(ready.map((asset) => readFile(library.proxyPath(asset))));
    const cached = await library.importForEditing(sources);
    expect(cached).toMatchObject({ added: 0, existing: 2, jobs: [], queueErrors: [] });
    expect((await library.addForEditing(filenames[0]!)).job).toBeNull();
    expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(2);
    expect(await Promise.all(ready.map((asset) => readFile(library.proxyPath(asset))))).toEqual(proxies);
    expect(await Promise.all(filenames.map((filename) => readFile(filename)))).toEqual(originals);
    expect(await Promise.all(filenames.map((filename) => fingerprintFile(filename)))).toEqual(identities);
  });

  it('does not auto-retry a cancelled admission and permits an explicit native preparation retry', async () => {
    const { sources, config, app, library, jobs } = await fixture();
    const filename = path.join(sources, 'clip.mp4');
    await pattern(config, filename);
    const original = await readFile(filename);
    const blocker = blockWorker(jobs);
    const accepted = await library.addForEditing(filename);
    expect(accepted.job!.state).toBe('queued');
    jobs.cancel(accepted.job!.id);
    blocker.release();
    expect((await jobs.wait(accepted.job!.id)).state).toBe('cancelled');
    expect(library.get(accepted.asset.id)).toMatchObject({ status: 'error', prepared: null });
    expect((await library.importForEditing(sources)).jobs).toEqual([]);
    expect((await library.addForEditing(filename)).job).toBeNull();
    expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);

    const response = await app.inject({
      method: 'POST',
      url: `/api/media/${accepted.asset.id}/prepare`,
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const retry = response.json<{ job: MediaJob }>().job;
    expect(retry.id).not.toBe(accepted.job!.id);
    const completed = await jobs.wait(retry.id);
    expect(completed.state, completed.message).toBe('completed');
    expect(library.get(accepted.asset.id)).toMatchObject({
      status: 'ready',
      prepared: { verification: { frameCount: 12 } },
    });
    expect(await readFile(filename)).toEqual(original);
  });
});
