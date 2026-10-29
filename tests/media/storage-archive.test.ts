import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig } from '../../src/server/config.js';
import { restoreExports } from '../../src/server/export-archive.js';
import { JobQueue } from '../../src/server/jobs.js';
import { ProjectStore } from '../../src/server/storage.js';
import { createAdjustment, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe, uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, PROJECT_SCHEMA_VERSION } from '../../src/shared/model.js';
import { SPATIAL_CHANNELS, type SpatialChannel } from '../../src/shared/spatial.js';
import { EARLIER_SCHEMA_VERSIONS, SUPPORTED_VERSIONS, unsupportedProject } from '../unit/project-fixtures.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const NO_POSE = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as Record<SpatialChannel, null>;
const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-schema13-storage-media-'));
  roots.push(root);
  return root;
}

describe.skipIf(!enabled)('current-schema storage/archive integration · generated files only, no migrations', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('loads strict current-schema grades, fourteen-setting grade keyframes and Opacity keys, and preserves unsupported earlier versions', async () => {
    const root = await temp();
    const store = new ProjectStore(root);
    const project = createProject('strict-current', 'Strict current document');
    project.media = { videoIds: ['generated-original', 'unplaced-original'], audioIds: ['unplaced-music'] };
    const clip = {
      ...createClip('current-clip', 'generated-original', 0, 4),
      speed: { mode: 'constant' as const, rate: 0.5 },
    };
    clip.grade.colour.temperature = 0.75;
    clip.grade.colour.tint = -0.65;
    project.clips = [clip];
    project.adjustments = [
      {
        ...createAdjustment('look', 0, 8),
        keyframes: [
          layerKeyAsGradeKey(layerKeyframe(0, { ...EMPTY_KEY_VALUES, temperature: -1 }, 'linear')),
          layerKeyAsGradeKey(layerKeyframe(5000, { ...EMPTY_KEY_VALUES, exposure: 0.25, tint: 1 }, 'ease-out')),
        ],
      },
    ];
    project.layers[0]!.transform.keyframes = [
      { ...uniformKeyframe(0, { ...NO_POSE, opacity: 0.8 }, 'linear'), reset: false },
    ];
    const saved = await store.save(project, 0);
    expect(saved.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(saved.media).toEqual(project.media);
    expect(saved.clips[0]!.grade.colour).toMatchObject({ temperature: 0.75, tint: -0.65 });
    expect(saved.adjustments).toEqual(project.adjustments);
    expect(saved.layers[0]!.transform.keyframes).toEqual(project.layers[0]!.transform.keyframes);
    for (const keyframe of saved.adjustments[0]!.keyframes) {
      expect(Object.keys(keyframe.values)).toHaveLength(14);
      expect(keyframe.values).not.toHaveProperty('speed');
      expect(keyframe.values).not.toHaveProperty('opacity');
      expect(keyframe.values).toHaveProperty('temperature');
      expect(keyframe.values).toHaveProperty('tint');
    }
    expect(await store.load(saved.id)).toEqual(saved);
    const currentPath = path.join(root, 'projects', `${saved.id}.json`);
    const currentBytes = await readFile(currentPath);
    const old = [];
    for (const version of EARLIER_SCHEMA_VERSIONS) {
      const id = `original-v${version}`;
      const title = `Preserved original version ${version}`;
      const document = unsupportedProject(version, id, title);
      const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
      const filename = path.join(root, 'projects', `${id}.json`);
      await writeFile(filename, bytes);
      old.push({ id, title, version, filename, bytes });
      await expect(store.load(id)).rejects.toThrow(
        `schema version ${version}; this build requires ${SUPPORTED_VERSIONS}`,
      );
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
        error: expect.stringContaining(`requires ${SUPPORTED_VERSIONS}`),
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
    project.layers[0]!.transform.base.opacity = 0.65;
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

  it('rejects missing/out-of-range current-schema gains and removed appearance/speed fields without defaults', async () => {
    const root = await temp();
    const store = new ProjectStore(root);
    const directory = path.join(root, 'projects');
    await mkdir(directory);
    const valid = createProject('malformed-current', 'Must remain strict');
    valid.clips = [createClip('current', 'generated-original', 0, 4)];
    const grade = valid.clips[0]!.grade;
    /** The valid project with one clip grade keyframe whose values are `values`. */
    const gradeKey = (values: Record<string, unknown>, frame = 0) => {
      const key = layerKeyAsGradeKey(layerKeyframe(frame, { ...EMPTY_KEY_VALUES, exposure: 0.25 }, 'linear'));
      return { ...valid, clips: [{ ...valid.clips[0]!, grade: { ...grade, keyframes: [{ ...key, values }] } }] };
    };
    const gradeValues = (): Record<string, unknown> =>
      layerKeyAsGradeKey(layerKeyframe(0, { ...EMPTY_KEY_VALUES, exposure: 0.25 }, 'linear')).values;
    const missingMedia: Record<string, unknown> = { ...valid };
    delete missingMedia['media'];
    const missingAdjustments: Record<string, unknown> = { ...valid };
    delete missingAdjustments['adjustments'];
    const missingGrade: Record<string, unknown> = { ...valid.clips[0]! };
    delete missingGrade['grade'];
    const missingClip: Record<string, unknown> = { ...valid.clips[0]! };
    delete missingClip['speed'];
    const missingTransform: Record<string, unknown> = { ...valid.layers[0]! };
    delete missingTransform['transform'];
    const missingValues = gradeValues();
    delete missingValues['hue'];
    const variants: Record<string, unknown>[] = [
      missingMedia,
      { ...valid, media: { videoIds: [] } },
      { ...valid, media: { audioIds: [] } },
      missingAdjustments,
      { ...valid, clips: [missingGrade] },
      { ...valid, clips: [{ ...valid.clips[0]!, opacity: 1 }] },
      gradeKey({ ...gradeValues(), layerOpacity: null }),
      gradeKey({ ...gradeValues(), opacity: 0.5 }),
      { ...valid, clips: [missingClip] },
      {
        ...valid,
        clips: [
          {
            ...valid.clips[0]!,
            speed: { mode: 'ramp', startRate: 0.5, endRate: 2, curve: 'linear', anchorIn: 0, anchorOut: 4 },
          },
        ],
      },
      gradeKey({ ...gradeValues(), speed: null }),
      { ...valid, layers: [missingTransform] },
      { ...valid, layers: [{ ...valid.layers[0]!, transform: { ...valid.layers[0]!.transform, unknown: true } }] },
      { ...valid, clips: [{ ...valid.clips[0]!, spatial: valid.layers[0]!.transform }] },
      { ...valid, unexpected: true },
      // The removed track appearance: track Colour, keyframes and Opacity.
      { ...valid, layers: [{ ...valid.layers[0]!, colour: grade.colour }] },
      { ...valid, layers: [{ ...valid.layers[0]!, keyframes: [] }] },
      { ...valid, layers: [{ ...valid.layers[0]!, opacity: 1 }] },
      ...(
        [
          ['temperature', 2],
          ['tint', 1],
        ] as const
      ).flatMap(([setting, limit]) => {
        const colour: Record<string, unknown> = { ...grade.colour };
        delete colour[setting];
        const values = gradeValues();
        delete values[setting];
        return [
          { ...valid, clips: [{ ...valid.clips[0]!, grade: { ...grade, colour } }] },
          { ...valid, clips: [{ ...valid.clips[0]!, [setting]: 0 }] },
          { ...valid, clips: [{ ...valid.clips[0]!, colour: { ...grade.colour, [setting]: 0.5 } }] },
          gradeKey(values),
          ...[null, -limit - 0.001, limit + 0.001, '0'].map((value) => ({
            ...valid,
            clips: [{ ...valid.clips[0]!, grade: { ...grade, colour: { ...grade.colour, [setting]: value } } }],
          })),
          ...[-limit - 0.001, limit + 0.001, '0'].map((value) => gradeKey({ ...gradeValues(), [setting]: value })),
        ];
      }),
      gradeKey(missingValues, 100),
      ...['ripple', 'transitions', 'openingFade', 'closingFade'].map((field) => {
        const row: Record<string, unknown> = { ...valid.layers[0]! };
        delete row[field];
        return { ...valid, layers: [row] };
      }),
      (() => {
        const base: Record<string, unknown> = { ...valid.layers[0]!.transform.base };
        delete base['opacity'];
        return { ...valid, layers: [{ ...valid.layers[0]!, transform: { ...valid.layers[0]!.transform, base } }] };
      })(),
      { ...valid, transitions: [] },
      { ...valid, openingFade: 0 },
      { ...valid, closingFade: 0 },
      gradeKey({ ...gradeValues(), clipOpacity: null }),
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

  it('restores only strict current-schema snapshots in version-1 receipts and preserves earlier outputs/receipts byte-for-byte', async () => {
    const root = await temp();
    const config = createConfig({ dataDir: root });
    const jobs = new JobQueue();
    const snapshot = createProject('current-export', 'Current verified export');
    snapshot.clips = [createClip('one', 'generated-original', 0, 2)];
    snapshot.clips[0]!.grade = {
      colour: { ...snapshot.clips[0]!.grade.colour, temperature: -0.85, tint: 0.9 },
      keyframes: [
        layerKeyAsGradeKey(
          layerKeyframe(1, { ...EMPTY_KEY_VALUES, exposure: 0.1, temperature: 1, tint: -1 }, 'smooth'),
        ),
      ],
    };
    snapshot.adjustments = [
      {
        ...createAdjustment('look', 0, 2),
        keyframes: [layerKeyAsGradeKey(layerKeyframe(50, { ...EMPTY_KEY_VALUES, saturation: 1.2 }, 'linear'))],
      },
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
      const current = await archive(snapshot, 'current schema');
      const older = [];
      for (const version of EARLIER_SCHEMA_VERSIONS) {
        const document = unsupportedProject(version, `old-${version}`, `Original ${version}`);
        older.push({ ...(await archive(document, `v${version}`)), version });
      }
      const layer = snapshot.layers[0]!;
      const clip = snapshot.clips[0]!;
      const missingKeys: Record<string, unknown> = { ...layer.transform };
      delete missingKeys['keyframes'];
      const malformed = await archive(
        { ...snapshot, layers: [{ ...layer, transform: missingKeys }] },
        'Malformed current schema',
      );
      const missingTiming = [];
      for (const field of ['opacity', 'ripple', 'transitions', 'openingFade', 'closingFade']) {
        // Opacity is part of the track Transform's pose.
        const row: Record<string, unknown> = { ...layer };
        const base: Record<string, unknown> = { ...layer.transform.base };
        if (field === 'opacity') {
          delete base[field];
          row['transform'] = { ...layer.transform, base };
        } else delete row[field];
        missingTiming.push({ ...(await archive({ ...snapshot, layers: [row] }, `Missing ${field}`)), field });
      }
      const missingGains = [];
      for (const setting of ['temperature', 'tint'] as const) {
        const colour: Record<string, unknown> = { ...clip.grade.colour };
        delete colour[setting];
        missingGains.push({
          ...(await archive(
            { ...snapshot, clips: [{ ...clip, grade: { ...clip.grade, colour } }] },
            `Missing grade ${setting}`,
          )),
          setting,
        });
        const values: Record<string, unknown> = { ...clip.grade.keyframes[0]!.values };
        delete values[setting];
        missingGains.push({
          ...(await archive(
            {
              ...snapshot,
              clips: [{ ...clip, grade: { ...clip.grade, keyframes: [{ ...clip.grade.keyframes[0]!, values }] } }],
            },
            `Missing nullable ${setting}`,
          )),
          setting,
        });
      }
      const removedAppearance = [
        await archive({ ...snapshot, clips: [{ ...clip, opacity: 1 }] }, 'Removed clip opacity'),
      ];
      for (const setting of ['layerOpacity', 'clipOpacity'])
        removedAppearance.push(
          await archive(
            {
              ...snapshot,
              clips: [
                {
                  ...clip,
                  grade: {
                    ...clip.grade,
                    keyframes: [
                      { ...clip.grade.keyframes[0]!, values: { ...clip.grade.keyframes[0]!.values, [setting]: null } },
                    ],
                  },
                },
              ],
            },
            `Removed ${setting}`,
          ),
        );
      const warnings = await restoreExports(config, jobs);
      // Every earlier version plus the 13 malformed current-schema archives.
      const rejected = EARLIER_SCHEMA_VERSIONS.length + 13;
      expect(warnings).toHaveLength(rejected);
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
          `Unsupported export snapshot schema version ${entry.version}; this build requires ${SUPPORTED_VERSIONS}`,
        );
        expect(warnings.find((warning) => warning.startsWith(`${entry.id}:`))).toContain(
          'successful output were not changed',
        );
      }
      expect(warnings.find((warning) => warning.startsWith(`${malformed.id}:`))).toContain('keyframes');
      for (const entry of missingTiming)
        expect(warnings.find((warning) => warning.startsWith(`${entry.id}:`))).toContain(entry.field);
      for (const entry of missingGains) {
        const warning = warnings.find((warning) => warning.startsWith(`${entry.id}:`));
        expect(warning).toContain(entry.setting);
        expect(warning).toContain('successful output were not changed');
      }
      for (const entry of removedAppearance)
        expect(warnings.find((warning) => warning.startsWith(`${entry.id}:`))).toContain(
          'successful output were not changed',
        );
      for (const entry of [current, ...older, malformed, ...missingTiming, ...missingGains, ...removedAppearance]) {
        expect(await readFile(path.join(entry.folder, 'receipt.json'))).toEqual(entry.receipt);
        expect(await readFile(path.join(entry.folder, 'export.mp4'))).toEqual(entry.output);
      }
      expect(await restoreExports(config, jobs)).toHaveLength(rejected);
      expect(jobs.list()).toHaveLength(1);
    } finally {
      await jobs.close();
    }
  });
});
