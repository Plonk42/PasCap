import { expect, test, type Page } from '@playwright/test';
import { mediaAssetSchema, type MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { memoryProjects, type MemoryProjects, type MemorySession } from './memory-projects.js';

const PROJECT_ID = 'browser-assistant';
let assets: MediaAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];

test.beforeEach(async ({ page, request }) => {
  unexpectedApi = [];
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: unknown[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.map((item) => mediaAssetSchema.parse(item)).find((item) => item.name === name);
    if (asset?.status !== 'ready') throw new Error(`Assistant session regressions require the ready fixture ${name}.`);
    return asset;
  });
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [], missing: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
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
  memory = await memoryProjects(page, project([], 1));
});

test.afterEach(() => {
  expect(unexpectedApi, 'No import, preparation, export or unowned API requests').toEqual([]);
});

function project(bookmarks: number[], revision: number): ProjectDocument {
  const document = createProject(PROJECT_ID, 'Assistant · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [createClip('a', assets[0]!.id, 15, 105), { ...createClip('b', assets[1]!.id, 30, 90), start: 90 }];
  document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
  return projectSchema.parse({ ...document, bookmarks, revision });
}

function session(edits: number): MemorySession {
  return {
    checkpoint: project([], 1),
    view: {
      projectId: PROJECT_ID,
      startedAt: '2026-10-21T10:00:00.000Z',
      startedBy: 'assistant',
      lastActivityAt: '2026-10-21T10:01:00.000Z',
      brief: { notes: 'A calm cut', musicTrackId: null, targetSeconds: null, allowedMovement: null, maxClips: null },
      checkpointId: '2026-10-21T10-00-00-000Z-abcdef',
      edits: Array.from({ length: edits }, (_, index) => ({
        revision: index + 2,
        at: '2026-10-21T10:01:00.000Z',
        commands: 1,
        summary: 'bookmark-add',
      })),
      endedAt: null,
      endedBy: null,
      notes: null,
      active: true,
      expiresAt: '2026-10-21T10:11:00.000Z',
    },
  };
}

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
}

async function bookmarks(page: Page): Promise<number[]> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).bookmarks;
}

test('follows an assistant session read-only, then takes over and restores the project before it', async ({ page }) => {
  memory.session = session(0);
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page);
  const banner = page.locator('.assistant-banner.editing');
  await expect(banner).toContainText('An assistant is editing this project');
  await expect(banner).toContainText('0 edits · no edits yet');

  // The editor is read-only: an edit is refused with the reason and nothing is saved.
  await page.getByRole('region', { name: 'Video timeline', exact: true }).focus();
  await page.keyboard.press('m');
  await expect(page.locator('.error-banner')).toContainText(
    'An assistant is editing this project: take over to edit it.',
  );
  expect(await bookmarks(page)).toEqual([]);

  // The assistant saves a revision: the editor adopts it without an Undo step or a save.
  memory.seed(project([30], 2));
  memory.session = session(1);
  await expect.poll(() => bookmarks(page), { timeout: 10_000 }).toEqual([30]);
  await expect(banner).toContainText('1 edit · last: bookmark-add');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(memory.saves).toBe(0);

  await banner.getByRole('button', { name: 'Take over' }).click();
  const ended = page.locator('.assistant-banner.ended');
  await expect(ended).toContainText('You took the project back · 1 edit');
  await expect(banner).toHaveCount(0);

  // Editing works again and saves.
  await page.evaluate(() => window.pascapLab!.engine.seek(60));
  await page.getByRole('region', { name: 'Video timeline', exact: true }).focus();
  await page.keyboard.press('m');
  await expect.poll(() => bookmarks(page)).toEqual([30, 60]);
  await expect.poll(() => memory.saves).toBe(1);

  await ended.getByRole('button', { name: 'Restore project before session' }).click();
  await expect.poll(() => bookmarks(page)).toEqual([]);
  expect(memory.snapshot().revision).toBe(4);
  await expect(ended).toHaveCount(0);
});

test('keeps unsaved editor changes when a session starts, for the user to download or discard', async ({ page }) => {
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page);
  await expect(page.locator('.assistant-banner')).toHaveCount(0);
  // Saves are refused once the assistant holds the lease, as the service does.
  await page.route(`**/api/projects/${PROJECT_ID}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await route.fulfill({
      status: 423,
      json: {
        error: 'An assistant is editing this project. Take over in the editor to edit it again; nothing was saved.',
      },
    });
  });
  await page.evaluate(() => window.pascapLab!.engine.seek(45));
  await page.getByRole('region', { name: 'Video timeline', exact: true }).focus();
  await page.keyboard.press('m');
  memory.session = session(0);
  await expect(page.locator('.save-recovery-banner')).toContainText('An assistant is editing this project');
  await expect(page.locator('.assistant-banner.editing')).toBeVisible();
  memory.seed(project([90], 2));
  // The draft stays: a newer saved revision never replaces unsaved changes, whatever the polls report.
  for (let poll = 0; poll < 2; poll++)
    await page.waitForResponse((response) => response.url().endsWith('/api/ops/session_status'));
  expect(await bookmarks(page)).toEqual([45]);
  await expect(page.getByRole('button', { name: 'Download unsaved project' })).toBeVisible();
});

test('hands off with a brief after showing what the assistant can use, then opens the project before it as a copy', async ({
  page,
}) => {
  memory.readiness = {
    recordings: [
      { id: assets[0]!.id, name: 'pattern-a.mp4', preparation: 'ready', cameraMotion: 'analysed' },
      { id: assets[1]!.id, name: 'pattern-b.mp4', preparation: 'ready', cameraMotion: 'missing' },
    ],
    music: [],
    exportRunning: true,
  };
  const analysed: string[] = [];
  await page.route('**/api/media/*/motion', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    analysed.push(id);
    memory.readiness = {
      ...memory.readiness,
      recordings: memory.readiness.recordings.map((item) =>
        item.id === id ? { ...item, cameraMotion: 'analysing' } : item,
      ),
    };
    await route.fulfill({
      json: {
        job: {
          id: 'motion-job',
          kind: 'motion',
          label: 'pattern-b.mp4',
          state: 'queued',
          progress: 0,
          message: 'Queued',
          createdAt: '2026-10-21T10:00:00.000Z',
          finishedAt: null,
          outputUrl: null,
          receiptUrl: null,
        },
      },
    });
  });
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page);
  await page.getByRole('button', { name: 'Hand off to an assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand off to an assistant' });
  const readiness = dialog.getByRole('region', { name: 'What the assistant can use' });
  await expect(readiness).toContainText('2 video recordings prepared');
  await expect(readiness).toContainText('Camera motion not analysed for 1 recording');
  await expect(readiness).toContainText('No music in this project');
  await expect(readiness).toContainText('An export is running');
  await readiness.getByRole('button', { name: 'Analyse 1' }).click();
  await expect(readiness).toContainText('1 analysing');
  expect(analysed).toEqual([assets[1]!.id]);

  await dialog.getByLabel('What should it make?').fill('A calm cut of the lake');
  await dialog.getByLabel('Target length (s)').fill('30');
  await dialog.getByLabel('Allowed movement').fill('9');
  await expect(dialog.getByText('Enter a number from 0.5 to 6.')).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Hand off', exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Allowed movement').fill('3');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.assistant-banner.editing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hand off to an assistant' })).toBeDisabled();
  expect(memory.session?.view?.brief).toEqual({
    notes: 'A calm cut of the lake',
    musicTrackId: null,
    targetSeconds: 30,
    allowedMovement: 3,
    maxClips: null,
  });

  // The assistant edits, then finishes with notes.
  memory.seed(project([30], 2));
  memory.session = {
    ...memory.session!,
    view: {
      ...memory.session!.view!,
      edits: [{ revision: 2, at: '2026-10-21T10:02:00.000Z', commands: 1, summary: 'bookmark-add' }],
      active: false,
      endedAt: '2026-10-21T10:03:00.000Z',
      endedBy: 'assistant',
      notes: 'Marked the first cut.',
      expiresAt: null,
    },
  };
  const ended = page.getByRole('region', { name: 'Assistant session summary' });
  await expect(ended).toContainText('The assistant finished · 1 edit');
  await expect(ended).toContainText('Marked the first cut.');
  await expect.poll(() => bookmarks(page)).toEqual([30]);
  await ended.getByText('Edit log').click();
  await expect(ended.getByRole('listitem')).toContainText(['bookmark-add']);

  await ended.getByRole('button', { name: 'Open as new project' }).click();
  await expect(page).toHaveURL(/project=browser-project-1/);
  await expect(page.locator('.assistant-banner')).toHaveCount(0);
  expect(await bookmarks(page)).toEqual([]);
  expect(memory.snapshot('browser-project-1').title).toBe('Assistant · memory-only (before assistant)');
  expect(memory.snapshot().bookmarks).toEqual([30]);
});
