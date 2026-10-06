import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { AudioLibrary, PcmPeakReducer } from '../../src/server/audio.js';
import { createConfig } from '../../src/server/config.js';
import { fingerprintFile } from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { atomicWrite, ProjectStore } from '../../src/server/storage.js';
import { audioAssetSchema, type AudioAsset } from '../../src/shared/audio.js';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import {
  EMPTY_KEY_VALUES,
  KEYFRAME_SETTINGS,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { mediaAssetSchema, type MediaJob } from '../../src/shared/media.js';
import {
  createClip,
  createLayer,
  createProject,
  idSchema,
  projectSchema,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { projectSummarySchema } from '../../src/shared/projects.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';
import { unsupportedProject } from './project-fixtures.js';

const temporary: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const queues: JobQueue[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-projects-'));
  temporary.push(directory);
  return directory;
}
async function serviceAt(dataDir: string): Promise<Awaited<ReturnType<typeof createApp>>> {
  const service = await createApp(
    createConfig({
      dataDir,
      webDir: path.join(dataDir, 'absent-web'),
      ffmpeg: '/unit-tests-do-not-run-ffmpeg',
      ffprobe: '/unit-tests-do-not-run-ffprobe',
    }),
  );
  services.push(service);
  return service;
}
function registryAsset(directory: string, id: string, status: AudioAsset['status']): AudioAsset {
  return audioAssetSchema.parse({
    id,
    name: `${id}.wav`,
    sourcePath: path.join(directory, `${id}.wav`),
    fingerprint: { algorithm: 'sampled-sha256-v1', digest: 'a'.repeat(64), size: 100, mtimeMs: 1, device: 1, inode: 1 },
    metadata: { codec: 'pcm_s16le', sampleRate: 48_000, channels: 2, durationSeconds: 2, frameCount: 59 },
    status,
    error: null,
    waveform: [0.25, 0.5],
  });
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.app.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('multiple-project store', () => {
  it('creates independent UUID documents at revision one and lists recent retimed durations', async () => {
    const directory = await temp();
    const store = new ProjectStore(directory);
    expect(await store.list()).toEqual([]);
    const first = await store.create('  First flight  ');
    const second = await store.create('Second flight');
    expect(first.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.id).not.toBe(second.id);
    expect(first.title).toBe('First flight');
    expect(first.revision).toBe(1);
    expect(first.schemaVersion).toBe(6);
    expect(first.layers[0]!.keyframes).toEqual([]);
    const clip = { ...createClip('clip-a', 'registered-video', 0, 120), speed: { mode: 'constant' as const, rate: 2 } };
    const saved = await store.save({ ...first, clips: [clip] }, 1);
    expect(saved.revision).toBe(2);
    const firstTime = new Date('2025-01-01T00:00:00Z');
    const secondTime = new Date('2025-01-02T00:00:00Z');
    await utimes(path.join(directory, 'projects', `${first.id}.json`), firstTime, firstTime);
    await utimes(path.join(directory, 'projects', `${second.id}.json`), secondTime, secondTime);
    const summaries = await store.list();
    expect(summaries.map((summary) => summary.id)).toEqual([second.id, first.id]);
    expect(summaries[1]).toEqual({
      id: first.id,
      title: first.title,
      revision: 2,
      clipCount: 1,
      duration: 60,
      updatedAt: firstTime.toISOString(),
      compatible: true,
      error: null,
    });
    summaries.forEach((summary) => projectSummarySchema.parse(summary));
    expect(await store.load(first.id)).toEqual(saved);
    expect((await readdir(path.join(directory, 'projects'))).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('round-trips 256 strict row points and rejects malformed v6 data without changing confirmed bytes', async () => {
    const directory = await temp();
    const store = new ProjectStore(directory);
    const document = createProject('strict-row', 'Shared row');
    document.clips = [createClip('excerpt', 'registered-video', 500, 600)];
    document.layers[0]!.keyframes = Array.from({ length: 256 }, (_, index) =>
      point(index * 10, { exposure: index % 2 }),
    );
    document.layers[0]!.keyframes[0] = point(
      0,
      { ...NEUTRAL_COLOUR, layerOpacity: 1, clipOpacity: 0, speed: 1.25 },
      'smooth',
    );
    const saved = await store.save(document, 0);
    expect(saved.schemaVersion).toBe(6);
    expect(saved.layers[0]!.keyframes).toHaveLength(256);
    expect(Object.keys(saved.layers[0]!.keyframes[0]!.values)).toEqual(KEYFRAME_SETTINGS.map((setting) => setting.key));
    expect(saved.layers[0]!.keyframes.at(-1)!.frame).toBeGreaterThan(saved.clips[0]!.sourceOut);
    expect(await store.load(saved.id)).toEqual(saved);
    expect((await store.list())[0]).toMatchObject({
      id: saved.id,
      compatible: true,
      clipCount: 1,
      duration: 80,
      revision: 1,
    });
    const filename = path.join(directory, 'projects', `${saved.id}.json`);
    const bytes = await readFile(filename, 'utf8');
    const first = saved.layers[0]!.keyframes[0]!;
    const { shadows: _shadows, ...missingValue } = first.values;
    const { keyframes: _keyframes, ...missingPoints } = saved.layers[0]!;
    const malformedRows: unknown[] = [
      [...saved.layers[0]!.keyframes, point(2560, { hue: 90 })],
      [point(10, { clipOpacity: 0 }), point(10, { hue: 90 })],
      [point(20, { exposure: 0 }), point(10, { hue: 90 })],
      [point(0, {})],
      [{ ...first, values: missingValue }],
      [{ ...first, values: { ...first.values, shadows: undefined } }],
      [{ ...first, values: { ...first.values, legacy: 1 } }],
      [{ ...first, frame: -1 }],
      [{ ...first, frame: 0.5 }],
      [{ ...first, frame: 2_147_483_648 }],
      [{ ...first, interpolation: 'cubic' }],
      [{ ...first, sourceFrame: 500 }],
    ];
    const invalid: unknown[] = [
      ...malformedRows.map((keyframes) => ({ ...saved, layers: [{ ...saved.layers[0]!, keyframes }] })),
      { ...saved, layers: [missingPoints] },
      { ...saved, layers: [{ ...saved.layers[0]!, opacityKeys: [] }] },
      { ...saved, clips: [{ ...saved.clips[0]!, animation: { opacity: [], colour: [] } }] },
      {
        ...saved,
        clips: [
          {
            ...saved.clips[0]!,
            speed: { mode: 'keyframes', keys: [{ frame: 500, value: 1, interpolation: 'linear' }] },
          },
        ],
      },
      { ...saved, clips: [{ ...saved.clips[0]!, opacity: undefined }] },
      { ...saved, clips: [{ ...saved.clips[0]!, colour: { exposure: 0 } }] },
    ];
    for (const candidate of invalid) {
      expect(projectSchema.safeParse(candidate).success).toBe(false);
      await expect(store.save(candidate as ProjectDocument, 1)).rejects.toThrow();
      expect(await readFile(filename, 'utf8')).toBe(bytes);
    }
    expect(await store.load(saved.id)).toEqual(saved);
  });

  it('round-trips arbitrary track order, Ripple settings, dormant fades and every authoritative clip start', async () => {
    const directory = await temp();
    const store = new ProjectStore(directory);
    const document = createProject('uniform-tracks', 'Uniform tracks');
    document.layers = [
      createLayer('positioned-first', 'Positioned', false),
      createLayer('packed-last', 'Packed'),
      createLayer('empty', 'Empty'),
    ];
    document.layers[0]!.openingFade = 3;
    document.layers[0]!.closingFade = 4;
    document.layers[1]!.openingFade = 2;
    document.layers[1]!.closingFade = 5;
    document.layers[2]!.openingFade = 20;
    document.layers[2]!.closingFade = 30;
    document.layers[1]!.keyframes = [
      point(0, { exposure: 0.123456789, speed: 1 }, 'hold'),
      point(500, { hue: 90 }, 'smooth'),
    ];
    document.clips = [
      { ...createClip('positioned-left', 'one', 100, 130, 'positioned-first'), start: 10 },
      { ...createClip('packed-left', 'two', 200, 230, 'packed-last'), start: 25 },
      { ...createClip('positioned-right', 'three', 300, 330, 'positioned-first'), start: 35 },
      { ...createClip('packed-right', 'four', 400, 430, 'packed-last'), start: 55 },
    ];
    document.layers[0]!.transitions = [
      { leftId: 'positioned-left', rightId: 'positioned-right', type: 'cross-dissolve', duration: 5 },
    ];
    document.layers[1]!.transitions = [
      { leftId: 'packed-left', rightId: 'packed-right', type: 'fade-through-black', duration: 5 },
    ];
    const saved = await store.save(document, 0);
    expect(saved).toEqual({ ...document, revision: 1 });
    const reopened = await store.load(saved.id);
    expect(reopened).toEqual(saved);
    expect(JSON.parse(await readFile(path.join(directory, 'projects', `${saved.id}.json`), 'utf8'))).toEqual(saved);
    expect(reopened).not.toHaveProperty('transitions');
    expect(reopened).not.toHaveProperty('openingFade');
    expect(reopened).not.toHaveProperty('closingFade');
    for (const placed of calculateLayout(reopened).clips) expect(placed.clip.start).toBe(placed.start);
    const reordered = applyCommand(reopened, {
      type: 'layer-order',
      layerIds: ['packed-last', 'empty', 'positioned-first'],
    });
    const final = await store.save(reordered, 1);
    expect(final).toEqual({ ...reordered, revision: 2 });
    expect(await store.load(saved.id)).toEqual(final);
    expect(final.clips.map((clip) => clip.start)).toEqual([10, 25, 35, 55]);
    expect((await store.list())[0]).toMatchObject({ compatible: true, revision: 2, clipCount: 4, duration: 85 });
  });

  it('serialises rename against saves and other renames without losing a newer edit', async () => {
    const store = new ProjectStore(await temp());
    const document = await store.create('Flight');
    const edited = { ...document, clips: [createClip('clip-a', 'registered-video', 0, 60)] };
    const results = await Promise.allSettled([store.rename(document.id, '  Renamed  ', 1), store.save(edited, 1)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason.statusCode : null).toBe(409);
    const current = await store.load(document.id);
    expect(current.revision).toBe(2);
    expect(current.title).toBe('Renamed');
    expect(current.clips).toEqual([]);
    const renames = await Promise.allSettled([store.rename(document.id, 'A', 2), store.rename(document.id, 'B', 2)]);
    expect(renames.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.load(document.id)).revision).toBe(3);
    await expect(store.rename(document.id, 'Stale', 2)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.save({ ...current, revision: 3 }, 2)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.rename('missing-project', 'Missing', 0)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.create('   ')).rejects.toThrow();
  });

  it('persists independent empty/imported video and audio bins without timeline clips', async () => {
    const store = new ProjectStore(await temp());
    const first = await store.create('Imported sources');
    const second = await store.create('New empty edit');
    expect(first.media).toEqual({ videoIds: [], audioIds: [] });
    expect(second.media).toEqual(first.media);
    const saved = await store.save(
      { ...first, media: { videoIds: ['recording-one'], audioIds: ['music-one'] } },
      first.revision,
    );
    expect((await store.load(first.id)).media).toEqual(saved.media);
    expect((await store.load(second.id)).media).toEqual({ videoIds: [], audioIds: [] });
    const { media: _media, ...missingBin } = first;
    for (const invalid of [
      missingBin,
      { ...first, media: { videoIds: [] } },
      { ...first, media: { ...first.media, videoIds: ['same', 'same'] } },
      { ...first, media: { ...first.media, audioIds: ['../unsafe'] } },
      { ...first, media: { ...first.media, extra: [] } },
    ]) {
      expect(projectSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('deletes only the chosen project, serialises with saves and prevents a stale tab resurrecting it', async () => {
    const directory = await temp();
    const store = new ProjectStore(directory);
    const first = await store.create('Delete me');
    const second = await store.create('Keep me');
    const kept = new Map<string, string>();
    for (const name of ['original.mp4', 'library.json', 'audio.json', 'proxies/ready.mp4', 'renders/export.mp4']) {
      const filename = path.join(directory, name);
      await mkdir(path.dirname(filename), { recursive: true });
      const bytes = `Keep ${name} unchanged`;
      await writeFile(filename, bytes);
      kept.set(filename, bytes);
    }
    await expect(store.delete(first.id, null)).rejects.toMatchObject({ statusCode: 409 });
    const results = await Promise.allSettled([
      store.save({ ...first, title: 'Newer edit' }, 1),
      store.delete(first.id, 1),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect(await store.load(first.id)).toMatchObject({ title: 'Newer edit', revision: 2 });
    await store.delete(first.id, 2);
    await expect(store.load(first.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.delete(first.id, 2)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.save({ ...first, revision: 2 }, 2)).rejects.toMatchObject({ statusCode: 409 });
    expect(await store.list()).toEqual([expect.objectContaining({ id: second.id })]);
    expect(await store.load(second.id)).toEqual(second);
    for (const [filename, bytes] of kept) expect(await readFile(filename, 'utf8')).toBe(bytes);
  });

  it('explicitly deletes unsupported/corrupt regular files without migration but rejects non-files', async () => {
    const directory = await temp();
    const store = new ProjectStore(directory);
    await store.create('Safe');
    const folder = path.join(directory, 'projects');
    await writeFile(
      path.join(folder, 'old-v4.json'),
      JSON.stringify(unsupportedProject(4, 'old-v4', 'Old shared library')),
    );
    await writeFile(path.join(folder, 'broken.json'), '{broken');
    await mkdir(path.join(folder, 'not-file.json'));
    await expect(store.load('old-v4')).rejects.toThrow('schema version 4');
    await store.delete('old-v4', null);
    await store.delete('broken', null);
    await expect(store.load('old-v4')).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.delete('not-file', null)).rejects.toMatchObject({ statusCode: 422 });
    expect(await readdir(folder)).toContain('not-file.json');
  });

  it('isolates old, incomplete, corrupt, mismatched, non-file and invalid-name entries without changing bytes', async () => {
    const directory = await temp();
    const store = new ProjectStore(directory);
    const good = await store.create('Valid project');
    const folder = path.join(directory, 'projects');
    const old = `${JSON.stringify({ ...createProject('old', 'Original title'), schemaVersion: 1 }, null, 2)}\n`;
    const incompleteClip: Record<string, unknown> = { ...createClip('clip-a', 'video', 0, 30) };
    delete incompleteClip['speed'];
    const incomplete = JSON.stringify({
      ...createProject('incomplete', 'Missing required speed'),
      clips: [incompleteClip],
    });
    const broken = '{not valid JSON';
    const mismatch = JSON.stringify(createProject('another-id', 'Mismatched ID'));
    await Promise.all([
      writeFile(path.join(folder, 'old.json'), old),
      writeFile(path.join(folder, 'incomplete.json'), incomplete),
      writeFile(path.join(folder, 'broken.json'), broken),
      writeFile(path.join(folder, 'mismatch.json'), mismatch),
      writeFile(path.join(folder, 'bad id.json'), '{}'),
      writeFile(path.join(folder, 'ignored.tmp'), 'temporary'),
      mkdir(path.join(folder, 'directory.json')),
    ]);
    const summaries = await store.list();
    expect(summaries).toHaveLength(7);
    expect(summaries.find((summary) => summary.id === good.id)?.compatible).toBe(true);
    expect(summaries.find((summary) => summary.id === 'old')?.title).toBe('Original title');
    const disabled = summaries.filter((summary) => !summary.compatible);
    expect(disabled).toHaveLength(6);
    disabled.forEach((summary) => {
      idSchema.parse(summary.id);
      expect(summary.error).toContain('existing file was not changed');
      expect(summary.error).toContain('create a new project');
    });
    await expect(store.load('old')).rejects.toMatchObject({ statusCode: 422 });
    await expect(store.load('incomplete')).rejects.toThrow('speed');
    await expect(store.load('broken')).rejects.toMatchObject({ statusCode: 422 });
    await expect(store.load('mismatch')).rejects.toThrow('ID does not match');
    await expect(store.rename('old', 'Overwrite', 0)).rejects.toMatchObject({ statusCode: 422 });
    await expect(store.save(createProject('old', 'Overwrite'), 0)).rejects.toMatchObject({ statusCode: 422 });
    expect(await readFile(path.join(folder, 'old.json'), 'utf8')).toBe(old);
    expect(await readFile(path.join(folder, 'incomplete.json'), 'utf8')).toBe(incomplete);
    expect(await readFile(path.join(folder, 'broken.json'), 'utf8')).toBe(broken);
    expect(await readFile(path.join(folder, 'mismatch.json'), 'utf8')).toBe(mismatch);
  });

  it('validates direct-call IDs and refuses project-file, directory and atomic-output symlinks', async () => {
    const directory = await temp();
    const store = new ProjectStore(path.join(directory, 'cache'));
    await store.create('Safe');
    const invalid = ['../escape', '/absolute', 'with/slash', 'with\\slash', '..', 'a'.repeat(101)];
    await Promise.all(
      invalid.map(async (id) => {
        await expect(store.load(id)).rejects.toThrow();
        await expect(store.rename(id, 'Invalid', 0)).rejects.toThrow();
        await expect(store.delete(id, null)).rejects.toThrow();
        await expect(store.save({ ...createProject('safe', 'Safe'), id }, 0)).rejects.toThrow();
      }),
    );
    const original = JSON.stringify(createProject('linked', 'Untouched'));
    const target = path.join(directory, 'original.json');
    await writeFile(target, original);
    await symlink(target, path.join(directory, 'cache', 'projects', 'linked.json'));
    expect((await store.list()).find((summary) => summary.id === 'linked')?.compatible).toBe(false);
    await expect(store.load('linked')).rejects.toThrow('Symlinks');
    await expect(store.save(createProject('linked', 'Overwrite'), 0)).rejects.toThrow('Symlinks');
    await expect(store.delete('linked', null)).rejects.toThrow('Symlinks');
    await expect(atomicWrite(path.join(directory, 'cache', 'projects', 'linked.json'), 'overwrite')).rejects.toThrow(
      'Symlinks',
    );
    await symlink(path.join(directory, 'cache'), path.join(directory, 'cache-link'));
    await expect(new ProjectStore(path.join(directory, 'cache-link')).create('Unsafe')).rejects.toThrow('Symlinks');
    await expect(atomicWrite(path.join(directory, 'cache-link', 'new', 'unsafe.json'), '{}')).rejects.toThrow(
      'Symlinks',
    );
    expect(await readFile(target, 'utf8')).toBe(original);
  });
});

describe('multiple-project HTTP API', () => {
  it('requires a trusted confirmed revision for DELETE and returns missing/conflict errors without removing other data', async () => {
    const directory = await temp();
    const service = await serviceAt(directory);
    const document = await service.projects.create('Delete through API');
    const url = `/api/projects/${document.id}`;
    expect(
      (
        await service.app.inject({
          method: 'DELETE',
          url,
          headers: { host: headers.host },
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect((await service.app.inject({ method: 'DELETE', url, headers, payload: {} })).statusCode).toBe(400);
    expect(
      (await service.app.inject({ method: 'DELETE', url, headers, payload: { expectedRevision: -1 } })).statusCode,
    ).toBe(400);
    expect(
      (await service.app.inject({ method: 'DELETE', url, headers, payload: { expectedRevision: 0 } })).statusCode,
    ).toBe(409);
    expect(
      (await service.app.inject({ method: 'DELETE', url, headers, payload: { expectedRevision: null } })).statusCode,
    ).toBe(409);
    const deleted = await service.app.inject({ method: 'DELETE', url, headers, payload: { expectedRevision: 1 } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect((await service.app.inject({ url, headers })).statusCode).toBe(404);
    expect(
      (await service.app.inject({ method: 'DELETE', url, headers, payload: { expectedRevision: 1 } })).statusCode,
    ).toBe(404);
    expect(
      (
        await service.app.inject({
          method: 'DELETE',
          url: '/api/projects/bad%2Fid',
          headers,
          payload: { expectedRevision: null },
        })
      ).statusCode,
    ).toBe(400);
    await atomicWrite(
      path.join(directory, 'projects', 'legacy.json'),
      JSON.stringify(unsupportedProject(4, 'legacy', 'Old')),
    );
    expect(
      (
        await service.app.inject({
          method: 'DELETE',
          url: '/api/projects/legacy',
          headers,
          payload: { expectedRevision: null },
        })
      ).statusCode,
    ).toBe(200);
    expect(service.jobs.list()).toEqual([]);
  });

  it('rejects unregistered IDs in project bins without accepting or writing the project', async () => {
    const directory = await temp();
    const service = await serviceAt(directory);
    const document = createProject('new-bin', 'Import only');
    for (const media of [
      { videoIds: ['missing-video'], audioIds: [] },
      { videoIds: [], audioIds: ['missing-audio'] },
    ]) {
      expect(
        (
          await service.app.inject({
            method: 'PUT',
            url: '/api/projects/new-bin',
            headers,
            payload: { document: { ...document, media }, expectedRevision: 0 },
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(await service.projects.list()).toEqual([]);
  });

  it('creates, lists, loads, renames and revision-saves projects, including the existing preview-lab key', async () => {
    const directory = await temp();
    const service = await serviceAt(directory);
    const firstResponse = await service.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: 'First' },
    });
    const secondResponse = await service.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: 'Second' },
    });
    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    const first = projectSchema.parse(firstResponse.json().document);
    const second = projectSchema.parse(secondResponse.json().document);
    expect(first.revision).toBe(1);
    expect(first.schemaVersion).toBe(6);
    expect(second.schemaVersion).toBe(6);
    expect(second.id).not.toBe(first.id);
    expect((await service.app.inject({ url: '/api/projects', headers })).json().projects).toHaveLength(2);
    expect((await service.app.inject({ url: `/api/projects/${first.id}`, headers })).json().document).toEqual(first);
    const renamed = await service.app.inject({
      method: 'POST',
      url: `/api/projects/${first.id}/rename`,
      headers,
      payload: { title: '  New title  ', expectedRevision: 1 },
    });
    expect(renamed.statusCode).toBe(200);
    const current = projectSchema.parse(renamed.json().document);
    expect(current.title).toBe('New title');
    expect(current.revision).toBe(2);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: `/api/projects/${first.id}/rename`,
          headers,
          payload: { title: 'Stale', expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: `/api/projects/${first.id}`,
          headers,
          payload: { document: { ...current, title: 'Saved title' }, expectedRevision: 2 },
        })
      ).json().document.revision,
    ).toBe(3);
    const lab = createProject('preview-lab', 'Existing API key');
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/preview-lab',
          headers,
          payload: { document: lab, expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await service.app.inject({ url: '/api/projects/preview-lab', headers })).json().document.revision).toBe(1);
    expect(service.audio.jobs).toBe(service.jobs);
    expect(service.library.jobs).toBe(service.jobs);
    expect(JSON.parse(await readFile(path.join(directory, 'audio.json'), 'utf8'))).toEqual({ version: 1, assets: [] });
  });

  it('keeps local request restrictions and rejects bad titles, revisions, IDs and incompatible loads', async () => {
    const directory = await temp();
    const service = await serviceAt(directory);
    expect((await service.app.inject({ url: '/api/projects', headers: { host: 'attacker.example' } })).statusCode).toBe(
      403,
    );
    expect(
      (await service.app.inject({ url: '/api/audio', headers: { ...headers, origin: 'https://attacker.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: { host: headers.host },
          payload: { title: 'Missing client' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await service.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { title: ' ' } })).statusCode,
    ).toBe(400);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { title: 'X', id: 'chosen-id' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await service.app.inject({ url: '/api/projects/bad%2Fid', headers })).statusCode).toBe(400);
    expect((await service.app.inject({ url: '/api/projects/missing', headers })).statusCode).toBe(404);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/projects/missing/rename',
          headers,
          payload: { title: 'X', expectedRevision: -1 },
        })
      ).statusCode,
    ).toBe(400);
    const old = JSON.stringify({ ...createProject('old', 'Old project'), schemaVersion: 1 });
    await atomicWrite(path.join(directory, 'projects', 'old.json'), old);
    expect((await service.app.inject({ url: '/api/projects', headers })).json().projects[0].compatible).toBe(false);
    const load = await service.app.inject({ url: '/api/projects/old', headers });
    expect(load.statusCode).toBe(422);
    expect(load.json().error).toContain('version 6');
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/old',
          headers,
          payload: { document: createProject('old', 'Overwrite'), expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(422);
    expect(await readFile(path.join(directory, 'projects', 'old.json'), 'utf8')).toBe(old);
    const good = createProject('preview-lab', 'Valid');
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/different',
          headers,
          payload: { document: good, expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('exposes an unsupported-version input as unavailable and refuses load, rename or v6 overwrite', async () => {
    const directory = await temp();
    const unsupported = unsupportedProject(3, 'legacy-v3', 'Original v3');
    const bytes = `${JSON.stringify(unsupported, null, 2)}\n`;
    const filename = path.join(directory, 'projects', 'legacy-v3.json');
    await atomicWrite(filename, bytes);
    expect(projectSchema.safeParse(unsupported).success).toBe(false);
    const service = await serviceAt(directory);
    const listed = await service.app.inject({ url: '/api/projects', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().projects).toEqual([
      expect.objectContaining({
        id: 'legacy-v3',
        title: 'Original v3',
        compatible: false,
        clipCount: 0,
        revision: 0,
        duration: 0,
      }),
    ]);
    const loaded = await service.app.inject({ url: '/api/projects/legacy-v3', headers });
    expect(loaded.statusCode).toBe(422);
    expect(loaded.json().error).toContain('schema version 3');
    expect(loaded.json().error).toContain('requires version 6');
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/projects/legacy-v3/rename',
          headers,
          payload: { title: 'Overwrite', expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/legacy-v3',
          headers,
          payload: { document: createProject('legacy-v3', 'Overwrite'), expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(422);
    expect(await readFile(filename, 'utf8')).toBe(bytes);
    expect(service.jobs.list()).toEqual([]);
  });

  it('validates registered video and music source ranges/identity without changing video registrations', async () => {
    const directory = await temp();
    const dataDir = path.join(directory, 'cache');
    const sources = path.join(directory, 'unit-source-identities');
    await mkdir(sources);
    const videoPath = path.join(sources, 'video.mp4');
    const musicPath = path.join(sources, 'music.wav');
    // Unit-only identity bytes: no decoder or preparation process is launched.
    await writeFile(videoPath, 'disposable video identity');
    await writeFile(musicPath, 'disposable music identity');
    const video = mediaAssetSchema.parse({
      id: 'video-unit',
      name: 'video.mp4',
      sourcePath: videoPath,
      fingerprint: await fingerprintFile(videoPath),
      metadata: {
        width: 320,
        height: 180,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        frameRate: { ...PROJECT_FPS },
        frameCount: 120,
        durationSeconds: framesToSeconds(120),
        colourPrimaries: 'bt709',
        colourTransfer: 'bt709',
        colourSpace: 'bt709',
        colourRange: 'tv',
        hasAudio: false,
      },
      status: 'registered',
      error: null,
      prepared: null,
    });
    const music = audioAssetSchema.parse({
      ...registryAsset(sources, 'music-unit', 'registered'),
      sourcePath: musicPath,
      fingerprint: await fingerprintFile(musicPath),
      waveform: [],
    });
    await atomicWrite(path.join(dataDir, 'library.json'), JSON.stringify({ version: 1, assets: [video] }));
    await atomicWrite(path.join(dataDir, 'audio.json'), JSON.stringify({ version: 1, assets: [music] }));
    const service = await serviceAt(dataDir);
    const document = projectSchema.parse({
      ...createProject('preview-lab', 'Video and music'),
      clips: [createClip('clip-a', video.id, 0, 120)],
      music: {
        mediaId: music.id,
        sourceIn: 0,
        sourceOut: 59,
        start: 10,
        duration: 50,
        gainDb: -6,
        fadeIn: 5,
        fadeOut: 5,
        loop: false,
      },
    });
    const saved = await service.app.inject({
      method: 'PUT',
      url: '/api/projects/preview-lab',
      headers,
      payload: { document, expectedRevision: 0 },
    });
    expect(saved.statusCode).toBe(200);
    const current = projectSchema.parse(saved.json().document);
    const videoTooLong = { ...current, clips: [createClip('clip-a', video.id, 0, 121)] };
    const musicTooLong = { ...current, music: { ...current.music!, sourceOut: 60 } };
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/preview-lab',
          headers,
          payload: { document: videoTooLong, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/preview-lab',
          headers,
          payload: { document: musicTooLong, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/preview-lab',
          headers,
          payload: {
            document: { ...current, music: { ...current.music!, mediaId: 'missing-audio' } },
            expectedRevision: 1,
          },
        })
      ).statusCode,
    ).toBe(404);
    await writeFile(musicPath, 'changed disposable identity');
    expect(
      (
        await service.app.inject({
          method: 'PUT',
          url: '/api/projects/preview-lab',
          headers,
          payload: { document: current, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect((await service.projects.load('preview-lab')).revision).toBe(1);
    expect(service.library.list()).toEqual([video]);
    expect(service.audio.get(music.id).metadata).toEqual(music.metadata);
    expect(service.jobs.list()).toEqual([]);
  });
});

describe('audio registry and HTTP registration boundary', () => {
  it('persists interrupted queued/running preparations as explicit-retry errors and returns immutable copies', async () => {
    const directory = await temp();
    const queued = registryAsset(directory, 'queued-music', 'queued');
    const running = registryAsset(directory, 'running-music', 'preparing');
    await atomicWrite(path.join(directory, 'audio.json'), JSON.stringify({ version: 1, assets: [queued, running] }));
    const queue = new JobQueue();
    queues.push(queue);
    const audio = new AudioLibrary(createConfig({ dataDir: directory }), queue);
    await audio.initialise();
    audio.list().forEach((asset) => {
      expect(asset.status).toBe('error');
      expect(asset.error).toContain('interrupted');
      expect(asset.waveform).toEqual([]);
    });
    const saved = JSON.parse(await readFile(path.join(directory, 'audio.json'), 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.assets.every((asset: AudioAsset) => asset.status === 'error' && asset.waveform.length === 0)).toBe(
      true,
    );
    const external = audio.get(queued.id);
    external.metadata.sampleRate = 1;
    external.fingerprint.digest = 'b'.repeat(64);
    expect(audio.get(queued.id).metadata).toEqual(queued.metadata);
    expect(audio.get(queued.id).fingerprint).toEqual(queued.fingerprint);
    await expect(audio.prepare('../invalid')).rejects.toThrow();
    expect(() => audio.get('../invalid')).toThrow();
    expect(queue.list()).toEqual([]);
  });

  it('wires asset/job registration and explicit retry without accepting arbitrary bodies or downloads', async () => {
    const directory = await temp();
    const asset = registryAsset(directory, 'music-unit', 'registered');
    await atomicWrite(path.join(directory, 'audio.json'), JSON.stringify({ version: 1, assets: [asset] }));
    const service = await serviceAt(directory);
    const job: MediaJob = {
      id: 'audio-job',
      kind: 'audio',
      label: asset.name,
      state: 'queued',
      progress: 0,
      message: 'Waiting',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      outputUrl: null,
      receiptUrl: null,
    };
    const register = vi.spyOn(service.audio, 'register').mockResolvedValue({ asset, job });
    const prepare = vi.spyOn(service.audio, 'prepare').mockResolvedValue(job);
    expect((await service.app.inject({ url: '/api/audio', headers })).json().assets).toEqual([asset]);
    const registered = await service.app.inject({
      method: 'POST',
      url: '/api/audio/register',
      headers,
      payload: { path: asset.sourcePath },
    });
    expect(registered.statusCode).toBe(202);
    expect(registered.json()).toEqual({ asset, job });
    expect(register).toHaveBeenCalledWith(asset.sourcePath);
    expect(
      (await service.app.inject({ method: 'POST', url: '/api/audio/music-unit/prepare', headers, payload: {} })).json(),
    ).toEqual({ job });
    expect(prepare).toHaveBeenCalledWith(asset.id);
    expect(
      (await service.app.inject({ method: 'POST', url: '/api/audio/register', headers, payload: { path: 42 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/audio/music-unit/prepare',
          headers,
          payload: { implicit: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/audio/music-unit/prepare',
          headers: { ...headers, 'sec-fetch-site': 'cross-site' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/audio/register',
          headers: { host: headers.host },
          payload: { path: asset.sourcePath },
        })
      ).statusCode,
    ).toBe(403);
    expect((await service.app.inject({ url: '/api/audio/music-unit/playback', headers })).statusCode).toBe(409);
    expect((await service.app.inject({ url: '/api/audio/music-unit/waveform', headers })).statusCode).toBe(409);
    expect((await service.app.inject({ url: '/api/audio/unknown/playback', headers })).statusCode).toBe(404);
    expect((await service.app.inject({ url: '/api/file?path=/etc/passwd', headers })).statusCode).toBe(404);
  });
});

describe('bounded streaming PCM peaks', () => {
  it('handles split sample bytes and normalises signed peaks without losing stereo channel peaks', () => {
    const reducer = new PcmPeakReducer(1);
    const samples = Buffer.alloc(8);
    samples.writeInt16LE(0, 0);
    samples.writeInt16LE(-32_768, 2);
    samples.writeInt16LE(16_384, 4);
    samples.writeInt16LE(-16_384, 6);
    for (const byte of samples) reducer.add(Buffer.from([byte]));
    const peaks = reducer.finish();
    expect(peaks).toHaveLength(100);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1)).toBe(true);
  });
  it('reduces more than 32 MiB through a reused small chunk to at most 2048 peaks', () => {
    const reducer = new PcmPeakReducer(200);
    const chunk = Buffer.alloc(64 * 1024).fill(Buffer.from([0, 64]));
    for (let count = 0; count < 520; count++) reducer.add(chunk);
    expect(chunk.length * 520).toBeGreaterThan(32 * 1024 * 1024);
    const peaks = reducer.finish();
    expect(peaks).toHaveLength(2048);
    expect(Math.max(...peaks)).toBe(0.5);
  });
  it('rejects empty or truncated PCM output rather than marking a cache ready', () => {
    expect(() => new PcmPeakReducer(1).finish()).toThrow('no audio samples');
    const reducer = new PcmPeakReducer(1);
    reducer.add(Buffer.from([0, 0, 0]));
    expect(() => reducer.finish()).toThrow('incomplete PCM');
  });
});
