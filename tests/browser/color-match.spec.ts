import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { AUTO_ADJUST_SETTINGS, type AutoCorrection } from '../../src/shared/auto-adjust.js';
import type { ColorSettings } from '../../src/shared/color.js';
import { matchFrame, matchStyle, measureLook, towardsMatch } from '../../src/shared/look-match.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import type { StyleSummary } from '../../src/shared/styles.js';
import type { AnalysisFrame } from '../../src/shared/white-balance.js';
import { expandedInspectorPreferences, inspectorTab } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let unexpected: string[];
let assets: MediaAsset[];
let styleRequests: number;
let styles: StyleSummary[];

/** The reference clip's look: a grade worth matching, beyond a balance. */
const LOOK: Partial<ColorSettings> = { exposure: 0.3, contrast: 1.2, saturation: 1.15, temperature: 0.2 };

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  styleRequests = 0;
  styles = [];
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources', name))
      throw new Error('Match tests require existing prepared synthetic videos; no import or preparation.');
    return asset;
  });
  const reads: Record<string, unknown> = {
    '/api/health': {
      name: 'PasCap',
      milestone: 'editing-and-export',
      frameRate: '30000/1001',
      workerConcurrency: 1,
      toolchain: null,
    },
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [], missing: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    const media = /^\/api\/media\/([^/]+)\/(?:proxy|motion|thumbnail\/\d+)$/.exec(pathname);
    if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) {
      await route.continue();
      return;
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('color-match-memory', 'Color match · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  const hero = createClip('hero', assets[0]!.id, 0, 60);
  hero.grade.color = { ...hero.grade.color, ...LOOK };
  document.clips = [
    hero,
    { ...createClip('shot', assets[1]!.id, 0, 60), start: 60 },
    { ...createClip('other', assets[1]!.id, 60, 120), start: 120 },
  ];
  document.layers[0]!.transitions = [
    { leftId: 'hero', rightId: 'shot', type: 'cut', duration: 0 },
    { leftId: 'shot', rightId: 'other', type: 'cut', duration: 0 },
  ];
  memory = await memoryProjects(page, document);
  await page.route('**/api/ops/list_styles', async (route) => {
    styleRequests++;
    await route.fulfill({ json: { styles } });
  });
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
});

test.afterEach(() => {
  expect(unexpected, 'No real-store writes, imports, preparation, exports or unowned media requests').toEqual([]);
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()))
    .toMatchObject({ status: 'paused', frame });
}

/** One source frame of a recording as the page decodes it for analysis. */
async function pageFrame(page: Page, mediaId: string, source: number): Promise<AnalysisFrame> {
  const [encoded] = await page.evaluate(
    async ({ id, sources }) => {
      const sampled = await window.pascapLab!.sampleFrames(id, sources);
      return [...sampled].map(([, image]) => {
        let binary = '';
        for (let index = 0; index < image.data.length; index += 8192)
          binary += String.fromCharCode(...image.data.subarray(index, index + 8192));
        return { width: image.width, height: image.height, data: btoa(binary) };
      });
    },
    { id: mediaId, sources: [source] },
  );
  return {
    width: encoded!.width,
    height: encoded!.height,
    data: new Uint8ClampedArray(Buffer.from(encoded!.data, 'base64')),
  };
}

const eleven = (color: ColorSettings): AutoCorrection =>
  Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, color[setting]])) as AutoCorrection;
const gradeOf = (document: ProjectDocument, clipId: string) => document.clips.find((clip) => clip.id === clipId)!.grade;
const section = (page: Page) => page.locator('.color-match');
const usePlayhead = (page: Page) =>
  page.getByRole('button', { name: 'Use the frame at the playhead as the color reference', exact: true });
const matchButton = (page: Page) => section(page).locator('.color-match-actions .primary-button');
const apply = (page: Page) => section(page).getByRole('button', { name: /^Apply/ });

async function selectClip(page: Page, clipId: string, frame: number): Promise<void> {
  // Enter on a clip seeks its start.
  await page.locator(`[data-clip-id="${clipId}"] .timeline-clip-body`).press('Enter');
  await seek(page, frame);
}

test('matches a clip frame to the timeline frame at the playhead, previewing before one Undo step', async ({
  page,
}) => {
  await seek(page, 10);
  await inspectorTab(page, 'Clip grade');
  await expect(page.getByRole('button', { name: 'Match section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(section(page)).toContainText('No reference');
  await expect(matchButton(page)).toHaveAttribute('aria-disabled', 'true');
  await usePlayhead(page).click();
  await expect(section(page)).toContainText('pattern-a');
  await expect(section(page)).toContainText('Timeline frame, as graded');
  await expect(section(page).locator('.color-match-thumbnail img')).toBeVisible();
  // The playhead shows the reference itself.
  await expect(section(page)).toContainText('The playhead shows the reference frame itself');

  await selectClip(page, 'shot', 70);
  await expect(section(page)).toContainText('This clip at the playhead');
  const before = await current(page);
  await matchButton(page).click();
  await expect(apply(page)).toBeVisible({ timeout: 30_000 });
  // Match gave way to its result: the keyboard continues on Apply.
  await expect(apply(page)).toBeFocused();
  await expect(section(page)).toContainText(/scene/);
  // The preview edits nothing.
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);

  const reference = await pageFrame(page, assets[0]!.id, 10);
  const target = await pageFrame(page, assets[1]!.id, 10);
  const shotColor = gradeOf(before, 'shot').color;
  const matched = matchFrame(
    { frame: reference, color: gradeOf(before, 'hero').color },
    { frame: target, color: shotColor },
  )!;
  const expected = towardsMatch(shotColor, matched.correction, 1);
  await apply(page).click();
  await expect(apply(page)).toHaveCount(0);
  await expect.poll(async () => eleven(gradeOf(await current(page), 'shot').color)).toEqual(expected);
  const after = await current(page);
  expect(gradeOf(after, 'hero')).toEqual(gradeOf(before, 'hero'));
  expect(gradeOf(after, 'other')).toEqual(gradeOf(before, 'other'));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => gradeOf(await current(page), 'shot')).toEqual(gradeOf(before, 'shot'));

  // Half the Intensity moves the grade half way.
  await matchButton(page).click();
  const intensity = page.getByRole('spinbutton', { name: 'Match intensity', exact: true });
  await intensity.fill('50');
  await intensity.press('Enter');
  await apply(page).click();
  await expect
    .poll(async () => eleven(gradeOf(await current(page), 'shot').color))
    .toEqual(towardsMatch(shotColor, matched.correction, 0.5));
  expect(styleRequests).toBe(0);
});

test('matches several selected clips, each at the playhead or its middle frame, in one Undo step', async ({ page }) => {
  await seek(page, 10);
  await inspectorTab(page, 'Clip grade');
  await usePlayhead(page).click();
  await selectClip(page, 'shot', 70);
  await page.locator('[data-clip-id="other"] .timeline-clip-body').click({ modifiers: ['ControlOrMeta'] });
  await expect(section(page)).toContainText('2 selected clips, each at the playhead or at its middle frame');
  await expect(page.locator('.inspector-empty')).toContainText('2 clips are selected');
  const before = await current(page);
  await expect(matchButton(page)).toHaveText(/Match 2 clips/);
  await matchButton(page).click();
  await expect(apply(page)).toHaveText('Apply to 2 clips', { timeout: 30_000 });
  await apply(page).click();
  await expect
    .poll(async () => eleven(gradeOf(await current(page), 'other').color))
    .not.toEqual(eleven(gradeOf(before, 'other').color));
  const after = await current(page);
  expect(eleven(gradeOf(after, 'shot').color)).not.toEqual(eleven(gradeOf(before, 'shot').color));
  expect(gradeOf(after, 'hero')).toEqual(gradeOf(before, 'hero'));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await current(page)).clips).toEqual(before.clips);
});

test('keeps the reference per project from a clip menu, Source preview and styles', async ({ page }) => {
  await seek(page, 70);
  await page.locator('[data-clip-id="hero"] .timeline-clip-body').click({ button: 'right' });
  await page.getByRole('button', { name: 'Use this clip as the color reference', exact: true }).click();
  await inspectorTab(page, 'Clip grade');
  // The hero's middle frame: the playhead is on another clip.
  await expect(section(page)).toContainText('pattern-a');
  expect(await page.evaluate(() => localStorage.getItem('pascap-color-reference-color-match-memory'))).toBe(
    JSON.stringify({ kind: 'clip', clipId: 'hero', sourceFrame: 30 }),
  );
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await selectClip(page, 'shot', 70);
  await inspectorTab(page, 'Clip grade');
  await expect(section(page)).toContainText('Timeline frame, as graded');
  await expect(section(page)).toContainText('This clip at the playhead');

  // A recording frame, as shot.
  await page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true }).click();
  const fromSource = page.getByRole('button', { name: 'Use this frame as the color reference', exact: true });
  await expect(fromSource).toBeEnabled();
  await fromSource.click();
  await expect(fromSource).toHaveAttribute('aria-pressed', 'true');
  await expect(section(page)).toContainText('pattern-b');
  await expect(section(page)).toContainText('Recording frame, as shot');

  // A registered style, loaded only once its menu opens: the hero's look as graded.
  expect(styleRequests).toBe(0);
  const look = measureLook([await pageFrame(page, assets[0]!.id, 20)], gradeOf(await current(page), 'hero').color)!;
  styles = [
    {
      id: 'bright',
      name: 'Bright edits',
      references: [{ name: 'edit.mp4', kind: 'video', frames: 8 }],
      look,
      createdAt: '2026-11-13T00:00:00.000Z',
    },
  ];
  await page.locator('summary[aria-label="Styles and other references"]').click();
  await page.getByRole('button', { name: /Bright edits/ }).click();
  expect(styleRequests).toBe(1);
  await expect(section(page)).toContainText('Registered style');
  const before = await current(page);
  await matchButton(page).click();
  await expect(section(page)).toContainText('Matched to the style’s look', { timeout: 30_000 });
  const shotColor = gradeOf(before, 'shot').color;
  const target = await pageFrame(page, assets[1]!.id, 10);
  const expected = towardsMatch(shotColor, matchStyle(look, { frame: target, color: shotColor })!, 1);
  await apply(page).click();
  await expect.poll(async () => eleven(gradeOf(await current(page), 'shot').color)).toEqual(expected);

  await page.locator('summary[aria-label="Styles and other references"]').click();
  await page.getByRole('button', { name: 'Clear reference', exact: true }).click();
  await expect(section(page)).toContainText('No reference');
});
