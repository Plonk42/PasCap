import { expect, test, type Page } from '@playwright/test';
import { briefSchema } from '../../src/shared/assistant-session.js';
import { DEFAULT_AUTO_EDIT_CHOICES } from '../../src/shared/auto-edit/options.js';
import type { AutoEditReport } from '../../src/shared/auto-edit/report.js';
import type { AutoEditResult } from '../../src/shared/auto-edit/result.js';
import { mediaAssetSchema, type MediaAsset, type MediaJob } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

const PROJECT_ID = 'browser-auto-edit';
const COPY_ID = 'browser-auto-edit-copy';
let assets: MediaAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];
let jobs: MediaJob[];
let started: Record<string, unknown>[];
const results = new Map<string, AutoEditResult>();

test.beforeEach(async ({ page, request }) => {
  unexpectedApi = [];
  jobs = [];
  started = [];
  results.clear();
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: unknown[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.map((item) => mediaAssetSchema.parse(item)).find((item) => item.name === name);
    if (asset?.status !== 'ready') throw new Error(`Auto edit regressions require the ready fixture ${name}.`);
    return asset;
  });
  const reads: Record<string, () => unknown> = {
    '/api/health': () => ({
      name: 'PasCap',
      milestone: 'editing-and-export',
      frameRate: '30000/1001',
      workerConcurrency: 1,
      toolchain: null,
    }),
    '/api/media': () => ({ assets, missing: [] }),
    '/api/audio': () => ({ assets: [], missing: [] }),
    '/api/jobs': () => ({ jobs }),
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname]() });
      return;
    }
    const media = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
    if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) {
      await route.continue();
      return;
    }
    unexpectedApi.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  memory = await memoryProjects(page, project());
  await page.route('**/api/ops/auto_edit_start', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    started.push(body);
    const job: MediaJob = {
      id: `auto-edit-job-${started.length}`,
      kind: 'auto-edit',
      label: 'Auto edit of Flight · memory-only',
      state: 'running',
      progress: 0.3,
      message: 'Looked at 3 of 9 steady ranges',
      createdAt: '2026-11-20T10:00:00.000Z',
      finishedAt: null,
      outputUrl: null,
      receiptUrl: null,
    };
    jobs = [job];
    await route.fulfill({ json: { job } });
  });
  await page.route('**/api/ops/auto_edit_result', async (route) => {
    const { resultId } = route.request().postDataJSON() as { resultId: string };
    const result = results.get(resultId);
    await route.fulfill(result ? { json: { result } } : { status: 404, json: { error: 'No such auto edit.' } });
  });
});

test.afterEach(() => {
  expect(unexpectedApi, 'No import, preparation, export or unowned API requests').toEqual([]);
});

function project(): ProjectDocument {
  const document = createProject(PROJECT_ID, 'Flight · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [createClip('a', assets[0]!.id, 15, 105)];
  return projectSchema.parse({ ...document, revision: 1 });
}

/** The copy an auto edit makes: one Auto edit track with a clip of each recording, or three for its variant. */
function copy(clips = 2): ProjectDocument {
  const document = createProject(COPY_ID, 'Flight · memory-only · Auto edit');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.layers = [createLayer('auto-edit', 'Auto edit')];
  document.clips = Array.from({ length: clips }, (_, index) => ({
    ...createClip(`auto-${index + 1}`, assets[index % 2]!.id, 0, 60),
    layerId: 'auto-edit',
    start: index * 60,
  }));
  document.layers[0]!.transitions = document.clips.slice(1).map((clip, index) => ({
    leftId: document.clips[index]!.id,
    rightId: clip.id,
    type: 'cut' as const,
    duration: 0 as const,
  }));
  return projectSchema.parse({ ...document, revision: 1 });
}

function report(document: ProjectDocument, variant: number): AutoEditReport {
  const range = (index: number) => ({
    recording: assets[index % 2]!.name,
    mediaId: assets[index % 2]!.id,
    sourceIn: 0,
    sourceOut: 60,
  });
  return {
    choices: { ...DEFAULT_AUTO_EDIT_CHOICES, pace: 'calm', variant },
    duration: { frames: document.clips.length * 60, seconds: document.clips.length * 2, timecode: '00:04:00' },
    targetSeconds: null,
    layerId: 'auto-edit',
    music: null,
    clips: document.clips.map((clip, index) => ({
      clipId: clip.id,
      ...range(index),
      start: index * 60,
      end: (index + 1) * 60,
      section: null,
      kind: index ? 'orbit' : 'reveal',
      quality: 0.8,
      reasons: index ? ['orbit (pan left)'] : ['reveal (pull out)', 'establishing shot, opens the cut'],
    })),
    transitions: { cuts: document.clips.length - 1, dissolves: 0, fades: 0 },
    alignment: null,
    duplicates: [{ chosen: range(0), alike: [{ ...range(1), sourceIn: 60, sourceOut: 120 }] }],
    leftOut: [{ ...range(1), sourceIn: 60, sourceOut: 120, reason: 'Another shot scored better in its place.' }],
    leftOutCount: 1,
    candidates: 3,
    skipped: [],
    grade: { choice: 'match', clips: document.clips.length, hero: null, style: null, failed: null },
    notes: ['The steady footage fills 4 of the 30 seconds wanted: keep more or longer ranges for a longer cut.'],
  };
}

function result(id: string, into: 'copy' | 'project', document: ProjectDocument, variant: number): AutoEditResult {
  return {
    id,
    createdAt: '2026-11-20T10:01:00.000Z',
    sourceProjectId: into === 'copy' ? PROJECT_ID : COPY_ID,
    sourceRevision: 1,
    into,
    projectId: COPY_ID,
    brief: briefSchema.parse({}),
    choices: { ...DEFAULT_AUTO_EDIT_CHOICES, pace: 'calm', variant },
    report: report(document, variant),
    document: into === 'project' ? document : null,
  };
}

function finish(message: string): void {
  jobs = jobs.map((job) => ({
    ...job,
    state: 'completed',
    progress: 1,
    message,
    finishedAt: '2026-11-20T10:01:00.000Z',
    outputUrl: `/?project=${COPY_ID}`,
  }));
}

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
}

async function clipCount(page: Page): Promise<number> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).clips.length;
}

test('auto edits a copy from Hand off, opens it with its report, and tries again as one Undo step', async ({
  page,
}) => {
  memory.seed(copy());
  results.set('auto-edit-job-1', result('auto-edit-job-1', 'copy', copy(), 0));
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page);
  await expect(page.getByRole('button', { name: 'Auto edit report' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Hand off to an assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand off' });
  const auto = dialog.getByRole('region', { name: 'Auto edit' });
  await expect(auto).toContainText('Builds a first cut in a copy, Flight · memory-only · Auto edit');
  await auto.getByLabel('Pace').selectOption('calm');
  await auto.getByRole('button', { name: 'Auto edit' }).click();
  await expect(auto.getByRole('progressbar', { name: 'Auto edit progress' })).toBeVisible();
  await expect(auto).toContainText('Looked at 3 of 9 steady ranges');
  await expect(auto.getByRole('button', { name: 'Auto edit' })).toBeDisabled();
  expect(started).toEqual([
    {
      projectId: PROJECT_ID,
      expectedRevision: 1,
      into: 'copy',
      brief: briefSchema.parse({}),
      choices: { ...DEFAULT_AUTO_EDIT_CHOICES, pace: 'calm' },
    },
  ]);

  finish('2 clips, 00:04:00');
  await expect(auto).toContainText('2 clips, 00:04:00');
  await auto.getByRole('button', { name: 'Open the auto edit' }).click();
  await expect(page).toHaveURL(new RegExp(`project=${COPY_ID}`));
  const report = page.getByRole('dialog', { name: 'Auto edit' });
  await expect(report).toContainText('2 clips · 00:04:00');
  await expect(report).toContainText('Calm pace · As filmed · Mixed · grade auto + match');
  await expect(report).toContainText('The steady footage fills 4 of the 30 seconds wanted');
  await expect(report.getByRole('table', { name: 'Clips of the auto edit' }).getByRole('row')).toHaveCount(3);
  await expect(report).toContainText('establishing shot, opens the cut');
  await report.getByText('Alike takes left out (1)').click();
  await expect(report).toContainText(`Kept ${assets[0]!.name} frames 0–59; left out ${assets[1]!.name} frames 60–119`);
  await report.getByRole('button', { name: 'Show clip 2' }).click();
  await expect(report).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(60);
  expect(await clipCount(page)).toBe(2);

  // Try again replaces the cut with the next alternative as one Undo step.
  await page.getByRole('button', { name: 'Auto edit report' }).click();
  await expect(report).toBeVisible();
  results.set('auto-edit-job-2', result('auto-edit-job-2', 'project', copy(3), 1));
  await report.getByRole('button', { name: 'Try again' }).click();
  await expect(report.getByRole('progressbar', { name: 'Try again progress' })).toBeVisible();
  expect(started[1]).toMatchObject({
    projectId: COPY_ID,
    expectedRevision: 1,
    into: 'project',
    choices: { ...DEFAULT_AUTO_EDIT_CHOICES, pace: 'calm', variant: 1 },
  });
  finish('3 clips, 00:06:00');
  await expect(report).toContainText('alternative 1');
  await expect(report.getByRole('table', { name: 'Clips of the auto edit' }).getByRole('row')).toHaveCount(4);
  expect(await clipCount(page)).toBe(3);
  await report.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => clipCount(page)).toBe(2);
});

test('opens a finished auto edit from Activity', async ({ page }) => {
  memory.seed(copy());
  results.set('auto-edit-job-1', result('auto-edit-job-1', 'copy', copy(), 0));
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page);
  await page.getByRole('button', { name: 'Hand off to an assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand off' });
  await dialog.getByRole('region', { name: 'Auto edit' }).getByRole('button', { name: 'Auto edit' }).click();
  await expect(dialog.getByRole('progressbar', { name: 'Auto edit progress' })).toBeVisible();
  // The dialog can close while the job runs; Activity opens the result once done.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  finish('2 clips, 00:04:00');
  await page.getByRole('button', { name: 'Open activity' }).click();
  await page.getByRole('button', { name: 'Open Auto edit of Flight · memory-only' }).click();
  await expect(page).toHaveURL(new RegExp(`project=${COPY_ID}`));
  await expect(page.getByRole('dialog', { name: 'Auto edit' })).toContainText('2 clips · 00:04:00');
});
