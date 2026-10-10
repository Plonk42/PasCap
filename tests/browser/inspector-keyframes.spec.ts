import { expect, test, type Page } from '@playwright/test';
import { applyCommand } from '../../src/shared/commands.js';
import { KEYFRAME_SETTINGS } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  editLayerPoint,
  expandedInspectorPreferences,
  inspectorTab,
  layerKeyframes,
  resetSetting,
  sharedPoint,
} from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let initial: ProjectDocument;
let memory: MemoryProjects;

test.beforeEach(async ({ page, request }) => {
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const asset = library.assets.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready');
  if (!asset) throw new Error('Dedicated prepared synthetic fixture required.');
  initial = createProject('inspector-keyframes', 'Inspector points · memory-only');
  initial.media.videoIds = [asset.id];
  initial = applyCommand(initial, { type: 'insert', clip: createClip('bottom', asset.id, 0, 90), index: 0 });
  initial = applyCommand(initial, { type: 'layer-add', layer: createLayer('upper', 'Video track 2', false) });
  initial = applyCommand(initial, {
    type: 'insert',
    clip: { ...createClip('upper-clip', asset.id, 0, 90), layerId: 'upper' },
    index: 1,
  });
  initial = applyCommand(initial, { type: 'layer-add', layer: createLayer('empty', 'Empty row', false) });
  initial.layers[0]!.keyframes = [
    sharedPoint(
      10,
      {
        opacity: 0.4,
        temperature: 0.3,
        tint: -0.2,
        exposure: 0.5,
        brightness: 0.1,
        contrast: 1.2,
        hue: 20,
        saturation: 1.3,
        highlights: 0.2,
        shadows: -0.2,
        hdr: 0.3,
      },
      'smooth',
    ),
    sharedPoint(200, { exposure: -0.5 }, 'hold'),
  ];
  initial.layers[1]!.keyframes = [sharedPoint(10, { exposure: 0.5 })];
  initial.layers[2]!.keyframes = [sharedPoint(200, { opacity: 0.7, exposure: 0.2 }, 'hold')];
  memory = await memoryProjects(page, initial);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${initial.id}`);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function selectClip(page: Page, id: string): Promise<void> {
  await page.locator(`[data-clip-id="${id}"] .timeline-clip-body`).click();
}

test('three accessible tabs preserve selection across clips, populated/empty tracks and projects without writes', async ({
  page,
}) => {
  const tabs = page.getByRole('tablist', { name: 'Inspector sections', exact: true });
  await expect(tabs.getByRole('tab')).toHaveText(['Clip', 'Track', 'Audio']);
  await tabs.getByRole('tab', { name: 'Clip', exact: true }).focus();
  for (const label of ['Track', 'Audio']) {
    await page.keyboard.press('ArrowRight');
    const tab = tabs.getByRole('tab', { name: label, exact: true });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel', { name: label, exact: true });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) all \w+ sections$/ })).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: new RegExp(`^(Expand|Collapse) all ${label} sections$`) }),
    ).toHaveCount(1);
    await expect(panel.locator('.inspector-track-selection')).toHaveCount(0);
    expect(await tab.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'));
    await selectClip(page, 'upper-clip');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await selectClip(page, 'bottom');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await tab.focus();
  }
  await page.keyboard.press('Home');
  await expect(tabs.getByRole('tab', { name: 'Clip', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Audio', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Clip', exact: true })).toBeFocused();
  await inspectorTab(page, 'Track keyframes');
  await expect(
    layerKeyframes(page, 'Video track 1').getByRole('list', { name: 'Edit track keyframes', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit track keyframes', exact: true })).toHaveCount(0);
  await selectClip(page, 'upper-clip');
  await expect(layerKeyframes(page, 'Video track 2')).toBeVisible();
  await page.getByRole('button', { name: 'Select track Empty row', exact: true }).click();
  await expect(layerKeyframes(page, 'Empty row')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(
    layerKeyframes(page, 'Empty row').getByRole('button', { name: 'Next track keyframe', exact: true }),
  ).toBeEnabled();
  const other = createProject('other-inspector', 'Other context');
  other.layers[0]!.name = 'Other row';
  memory.seed(other);
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.getByRole('button', { name: 'Open Other context', exact: true }).click();
  await expect(layerKeyframes(page, 'Other row')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(layerKeyframes(page, 'Empty row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(memory.saves).toBe(0);
  expect(memory.snapshot(initial.id)).toEqual(initial);
});

test('all participants reuse their main control bounds and resets with one exact value beside each slider while edits isolate the stored point', async ({
  page,
}) => {
  const main = new Map<string, { min: string | null; max: string | null; step: string | null }>();
  await inspectorTab(page, 'Track');
  for (const setting of KEYFRAME_SETTINGS) {
    const slider = page.getByRole('slider', { name: setting.label, exact: true });
    main.set(
      setting.key,
      await slider.evaluate((input) => ({
        min: input.getAttribute('min'),
        max: input.getAttribute('max'),
        step: input.getAttribute('step'),
      })),
    );
  }
  const row = await editLayerPoint(page, 'Video track 1', 10);
  expect(KEYFRAME_SETTINGS).toHaveLength(11);
  await expect(row.locator('.layer-keyframe-point-values').getByRole('spinbutton')).toHaveCount(11);
  for (const setting of KEYFRAME_SETTINGS) {
    const name = `${setting.label} keyframe value 10`;
    await expect(row.getByRole('spinbutton', { name, exact: true })).toBeEnabled();
    const slider = row.getByRole('slider', { name, exact: true });
    expect(
      await slider.evaluate((input) => ({
        min: input.getAttribute('min'),
        max: input.getAttribute('max'),
        step: input.getAttribute('step'),
      })),
    ).toEqual(main.get(setting.key));
    const field = row.getByRole('spinbutton', { name, exact: true });
    const scale = setting.key === 'opacity' ? 100 : 1;
    await expect(field).toHaveValue(String(initial.layers[0]!.keyframes[0]!.values[setting.key]! * scale));
    await field.scrollIntoViewIfNeeded();
    const sliderBox = (await slider.boundingBox())!;
    const fieldBox = (await field.boundingBox())!;
    expect(fieldBox.x).toBeGreaterThanOrEqual(sliderBox.x + sliderBox.width);
    expect(Math.abs(fieldBox.y + fieldBox.height / 2 - (sliderBox.y + sliderBox.height / 2))).toBeLessThanOrEqual(2);
    await expect(row.getByRole('button', { name: `Reset ${name}`, exact: true })).toHaveCount(0);
  }
  await expect(row.locator('output')).toHaveCount(0);
  const before = await current(page);
  const slider = row.getByRole('slider', { name: 'Exposure keyframe value 10', exact: true });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toBeFocused();
  const expected = structuredClone(before);
  expected.layers[0]!.keyframes[0]!.values.exposure = 0.51;
  expect(await current(page)).toEqual(expected);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await resetSetting(row, 'Hue keyframe value 10');
  expected.layers[0]!.keyframes[0]!.values.exposure = 0.5;
  expected.layers[0]!.keyframes[0]!.values.hue = 0;
  expect(await current(page)).toEqual(expected);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await resetSetting(row, 'Opacity keyframe value 10');
  const resetOpacity = structuredClone(before);
  resetOpacity.layers[0]!.keyframes[0]!.values.opacity = 1;
  expect(await current(page)).toEqual(resetOpacity);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const precise = row.getByRole('spinbutton', { name: 'Contrast keyframe value 10', exact: true });
  await precise.fill('1.23456789');
  await precise.press('Enter');
  await precise.press('Tab');
  expect((await current(page)).layers[0]!.keyframes[0]!.values.contrast).toBe(1.23456789);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('invalid stored drafts survive tab changes and cancel, without stale row context or implicit participation', async ({
  page,
}) => {
  const row = await editLayerPoint(page, 'Video track 1', 200);
  await expect(row.getByRole('slider')).toHaveCount(1);
  await expect(row.getByRole('spinbutton')).toHaveCount(2);
  const field = row.getByRole('spinbutton', { name: 'Exposure keyframe value 200', exact: true });
  await field.fill('99');
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await inspectorTab(page, 'Clip');
  await inspectorTab(page, 'Track keyframes');
  await expect(field).toHaveValue('99');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.press('Escape');
  await expect(field).toHaveValue('-0.5');
  await expect(field).toBeFocused();
  await field.fill('0.123456789');
  await field.press('Enter');
  await expect(field).toBeFocused();
  const after = await current(page);
  expect(after.layers[0]!.keyframes[1]).toEqual(sharedPoint(200, { exposure: 0.123456789 }, 'hold'));
  expect(after.clips).toEqual(initial.clips);
  expect(after.layers[0]!.keyframes[0]).toEqual(initial.layers[0]!.keyframes[0]);
  const head = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  expect(head).toBe(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('-0.5');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('0.123456789');
  await selectClip(page, 'upper-clip');
  await expect(layerKeyframes(page, 'Video track 2')).toBeVisible();
  const other = await editLayerPoint(page, 'Video track 2', 10);
  await expect(other.getByRole('slider', { name: 'Exposure keyframe value 10', exact: true })).toHaveValue('0.5');
  await expect(other.getByRole('spinbutton', { name: 'Exposure keyframe value 10', exact: true })).toHaveValue('0.5');
  await page.getByRole('button', { name: 'Select track Empty row', exact: true }).click();
  const empty = await editLayerPoint(page, 'Empty row', 200);
  await empty.getByRole('spinbutton', { name: 'Exposure keyframe value 200', exact: true }).fill('0.75');
  await empty.getByRole('spinbutton', { name: 'Exposure keyframe value 200', exact: true }).press('Enter');
  expect((await current(page)).layers[2]!.keyframes).toEqual([
    sharedPoint(200, { opacity: 0.7, exposure: 0.75 }, 'hold'),
  ]);
  expect(calculateLayout(await current(page)).duration).toBe(calculateLayout(initial).duration);
});

test('four tabs and participant controls fit the minimum Inspector at the default and minimum viewports without overflow', async ({
  page,
}) => {
  await page.evaluate(() =>
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
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    await inspectorTab(page, 'Track keyframes');
    const row = await editLayerPoint(page, 'Video track 1', 10);
    const divider = page.getByRole('slider', { name: 'Resize Clip panel', exact: true });
    await expect(divider).toHaveAttribute('aria-valuenow', '270');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const panel = page.getByRole('complementary', { name: 'Clip inspector', exact: true });
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const tab of await page
      .getByRole('tablist', { name: 'Inspector sections', exact: true })
      .getByRole('tab')
      .all()) {
      await expect(tab).toBeVisible();
      expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(32);
      expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    const value = row.getByRole('spinbutton', { name: 'Shadows keyframe value 10', exact: true });
    await value.scrollIntoViewIfNeeded();
    await expect(value).toBeInViewport();
  }
  expect(await current(page)).toEqual(initial);
  expect(memory.saves).toBe(0);
});
