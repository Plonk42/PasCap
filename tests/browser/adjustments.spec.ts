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
  await inspectorTab(page, 'Color');
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
  await expect(inspector(page).locator('.color-target')).toContainText('Adjustment 00:00:00 – 00:01:10');
  await expect.poll(async () => (await current(page)).adjustments).toMatchObject([{ start: 0, duration: 40 }]);

  const saturation = page.getByRole('spinbutton', { name: 'Saturation', exact: true });
  await saturation.fill('0');
  await saturation.press('Enter');
  await expect.poll(async () => (await current(page)).adjustments[0]!.color.saturation).toBe(0);
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
  look.color.saturation = 0;
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

test('an eye turns one adjustment or all of them off and on, one Undo step each, keeping them editable', async ({
  page,
}) => {
  const plain = { one: await checksum(page, 10), two: await checksum(page, 60) };
  const gray = createAdjustment('gray', 0, 40);
  gray.color.saturation = 0;
  const dark = createAdjustment('dark', 40, 40);
  dark.color.exposure = -1;
  await page.evaluate((next) => window.pascapLab!.setDocument(next), {
    ...(await current(page)),
    adjustments: [gray, dark],
  });
  await page.getByRole('slider', { name: 'Timeline zoom' }).fill('180');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const graded = { one: await checksum(page, 10), two: await checksum(page, 60) };
  expect(graded.one).not.toBe(plain.one);
  expect(graded.two).not.toBe(plain.two);
  const enabled = async () => (await current(page)).adjustments.map((item) => item.enabled);
  const item = page.locator('.adjustment-item[data-adjustment-id="gray"]');
  const all = page.locator('.layer-sidebar-adjustments .adjustments-eye');
  await expect(all).toHaveAttribute('data-state', 'on');

  await item.getByRole('button', { name: 'Turn off adjustment 00:00:00 – 00:01:10', exact: true }).click();
  await expect.poll(enabled).toEqual([false, true]);
  await expect(item).toHaveClass(/\boff\b/);
  await expect(all).toHaveAttribute('data-state', 'mixed');
  await expect(all).toHaveAccessibleName('Turn on all adjustments');
  await expect.poll(() => checksum(page, 10)).toBe(plain.one);
  expect(await checksum(page, 60)).toBe(graded.two);

  // Its Color tab says it is off and still edits it.
  await item.locator('.adjustment-body').click();
  await expect(inspector(page).locator('.color-target')).toContainText('Turned off: grades nothing');
  const saturation = page.getByRole('spinbutton', { name: 'Saturation', exact: true });
  await saturation.fill('0.5');
  await saturation.press('Enter');
  await expect
    .poll(async () => (await current(page)).adjustments[0])
    .toMatchObject({
      enabled: false,
      color: { saturation: 0.5 },
    });
  expect(await checksum(page, 10)).toBe(plain.one);
  await undo.click();
  await expect.poll(async () => (await current(page)).adjustments[0]!.color.saturation).toBe(0);
  await inspector(page).getByRole('button', { name: 'Turn on adjustment', exact: true }).click();
  await expect.poll(enabled).toEqual([true, true]);
  await expect(item).not.toHaveClass(/\boff\b/);
  // So does its menu, where the item is too short for its eye.
  await item.locator('.adjustment-body').click({ button: 'right' });
  await page.getByRole('button', { name: 'Turn off this adjustment', exact: true }).click();
  await expect.poll(enabled).toEqual([false, true]);
  await undo.click();
  await expect.poll(enabled).toEqual([true, true]);

  // The header turns every adjustment off, then on, in one step each.
  await all.click();
  await expect.poll(enabled).toEqual([false, false]);
  await expect(all).toHaveAttribute('data-state', 'off');
  await expect.poll(() => checksum(page, 60)).toBe(plain.two);
  expect(await checksum(page, 10)).toBe(plain.one);
  await all.click();
  await expect.poll(enabled).toEqual([true, true]);
  await expect.poll(() => checksum(page, 10)).toBe(graded.one);
  await undo.click();
  await expect.poll(enabled).toEqual([false, false]);
  await undo.click();
  await expect.poll(enabled).toEqual([true, true]);
});
