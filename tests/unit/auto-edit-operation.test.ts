import { describe, expect, it, vi } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { DEFAULT_AUTO_EDIT_CHOICES } from '../../src/shared/auto-edit/options.js';
import { briefSchema } from '../../src/shared/assistant-session.js';
import { createProject, projectSchema, type MusicLane, type ProjectDocument } from '../../src/shared/model.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { PROJECT_FPS } from '../../src/shared/timing.js';
import type { AutoEditResult } from '../../src/shared/auto-edit/result.js';
import { JobQueue } from '../../src/server/jobs.js';
import { runners } from '../../src/server/operations/index.js';
import { flight, motion, scene, song } from './auto-edit-fixtures.js';

vi.mock('../../src/server/project-sources.js', () => ({
  assertProjectSources: async () => {},
  assertSourceRanges: () => {},
}));

type Context = Parameters<typeof runners.auto_edit>[0];

const SONG = song(120, [
  { seconds: 8, kind: 'quiet', loudnessDb: -24 },
  { seconds: 8, kind: 'peak', loudnessDb: -8 },
  { seconds: 8, kind: 'release', loudnessDb: -18 },
]);
const SONG_FRAMES = Math.floor(SONG.samples / MUSIC_SAMPLES_PER_FRAME);
const RECORDINGS = Array.from({ length: 6 }, (_, index) => `rec-${index}`);
const SESSION_BRIEF = briefSchema.parse({ musicId: 'song' });

function lane(): MusicLane {
  return {
    id: 'music-1',
    gainDb: 0,
    ripple: false,
    openingFade: 0,
    closingFade: 0,
    clips: [
      {
        id: 'song-clip',
        mediaId: 'song',
        sourceIn: 0,
        sourceOut: SONG_FRAMES,
        start: 0,
        duration: SONG_FRAMES,
        loop: false,
      },
    ],
    transitions: [],
  };
}

function project(music: MusicLane[] = []): ProjectDocument {
  const base = createProject('flight', 'Flight');
  return projectSchema.parse({
    ...base,
    media: { videoIds: [...RECORDINGS, 'raw'], audioIds: ['song'], imageIds: [] },
    music,
    revision: 4,
  });
}

function context(document: ProjectDocument, options: { analyzed?: boolean } = {}) {
  const saved: ProjectDocument[] = [];
  const results = new Map<string, AutoEditResult>();
  const reads: string[] = [];
  const jobs = new JobQueue();
  const asset = (id: string) => ({
    id,
    name: id === 'raw' ? 'RAW.MP4' : `DJI_000${RECORDINGS.indexOf(id) + 1}.MP4`,
    status: id === 'raw' ? 'registered' : 'ready',
    prepared: id === 'raw' ? null : { width: 1280, height: 720 },
    metadata: { frameCount: 2000, frameRate: { ...PROJECT_FPS } },
    damage: [],
  });
  const lumaOf = (frame: ReturnType<typeof scene>) => ({
    width: frame.width,
    height: frame.height,
    data: Uint8Array.from({ length: frame.width * frame.height }, (_, index) => frame.data[index * 4 + 1]!),
  });
  const value = {
    caller: 'assistant',
    projects: {
      load: async () => document,
      save: async (next: ProjectDocument, revision: number) => {
        const stored = projectSchema.parse({ ...next, revision: revision + 1 });
        saved.push(stored);
        return stored;
      },
    },
    sessions: {
      current: async () => ({ endedAt: null, brief: SESSION_BRIEF }),
      recordEdit: async () => {},
    },
    library: {
      get: asset,
      motion: async (id: string) =>
        motion(
          [
            { frames: 420, rotation: 0.003 },
            { frames: 360, tx: 3 },
            { frames: 300, zoom: -0.004 },
          ],
          flight(40, 40 + 10 * RECORDINGS.indexOf(id), 100 + 50 * RECORDINGS.indexOf(id)),
        ),
    },
    audio: {
      get: (id: string) => ({ id, name: 'Song.mp3', metadata: { frameCount: SONG_FRAMES } }),
      analysis: async () => (options.analyzed === false ? null : SONG),
    },
    imageLibrary: { get: () => ({}) },
    stills: {
      analysisFrames: async (mediaId: string, frames: number[]) => {
        reads.push(mediaId);
        return new Map(
          frames.map((frame) => [frame, scene(RECORDINGS.indexOf(mediaId) * 10 + Math.floor(frame / 400), frame)]),
        );
      },
      lumaFrames: async (mediaId: string, frames: number[]) =>
        frames.map((frame) => lumaOf(scene(RECORDINGS.indexOf(mediaId) * 10 + Math.floor(frame / 400), frame))),
    },
    styles: { get: async (id: string) => ({ id, name: 'Style', look: null }) },
    jobs,
    autoEdits: {
      save: async (result: AutoEditResult) => {
        results.set(result.id, result);
      },
      get: async (id: string) => results.get(id)!,
    },
  } as unknown as Context;
  return { context: value, saved, results, reads, jobs };
}

const choices = DEFAULT_AUTO_EDIT_CHOICES;

describe('auto edit operation', () => {
  it("proposes a whole graded cut on a new track, placing the brief's music, with a report", async () => {
    const document = project();
    const { context: fake, reads } = context(document);
    const result = await runners.auto_edit(fake, { projectId: 'flight', ...choices, apply: false });
    expect(result.revision).toBe(4);
    expect(result.applied).toBeNull();
    expect(reads.filter((id) => id === 'raw')).toEqual([]);
    const { report } = result;
    expect(report.skipped).toEqual([{ mediaId: 'raw', recording: 'RAW.MP4', reason: 'Not prepared.' }]);
    expect(report.music).toEqual({ trackId: 'auto-music', recording: 'Song.mp3', placed: true, analyzed: true });
    expect(report.clips.length).toBeGreaterThan(3);
    expect(report.alignment!.onBeat).toBe(report.alignment!.boundaries);
    expect(report.grade.choice).toBe('match');
    expect(report.grade.hero).not.toBeNull();
    expect(report.grade.failed).toBeNull();
    const built = result.commands.reduce((current, command) => applyCommand(current, command), document);
    expect(calculateLayout(built).duration).toBe(report.duration.frames);
    expect(built.layers.at(-1)!.name).toBe('Auto edit');
    expect(built.music).toHaveLength(1);
    const graded = built.clips.filter((clip) => clip.grade.color.exposure !== 0 || clip.grade.color.contrast !== 1);
    expect(graded.length).toBeGreaterThan(0);
    expect(result.commands.filter((command) => command.type === 'color-patch').length).toBeGreaterThan(
      report.clips.length - 1,
    );
  });

  it('grades only with Auto or not at all when asked, and saves the cut as one edit with apply', async () => {
    const document = project([lane()]);
    const { context: fake, saved } = context(document);
    const auto = await runners.auto_edit(fake, { projectId: 'flight', ...choices, grade: 'auto', apply: false });
    expect(auto.report.grade).toMatchObject({ choice: 'auto', hero: null });
    expect(auto.report.music).toMatchObject({ trackId: 'music-1', placed: false });
    const none = await runners.auto_edit(fake, { projectId: 'flight', ...choices, grade: 'none', apply: false });
    expect(none.commands.some((command) => command.type === 'color-patch')).toBe(false);
    await expect(runners.auto_edit(fake, { projectId: 'flight', ...choices, apply: true })).rejects.toThrow(
      /expectedRevision/,
    );
    const applied = await runners.auto_edit(fake, {
      projectId: 'flight',
      ...choices,
      grade: 'none',
      apply: true,
      expectedRevision: 4,
    });
    expect(applied.commands).toEqual([]);
    expect(applied.applied?.revision).toBe(5);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.layers.map((layer) => layer.name)).toEqual(['Track 1', 'Auto edit']);
  });

  it('refuses music without beats and a bin without analyzed footage', async () => {
    const { context: unanalyzed } = context(project([lane()]), { analyzed: false });
    await expect(runners.auto_edit(unanalyzed, { projectId: 'flight', ...choices, apply: false })).rejects.toThrow(
      /no beat analysis/,
    );
    const empty = projectSchema.parse({
      ...createProject('flight', 'Flight'),
      media: { videoIds: ['raw'], audioIds: ['song'], imageIds: [] },
    });
    const { context: bare } = context(empty);
    await expect(runners.auto_edit(bare, { projectId: 'flight', ...choices, apply: false })).rejects.toThrow(
      /No recording of the project is prepared/,
    );
  });

  it('runs as a job saving a copy of the project, or keeping the cut for the editor', async () => {
    const document = project([lane()]);
    const { context: fake, saved, results, jobs } = context(document);
    const editor = { ...fake, caller: 'editor' } as Context;
    const brief = briefSchema.parse({});
    await expect(
      runners.auto_edit_start(editor, { projectId: 'flight', expectedRevision: 3, into: 'copy', brief, choices }),
    ).rejects.toThrow(/revision 4, not 3/);
    const { job } = await runners.auto_edit_start(editor, {
      projectId: 'flight',
      expectedRevision: 4,
      into: 'copy',
      brief,
      choices: { ...choices, grade: 'none' },
    });
    expect(job.kind).toBe('auto-edit');
    const done = await jobs.wait(job.id);
    expect(done.state).toBe('completed');
    expect(done.message).toMatch(/^\d+ clips, \d\d:\d\d:\d\d on Song\.mp3$/);
    const copy = saved[0]!;
    expect(copy.id).not.toBe('flight');
    expect(copy.title).toBe('Flight · Auto edit');
    expect(copy.revision).toBe(1);
    expect(copy.layers.map((layer) => layer.name)).toEqual(['Auto edit']);
    expect(done.outputUrl).toBe(`/?project=${copy.id}`);
    const stored = (await runners.auto_edit_result(editor, { resultId: job.id })).result;
    expect(stored).toMatchObject({ projectId: copy.id, sourceProjectId: 'flight', into: 'copy', document: null });
    const again = await runners.auto_edit_start(editor, {
      projectId: 'flight',
      expectedRevision: 4,
      into: 'project',
      brief,
      choices: { ...choices, grade: 'none', variant: 1 },
    });
    await jobs.wait(again.job.id);
    const kept = results.get(again.job.id)!;
    expect(kept.projectId).toBe('flight');
    expect(projectSchema.parse(kept.document).id).toBe('flight');
    expect(saved).toHaveLength(1);
  });
});
