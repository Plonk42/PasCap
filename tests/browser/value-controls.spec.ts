import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import type { AudioAsset } from '../../src/shared/audio.js';
import { COLOUR_CONTROLS } from '../../src/shared/colour.js';
import { applyCommand, type EditCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { editLayerPoint, expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

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
    '/api/media': { assets },
    '/api/audio': { assets: [music] },
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
    const pcm = /^\/api\/audio\/([^/]+)\/playback$/.exec(pathname);
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
  expect(music.metadata.frameCount).toBeGreaterThanOrEqual(120);
  document.music = [
    {
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
    },
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

const opacityEdit: ValueEdit = (_document, opacity) => ({ type: 'opacity', layerId: 'video-1', opacity });
const exposureEdit: ValueEdit = (document, exposure) => ({
  type: 'colour',
  layerId: document.layers[0]!.id,
  colour: { ...document.layers[0]!.colour, exposure },
});
const constantEdit: ValueEdit = (_document, rate) => ({
  type: 'speed',
  clipId: 'one',
  speed: { mode: 'constant', rate },
});
const gainEdit: ValueEdit = (document, gainDb) => ({
  type: 'music',
  music: document.music.map((track) => (track.id === 'value-music' ? { ...track, gainDb } : track)),
});

test('row Colour captures its base and keeps precise release-only edits identical across clip selection', async ({
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
  expect(changed.layers[0]!.colour.exposure).toBe(0.5);
  expect(changed.layers[0]!.keyframes[0]!.values.exposure).toBe(0.5);
  expect(changed.clips).toEqual(document.clips);
  await page.getByRole('button', { name: 'Keyframe Exposure', exact: true }).click();
  expect((await current(page)).layers[0]!.colour.exposure).toBe(0.5);
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
  expect(changed.layers[0]!.colour.exposure).toBe(0.5);
  expect(changed.clips).toEqual(document.clips);
});

test('empty rows expose all eight editable row appearance widgets and no clip colour scope', async ({ page }) => {
  const document = await current(page);
  document.clips = [];
  document.music = [];
  await fixture(page, document);
  await preciseEdit(page, 'Exposure', 0.123456789, exposureEdit);
  for (const name of ['Opacity', ...COLOUR_CONTROLS.map((control) => control.label)]) {
    await expect(page.getByRole('slider', { name, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: `Keyframe ${name}`, exact: true })).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: 'Clip correction', exact: true })).toHaveCount(0);
  expect((await current(page)).layers[0]!.colour).toEqual(document.layers[0]!.colour);
});

test('all main colour, Opacity, constant-rate and Gain sliders draft locally and release as exactly one edit', async ({
  page,
}) => {
  await pointerEdit(page, 'Opacity', opacityEdit);
  for (const control of COLOUR_CONTROLS) {
    await pointerEdit(page, control.label, (document, value) => ({
      type: 'colour',
      layerId: document.layers[0]!.id,
      colour: { ...document.layers[0]!.colour, [control.key]: value },
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
  const { exact, widget } = controls(page, 'Opacity');
  await expect(exact).toHaveValue('1');
  await expect(exact).toHaveAttribute('min', '0');
  await expect(exact).toHaveAttribute('max', '1');
  await expect(widget.getByText('0–1', { exact: true })).toBeVisible();
  const before = await checkpoint(page);
  for (const invalid of ['', '-0.1', '1.1']) {
    await exact.fill(invalid);
    await exact.press('Enter');
    await expect(exact).toHaveValue(invalid);
    await expect(exact).toHaveAttribute('aria-invalid', 'true');
    await expect(exact.locator('..').getByRole('alert')).toContainText(
      invalid === '' ? 'Enter a number' : invalid === '-0.1' ? 'Enter 0 or greater.' : 'Enter 1 or less.',
    );
    await unchanged(page, before);
    await exact.press('Escape');
    await expect(exact).toHaveValue('1');
  }
  await preciseEdit(page, 'Opacity', 0.123456789, opacityEdit);
  await preciseEdit(page, 'Exposure', 1.23456789, exposureEdit);
  await inspectorTab(page, 'Audio');
  await preciseEdit(page, 'Music gain', -7.123456789, gainEdit);
});

test('constant, ramp endpoints and custom-point rates use the same pointer and precise-number contract', async ({
  page,
}) => {
  await preciseEdit(page, 'Clip speed rate', 1.23456789, constantEdit);
  await page.getByRole('combobox', { name: 'Speed mode', exact: true }).selectOption('ramp-up');
  await ready(page, await current(page));
  for (const [name, key, value] of [
    ['Ramp start rate', 'startRate', 0.87654321],
    ['Ramp end rate', 'endRate', 2.34567891],
  ] as const) {
    const edit: ValueEdit = (document, rate) => {
      const speed = document.clips[0]!.speed;
      if (speed.mode !== 'ramp') throw new Error('Expected the explicitly selected clip ramp.');
      return { type: 'speed', clipId: 'one', speed: { ...speed, [key]: rate } };
    };
    await preciseEdit(page, name, value, edit);
    await pointerEdit(page, name, edit);
  }
  await page.getByRole('combobox', { name: 'Speed mode', exact: true }).selectOption('curve');
  await expect(page.getByRole('region', { name: 'Clip speed curve editor' })).toBeVisible();
  const selectedFrame = Number(
    await page.getByRole('spinbutton', { name: 'Clip speed keyframe source frame', exact: true }).inputValue(),
  );
  const edit: ValueEdit = (document, rate) => {
    const speed = document.clips[0]!.speed;
    if (speed.mode !== 'curve') throw new Error('Expected the explicitly selected clip curve.');
    return {
      type: 'speed',
      clipId: 'one',
      speed: {
        ...speed,
        keyframes: speed.keyframes.map((point) => (point.frame === selectedFrame ? { ...point, rate } : point)),
      },
    };
  };
  await preciseEdit(page, 'Clip speed keyframe rate', 1.987654321, edit);
  await pointerEdit(page, 'Clip speed keyframe rate', edit);
});

test('stored participants share the widgets, retain precise Speed and never join another channel or seek', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.keyframes = [
    sharedPoint(0, { opacity: 0.8, exposure: 0.2, speed: 1 }, 'ease-in'),
    sharedPoint(180, { speed: 1, exposure: 0.5 }, 'hold'),
  ];
  await fixture(page, document);
  const row = await editLayerPoint(page, 'Video 1', 0);
  for (const [setting, label, value] of [
    ['opacity', 'Opacity', 0.234567891],
    ['exposure', 'Exposure', 0.345678912],
    ['speed', 'Speed', 1.234567891],
  ] as const) {
    const edit: ValueEdit = (_document, nextValue) => ({
      type: 'layer-key-value',
      layerId: 'video-1',
      frame: 0,
      setting,
      value: nextValue,
    });
    await pointerEdit(page, `${label} keyframe value 0`, edit, row);
    await preciseEdit(page, `${label} keyframe value 0`, value, edit, row);
  }
  await expect(row.locator('.layer-keyframe-point-values').getByRole('slider')).toHaveCount(3);
  await expect(row.locator('.layer-keyframe-point-values').getByRole('spinbutton')).toHaveCount(3);
  await expect(row.getByRole('slider', { name: 'Saturation keyframe value 0', exact: true })).toHaveCount(0);
  const outside = await editLayerPoint(page, 'Video 1', 180);
  await preciseEdit(
    page,
    'Speed keyframe value 180',
    1.876543219,
    (_document, value) => ({ type: 'layer-key-value', layerId: 'video-1', frame: 180, setting: 'speed', value }),
    outside,
  );
  expect((await current(page)).layers).toEqual(document.layers);
  expect((await current(page)).clips).toEqual(document.clips);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
});

test('closing-fade Speed conflicts retain the final invalid draft, never an earlier valid value, and allow correction', async ({
  page,
}) => {
  for (const stored of [false, true]) {
    const document = memory.snapshot();
    document.layers[0]!.closingFade = 90;
    document.layers[0]!.keyframes = stored ? [sharedPoint(0, { speed: 1, exposure: 0.25 }, 'smooth')] : [];
    await fixture(page, document);
    const scope = stored ? await editLayerPoint(page, 'Video 1', 0) : page;
    const name = stored ? 'Speed keyframe value 0' : 'Clip speed rate';
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
      stored
        ? (_document, value) => ({ type: 'layer-key-value', layerId: 'video-1', frame: 0, setting: 'speed', value })
        : constantEdit,
      scope,
    );
    expect((await current(page)).layers[0]!.closingFade).toBe(90);
  }
});

test('identical-valued clip and row context replacements preserve input identity/focus but discard stale drafts', async ({
  page,
}) => {
  const document = await current(page);
  document.clips = [createClip('one', assets[0]!.id, 0, 60), { ...createClip('two', assets[1]!.id, 0, 60), start: 60 }];
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  document.layers.push(createLayer('empty', 'Empty row'));
  await fixture(page, document);
  for (const [name, target, value] of [
    ['Exposure', '[data-clip-id="two"] .timeline-clip-body', '0'],
    ['Opacity', '[aria-label="Select layer Empty row"]', '1'],
  ] as const) {
    const { exact } = controls(page, name);
    const id = await exact.getAttribute('id');
    await exact.fill('0.987654321');
    // Activate without a pointer-induced blur commit: the editing context itself must reset the mounted field.
    await page.locator(target).evaluate((button: HTMLButtonElement) => button.click());
    await expect(exact).toBeFocused();
    await expect(exact).toHaveAttribute('id', id!);
    await expect(exact).toHaveValue(value);
    await exact.press('Enter');
    await exact.press('Tab');
    expect(await current(page)).toEqual(document);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  }
  const before = await checkpoint(page);
  const { slider, exact, widget } = controls(page, 'Opacity');
  const id = await exact.getAttribute('id');
  const drag = await beginDrag(page, slider);
  await moveDrag(page, drag, 0.35);
  await expect(exact).toBeDisabled();
  await page
    .getByRole('button', { name: 'Select layer Video 1', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(widget).toHaveAttribute('data-pointer-draft', 'false');
  await expect(slider).toBeFocused();
  await expect(slider).toHaveValue('1');
  await expect(exact).toHaveAttribute('id', id!);
  await expect(exact).toHaveValue('1');
  await moveDrag(page, drag, 0.65);
  await page.mouse.up();
  await expect(exact).toBeEnabled();
  await unchanged(page, before);
  await pointerEdit(page, 'Opacity', opacityEdit);
});

test('animated channels without a playhead participant disable both inputs, not the explicit capture diamond', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.keyframes = [sharedPoint(10, { opacity: 1, exposure: 0, speed: 1 })];
  await fixture(page, document);
  const before = await checkpoint(page);
  for (const name of ['Opacity', 'Exposure', 'Layer speed rate']) {
    const { slider, exact } = controls(page, name);
    await expect(slider).toBeVisible();
    await expect(exact).toBeVisible();
    await expect(slider).toBeDisabled();
    await expect(exact).toBeDisabled();
    const label = name === 'Layer speed rate' ? 'Speed' : name;
    await expect(page.getByRole('button', { name: `Keyframe ${label}`, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: `Keyframe ${label}`, exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  }
  await unchanged(page, before);
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await ready(page, document);
  const { exact } = controls(page, 'Opacity');
  await expect(exact).toBeEnabled();
  await exact.fill('0.456789123');
  await page.evaluate(() => window.pascapLab!.engine.seek(0));
  await expect(exact).toBeDisabled();
  await expect(exact).toHaveValue('1');
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await expect(exact).toBeEnabled();
  await expect(exact).toHaveValue('1');
  await exact.press('Enter');
  await exact.press('Tab');
  expect(await current(page)).toEqual(document);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await page.getByRole('button', { name: 'Keyframe Opacity', exact: true }).click();
  expect((await current(page)).layers[0]!.keyframes).toEqual([sharedPoint(10, { exposure: 0, speed: 1 })]);
});

test('common widgets fit 270px inspectors and the desktop/drawer width matrix without overflow or document edits', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.keyframes = [sharedPoint(0, { opacity: 0.8, exposure: 0.2, speed: 1 })];
  await fixture(page, document);
  const resizer = page.getByRole('slider', { name: 'Resize Clip panel', exact: true });
  for (let index = 0; index < 4; index++) await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', '270');
  const inspector = page.getByRole('complementary', { name: 'Clip inspector', exact: true });
  const toggle = page.getByRole('button', { name: 'Toggle Clip panel', exact: true });
  const mediaToggle = page.getByRole('button', { name: 'Toggle Media panel', exact: true });
  for (const width of [1440, 1280, 1024, 900, 720]) {
    await page.setViewportSize({ width, height: 900 });
    if (width >= 980) {
      await expect(inspector).toBeVisible();
      expect((await inspector.boundingBox())!.width).toBe(270);
    } else {
      if ((await mediaToggle.getAttribute('aria-pressed')) === 'false') await mediaToggle.click();
      await expect(inspector).toBeHidden();
      await expect(page.getByRole('complementary', { name: 'Media library', exact: true })).toBeVisible();
      await toggle.click();
      await expect(inspector).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Media library', exact: true })).toBeHidden();
      await toggle.click();
      await expect(inspector).toBeHidden();
      await toggle.click();
      await expect(inspector).toBeVisible();
    }
    for (const tab of ['Clip', 'Layer keyframes', 'Audio'] as const) {
      await inspectorTab(page, tab);
      if (tab === 'Clip')
        await inspector
          .locator('.advanced-colour details')
          .first()
          .evaluate((element) => {
            (element as HTMLDetailsElement).open = true;
          });
      if (tab === 'Layer keyframes') await editLayerPoint(page, 'Video 1', 0);
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
              unitSeparated: !unit || number.right <= unit.left,
              sameRow: Math.abs(slider.y + slider.height / 2 - number.y - number.height / 2) < 1,
              separated: slider.right <= number.left,
              contained: container.left >= pane.left && container.right <= pane.right && container.right <= innerWidth,
              overflow: element.scrollWidth > element.clientWidth,
            };
          }),
      );
      expect(widgets.length, `${width}px ${tab}`).toBe(tab === 'Clip' ? 20 : tab === 'Layer keyframes' ? 3 : 1);
      for (const widget of widgets) {
        expect(widget.inputs, `${width}px ${widget.name}`).toBe(2);
        expect(widget.outputs).toBe(0);
        expect(widget.sliderWidth).toBeGreaterThanOrEqual(24);
        expect(widget.numberWidth).toBeGreaterThanOrEqual(76);
        expect(widget.sliderHeight).toBeGreaterThanOrEqual(28);
        expect(widget.appearance).toBe('none');
        expect(widget.numberFont).toBeGreaterThanOrEqual(12);
        expect(widget.unitSeparated).toBe(true);
        expect(widget.sameRow).toBe(true);
        expect(widget.separated).toBe(true);
        expect(widget.contained).toBe(true);
        expect(widget.overflow).toBe(false);
      }
      const name = tab === 'Clip' ? 'Opacity' : tab === 'Layer keyframes' ? 'Speed keyframe value 0' : 'Music gain';
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
