import { expect, test, type Page } from '@playwright/test';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';

let saved: ProjectDocument;
let initial: ProjectDocument;

/** Track 1 (Ripple off) holds a (0–60) and b (100–160); Track 2 (Ripple off) holds c (20–50). */
function project(assets: readonly MediaAsset[]): ProjectDocument {
  const [first, second] = ['pattern-a.mp4', 'pattern-b.mp4'].map(
    (name) => assets.find((asset) => asset.name === name)!.id,
  );
  const document = createProject('clip-group', 'Clip group · memory-only');
  document.media.videoIds = [first!, second!];
  document.layers[0]!.ripple = false;
  document.layers.push(createLayer('upper', 'Track 2', false));
  document.clips = [
    createClip('a', first!, 0, 60),
    { ...createClip('b', first!, 60, 120), start: 100 },
    { ...createClip('c', second!, 15, 45, 'upper'), start: 20 },
  ];
  document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
  return projectSchema.parse(document);
}

test.beforeEach(async ({ page, request }) => {
  const assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  saved = project(assets);
  initial = saved;
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: saved.id,
            title: saved.title,
            revision: saved.revision,
            clipCount: saved.clips.length,
            duration: calculateLayout(saved).duration,
            updatedAt: '2026-10-20T10:00:00Z',
            compatible: true,
            error: null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/projects/clip-group', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { document: saved } });
      return;
    }
    const body = route.request().postDataJSON() as { document: unknown };
    saved = projectSchema.parse({ ...projectSchema.parse(body.document), revision: saved.revision + 1 });
    await route.fulfill({ json: { document: saved } });
  });
  await page.goto('/?project=clip-group');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  // Exact frames: no magnet pulls the dragged group.
  await page.getByRole('button', { name: 'Toggle snapping' }).click();
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

function starts(document: ProjectDocument): Record<string, [string, number]> {
  return Object.fromEntries(
    calculateLayout(document).clips.map((placed) => [placed.clip.id, [placed.clip.layerId, placed.start]]),
  );
}

function clip(page: Page, id: string) {
  return page.locator(`[data-clip-id="${id}"]`);
}

/** Starts a real native drag of `id`, grabbed 12 frames in, and holds it over `layerId` at `desiredStart`. */
async function drag(page: Page, id: string, desiredStart: number, layerId: string): Promise<void> {
  const box = (await clip(page, id).boundingBox())!;
  const surface = page.locator('.timeline-surface');
  const scale = Number(await surface.getAttribute('data-pixels-per-frame'));
  const origin = (await surface.boundingBox())!.x + Number(await surface.getAttribute('data-leading'));
  const lane = (await page.locator(`[data-layer-lane="${layerId}"]`).boundingBox())!;
  await page.mouse.move(box.x + 12 * scale, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 12 * scale + 12, box.y + 30, { steps: 3 });
  await page.mouse.move(origin + (desiredStart + 12) * scale, lane.y + 38, { steps: 8 });
  await page.mouse.move(origin + (desiredStart + 12) * scale, lane.y + 38);
  await expect(page.locator(`.timeline-drop-preview[data-drop-clip="${id}"]`)).toBeVisible();
}

function ghost(page: Page, id: string) {
  return page.locator(`.timeline-drop-preview[data-drop-clip="${id}"]`);
}

test('Ctrl-click builds a selection whose clips from several tracks move in time together, in one Undo step', async ({
  page,
}) => {
  await clip(page, 'a').locator('.timeline-clip-body').click();
  await clip(page, 'c')
    .locator('.timeline-clip-body')
    .click({ modifiers: ['Control'] });
  await expect(clip(page, 'c')).toHaveClass(/\bselected\b/);
  await expect(clip(page, 'a')).toHaveClass(/\bgrouped\b/);
  await expect(clip(page, 'b')).not.toHaveClass(/\b(selected|grouped)\b/);
  for (const id of ['a', 'c'])
    await expect(clip(page, id).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Delete selected clips', exact: true })).toBeEnabled();

  await drag(page, 'a', 30, 'video-1');
  await expect(ghost(page, 'a')).toHaveAttribute('data-drop-start', '30');
  await expect(ghost(page, 'a')).toContainText('Move 2 clips');
  await expect(ghost(page, 'c')).toHaveAttribute('data-drop-start', '50');
  await expect(ghost(page, 'c')).toHaveAttribute('data-drop-layer', 'upper');
  expect((await current(page)).clips).toEqual(initial.clips);
  await page.mouse.up();
  await expect
    .poll(async () => starts(await current(page)))
    .toEqual({
      a: ['video-1', 30],
      b: ['video-1', 100],
      c: ['upper', 50],
    });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).clips).toEqual(initial.clips);

  // A plain click returns to one selected clip.
  await clip(page, 'b').locator('.timeline-clip-body').click();
  await expect(page.locator('.timeline-clip.grouped')).toHaveCount(0);
  await expect(clip(page, 'b')).toHaveClass(/\bselected\b/);
});

test('Select all clips moves a track’s clips to another track, keeping their offsets; Delete removes them all', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Select all clips on Track 1', exact: true }).click();
  await expect(clip(page, 'a')).toHaveClass(/\bselected\b/);
  await expect(clip(page, 'b')).toHaveClass(/\bgrouped\b/);
  await expect(page.getByRole('button', { name: 'Select all clips on Track 2', exact: true })).toBeEnabled();

  await drag(page, 'a', 200, 'upper');
  await expect(ghost(page, 'a')).toHaveAttribute('data-drop-layer', 'upper');
  await expect(ghost(page, 'b')).toHaveAttribute('data-drop-start', '300');
  await page.mouse.up();
  await expect
    .poll(async () => starts(await current(page)))
    .toEqual({
      c: ['upper', 20],
      a: ['upper', 200],
      b: ['upper', 300],
    });
  await expect(page.getByRole('button', { name: 'Select all clips on Track 1', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Delete selected clips', exact: true }).click();
  await expect.poll(async () => (await current(page)).clips.map((item) => item.id)).toEqual(['c']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await current(page)).clips.length).toBe(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).clips).toEqual(initial.clips);
});

test('an invalid group move shows red ghosts and commits nothing; Alt+arrows nudge the selection', async ({ page }) => {
  await clip(page, 'a').locator('.timeline-clip-body').click();
  await clip(page, 'c')
    .locator('.timeline-clip-body')
    .click({ modifiers: ['Control'] });
  // a would overlap b: the whole move is rejected, never clamped or applied in part.
  await drag(page, 'a', 50, 'video-1');
  for (const id of ['a', 'c']) await expect(ghost(page, id)).toHaveAttribute('data-drop-valid', 'false');
  await page.mouse.up();
  await expect(page.locator('.timeline-drop-preview')).toHaveCount(0);
  expect((await current(page)).clips).toEqual(initial.clips);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await page.getByRole('region', { name: 'Video timeline' }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect
    .poll(async () => starts(await current(page)))
    .toEqual({
      a: ['video-1', 1],
      b: ['video-1', 100],
      c: ['upper', 21],
    });
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await current(page)).clips.map((item) => item.id)).toEqual(['b']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).clips).toEqual(initial.clips);
});
