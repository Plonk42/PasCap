import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { restoreExports } from '../../src/server/export-archive.js';
import { JobQueue } from '../../src/server/jobs.js';
import { audioAssetSchema } from '../../src/shared/audio.js';
import { planExportMusic } from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { framesToSeconds } from '../../src/shared/timing.js';
import { unsupportedProject } from './project-fixtures.js';

function audioAsset(id: string) {
  return audioAssetSchema.parse({
    id,
    name: 'song.wav',
    sourcePath: '/synthetic/song.wav',
    fingerprint: {
      algorithm: 'sampled-sha256-v1',
      digest: 'a'.repeat(64),
      size: 192000,
      mtimeMs: 0,
      device: 1,
      inode: 1,
    },
    metadata: {
      codec: 'pcm_s16le',
      sampleRate: 48000,
      channels: 2,
      durationSeconds: framesToSeconds(120),
      frameCount: 120,
    },
    status: 'registered',
    error: null,
    waveform: [],
  });
}

function receiptFixture(snapshot: ProjectDocument, jobId: string) {
  const duration = calculateLayout(snapshot).duration;
  return {
    kind: 'export',
    schemaVersion: 1,
    jobId,
    createdAt: new Date().toISOString(),
    snapshot,
    profile: 'draft720',
    musicSources: [...new Set(snapshot.music.map((music) => music.mediaId))].map(audioAsset),
    settings: { audio: snapshot.music.map((music) => planExportMusic(music, duration)) },
    verification: { frameCount: duration, fullDecode: true, faststart: true },
  };
}

function musicProject() {
  const snapshot = createProject('music-flight', 'Music flight');
  snapshot.clips.push(createClip('one', 'source', 0, 10));
  snapshot.music = [
    {
      id: 'music-0',
      mediaId: 'song',
      sourceIn: 2,
      sourceOut: 32,
      start: 5,
      duration: 40,
      gainDb: -6,
      fadeIn: 3,
      fadeOut: 4,
      loop: true,
    },
  ];
  return snapshot;
}

type ReceiptFixture = ReturnType<typeof receiptFixture>;

const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});
describe('durable export receipts', () => {
  it('labels restored exports and names their downloads from the receipt output name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-'));
    temporary.push(root);
    const named = randomUUID();
    const unnamed = randomUUID();
    const snapshot = createProject('flight', 'Flight');
    snapshot.clips.push(createClip('one', 'source', 0, 10));
    await Promise.all(
      [
        [named, { outputName: 'Mont Blanc été "final" (v2).mp4' }],
        [unnamed, {}],
      ].map(async ([id, extra]) => {
        const folder = path.join(root, 'renders', id as string);
        await mkdir(folder, { recursive: true });
        await writeFile(
          path.join(folder, 'receipt.json'),
          JSON.stringify({ ...receiptFixture(snapshot, id as string), ...(extra as object) }),
        );
        await writeFile(path.join(folder, 'export.mp4'), 'output');
      }),
    );
    const service = await createApp(
      createConfig({
        dataDir: root,
        webDir: path.join(root, 'absent-web'),
        ffmpeg: '/unit-tests-do-not-run-ffmpeg',
        ffprobe: '/unit-tests-do-not-run-ffprobe',
      }),
    );
    try {
      expect(service.jobs.get(named).label).toBe('Mont Blanc été "final" (v2).mp4');
      expect(service.jobs.get(unnamed).label).toBe('Flight · 720p');
      const headers = { host: '127.0.0.1:4318' };
      const download = await service.app.inject({ url: `/api/jobs/${named}/export`, headers });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-disposition']).toBe(
        'inline; filename="Mont Blanc _t_ _final_ (v2).mp4"; filename*=UTF-8\'\'Mont%20Blanc%20%C3%A9t%C3%A9%20%22final%22%20%28v2%29.mp4',
      );
      const fallback = await service.app.inject({ url: `/api/jobs/${unnamed}/export`, headers });
      expect(fallback.headers['content-disposition']).toContain('filename="Flight _ 720p.mp4"');
      const receipt = await service.app.inject({ url: `/api/jobs/${named}/receipt`, headers });
      expect(receipt.headers['content-disposition']).toBeUndefined();
    } finally {
      await service.app.close();
    }
  });
  it('restores verified completed outputs without touching their receipt or source edit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-'));
    temporary.push(root);
    const id = randomUUID();
    const folder = path.join(root, 'renders', id);
    await mkdir(folder, { recursive: true });
    const snapshot = createProject('flight', 'Flight');
    snapshot.clips.push(createClip('one', 'source', 0, 10));
    snapshot.clips[0]!.spatial = {
      base: { ...NEUTRAL_SPATIAL_POSE, cropLeft: 0.125, scale: 1.23456789 },
      keyframes: [
        { frame: 0, interpolation: 'smooth', values: { ...NEUTRAL_SPATIAL_POSE, rotation: -90 } },
        { frame: 100, interpolation: 'hold', values: { ...NEUTRAL_SPATIAL_POSE, translateX: 0.5 } },
      ],
    };
    snapshot.layers[0]!.keyframes = [
      { frame: 5, interpolation: 'smooth', values: { ...EMPTY_KEY_VALUES, opacity: 0.5, exposure: 0.7 } },
    ];
    snapshot.music = Array.from({ length: 8 }, (_, index) => ({
      id: `music-${index}`,
      mediaId: index % 2 ? 'one-source' : 'other-source',
      sourceIn: index,
      sourceOut: 20 + index,
      start: index * 10,
      duration: 20,
      gainDb: -index,
      fadeIn: index,
      fadeOut: index,
      loop: false,
    }));
    expect(snapshot.schemaVersion).toBe(13);
    const receipt = receiptFixture(snapshot, id);
    expect(receipt.musicSources).toHaveLength(2);
    expect(receipt.settings.audio).toHaveLength(8);
    const text = JSON.stringify(receipt);
    await writeFile(path.join(folder, 'receipt.json'), text);
    await writeFile(path.join(folder, 'export.mp4'), 'verified output fixture');
    const jobs = new JobQueue();
    expect(await restoreExports(createConfig({ dataDir: root }), jobs)).toEqual([]);
    expect(jobs.get(id)).toMatchObject({
      kind: 'export',
      state: 'completed',
      progress: 1,
      outputUrl: `/api/jobs/${id}/export`,
    });
    expect(await readFile(path.join(folder, 'receipt.json'), 'utf8')).toBe(text);
    expect(JSON.parse(await readFile(path.join(folder, 'receipt.json'), 'utf8')).snapshot.clips[0].spatial).toEqual(
      snapshot.clips[0]!.spatial,
    );
    expect(await readFile(path.join(folder, 'export.mp4'), 'utf8')).toBe('verified output fixture');
    await restoreExports(createConfig({ dataDir: root }), jobs);
    expect(jobs.list()).toHaveLength(1);
    await jobs.close();
  });
  it('restores a current no-music receipt with explicit empty source and plan arrays', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-'));
    temporary.push(root);
    const id = randomUUID();
    const folder = path.join(root, 'renders', id);
    await mkdir(folder, { recursive: true });
    const snapshot = createProject('silent-flight', 'Silent flight');
    snapshot.clips.push(createClip('one', 'source', 0, 10));
    const receipt = receiptFixture(snapshot, id);
    expect(receipt.musicSources).toEqual([]);
    expect(receipt.settings.audio).toEqual([]);
    await writeFile(path.join(folder, 'receipt.json'), JSON.stringify(receipt));
    await writeFile(path.join(folder, 'export.mp4'), 'verified silent output fixture');
    const jobs = new JobQueue();
    try {
      expect(await restoreExports(createConfig({ dataDir: root }), jobs)).toEqual([]);
      expect(jobs.get(id)?.state).toBe('completed');
    } finally {
      await jobs.close();
    }
  });

  const invalidReceipts: { name: string; change: (receipt: ReceiptFixture) => void }[] = [
    {
      name: 'missing row colour',
      change: (receipt) => {
        Reflect.deleteProperty(receipt.snapshot.layers[0]!, 'colour');
      },
    },
    {
      name: 'forbidden clip correction',
      change: (receipt) => {
        Object.assign(receipt.snapshot.clips[0]!, { correction: receipt.snapshot.layers[0]!.colour });
      },
    },
    {
      name: 'old clip colour',
      change: (receipt) => {
        Object.assign(receipt.snapshot.clips[0]!, { colour: receipt.snapshot.layers[0]!.colour });
      },
    },
    {
      name: 'missing clip spatial settings',
      change: (receipt) => {
        Reflect.deleteProperty(receipt.snapshot.clips[0]!, 'spatial');
      },
    },
    {
      name: 'unknown clip spatial metadata',
      change: (receipt) => {
        Object.assign(receipt.snapshot.clips[0]!.spatial, { legacy: true });
      },
    },
    {
      name: 'invalid snapshot fade layout',
      change: (receipt) => {
        receipt.snapshot.layers[0]!.closingFade = 11;
      },
    },
    {
      name: 'invalid snapshot topology',
      change: (receipt) => {
        receipt.snapshot.clips[0]!.layerId = 'missing-layer';
      },
    },
    {
      name: 'missing musicSources',
      change: (receipt) => {
        Reflect.deleteProperty(receipt, 'musicSources');
      },
    },
    {
      name: 'missing settings',
      change: (receipt) => {
        Reflect.deleteProperty(receipt, 'settings');
      },
    },
    {
      name: 'missing audio plans',
      change: (receipt) => {
        Reflect.deleteProperty(receipt.settings, 'audio');
      },
    },
    {
      name: 'null musicSources',
      change: (receipt) => {
        Object.assign(receipt, { musicSources: null });
      },
    },
    {
      name: 'singular audio plan',
      change: (receipt) => {
        Object.assign(receipt.settings, { audio: receipt.settings.audio[0] });
      },
    },
    {
      name: 'missing captured source',
      change: (receipt) => {
        receipt.musicSources = [];
      },
    },
    {
      name: 'duplicate captured source',
      change: (receipt) => {
        receipt.musicSources.push(receipt.musicSources[0]!);
      },
    },
    {
      name: 'unreferenced captured source',
      change: (receipt) => {
        receipt.musicSources.push(audioAsset('other'));
      },
    },
    {
      name: 'wrong captured media ID',
      change: (receipt) => {
        receipt.musicSources[0]!.id = 'other';
      },
    },
    {
      name: 'invalid captured audio metadata',
      change: (receipt) => {
        receipt.musicSources[0]!.metadata.sampleRate = 0;
      },
    },
    {
      name: 'unknown captured audio field',
      change: (receipt) => {
        Object.assign(receipt.musicSources[0]!, { legacy: true });
      },
    },
    {
      name: 'missing plan',
      change: (receipt) => {
        receipt.settings.audio = [];
      },
    },
    {
      name: 'duplicate plan ID',
      change: (receipt) => {
        receipt.settings.audio.push(receipt.settings.audio[0]!);
      },
    },
    {
      name: 'wrong plan instance ID',
      change: (receipt) => {
        receipt.settings.audio[0]!.id = 'other';
      },
    },
    {
      name: 'wrong plan media ID',
      change: (receipt) => {
        receipt.settings.audio[0]!.mediaId = 'other';
      },
    },
    {
      name: 'wrong loop flag',
      change: (receipt) => {
        receipt.settings.audio[0]!.loop = false;
      },
    },
    {
      name: 'wrong gain',
      change: (receipt) => {
        receipt.settings.audio[0]!.gain = 1;
      },
    },
    {
      name: 'unknown plan field',
      change: (receipt) => {
        Object.assign(receipt.settings.audio[0]!, { legacy: true });
      },
    },
    {
      name: 'negative samples',
      change: (receipt) => {
        receipt.settings.audio[0]!.startSamples = -1;
      },
    },
    {
      name: 'fractional samples',
      change: (receipt) => {
        receipt.settings.audio[0]!.startSamples += 0.5;
      },
    },
    {
      name: 'zero project samples',
      change: (receipt) => {
        receipt.settings.audio[0]!.videoSamples = 0;
      },
    },
    {
      name: 'nonfinite gain',
      change: (receipt) => {
        receipt.settings.audio[0]!.gain = Infinity;
      },
    },
    {
      name: 'out-of-range gain',
      change: (receipt) => {
        receipt.settings.audio[0]!.gain = 5;
      },
    },
    {
      name: 'too many captured sources',
      change: (receipt) => {
        receipt.musicSources = Array.from({ length: 9 }, (_, index) => audioAsset(`source-${index}`));
      },
    },
    {
      name: 'too many plans',
      change: (receipt) => {
        receipt.settings.audio = Array.from({ length: 9 }, (_, index) => ({
          ...receipt.settings.audio[0]!,
          id: `plan-${index}`,
        }));
      },
    },
  ];
  for (const field of Object.keys(planExportMusic(musicProject().music[0]!, 45)))
    invalidReceipts.push({
      name: `missing plan ${field}`,
      change: (receipt) => {
        Reflect.deleteProperty(receipt.settings.audio[0]!, field);
      },
    });
  for (const field of [
    'sourceInSamples',
    'sourceOutSamples',
    'startSamples',
    'durationSamples',
    'activeSamples',
    'fadeInSamples',
    'fadeOutSamples',
    'videoSamples',
  ] as const)
    invalidReceipts.push({
      name: `mismatched ${field}`,
      change: (receipt) => {
        receipt.settings.audio[0]![field] += 1;
      },
    });

  it.each(invalidReceipts)(
    'rejects $name without changing receipt bytes or the completed output',
    async ({ change }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-'));
      temporary.push(root);
      const id = randomUUID();
      const folder = path.join(root, 'renders', id);
      await mkdir(folder, { recursive: true });
      const receipt = receiptFixture(musicProject(), id);
      change(receipt);
      // JSON.stringify turns Infinity into null; an overflowing JSON number tests actual nonfinite decoding.
      const text =
        receipt.settings?.audio?.[0]?.gain === Infinity
          ? JSON.stringify(receipt).replace('"gain":null', '"gain":1e400')
          : JSON.stringify(receipt);
      const output = 'preserved completed output fixture';
      await writeFile(path.join(folder, 'receipt.json'), text);
      await writeFile(path.join(folder, 'export.mp4'), output);
      const jobs = new JobQueue();
      try {
        const warnings = await restoreExports(createConfig({ dataDir: root }), jobs);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Cannot restore this export receipt:');
        expect(warnings[0]).toContain('The existing receipt and successful output were not changed.');
        expect(jobs.list()).toEqual([]);
        expect(await readFile(path.join(folder, 'receipt.json'), 'utf8')).toBe(text);
        expect(await readFile(path.join(folder, 'export.mp4'), 'utf8')).toBe(output);
      } finally {
        await jobs.close();
      }
    },
  );
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
    'leaves version-1 receipts with unsupported v%s snapshots and their completed outputs unchanged',
    async (version) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-'));
      temporary.push(root);
      const id = randomUUID();
      const folder = path.join(root, 'renders', id);
      await mkdir(folder, { recursive: true });
      const snapshot = unsupportedProject(version, 'unsupported-flight', `Original v${version} flight`);
      const text = JSON.stringify({
        kind: 'export',
        schemaVersion: 1,
        jobId: id,
        createdAt: new Date().toISOString(),
        snapshot,
        profile: 'draft720',
        verification: { frameCount: 60, fullDecode: true, faststart: true },
      });
      const output = 'completed legacy output fixture';
      await writeFile(path.join(folder, 'receipt.json'), text);
      await writeFile(path.join(folder, 'export.mp4'), output);
      const jobs = new JobQueue();
      try {
        const warnings = await restoreExports(createConfig({ dataDir: root }), jobs);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(
          `Unsupported export snapshot schema version ${version}; this build requires version 13`,
        );
        expect(jobs.list()).toEqual([]);
        expect(await readFile(path.join(folder, 'receipt.json'), 'utf8')).toBe(text);
        expect(await readFile(path.join(folder, 'export.mp4'), 'utf8')).toBe(output);
      } finally {
        await jobs.close();
      }
    },
  );
  it('does not restore failed/incomplete outputs or rewrite corrupt receipts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-'));
    temporary.push(root);
    const folder = path.join(root, 'renders', randomUUID());
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'receipt.json'), 'not-json');
    const jobs = new JobQueue();
    expect(await restoreExports(createConfig({ dataDir: root }), jobs)).toHaveLength(1);
    expect(jobs.list()).toHaveLength(0);
    expect(await readFile(path.join(folder, 'receipt.json'), 'utf8')).toBe('not-json');
    await jobs.close();
  });
});
