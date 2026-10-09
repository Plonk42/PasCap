import { expect, test, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { MediaAsset, MediaJob } from '../../src/shared/media.js';
import { createProject } from '../../src/shared/model.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let video: MediaAsset;
let reused: MediaAsset;
let music: AudioAsset;
const initialId = 'project-bin-first';
const initialTitle = 'First flight · memory-only';

test.beforeEach(async ({ page, request }) => {
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const audio = (await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] };
  video = library.assets.find((asset) => asset.name === 'pattern-a.mp4')!;
  reused = library.assets.find((asset) => asset.name === 'pattern-b.mp4')!;
  music = audio.assets[0]!;
  const project = {
    ...createProject(initialId, initialTitle),
    revision: 1,
    media: { videoIds: [video.id], audioIds: [music.id] },
  };
  memory = await memoryProjects(page, project);
  await page.goto(`/?project=${initialId}`);
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue(initialTitle);
  await expect(page.locator('.media-item')).toHaveCount(1);
});

async function create(page: Page, title = 'New empty flight'): Promise<string> {
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.getByRole('textbox', { name: 'New project title', exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toHaveCount(0);
  return page.evaluate(() => window.pascapLab!.project()!.id);
}

async function open(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toHaveCount(0);
}

test('new projects have empty video/audio bins and no stale source review, search or import dialog', async ({
  page,
}) => {
  await page.getByRole('button', { name: `Review ${video.name}`, exact: true }).click();
  await expect(page.locator('.source-preview')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search media', exact: true }).fill('pattern-a');
  const id = await create(page);
  expect(memory.snapshot(id).media).toEqual({ videoIds: [], audioIds: [] });
  await expect(page.locator('.media-item')).toHaveCount(0);
  await expect(page.locator('.source-preview')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search media', exact: true })).toHaveValue('');
  await expect(page.locator('[data-music-media-id]')).toHaveCount(0);
  await expect(page.getByText('Your media library is empty', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.media-item')).toHaveCount(0);
  await open(page, initialTitle);
  await expect(page.locator('.media-item')).toHaveCount(1);
  await expect(page.locator('[data-music-media-id]')).toHaveCount(1);
});

test('reimporting prepared media associates it only with the current project and survives reload without timeline clips', async ({
  page,
}) => {
  let imports = 0;
  let preparations = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/prepare')) preparations++;
  });
  await page.route('**/api/media/import', async (route) => {
    imports++;
    await route.fulfill({
      status: 202,
      json: { assets: [reused], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] },
    });
  });
  const id = await create(page);
  await page.locator('button[aria-label="Import folder"]').click();
  await page.getByText('Import a whole folder by path', { exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Absolute folder path on this machine' })
    .fill('/memory-only/already-prepared');
  await page.getByRole('button', { name: 'Register recordings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText('1 already registered');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot(id).media.videoIds).toEqual([reused.id]);
  expect(memory.snapshot(id).clips).toEqual([]);
  await page.reload();
  await expect(page.getByRole('button', { name: `Review ${reused.name}`, exact: true })).toBeVisible();
  await expect(page.locator('.media-item')).toHaveCount(1);
  await page.getByRole('button', { name: `Add ${reused.name} to timeline`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete selected clip', exact: true }).click();
  await expect(page.locator('.media-item')).toHaveCount(1);
  await open(page, initialTitle);
  await expect(page.getByRole('button', { name: `Review ${video.name}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Review ${reused.name}`, exact: true })).toHaveCount(0);
  expect(imports).toBe(1);
  expect(preparations).toBe(0);
});

test('audio imports persist in the new project bin without assigning a music track', async ({ page }) => {
  const job: MediaJob = {
    id: 'memory-reused-audio',
    kind: 'audio',
    label: music.name,
    state: 'completed',
    progress: 1,
    message: 'Already prepared',
    createdAt: '2026-10-03T10:00:00Z',
    finishedAt: '2026-10-03T10:00:00Z',
    outputUrl: null,
    receiptUrl: null,
  };
  await page.route('**/api/audio/register', (route) => route.fulfill({ status: 202, json: { asset: music, job } }));
  const id = await create(page);
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  const filename = page.getByRole('textbox', { name: 'Music recording path', exact: true });
  if (!(await filename.isVisible())) await page.getByRole('button', { name: 'Music section', exact: true }).click();
  await filename.fill('/memory-only/music.wav');
  await page.getByRole('button', { name: 'Import audio', exact: true }).click();
  await expect(page.locator(`[data-music-media-id="${music.id}"]`)).toHaveCount(1);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot(id).media.audioIds).toEqual([music.id]);
  expect(memory.snapshot(id).music).toEqual([]);
  await page.reload();
  await expect(page.locator(`[data-music-media-id="${music.id}"]`)).toHaveCount(1);
});

test('deleting another project requires confirmation, supports cancel, and leaves the current editor intact', async ({
  page,
  request,
}) => {
  const other = { ...createProject('other-bin', 'Other project'), revision: 1 };
  memory.seed(other);
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Delete Other project', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Delete project?', exact: true })).toContainText(
    'Original recordings, prepared media and exported videos are kept',
  );
  await page
    .getByRole('dialog', { name: 'Delete project?', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(trigger).toBeFocused();
  expect(memory.snapshot(other.id)).toEqual(other);
  await trigger.click();
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete project?', exact: true })).toHaveCount(0);
  await expect(trigger).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search projects' })).toBeFocused();
  expect(() => memory.snapshot(other.id)).toThrow('Unknown memory-only project');
  expect(await page.evaluate(() => window.pascapLab!.project()!.id)).toBe(initialId);
  const remaining = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  expect(remaining.assets.some((asset) => asset.id === video.id)).toBe(true);
});

test('deleting the current dirty project closes it, clears preview/history/preferences and does not recreate it', async ({
  page,
}) => {
  await page.evaluate((id) => localStorage.setItem(`pascap-media-ranges-${id}`, '{}'), initialId);
  const title = page.getByRole('textbox', { name: 'Project title', exact: true });
  await title.fill('Renamed before deletion');
  await title.press('Enter');
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.getByRole('button', { name: `Delete ${initialTitle}`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete project?', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.pascapLab!.project())).toBeNull();
  await expect(page).not.toHaveURL(/project=/);
  await expect(page.locator('.media-item')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().decoderCount)).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(
      (id) => [localStorage.getItem('pascap-project'), localStorage.getItem(`pascap-media-ranges-${id}`)],
      initialId,
    ),
  ).toEqual([null, null]);
  expect(() => memory.snapshot(initialId)).toThrow('Unknown memory-only project');
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page
    .getByRole('region', { name: 'Preview', exact: true })
    .getByRole('button', { name: 'Import folder', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Import recordings', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'New project title', exact: true }).fill('After deletion');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(title).toHaveValue('After deletion');
  expect(memory.saves).toBe(1);
});

test('a failed or stale deletion keeps the confirmation and current project with an explicit error', async ({
  page,
}) => {
  let deletes = 0;
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.route(`**/api/projects/${initialId}`, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    deletes++;
    await route.fulfill({
      status: 409,
      json: { error: 'This project changed in another tab. Refresh Projects before deleting it.' },
    });
  });
  await page.getByRole('button', { name: `Delete ${initialTitle}`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete project?', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('alert')).toContainText('changed in another tab');
  expect(await page.evaluate(() => window.pascapLab!.project()!.id)).toBe(initialId);
  expect(deletes).toBe(1);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: `Delete ${initialTitle}`, exact: true })).toBeFocused();
});

for (const oldVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  test(`unavailable schema-${oldVersion} projects can be explicitly deleted without being opened or migrated to schema 12`, async ({
    page,
  }) => {
    let deleted = false;
    let reads = 0;
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: {
          projects: deleted
            ? []
            : [
                {
                  id: 'old-v6',
                  title: 'Old dual-opacity project',
                  revision: 0,
                  clipCount: 0,
                  duration: 0,
                  updatedAt: '2026-10-03T10:00:00Z',
                  compatible: false,
                  error: `Unsupported project schema version ${oldVersion}; this build requires version 12.`,
                },
              ],
        },
      });
    });
    await page.route('**/api/projects/old-v6', async (route) => {
      if (route.request().method() !== 'DELETE') {
        reads++;
        await route.abort('blockedbyclient');
        return;
      }
      expect(route.request().postDataJSON()).toEqual({ expectedRevision: null });
      deleted = true;
      await route.fulfill({ json: { deleted: true } });
    });
    await page.getByRole('button', { name: 'Open projects', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Old dual-opacity project', exact: true })).toBeDisabled();
    await expect(
      page.getByText(`Unsupported project schema version ${oldVersion}; this build requires version 12.`, {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Delete Old dual-opacity project', exact: true }).click();
    await page.getByRole('button', { name: 'Delete project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete Old dual-opacity project', exact: true })).toHaveCount(0);
    expect(deleted).toBe(true);
    expect(reads).toBe(0);
    expect(await page.evaluate(() => window.pascapLab!.project()!.id)).toBe(initialId);
  });
