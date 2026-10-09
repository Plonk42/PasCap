import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  unexpected = [];
  const { assets } = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const asset = assets.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready' && item.prepared);
  if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/pattern-a.mp4'))
    throw new Error('Live preview tests require the prepared synthetic pattern; no real-media work.');
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
  let document = createProject('colour-live-memory', 'Colour live preview · memory-only');
  document.media.videoIds = [asset.id];
  document = applyCommand(document, { type: 'insert', clip: createClip('first', asset.id, 0, 40), index: 0 });
  document = applyCommand(document, { type: 'insert', clip: createClip('second', asset.id, 40, 80), index: 1 });
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
});

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

async function dragSlider(page: Page, name: string, fraction: number) {
  const slider = page.getByRole('slider', { name, exact: true });
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2, { steps: 4 });
  return slider;
}

test('a Colour slider drag previews the value without a document, history or save change, and Escape restores it', async ({
  page,
}) => {
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await inspectorTab(page, 'Track');
  const before = await current(page);
  const graded = await checksum(page);
  await dragSlider(page, 'Exposure', 0.9);
  await expect.poll(() => checksum(page)).not.toBe(graded);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => checksum(page)).toBe(graded);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('releasing the drag commits one Undo step and the preview stays on the committed value', async ({ page }) => {
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await inspectorTab(page, 'Track');
  const before = await current(page);
  const graded = await checksum(page);
  await dragSlider(page, 'Exposure', 0.9);
  await expect.poll(() => checksum(page)).not.toBe(graded);
  const previewed = await checksum(page);
  await page.mouse.up();
  const after = await current(page);
  expect(after.layers[0]!.colour.exposure).toBeGreaterThan(0);
  expect(after.layers[0]!.keyframes).toEqual(before.layers[0]!.keyframes);
  await expect.poll(() => checksum(page)).toBe(previewed);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect.poll(() => checksum(page)).toBe(graded);
});

test('a locked animated slider neither previews nor creates a keyframe', async ({ page }) => {
  const document = await current(page);
  document.layers[0]!.keyframes = [sharedPoint(30, { exposure: 0 })];
  memory.seed(document);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await inspectorTab(page, 'Track');
  const graded = await checksum(page);
  const slider = page.getByRole('slider', { name: 'Exposure', exact: true });
  await expect(slider).toBeDisabled();
  const box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  expect(await checksum(page)).toBe(graded);
  expect(await current(page)).toEqual(document);
  expect(memory.saves).toBe(0);
});

test('Colour offers to move a clip to its own track, once, from the hint and the clip menu', async ({ page }) => {
  await inspectorTab(page, 'Track');
  const before = await current(page);
  await expect(page.locator('.colour-scope-hint')).toContainText('Grades all 2 clips on Video track 1');
  await page.getByRole('button', { name: 'Move clip to its own track', exact: true }).click();
  const moved = await current(page);
  expect(moved.layers).toHaveLength(2);
  const layout = calculateLayout(moved);
  const first = layout.clips.find((item) => item.clip.id === 'first')!;
  expect(first.clip.layerId).toBe(moved.layers[1]!.id);
  expect(first.start).toBe(0);
  await expect(page.locator('.colour-scope-hint')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await page.locator('[data-clip-id="second"]').click({ button: 'right' });
  const item = page.getByRole('button', { name: 'Move selected clip to a new track', exact: true });
  await expect(item).toBeVisible();
  await item.click();
  const again = await current(page);
  expect(again.layers).toHaveLength(2);
  expect(again.clips.find((clip) => clip.id === 'second')!.layerId).toBe(again.layers[1]!.id);
  expect(memory.saves).toBeLessThanOrEqual(2);
});
