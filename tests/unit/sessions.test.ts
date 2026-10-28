import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/server/operations/context.js';
import { runOperation } from '../../src/server/operations/index.js';
import { AssistantSessions } from '../../src/server/sessions.js';
import { ProjectStore } from '../../src/server/storage.js';
import { sessionViolation } from '../../src/shared/assistant-session.js';
import type { EditCommand } from '../../src/shared/commands.js';
import { createClipGrade } from '../../src/shared/grade.js';
import { createProject, projectSchema, type ProjectDocument, type VideoClip } from '../../src/shared/model.js';
import { operationNamed, type OperationName } from '../../src/shared/operations/index.js';

vi.mock('../../src/server/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/files.js')>()),
  assertSourceIdentity: async () => undefined,
}));

const LEASE = 10 * 60_000;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function clip(id: string, sourceIn: number, sourceOut: number): VideoClip {
  return {
    id,
    mediaId: 'rec-1',
    layerId: 'video-1',
    start: 0,
    sourceIn,
    sourceOut,
    speed: { mode: 'constant', rate: 1 },
    reverse: false,
    detail: { sharpen: 0, clarity: 0, denoise: 0 },
    grade: createClipGrade(),
  };
}

async function setup(options: { ready?: boolean; checkpoints?: number; leaseMs?: number | null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pascap-sessions-'));
  temporary.push(dataDir);
  let now = Date.parse('2026-10-21T10:00:00.000Z');
  const clock = { advance: (ms: number) => (now += ms) };
  const projects = new ProjectStore(dataDir);
  const sessions = new AssistantSessions(
    dataDir,
    { leaseMs: options.leaseMs === undefined ? LEASE : options.leaseMs, checkpoints: options.checkpoints ?? 5 },
    projects,
    () => now,
  );
  const asset = {
    id: 'rec-1',
    name: 'DJI_0001.MP4',
    status: options.ready === false ? 'preparing' : 'ready',
    sourcePath: '/footage/DJI_0001.MP4',
    fingerprint: {},
    metadata: { frameCount: 600 },
  };
  const resources = {
    projects,
    sessions,
    library: { get: (id: string) => (id === 'rec-1' ? asset : Promise.reject(new Error('unknown'))) },
    audio: { get: () => ({}) },
    stills: {},
    images: { stillWidth: 480, sheetCellWidth: 240, sheetCells: 9 },
  } as unknown as Omit<ServiceContext, 'caller'>;
  const project = await projects.save(
    projectSchema.parse({
      ...createProject('flight', 'Flight'),
      media: { videoIds: ['rec-1'], audioIds: [] },
      clips: [clip('user-clip', 500, 560)],
      selects: { 'rec-1': [{ sourceIn: 0, sourceOut: 300 }] },
    }),
    0,
  );
  const call = (caller: ServiceContext['caller'], name: OperationName, input: object) =>
    runOperation(operationNamed(name), { ...resources, caller }, input) as Promise<Record<string, unknown>>;
  const file = path.join(dataDir, 'projects', 'flight.json');
  return { dataDir, projects, sessions, project, call, clock, file };
}

const bookmark = (frame: number): EditCommand => ({ type: 'bookmark-add', frame });

describe('assistant sessions', () => {
  it('lets only the assistant write while it holds the lease, until the user takes over', async () => {
    const { projects, project, call, file } = await setup();
    await expect(
      call('assistant', 'edit', { projectId: 'flight', expectedRevision: 1, commands: [bookmark(30)] }),
    ).rejects.toThrow(/Start an assistant session with session_start/);

    const started = await call('assistant', 'session_start', {
      projectId: 'flight',
      expectedRevision: 1,
      brief: { notes: 'Calm flight', targetSeconds: 30 },
    });
    expect(started).toMatchObject({
      active: true,
      startedBy: 'assistant',
      brief: { notes: 'Calm flight', maxClips: null },
    });

    const saved = await readFile(file, 'utf8');
    await expect(projects.save(project, 1)).rejects.toMatchObject({ statusCode: 423 });
    await expect(projects.rename('flight', 'Other', 1)).rejects.toMatchObject({ statusCode: 423 });
    await expect(
      call('editor', 'edit', { projectId: 'flight', expectedRevision: 1, commands: [bookmark(30)] }),
    ).rejects.toMatchObject({ statusCode: 423 });
    expect(await readFile(file, 'utf8')).toBe(saved);

    expect(
      await call('assistant', 'edit', {
        projectId: 'flight',
        expectedRevision: 1,
        commands: [bookmark(30), bookmark(60)],
      }),
    ).toMatchObject({ revision: 2 });
    const status = await call('editor', 'session_status', { projectId: 'flight' });
    expect(status.session).toMatchObject({
      active: true,
      edits: [{ revision: 2, commands: 2, summary: 'bookmark-add, bookmark-add', frame: 30 }],
    });

    expect(await call('editor', 'session_end', { projectId: 'flight' })).toMatchObject({
      session: { active: false, endedBy: 'user' },
    });
    await expect(
      call('assistant', 'edit', { projectId: 'flight', expectedRevision: 2, commands: [bookmark(90)] }),
    ).rejects.toThrow('The user took the project back.');
    expect((await projects.save({ ...(await projects.load('flight')) }, 2)).revision).toBe(3);
  });

  it('ends an idle session after the lease, while any call keeps it alive', async () => {
    const { call, clock, projects } = await setup();
    await call('assistant', 'session_start', { projectId: 'flight', expectedRevision: 1 });
    clock.advance(LEASE - 1000);
    await call('assistant', 'edit', { projectId: 'flight', expectedRevision: 1, commands: [bookmark(30)] });
    clock.advance(LEASE - 1000);
    expect((await call('editor', 'session_status', { projectId: 'flight' })).session).toMatchObject({ active: true });
    clock.advance(2000);
    await expect(
      call('assistant', 'edit', { projectId: 'flight', expectedRevision: 2, commands: [bookmark(60)] }),
    ).rejects.toThrow(/ended after a period without activity/);
    expect((await call('editor', 'session_status', { projectId: 'flight' })).session).toMatchObject({
      active: false,
      endedBy: 'expiry',
    });
    expect((await projects.save(await projects.load('flight'), 2)).revision).toBe(3);
  });

  it('keeps an idle session without a configured lease until it is ended', async () => {
    const { call, clock } = await setup({ leaseMs: null });
    const started = await call('assistant', 'session_start', { projectId: 'flight', expectedRevision: 1 });
    expect(started).toMatchObject({ active: true, expiresAt: null });
    clock.advance(7 * 24 * 60 * 60_000);
    expect((await call('editor', 'session_status', { projectId: 'flight' })).session).toMatchObject({ active: true });
    expect(
      await call('assistant', 'edit', { projectId: 'flight', expectedRevision: 1, commands: [bookmark(30)] }),
    ).toMatchObject({ revision: 2 });
  });

  it('opens a session file holding the picture count the mcp branch briefly kept', async () => {
    const { call, dataDir } = await setup();
    await call('assistant', 'session_start', { projectId: 'flight', expectedRevision: 1 });
    const file = path.join(dataDir, 'assistant', 'flight', 'session.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), pictures: 3 }));
    const status = await call('editor', 'session_status', { projectId: 'flight' });
    expect(status.session).toMatchObject({ active: true });
    expect(status.session).not.toHaveProperty('pictures');
  });

  it('refuses to start on a stale revision or beside an active session, saying whether it can be used', async () => {
    const stale = await setup();
    await expect(
      stale.call('assistant', 'session_start', { projectId: 'flight', expectedRevision: 0 }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    await stale.call('editor', 'session_start', {
      projectId: 'flight',
      expectedRevision: 1,
      brief: { notes: 'A calm flight', targetSeconds: 60 },
    });
    // The user's Hand off is open for the assistant, even from a revision it read earlier.
    for (const expectedRevision of [1, 0])
      await expect(stale.call('assistant', 'session_start', { projectId: 'flight', expectedRevision })).rejects.toThrow(
        /^The user handed this project off to an assistant at .*: that session is open for you, so do not start another\. Edit within it with edit \(expectedRevision 1\) and finish with session_end and your notes\. Brief: notes “A calm flight”; target length 60 s\.$/,
      );
    await expect(stale.call('editor', 'session_start', { projectId: 'flight', expectedRevision: 1 })).rejects.toThrow(
      /^An assistant session has been active on this project since /,
    );
    const other = await setup();
    await other.call('assistant', 'session_start', { projectId: 'flight', expectedRevision: 1 });
    await expect(
      other.call('assistant', 'session_start', { projectId: 'flight', expectedRevision: 1 }),
    ).rejects.toThrow(/started by an assistant, perhaps you\), so do not start another\..* The brief is empty\.$/);
  });

  it('keeps assistant clips inside the kept ranges and only narrows them, leaving the project unchanged otherwise', async () => {
    const { call, file } = await setup();
    await call('assistant', 'session_start', { projectId: 'flight', expectedRevision: 1 });
    const saved = await readFile(file, 'utf8');
    const insert = (id: string, sourceIn: number, sourceOut: number): EditCommand => {
      const { grade: _grade, ...inserted } = clip(id, sourceIn, sourceOut);
      return { type: 'insert', clip: inserted, index: 1 };
    };
    await expect(
      call('assistant', 'edit', { projectId: 'flight', expectedRevision: 1, commands: [insert('outside', 250, 350)] }),
    ).rejects.toThrow(/outside the ranges the user kept/);
    await expect(
      call('assistant', 'edit', {
        projectId: 'flight',
        expectedRevision: 1,
        commands: [{ type: 'select-set', mediaId: 'rec-1', ranges: [{ sourceIn: 0, sourceOut: 400 }] }],
      }),
    ).rejects.toThrow(/can only narrow/);
    await expect(
      call('assistant', 'preview_edits', { projectId: 'flight', commands: [insert('outside', 250, 350)] }),
    ).rejects.toThrow(/Nothing would be saved/);
    expect(await readFile(file, 'utf8')).toBe(saved);

    expect(
      await call('assistant', 'preview_edits', { projectId: 'flight', commands: [insert('inside', 100, 190)] }),
    ).toMatchObject({ revision: 1, clipCount: 2 });
    expect(await readFile(file, 'utf8')).toBe(saved);
    // The user's own clip outside the kept ranges may stay.
    expect(
      await call('assistant', 'edit', {
        projectId: 'flight',
        expectedRevision: 1,
        commands: [
          { type: 'select-narrow', mediaId: 'rec-1', ranges: [{ sourceIn: 60, sourceOut: 240 }] },
          insert('inside', 100, 190),
        ],
      }),
    ).toMatchObject({ revision: 2 });
  });

  it('restores a checkpoint as a new revision after checkpointing the current state, keeping the newest ones', async () => {
    const { call, projects, dataDir } = await setup({ checkpoints: 3 });
    const started = await call('editor', 'session_start', { projectId: 'flight', expectedRevision: 1 });
    await call('assistant', 'edit', { projectId: 'flight', expectedRevision: 1, commands: [bookmark(30)] });
    await call('assistant', 'session_end', { projectId: 'flight', notes: 'Added a bookmark.' });

    const restored = await call('editor', 'checkpoint_restore', {
      projectId: 'flight',
      expectedRevision: 2,
      checkpointId: started.checkpointId,
    });
    expect(restored).toMatchObject({ revision: 3 });
    expect((await projects.load('flight')).bookmarks).toEqual([]);
    const { checkpoints } = (await call('editor', 'session_status', { projectId: 'flight' })) as {
      checkpoints: { reason: string; revision: number }[];
    };
    expect(checkpoints.map((entry) => [entry.reason, entry.revision])).toEqual([
      ['before-restore', 2],
      ['session-start', 1],
    ]);

    for (const label of ['a', 'b', 'c']) await call('editor', 'checkpoint', { projectId: 'flight', label });
    const after = (await call('editor', 'session_status', { projectId: 'flight' })) as {
      checkpoints: { label: string | null }[];
    };
    expect(after.checkpoints.map((entry) => entry.label)).toEqual(['c', 'b', 'a']);
    // Sessions and checkpoints live outside the projects directory and its format.
    expect(await readdir(path.join(dataDir, 'projects'))).toEqual(['flight.json']);
    expect((await projects.list()).map((entry) => entry.id)).toEqual(['flight']);
  });

  it('opens a checkpoint as a new project, leaving the project and its session unchanged', async () => {
    const { call, projects, file } = await setup();
    const started = await call('editor', 'session_start', { projectId: 'flight', expectedRevision: 1 });
    await call('assistant', 'edit', { projectId: 'flight', expectedRevision: 1, commands: [bookmark(30)] });
    const saved = await readFile(file, 'utf8');
    const copy = await call('editor', 'checkpoint_copy', {
      projectId: 'flight',
      checkpointId: started.checkpointId,
      title: 'Flight before the assistant',
    });
    expect(copy).toMatchObject({ title: 'Flight before the assistant' });
    const opened = await projects.load(copy.projectId as string);
    expect(opened).toMatchObject({ title: 'Flight before the assistant', revision: 1, bookmarks: [] });
    expect(opened.id).not.toBe('flight');
    expect(await readFile(file, 'utf8')).toBe(saved);
    expect((await call('editor', 'session_status', { projectId: 'flight' })).session).toMatchObject({ active: true });
    await expect(
      call('editor', 'checkpoint_copy', { projectId: 'flight', checkpointId: 'missing', title: 'Copy' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('session rules', () => {
  const base = projectSchema.parse({
    ...createProject('rules', 'Rules'),
    media: { videoIds: ['rec-1'], audioIds: [] },
    clips: [clip('old', 500, 560)],
    selects: { 'rec-1': [{ sourceIn: 0, sourceOut: 300 }] },
  });
  const name = () => 'DJI_0001.MP4';
  const change = (patch: Partial<ProjectDocument>): ProjectDocument => ({ ...base, ...patch });

  it('allows unchanged clips outside the kept ranges and new clips inside them', () => {
    expect(sessionViolation(base, change({ clips: [...base.clips, clip('new', 10, 200)] }), name)).toBeNull();
  });

  it('rejects a moved trim outside, a widened or removed kept range and a recording outside the bin', () => {
    expect(sessionViolation(base, change({ clips: [clip('old', 400, 460)] }), name)).toMatch(
      /Clip old plays frames 400–460/,
    );
    expect(sessionViolation(base, change({ selects: {} }), name)).toMatch(/can only narrow/);
    expect(
      sessionViolation(base, change({ media: { videoIds: [], audioIds: [] }, clips: [clip('new', 10, 20)] }), name),
    ).toMatch(/not a recording of this project/);
  });
});
