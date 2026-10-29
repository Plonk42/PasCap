import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import type { AudioAsset } from '../../src/shared/audio.js';
import { COLOUR_CONTROLS } from '../../src/shared/colour.js';
import { applyCommand, type EditCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  adjustmentFrom0,
  editAdjustmentPoint,
  editTransformKeyframe,
  expandedInspectorPreferences,
  gradePoint,
  inspectorTab,
  transformPoint,
} from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';
import { singleClipLane } from '../music-lanes.js';

let memory: MemoryProjects;
let assets: MediaAsset[];
let music: AudioAsset;
let unexpected: string[];
type ValueEdit = (document: ProjectDocument, value: number) => EditCommand;

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const videos = await request.get('/api/media');
  const audio = await request.get('/api/audio');
  expect(videos.ok()).toBe(true);
  expect(audio.ok()).toBe(true);
  const library = (await videos.json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources', name))
      throw new Error('Value controls require existing prepared synthetic videos; no real-media work is allowed.');
    return asset;
  });
  const prepared = ((await audio.json()) as { assets: AudioAsset[] }).assets.find(
    (asset) => asset.name === 'test-music.wav' && asset.status === 'ready',
  );
  if (!prepared || prepared.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/test-music.wav'))
    throw new Error('Value controls require the existing prepared synthetic WAV, without import or preparation.');
  music = prepared;

  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [music], missing: [] },
    '/api/jobs': { jobs: [] },
  };
  // Project routes registered below take precedence. No other writes reach the service.
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    const proxy = /^\/api\/media\/([^/]+)\/(proxy|thumbnail\/\d+)$/.exec(pathname);
    const pcm = /^\/api\/audio\/([^/]+)\/(?:playback|analysis)$/.exec(pathname);
    if (
      (method === 'GET' && proxy && assets.some((asset) => asset.id === proxy[1])) ||
      ((method === 'HEAD' || method === 'GET') && pcm && pcm[1] === music.id)
    ) {
      await route.continue();
      return;
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('value-controls-memory', 'Value controls · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.media.audioIds = [music.id];
  document.clips = [createClip('one', assets[0]!.id, 0, 120)];
  // One adjustment grades every track; it outlasts the clips some tests add.
  document.adjustments = [adjustmentFrom0(240)];
  expect(music.metadata.frameCount).toBeGreaterThanOrEqual(120);
  document.music = [
    singleClipLane({
      id: 'value-music',
      mediaId: music.id,
      sourceIn: 0,
      sourceOut: 120,
      start: 0,
      duration: 120,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    }),
  ];
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await ready(page, document);
});

test.afterEach(() => {
  expect(unexpected, 'No imports, preparation, native renders or real-store writes').toEqual([]);
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
    .toEqual({
      status: calculateLayout(document).duration ? 'paused' : 'empty',
      duration: calculateLayout(document).duration,
    });
  await expect(page.getByRole('tab', { name: 'Clip', exact: true })).toBeVisible();
}

/** Seed only the intercepted in-memory document, never reset the browser fixture cache. */
async function fixture(page: Page, document: ProjectDocument): Promise<void> {
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}

function controls(scope: Page | Locator, name: string) {
  const slider = scope.getByRole('slider', { name, exact: true });
  return { slider, exact: scope.getByRole('spinbutton', { name, exact: true }), widget: slider.locator('..') };
}

/** Track → Transform owns Opacity and stored Transform values; the Colour tab's adjustment owns Colour and its
 * stored keyframe values; Audio owns gain; Clip owns clip speed. */
async function showControl(page: Page, name: string): Promise<void> {
  if (name === 'Music gain') await inspectorTab(page, 'Audio');
  else if (/^Transform |^Opacity keyframe value/.test(name)) await inspectorTab(page, 'Track');
  else if (
    /keyframe value|^(Temperature|Tint|Exposure|Brightness|Contrast|Hue|Saturation|Vibrance|Highlights|Shadows|Whites|Blacks)$/.test(
      name,
    )
  )
    await inspectorTab(page, 'Adjustment');
  else if (/speed rate|rate$/i.test(name)) await inspectorTab(page, 'Clip');
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
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(before.frame);
}

async function committed(
  page: Page,
  before: Awaited<ReturnType<typeof checkpoint>>,
  expected: ProjectDocument,
): Promise<void> {
  expect(await current(page)).toEqual(expected);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(before.saves + 1);
  expect(memory.snapshot()).toEqual({ ...expected, revision: before.saved.revision + 1 });
  await ready(page, expected);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before.document);
  expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(before.undo);
  await ready(page, before.document);
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
      // Every shared value widget has the same 10px thumb inside its 28px native hit target.
      inset: 5 + Number.parseFloat(getComputedStyle(element).borderLeftWidth),
    };
  });
  // Native range thumbs inset their centres from the ends of the track.
  await page.mouse.move(
    box.x + geometry.inset + geometry.ratio * (box.width - 2 * geometry.inset),
    box.y + box.height / 2,
  );
  await page.mouse.down();
  const pointerId = Number(await slider.getAttribute('data-test-pointer-id'));
  // Chrome captures its UA-shadow range thumb, retargeting capture events to the input.
  // hasPointerCapture() on the public input is therefore false even during a real captured drag.
  await page.mouse.move(
    box.x + geometry.inset + geometry.ratio * (box.width - 2 * geometry.inset),
    box.y + box.height / 2,
  );
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

async function pointerEdit(page: Page, name: string, edit: ValueEdit, scope: Page | Locator = page): Promise<void> {
  await showControl(page, name);
  const { slider, exact, widget } = controls(scope, name);
  const before = await checkpoint(page);
  const initial = await slider.inputValue();
  const drag = await beginDrag(page, slider);
  for (const ratio of [0.35, 0.65]) {
    await moveDrag(page, drag, ratio);
    const draft = await slider.inputValue();
    expect(draft).not.toBe(initial);
    await expect(exact).toHaveValue(draft);
    await expect(exact).toBeDisabled();
    await expect(widget).toHaveAttribute('data-dirty', 'true');
    await unchanged(page, before);
  }
  const value = Number(await slider.inputValue());
  await page.mouse.up();
  await expect(widget).toHaveAttribute('data-pointer-draft', 'false');
  await expect(exact).toBeEnabled();
  await expect(exact).toHaveValue(String(value));
  await committed(page, before, applyCommand(before.document, edit(before.document, value)));
  await expect(slider).toHaveValue(initial);
}

async function preciseEdit(
  page: Page,
  name: string,
  value: number,
  edit: ValueEdit,
  scope: Page | Locator = page,
): Promise<void> {
  await showControl(page, name);
  const { exact } = controls(scope, name);
  const before = await checkpoint(page);
  const id = await exact.getAttribute('id');
  await exact.fill(String(value));
  await unchanged(page, before);
  await exact.press('Enter');
  await expect(exact).toBeFocused();
  await expect(exact).toHaveAttribute('id', id!);
  await expect(exact).toHaveValue(String(value));
  await exact.press('Tab');
  await committed(page, before, applyCommand(before.document, edit(before.document, value)));
}

const opacityEdit: ValueEdit = (_document, percent) => ({
  type: 'transform-setting',
  layerId: 'video-1',
  setting: 'opacity',
  value: percent / 100,
});
const exposureEdit: ValueEdit = (document, exposure) => ({
  type: 'colour',
  adjustmentId: 'adjustment',
  colour: { ...document.adjustments[0]!.colour, exposure },
});
const constantEdit: ValueEdit = (_document, rate) => ({
  type: 'speed',
  clipId: 'one',
  speed: { mode: 'constant', rate },
});
const gainEdit: ValueEdit = (document, gainDb) => ({
  type: 'music',
  music: document.music.map((track) => (track.id === 'value-music-track' ? { ...track, gainDb } : track)),
});

test('adjustment Colour captures its base and keeps precise release-only edits identical across clip selection', async ({
  page,
}) => {
  const document = await current(page);
  const second = { ...createClip('two', assets[1]!.id, 0, 120), start: 120 };
  document.clips.push(second);
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  await fixture(page, document);
  await page.locator('[data-clip-id="one"] .timeline-clip-body').click();
  await preciseEdit(page, 'Exposure', 0.5, exposureEdit);
  const base = controls(page, 'Exposure').exact;
  await base.fill('0.5');
  await base.press('Enter');
  await page.getByRole('button', { name: 'Keyframe Exposure', exact: true }).click();
  let changed = await current(page);
  expect(changed.adjustments[0]!.colour.exposure).toBe(0.5);
  expect(changed.adjustments[0]!.keyframes[0]!.values.exposure).toBe(0.5);
  expect(changed.clips).toEqual(document.clips);
  await page.getByRole('button', { name: 'Keyframe Exposure', exact: true }).click();
  expect((await current(page)).adjustments[0]!.colour.exposure).toBe(0.5);
  await expect(page.getByRole('button', { name: 'Clip correction', exact: true })).toHaveCount(0);
  await pointerEdit(page, 'Exposure', exposureEdit);
  await preciseEdit(page, 'Exposure', -0.123456789, exposureEdit);
  const before = await checkpoint(page);
  await base.fill('4');
  await base.press('Enter');
  await expect(base).toHaveValue('4');
  await unchanged(page, before);
  await base.press('Escape');
  await page.locator('[data-clip-id="two"] .timeline-clip-body').click();
  await expect(base).toHaveValue('0.5');
  changed = await current(page);
  expect(changed.adjustments[0]!.colour.exposure).toBe(0.5);
  expect(changed.clips).toEqual(document.clips);
});

test('an empty timeline exposes every adjustment Colour widget and Transform Opacity, and no clip colour scope', async ({
  page,
}) => {
  const document = await current(page);
  document.clips = [];
  document.music = [];
  await fixture(page, document);
  await preciseEdit(page, 'Exposure', 0.123456789, exposureEdit);
  for (const name of COLOUR_CONTROLS.map((control) => control.label)) {
    await expect(page.getByRole('slider', { name, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: `Keyframe ${name}`, exact: true })).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: 'Clip correction', exact: true })).toHaveCount(0);
  expect((await current(page)).adjustments[0]!.colour).toEqual(document.adjustments[0]!.colour);
  await showControl(page, 'Transform Opacity');
  await expect(page.getByRole('slider', { name: 'Transform Opacity', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Keyframe Opacity', exact: true })).toBeEnabled();
});

test('Colour groups its sliders under labelled headings, each with a one-step group Reset', async ({ page }) => {
  const document = await current(page);
  Object.assign(document.adjustments[0]!.colour, { exposure: 0.5, shadows: -0.2, hue: 30 });
  await fixture(page, document);
  await inspectorTab(page, 'Adjustment');
  const groups = {
    Colour: ['Temperature', 'Tint', 'Hue', 'Saturation', 'Vibrance'],
    Light: ['Exposure', 'Brightness', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks'],
    Effects: ['HDR', 'Local contrast'],
  };
  const colourControls = page.locator('.inspector-panel .colour-controls');
  await expect(colourControls.getByRole('group')).toHaveCount(3);
  for (const [name, sliders] of Object.entries(groups)) {
    const group = colourControls.getByRole('group', { name, exact: true });
    expect(
      await group.getByRole('slider').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
    ).toEqual(sliders);
  }
  const resetEffects = page.getByRole('button', { name: 'Reset the Effects group', exact: true });
  await expect(resetEffects).toHaveAttribute('aria-disabled', 'true');
  await expect(resetEffects).toHaveAttribute('title', 'Already at their default values.');
  const before = await checkpoint(page);
  await page.getByRole('button', { name: 'Reset the Light group', exact: true }).click();
  await committed(
    page,
    before,
    applyCommand(before.document, {
      type: 'colour',
      adjustmentId: 'adjustment',
      colour: { ...before.document.adjustments[0]!.colour, exposure: 0, shadows: 0 },
    }),
  );
});

test('all main colour, Opacity, constant-rate and Gain sliders draft locally and release as exactly one edit', async ({
  page,
}) => {
  // Twelve live-previewed drags: 44 s measured CI-like (software GL, two cores).
  test.setTimeout(240_000);
  await pointerEdit(page, 'Transform Opacity', opacityEdit);
  for (const control of COLOUR_CONTROLS) {
    await pointerEdit(page, control.label, (document, value) => ({
      type: 'colour',
      adjustmentId: 'adjustment',
      colour: { ...document.adjustments[0]!.colour, [control.key]: value },
    }));
  }
  await pointerEdit(page, 'Clip speed rate', constantEdit);
  await inspectorTab(page, 'Audio');
  await pointerEdit(page, 'Music gain', gainEdit);
});

for (const cancellation of ['Escape', 'pointercancel', 'lostcapture', 'windowblur'] as const) {
  test(`${cancellation} restores the thumb, exact readout and document; the next real gesture still works`, async ({
    page,
  }) => {
    await showControl(page, 'Exposure');
    const { slider, exact, widget } = controls(page, 'Exposure');
    const before = await checkpoint(page);
    const drag = await beginDrag(page, slider);
    await moveDrag(page, drag, 0.75);
    expect(await slider.inputValue()).not.toBe('0');
    await expect(exact).toHaveValue(await slider.inputValue());
    await expect(exact).toBeDisabled();
    await unchanged(page, before);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'windowblur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else if (cancellation === 'lostcapture') {
      // Transfer the actual native thumb capture away; releasing the public input cannot release a UA-shadow thumb.
      await widget.evaluate((element, id) => element.setPointerCapture(id), drag.pointerId);
      // Process the browser's pending capture transition, rather than synthesize lostpointercapture.
      await page.mouse.move(
        drag.box.x + drag.inset + 0.75 * (drag.box.width - 2 * drag.inset),
        drag.box.y + drag.box.height / 2 + 2,
        { steps: 2 },
      );
    } else {
      await slider.dispatchEvent('pointercancel', { pointerId: drag.pointerId, pointerType: 'mouse', isPrimary: true });
    }
    await expect(widget).toHaveAttribute('data-pointer-draft', 'false');
    await expect(slider).toHaveValue('0');
    await expect(exact).toHaveValue('0');
    await expect(exact).toBeEnabled();
    await page.mouse.up();
    await expect(exact).toBeEnabled();
    await unchanged(page, before);
    await pointerEdit(page, 'Exposure', exposureEdit);
  });
}

test('precise entry remains usable after window blur without the lost native release', async ({ page }) => {
  await showControl(page, 'Exposure');
  const { slider, exact } = controls(page, 'Exposure');
  const before = await checkpoint(page);
  const drag = await beginDrag(page, slider);
  await moveDrag(page, drag, 0.75);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(exact).toBeEnabled();
  await exact.fill('1.23456789');
  await exact.press('Enter');
  const expected = applyCommand(before.document, exposureEdit(before.document, 1.23456789));
  expect(await current(page)).toEqual(expected);
  await moveDrag(page, drag, 0.9);
  await page.mouse.up();
  expect(await current(page)).toEqual(expected);
  await committed(page, before, expected);
});

test('main exact Opacity, exposure and Gain preserve full precision; Enter then blur saves only once', async ({
  page,
}) => {
  await showControl(page, 'Transform Opacity');
  const { slider, exact, widget } = controls(page, 'Transform Opacity');
  await expect(slider).toHaveValue('100');
  await expect(slider).toHaveAttribute('min', '0');
  await expect(slider).toHaveAttribute('max', '100');
  await expect(slider).toHaveAttribute('step', '1');
  await expect(exact).toHaveValue('100');
  await expect(exact).toHaveAttribute('min', '0');
  await expect(exact).toHaveAttribute('max', '100');
  await expect(widget.getByText('%', { exact: true })).toBeVisible();
  const before = await checkpoint(page);
  for (const invalid of ['', '-0.1', '100.1']) {
    await exact.fill(invalid);
    await exact.press('Enter');
    await expect(exact).toHaveValue(invalid);
    await expect(exact).toHaveAttribute('aria-invalid', 'true');
    await expect(exact.locator('..').getByRole('alert')).toContainText(
      invalid === '' ? 'Enter a number' : invalid === '-0.1' ? 'Enter 0 or greater.' : 'Enter 100 or less.',
    );
    await unchanged(page, before);
    await exact.press('Escape');
    await expect(exact).toHaveValue('100');
  }
  await preciseEdit(page, 'Transform Opacity', 12.3456789, opacityEdit);
  await preciseEdit(page, 'Exposure', 1.23456789, exposureEdit);
  await inspectorTab(page, 'Audio');
  await preciseEdit(page, 'Music gain', -7.123456789, gainEdit);
});

test('stepping an exact field with its arrows commits at once, without Enter or leaving the field', async ({
  page,
}) => {
  await showControl(page, 'Exposure');
  const { exact } = controls(page, 'Exposure');
  const before = await checkpoint(page);
  await exact.focus();
  await exact.press('ArrowUp');
  await expect(exact).toBeFocused();
  await expect(exact).toHaveValue('0.01');
  await committed(page, before, applyCommand(before.document, exposureEdit(before.document, 0.01)));
});

test('main and stored Opacity percentages reject invalid entries, cancel drafts and reset without changing fractional bases or other keys', async ({
  page,
}) => {
  for (const stored of [false, true]) {
    const document = await current(page);
    document.layers[0]!.transform.base.opacity = 0.75;
    document.layers[0]!.transform.keyframes = stored
      ? [transformPoint(0, { opacity: 0.8, scale: 1.2 }), transformPoint(180, { opacity: 0.4 })]
      : [];
    await fixture(page, document);
    const scope = stored ? await editTransformKeyframe(page, 0) : page;
    const name = stored ? 'Opacity keyframe value 0' : 'Transform Opacity';
    await showControl(page, name);
    const { slider, exact, widget } = controls(scope, name);
    const before = await checkpoint(page);
    const initial = stored ? '80' : '75';
    await expect(slider).toHaveValue(initial);
    await expect(exact).toHaveValue(initial);
    await expect(widget.getByText('%', { exact: true })).toBeVisible();
    for (const invalid of ['', '-1', '100.000000001']) {
      await exact.fill(invalid);
      await exact.press('Enter');
      await expect(exact).toHaveValue(invalid);
      await expect(exact).toHaveAttribute('aria-invalid', 'true');
      await exact.press('Tab');
      await unchanged(page, before);
      await exact.press('Escape');
      await expect(exact).toHaveValue(initial);
    }
    const drag = await beginDrag(page, slider);
    await moveDrag(page, drag, 0.35);
    await expect(slider).toHaveValue('35');
    await expect(exact).toHaveValue('35');
    await unchanged(page, before);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(slider).toHaveValue(initial);
    await expect(exact).toHaveValue(initial);
    await unchanged(page, before);
    const edit: ValueEdit = stored
      ? (document, percent) => {
          const transform = document.layers[0]!.transform;
          return {
            type: 'transform',
            layerId: 'video-1',
            transform: {
              ...transform,
              keyframes: transform.keyframes.map((point) =>
                point.frame === 0 ? { ...point, values: { ...point.values, opacity: percent / 100 } } : point,
              ),
            },
          };
        }
      : opacityEdit;
    await preciseEdit(page, name, 12.3456789, edit, scope);
    const beforeReset = await checkpoint(page);
    await scope.locator(`[id="${await slider.getAttribute('id')}-name"]`).dblclick();
    await expect(slider).toHaveValue('100');
    await expect(exact).toHaveValue('100');
    await committed(page, beforeReset, applyCommand(beforeReset.document, edit(beforeReset.document, 100)));
    await expect(exact).toHaveValue(initial);
  }
});

test('constant, keyed main and custom-point rates use the same pointer and precise-number contract', async ({
  page,
}) => {
  await preciseEdit(page, 'Clip speed rate', 1.23456789, constantEdit);
  await page.getByRole('combobox', { name: 'Speed mode', exact: true }).selectOption('curve');
  await expect(page.getByRole('region', { name: 'Clip speed curve editor' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keyframe Speed', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const keyEdit =
    (frame: number): ValueEdit =>
    (document, rate) => {
      const speed = document.clips[0]!.speed;
      if (speed.mode !== 'curve') throw new Error('Expected the explicitly selected clip curve.');
      return {
        type: 'speed',
        clipId: 'one',
        speed: {
          ...speed,
          keyframes: speed.keyframes.map((point) => (point.frame === frame ? { ...point, rate } : point)),
        },
      };
    };
  await preciseEdit(page, 'Clip speed rate', 0.87654321, keyEdit(0));
  await pointerEdit(page, 'Clip speed rate', keyEdit(0));
  const selectedFrame = Number(
    await page.getByRole('spinbutton', { name: 'Clip speed keyframe source frame', exact: true }).inputValue(),
  );
  await preciseEdit(page, 'Clip speed keyframe rate', 1.987654321, keyEdit(selectedFrame));
  await pointerEdit(page, 'Clip speed keyframe rate', keyEdit(selectedFrame));
});

test('stored keyframe values share the widgets, retain precise values and never join another setting or seek', async ({
  page,
}) => {
  const document = await current(page);
  document.adjustments[0]!.keyframes = [
    gradePoint(0, { saturation: 0.8, exposure: 0.2, contrast: 1 }, 'ease-in'),
    gradePoint(180, { contrast: 1, exposure: 0.5 }, 'hold'),
  ];
  await fixture(page, document);
  const row = await editAdjustmentPoint(page, 0);
  for (const [setting, label, value] of [
    ['saturation', 'Saturation', 0.234567891],
    ['exposure', 'Exposure', 0.345678912],
    ['contrast', 'Contrast', 1.234567891],
  ] as const) {
    const edit: ValueEdit = (_document, nextValue) => ({
      type: 'layer-key-value',
      adjustmentId: 'adjustment',
      frame: 0,
      setting,
      value: nextValue,
    });
    await pointerEdit(page, `${label} keyframe value 0`, edit, row);
    await preciseEdit(page, `${label} keyframe value 0`, value, edit, row);
  }
  await expect(row.locator('.layer-keyframe-point-values').getByRole('slider')).toHaveCount(3);
  await expect(row.locator('.layer-keyframe-point-values').getByRole('spinbutton')).toHaveCount(3);
  await expect(row.getByRole('slider', { name: 'Hue keyframe value 0', exact: true })).toHaveCount(0);
  const outside = await editAdjustmentPoint(page, 180);
  await preciseEdit(
    page,
    'Contrast keyframe value 180',
    1.876543219,
    (_document, value) => ({
      type: 'layer-key-value',
      adjustmentId: 'adjustment',
      frame: 180,
      setting: 'contrast',
      value,
    }),
    outside,
  );
  expect((await current(page)).adjustments).toEqual(document.adjustments);
  expect((await current(page)).layers).toEqual(document.layers);
  expect((await current(page)).clips).toEqual(document.clips);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
});

test('closing-fade Speed conflicts retain the final invalid draft, never an earlier valid value, and allow correction', async ({
  page,
}) => {
  for (const keyed of [false, true]) {
    const document = memory.snapshot();
    document.layers[0]!.closingFade = 90;
    document.clips[0]!.speed = keyed
      ? { mode: 'curve', keyframes: [{ frame: 0, rate: 1, interpolation: 'smooth' }] }
      : { mode: 'constant', rate: 1 };
    await fixture(page, document);
    const scope = page;
    const name = 'Clip speed rate';
    const { slider, exact, widget } = controls(scope, name);
    const before = await checkpoint(page);
    const drag = await beginDrag(page, slider);
    await moveDrag(page, drag, (1.2 - 0.1) / 7.9);
    await expect(slider).toHaveValue('1.2');
    await expect(slider).toHaveAttribute('aria-invalid', 'false');
    await unchanged(page, before);
    await moveDrag(page, drag, 1);
    await expect(slider).toHaveValue('8');
    await expect(exact).toHaveValue('8');
    await expect(exact).toBeDisabled();
    await expect(slider).toHaveAttribute('aria-invalid', 'true');
    await expect(widget.getByRole('alert')).toContainText('Fade/transition regions overlap or exceed clip one.');
    await unchanged(page, before);
    await page.mouse.up();
    await expect(exact).toBeEnabled();
    await expect(slider).toHaveValue('8');
    await expect(widget.getByRole('alert')).toContainText('Press Escape on the slider to restore 1.');
    await unchanged(page, before);
    await exact.fill('7.987654321');
    await exact.press('Enter');
    await expect(exact).toBeFocused();
    await expect(exact).toHaveValue('7.987654321');
    await expect(exact).toHaveAttribute('aria-invalid', 'true');
    await expect(exact.locator('..').getByRole('alert')).toContainText('Fade/transition regions overlap');
    await exact.press('Tab');
    await unchanged(page, before);
    await preciseEdit(
      page,
      name,
      1.234567891,
      keyed
        ? (_document, rate) => ({
            type: 'speed',
            clipId: 'one',
            speed: { mode: 'curve', keyframes: [{ frame: 0, rate, interpolation: 'smooth' }] },
          })
        : constantEdit,
      scope,
    );
    expect((await current(page)).layers[0]!.closingFade).toBe(90);
  }
});

test('identical-valued clip-grade and track context replacements discard stale drafts; the clip grade keeps input identity/focus', async ({
  page,
}) => {
  const document = await current(page);
  document.clips = [createClip('one', assets[0]!.id, 0, 60), { ...createClip('two', assets[1]!.id, 0, 60), start: 60 }];
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  document.layers.push(createLayer('empty', 'Empty row'));
  await fixture(page, document);
  await page.locator('[data-clip-id="one"] .timeline-clip-body').click();
  const pristine = async () => {
    expect(await current(page)).toEqual(document);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  };
  // Exposure edits the selected clip's grade: another clip keeps the mounted field and discards its draft.
  await inspectorTab(page, 'Clip grade');
  const grade = controls(page, 'Exposure');
  const gradeId = await grade.exact.getAttribute('id');
  await grade.exact.fill('0.987654321');
  // Activate without a pointer-induced blur commit: the editing context itself must reset the mounted field.
  await page
    .locator('[data-clip-id="two"] .timeline-clip-body')
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(grade.exact).toBeFocused();
  await expect(grade.exact).toHaveAttribute('id', gradeId!);
  await expect(grade.exact).toHaveValue('0');
  await grade.exact.press('Enter');
  await grade.exact.press('Tab');
  await pristine();
  // Track → Transform remounts for another track, as it did before Opacity joined it: the draft never reaches it.
  await showControl(page, 'Transform Opacity');
  const opacity = controls(page, 'Transform Opacity');
  await opacity.exact.fill('0.987654321');
  await page.locator('[aria-label="Select track Empty row"]').evaluate((button: HTMLButtonElement) => button.click());
  await expect(opacity.exact).toHaveValue('100');
  await opacity.exact.press('Enter');
  await opacity.exact.press('Tab');
  await pristine();
  // A clip change also cancels a pointer draft without committing, keeping the slider identity and focus.
  await page.locator('[data-clip-id="one"] .timeline-clip-body').click();
  await inspectorTab(page, 'Clip grade');
  const before = await checkpoint(page);
  const { slider, exact, widget } = controls(page, 'Exposure');
  const id = await exact.getAttribute('id');
  const drag = await beginDrag(page, slider);
  await moveDrag(page, drag, 0.35);
  await expect(exact).toBeDisabled();
  await page
    .locator('[data-clip-id="two"] .timeline-clip-body')
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(widget).toHaveAttribute('data-pointer-draft', 'false');
  await expect(slider).toBeFocused();
  await expect(slider).toHaveValue('0');
  await expect(exact).toHaveAttribute('id', id!);
  await expect(exact).toHaveValue('0');
  await moveDrag(page, drag, 0.65);
  await page.mouse.up();
  await expect(exact).toBeEnabled();
  expect(await current(page)).toEqual(before.document);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(before.saves);
  await pointerEdit(page, 'Exposure', exposureEdit);
});

test('keyboard focus and native reveal clear the sticky inspector tabs at the default and minimum viewports', async ({
  page,
}) => {
  await showControl(page, 'Exposure');
  const before = await checkpoint(page);
  const { slider } = controls(page, 'Exposure');
  const diamond = page.getByRole('button', { name: 'Keyframe Exposure', exact: true });
  // Park the control entirely beneath the sticky tabs, which still lie inside the scrollport.
  const tuck = () =>
    slider.evaluate((element) => {
      const panel = element.closest('.inspector-panel')!;
      const heading = panel.querySelector(':scope > .panel-heading')!.getBoundingClientRect();
      panel.scrollTop += element.getBoundingClientRect().y - heading.y;
    });
  const unobscured = (element: Element) => {
    const heading = element.closest('.inspector-panel')!.querySelector(':scope > .panel-heading')!;
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.top >= heading.getBoundingClientRect().bottom && hit !== null && element.contains(hit);
  };
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect(slider).toBeVisible();
    await tuck();
    await diamond.evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
    await page.keyboard.press('Shift+Tab');
    expect(await page.locator(':focus').evaluate(unobscured)).toBe(true);
    await tuck();
    await slider.scrollIntoViewIfNeeded();
    expect(await slider.evaluate(unobscured)).toBe(true);
  }
  await unchanged(page, before);
});

test('animated channels without a playhead participant disable both inputs, not the explicit capture diamond', async ({
  page,
}) => {
  const document = await current(page);
  document.adjustments[0]!.keyframes = [gradePoint(10, { exposure: 0 })];
  document.layers[0]!.transform.keyframes = [transformPoint(10, { opacity: 1 })];
  document.clips[0]!.speed = { mode: 'curve', keyframes: [{ frame: 10, rate: 1, interpolation: 'linear' }] };
  await fixture(page, document);
  const before = await checkpoint(page);
  for (const name of ['Transform Opacity', 'Exposure', 'Clip speed rate']) {
    await showControl(page, name);
    const { slider, exact } = controls(page, name);
    await expect(slider).toBeVisible();
    await expect(exact).toBeVisible();
    await expect(slider).toBeDisabled();
    await expect(exact).toBeDisabled();
    const label = { 'Clip speed rate': 'Speed', 'Transform Opacity': 'Opacity' }[name] ?? name;
    await expect(page.getByRole('button', { name: `Keyframe ${label}`, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: `Keyframe ${label}`, exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  }
  await unchanged(page, before);
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await ready(page, document);
  await showControl(page, 'Transform Opacity');
  const { exact } = controls(page, 'Transform Opacity');
  await expect(exact).toBeEnabled();
  await exact.fill('45.6789123');
  await page.evaluate(() => window.pascapLab!.engine.seek(0));
  await expect(exact).toBeDisabled();
  await expect(exact).toHaveValue('100');
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await expect(exact).toBeEnabled();
  await expect(exact).toHaveValue('100');
  await exact.press('Enter');
  await exact.press('Tab');
  expect(await current(page)).toEqual(document);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await page.getByRole('button', { name: 'Keyframe Opacity', exact: true }).click();
  expect((await current(page)).layers[0]!.transform.keyframes).toEqual([]);
  expect((await current(page)).adjustments).toEqual(document.adjustments);
});

test('common widgets fit 270px inspectors at the default and minimum viewports without overflow or document edits', async ({
  page,
}) => {
  const document = await current(page);
  document.adjustments[0]!.keyframes = [gradePoint(0, { saturation: 0.8, exposure: 0.2, contrast: 1 })];
  await fixture(page, document);
  const resizer = page.getByRole('slider', { name: 'Resize Properties panel', exact: true });
  for (let index = 0; index < 4; index++) await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', '270');
  const inspector = page.getByRole('complementary', { name: 'Properties', exact: true });
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect(inspector).toBeVisible();
    expect((await inspector.boundingBox())!.width).toBe(270);
    for (const tab of ['Clip', 'Clip grade', 'Adjustment', 'Track', 'Audio'] as const) {
      await inspectorTab(page, tab);
      if (tab === 'Clip grade' || tab === 'Adjustment') {
        const hsl = inspector.getByRole('button', { name: 'HSL ranges section', exact: true });
        if ((await hsl.getAttribute('aria-expanded')) !== 'true') await hsl.click();
      }
      if (tab === 'Adjustment') await editAdjustmentPoint(page, 0);
      const widgets = await inspector.locator('.value-control').evaluateAll((elements) =>
        elements
          .filter((element) => element.getBoundingClientRect().height > 0)
          .map((element) => {
            const range = element.querySelector<HTMLInputElement>('input[type="range"]')!;
            const exact = element.querySelector<HTMLInputElement>('input[type="number"]')!;
            const container = element.getBoundingClientRect();
            const slider = range.getBoundingClientRect();
            const number = exact.getBoundingClientRect();
            const pane = element.closest('aside')!.getBoundingClientRect();
            const unit = element.querySelector('.value-control-unit')?.getBoundingClientRect();
            return {
              name: range.getAttribute('aria-label'),
              inputs: element.querySelectorAll('input').length,
              outputs: element.querySelectorAll('output').length,
              sliderWidth: slider.width,
              numberWidth: number.width,
              sliderHeight: slider.height,
              appearance: getComputedStyle(range).appearance,
              numberFont: Number.parseFloat(getComputedStyle(exact).fontSize),
              unitInside: !unit || (unit.left > number.left + number.width / 2 && unit.right <= number.right),
              sameRow: Math.abs(slider.y + slider.height / 2 - number.y - number.height / 2) < 1,
              separated: slider.right <= number.left,
              contained: container.left >= pane.left && container.right <= pane.right && container.right <= innerWidth,
              overflow: element.scrollWidth > element.clientWidth,
            };
          }),
      );
      // Clip: speed rate and three Detail values; clip grade: fourteen Colour and three HSL; adjustment: fourteen
      // Colour, three HSL and three stored values; Track: nine Transform settings including Opacity; Audio: gain.
      const expected = { Clip: 4, 'Clip grade': 17, Adjustment: 20, Track: 9, Audio: 1 }[tab];
      expect(widgets.length, `${width}px ${tab}`).toBe(expected);
      for (const widget of widgets) {
        expect(widget.inputs, `${width}px ${widget.name}`).toBe(2);
        expect(widget.outputs).toBe(0);
        expect(widget.sliderWidth).toBeGreaterThanOrEqual(24);
        expect(widget.numberWidth).toBeGreaterThanOrEqual(76);
        expect(widget.sliderHeight).toBeGreaterThanOrEqual(28);
        expect(widget.appearance).toBe('none');
        expect(widget.numberFont).toBeGreaterThanOrEqual(12);
        expect(widget.unitInside).toBe(true);
        expect(widget.sameRow).toBe(true);
        expect(widget.separated).toBe(true);
        expect(widget.contained).toBe(true);
        expect(widget.overflow).toBe(false);
      }
      const name = {
        Clip: 'Clip speed rate',
        'Clip grade': 'Local contrast',
        Adjustment: 'Contrast keyframe value 0',
        Track: 'Transform Rotation',
        Audio: 'Music gain',
      }[tab];
      const { exact } = controls(inspector, name);
      await exact.scrollIntoViewIfNeeded();
      await expect(exact).toBeInViewport();
    }
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(await current(page)).toEqual(document);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
