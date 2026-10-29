import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyCommand } from '../../src/shared/commands.js';
import { createAdjustment } from '../../src/shared/grade.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { expandedInspectorPreferences } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;

const current = (page: Page): Promise<ProjectDocument> => page.evaluate(() => window.pascapLab!.project()!);
const item = (page: Page, id: string): Locator => page.locator(`.adjustment-item[data-adjustment-id="${id}"]`);
const body = (page: Page, id: string): Locator => item(page, id).locator('.adjustment-body');
const ranges = async (page: Page) =>
  (await current(page)).adjustments.map(({ id, start, duration }) => ({ id, start, duration }));

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()))
    .toMatchObject({ status: 'paused', frame });
}

async function pixelsPerFrame(page: Page): Promise<number> {
  return Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
}

/** Presses on `target` and moves by whole frames, returning a function that releases the pointer. */
async function press(page: Page, target: Locator, frames: number, alt = true): Promise<() => Promise<void>> {
  const box = (await target.boundingBox())!;
  const scale = await pixelsPerFrame(page);
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (frames * scale) / 2, y, { steps: 3 });
  await page.mouse.move(x + frames * scale, y, { steps: 3 });
  return async () => {
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
  };
}

test.beforeEach(async ({ page, request }) => {
  const assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const asset = assets.find((entry) => entry.name === 'pattern-a.mp4' && entry.status === 'ready');
  if (!asset) throw new Error('Prepared synthetic video required.');
  let document = createProject('adjustment-timeline', 'Adjustment timeline · memory only');
  document.media.videoIds = [asset.id];
  document.clips = [createClip('one', asset.id, 0, 40), { ...createClip('two', asset.id, 40, 80), start: 40 }];
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  document.adjustments = [createAdjustment('a', 10, 20), createAdjustment('b', 50, 10)];
  document = applyCommand(document, {
    type: 'layer-key-toggle',
    adjustmentId: 'a',
    frame: 5,
    setting: 'exposure',
    value: 0.5,
  });
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await page.waitForFunction(() => window.pascapLab?.project() != null);
  await page.getByRole('slider', { name: 'Timeline zoom' }).fill('180');
  await seek(page, 0);
});

test('adjustments sit on a pinned track above the video tracks; a click selects one and opens its Colour', async ({
  page,
}) => {
  const lane = page.locator('.adjustment-lane');
  const track = page.locator('[data-layer-lane]').first();
  expect((await lane.boundingBox())!.y + 30).toBeLessThan((await track.boundingBox())!.y);
  await expect(page.locator('.layer-sidebar-adjustments')).toHaveText('Adjustments · 2 / 64');
  await expect(body(page, 'a')).toHaveAccessibleName('Adjustment 00:00:10 – 00:01:00');
  await expect(item(page, 'a').locator('[data-adjustment-keyframe="5"]')).toHaveAccessibleName(
    /Adjustment keyframe at 00:00:15/,
  );

  await body(page, 'a').click();
  await expect(body(page, 'a')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tab', { name: 'Colour', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inspector-pane .colour-target strong')).toHaveText('Adjustment 00:00:10 – 00:01:00');
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  expect(frame).toBeGreaterThanOrEqual(10);
  expect(frame).toBeLessThan(30);

  // A selected clip shows which adjustment also grades it at the playhead, without selecting it.
  await page.locator('[data-clip-id="one"] .timeline-clip-body').click();
  await seek(page, 20);
  await expect(body(page, 'a')).toHaveAttribute('aria-pressed', 'false');
  await expect(item(page, 'a')).toHaveClass(/grading/);
  await expect(body(page, 'a')).toHaveAccessibleName(/grades the selected clip/);
  await seek(page, 35);
  await expect(item(page, 'a')).not.toHaveClass(/grading/);
  expect(memory.saves).toBe(0);
});

test('dragging moves or trims an adjustment in one Undo step, refusing overlaps and restoring on Escape', async ({
  page,
}) => {
  const release = await press(page, body(page, 'a'), 10);
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '20');
  await expect(page.locator('.timeline-bottom')).toContainText('Adjustment 00:00:20 – 00:01:10');
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });
  await release();
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 20, duration: 20 });
  // Keyframes move with it: they count from its start.
  expect((await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([5]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });

  const overlap = await press(page, body(page, 'a'), 35);
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-valid', 'false');
  await expect(item(page, 'a')).toHaveClass(/invalid/);
  await expect(page.locator('.timeline-bottom')).toContainText('Adjustments cannot overlap');
  await overlap();
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '10');
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });

  const cancelled = await press(page, body(page, 'a'), 5);
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '15');
  await page.keyboard.press('Escape');
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '10');
  await cancelled();
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });

  // Trimming the start keeps each keyframe on its project frame.
  const trim = await press(page, item(page, 'a').locator('.trim-handle.in'), 3);
  await trim();
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 13, duration: 17 });
  expect((await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([2]);
  const saves = memory.saves;
  await page.keyboard.press('Control+z');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });
  await expect.poll(() => memory.saves).toBeGreaterThan(saves);
});

test('a moved adjustment snaps its edges to clip boundaries unless Alt is held', async ({ page }) => {
  // Its end lands at 39, one frame from the cut at 40; without snapping it would start at 19.
  const release = await press(page, body(page, 'a'), 8.8, false);
  await release();
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 20, duration: 20 });
});

test('keyboard moves, trims and deletes an adjustment', async ({ page }) => {
  await body(page, 'a').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 11, duration: 20 });
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 20 });
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.locator('.error-banner')).toContainText('An adjustment cannot start before the first frame.');
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 20 });
  await item(page, 'a').locator('.trim-handle.out').focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 10 });
  await body(page, 'a').focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => ranges(page)).toEqual([{ id: 'b', start: 50, duration: 10 }]);
  await expect(page.locator('.layer-sidebar-adjustments')).toHaveText('Adjustments · 1 / 64');
  await page.keyboard.press('Control+z');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 10 });
});

test('an adjustment keyframe slides within its adjustment', async ({ page }) => {
  const marker = item(page, 'a').locator('[data-adjustment-keyframe="5"]');
  const release = await press(page, marker, 3);
  await expect(page.locator('.timeline-bottom')).toContainText('Adjustment keyframe · 00:00:18');
  await release();
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([8]);
  await expect(page.getByRole('tab', { name: 'Colour', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(body(page, 'a')).toHaveAttribute('aria-pressed', 'true');

  const outside = item(page, 'a').locator('[data-adjustment-keyframe="8"]');
  await outside.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([18]);
  await page.keyboard.press('Shift+ArrowRight');
  expect((await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([18]);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes).toEqual([]);
});
