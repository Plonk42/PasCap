import { expect, test, type Page } from '@playwright/test';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { evaluateSpatial, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';
import { SPATIAL_CONTROLS } from '../../src/web/spatial-editor.js';
import { clipAction, expandedInspectorPreferences } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let assets: MediaAsset[];
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const asset = library.assets.find(
    (item) => item.name === 'pattern-a.mp4' && item.status === 'ready' && item.prepared !== null,
  );
  if (!asset)
    throw new Error(
      'Transform UI tests require an existing prepared synthetic pattern; no preparation or real media is admitted.',
    );
  assets = [asset];
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets },
    '/api/audio': { assets: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    const proxy = /^\/api\/media\/([^/]+)\/(proxy|thumbnail\/\d+)$/.exec(pathname);
    if (route.request().method() === 'GET' && proxy && assets.some((item) => item.id === proxy[1])) {
      await route.continue();
      return;
    }
    unexpected.push(`${route.request().method()} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('spatial-ui-memory', 'Transform · memory only');
  document.media.videoIds = assets.map((item) => item.id);
  document.clips = [createClip('one', asset.id, 0, 120)];
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.addInitScript(() => localStorage.setItem('pascap-section-transform', 'open'));
  await page.goto(`/?project=${document.id}`);
  await ready(page, document);
});

test.afterEach(() =>
  expect(unexpected, 'Only prepared synthetic reads and memory-only project writes are allowed').toEqual([]),
);

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}
async function ready(page: Page, document: ProjectDocument): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab?.engine.diagnostics();
        return { status: state?.status, duration: state?.duration };
      }),
    )
    .toEqual({ status: 'paused', duration: calculateLayout(document).duration });
}
async function seed(page: Page, configure: (document: ProjectDocument) => void): Promise<ProjectDocument> {
  const document = await current(page);
  configure(document);
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  return document;
}
async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
}
const capture = (page: Page) =>
  page.getByRole('button', { name: 'Transform keyframe at displayed source frame', exact: true });
const exact = (page: Page, label: string, stored = false) =>
  page.getByRole('spinbutton', { name: `${stored ? 'Stored Transform' : 'Transform'} ${label}`, exact: true });

test('all eight exact fields edit only the base with full precision and no implicit keys', async ({ page }) => {
  const before = await current(page);
  const values = [0.1234567, 0.2, 0.3, 0.4, 1.234567, -0.1234567, 0.1234567, 17.1234567];
  for (const [index, control] of SPATIAL_CONTROLS.entries()) {
    const field = exact(page, control.label);
    const prior = await current(page);
    await field.fill(String(values[index]));
    expect(await current(page)).toEqual(prior);
    await field.press('Enter');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(String(values[index]));
    expect((await current(page)).clips[0]!.spatial.base[control.key]).toBe(values[index]);
    expect((await current(page)).clips[0]!.spatial.keyframes).toEqual([]);
  }
  const after = await current(page);
  expect(after.layers).toEqual(before.layers);
  expect(after.clips[0]!.sourceIn).toBe(before.clips[0]!.sourceIn);
  expect(after.clips[0]!.speed).toEqual(before.clips[0]!.speed);
  expect(calculateLayout(after).duration).toBe(calculateLayout(before).duration);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).clips[0]!.spatial.base.rotation).toBe(0);
});

test('invalid crop drafts remain editable without clamping and Escape restores', async ({ page }) => {
  await exact(page, 'Crop right').fill('0.6');
  await exact(page, 'Crop right').press('Enter');
  const before = await current(page);
  const left = exact(page, 'Crop left');
  await left.fill('0.456789');
  await left.press('Enter');
  await expect(left).toHaveAttribute('aria-invalid', 'true');
  await expect(left).toHaveValue('0.456789');
  expect(await current(page)).toEqual(before);
  await left.press('Escape');
  await expect(left).toHaveValue('0');
  await left.fill('1');
  await left.press('Enter');
  await expect(left).toHaveAttribute('aria-invalid', 'true');
  await expect(left).toHaveValue('1');
  expect(await current(page)).toEqual(before);
});

test('real native slider drafts commit on release once, cancel on Escape and Undo restores', async ({ page }) => {
  const before = await current(page);
  const slider = page.getByRole('slider', { name: 'Transform Scale', exact: true });
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
  expect(await current(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await current(page)).toEqual(before);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
  expect(await current(page)).toEqual(before);
  await page.mouse.up();
  expect((await current(page)).clips[0]!.spatial.base.scale).toBeGreaterThan(1);
  expect((await current(page)).clips[0]!.spatial.keyframes).toEqual([]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('one full-pose diamond captures continuous evaluation at the actual displayed integer source frame', async ({
  page,
}) => {
  const before = await seed(page, (document) => {
    const clip = document.clips[0]!;
    clip.speed = { mode: 'constant', rate: 0.75 };
    clip.spatial.base.scale = 1.5;
    clip.spatial.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...NEUTRAL_SPATIAL_POSE, scale: 1 } },
      { frame: 100, interpolation: 'smooth', values: { ...NEUTRAL_SPATIAL_POSE, scale: 3, rotation: 90 } },
    ];
  });
  await seek(page, 5);
  const placed = calculateLayout(before).clips[0]!;
  const source = placed.retiming.sourceAt(5);
  const evaluated = evaluateSpatial(before.clips[0]!.spatial, placed.retiming.sourcePositionAt(5));
  await expect(exact(page, 'Scale')).toBeDisabled();
  await expect(capture(page)).toHaveAttribute('aria-pressed', 'false');
  await capture(page).focus();
  await capture(page).press('Enter');
  await expect(capture(page)).toHaveAttribute('aria-pressed', 'true');
  const captured = await current(page);
  expect(captured.clips[0]!.spatial.keyframes.find((key) => key.frame === source)).toEqual({
    frame: source,
    interpolation: 'linear',
    values: evaluated,
  });
  expect(captured.clips[0]!.spatial.base).toEqual(before.clips[0]!.spatial.base);
  expect(captured.layers).toEqual(before.layers);
  await exact(page, 'Scale').fill('2.3456789');
  await exact(page, 'Scale').press('Enter');
  expect((await current(page)).clips[0]!.spatial.keyframes.find((key) => key.frame === source)!.values.scale).toBe(
    2.3456789,
  );
  await seek(page, 20);
  await expect(exact(page, 'Scale')).toBeDisabled();
  expect((await current(page)).clips[0]!.spatial.keyframes).toHaveLength(3);
});

test('stored full poses preserve base, frame input focus through move/Undo, reject collisions and edit easing', async ({
  page,
}) => {
  const before = await seed(page, (document) => {
    const clip = document.clips[0]!;
    clip.spatial.base.scale = 1.5;
    clip.spatial.keyframes = [0, 100].map((frame) => ({
      frame,
      interpolation: 'linear',
      values: { ...NEUTRAL_SPATIAL_POSE },
    }));
  });
  const time = page.getByRole('spinbutton', { name: 'Transform keyframe source frame', exact: true });
  await time.fill('40');
  await time.press('Enter');
  await expect(time).toBeFocused();
  await expect(time).toHaveValue('40');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(time).toHaveValue('0');
  await time.fill('100');
  await time.press('Enter');
  await expect(time).toHaveAttribute('aria-invalid', 'true');
  await expect(time).toHaveValue('100');
  expect(await current(page)).toEqual(before);
  await time.press('Escape');
  await page.getByRole('combobox', { name: 'Transform keyframe easing', exact: true }).selectOption('ease-in');
  for (const control of SPATIAL_CONTROLS) {
    const field = exact(page, control.label, true);
    const value = control.key === 'scale' ? 1.23456789 : 0.123456789;
    await field.fill(String(value));
    await field.press('Enter');
    expect((await current(page)).clips[0]!.spatial.keyframes[0]!.values[control.key]).toBe(value);
  }
  const after = await current(page);
  expect(after.clips[0]!.spatial.base).toEqual(before.clips[0]!.spatial.base);
  expect(after.clips[0]!.spatial.keyframes[0]!.interpolation).toBe('ease-in');
  expect(after.layers).toEqual(before.layers);
});

test('off-trim and exclusive OUT stored navigation uses the closest real mapped image without save/history', async ({
  page,
}) => {
  const before = await seed(page, (document) => {
    const clip = document.clips[0]!;
    clip.sourceIn = 30;
    clip.sourceOut = 90;
    clip.speed = { mode: 'constant', rate: 4 };
    clip.spatial.keyframes = [0, 41, 90, 120].map((frame) => ({
      frame,
      interpolation: 'linear',
      values: { ...NEUTRAL_SPATIAL_POSE },
    }));
  });
  for (const frame of [0, 41, 90, 120]) {
    await page.getByRole('combobox', { name: 'Selected Transform keyframe', exact: true }).selectOption(String(frame));
    await page.getByRole('button', { name: 'Preview selected Transform keyframe', exact: true }).click();
    const output = previewClipSource(before, 'one', frame);
    const source = calculateLayout(before).clips[0]!.retiming.sourceAt(output);
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(output);
    await expect(page.getByRole('region', { name: 'Stored Transform key', exact: true })).toContainText(
      `Stored source frame ${frame} · actual displayed source frame ${source}`,
    );
    await expect(exact(page, 'Scale')).toBeDisabled();
  }
  await page.getByRole('button', { name: 'Previous Transform keyframe', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Selected Transform keyframe', exact: true })).toHaveValue('90');
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('last-key deletion reveals preserved base; whole Reset clears keys and base in one Undo', async ({ page }) => {
  const before = await seed(page, (document) => {
    const clip = document.clips[0]!;
    clip.spatial.base.scale = 1.456789;
    clip.spatial.keyframes = [{ frame: 0, interpolation: 'hold', values: { ...NEUTRAL_SPATIAL_POSE, scale: 2 } }];
  });
  await page.getByRole('button', { name: 'Delete selected Transform keyframe', exact: true }).click();
  await expect(exact(page, 'Scale')).toHaveValue('1.456789');
  expect((await current(page)).clips[0]!.spatial.base).toEqual(before.clips[0]!.spatial.base);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Reset transform', exact: true }).click();
  expect((await current(page)).clips[0]!.spatial).toEqual({ base: NEUTRAL_SPATIAL_POSE, keyframes: [] });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('selection context cancels invalid drafts instead of applying them to another excerpt', async ({ page }) => {
  const before = await current(page);
  const field = exact(page, 'Scale');
  await field.fill('9.1234567');
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await clipAction(page, 'Duplicate selected clip');
  await expect(exact(page, 'Scale')).toHaveValue('1');
  await expect(exact(page, 'Scale')).toHaveAttribute('aria-invalid', 'false');
  const duplicated = await current(page);
  expect(duplicated.clips).toHaveLength(2);
  expect(duplicated.clips.map((clip) => clip.spatial)).toEqual([before.clips[0]!.spatial, before.clips[0]!.spatial]);
  await exact(page, 'Scale').fill('1.25');
  await exact(page, 'Scale').press('Enter');
  const after = await current(page);
  expect(after.clips[0]!.spatial).toEqual(before.clips[0]!.spatial);
  expect(after.clips[1]!.spatial.base.scale).toBe(1.25);
});

test('bulk expansion includes Transform while heading help and tab navigation retain normal focus', async ({
  page,
}) => {
  const before = await current(page);
  await page.getByRole('button', { name: 'Collapse all Inspector settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const help = page.getByRole('button', { name: 'Transform animation help', exact: true });
  await help.click();
  await expect(
    page.getByText('Crop fractions remove original source edges without refitting;', { exact: false }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Expand all Inspector settings', exact: true }).click();
  await expect(exact(page, 'Scale')).toBeVisible();
  await page.getByRole('tab', { name: 'Clip', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(exact(page, 'Scale')).toBeVisible();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('Transform controls fit the 270px Inspector at the default and minimum viewports with all stored fields reachable', async ({
  page,
}) => {
  await seed(page, (document) => {
    document.clips[0]!.spatial.keyframes = [{ frame: 0, interpolation: 'linear', values: { ...NEUTRAL_SPATIAL_POSE } }];
  });
  const divider = page.getByRole('slider', { name: 'Resize Clip panel', exact: true });
  await divider.focus();
  for (let index = 0; index < 4; index++) await divider.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '270');
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect(divider).toHaveAttribute('aria-valuenow', '270');
    const editor = page.getByRole('region', { name: 'Clip Transform editor', exact: true });
    await expect(editor).toBeVisible();
    for (const stored of [false, true]) {
      for (const control of SPATIAL_CONTROLS) {
        const field = exact(page, control.label, stored);
        await field.scrollIntoViewIfNeeded();
        await expect(field).toBeVisible();
        const box = (await field.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(60);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
