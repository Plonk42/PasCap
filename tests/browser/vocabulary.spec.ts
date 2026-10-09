import { expect, test } from '@playwright/test';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { expandedInspectorPreferences, inspectorTab, openOptions, sharedPoint } from './editor-helpers.js';
import { memoryProjects } from './memory-projects.js';

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`one glossary names files, instances, tracks, animation and ranges at ${viewport.width}×${viewport.height}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const response = await request.get('/api/media');
    expect(response.ok()).toBe(true);
    const { assets } = (await response.json()) as { assets: MediaAsset[] };
    const recording = assets.find((asset) => asset.name === 'pattern-a.mp4' && asset.status === 'ready');
    expect(recording?.prepared).not.toBeNull();
    if (!recording?.prepared) throw new Error('The glossary check requires the prepared synthetic recording.');
    const project = createProject('preview-lab', 'Editor vocabulary · memory-only');
    project.media.videoIds = [recording.id];
    project.clips = [createClip('clip', recording.id, 0, 90)];
    project.layers[0]!.keyframes = [sharedPoint(0, { exposure: 0 }), sharedPoint(30, { exposure: 0.5 })];
    const unexpected: string[] = [];
    await page.route('**/api/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const payloads: Record<string, unknown> = {
        '/api/health': {
          name: 'PasCap',
          milestone: 'editing-and-export',
          frameRate: '30000/1001',
          workerConcurrency: 1,
        },
        '/api/media': { assets: [recording] },
        '/api/audio': { assets: [] },
        '/api/jobs': { jobs: [] },
      };
      if (route.request().method() === 'GET' && payloads[pathname]) {
        await route.fulfill({ json: payloads[pathname] });
      } else if (route.request().method() === 'GET' && pathname.startsWith(`/api/media/${recording.id}/`)) {
        await route.continue();
      } else {
        unexpected.push(`${route.request().method()} ${pathname}`);
        await route.abort('blockedbyclient');
      }
    });
    const memory = await memoryProjects(page, project);
    await expandedInspectorPreferences(page);
    await page.goto('/?project=preview-lab');
    await expect(page.getByRole('button', { name: 'Select track Video track 1', exact: true })).toBeEnabled();
    const tracks = page.getByRole('complementary', { name: 'Video tracks', exact: true });
    await expect(tracks.locator('.layer-sidebar-heading')).toHaveText('Video tracks · 1 / 8');
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
    expect(await page.locator('.layer-select').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expect(page.getByRole('button', { name: 'Add video track', exact: true })).toHaveText('Track');
    await expect(page.locator('.media-usage-badge')).toHaveText('1 clip');

    await openOptions(page, 'Track options Video track 1');
    await expect(page.getByRole('textbox', { name: 'Rename track Video track 1', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await inspectorTab(page, 'Track');
    await expect(page.getByRole('group', { name: 'Track keyframes Video track 1', exact: true })).toBeAttached();
    await expect(page.getByRole('button', { name: 'Delete track keyframe 30', exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'Colour animation help', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.editor-help-content:popover-open')).toContainText('track');
    await page.keyboard.press('Escape');
    await page
      .getByText('Colour curves', { exact: false })
      .filter({ has: page.locator('small') })
      .click();
    await expect(page.getByRole('combobox', { name: 'Selected colour curve control node', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete colour curve control node', exact: true })).toBeDisabled();

    await inspectorTab(page, 'Clip');
    await expect(page.getByRole('button', { name: 'Range section', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Keyframe Scale', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Selected Transform keyframe', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview selected Transform keyframe', exact: true })).toHaveText(
      'Preview stored keyframe',
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Selected Transform keyframe', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Add clip \d+\.\d{2} s to timeline$/ })).toBeVisible();
    await expect(page.locator('summary[aria-label="Show 1 clip from this recording"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply range', exact: true })).toHaveCount(0);
    await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('1');
    await expect(page.getByRole('button', { name: 'Cancel range', exact: true })).toHaveCount(0);
    await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).press('Escape');
    await page.getByRole('button', { name: 'Close source review', exact: true }).click();
    await inspectorTab(page, 'Audio');
    await expect(page.getByRole('button', { name: 'Browse music recordings', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Music recording path', exact: true })).toBeVisible();

    // Include mounted help and accessible names, not implementation classes or persisted fields.
    const wording = await page
      .locator('body')
      .evaluate((body) => [
        body.textContent,
        ...Array.from(body.querySelectorAll('[aria-label], [title]')).flatMap((element) => [
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ]),
      ]);
    expect(wording.join('\n')).not.toMatch(/\b(?:rush|excerpts?|rows?|layers?|participants?|points?)\b/i);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(memory.snapshot().clips[0]!.spatial.keyframes).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
