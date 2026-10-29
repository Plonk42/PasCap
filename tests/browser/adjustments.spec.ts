import { expect, test, type Page } from '@playwright/test';
import { createAdjustment } from '../../src/shared/grade.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { expandedInspectorPreferences, inspectorTab } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let document: ProjectDocument;

const current = (page: Page): Promise<ProjectDocument> => page.evaluate(() => window.pascapLab!.project()!);
const inspector = (page: Page) => page.locator('#inspector-pane [role="tabpanel"]:not([hidden])');

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()))
    .toMatchObject({ status: 'paused', frame });
}

async function checksum(page: Page, frame: number): Promise<number> {
  await seek(page, frame);
  return page.evaluate(() => {
    const bytes = window.pascapLab!.engine.capturePixels();
    let sum = 2_166_136_261;
    for (let index = 0; index < bytes.length; index++) sum = Math.imul(sum ^ bytes[index]!, 16_777_619) >>> 0;
    return sum;
  });
}

test.beforeEach(async ({ page, request }) => {
  const assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const asset = assets.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready');
  if (!asset) throw new Error('Prepared synthetic video required.');
  document = createProject('adjustments-memory', 'Adjustments · memory only');
  document.media.videoIds = [asset.id];
  document.clips = [createClip('one', asset.id, 0, 40), { ...createClip('two', asset.id, 40, 80), start: 40 }];
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await inspectorTab(page, 'Colour');
});

test('an adjustment created over a clip grades only its range, refuses an overlap and undoes in one step', async ({
  page,
}) => {
  const before = { inside: await checksum(page, 10), after: await checksum(page, 60) };
  await page.locator('[data-clip-id="one"]').click();
  await seek(page, 10);
  const add = page.getByRole('button', { name: 'Add adjustment', exact: true });
  await expect(add).toHaveAttribute('title', 'Add an adjustment over the selected clip, 00:00:00 – 00:01:10');
  await add.click();
  await expect(inspector(page).locator('.colour-target')).toContainText('Adjustment 00:00:00 – 00:01:10');
  await expect.poll(async () => (await current(page)).adjustments).toMatchObject([{ start: 0, duration: 40 }]);

  const saturation = page.getByRole('spinbutton', { name: 'Saturation', exact: true });
  await saturation.fill('0');
  await saturation.press('Enter');
  await expect.poll(async () => (await current(page)).adjustments[0]!.colour.saturation).toBe(0);
  const edited = await current(page);
  expect(edited.layers).toEqual(document.layers);
  expect(edited.clips.map((clip) => clip.grade)).toEqual(document.clips.map((clip) => clip.grade));
  // It grades the clip within its range and leaves the next clip as it was.
  await expect.poll(() => checksum(page, 10)).not.toBe(before.inside);
  expect(await checksum(page, 60)).toBe(before.after);

  // The clip's span is taken: a second adjustment over it is refused with the reason.
  await seek(page, 10);
  await inspector(page).getByRole('button', { name: 'Delete adjustment' }).click();
  await expect.poll(async () => (await current(page)).adjustments).toEqual([]);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await current(page)).adjustments).toHaveLength(1);
  await page.locator('[data-clip-id="one"]').click();
  await expect(add).toHaveAttribute('title', /Adjustments cannot overlap/);
  await add.dispatchEvent('click');
  expect((await current(page)).adjustments).toHaveLength(1);
});

test('Original with Alt bypasses adjustments only, and with Shift clip grades only', async ({ page }) => {
  const look = createAdjustment('look', 0, 80);
  look.colour.saturation = 0;
  const start = await current(page);
  await page.evaluate((next) => window.pascapLab!.setDocument(next), { ...start, adjustments: [look] });
  await expect.poll(async () => (await current(page)).adjustments).toHaveLength(1);
  await seek(page, 10);
  const original = page.locator('.preview-heading').getByRole('button', { name: 'Show original preview', exact: true });
  for (const [key, mode] of [
    ['Alt', 'adjustment'],
    ['Shift', 'clip'],
  ] as const) {
    await original.hover();
    await page.keyboard.down(key);
    await page.mouse.down();
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().original)).toBe(mode);
    await page.mouse.up();
    await page.keyboard.up(key);
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().original)).toBeNull();
  }
  await expect.poll(() => memory.saves).toBe(1);
});
