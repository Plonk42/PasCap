import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { applyCommand } from '../../src/shared/commands.js';
import { NEUTRAL_DETAIL } from '../../src/shared/detail.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { inspectorTab, resetSetting } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  unexpected = [];
  const { assets } = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const asset = assets.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready' && item.prepared);
  if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/pattern-a.mp4'))
    throw new Error('Detail tests require the prepared synthetic pattern; no real-media work.');
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets: [asset] },
    '/api/audio': { assets: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) return route.fulfill({ json: reads[pathname] });
    if (method === 'GET' && new RegExp(`^/api/media/${asset.id}/(proxy|thumbnail/\\d+)$`).test(pathname))
      return route.continue();
    unexpected.push(`${method} ${pathname}`);
    return route.abort('blockedbyclient');
  });
  let document = createProject('detail-memory', 'Detail · memory-only');
  document.media.videoIds = [asset.id];
  document = applyCommand(document, { type: 'insert', clip: createClip('first', asset.id, 0, 40), index: 0 });
  document = applyCommand(document, { type: 'insert', clip: createClip('second', asset.id, 40, 80), index: 1 });
  memory = await memoryProjects(page, document);
});

async function openEditor(page: Page, detailOpen: boolean): Promise<void> {
  if (detailOpen) await page.addInitScript(() => localStorage.setItem('pascap-section-detail', 'open'));
  await page.goto('/?project=detail-memory');
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await page.getByRole('button', { name: /^Select pattern-a\.mp4, clip 1/ }).click();
  await inspectorTab(page, 'Clip');
}

test.afterEach(() => {
  expect(unexpected).toEqual([]);
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function checksum(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bytes = window.pascapLab!.engine.capturePixels();
    let sum = 2_166_136_261;
    for (let index = 0; index < bytes.length; index++) sum = Math.imul(sum ^ bytes[index]!, 16_777_619) >>> 0;
    return sum;
  });
}

const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });

test('a Detail slider drag previews live without a document, history or save change; Escape restores, release commits once', async ({
  page,
}) => {
  await openEditor(page, true);
  const before = await current(page);
  const plain = await checksum(page);
  const slider = page.getByRole('slider', { name: 'Clip Sharpen', exact: true });
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const drag = async (): Promise<void> => {
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 4 });
  };
  await drag();
  await expect.poll(() => checksum(page)).not.toBe(plain);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(undo(page)).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => checksum(page)).toBe(plain);
  expect(await current(page)).toEqual(before);
  await expect(undo(page)).toBeDisabled();

  await drag();
  await expect.poll(() => checksum(page)).not.toBe(plain);
  const previewed = await checksum(page);
  await page.mouse.up();
  const after = await current(page);
  expect(after.clips[0]!.detail.sharpen).toBeGreaterThan(0.5);
  expect(after.clips[1]!.detail).toEqual(NEUTRAL_DETAIL);
  expect(after.layers).toEqual(before.layers);
  await expect.poll(() => checksum(page)).toBe(previewed);
  await undo(page).click();
  expect(await current(page)).toEqual(before);
  await expect.poll(() => checksum(page)).toBe(plain);
});

test('exact fields reject invalid drafts, names reset one setting, Reset detail and Compare bypass the filters', async ({
  page,
}) => {
  await openEditor(page, true);
  const before = await current(page);
  const plain = await checksum(page);
  const sharpen = page.getByRole('spinbutton', { name: 'Clip Sharpen', exact: true });
  await sharpen.fill('1.5');
  await sharpen.press('Enter');
  await expect(sharpen).toHaveAttribute('aria-invalid', 'true');
  expect(await current(page)).toEqual(before);
  await sharpen.press('Escape');
  await expect(sharpen).toHaveValue('0');
  for (const [name, value] of [
    ['Clip Sharpen', '0.75'],
    ['Clip Clarity', '-0.4'],
    ['Clip Denoise', '0.3'],
  ] as const) {
    const field = page.getByRole('spinbutton', { name, exact: true });
    await field.fill(value);
    await field.press('Enter');
  }
  await expect
    .poll(async () => (await current(page)).clips[0]!.detail)
    .toEqual({
      sharpen: 0.75,
      clarity: -0.4,
      denoise: 0.3,
    });
  const filtered = await checksum(page);
  expect(filtered).not.toBe(plain);
  await page.getByRole('button', { name: 'Show ungraded preview' }).click();
  await expect.poll(() => checksum(page)).toBe(plain);
  await page.getByRole('button', { name: 'Show ungraded preview' }).click();
  await expect.poll(() => checksum(page)).toBe(filtered);

  await resetSetting(page, 'Clip Clarity');
  await expect
    .poll(async () => (await current(page)).clips[0]!.detail)
    .toEqual({
      sharpen: 0.75,
      clarity: 0,
      denoise: 0.3,
    });
  await page.getByRole('button', { name: 'Reset detail', exact: true }).click();
  await expect.poll(async () => (await current(page)).clips[0]!.detail).toEqual(NEUTRAL_DETAIL);
  await expect(page.getByRole('button', { name: 'Reset detail', exact: true })).toBeDisabled();
  await expect.poll(() => checksum(page)).toBe(plain);
  await undo(page).click();
  await expect
    .poll(async () => (await current(page)).clips[0]!.detail)
    .toEqual({
      sharpen: 0.75,
      clarity: 0,
      denoise: 0.3,
    });
});

test('Detail is a Clip section, collapsed by default and included in Expand all', async ({ page }) => {
  await openEditor(page, false);
  const section = page.getByRole('button', { name: 'Detail section', exact: true });
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Detail help', exact: true })).toBeVisible();
  const expand = page.getByRole('button', { name: 'Expand all Clip sections', exact: true });
  await expand.click();
  await expect(section).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('slider', { name: 'Clip Denoise', exact: true })).toBeVisible();
});
