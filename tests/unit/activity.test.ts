import { describe, expect, it } from 'vitest';
import {
  EMPTY_KEY_VALUES,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import type { MediaJob } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';
import type { ProjectSummary } from '../../src/shared/projects.js';
import { summarizeExport } from '../../src/web/ExportDialog.js';
import { activityResultSummary, activitySummary, isActiveJob, orderActivityJobs } from '../../src/web/Jobs.js';
import { filterProjects } from '../../src/web/Projects.js';

function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function job(id: string, overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id,
    kind: 'prepare',
    label: `${id}.mp4`,
    state: 'queued',
    progress: 0,
    message: 'Waiting for the media worker',
    createdAt: '2026-10-03T10:00:00Z',
    finishedAt: null,
    outputUrl: null,
    receiptUrl: null,
    ...overrides,
  };
}

function project(id: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    title: id,
    revision: 0,
    clipCount: 0,
    duration: 0,
    updatedAt: '2026-10-03T10:00:00Z',
    compatible: true,
    error: null,
    ...overrides,
  };
}

describe('project dialog filtering', () => {
  const entries = [
    project('north-2', { title: 'North flight 2', clipCount: 2, duration: 90, updatedAt: '2026-10-02T12:00:00Z' }),
    project('north-10', { title: 'North flight 10', updatedAt: '2026-10-03T12:00:00Z' }),
    project('legacy', {
      title: 'North flight old',
      compatible: false,
      error: 'Unsupported project schema version 6; this build requires version 13.',
    }),
    project('south', { title: 'South flight', updatedAt: '2026-10-01T12:00:00Z' }),
  ];

  it('searches titles and IDs with trimmed case-insensitive terms', () => {
    expect(filterProjects(entries, '  NORTH   flight ', 'compatible').map((entry) => entry.id)).toEqual([
      'north-10',
      'north-2',
    ]);
    expect(filterProjects(entries, 'NORTH-2').map((entry) => entry.id)).toEqual(['north-2']);
    expect(filterProjects(entries, 'missing')).toEqual([]);
  });

  it('keeps unavailable entries visible by default and filters compatibility explicitly', () => {
    expect(filterProjects(entries, '').map((entry) => entry.id)).toContain('legacy');
    expect(filterProjects(entries, '', 'compatible').every((entry) => entry.compatible)).toBe(true);
    expect(filterProjects(entries, '', 'unsupported')).toEqual([entries[2]]);
    expect(filterProjects(entries, 'south', 'unsupported')).toEqual([]);
  });

  it('uses updated dates, natural title ties, then IDs without mutating the source', () => {
    const a = Object.freeze(project('a', { title: 'Flight 10' }));
    const b = Object.freeze(project('b', { title: 'Flight 2' }));
    const c = Object.freeze(project('c', { title: 'Flight 2' }));
    const source = Object.freeze([a, c, b]);
    expect(filterProjects(source, '').map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    expect(source.map((entry) => entry.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not invent metadata or rewrite an unsupported document summary', () => {
    const unavailable = Object.freeze(entries[2]!);
    const filtered = filterProjects(Object.freeze([unavailable]), 'old', 'unsupported');
    expect(filtered[0]).toBe(unavailable);
    expect(filtered[0]?.error).toBe('Unsupported project schema version 6; this build requires version 13.');
    expect(filtered[0]?.compatible).toBe(false);
    expect(filtered[0]?.clipCount).toBe(0);
  });

  it('handles empty lists and unavailable dates deterministically', () => {
    expect(filterProjects([], '', 'compatible')).toEqual([]);
    expect(
      filterProjects([project('unknown', { updatedAt: 'unavailable' }), project('dated')], '').map((entry) => entry.id),
    ).toEqual(['dated', 'unknown']);
  });
});

describe('activity ordering and summaries', () => {
  it('orders running jobs, a FIFO queue and all history by finished time', () => {
    const jobs = [
      job('completed', {
        state: 'completed',
        createdAt: '2026-10-03T09:00:00Z',
        finishedAt: '2026-10-03T12:00:00Z',
        progress: 1,
      }),
      job('queued-new', { createdAt: '2026-10-03T11:00:00Z' }),
      job('cancelled', { state: 'cancelled', createdAt: '2026-10-03T11:00:00Z', finishedAt: '2026-10-03T11:30:00Z' }),
      job('running', { state: 'running', progress: 0.2 }),
      job('queued-old', { createdAt: '2026-10-03T10:30:00Z' }),
      job('failed', { state: 'failed', finishedAt: '2026-10-03T12:30:00Z' }),
    ];
    const source = Object.freeze(jobs.map((entry) => Object.freeze(entry)));
    expect(orderActivityJobs(source).map((entry) => entry.id)).toEqual([
      'running',
      'queued-old',
      'queued-new',
      'failed',
      'completed',
      'cancelled',
    ]);
    expect(source.map((entry) => entry.id)).toEqual([
      'completed',
      'queued-new',
      'cancelled',
      'running',
      'queued-old',
      'failed',
    ]);
  });

  it('uses stable IDs for ties and tolerates missing completion timestamps', () => {
    expect(orderActivityJobs([job('b'), job('a')]).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(
      orderActivityJobs([
        job('unknown', { state: 'cancelled', createdAt: 'unknown' }),
        job('known', { state: 'completed' }),
      ]).map((entry) => entry.id),
    ).toEqual(['known', 'unknown']);
  });

  it('counts every state and every preparation/render kind', () => {
    expect(activitySummary([])).toBe('No activity yet');
    expect(
      activitySummary([
        job('running', { state: 'running', kind: 'export' }),
        job('queued'),
        job('queued-audio', { kind: 'audio' }),
        job('failed', { state: 'failed' }),
        job('cancelled', { state: 'cancelled', kind: 'audio' }),
        job('completed', { state: 'completed', kind: 'reference' }),
      ]),
    ).toBe('1 running · 2 queued · 1 failed · 1 cancelled · 1 completed');
  });

  it('announces preparation failures/cancellations and completion, but not progress', () => {
    expect(activityResultSummary(null)).toBe('');
    expect(activityResultSummary(job('clip', { state: 'running', progress: 0.7 }))).toBe('');
    expect(activityResultSummary(job('clip', { state: 'queued' }))).toBe('');
    expect(activityResultSummary(job('clip', { state: 'failed', message: 'Cannot prepare proxy' }))).toBe(
      'Video recording preparation failed: clip.mp4. Cannot prepare proxy',
    );
    expect(activityResultSummary(job('music', { kind: 'audio', state: 'cancelled', message: 'Job cancelled.' }))).toBe(
      'Music recording preparation cancelled: music.mp4. Job cancelled.',
    );
    const completed = job('render', { kind: 'export', state: 'completed', progress: 1 });
    expect(activityResultSummary(completed)).toBe('Export completed: render.mp4');
    expect(activityResultSummary({ ...completed, progress: 0.9 })).toBe(activityResultSummary(completed));
  });

  it('only treats queued and running jobs as cancellable activity', () => {
    expect(
      ['queued', 'running', 'completed', 'failed', 'cancelled'].map((state) =>
        isActiveJob(job(state, { state: state as MediaJob['state'] })),
      ),
    ).toEqual([true, true, false, false, false]);
  });
});

describe('export snapshot summary', () => {
  it('summarizes an empty strict version 13 project without adding defaults', () => {
    const document = createProject('empty', 'Empty');
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({ duration: 0, clips: 0, layers: 1, enabledLayers: 1, layered: false });
    expect(summary.keys).toEqual({ points: 0, settings: 0, colour: 0, opacity: 0 });
    expect(document.schemaVersion).toBe(13);
    expect(document.media).toEqual({ videoIds: [], audioIds: [] });
    expect(document.layers[0]!.keyframes).toEqual([]);
  });

  it('uses retimed duration and includes disabled overlay tails and stored keys', () => {
    const document: ProjectDocument = createProject('layers', 'Layers');
    const primary = createClip('primary', 'source', 0, 60);
    primary.speed = { mode: 'constant', rate: 2 };
    document.layers[0]!.keyframes = [
      point(
        0,
        {
          opacity: 1,
          temperature: 0,
          tint: 0,
          exposure: 0,
          brightness: 0,
          contrast: 1,
          hue: 0,
          saturation: 1,
          highlights: 0,
          shadows: 0,
        },
        'hold',
      ),
    ];
    const overlay = createClip('overlay', 'source', 0, 30);
    overlay.layerId = 'video-2';
    overlay.start = 100;
    document.layers.push({
      ...createLayer('video-2', 'Overlay', false),
      enabled: false,
      keyframes: [point(0, { opacity: 1 }), point(200, { brightness: 0.1 }, 'hold')],
    });
    document.clips = [primary, overlay];
    const before = JSON.stringify(document);
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({ duration: 130, clips: 2, layers: 2, enabledLayers: 1, layered: true });
    expect(summary.keys).toEqual({ points: 3, settings: 12, colour: 10, opacity: 2 });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('distinguishes shared track points from the static-only export path and still detects row opacity', () => {
    const document = createProject('points', 'Points');
    const clip = createClip('clip', 'source', 0, 60);
    document.layers[0]!.keyframes = [point(0, { exposure: 0.5 })];
    document.clips = [clip];
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({ duration: 60, layered: true });
    expect(summary.keys).toEqual({ points: 1, settings: 1, colour: 1, opacity: 0 });
    document.layers[0]!.keyframes = [];
    expect(summarizeExport(document)).toMatchObject({ duration: 60, layered: false });
    document.layers[0]!.opacity = 0.5;
    expect(summarizeExport(document).layered).toBe(true);
  });

  it('counts each row point once across its clips and counts zero-valued colour members individually', () => {
    const document = createProject('participants', 'Participants');
    const left = createClip('left', 'source', 0, 30);
    const right = createClip('right', 'source', 100, 130);
    document.layers[0]!.colour.hue = 90;
    document.clips = [left, right];
    document.layers[0]!.transitions = [{ leftId: 'left', rightId: 'right', type: 'cut', duration: 0 }];
    document.layers[0]!.keyframes = [
      point(0, { exposure: 0, brightness: 0, opacity: 0 }),
      point(60, { exposure: 1, shadows: 0 }),
    ];
    const before = JSON.stringify(document);
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({ duration: 60, clips: 2, layers: 1, enabledLayers: 1, layered: true });
    expect(summary.keys).toEqual({ points: 2, settings: 5, colour: 4, opacity: 1 });
    expect(JSON.stringify(document)).toBe(before);
  });
});
