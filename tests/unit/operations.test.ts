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
import { createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import type { TrackDescription } from '../../src/shared/operations/describe-track.js';
import { operations } from '../../src/shared/operations/index.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';

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
      bookmarks: [],
    });

    const edited = await call(app, 'edit', {
      projectId: project.id,
      expectedRevision: 1,
      commands: [
        { type: 'bookmark-add', frame: 90 },
        { type: 'bookmark-add', frame: 30 },
        { type: 'layer-add', layer: createLayer('video-2', 'Overlay') },
        { type: 'opacity', layerId: 'video-2', opacity: 0.5 },
      ],
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toEqual({ revision: 2, duration: { frames: 0, timecode: '00:00:00' } });

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
    expect(description.videoTracks[0]!.clips).toEqual([
      {
        id: 'clip-1',
        recording: { id: 'rec-1', name: 'DJI_0001.MP4' },
        start: 0,
        end: 30,
        startTimecode: '00:00:00',
        endTimecode: '00:01:00',
        sourceIn: 30,
        sourceOut: 90,
        speed: '2×',
        reverse: true,
      },
    ]);
    expect(description.recordings).toEqual([
      { id: 'rec-1', name: 'DJI_0001.MP4', frameCount: 300, ready: true, kept: [{ sourceIn: 0, sourceOut: 120 }] },
    ]);
  });

  it('reads a whole track, its keyed settings and the values that apply at frames', async () => {
    const { app, project } = await service();
    const edited = await call(app, 'edit', {
      projectId: project.id,
      expectedRevision: 1,
      commands: [
        { type: 'colour', layerId: 'video-1', colour: { ...createColourSettings(), shadows: 0.3, contrast: 1.2 } },
        {
          type: 'transform',
          layerId: 'video-1',
          transform: { base: { ...NEUTRAL_SPATIAL_POSE, scale: 1.5 }, keyframes: [] },
        },
        { type: 'layer-key-toggle', layerId: 'video-1', frame: 30, setting: 'exposure', value: 1 },
        { type: 'layer-key-toggle', layerId: 'video-1', frame: 90, setting: 'exposure', value: 0 },
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
    const saved = (await call(app, 'describe_project', { projectId: project.id })).json<{ revision: number }>();
    expect(description.revision).toBe(saved.revision);
    expect(description.track.colour).toMatchObject({ shadows: 0.3, contrast: 1.2, exposure: 0 });
    expect(description.track.keyframes.map((key) => [key.frame, key.values.exposure])).toEqual([
      [30, 1],
      [90, 0],
    ]);
    expect(description.keyed).toEqual({ colour: ['exposure'], transform: [] });
    expect(
      description.at.map(({ frame, timecode, values }) => [frame, timecode, values.exposure, values.shadows]),
    ).toEqual([
      [0, '00:00:00', 1, 0.3],
      [60, '00:02:00', 0.5, 0.3],
      [120, '00:04:00', 0, 0.3],
    ]);
    expect(description.at[1]!.values.opacity).toBe(1);
    expect(description.at[1]!.transform.scale).toBe(1.5);

    const unknown = await call(app, 'describe_track', { projectId: project.id, layerId: 'video-9' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: string }>().error).toBe('The project has no video track video-9.');
  });
});
