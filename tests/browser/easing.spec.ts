import { expect, test, type Page } from '@playwright/test';
import { clipSpeedPreset } from '../../src/shared/clip-speed.js';
import { interpolatedProgress, interpolationSchema } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { editLayerPoint, expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects } from './memory-projects.js';

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

for (const context of ['shared', 'clip'] as const) {
  test(`${context} easing graphs keep native selection, exact shapes and one-step Undo in the 270px Inspector`, async ({
    page,
    request,
  }) => {
    const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
    const asset = library.assets.find(
      (item) => item.name === 'pattern-a.mp4' && item.status === 'ready' && item.prepared,
    );
    if (!asset) throw new Error('Prepared synthetic fixture required; real-media work is not allowed.');
    const document = createProject(`easing-${context}`, 'Easing · memory-only');
    document.media.videoIds = [asset.id];
    const clip = createClip('excerpt', asset.id, 0, 120);
    if (context === 'clip') clip.speed = clipSpeedPreset(clip, 'flat');
    document.clips = [clip];
    document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0.2, opacity: 0.4 }, 'smooth')];
    const unexpected: string[] = [];
    const reads: Record<string, unknown> = {
      '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
      '/api/media': { assets: [asset] },
      '/api/audio': { assets: [] },
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
    if (context === 'shared') await editLayerPoint(page, 'Video track 1', 10);
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
    expect(before.schemaVersion).toBe(13);
    expect(before.layers[0]!.opacity).toBe(1);
    expect(before.clips[0]).not.toHaveProperty('opacity');
    expect(Object.keys(before.layers[0]!.keyframes[0]!.values)).toHaveLength(10);
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
      if (context === 'shared') expected.layers[0]!.keyframes[0]!.interpolation = value;
      else if (context === 'clip' && expected.clips[0]!.speed.mode === 'curve')
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
