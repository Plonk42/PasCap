import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { expandedInspectorPreferences, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let unexpected: string[];
async function current(page: Page): Promise<ProjectDocument> {
  return page.evaluate(() => window.pascapLab!.project()!);
}
test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const asset = assets.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready');
  expect(asset?.sourcePath).toBe(path.resolve('.pascap/browser-tests/synthetic-sources/pattern-a.mp4'));
  if (!asset) throw new Error('Prepared synthetic video required.');
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('advanced-memory', 'Advanced colour · memory only');
  document.media.videoIds = [asset.id];
  document.clips = [createClip('one', asset.id, 0, 120)];
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeEnabled();
});
test.afterEach(() => expect(unexpected).toEqual([]));

test('static HSL exact entry, invalid drafts, keyboard, range reset and Undo', async ({ page }) => {
  await expect(page.getByRole('combobox', { name: 'HSL range' })).toBeHidden();
  await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toBeVisible();
  await page
    .getByText('HSL ranges', { exact: false })
    .filter({ has: page.locator('small') })
    .click();
  await page.getByRole('combobox', { name: 'HSL range' }).selectOption('cyan');
  const field = page.getByRole('spinbutton', { name: 'HSL hue', exact: true });
  await field.fill('12.3456789');
  await field.press('Enter');
  await expect.poll(async () => (await current(page)).layers[0]!.colour.hsl.cyan.hue).toBe(12.3456789);
  await field.fill('31');
  await field.press('Enter');
  await expect(field).toHaveValue('31');
  expect((await current(page)).layers[0]!.colour.hsl.cyan.hue).toBe(12.3456789);
  await field.press('Escape');
  await expect(field).toHaveValue('12.3456789');
  await page.getByRole('button', { name: 'Reset HSL range', exact: true }).click();
  await expect.poll(async () => (await current(page)).layers[0]!.colour.hsl.cyan.hue).toBe(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('12.3456789');
  await page.getByRole('slider', { name: 'HSL saturation', exact: true }).press('ArrowRight');
  await expect.poll(async () => (await current(page)).layers[0]!.colour.hsl.cyan.saturation).toBe(0.01);
});

test('curve endpoints, exact collisions, nonmonotonic values, maximum points and reset', async ({ page }) => {
  await page.locator('.advanced-colour details').nth(1).locator('summary').click();
  const input = page.getByRole('spinbutton', { name: 'Colour curve input', exact: true });
  const output = page.getByRole('spinbutton', { name: 'Colour curve output', exact: true });
  await expect(input).toBeDisabled();
  await output.fill('0.8');
  await output.press('Enter');
  await page.getByRole('button', { name: 'Add colour curve point', exact: true }).click();
  await expect(input).toHaveValue('0.5');
  await output.fill('0.123456789');
  await output.press('Enter');
  await input.fill('1');
  await input.press('Enter');
  await expect(input).toHaveValue('1');
  expect((await current(page)).layers[0]!.colour.curves.master[1]!.x).toBe(0.5);
  await input.press('Escape');
  for (let i = 3; i < 16; i++) await page.getByRole('button', { name: 'Add colour curve point', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add colour curve point', exact: true })).toBeDisabled();
  expect((await current(page)).layers[0]!.colour.curves.master).toHaveLength(16);
  await page.getByRole('button', { name: 'Reset colour curve channel', exact: true }).click();
  await expect
    .poll(async () => (await current(page)).layers[0]!.colour.curves.master)
    .toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
});

test('captured curve drafts cancel, reject the final invalid destination and commit once with Undo', async ({
  page,
}) => {
  await page.locator('.advanced-colour details').nth(1).locator('summary').click();
  await page.getByRole('button', { name: 'Add colour curve point', exact: true }).click();
  await expect.poll(() => memory.saves).toBe(1);
  const original = (await current(page)).layers[0]!.colour.curves.master;
  const point = page.getByRole('button', { name: 'Colour curve point 2', exact: true });
  const box = await point.boundingBox();
  if (!box) throw new Error('Curve point not visible.');
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 15, y - 15);
  expect(memory.saves).toBe(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await current(page)).layers[0]!.colour.curves.master).toEqual(original);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y - 10);
  await page.mouse.move(x + 400, y - 10);
  await expect(page.locator('.colour-curve-plot')).toHaveClass(/invalid/);
  await page.mouse.up();
  expect((await current(page)).layers[0]!.colour.curves.master).toEqual(original);
  expect(memory.saves).toBe(1);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 15, y - 15);
  await page.mouse.up();
  await expect.poll(() => memory.saves).toBe(2);
  expect((await current(page)).layers[0]!.colour.curves.master).not.toEqual(original);
  await point.focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await current(page)).layers[0]!.colour.curves.master).toEqual(original);
  await expect(point).toBeFocused();
});

test('scalar keys do not disable static HSL or curves and Reset keys preserves their row base', async ({ page }) => {
  const document = memory.snapshot();
  document.layers[0]!.keyframes = [sharedPoint(0, { exposure: 0.4 })];
  document.layers[0]!.colour.hsl.red.hue = 7;
  document.layers[0]!.colour.curves.master[0]!.y = 0.05;
  memory.seed(document);
  await page.reload();
  await page.locator('.advanced-colour details').nth(0).locator('summary').click();
  await expect(page.getByRole('slider', { name: 'HSL hue', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reset colour', exact: true }).click();
  await expect.poll(async () => (await current(page)).layers[0]!.keyframes[0]!.values.exposure).toBe(0);
  expect((await current(page)).layers[0]!.colour.hsl.red.hue).toBe(7);
  expect((await current(page)).layers[0]!.colour.curves.master[0]!.y).toBe(0.05);
});

for (const cancellation of ['pointercancel', 'lostcapture', 'windowblur'] as const) {
  test(`curve ${cancellation} restores captured points without a draft save`, async ({ page }) => {
    await page.locator('.advanced-colour details').nth(1).locator('summary').click();
    await page.getByRole('button', { name: 'Add colour curve point', exact: true }).click();
    await expect.poll(() => memory.saves).toBe(1);
    const original = (await current(page)).layers[0]!.colour.curves.master;
    const point = page.getByRole('button', { name: 'Colour curve point 2', exact: true });
    const box = await point.boundingBox();
    if (!box) throw new Error('Visible point required.');
    await point.evaluate((element) =>
      element.addEventListener(
        'pointerdown',
        (event) => {
          element.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId));
        },
        { once: true },
      ),
    );
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 - 15);
    if (cancellation === 'windowblur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else if (cancellation === 'lostcapture')
      await point.evaluate((element) =>
        element.releasePointerCapture(Number(element.getAttribute('data-test-pointer'))),
      );
    else await point.dispatchEvent('pointercancel');
    await page.mouse.up();
    expect((await current(page)).layers[0]!.colour.curves.master).toEqual(original);
    expect(memory.saves).toBe(1);
    await expect(page.getByRole('button', { name: 'Add colour curve point', exact: true })).toBeEnabled();
  });
}

test('advanced row settings survive same-row clip selection; empty-row selection cannot apply an old invalid draft', async ({
  page,
}) => {
  const document = memory.snapshot();
  const second = { ...createClip('two', document.clips[0]!.mediaId, 0, 120), start: 120 };
  document.clips.push(second);
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  document.layers.push(createLayer('empty', 'Empty advanced row'));
  memory.seed(document);
  await page.reload();
  await page.locator('.advanced-colour details').first().locator('summary').click();
  const field = page.getByRole('spinbutton', { name: 'HSL hue', exact: true });
  await field.fill('7.123456789');
  await field.press('Enter');
  await page.locator('[data-clip-id="two"] .timeline-clip-body').click();
  await expect(field).toHaveValue('7.123456789');
  await field.fill('31');
  await field.press('Enter');
  await page.getByRole('button', { name: 'Select layer Empty advanced row', exact: true }).click();
  await page.locator('.advanced-colour details').first().locator('summary').click();
  await expect(field).toHaveValue('0');
  await expect(field).toBeEnabled();
  await field.fill('-4.23456789');
  await field.press('Enter');
  const changed = await current(page);
  expect(changed.layers[0]!.colour.hsl.red.hue).toBe(7.123456789);
  expect(changed.layers[1]!.colour.hsl.red.hue).toBe(-4.23456789);
  expect(changed.clips).toEqual(document.clips);
});
