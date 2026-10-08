import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig } from '../../src/server/config.js';
import { restoreExports } from '../../src/server/export-archive.js';
import { JobQueue } from '../../src/server/jobs.js';
import { ProjectStore } from '../../src/server/storage.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject } from '../../src/shared/model.js';
import { unsupportedProject } from '../unit/project-fixtures.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-schema10-storage-media-'));
  roots.push(root);
  return root;
}

describe.skipIf(!enabled)('schema-10 storage/archive integration · generated files only, no migrations', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('loads strict v10 points/bins and lists/rejects unsupported versions through v9 without rewriting them', async () => {
    const root = await temp();
    const store = new ProjectStore(root);
    const project = createProject('strict-v10', 'Strict current document');
    project.media = { videoIds: ['generated-original', 'unplaced-original'], audioIds: ['unplaced-music'] };
    project.clips = [createClip('current-clip', 'generated-original', 0, 4)];
    project.layers[0]!.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: 0.5, opacity: 0.8 } },
      { frame: 5000, interpolation: 'ease-out', values: { ...EMPTY_KEY_VALUES, exposure: 0.25 } },
    ];
    const saved = await store.save(project, 0);
    expect(saved.schemaVersion).toBe(10);
    expect(saved.media).toEqual(project.media);
    expect(await store.load(saved.id)).toEqual(saved);
    const currentPath = path.join(root, 'projects', `${saved.id}.json`);
    const currentBytes = await readFile(currentPath);
    const old = [];
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const id = `original-v${version}`;
      const title = `Preserved original version ${version}`;
      const document = unsupportedProject(version, id, title);
      const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
      const filename = path.join(root, 'projects', `${id}.json`);
      await writeFile(filename, bytes);
      old.push({ id, title, version, filename, bytes });
      await expect(store.load(id)).rejects.toThrow(`schema version ${version}; this build requires version 10`);
      await expect(store.rename(id, 'Must not rewrite an older file', 0)).rejects.toThrow(
        'existing file was not changed',
      );
      await expect(store.save(createProject(id, 'No migration'), 0)).rejects.toThrow('existing file was not changed');
    }
    const summaries = await store.list();
    expect(summaries.find((summary) => summary.id === saved.id)).toMatchObject({
      compatible: true,
      revision: 1,
      clipCount: 1,
      duration: 8,
      error: null,
    });
    for (const entry of old) {
      expect(summaries.find((summary) => summary.id === entry.id)).toMatchObject({
        id: entry.id,
        title: entry.title,
        compatible: false,
        revision: 0,
        clipCount: 0,
        duration: 0,
        error: expect.stringContaining(`requires version 10`),
      });
      expect(await readFile(entry.filename)).toEqual(entry.bytes);
    }
    expect(await readFile(currentPath)).toEqual(currentBytes);
  });

  it('round-trips arbitrary mixed-Ripple tracks with track-owned transitions/fades and dormant empty-track fades', async () => {
    const root = await temp();
    const store = new ProjectStore(root);
    const project = createProject('strict-tracks', 'Role-independent saved tracks');
    project.layers = [
      {
        ...createLayer('positioned', 'Independent', false),
        opacity: 0.65,
        openingFade: 1,
        closingFade: 1,
        transitions: [{ leftId: 'left', rightId: 'right', type: 'cross-dissolve', duration: 2 }],
      },
      {
        ...createLayer('packed', 'Ripple', true),
        openingFade: 1,
        closingFade: 1,
        transitions: [{ leftId: 'packed-left', rightId: 'packed-right', type: 'cut', duration: 0 }],
      },
      { ...createLayer('empty', 'Dormant fades', false), openingFade: 7, closingFade: 9 },
    ];
    project.clips = [
      { ...createClip('right', 'generated-original', 8, 12, 'positioned'), start: 4 },
      { ...createClip('packed-left', 'generated-original', 0, 4, 'packed'), start: 3 },
      { ...createClip('left', 'generated-original', 0, 4, 'positioned'), start: 2 },
      { ...createClip('packed-right', 'generated-original', 4, 8, 'packed'), start: 7 },
    ];
    project.media.videoIds = ['generated-original'];
    const saved = await store.save(project, 0);
    expect(saved).toEqual({ ...project, revision: 1 });
    expect(await store.load(project.id)).toEqual(saved);
    expect(saved).not.toHaveProperty('transitions');
    expect(saved).not.toHaveProperty('openingFade');
    expect(saved).not.toHaveProperty('closingFade');
    expect((await store.list()).find((item) => item.id === project.id)).toMatchObject({
      compatible: true,
      duration: 11,
      clipCount: 4,
      revision: 1,
      error: null,
    });
    const filename = path.join(root, 'projects', `${project.id}.json`);
    const bytes = await readFile(filename);
    expect(await store.load(project.id)).toEqual(saved);
    expect(await readFile(filename)).toEqual(bytes);
  });

  it('rejects malformed v9 and removed opacity fields without synthesizing missing current fields', async () => {
    const root = await temp();
    const store = new ProjectStore(root);
    const directory = path.join(root, 'projects');
    await mkdir(directory);
    const valid = createProject('malformed-v9', 'Must remain strict');
    valid.clips = [createClip('current', 'generated-original', 0, 4)];
    const missingMedia: Record<string, unknown> = { ...valid };
    delete missingMedia['media'];
    const missingRow: Record<string, unknown> = { ...valid.layers[0]! };
    delete missingRow['keyframes'];
    const missingClip: Record<string, unknown> = { ...valid.clips[0]! };
    delete missingClip['speed'];
    const missingSpatial: Record<string, unknown> = { ...valid.clips[0]! };
    delete missingSpatial['spatial'];
    const missingValues: Record<string, unknown> = { ...EMPTY_KEY_VALUES, exposure: 0.25 };
    delete missingValues['hue'];
    const variants: Record<string, unknown>[] = [
      missingMedia,
      { ...valid, media: { videoIds: [] } },
      { ...valid, media: { audioIds: [] } },
      { ...valid, layers: [missingRow] },
      { ...valid, clips: [{ ...valid.clips[0]!, opacity: 1 }] },
      {
        ...valid,
        layers: [
          {
            ...valid.layers[0]!,
            keyframes: [
              {
                frame: 0,
                interpolation: 'linear',
                values: { ...EMPTY_KEY_VALUES, opacity: 0.5, layerOpacity: null },
              },
            ],
          },
        ],
      },
      { ...valid, clips: [missingClip] },
      { ...valid, clips: [missingSpatial] },
      { ...valid, clips: [{ ...valid.clips[0]!, spatial: { ...valid.clips[0]!.spatial, unknown: true } }] },
      { ...valid, unexpected: true },
      {
        ...valid,
        layers: [{ ...valid.layers[0]!, keyframes: [{ frame: 100, interpolation: 'linear', values: missingValues }] }],
      },
      ...['opacity', 'ripple', 'transitions', 'openingFade', 'closingFade'].map((field) => {
        const row: Record<string, unknown> = { ...valid.layers[0]! };
        delete row[field];
        return { ...valid, layers: [row] };
      }),
      { ...valid, transitions: [] },
      { ...valid, openingFade: 0 },
      { ...valid, closingFade: 0 },
      {
        ...valid,
        layers: [
          {
            ...valid.layers[0]!,
            keyframes: [
              {
                frame: 0,
                interpolation: 'linear',
                values: { ...EMPTY_KEY_VALUES, opacity: 0.5, clipOpacity: null },
              },
            ],
          },
        ],
      },
    ];
    for (const [index, variant] of variants.entries()) {
      const id = `malformed-${index}`;
      const filename = path.join(directory, `${id}.json`);
      const bytes = Buffer.from(`${JSON.stringify({ ...variant, id })}\n`);
      await writeFile(filename, bytes);
      await expect(store.load(id)).rejects.toThrow('Cannot open this project');
      await expect(store.save(createProject(id, 'No defaults or rewrite'), 0)).rejects.toThrow(
        'existing file was not changed',
      );
      expect(await readFile(filename)).toEqual(bytes);
    }
    expect((await store.list()).every((summary) => !summary.compatible)).toBe(true);
  });

  it('restores only strict v10 snapshots in version-1 receipts and preserves earlier outputs/receipts byte-for-byte', async () => {
    const root = await temp();
    const config = createConfig({ dataDir: root });
    const jobs = new JobQueue();
    const snapshot = createProject('current-export', 'Current verified export');
    snapshot.clips = [createClip('one', 'generated-original', 0, 2)];
    snapshot.layers[0]!.keyframes = [
      { frame: 50, interpolation: 'smooth', values: { ...EMPTY_KEY_VALUES, exposure: 0.1 } },
    ];
    async function archive(document: unknown, label: string) {
      const id = randomUUID();
      const folder = path.join(root, 'renders', id);
      await mkdir(folder, { recursive: true });
      const receipt = Buffer.from(
        JSON.stringify({
          kind: 'export',
          schemaVersion: 1,
          jobId: id,
          createdAt: '2026-10-03T00:00:00.000Z',
          snapshot: document,
          profile: 'draft720',
          musicSources: [],
          settings: { audio: [] },
          verification: { frameCount: 2, fullDecode: true, faststart: true },
        }),
      );
      const output = Buffer.from(`Preserved successful-output sentinel: ${label}`);
      await writeFile(path.join(folder, 'receipt.json'), receipt);
      await writeFile(path.join(folder, 'export.mp4'), output);
      return { id, folder, receipt, output };
    }
    try {
      const current = await archive(snapshot, 'v9');
      const older = [];
      for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const document = unsupportedProject(version, `old-${version}`, `Original ${version}`);
        older.push({ ...(await archive(document, `v${version}`)), version });
      }
      const missingRow: Record<string, unknown> = { ...snapshot.layers[0]! };
      delete missingRow['keyframes'];
      const malformed = await archive({ ...snapshot, layers: [missingRow] }, 'Malformed v9');
      const missingTiming = [];
      for (const field of ['opacity', 'ripple', 'transitions', 'openingFade', 'closingFade']) {
        const row: Record<string, unknown> = { ...snapshot.layers[0]! };
        delete row[field];
        missingTiming.push({ ...(await archive({ ...snapshot, layers: [row] }, `Missing ${field}`)), field });
      }
      const removedAppearance = [
        await archive({ ...snapshot, clips: [{ ...snapshot.clips[0]!, opacity: 1 }] }, 'Removed clip opacity'),
      ];
      for (const setting of ['layerOpacity', 'clipOpacity'])
        removedAppearance.push(
          await archive(
            {
              ...snapshot,
              layers: [
                {
                  ...snapshot.layers[0]!,
                  keyframes: [
                    {
                      frame: 0,
                      interpolation: 'linear',
                      values: { ...EMPTY_KEY_VALUES, opacity: 0.5, [setting]: null },
                    },
                  ],
                },
              ],
            },
            `Removed ${setting}`,
          ),
        );
      const warnings = await restoreExports(config, jobs);
      expect(warnings).toHaveLength(18);
      expect(jobs.list().map((job) => job.id)).toEqual([current.id]);
      expect(jobs.get(current.id)).toMatchObject({
        kind: 'export',
        state: 'completed',
        progress: 1,
        outputUrl: `/api/jobs/${current.id}/export`,
        receiptUrl: `/api/jobs/${current.id}/receipt`,
      });
      for (const entry of older) {
        expect(warnings.find((warning) => warning.startsWith(`${entry.id}:`))).toContain(
          `Unsupported export snapshot schema version ${entry.version}; this build requires version 10`,
        );
        expect(warnings.find((warning) => warning.startsWith(`${entry.id}:`))).toContain(
          'successful output were not changed',
        );
      }
      expect(warnings.find((warning) => warning.startsWith(`${malformed.id}:`))).toContain('keyframes');
      for (const entry of missingTiming)
        expect(warnings.find((warning) => warning.startsWith(`${entry.id}:`))).toContain(entry.field);
      for (const entry of removedAppearance)
        expect(warnings.find((warning) => warning.startsWith(`${entry.id}:`))).toContain(
          'successful output were not changed',
        );
      for (const entry of [current, ...older, malformed, ...missingTiming, ...removedAppearance]) {
        expect(await readFile(path.join(entry.folder, 'receipt.json'))).toEqual(entry.receipt);
        expect(await readFile(path.join(entry.folder, 'export.mp4'))).toEqual(entry.output);
      }
      expect(await restoreExports(config, jobs)).toHaveLength(18);
      expect(jobs.list()).toHaveLength(1);
    } finally {
      await jobs.close();
    }
  });
});
