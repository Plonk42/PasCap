import { describe, expect, it } from 'vitest';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { createAdjustment, layerKeyAsGradeKey, type GradeKeyframe } from '../../src/shared/grade.js';
import {
  EMPTY_KEY_VALUES,
  type Interpolation,
  type LayerKeyValues,
  layerKeyframe,
  uniformKeyframe,
} from '../../src/shared/keyframes.js';
import type { MediaJob } from '../../src/shared/media.js';
import {
  createClip,
  createLayer,
  createProject,
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
} from '../../src/shared/model.js';
import type { ProjectSummary } from '../../src/shared/projects.js';
import { SPATIAL_CHANNELS, type SpatialKeyframe, type SpatialKeyValues } from '../../src/shared/spatial.js';
import { summarizeExport } from '../../src/web/ExportDialog.js';
import {
  activityResultSummary,
  activitySummary,
  formatJobDuration,
  isActiveJob,
  orderActivityJobs,
} from '../../src/web/Jobs.js';
import { filterProjects } from '../../src/web/Projects.js';

function gradeKey(
  frame: number,
  values: Partial<LayerKeyValues>,
  interpolation: Interpolation = 'linear',
): GradeKeyframe {
  return layerKeyAsGradeKey(layerKeyframe(frame, { ...EMPTY_KEY_VALUES, ...values }, interpolation));
}
const NO_TRANSFORM = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as SpatialKeyValues;
function transformKey(frame: number, values: Partial<SpatialKeyValues>): SpatialKeyframe {
  return { ...uniformKeyframe(frame, { ...NO_TRANSFORM, ...values }, 'linear'), reset: false };
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
      error: `Unsupported project schema version 6; this build requires version ${PROJECT_SCHEMA_VERSION}.`,
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
    expect(filtered[0]?.error).toBe(
      `Unsupported project schema version 6; this build requires version ${PROJECT_SCHEMA_VERSION}.`,
    );
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

  it('lists queued camera motion analyses after the other queued jobs, as they run', () => {
    expect(
      orderActivityJobs([
        job('motion-old', { kind: 'motion', createdAt: '2026-10-03T09:00:00Z' }),
        job('prepare-new', { createdAt: '2026-10-03T10:00:00Z' }),
        job('motion-running', { kind: 'motion', state: 'running' }),
        job('failed', { state: 'failed', finishedAt: '2026-10-03T12:30:00Z' }),
      ]).map((entry) => entry.id),
    ).toEqual(['motion-running', 'prepare-new', 'motion-old', 'failed']);
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

  it('formats the time between creation and completion', () => {
    const created = '2026-10-03T10:00:00Z';
    expect(formatJobDuration(created, '2026-10-03T10:00:45Z')).toBe('45 s');
    expect(formatJobDuration(created, '2026-10-03T10:03:05Z')).toBe('3 min 05 s');
    expect(formatJobDuration(created, '2026-10-03T11:02:20Z')).toBe('1 h 02 min');
    expect(formatJobDuration(created, '2026-10-03T09:59:00Z')).toBeNull();
    expect(formatJobDuration('unknown', '2026-10-03T10:00:00Z')).toBeNull();
  });
});

describe('export snapshot summary', () => {
  it('summarizes an empty strict current-schema project without adding defaults', () => {
    const document = createProject('empty', 'Empty');
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({
      duration: 0,
      clips: 0,
      layers: 1,
      enabledLayers: 1,
      adjustments: 0,
      keyframeCount: 0,
      layered: false,
    });
    expect(summary.keys).toEqual({ points: 0, settings: 0, transform: 0 });
    expect(document.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(document.media).toEqual({ videoIds: [], audioIds: [] });
    expect(document.layers[0]!.transform.keyframes).toEqual([]);
    expect(document.adjustments).toEqual([]);
  });

  it('uses retimed duration and includes disabled overlay tails and stored keys', () => {
    const document: ProjectDocument = createProject('layers', 'Layers');
    const primary = createClip('primary', 'source', 0, 60);
    primary.speed = { mode: 'constant', rate: 2 };
    primary.grade.keyframes = [
      gradeKey(
        0,
        {
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
    document.layers[0]!.transform.keyframes = [transformKey(0, { opacity: 1 })];
    const overlay = createClip('overlay', 'source', 0, 30);
    overlay.layerId = 'video-2';
    overlay.start = 100;
    overlay.grade.keyframes = [gradeKey(5, { brightness: 0.1 }, 'hold')];
    const hidden = createLayer('video-2', 'Overlay', false);
    hidden.transform.keyframes = [transformKey(0, { opacity: 1 })];
    document.layers.push({ ...hidden, enabled: false });
    // An adjustment keeps its keyframes outside its range, and never extends the project.
    document.adjustments = [{ ...createAdjustment('look', 0, 50), keyframes: [gradeKey(200, { brightness: 0.1 })] }];
    document.clips = [primary, overlay];
    const before = JSON.stringify(document);
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({
      duration: 130,
      clips: 2,
      layers: 2,
      enabledLayers: 1,
      adjustments: 1,
      keyframeCount: 3,
      layered: true,
    });
    expect(summary.keys).toEqual({ points: 3, settings: 11, transform: 2 });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('distinguishes keyed grades and adjustments from the static-only export path and still detects track Opacity', () => {
    const document = createProject('points', 'Points');
    const clip = createClip('clip', 'source', 0, 60);
    document.adjustments = [{ ...createAdjustment('look', 0, 60), keyframes: [gradeKey(0, { exposure: 0.5 })] }];
    document.clips = [clip];
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({ duration: 60, layered: true });
    expect(summary.keys).toEqual({ points: 1, settings: 1, transform: 0 });
    document.adjustments = [];
    expect(summarizeExport(document)).toMatchObject({ duration: 60, layered: false });
    clip.grade.keyframes = [gradeKey(10, { exposure: 0.5 })];
    expect(summarizeExport(document)).toMatchObject({ layered: true, keys: { points: 1, settings: 1, transform: 0 } });
    clip.grade.keyframes = [];
    expect(summarizeExport(document).layered).toBe(false);
    document.layers[0]!.transform.base.opacity = 0.5;
    expect(summarizeExport(document).layered).toBe(true);
  });

  it('counts each adjustment point once across the clips it grades and counts zero-valued members individually', () => {
    const document = createProject('participants', 'Participants');
    const left = createClip('left', 'source', 0, 30);
    const right = createClip('right', 'source', 100, 130);
    document.clips = [left, right];
    document.layers[0]!.transitions = [{ leftId: 'left', rightId: 'right', type: 'cut', duration: 0 }];
    document.layers[0]!.transform.keyframes = [transformKey(0, { opacity: 0 })];
    document.adjustments = [
      {
        ...createAdjustment('look', 0, 60),
        colour: { ...NEUTRAL_COLOUR, hue: 90 },
        keyframes: [gradeKey(0, { exposure: 0, brightness: 0 }), gradeKey(60, { exposure: 1, shadows: 0 })],
      },
    ];
    const before = JSON.stringify(document);
    const summary = summarizeExport(document);
    expect(summary).toMatchObject({ duration: 60, clips: 2, layers: 1, enabledLayers: 1, layered: true });
    expect(summary.keys).toEqual({ points: 2, settings: 4, transform: 1 });
    expect(JSON.stringify(document)).toBe(before);
  });
});
