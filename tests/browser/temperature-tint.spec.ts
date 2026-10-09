import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  editLayerPoint,
  expandedInspectorPreferences,
  layerKeyframes,
  resetSetting,
  inspectorTab as openTab,
  sharedPoint,
} from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

// Temperature/Tint are Track settings beside the keyframe list; "Clip" here means those playhead controls.
async function inspectorTab(page: Page, name: 'Clip' | 'Track keyframes'): Promise<void> {
  await openTab(page, name === 'Clip' ? 'Track' : name);
}

const channels = [
  { setting: 'temperature', label: 'Temperature', precise: 0.123456789 },
  { setting: 'tint', label: 'Tint', precise: -0.234567891 },
] as const;
type Setting = (typeof channels)[number]['setting'];
type Cancellation = 'Escape' | 'pointercancel' | 'lostcapture' | 'windowblur';
let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: MediaAsset[] };
  const assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources', name))
      throw new Error('Temperature/Tint tests require existing prepared synthetic videos; no import or preparation.');
    return asset;
  });
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets },
    '/api/audio': { assets: [] },
    '/api/jobs': { jobs: [] },
  };
  // Only intercepted memory-project writes and these owned synthetic media GETs are permitted.
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    const media = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
    if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) {
      await route.continue();
      return;
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('temperature-tint-memory', 'Temperature and Tint · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [createClip('one', assets[0]!.id, 0, 60), { ...createClip('two', assets[1]!.id, 0, 60), start: 60 }];
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  document.layers.push(createLayer('empty', 'Empty row'));
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await ready(page, document);
});

test.afterEach(() => {
  expect(unexpected, 'No real-store writes, imports, preparation, exports or unowned media requests').toEqual([]);
});

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
  await inspectorTab(page, 'Clip');
  await expect(page.getByRole('slider', { name: 'Temperature', exact: true })).toBeVisible();
}

async function fixture(page: Page, document: ProjectDocument): Promise<void> {
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}

function controls(scope: Page | Locator, label: string) {
  const slider = scope.getByRole('slider', { name: label, exact: true });
  return { slider, exact: scope.getByRole('spinbutton', { name: label, exact: true }), widget: slider.locator('..') };
}

function diamond(page: Page, label: string): Locator {
  return page.getByRole('button', { name: `Keyframe ${label}`, exact: true });
}

function navigation(page: Page, label: string, direction: 'Previous' | 'Next'): Locator {
  return diamond(page, label)
    .locator('..')
    .getByRole('button', { name: `${direction} ${label} keyframe`, exact: true });
}

async function previewAt(page: Page, frame: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame, duration: state.duration };
      }),
    )
    .toEqual({ status: 'paused', frame, duration: 120 });
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await previewAt(page, frame);
}

async function checkpoint(page: Page) {
  await page.evaluate(() => window.pascapLab!.flush());
  return {
    document: await current(page),
    saved: memory.snapshot(),
    saves: memory.saves,
    undo: await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(),
    redo: await page.getByRole('button', { name: 'Redo', exact: true }).isEnabled(),
    frame: await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame),
  };
}

async function unchanged(page: Page, before: Awaited<ReturnType<typeof checkpoint>>): Promise<void> {
  expect(await current(page)).toEqual(before.document);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot()).toEqual(before.saved);
  expect(memory.saves).toBe(before.saves);
  expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(before.undo);
  expect(await page.getByRole('button', { name: 'Redo', exact: true }).isEnabled()).toBe(before.redo);
  await previewAt(page, before.frame);
}

/** Assert the entire document, including untouched rows, clips, points and easing, not only the edited number. */
function edited(document: ProjectDocument, setting: Setting, value: number, layerId: string, frame?: number) {
  const expected = structuredClone(document);
  const row = expected.layers.find((layer) => layer.id === layerId)!;
  if (frame === undefined) row.colour[setting] = value;
  else row.keyframes.find((point) => point.frame === frame)!.values[setting] = value;
  return expected;
}

async function editAndUndo(
  page: Page,
  before: Awaited<ReturnType<typeof checkpoint>>,
  expected: ProjectDocument,
): Promise<void> {
  expect(await current(page)).toEqual(expected);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(before.saves + 1);
  expect(memory.snapshot()).toEqual({ ...expected, revision: before.saved.revision + 1 });
  await previewAt(page, before.frame);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before.document);
  expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(before.undo);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.evaluate(() => window.pascapLab!.flush());
}

async function beginDrag(page: Page, slider: Locator) {
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const geometry = await slider.evaluate((element: HTMLInputElement) => {
    element.removeAttribute('data-test-capture-id');
    element.addEventListener(
      'gotpointercapture',
      (event) => element.setAttribute('data-test-capture-id', String(event.pointerId)),
      { once: true },
    );
    element.addEventListener(
      'pointerdown',
      (event) => element.setAttribute('data-test-pointer-id', String(event.pointerId)),
      { once: true },
    );
    return {
      ratio: (Number(element.value) - Number(element.min)) / (Number(element.max) - Number(element.min)),
      inset: 5 + Number.parseFloat(getComputedStyle(element).borderLeftWidth),
    };
  });
  const x = box.x + geometry.inset + geometry.ratio * (box.width - 2 * geometry.inset);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const pointerId = Number(await slider.getAttribute('data-test-pointer-id'));
  await page.mouse.move(x, y);
  // Native Chrome capture belongs to the UA-shadow thumb; observe the retargeted capture event.
  await expect(slider).toHaveAttribute('data-test-capture-id', String(pointerId));
  await expect(slider.locator('..')).toHaveAttribute('data-pointer-draft', 'true');
  return { box, pointerId, inset: geometry.inset };
}

async function moveDrag(page: Page, drag: Awaited<ReturnType<typeof beginDrag>>, ratio: number): Promise<void> {
  await page.mouse.move(
    drag.box.x + drag.inset + ratio * (drag.box.width - 2 * drag.inset),
    drag.box.y + drag.box.height / 2,
    { steps: 6 },
  );
}

async function cancelDrag(
  page: Page,
  slider: Locator,
  drag: Awaited<ReturnType<typeof beginDrag>>,
  cancellation: Cancellation,
): Promise<void> {
  if (cancellation === 'Escape') await page.keyboard.press('Escape');
  else if (cancellation === 'windowblur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  else if (cancellation === 'pointercancel')
    await slider.dispatchEvent('pointercancel', { pointerId: drag.pointerId, pointerType: 'mouse', isPrimary: true });
  else {
    // Transfer genuine native capture; releasing the public input cannot release its shadow thumb.
    await slider.locator('..').evaluate((element, id) => element.setPointerCapture(id), drag.pointerId);
    await page.mouse.move(
      drag.box.x + drag.inset + 0.8 * (drag.box.width - 2 * drag.inset),
      drag.box.y + drag.box.height / 2 + 2,
      { steps: 2 },
    );
  }
}

test('empty-row native controls preserve exact precision, invalid drafts, individual resets and one-step history', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.colour.temperature = 0.4;
  document.layers[0]!.colour.tint = -0.6;
  await fixture(page, document);
  await page.getByRole('button', { name: 'Select track Empty row', exact: true }).click();
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .selected-clip-name')).toContainText(
    'Applies to every clip added to this track',
  );
  for (const { setting, label, precise } of channels) {
    const { slider, exact, widget } = controls(page, label);
    await expect(slider).toBeEnabled();
    await expect(exact).toBeEnabled();
    await expect(exact).toHaveValue('0');
    await expect(slider).toHaveAttribute('type', 'range');
    for (const field of [slider, exact]) {
      await expect(field).toHaveAttribute('min', '-1');
      await expect(field).toHaveAttribute('max', '1');
    }
    await expect(widget.locator('input')).toHaveCount(2);
    await expect(widget.locator('output')).toHaveCount(0);
    await expect(diamond(page, label)).toBeEnabled();
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    const main = diamond(page, label).locator('..');
    await expect(main).toHaveClass(/\bkeyframe-setting-navigation\b/);
    await expect(main).toHaveJSProperty('tagName', 'SPAN');
    await expect(main.getByRole('button')).toHaveCount(3);
    for (const button of await main.getByRole('button').all())
      await expect(button).toHaveJSProperty('tagName', 'BUTTON');
    const neutralState = await checkpoint(page);
    await resetSetting(page, label);
    await unchanged(page, neutralState);
    for (const direction of ['Previous', 'Next'] as const) {
      await expect(navigation(page, label, direction)).toBeVisible();
      await expect(navigation(page, label, direction)).toHaveAttribute('aria-disabled', 'true');
      await expect(navigation(page, label, direction)).toHaveJSProperty('disabled', false);
      await expect(navigation(page, label, direction)).toHaveAttribute('tabindex', '-1');
    }
    const before = await checkpoint(page);
    await exact.fill(String(precise));
    await unchanged(page, before);
    await exact.press('Enter');
    await expect(exact).toBeFocused();
    await expect(exact).toHaveValue(String(precise));
    await exact.press('Tab');
    const expected = edited(before.document, setting, precise, 'empty');
    await editAndUndo(page, before, expected);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(await current(page)).toEqual(expected);
    await expect(exact).toHaveValue(String(precise));

    const preciseState = await checkpoint(page);
    for (const invalid of ['', '-1.0001', '1.0001']) {
      await exact.fill(invalid);
      await exact.press('Enter');
      await expect(exact).toHaveValue(invalid);
      await expect(exact).toHaveAttribute('aria-invalid', 'true');
      await expect(exact.locator('..').getByRole('alert')).toContainText(
        invalid === '' ? 'Enter a number' : invalid.startsWith('-') ? 'Enter -1 or greater.' : 'Enter 1 or less.',
      );
      await exact.press('Tab');
      await unchanged(page, preciseState);
      await exact.press('Escape');
      await expect(exact).toHaveValue(String(precise));
      await expect(exact).toHaveAttribute('aria-invalid', 'false');
    }
    await exact.fill(`${precise}0`);
    await exact.press('Enter');
    await exact.press('Tab');
    await unchanged(page, preciseState);
    await resetSetting(page, label);
    await expect(exact).toHaveValue('0');
    await editAndUndo(page, preciseState, edited(preciseState.document, setting, 0, 'empty'));
    const keyboardBefore = await checkpoint(page);
    const initial = Number(await slider.inputValue());
    await slider.press('ArrowRight');
    const next = Number(await slider.inputValue());
    expect(next).toBeGreaterThan(initial);
    await editAndUndo(page, keyboardBefore, edited(keyboardBefore.document, setting, next, 'empty'));
  }
  const resetBefore = await checkpoint(page);
  const neutral = edited(edited(resetBefore.document, 'temperature', 0, 'empty'), 'tint', 0, 'empty');
  await page.getByRole('button', { name: 'Reset colour', exact: true }).click();
  for (const { label } of channels) await expect(controls(page, label).exact).toHaveValue('0');
  await editAndUndo(page, resetBefore, neutral);
  const finished = await current(page);
  expect(finished.layers[0]).toEqual(document.layers[0]);
  expect(finished.layers[1]!.keyframes).toEqual([]);
  expect(finished.clips).toEqual(document.clips);
  for (const clipId of ['one', 'two']) {
    await page.locator(`[data-clip-id="${clipId}"] .timeline-clip-body`).click();
    await expect(controls(page, 'Temperature').exact).toHaveValue('0.4');
    await expect(controls(page, 'Tint').exact).toHaveValue('-0.6');
  }
  expect(await current(page)).toEqual(finished);
  for (const clip of finished.clips) {
    expect(clip).not.toHaveProperty('colour');
    expect(clip).not.toHaveProperty('temperature');
    expect(clip).not.toHaveProperty('tint');
  }
});

test('main and stored native pointer drafts cancel safely, then release as one save and one Undo', async ({ page }) => {
  // 25 s measured CI-like (software GL, two cores).
  test.setTimeout(75_000);
  for (const stored of [false, true]) {
    if (stored) {
      const document = await current(page);
      document.layers[0]!.keyframes = [sharedPoint(30, { temperature: 0.25, tint: -0.3, exposure: 0.2 }, 'smooth')];
      await fixture(page, document);
    }
    const scope = stored ? await editLayerPoint(page, 'Video track 1', 30) : page;
    for (const { setting, label } of channels) {
      const name = stored ? `${label} keyframe value 30` : label;
      const { slider, exact, widget } = controls(scope, name);
      const before = await checkpoint(page);
      const initialSlider = await slider.inputValue();
      const initialExact = await exact.inputValue();
      const cancellation: Cancellation = stored
        ? setting === 'temperature'
          ? 'pointercancel'
          : 'lostcapture'
        : setting === 'temperature'
          ? 'Escape'
          : 'windowblur';
      const cancelled = await beginDrag(page, slider);
      await moveDrag(page, cancelled, 0.8);
      expect(await slider.inputValue()).not.toBe(initialSlider);
      await expect(exact).toHaveValue(await slider.inputValue());
      await expect(exact).toBeDisabled();
      await unchanged(page, before);
      await cancelDrag(page, slider, cancelled, cancellation);
      await expect(widget).toHaveAttribute('data-pointer-draft', 'false');
      await expect(slider).toHaveValue(initialSlider);
      await expect(exact).toHaveValue(initialExact);
      await expect(exact).toBeEnabled();
      await page.mouse.up();
      await unchanged(page, before);

      const drag = await beginDrag(page, slider);
      for (const ratio of [0.3, 0.7]) {
        await moveDrag(page, drag, ratio);
        expect(await slider.inputValue()).not.toBe(initialSlider);
        await expect(exact).toHaveValue(await slider.inputValue());
        await expect(exact).toBeDisabled();
        await expect(widget).toHaveAttribute('data-dirty', 'true');
        await unchanged(page, before);
      }
      const value = Number(await slider.inputValue());
      await page.mouse.up();
      await expect(widget).toHaveAttribute('data-pointer-draft', 'false');
      await expect(exact).toBeEnabled();
      await expect(exact).toHaveValue(String(value));
      await editAndUndo(page, before, edited(before.document, setting, value, 'video-1', stored ? 30 : undefined));
      await expect(slider).toHaveValue(initialSlider);
    }
  }
});

test('animated missing participants stay read-only until explicit capture; removal restores independent row bases', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.colour.temperature = 0.35;
  document.layers[0]!.colour.tint = -0.25;
  document.layers[0]!.keyframes = [
    sharedPoint(10, { temperature: -0.5 }),
    sharedPoint(20, { exposure: 0.4 }, 'smooth'),
    sharedPoint(30, { temperature: 0.5 }),
  ];
  await fixture(page, document);
  expect(document.schemaVersion).toBe(12);
  expect(Object.keys(document.layers[0]!.keyframes[0]!.values)).toHaveLength(11);
  await seek(page, 20);
  const temperature = controls(page, 'Temperature');
  const tint = controls(page, 'Tint');
  await expect(temperature.exact).toHaveValue('0');
  for (const field of [temperature.slider, temperature.exact]) await expect(field).toBeDisabled();
  const readOnly = await checkpoint(page);
  await resetSetting(page, 'Temperature');
  await unchanged(page, readOnly);
  await expect(diamond(page, 'Temperature')).toBeEnabled();
  await expect(diamond(page, 'Temperature')).toHaveAttribute('aria-pressed', 'false');
  await expect(temperature.slider).toHaveAccessibleDescription(/Read-only animated value at timeline frame 20/);
  const before = await checkpoint(page);
  await expect(tint.exact).toBeEnabled();
  await tint.exact.fill('-0.456789123');
  await tint.exact.press('Enter');
  const staticChange = edited(before.document, 'tint', -0.456789123, 'video-1');
  expect(await current(page)).toEqual(staticChange);
  expect((await current(page)).layers[0]!.keyframes).toEqual(document.layers[0]!.keyframes);

  await diamond(page, 'Temperature').press('Space');
  await expect(temperature.exact).toBeEnabled();
  await expect(diamond(page, 'Temperature')).toHaveAttribute('aria-pressed', 'true');
  const captured = edited(staticChange, 'temperature', 0, 'video-1', 20);
  expect(await current(page)).toEqual(captured);
  await temperature.exact.fill('0.123456789');
  await temperature.exact.press('Enter');
  const keyed = edited(captured, 'temperature', 0.123456789, 'video-1', 20);
  const keyedBefore = await checkpoint(page);
  expect(keyedBefore.document).toEqual(keyed);
  await resetSetting(page, 'Temperature');
  await editAndUndo(page, keyedBefore, captured);
  await diamond(page, 'Tint').click();
  const both = edited(keyed, 'tint', -0.456789123, 'video-1', 20);
  expect(await current(page)).toEqual(both);
  await diamond(page, 'Temperature').click();
  await expect(temperature.exact).toBeDisabled();
  await expect(tint.exact).toBeEnabled();
  for (const frame of [10, 30]) {
    await seek(page, frame);
    await expect(tint.slider).toBeDisabled();
    await expect(tint.exact).toBeDisabled();
    await expect(diamond(page, 'Tint')).toBeEnabled();
    await expect(diamond(page, 'Tint')).toHaveAttribute('aria-pressed', 'false');
    await diamond(page, 'Temperature').click();
  }
  await expect(temperature.exact).toBeEnabled();
  await expect(temperature.exact).toHaveValue('0.35');
  const remaining = structuredClone(staticChange);
  remaining.layers[0]!.keyframes = [sharedPoint(20, { exposure: 0.4, tint: -0.456789123 }, 'smooth')];
  expect(await current(page)).toEqual(remaining);
  await seek(page, 20);
  await diamond(page, 'Tint').click();
  await expect(tint.exact).toBeEnabled();
  await expect(tint.exact).toHaveValue('-0.456789123');
  const restored = structuredClone(staticChange);
  restored.layers[0]!.keyframes = [sharedPoint(20, { exposure: 0.4 }, 'smooth')];
  expect(await current(page)).toEqual(restored);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(remaining);
});

test('main and off-duration stored resets edit only existing participants; exact invalid drafts never seek or join keys', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.colour.temperature = 0.3;
  document.layers[0]!.colour.tint = -0.2;
  document.layers[0]!.keyframes = [
    sharedPoint(10, { temperature: -0.6, tint: 0.4, exposure: 0.25 }, 'smooth'),
    sharedPoint(30, { tint: -0.8 }, 'hold'),
    sharedPoint(180, { temperature: 0.7, tint: -0.5, opacity: 0.6 }, 'ease-out'),
  ];
  await fixture(page, document);
  await seek(page, 30);
  await expect(controls(page, 'Temperature').exact).toBeDisabled();
  for (const action of ['Tint', 'Reset colour']) {
    const mainBefore = await checkpoint(page);
    if (action === 'Tint') await resetSetting(page, 'Tint');
    else await page.getByRole('button', { name: action, exact: true }).click();
    await editAndUndo(page, mainBefore, edited(mainBefore.document, 'tint', 0, 'video-1', 30));
  }
  const row = await editLayerPoint(page, 'Video track 1', 180);
  await expect(row.locator('.layer-keyframe-point-values').getByRole('slider')).toHaveCount(3);
  await expect(row.getByRole('slider', { name: 'Exposure keyframe value 180', exact: true })).toHaveCount(0);
  for (const { setting, label, precise } of channels) {
    const name = `${label} keyframe value 180`;
    const { slider, exact } = controls(row, name);
    await expect(slider).toBeEnabled();
    await expect(exact).toBeEnabled();
    const before = await checkpoint(page);
    const initial = await exact.inputValue();
    await exact.fill(String(precise));
    await unchanged(page, before);
    await exact.press('Enter');
    await expect(exact).toHaveValue(String(precise));
    await exact.press('Tab');
    await editAndUndo(page, before, edited(before.document, setting, precise, 'video-1', 180));
    await expect(exact).toHaveValue(initial);
    const restored = await checkpoint(page);
    for (const invalid of ['', '-1.01', '1.01']) {
      await exact.fill(invalid);
      await exact.press('Enter');
      await expect(exact).toHaveValue(invalid);
      await expect(exact).toHaveAttribute('aria-invalid', 'true');
      await exact.press('Tab');
      await unchanged(page, restored);
      await exact.press('Escape');
      await expect(exact).toHaveValue(initial);
    }
    await resetSetting(row, name);
    await expect(exact).toHaveValue('0');
    await editAndUndo(page, restored, edited(restored.document, setting, 0, 'video-1', 180));
  }
  expect(await current(page)).toEqual(document);
  await previewAt(page, 30);
});

test('channel navigation skips unrelated keys and shares an off-duration cursor without editing the real playhead', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.keyframes = [
    sharedPoint(10, { temperature: 0 }),
    sharedPoint(20, { tint: -0.2 }),
    sharedPoint(30, { exposure: 0.5 }),
    sharedPoint(40, { temperature: 0.4 }),
    sharedPoint(50, { tint: 0 }),
    sharedPoint(130, { temperature: 0.6 }),
    sharedPoint(140, { tint: 0.4 }),
    sharedPoint(150, { opacity: 0.5 }),
    sharedPoint(180, { temperature: 0.8 }),
    sharedPoint(190, { tint: 0.6 }),
    sharedPoint(240, { temperature: 1 }),
    sharedPoint(250, { tint: 1 }),
    sharedPoint(260, { temperature: 0.9 }),
  ];
  await fixture(page, document);
  const before = await checkpoint(page);
  const next = navigation(page, 'Temperature', 'Next');
  const previous = navigation(page, 'Temperature', 'Previous');
  await expect(previous).toBeDisabled();
  for (const frame of [10, 40]) {
    await next.press('Enter');
    await previewAt(page, frame);
    await expect(next).toBeFocused();
    await expect(diamond(page, 'Temperature')).toHaveAttribute('aria-pressed', 'true');
  }
  await diamond(page, 'Temperature').focus();
  await page.keyboard.press('Tab');
  await expect(previous).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(controls(page, 'Temperature').slider).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const keys = layerKeyframes(page, 'Video track 1');
  for (const frame of [130, 180, 240]) {
    await next.press('Enter');
    await previewAt(page, 119);
    await expect(next).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(diamond(page, 'Temperature')).toHaveAttribute('aria-pressed', 'false');
    await expect(diamond(page, 'Temperature')).toHaveAttribute('title', /timeline frame 119\./);
    await expect(controls(page, 'Temperature').exact).toBeDisabled();
    await inspectorTab(page, 'Track keyframes');
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
      `Stored keyframe · timeline frame ${frame} · outside current duration`,
    );
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
      'Preview is at frame 119, not at this stored keyframe.',
    );
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute(
      'data-keyframe-frame',
      String(frame),
    );
    await inspectorTab(page, 'Clip');
  }
  // Terminal arrows remain native buttons: aria-disabled guards activation
  // and removes them from Tab order without discarding the activated focus.
  await next.press('Enter');
  await previewAt(page, 119);
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(next).toHaveJSProperty('disabled', false);
  await expect(next).toHaveAttribute('tabindex', '-1');
  for (const activation of ['Enter', 'Space']) {
    await next.press(activation);
    await expect(next).toBeFocused();
    await previewAt(page, 119);
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '260');
  }
  await previous.press('Space');
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 240');
  await inspectorTab(page, 'Clip');
  await previous.press('Space');
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 180');
  await inspectorTab(page, 'Clip');
  const tintNext = navigation(page, 'Tint', 'Next');
  for (const frame of [190, 250]) {
    await tintNext.press('Space');
    await previewAt(page, 119);
    await expect(tintNext).toBeFocused();
    await inspectorTab(page, 'Track keyframes');
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(`Stored keyframe · timeline frame ${frame}`);
    await inspectorTab(page, 'Clip');
  }
  await expect(tintNext).toHaveAttribute('aria-disabled', 'true');
  await expect(tintNext).toHaveJSProperty('disabled', false);
  await expect(tintNext).toHaveAttribute('tabindex', '-1');
  await tintNext.press('Enter');
  await expect(tintNext).toBeFocused();
  await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '250');
  for (const frame of [190, 140, 50, 20]) {
    await navigation(page, 'Tint', 'Previous').click();
    await previewAt(page, Math.min(frame, 119));
    if (frame === 50) {
      await expect(controls(page, 'Tint').exact).toHaveValue('0');
      await expect(diamond(page, 'Tint')).toHaveAttribute('aria-pressed', 'true');
    }
  }
  const tintPrevious = navigation(page, 'Tint', 'Previous');
  await expect(tintPrevious).toBeFocused();
  await expect(tintPrevious).toHaveAttribute('aria-disabled', 'true');
  await expect(tintPrevious).toHaveJSProperty('disabled', false);
  await expect(tintPrevious).toHaveAttribute('tabindex', '-1');
  await tintPrevious.press('Space');
  await expect(tintPrevious).toBeFocused();
  await previewAt(page, 20);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(await current(page)).toEqual(before.document);
  expect(memory.snapshot()).toEqual(before.saved);
  expect(memory.saves).toBe(before.saves);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
});
