import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { clipSpeedPreset } from '../../src/shared/clip-speed.js';
import { interpolatedProgress, interpolationSchema, uniformKeyframe } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import {
  createClip,
  createProject,
  projectSchema,
  type ProjectDocument,
  type VideoClip,
} from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { editLayerPoint, expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects } from './memory-projects.js';

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

/** A memory-only one-clip project at the 270px Inspector minimum, blocking every write route. */
async function openMemoryProject(
  page: Page,
  request: APIRequestContext,
  id: string,
  configure: (document: ProjectDocument, clip: VideoClip) => void,
) {
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const asset = library.assets.find(
    (item) => item.name === 'pattern-a.mp4' && item.status === 'ready' && item.prepared,
  );
  if (!asset) throw new Error('Prepared synthetic fixture required; real-media work is not allowed.');
  const document = createProject(id, 'Easing · memory-only');
  document.media.videoIds = [asset.id];
  const clip = createClip('excerpt', asset.id, 0, 120);
  document.clips = [clip];
  configure(document, clip);
  const unexpected: string[] = [];
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets: [asset], missing: [] },
    '/api/audio': { assets: [], missing: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    if (route.request().method() === 'GET' && pathname.startsWith(`/api/media/${asset.id}/`)) {
      await route.continue();
      return;
    }
    unexpected.push(`${route.request().method()} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      'pascap-workspace-layout',
      JSON.stringify({
        mediaWidth: 300,
        inspectorWidth: 270,
        timelineHeight: 290,
        mediaOpen: true,
        inspectorOpen: true,
      }),
    ),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/?project=${document.id}`);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  return { memory, unexpected };
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
}

test('a default keyframe returns settings to their defaults from its frame, in one Undo step', async ({
  page,
  request,
}) => {
  const { unexpected } = await openMemoryProject(page, request, 'easing-default-keyframe', (document) => {
    document.layers[0]!.colour.contrast = 1.4;
    document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0.6 })];
  });
  await inspectorTab(page, 'Track');
  const contrast = page.getByRole('spinbutton', { name: 'Contrast', exact: true });
  await seek(page, 60);
  const before = await current(page);
  const add = page.getByRole('button', { name: 'Add default keyframe', exact: true });
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await add.click();
  const remove = page.getByRole('button', { name: 'Remove default keyframe', exact: true });
  await expect(remove).toHaveAttribute('aria-pressed', 'true');
  const added = await current(page);
  expect(added.layers[0]!.keyframes[1]).toMatchObject({ frame: 60, reset: true, values: { contrast: 1, opacity: 1 } });
  expect(new Set(Object.values(added.layers[0]!.keyframes[1]!.easing))).toEqual(new Set(['hold']));
  const marker = page.getByRole('button', { name: 'Track keyframe 60 on Track 1 (default)', exact: true });
  await expect(marker).toHaveClass(/\breset\b/);
  await expect(contrast).toHaveValue('1');
  // Earlier frames keep the saved Contrast.
  await seek(page, 30);
  await expect(contrast).toHaveValue('1.4');
  // Another keyframe at the playhead blocks a default keyframe there.
  await seek(page, 10);
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await add.focus();
  await add.press('Enter');
  expect(await current(page)).toEqual(added);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  expect(await current(page)).toEqual(before);
  await expect(undo).toBeDisabled();
  expect(unexpected).toEqual([]);
});

test('per-setting Easing appears only on request or when settings differ, each change one Undo step', async ({
  page,
  request,
}) => {
  const { unexpected } = await openMemoryProject(page, request, 'easing-per-setting', (document) => {
    document.layers[0]!.keyframes = [
      sharedPoint(10, { exposure: 0.2, opacity: 0.4 }),
      sharedPoint(40, { exposure: 0.6, opacity: 0.8 }),
      sharedPoint(70, { hue: 20 }),
    ];
  });
  await editLayerPoint(page, 'Track 1', 70);
  // A keyframe with one setting has nothing to split.
  await expect(page.getByRole('button', { name: 'Easing per setting · Track keyframe easing 70' })).toHaveCount(0);
  await editLayerPoint(page, 'Track 1', 10);
  const all = page.getByRole('combobox', { name: 'Track keyframe easing 10', exact: true });
  const toggle = page.getByRole('button', { name: 'Easing per setting · Track keyframe easing 10', exact: true });
  const exposure = page.getByRole('combobox', { name: 'Exposure easing at track keyframe 10', exact: true });
  const opacity = page.getByRole('combobox', { name: 'Opacity easing at track keyframe 10', exact: true });
  await expect(all).toHaveValue('linear');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(exposure).toHaveCount(0);
  const before = await current(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await exposure.selectOption('hold');
  const mixed = await current(page);
  expect(mixed.layers[0]!.keyframes[0]!.easing).toEqual({
    ...before.layers[0]!.keyframes[0]!.easing,
    exposure: 'hold',
  });
  expect(mixed.layers[0]!.keyframes.slice(1)).toEqual(before.layers[0]!.keyframes.slice(1));
  // Differing settings read Mixed and keep their choices visible.
  await expect(all).toHaveValue('');
  await expect(all.locator('option:checked')).toHaveText('Mixed');
  await expect(toggle).toHaveCount(0);
  await expect(opacity).toHaveValue('linear');
  await all.focus();
  await all.selectOption('smooth');
  expect((await current(page)).layers[0]!.keyframes[0]!.easing).toMatchObject({
    exposure: 'smooth',
    opacity: 'smooth',
  });
  await expect(all).toBeFocused();
  // The list was opened explicitly, so it stays open until closed.
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(exposure).toHaveValue('smooth');
  await toggle.click();
  await expect(exposure).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  expect(await current(page)).toEqual(mixed);
  // Differing settings reveal their choices by themselves, and hide them again once they agree.
  await expect(exposure).toHaveValue('hold');
  await expect(toggle).toHaveCount(0);
  await undo.click();
  expect(await current(page)).toEqual(before);
  await expect(exposure).toHaveCount(0);
  await expect(undo).toBeDisabled();
  const bounds = (await all.locator('xpath=ancestor::li[1]').boundingBox())!;
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(unexpected).toEqual([]);
});

for (const context of ['shared', 'clip'] as const) {
  test(`${context} easing graphs keep native selection, exact shapes and one-step Undo in the 270px Inspector`, async ({
    page,
    request,
  }) => {
    const { memory, unexpected } = await openMemoryProject(page, request, `easing-${context}`, (document, clip) => {
      if (context === 'clip') clip.speed = clipSpeedPreset(clip, 'flat');
      document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0.2, opacity: 0.4 }, 'smooth')];
    });
    if (context === 'shared') await editLayerPoint(page, 'Track 1', 10);
    else await inspectorTab(page, 'Clip');
    const label = context === 'shared' ? 'Track keyframe easing 10' : 'Clip speed keyframe easing';
    const select = page.getByRole('combobox', { name: label, exact: true });
    const choice = select.locator('..');
    const graph = choice.locator('.easing-graph');
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute('aria-hidden', 'true');
    await expect(graph).toHaveAttribute('focusable', 'false');
    await expect(graph).not.toHaveAttribute('tabindex');
    await expect(select).toHaveAccessibleDescription(
      /Graph: time runs left to right; value progress runs bottom to top/,
    );
    const before = await current(page);
    expect(before.schemaVersion).toBe(18);
    expect(before.layers[0]!.opacity).toBe(1);
    expect(before.clips[0]).not.toHaveProperty('opacity');
    expect(Object.keys(before.layers[0]!.keyframes[0]!.values)).toHaveLength(11);
    const initialValue = (await select.inputValue())!;
    expect(memory.saves).toBe(0);
    for (const value of interpolationSchema.options) {
      await select.selectOption(value);
      const expectedPoints = Array.from(
        { length: 33 },
        (_, index) => `${6 + (index / 32) * 84},${50 - interpolatedProgress(index / 32, value) * 44}`,
      );
      if (value === 'hold') expectedPoints.push('90,6');
      await expect(choice).toHaveAttribute('data-easing', value);
      await expect(graph.locator('polyline')).toHaveAttribute('points', expectedPoints.join(' '));
      const expected = structuredClone(before);
      if (context === 'shared') {
        const point = expected.layers[0]!.keyframes[0]!;
        point.easing = uniformKeyframe(point.frame, point.values, value).easing;
      } else if (context === 'clip' && expected.clips[0]!.speed.mode === 'curve')
        expected.clips[0]!.speed.keyframes[0]!.interpolation = value;
      expect(await current(page)).toEqual(expected);
      if (value !== initialValue) await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(await current(page)).toEqual(before);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    }
    // Native keyboard selection retains focus and adds exactly one history step.
    await select.focus();
    await select.press('Home');
    await expect(select).toBeFocused();
    await expect(select).toHaveValue('hold');
    await expect(choice).toHaveAttribute('data-easing', 'hold');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await current(page)).toEqual(before);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('slider', { name: 'Resize Clip panel', exact: true })).toHaveAttribute(
      'aria-valuenow',
      '270',
    );
    await select.scrollIntoViewIfNeeded();
    const bounds = (await choice.boundingBox())!;
    const panel = page.getByRole('complementary', { name: 'Clip inspector', exact: true });
    const panelBounds = (await panel.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(270);
    expect(bounds.x).toBeGreaterThanOrEqual(panelBounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(panelBounds.x + panelBounds.width);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
    expect(await choice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(unexpected).toEqual([]);
    expect(calculateLayout(await current(page)).duration).toBe(calculateLayout(before).duration);
  });
}
