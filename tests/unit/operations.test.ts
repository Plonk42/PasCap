import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATALOGUE_DOCUMENT, withCatalogue } from '../../scripts/operation-catalogue.js';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { runners } from '../../src/server/operations/index.js';
import { createColourSettings } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import { createClipGrade } from '../../src/shared/grade.js';
import { createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import type { TrackDescription } from '../../src/shared/operations/describe-track.js';
import { operations } from '../../src/shared/operations/index.js';
import { durationOf } from '../../src/shared/operations/timecode.js';
import { NEUTRAL_SPATIAL_POSE, SPATIAL_CHANNELS } from '../../src/shared/spatial.js';

const NO_TRANSFORM = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null]));

const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };
const temporary: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.app.close()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function service() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pascap-operations-'));
  temporary.push(dataDir);
  const created = await createApp(
    createConfig({
      dataDir,
      webDir: path.join(dataDir, 'absent-web'),
      ffmpeg: '/unit-tests-do-not-run-ffmpeg',
      ffprobe: '/unit-tests-do-not-run-ffprobe',
    }),
  );
  services.push(created);
  const response = await created.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { title: 'Flight' },
  });
  const project = projectSchema.parse(response.json<{ document: unknown }>().document);
  return { ...created, project, file: path.join(dataDir, 'projects', `${project.id}.json`) };
}

function call(app: Awaited<ReturnType<typeof createApp>>['app'], name: string, payload: unknown) {
  return app.inject({ method: 'POST', url: `/api/ops/${name}`, headers, payload: payload as object });
}

describe('operation registry', () => {
  it('has unique snake_case names, explicit audiences and one runner each', () => {
    const names = operations.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    for (const operation of operations) {
      expect(operation.name).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
      expect(operation.audience.length, operation.name).toBeGreaterThan(0);
      expect(new Set(operation.audience).size).toBe(operation.audience.length);
    }
    expect(Object.keys(runners).sort()).toEqual([...names].sort());
  });

  it('describes every operation and input field, and converts both schemas to JSON Schema', () => {
    for (const operation of operations) {
      expect(operation.description.length, operation.name).toBeGreaterThan(40);
      expect(operation.input).toBeInstanceOf(z.ZodObject);
      for (const [field, schema] of Object.entries(operation.input.shape))
        expect(z.globalRegistry.get(schema as z.ZodType)?.description, `${operation.name}.${field}`).toBeTruthy();
      expect(() => z.toJSONSchema(operation.input)).not.toThrow();
      expect(() => z.toJSONSchema(operation.output)).not.toThrow();
    }
  });

  it('keeps the catalogue in the design guide up to date', async () => {
    const document = await readFile(CATALOGUE_DOCUMENT, 'utf8');
    expect(document === (await withCatalogue(document)), 'Run npm run operations:catalogue.').toBe(true);
  });
});

describe('operation routes', () => {
  it('describes a project and applies an edit batch as one saved revision', async () => {
    const { app, project } = await service();
    const before = await call(app, 'describe_project', { projectId: project.id });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      id: project.id,
      title: 'Flight',
      revision: 1,
      duration: { frames: 0, timecode: '00:00:00' },
      videoTracks: [{ id: 'video-1', clips: [] }],
      adjustments: [],
      bookmarks: [],
    });

    const edited = await call(app, 'edit', {
      projectId: project.id,
      expectedRevision: 1,
      commands: [
        { type: 'bookmark-add', frame: 90 },
        { type: 'bookmark-add', frame: 30 },
        { type: 'layer-create', layerId: 'video-2', name: 'Overlay' },
        { type: 'transform-setting', layerId: 'video-2', setting: 'opacity', value: 0.5 },
      ],
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toEqual({ revision: 2, duration: { frames: 0, seconds: 0, timecode: '00:00:00' } });

    const after = (await call(app, 'describe_project', { projectId: project.id })).json<{
      revision: number;
      bookmarks: number[];
      videoTracks: { id: string; opacity: number }[];
    }>();
    expect(after.revision).toBe(2);
    expect(after.bookmarks).toEqual([30, 90]);
    expect(after.videoTracks.map((track) => [track.id, track.opacity])).toEqual([
      ['video-1', 1],
      ['video-2', 0.5],
    ]);
  });

  it('saves nothing when a command is rejected or the revision is stale', async () => {
    const { app, project, file } = await service();
    const saved = await readFile(file, 'utf8');

    const rejected = await call(app, 'edit', {
      projectId: project.id,
      expectedRevision: 1,
      commands: [
        { type: 'bookmark-add', frame: 30 },
        { type: 'bookmark-add', frame: 30 },
      ],
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json<{ error: string }>().error).toBe(
      'Command 2 of 2 (bookmark-add) was rejected: A bookmark already exists at this frame. Nothing was saved.',
    );

    const stale = await call(app, 'edit', {
      projectId: project.id,
      expectedRevision: 0,
      commands: [{ type: 'bookmark-add', frame: 30 }],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toMatch(/revision 1, not 0/);
    expect(await readFile(file, 'utf8')).toBe(saved);
  });

  it('rejects invalid input with its path, and requests without the client header', async () => {
    const { app, project } = await service();
    const invalid = await call(app, 'edit', {
      projectId: project.id,
      expectedRevision: 1,
      commands: [{ type: 'bookmark-add', frame: -1 }],
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toMatch(/^commands\.0\.frame: /);
    expect((await call(app, 'describe_project', { projectId: project.id, extra: 1 })).statusCode).toBe(400);
    expect((await call(app, 'describe_project', { projectId: 'missing' })).statusCode).toBe(404);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/ops/describe_project',
      headers: { host: headers.host },
      payload: { projectId: project.id },
    });
    expect(anonymous.statusCode).toBe(403);
  });

  it('lists saved projects with their duration in frames, seconds and timecode', async () => {
    const { app, project } = await service();
    const listed = await call(app, 'list_projects', {});
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      projects: [
        {
          id: project.id,
          title: 'Flight',
          revision: 1,
          clipCount: 0,
          duration: { frames: 0, seconds: 0, timecode: '00:00:00' },
          updatedAt: expect.any(String),
          error: null,
        },
      ],
    });
    expect(durationOf(386)).toEqual({ frames: 386, seconds: 12.88, timecode: '00:12:26' });
  });

  it('describes clips with their recording, timecodes and kept ranges', async () => {
    const project: ProjectDocument = projectSchema.parse({
      ...createProject('clips', 'Clips'),
      media: { videoIds: ['rec-1'], audioIds: [] },
      clips: [
        {
          id: 'clip-1',
          mediaId: 'rec-1',
          layerId: 'video-1',
          start: 0,
          sourceIn: 30,
          sourceOut: 90,
          speed: { mode: 'constant', rate: 2 },
          reverse: true,
          detail: { sharpen: 0, clarity: 0, denoise: 0 },
          grade: createClipGrade(),
        },
      ],
      selects: { 'rec-1': [{ sourceIn: 0, sourceOut: 120 }] },
    });
    const context = {
      projects: { load: async () => project, save: async () => project },
      library: {
        get: () => ({ name: 'DJI_0001.MP4', metadata: { frameCount: 300 }, status: 'ready' }),
      },
      audio: { get: () => ({ name: 'song.wav' }) },
    } as unknown as Parameters<typeof runners.describe_project>[0];
    const description = await runners.describe_project(context, { projectId: project.id });
    expect(description.videoTracks![0]!.clips).toEqual([
      {
        id: 'clip-1',
        recording: { id: 'rec-1', name: 'DJI_0001.MP4' },
        start: 0,
        end: 30,
        startTimecode: '00:00:00',
        endTimecode: '00:01:00',
        seconds: 1,
        sourceIn: 30,
        sourceOut: 90,
        speed: '2×',
        reverse: true,
        grade: 'none',
      },
    ]);
    expect(description.recordings).toEqual([
      { id: 'rec-1', name: 'DJI_0001.MP4', frameCount: 300, ready: true, kept: [{ sourceIn: 0, sourceOut: 120 }] },
    ]);

    // A comparison renders the saved (or original) frame beside the candidate in one picture.
    const sides: unknown[] = [];
    const picture = { mimeType: 'image/jpeg', data: '', width: 964, height: 270 } as const;
    const pictures = {
      ...context,
      library: { get: (id: string) => ({ id, name: 'DJI_0001.MP4', metadata: { frameCount: 300 }, status: 'ready' }) },
      images: { stillWidth: 480, sheetCellWidth: 240, sheetCells: 16 },
      stills: {
        comparison: async (...args: unknown[]) => {
          sides.push(args);
          return picture;
        },
      },
    } as unknown as Parameters<typeof runners.still>[0];
    const candidate = [{ type: 'colour-setting', clipId: 'clip-1', setting: 'exposure', value: 0.5 }] as const;
    const compared = await runners.still(pictures, {
      projectId: project.id,
      frame: 10,
      commands: [...candidate],
      compare: 'saved',
    });
    expect(compared.image).toBe(picture);
    expect(compared.legend.map(({ cell, shows }) => [cell, shows])).toEqual([
      [0, 'saved'],
      [1, 'candidate'],
    ]);
    const [[[saved, edited], frame, width, crop]] = sides as [
      [
        [{ document: ProjectDocument; ungraded: boolean }, { document: ProjectDocument; ungraded: boolean }],
        number,
        number,
        null,
      ],
    ];
    expect([saved.document, saved.ungraded, edited.ungraded, frame, width, crop]).toEqual([
      project,
      false,
      false,
      10,
      480,
      null,
    ]);
    expect(edited.document.clips[0]!.grade.colour.exposure).toBe(0.5);
    const original = await runners.still(pictures, { projectId: project.id, frame: 10, compare: 'original' });
    expect(original.legend.map(({ shows }) => shows)).toEqual(['original', 'saved']);
    expect((sides[1] as [{ ungraded: boolean }[]])[0].map((side) => side.ungraded)).toEqual([true, false]);
    await expect(runners.still(pictures, { projectId: project.id, frame: 10, compare: 'saved' })).rejects.toMatchObject(
      {
        statusCode: 422,
      },
    );
  });

  it('reads a whole track, its keyed settings and the values that apply at frames, with the adjustment there', async () => {
    const { app, project } = await service();
    const opacityKey = (frame: number, opacity: number) => ({
      frame,
      values: { ...NO_TRANSFORM, opacity },
      easing: { ...NO_TRANSFORM, opacity: 'linear' },
      reset: false,
    });
    const edited = await call(app, 'edit', {
      projectId: project.id,
      expectedRevision: 1,
      commands: [
        { type: 'adjustment-add', adjustmentId: 'look', start: 0, duration: 200 },
        { type: 'colour', adjustmentId: 'look', colour: { ...createColourSettings(), shadows: 0.3, contrast: 1.2 } },
        {
          type: 'transform',
          layerId: 'video-1',
          transform: {
            base: { ...NEUTRAL_SPATIAL_POSE, scale: 1.5 },
            keyframes: [opacityKey(30, 1), opacityKey(90, 0.5)],
          },
        },
        { type: 'layer-key-toggle', adjustmentId: 'look', frame: 30, setting: 'exposure', value: 1 },
        { type: 'layer-key-toggle', adjustmentId: 'look', frame: 90, setting: 'exposure', value: 0 },
      ],
    });
    expect(edited.statusCode).toBe(200);

    const response = await call(app, 'describe_track', {
      projectId: project.id,
      layerId: 'video-1',
      frames: [0, 60, 120],
    });
    expect(response.statusCode).toBe(200);
    const description = response.json<TrackDescription>();
    const saved = (await call(app, 'describe_project', { projectId: project.id })).json<{
      revision: number;
      adjustments: unknown[];
    }>();
    expect(description.revision).toBe(saved.revision);
    expect(saved.adjustments).toEqual([
      expect.objectContaining({
        id: 'look',
        start: 0,
        end: 200,
        grade: { settings: { contrast: 1.2, shadows: 0.3 }, keyframes: 2 },
      }),
    ]);
    expect(description.track!.transform.base).toMatchObject({ scale: 1.5, opacity: 1 });
    expect(description.track!.transform.keyframes.map((key) => [key.frame, key.values.opacity])).toEqual([
      [30, 1],
      [90, 0.5],
    ]);
    expect(description.keyed).toEqual({ transform: ['opacity'] });
    expect(description.keyframes).toBeUndefined();
    expect(
      description.at!.map(({ frame, timecode, adjustment }) => [
        frame,
        timecode,
        adjustment?.adjustmentId,
        adjustment?.values.exposure,
        adjustment?.values.shadows,
      ]),
    ).toEqual([
      [0, '00:00:00', 'look', 1, 0.3],
      [60, '00:02:00', 'look', 0.5, 0.3],
      [120, '00:04:00', 'look', 0, 0.3],
    ]);
    expect(description.at![1]!.transform.opacity).toBe(0.75);
    expect(description.at![1]!.transform.scale).toBe(1.5);

    // Compact: keyframes with only their keyed settings, and the values of the settings asked for.
    const compact = await call(app, 'describe_track', {
      projectId: project.id,
      layerId: 'video-1',
      frames: [60],
      include: ['keyframes', 'at'],
      settings: ['exposure', 'scale'],
    });
    expect(compact.json()).toEqual({
      revision: saved.revision,
      keyed: { transform: ['opacity'] },
      keyframes: {
        transform: [
          { frame: 30, timecode: '00:01:00', values: { opacity: 1 }, easing: { opacity: 'linear' }, reset: false },
          { frame: 90, timecode: '00:03:00', values: { opacity: 0.5 }, easing: { opacity: 'linear' }, reset: false },
        ],
        clips: [],
        // The track has no clips, so no adjustment lies over it.
        adjustments: [],
      },
      at: [
        {
          frame: 60,
          timecode: '00:02:00',
          adjustment: { adjustmentId: 'look', values: { exposure: 0.5 } },
          transform: { scale: 1.5 },
        },
      ],
    });
    const parts = await call(app, 'describe_project', {
      projectId: project.id,
      include: ['bookmarks'],
    });
    expect(Object.keys(parts.json())).toEqual(['id', 'title', 'revision', 'duration', 'bookmarks']);
    const one = await call(app, 'describe_project', {
      projectId: project.id,
      include: ['videoTracks'],
      layerId: 'video-9',
    });
    expect(one.statusCode).toBe(404);

    const unknown = await call(app, 'describe_track', { projectId: project.id, layerId: 'video-9' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: string }>().error).toBe('The project has no video track video-9.');
  });

  it('reports what an assistant can use: caches, analyses and a running export', async () => {
    const project: ProjectDocument = projectSchema.parse({
      ...createProject('ready', 'Ready'),
      media: { videoIds: ['rec-1', 'rec-2', 'rec-3'], audioIds: ['song-1'] },
    });
    const videos: Record<string, { name: string; status: string }> = {
      'rec-1': { name: 'A.MP4', status: 'ready' },
      'rec-2': { name: 'B.MP4', status: 'queued' },
      'rec-3': { name: 'C.MP4', status: 'error' },
    };
    const context = {
      projects: { load: async () => project },
      library: {
        get: (id: string) => videos[id],
        motionJob: (id: string) => (id === 'rec-2' ? { id: 'job' } : null),
        motion: async (id: string) => (id === 'rec-1' ? { frames: [] } : null),
      },
      audio: {
        get: () => ({ name: 'song.wav', status: 'ready' }),
        analysisJob: () => null,
        analysis: async () => {
          throw new Error('unreadable cache');
        },
      },
      jobs: { list: () => [{ kind: 'export', state: 'running' }] },
      assistant: {
        url: 'http://127.0.0.1:4318/mcp',
        tokenFile: '/data/mcp-token',
        lastClient: () => ({ at: '2026-10-21T10:00:00.000Z', name: 'Visual Studio Code' }),
      },
    } as unknown as Parameters<typeof runners.hand_off_readiness>[0];
    expect(await runners.hand_off_readiness(context, { projectId: project.id })).toEqual({
      recordings: [
        { id: 'rec-1', name: 'A.MP4', preparation: 'ready', cameraMotion: 'analysed' },
        { id: 'rec-2', name: 'B.MP4', preparation: 'preparing', cameraMotion: 'analysing' },
        { id: 'rec-3', name: 'C.MP4', preparation: 'unprepared', cameraMotion: 'missing' },
      ],
      music: [{ id: 'song-1', name: 'song.wav', preparation: 'ready', beats: 'missing' }],
      exportRunning: true,
      connection: {
        url: 'http://127.0.0.1:4318/mcp',
        tokenFile: '/data/mcp-token',
        lastCall: '2026-10-21T10:00:00.000Z',
        client: 'Visual Studio Code',
      },
    });
  });

  it("describes a recording's steady ranges inside its kept ranges with a sheet of their middle frames", async () => {
    const pan = Array.from({ length: 600 }, (_, frame) => (frame === 0 ? null : frame < 300 ? 3 : -3));
    const zero = pan.map((value) => (value === null ? null : 0));
    const project: ProjectDocument = projectSchema.parse({
      ...createProject('shots', 'Shots'),
      media: { videoIds: ['rec-1'], audioIds: [] },
      selects: { 'rec-1': [{ sourceIn: 30, sourceOut: 570 }] },
    });
    const sheets: number[][] = [];
    const context = {
      projects: { load: async () => project },
      library: {
        get: () => ({
          id: 'rec-1',
          name: 'DJI_0001.MP4',
          status: 'ready',
          damage: [{ start: 100, end: 130 }],
          metadata: { frameCount: 600 },
        }),
        motion: async () => ({
          version: 3,
          verifiedAt: 'now',
          frameCount: 600,
          tx: pan,
          ty: zero,
          zoom: zero,
          rotation: zero,
          telemetry: [],
        }),
      },
      sessions: {
        current: async () => ({ endedAt: null, brief: { allowedMovement: 3 } }),
      },
      stills: {
        recordingSheet: async (_: string, frames: number[]) => {
          sheets.push(frames);
          return { mimeType: 'image/jpeg', data: 'jpeg', width: 240, height: 135 };
        },
      },
      images: { stillWidth: 480, sheetCellWidth: 240, sheetCells: 2 },
    } as unknown as Parameters<typeof runners.describe_recording>[0];
    const described = await runners.describe_recording(context, { projectId: 'shots', mediaId: 'rec-1', sheet: true });
    expect(described.revision).toBe(project.revision);
    expect(described.allowedMovement).toBe(3);
    expect(described.recording).toMatchObject({ damaged: [{ sourceIn: 100, sourceOut: 130 }], flightData: false });
    expect(described.keptRanges).toEqual([{ sourceIn: 30, sourceOut: 570 }]);
    const ranges = described.steadyRanges;
    expect(ranges.map((range) => range.motion)).toEqual(['pan left', 'pan left', 'pan right']);
    expect(ranges[0]!.sourceIn).toBe(30);
    expect(ranges.at(-1)!.sourceOut).toBe(570);
    // Three pans without flight data: ranked by length. Two cells: the two best ranges, in source order.
    expect(ranges.map((range) => [range.kind, range.rank])).toEqual([
      ['move', 3],
      ['move', 2],
      ['move', 1],
    ]);
    expect(ranges.map((range) => range.cell)).toEqual([null, 0, 1]);
    expect(sheets).toEqual([ranges.slice(1).map((range) => Math.floor((range.sourceIn + range.sourceOut) / 2))]);
    expect(described.image).toMatchObject({ mimeType: 'image/jpeg' });
    const bare = await runners.describe_recording(context, {
      projectId: 'shots',
      mediaId: 'rec-1',
      allowedMovement: 1,
      sheet: false,
    });
    expect(bare.image).toBeUndefined();
    expect(bare.allowedMovement).toBe(1);
    await expect(
      runners.describe_recording(context, { projectId: 'shots', mediaId: 'rec-9', sheet: false }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('compares candidate ranges of several recordings in one sheet, a row per candidate', async () => {
    const pan = Array.from({ length: 600 }, (_, frame) => (frame === 0 ? null : frame < 300 ? 3 : -3));
    const zero = pan.map((value) => (value === null ? null : 0));
    const project: ProjectDocument = projectSchema.parse({
      ...createProject('compare', 'Compare'),
      media: { videoIds: ['rec-1', 'rec-2', 'rec-3'], audioIds: [] },
      selects: { 'rec-1': [{ sourceIn: 30, sourceOut: 570 }] },
    });
    const assets: Record<string, object> = {
      'rec-1': { id: 'rec-1', name: 'A.MP4', status: 'ready', damage: [], metadata: { frameCount: 600 } },
      'rec-2': { id: 'rec-2', name: 'B.MP4', status: 'ready', damage: [], metadata: { frameCount: 600 } },
      'rec-3': { id: 'rec-3', name: 'C.MP4', status: 'preparing', damage: [], metadata: { frameCount: 600 } },
    };
    const sheets: { cells: unknown; columns: number | null }[] = [];
    const context = {
      projects: { load: async () => project },
      library: {
        get: (id: string) => assets[id],
        motion: async (id: string) =>
          id === 'rec-1'
            ? {
                version: 3,
                verifiedAt: 'now',
                frameCount: 600,
                tx: pan,
                ty: zero,
                zoom: zero,
                rotation: zero,
                telemetry: [],
              }
            : null,
      },
      sessions: { current: async () => null },
      stills: {
        sourceSheet: async (cells: unknown, columns: number | null) => {
          sheets.push({ cells, columns });
          return { mimeType: 'image/jpeg', data: 'jpeg', width: 484, height: 274 };
        },
      },
      images: { stillWidth: 480, sheetCellWidth: 240, sheetCells: 6 },
    } as unknown as Parameters<typeof runners.compare_recordings>[0];
    const described = await runners.describe_recording(
      context as unknown as Parameters<typeof runners.describe_recording>[0],
      { projectId: 'compare', mediaId: 'rec-1', sheet: false },
    );
    const best = described.steadyRanges.find((range) => range.rank === 1)!;
    const compared = await runners.compare_recordings(context, {
      projectId: 'compare',
      candidates: [{ mediaId: 'rec-1' }, { mediaId: 'rec-2' }, { mediaId: 'rec-2', sourceIn: 10, sourceOut: 40 }],
      frames: 2,
    });
    expect(compared.revision).toBe(described.revision);
    expect(compared.candidates.map(({ cells, sourceIn, sourceOut }) => ({ cells, sourceIn, sourceOut }))).toEqual([
      // The best steady range; without motion analysis or kept ranges, the whole recording.
      { cells: [0, 1], sourceIn: best.sourceIn, sourceOut: best.sourceOut },
      { cells: [2, 3], sourceIn: 0, sourceOut: 600 },
      { cells: [4, 5], sourceIn: 10, sourceOut: 40 },
    ]);
    expect(compared.candidates.slice(1).map((candidate) => candidate.frames)).toEqual([
      [150, 450],
      [17, 32],
    ]);
    expect(sheets).toEqual([
      {
        cells: compared.candidates.flatMap(({ mediaId, frames }) => frames.map((frame) => ({ mediaId, frame }))),
        columns: 2,
      },
    ]);
    await runners.compare_recordings(context, { projectId: 'compare', candidates: [{ mediaId: 'rec-2' }] });
    expect(sheets.at(-1)!.columns).toBeNull();
    const compare = (candidates: object[], frames?: number) =>
      runners.compare_recordings(context, { projectId: 'compare', candidates, frames } as never);
    await expect(compare([{ mediaId: 'rec-1' }], 4)).resolves.toBeTruthy();
    await expect(compare([{ mediaId: 'rec-1' }, { mediaId: 'rec-2' }], 4)).rejects.toMatchObject({ statusCode: 422 });
    await expect(compare([{ mediaId: 'rec-3' }])).rejects.toMatchObject({ statusCode: 409 });
    await expect(compare([{ mediaId: 'rec-9' }])).rejects.toMatchObject({ statusCode: 404 });
    await expect(compare([{ mediaId: 'rec-2', sourceIn: 10, sourceOut: 700 }])).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(
      operations
        .find((operation) => operation.name === 'compare_recordings')!
        .input.safeParse({ projectId: 'compare', candidates: [{ mediaId: 'rec-2', sourceIn: 10 }] }).success,
    ).toBe(false);
  });

  it('reads the music at project frames, measures the cuts against its beats and proposes snapped trims', async () => {
    const samplesPerFrame = (48_000 * 1_001) / 30_000;
    const base = createProject('music', 'Music');
    const project: ProjectDocument = projectSchema.parse({
      ...base,
      media: { videoIds: ['rec-1'], audioIds: ['song-1'] },
      clips: ['a', 'b'].map((id, index) => ({
        id,
        mediaId: 'rec-1',
        layerId: base.layers[0]!.id,
        start: index * 60,
        sourceIn: 0,
        sourceOut: 60,
        speed: { mode: 'constant', rate: 1 },
        reverse: false,
        detail: { sharpen: 0, clarity: 0, denoise: 0 },
        grade: createClipGrade(),
      })),
      layers: [{ ...base.layers[0]!, transitions: [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }] }],
      music: [
        {
          id: 'track-1',
          gainDb: 0,
          ripple: true,
          openingFade: 0,
          closingFade: 0,
          clips: [
            { id: 'song-clip', mediaId: 'song-1', sourceIn: 0, sourceOut: 300, start: 0, duration: 120, loop: false },
          ],
          transitions: [],
        },
      ],
    });
    // A beat every 20 frames from frame 10 of the song; every other one a downbeat.
    const beats = Array.from({ length: 15 }, (_, index) => ({
      sample: Math.round((10 + index * 20) * samplesPerFrame),
      strength: 0.5,
      downbeat: index % 2 === 0,
    }));
    const context = {
      projects: { load: async () => project },
      audio: {
        get: () => ({ id: 'song-1', name: 'song.wav' }),
        analysisJob: () => null,
        analysis: async () => ({
          sampleRate: 48_000,
          tempo: { bpm: 89.91, confidence: 0.8, curve: [{ fromSample: 0, bpm: 89.91 }] },
          meter: { beatsPerBar: 4, confidence: 0.6 },
          beats,
          hits: [
            { sample: Math.round(20 * samplesPerFrame), strength: 0.3, band: 'high', strong: false },
            { sample: Math.round(58 * samplesPerFrame), strength: 0.9, band: 'low', strong: true },
          ],
          sections: [{ fromSample: 0, toSample: Math.round(200 * samplesPerFrame), kind: 'build', loudnessDb: -14 }],
          tone: Array.from({ length: 10 }, () => [-20, -30, -50]),
          key: { tonic: 'A', mode: 'minor', confidence: 0.7 },
          swells: [
            {
              fromSample: Math.round(20 * samplesPerFrame),
              toSample: Math.round(40 * samplesPerFrame),
              kind: 'crescendo',
              changeDb: 8,
              sudden: false,
            },
          ],
          silences: [
            { fromSample: Math.round(40 * samplesPerFrame), toSample: Math.round(45 * samplesPerFrame) },
            { fromSample: Math.round(100 * samplesPerFrame), toSample: Math.round(110 * samplesPerFrame) },
          ],
        }),
      },
    } as unknown as Parameters<typeof runners.music_analysis>[0];

    const music = await runners.music_analysis(context, {
      projectId: 'music',
      fromFrame: 0,
      toFrame: 60,
      detail: 'full',
    });
    expect(music.clips[0]).toMatchObject({
      musicClipId: 'song-clip',
      trackId: 'track-1',
      analysis: 'analysed',
      tempo: { bpm: 89.9 },
      beatCount: 3,
      hitCount: 2,
      hits: [
        { frame: 20, timecode: '00:00:20', band: 'high', strong: false, strength: 0.3 },
        { frame: 58, timecode: '00:01:28', band: 'low', strong: true, strength: 0.9 },
      ],
      hitsTruncated: false,
      key: { tonic: 'A', mode: 'minor' },
      sections: [{ start: 0, end: 120, kind: 'build', tone: { lowDb: -20, midDb: -30, highDb: -50 } }],
      swells: [{ start: 20, end: 40, kind: 'crescendo', changeDb: 8, sudden: false }],
      silences: [{ start: 40, end: 45 }],
    });
    expect(music.clips[0]!.beats.map((beat) => [beat.frame, beat.downbeat])).toEqual([
      [10, true],
      [30, false],
      [50, true],
    ]);
    const summary = await runners.music_analysis(context, { projectId: 'music', detail: 'summary' });
    expect(summary.clips[0]).toMatchObject({
      beats: [],
      beatCount: 6,
      hitCount: 2,
      sections: music.clips[0]!.sections,
    });
    expect(summary.clips[0]!.hits.map((hit) => hit.frame)).toEqual([58]);

    const report = await runners.check_alignment(context, { projectId: 'music' });
    expect(report.boundaries).toMatchObject([
      { frame: 60, beat: { frame: 50, offset: 10 }, downbeat: { frame: 50 }, hit: { frame: 58, offset: 2 } },
    ]);
    expect(report.summary).toEqual({ boundaries: 1, onBeat: 0, onDownbeat: 0, onHit: 0, meanOffset: 10 });
    expect(report.hits).toBe(1);
    // Every read names the saved revision it used.
    expect([music.revision, report.revision]).toEqual([project.revision, project.revision]);

    for (const [prefer, sourceOut, target] of [
      ['hit', 58, 'hit'],
      ['beat-or-hit', 58, 'hit'],
      ['downbeat', 50, 'downbeat'],
    ] as const) {
      const snapped = await runners.snap_cuts_to_beats(context, {
        projectId: 'music',
        layerId: base.layers[0]!.id,
        prefer,
        minimumSeconds: 1,
        keepOnHit: false,
        apply: false,
      });
      expect(snapped.commands, prefer).toEqual([{ type: 'trim', clipId: 'a', sourceIn: 0, sourceOut }]);
      expect(snapped.boundaries[0]!.target, prefer).toBe(target);
    }

    const snap = (fields: Partial<Parameters<typeof runners.snap_cuts_to_beats>[1]>) =>
      runners.snap_cuts_to_beats(context, {
        projectId: 'music',
        layerId: base.layers[0]!.id,
        prefer: 'beat',
        minimumSeconds: 1,
        keepOnHit: false,
        apply: false,
        ...fields,
      });
    const proposal = await snap({});
    expect(proposal.revision).toBe(project.revision);
    expect(proposal.commands).toEqual([{ type: 'trim', clipId: 'a', sourceIn: 0, sourceOut: 50 }]);
    expect(proposal.boundaries).toMatchObject([{ before: 60, beat: 50, target: 'downbeat', after: 50, skipped: null }]);
    expect(proposal.applied).toBeNull();
    // The nearest beat is 10 frames away; kept and too-far boundaries stay, with the reason.
    const far = await snap({ maxShift: 9 });
    expect(far.commands).toEqual([]);
    expect(far.boundaries[0]!.skipped).toMatch(/10 frames away, more than maxShift/);
    expect((await snap({ maxShift: 10 })).commands).toHaveLength(1);
    const kept = await snap({ keep: [{ leftId: 'a', rightId: 'b' }] });
    expect(kept.commands).toEqual([]);
    expect(kept.boundaries[0]).toMatchObject({ after: 60, skipped: 'Listed in keep.' });
    // Within one frame of a light hit at 20 when the cut is there.
    const cutAt21 = applyCommand(project, { type: 'trim', clipId: 'a', sourceIn: 0, sourceOut: 21 });
    const onHit = await runners.snap_cuts_to_beats(
      { ...context, projects: { load: async () => cutAt21 } } as unknown as typeof context,
      {
        projectId: 'music',
        layerId: base.layers[0]!.id,
        prefer: 'beat',
        minimumSeconds: 0,
        keepOnHit: true,
        apply: false,
      },
    );
    expect(onHit.commands).toEqual([]);
    expect(onHit.boundaries[0]!.skipped).toBe('Already on a hit at frame 20.');
    await expect(snap({ apply: true })).rejects.toMatchObject({ statusCode: 422 });
  });
});
