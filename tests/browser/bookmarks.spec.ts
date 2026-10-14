import { expect, test, type Page } from '@playwright/test';
import { mediaAssetSchema, type MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

const PROJECT_ID = 'browser-bookmarks';
let assets: MediaAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];

test.beforeEach(async ({ page, request }) => {
  unexpectedApi = [];
  // Read already prepared fixtures only; never prepare or register here.
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: unknown[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.map((item) => mediaAssetSchema.parse(item)).find((item) => item.name === name);
    if (asset?.status !== 'ready' || !asset.sourcePath.endsWith(`/synthetic-sources/${name}`))
      throw new Error(`Bookmark regressions require the existing ready synthetic fixture ${name}.`);
    return asset;
  });
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets },
    '/api/audio': { assets: [] },
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
  memory = await memoryProjects(page, sequence([]));
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page);
});

test.afterEach(() => {
  expect(unexpectedApi, 'No import, preparation, export or unowned API requests').toEqual([]);
});

/** Clips a 0–90, b 90–150, c 150–210 on one Ripple track. */
function sequence(bookmarks: number[]): ProjectDocument {
  const document = createProject(PROJECT_ID, 'Bookmarks · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [
    createClip('a', assets[0]!.id, 15, 105),
    { ...createClip('b', assets[1]!.id, 30, 90), start: 90 },
    { ...createClip('c', assets[0]!.id, 60, 120), start: 150 },
  ];
  document.layers[0]!.transitions = [
    { leftId: 'a', rightId: 'b', type: 'cut', duration: 0 },
    { leftId: 'b', rightId: 'c', type: 'cut', duration: 0 },
  ];
  return projectSchema.parse({ ...document, bookmarks });
}

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
}

async function fixture(page: Page, bookmarks: number[]): Promise<void> {
  memory.seed(sequence(bookmarks));
  await page.reload();
  await ready(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function bookmarks(page: Page): Promise<number[]> {
  return (await current(page)).bookmarks;
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
}

async function frameX(page: Page, frame: number): Promise<number> {
  const surface = page.locator('.timeline-surface');
  const { left, leading, scale } = await surface.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    leading: Number(element.getAttribute('data-leading')),
    scale: Number(element.getAttribute('data-pixels-per-frame')),
  }));
  return left + leading + frame * scale;
}

function marker(page: Page, frame: number) {
  return page.locator(`[data-bookmark="${frame}"]`);
}

/** Real pointer capture on the marker, then movement to the timeline x of `frame`; returns before release. */
async function dragMarker(page: Page, from: number, to: number, alt = false): Promise<void> {
  const box = (await marker(page, from).boundingBox())!;
  const y = box.y + box.height / 2;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 6, y, { steps: 2 });
  await page.mouse.move(await frameX(page, to), y, { steps: 4 });
}

test('M and the toolbar add and delete bookmarks at the playhead; duplicates are rejected; a click only seeks', async ({
  page,
}) => {
  await seek(page, 60);
  await page.getByRole('region', { name: 'Video timeline', exact: true }).focus();
  await page.keyboard.press('m');
  await expect.poll(() => bookmarks(page)).toEqual([60]);
  await expect(marker(page, 60)).toHaveAccessibleName('Bookmark at 00:00:02:00');
  await page.keyboard.press('m');
  await expect(page.getByRole('alert')).toContainText('A bookmark already exists at this frame.');
  expect(await bookmarks(page)).toEqual([60]);

  const toggle = page.locator('.timeline-bookmark-action');
  await expect(toggle).toHaveAccessibleName('Delete bookmark at playhead');
  await toggle.click();
  await expect.poll(() => bookmarks(page)).toEqual([]);
  await expect(toggle).toHaveAccessibleName('Add bookmark at playhead');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => bookmarks(page)).toEqual([60]);

  await seek(page, 120);
  await toggle.click();
  await expect.poll(() => bookmarks(page)).toEqual([60, 120]);
  const before = await current(page);
  await seek(page, 0);
  await marker(page, 60).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(60);
  expect(await current(page)).toEqual(before);

  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot(PROJECT_ID).bookmarks).toEqual([60, 120]);
  await page.reload();
  await ready(page);
  await expect(page.locator('[data-bookmark]')).toHaveCount(2);
});

test('bookmarks slide with snapping, arrows and Delete; occupied frames and Escape restore', async ({ page }) => {
  await fixture(page, [40, 130]);
  // Snaps to clip a's OUT at 90, never back to its own origin.
  await dragMarker(page, 40, 93);
  await expect(page.locator('.timeline-bookmark.moving')).toHaveAttribute('data-bookmark', '90');
  await expect(page.locator('.bookmark-keyframe-guide')).toHaveCount(1);
  expect(await bookmarks(page)).toEqual([40, 130]);
  await page.mouse.up();
  await expect.poll(() => bookmarks(page)).toEqual([90, 130]);
  await expect(marker(page, 90)).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => bookmarks(page)).toEqual([91, 130]);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => bookmarks(page)).toEqual([81, 130]);
  await page.keyboard.press('Delete');
  await expect.poll(() => bookmarks(page)).toEqual([130]);
  for (const expected of [
    [81, 130],
    [91, 130],
    [90, 130],
    [40, 130],
  ]) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => bookmarks(page)).toEqual(expected);
  }

  await dragMarker(page, 40, 130, true);
  await expect(page.locator('.timeline-bookmark.invalid')).toHaveCount(1);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.getByRole('alert')).toContainText('A bookmark already exists at the destination frame.');
  expect(await bookmarks(page)).toEqual([40, 130]);

  await dragMarker(page, 40, 70, true);
  await expect(page.locator('.timeline-bookmark.moving')).toHaveAttribute('data-bookmark', '70');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(marker(page, 40)).toBeVisible();
  expect(await bookmarks(page)).toEqual([40, 130]);
  // Nothing was committed: the Redo stack from the Undo steps above is intact.
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => bookmarks(page)).toEqual([90, 130]);
});

test('a clip trim snaps to a bookmark exactly like a clip boundary; Alt bypasses it', async ({ page }) => {
  await fixture(page, [130]);
  const handle = page.locator('.timeline-clip[data-clip-id="b"] [data-trim-handle="out"]');
  const trimTo = async (frame: number, alt: boolean): Promise<void> => {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (await frameX(page, frame)) - (await frameX(page, 150)), y, { steps: 4 });
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
  };
  const end = async (): Promise<number> =>
    calculateLayout(await current(page)).clips.find((placed) => placed.clip.id === 'b')!.end;

  await trimTo(133, false);
  await expect.poll(end).toBe(130);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(end).toBe(150);
  await trimTo(133, true);
  await expect.poll(end).toBe(133);
  expect(await bookmarks(page)).toEqual([130]);
});
