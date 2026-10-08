import { expect, test, type Page } from '@playwright/test';
import { COLOUR_CONTROLS } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import {
  clipAction,
  editLayerPoint,
  expandedInspectorPreferences,
  inspectorTab,
  layerKeyframes,
  openOptions,
  sharedPoint,
} from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let assets: MediaAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];
const sliderInstructions =
  'Drag to choose a value; release to apply once. Escape cancels the drag. Exact values apply on Enter or blur.';

test.beforeEach(async ({ page, request }) => {
  unexpectedApi = [];
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset) throw new Error('Shared-point browser tests require the dedicated prepared synthetic fixtures.');
    return asset;
  });

  // Isolate every control API. Only existing synthetic proxy/thumbnail GETs may reach the fixture server.
  const payloads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets },
    '/api/audio': { assets: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && payloads[pathname] !== undefined) {
      await route.fulfill({ json: payloads[pathname] });
      return;
    }
    const media = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
    if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) {
      await route.continue();
      return;
    }
    unexpectedApi.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  let document = createProject('preview-lab', 'Shared row points · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document = applyCommand(document, { type: 'insert', clip: createClip('first', assets[0]!.id, 0, 60), index: 0 });
  document = applyCommand(document, { type: 'insert', clip: createClip('second', assets[1]!.id, 30, 90), index: 1 });
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.goto('/?project=preview-lab');
  await ready(page, document);
});

test.afterEach(() => {
  expect(unexpectedApi, 'No preparation, import, export, reference or unowned API requests').toEqual([]);
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function ready(page: Page, document: ProjectDocument): Promise<void> {
  await page.waitForFunction((duration) => {
    const state = window.pascapLab?.engine.diagnostics();
    return state?.status === 'paused' && state.duration === duration;
  }, calculateLayout(document).duration);
  await inspectorTab(page, 'Layer keyframes');
  await expect(layerKeyframes(page, 'Video 1')).toBeVisible();
  await inspectorTab(page, 'Clip');
}

async function fixture(page: Page, document: ProjectDocument): Promise<void> {
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame };
      }),
    )
    .toEqual({ status: 'paused', frame });
}

function diamond(page: Page, label: string) {
  return page
    .getByRole('complementary', { name: 'Clip inspector', exact: true })
    .getByRole('button', { name: `Keyframe ${label}`, exact: true });
}

for (const target of ['video-1', 'empty'] as const) {
  test(`the sole Colour Opacity slider edits the ${target === 'empty' ? 'empty' : 'multi-clip'} row in one Undo`, async ({
    page,
  }) => {
    let document = await current(page);
    document = applyCommand(document, {
      type: 'transition',
      transition: { leftId: 'first', rightId: 'second', type: 'cross-dissolve', duration: 8 },
    });
    document = applyCommand(document, { type: 'fades', layerId: 'video-1', opening: 2, closing: 3 });
    document = applyCommand(document, { type: 'layer-add', layer: createLayer('empty', 'Empty row') });
    await fixture(page, document);
    const layerName = target === 'empty' ? 'Empty row' : 'Video 1';
    await page.getByRole('button', { name: `Select layer ${layerName}`, exact: true }).click();
    await inspectorTab(page, 'Clip');
    const opacity = page.getByRole('slider', { name: 'Opacity', exact: true });
    await expect(opacity).toHaveCount(1);
    await expect(opacity).toBeVisible();
    await expect(opacity).toBeEnabled();
    await expect(opacity).toHaveValue('1');
    await expect(page.getByRole('button', { name: 'Placement section', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await page.evaluate(() => localStorage.getItem('pascap-section-layer-opacity'))).toBe('open');
    const colourSection = page.locator('section.inspector-section').filter({ has: opacity });
    await expect(colourSection.getByRole('button', { name: 'Colour section', exact: true })).toBeVisible();
    const placement = page.locator('section.inspector-section').filter({
      has: page.getByRole('button', { name: 'Placement section', exact: true }),
    });
    await expect(placement.getByRole('slider', { name: 'Opacity', exact: true })).toHaveCount(0);
    await expect(placement.getByRole('spinbutton', { name: 'Opacity', exact: true })).toHaveCount(0);
    await expect(page.locator('.layer-control input[aria-label="Opacity"]')).toHaveCount(0);
    await expect(colourSection.locator('input[aria-label="Opacity"]')).toHaveCount(2);
    await expect(opacity.locator('..').getByRole('spinbutton', { name: 'Opacity', exact: true })).toHaveValue('1');
    await expect(opacity.locator('..').getByText('0–1', { exact: true })).toBeVisible();
    await expect(
      colourSection.locator('.colour-control').filter({ has: opacity }).getByText('Not animated', { exact: true }),
    ).toHaveCount(1);
    await expect(opacity).toHaveAccessibleDescription(
      `Editing Opacity. Add keyframes to animate this setting on the row. Exact Opacity uses 0–1; 1 is 100%. ${sliderInstructions}`,
    );
    await expect(diamond(page, 'Opacity')).toHaveAttribute('aria-pressed', 'false');
    const before = await current(page);
    const layout = calculateLayout(before);
    await opacity.fill('0.35');
    const changed = await current(page);
    expect(changed.clips).toEqual(before.clips);
    expect(changed.layers).toEqual(
      before.layers.map((layer) => (layer.id === target ? { ...layer, opacity: 0.35 } : layer)),
    );
    expect(changed.layers.every((layer) => layer.keyframes.length === 0)).toBe(true);
    expect(changed.clips.every((clip) => !('opacity' in clip))).toBe(true);
    expect(calculateLayout(changed).clips.map(({ start, end }) => [start, end])).toEqual(
      layout.clips.map(({ start, end }) => [start, end]),
    );
    expect(calculateLayout(changed).duration).toBe(layout.duration);
    for (const frame of [0, 56, layout.duration - 1]) {
      const samples = sampleTimeline(changed, frame);
      expect(samples).toHaveLength(frame === 56 ? 2 : 1);
      expect(samples.map((sample) => sample.opacity)).toEqual(samples.map(() => (target === 'video-1' ? 0.35 : 1)));
      expect(samples.map(({ opacity: _opacity, ...sample }) => sample)).toEqual(
        sampleTimeline(before, frame).map(({ opacity: _opacity, ...sample }) => sample),
      );
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await current(page)).toEqual(before);
    await expect(opacity).toHaveValue('1');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(await current(page)).toEqual(changed);
  });
}

test('setting tooltips and accessible descriptions explain the editable keyframe and read-only animation states', async ({
  page,
}) => {
  const document = await current(page);
  document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0, opacity: 0.8, speed: 1 })];
  await fixture(page, document);
  for (const frame of [0, 10]) {
    await seek(page, frame);
    const scope = frame === 10 ? 'Keyframe at playhead' : 'Animated · add a keyframe to edit';
    for (const [label, role, name] of [
      ['Exposure', 'slider', 'Exposure'],
      ['Opacity', 'slider', 'Opacity'],
      ['Speed', 'spinbutton', 'Layer speed rate'],
    ] as const) {
      const hint =
        frame === 10
          ? `Editable keyframe at timeline frame 10. Edits change only ${label} at this shared layer point.`
          : `Read-only animated value at timeline frame 0. Click the ${label} diamond to add a keyframe here, then edit the value.`;
      const field = page.getByRole(role, { name, exact: true });
      if (role === 'slider') {
        const opacityHint = label === 'Opacity' ? ' Exact Opacity uses 0–1; 1 is 100%.' : '';
        await expect(field).toHaveAccessibleDescription(`${hint}${opacityHint} ${sliderInstructions}`);
      } else {
        await expect(field).toHaveAccessibleDescription(
          '1× is recorded speed. Custom curve points belong to one clip and use original source frames; drag a point or enter its exact frame/rate. Their positions stay anchored when trimming or splitting. The logarithmic graph spans 0.1×–8×. Slow motion repeats recorded frames, without generated optical-flow images. ' +
            `Enter or leave the field to apply. Escape restores the current value. ${hint}`,
        );
      }
      if (frame === 10) await expect(field).toBeEnabled();
      else await expect(field).toBeDisabled();
      if (role === 'slider')
        await expect(page.locator(`label[for="${await field.getAttribute('id')}"]`)).toHaveAttribute('title', hint);
    }
    await expect(page.locator('[id$="-clip-panel"] .layer-setting-kind').filter({ hasText: scope })).toHaveCount(3);
    await openOptions(page, 'Layer options Video 1');
    const options = page.getByRole('group', { name: 'Layer options Video 1', exact: true });
    await expect(options.getByRole('slider')).toHaveCount(0);
    await expect(options.getByRole('button', { name: /Opacity keyframe/ })).toHaveCount(0);
    await expect(options.getByRole('checkbox', { name: /Ripple/ })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  expect(await current(page)).toEqual(document);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

/** Paused capture checks the actual decoder positions, not just the shared sampler's expected values. */
async function captureAt(page: Page, frame: number) {
  await seek(page, frame);
  return page.evaluate(() => {
    const engine = window.pascapLab!.engine;
    const pixels = engine.capturePixels();
    let pixelSum = 0;
    for (let index = 0; index < pixels.length; index += 4)
      pixelSum += pixels[index]! + pixels[index + 1]! + pixels[index + 2]!;
    return {
      state: engine.diagnostics(),
      pixelSum,
      sourceFrames: Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'), (video) =>
        Math.floor((video.currentTime * 30000) / 1001 + 1e-7),
      ),
    };
  });
}

test('the first hollow diamond creates one point; same-frame channels merge independently and last removal deletes its marker', async ({
  page,
}) => {
  await seek(page, 20);
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.4');
  await page.getByRole('slider', { name: 'Opacity', exact: true }).fill('0.7');
  await expect(page.getByRole('slider', { name: 'Layer opacity', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Clip opacity', exact: true })).toHaveCount(0);
  const baseRate = page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true });
  await baseRate.fill('1.25');
  await baseRate.press('Enter');
  const bases = await current(page);
  expect(bases.schemaVersion).toBe(12);
  expect(bases.layers[0]!.opacity).toBe(0.7);
  expect(bases.clips.every((clip) => !('opacity' in clip))).toBe(true);
  expect(bases.layers[0]?.keyframes).toEqual([]);
  await expect(
    page.getByRole('combobox', { name: 'Speed mode', exact: true }).locator('option[value="keyframes"]'),
  ).toHaveCount(0);

  const exposure = diamond(page, 'Exposure');
  await expect(exposure).toBeEnabled();
  await expect(exposure).toHaveAttribute('aria-pressed', 'false');
  await expect(exposure.locator('[aria-hidden="true"]')).toHaveText('◇');
  await exposure.focus();
  await exposure.press('Space');
  expect((await current(page)).layers[0]?.keyframes).toEqual([sharedPoint(20, { exposure: 0.4 })]);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().playing)).toBe(false);
  await expect(exposure).toHaveAttribute('aria-pressed', 'true');
  await expect(exposure.locator('[aria-hidden="true"]')).toHaveText('◆');

  for (const label of ['Speed', 'Opacity']) {
    const toggle = diamond(page, label);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect((await current(page)).layers[0]?.keyframes).toHaveLength(1);
    await expect(page.locator('[data-keyframe-layer="video-1"][data-layer-keyframe="20"]')).toHaveCount(1);
  }
  const expected = sharedPoint(20, { exposure: 0.4, speed: 1.25, opacity: 0.7 });
  const keyed = await current(page);
  expect(keyed.layers[0]?.keyframes).toEqual([expected]);
  expect(keyed.clips).toEqual(bases.clips);
  expect(Object.keys(keyed.layers[0]!.keyframes[0]!.values).sort()).toEqual(Object.keys(EMPTY_KEY_VALUES).sort());
  for (const control of COLOUR_CONTROLS.filter((control) => control.key !== 'exposure')) {
    await expect(diamond(page, control.label)).toBeEnabled();
    await expect(diamond(page, control.label)).toHaveAttribute('aria-pressed', 'false');
    expect(keyed.layers[0]!.keyframes[0]!.values[control.key]).toBeNull();
  }
  await diamond(page, 'Saturation').click();
  const saturated = await current(page);
  expect(saturated.layers[0]?.keyframes).toEqual([{ ...expected, values: { ...expected.values, saturation: 1 } }]);
  await expect(page.locator('.layer-keyframe-controls')).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: 'Animate colour adjustments', exact: true })).toHaveCount(0);
  const row = await editLayerPoint(page, 'Video 1', 20);
  await expect(row.locator('.layer-keyframe-dependencies')).toHaveText('Opacity · Speed · Exposure · Saturation');
  await expect(row.locator('.layer-keyframe-point-values').getByRole('spinbutton')).toHaveCount(4);
  const marker = page.getByRole('button', { name: 'Layer keyframe 20 on Video 1', exact: true });
  for (const label of ['Opacity', 'Speed', 'Exposure', 'Saturation'])
    await expect(marker).toHaveAttribute('title', new RegExp(label));

  await inspectorTab(page, 'Clip');
  await exposure.click();
  expect((await current(page)).layers[0]?.keyframes).toEqual([
    { ...expected, values: { ...expected.values, exposure: null, saturation: 1 } },
  ]);
  await expect(marker).toBeVisible();
  await expect(marker).not.toHaveAttribute('title', /Exposure/);
  for (const label of ['Speed', 'Opacity']) {
    await diamond(page, label).click();
    expect((await current(page)).layers[0]?.keyframes).toHaveLength(1);
    await expect(marker).toBeVisible();
  }
  expect((await current(page)).layers[0]?.keyframes).toEqual([sharedPoint(20, { saturation: 1 })]);
  await diamond(page, 'Saturation').click();
  expect((await current(page)).layers[0]?.keyframes).toEqual([]);
  await expect(marker).toHaveCount(0);
  await expect(diamond(page, 'Saturation')).toHaveAttribute('aria-pressed', 'false');
  await expect(diamond(page, 'Saturation')).toBeEnabled();
  expect((await current(page)).clips).toEqual(bases.clips);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).layers[0]?.keyframes).toEqual([sharedPoint(20, { saturation: 1 })]);
  await expect(marker).toHaveCount(1);
});

test('between points keyed controls are read-only until their own diamond explicitly captures the project-time value', async ({
  page,
}) => {
  let document = await current(page);
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[0]!,
      keyframes: [
        sharedPoint(10, { exposure: 0, speed: 0.5, opacity: 0.2 }),
        sharedPoint(90, { exposure: 0.8, speed: 2, opacity: 0.8 }),
      ],
    },
  });
  await fixture(page, document);
  await seek(page, 30);
  for (const label of ['Exposure', 'Opacity']) {
    const slider = page.getByRole('slider', { name: label, exact: true });
    await expect(slider).toBeDisabled();
    await expect(page.locator(`label[for="${await slider.getAttribute('id')}"]`)).toHaveAttribute(
      'title',
      `Read-only animated value at timeline frame 30. Click the ${label} diamond to add a keyframe here, then edit the value.`,
    );
    await expect(diamond(page, label)).toBeEnabled();
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
  }
  const rate = page.getByRole('spinbutton', { name: 'Layer speed rate', exact: true });
  await expect(rate).toBeDisabled();
  await expect(rate).toHaveValue('0.875');
  await expect(diamond(page, 'Speed')).toBeEnabled();
  await expect(diamond(page, 'Speed')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toBeEnabled();
  expect(await current(page)).toEqual(document);
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('1.3');
  const staticChange = await current(page);
  expect(staticChange.layers[0]?.colour.saturation).toBe(1.3);
  expect(staticChange.clips).toEqual(document.clips);
  expect(staticChange.clips[1]).toEqual(document.clips[1]);
  expect(staticChange.layers[0]?.keyframes.map((point) => point.frame)).toEqual([10, 90]);
  document = staticChange;

  await diamond(page, 'Exposure').click();
  const captured = (await current(page)).layers[0]!.keyframes.find((point) => point.frame === 30)!;
  expect(captured).toEqual(sharedPoint(30, { exposure: 0.2 }));
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.6');
  await expect(rate).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toBeDisabled();
  expect((await current(page)).layers[0]?.keyframes).toEqual([
    document.layers[0]!.keyframes[0],
    sharedPoint(30, { exposure: 0.6 }),
    document.layers[0]!.keyframes[1],
  ]);
  await diamond(page, 'Speed').click();
  await expect(rate).toBeEnabled();
  await expect(rate).toHaveValue('0.875');
  await rate.fill('1.25');
  expect((await current(page)).layers[0]?.keyframes.find((point) => point.frame === 30)?.values.speed).toBe(0.875);
  await rate.press('Enter');
  expect((await current(page)).layers[0]?.keyframes).toEqual([
    document.layers[0]!.keyframes[0],
    sharedPoint(30, { exposure: 0.6, speed: 1.25 }),
    document.layers[0]!.keyframes[1],
  ]);
  const retimed = await current(page);
  const secondStart = calculateLayout(retimed).clips[0]!.end;
  expect(secondStart).toBe(56);
  expect(retimed.clips).toEqual([document.clips[0], { ...document.clips[1]!, start: 56 }]);
  expect(secondStart).not.toBe(document.clips[1]!.start);
  await expect(page.locator('[data-keyframe-layer="video-1"][data-layer-keyframe="30"]')).toHaveCount(1);
  await seek(page, 10);
  for (const label of ['Exposure', 'Speed', 'Opacity'])
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'true');
  await expect(diamond(page, 'Saturation')).toHaveAttribute('aria-pressed', 'false');
});

test('moving a shared point moves every participant with one Undo and preserves focus and invalid collision drafts', async ({
  page,
}) => {
  let document = await current(page);
  const first = sharedPoint(10, { opacity: 0.6, speed: 1, exposure: 0.4, saturation: 0.7 }, 'ease-in');
  const second = sharedPoint(40, { speed: 1, exposure: -0.3 }, 'hold');
  document = applyCommand(document, {
    type: 'layer-update',
    layer: { ...document.layers[0]!, keyframes: [first, second] },
  });
  await fixture(page, document);
  const row = await editLayerPoint(page, 'Video 1', 10);
  await expect(row.getByLabel('Edit layer keyframe 10', { exact: true })).toHaveText('Time, easing & values');
  await expect(row.locator('.layer-keyframe-dependencies')).toHaveText('Opacity · Speed · Exposure · Saturation');
  const time = row.getByRole('spinbutton', { name: 'Layer keyframe frame 10', exact: true });
  const id = await time.getAttribute('id');
  await time.fill('50');
  expect(await current(page)).toEqual(document);
  await time.press('Enter');
  const keys = layerKeyframes(page, 'Video 1');
  const moved = keys.getByRole('spinbutton', { name: 'Layer keyframe frame 50', exact: true });
  await expect(moved).toBeFocused();
  await expect(moved).toHaveAttribute('id', id!);
  expect((await current(page)).layers[0]?.keyframes).toEqual([second, { ...first, frame: 50 }]);
  await expect(keys.getByRole('combobox', { name: 'Layer keyframe interpolation 50', exact: true })).toHaveValue(
    'ease-in',
  );
  await moved.press('Enter');
  await page
    .getByRole('button', { name: 'Undo', exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  const restored = keys.getByRole('spinbutton', { name: 'Layer keyframe frame 10', exact: true });
  await expect(restored).toBeFocused();
  await expect(restored).toHaveValue('10');
  expect(await current(page)).toEqual(document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page
    .getByRole('button', { name: 'Redo', exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(moved).toBeFocused();
  const beforeCollision = await current(page);
  await moved.fill('40');
  await moved.press('Enter');
  await expect(moved).toBeFocused();
  await expect(moved).toHaveValue('40');
  await expect(moved).toHaveAttribute('aria-invalid', 'true');
  const error = moved.locator('..').getByRole('alert');
  await expect(error).toContainText('Frame 40 already has a shared point.');
  expect(await moved.getAttribute('aria-errormessage')).toBe(await error.getAttribute('id'));
  expect(await current(page)).toEqual(beforeCollision);
  await moved.press('Escape');
  await expect(moved).toHaveValue('50');
  await expect(moved).toBeFocused();
  await moved.fill('50.0');
  await moved.press('Enter');
  await moved.press('Tab');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('whole-row curves continue across different clips and their dissolve, while unkeyed channels keep the shared row base', async ({
  page,
}) => {
  let document = await current(page);
  document = applyCommand(document, {
    type: 'colour',
    layerId: 'video-1',
    colour: { ...document.layers[0]!.colour, exposure: -0.3, contrast: 1.3, saturation: 0.6 },
  });
  document = applyCommand(document, { type: 'opacity', layerId: 'video-1', opacity: 0.35 });
  document = applyCommand(document, { type: 'speed', clipId: 'first', speed: { mode: 'constant', rate: 2 } });
  document = applyCommand(document, {
    type: 'speed',
    clipId: 'second',
    speed: { mode: 'ramp', startRate: 0.5, endRate: 2, curve: 'smooth', anchorIn: 30, anchorOut: 90 },
  });
  document = applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'first', rightId: 'second', type: 'cross-dissolve', duration: 12 },
  });
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[0]!,
      keyframes: [
        sharedPoint(0, { exposure: -0.5, opacity: 0.2, speed: 0.5 }),
        sharedPoint(80, { exposure: 1.5, opacity: 0.8, speed: 2 }),
      ],
    },
  });
  await fixture(page, document);
  const layout = calculateLayout(document);
  const overlap = layout.transitions[0]!.start + 6;
  expect(layout.clips[0]?.duration).toBe(58);
  expect(layout.clips[1]?.start).toBe(46);
  expect(layout.duration).toBe(81);
  const simultaneous = sampleTimeline(document, overlap);
  expect(simultaneous).toHaveLength(2);
  expect(simultaneous[0]?.colour.exposure).toBeCloseTo(0.8);
  expect(simultaneous[1]?.colour.exposure).toBeCloseTo(0.8);
  expect(simultaneous.map((sample) => sample.colour.saturation)).toEqual([0.6, 0.6]);
  expect(simultaneous.map((sample) => sample.sourceFrame)).toEqual([51, 38]);

  for (const frame of [0, 20, overlap, layout.clips[0]!.end, layout.duration - 1]) {
    const captured = await captureAt(page, frame);
    expect(captured.state.status, captured.state.message).toBe('paused');
    expect(captured.state.decoderCount).toBe(2);
    const progress = frame / 80;
    for (const sample of sampleTimeline(document, frame)) {
      expect(sample.colour.exposure).toBeCloseTo(-0.5 + 2 * progress);
      expect(sample.opacity).toBeCloseTo(0.2 + 0.6 * progress);
      expect(sample.colour.contrast).toBe(document.layers[0]!.colour.contrast);
      expect(sample.colour.saturation).toBe(document.layers[0]!.colour.saturation);
      expect(sample).not.toHaveProperty('correction');
      const slot = captured.state.assignedClipIds.indexOf(sample.clipId);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(captured.sourceFrames[slot]).toBe(sample.sourceFrame);
      const placed = layout.clips.find((item) => item.clip.id === sample.clipId)!;
      expect(placed.retiming.rateAt(frame - placed.start)).toBeCloseTo(0.5 + 1.5 * progress);
    }
  }
  await page
    .locator('[data-clip-id="second"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await seek(page, overlap);
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('0.8');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Contrast', exact: true })).toHaveValue('1.3');
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveValue('0.6');
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toBeEnabled();
  expect((await current(page)).clips).toEqual(document.clips);
  expect((await current(page)).layers[0]?.keyframes).toEqual(document.layers[0]?.keyframes);
});

for (const rate of [0.25, 4]) {
  test(`project-time grade points update preview pixels at ${rate}× even when source frames are held or skipped`, async ({
    page,
  }) => {
    let document = await current(page);
    document = applyCommand(document, {
      type: 'transition',
      transition: { leftId: 'first', rightId: 'second', type: 'cross-dissolve', duration: 12 },
    });
    document = applyCommand(document, {
      type: 'layer-update',
      layer: {
        ...document.layers[0]!,
        keyframes: [
          sharedPoint(0, { speed: rate, exposure: -0.75 }),
          sharedPoint(1, { exposure: -0.25 }),
          sharedPoint(2, { exposure: 0.25 }),
          sharedPoint(3, { exposure: 0.75 }),
        ],
      },
    });
    await fixture(page, document);
    const captures = [];
    for (const frame of [0, 1, 2, 3]) {
      const captured = await captureAt(page, frame);
      const sample = sampleTimeline(document, frame).find((layer) => layer.clipId === 'first')!;
      const slot = captured.state.assignedClipIds.indexOf('first');
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(captured.sourceFrames[slot]).toBe(Math.floor(frame * rate));
      expect(sample.sourceFrame).toBe(Math.floor(frame * rate));
      expect(sample.colour.exposure).toBe(-0.75 + frame * 0.5);
      await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'true');
      await expect(diamond(page, 'Speed')).toHaveAttribute('aria-pressed', String(frame === 0));
      captures.push(captured);
    }
    expect(captures[3]!.state.renderedFrames).toBeGreaterThan(captures[0]!.state.renderedFrames);
    expect(captures[3]!.pixelSum).not.toBe(captures[0]!.pixelSum);
    await seek(page, 0);
    await inspectorTab(page, 'Layer keyframes');
    const keys = layerKeyframes(page, 'Video 1');
    for (const frame of [1, 2, 3]) {
      await keys.getByRole('button', { name: 'Next layer keyframe', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
      await expect(page.getByRole('button', { name: `Layer keyframe ${frame} on Video 1`, exact: true })).toHaveCount(
        1,
      );
    }
    expect((await current(page)).layers[0]?.keyframes).toEqual(document.layers[0]?.keyframes);
    expect((await current(page)).clips.map((clip) => clip.speed)).toEqual([
      { mode: 'constant', rate: 1 },
      { mode: 'constant', rate: 1 },
    ]);
  });
}

test('a row marker opens the selected empty row independently of clips, and keyboard contexts do not edit other rows', async ({
  page,
}) => {
  let document = await current(page);
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[0]!,
      keyframes: [sharedPoint(20, { exposure: -0.2 }), sharedPoint(60, { opacity: 0.8 })],
    },
  });
  document = applyCommand(document, {
    type: 'layer-add',
    layer: {
      ...createLayer('upper', 'Video 2', false),
      keyframes: [sharedPoint(20, { exposure: 1, speed: 2, opacity: 0.4 })],
    },
  });
  await fixture(page, document);
  await inspectorTab(page, 'Sequence');
  const marker = page.getByRole('button', { name: 'Layer keyframe 20 on Video 2', exact: true });
  await expect(marker).toHaveAttribute('data-layer-keyframe', '20');
  await expect(marker).toHaveAttribute('data-keyframe-layer', 'upper');
  await expect(marker.locator('xpath=ancestor::*[@data-clip-id]')).toHaveCount(0);
  const surface = page.locator('.timeline-surface');
  expect(Number(await surface.getAttribute('data-leading'))).toBe(32);
  const scale = Number(await surface.getAttribute('data-pixels-per-frame'));
  expect(Number.parseFloat(await marker.evaluate((element) => (element as HTMLElement).style.left))).toBeCloseTo(
    32 + 20 * scale,
  );
  const firstTrack = (await page.locator('[data-layer-lane="video-1"]').boundingBox())!;
  const overlay = (await page.locator('[data-layer-lane="upper"]').boundingBox())!;
  expect(overlay.y - firstTrack.y).toBe(88);
  const ruler = page.getByLabel('Timeline ruler', { exact: true });
  await expect(ruler).toHaveAttribute('title', /timeline|seek|ruler/i);
  expect((await ruler.boundingBox())!.y).toBeLessThan(firstTrack.y);

  await marker.click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  await expect(page.getByRole('tab', { name: 'Sequence', exact: true })).toHaveAttribute('aria-selected', 'true');
  await inspectorTab(page, 'Layer keyframes');
  await expect(layerKeyframes(page, 'Video 2')).toBeVisible();
  await expect(layerKeyframes(page, 'Video 1')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(page.locator('.selected-clip-name')).toContainText('Whole video row');
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame', exact: true })).toHaveCount(0);
  await expect(page.locator('.layer-control.selected .layer-select')).toHaveAttribute(
    'aria-label',
    'Select layer Video 2',
  );
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toBeEnabled();
  await expect(diamond(page, 'Saturation')).toBeEnabled();
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.6');
  const edited = await current(page);
  expect(edited.layers[0]).toEqual(document.layers[0]);
  expect(edited.clips).toEqual(document.clips);
  expect(edited.layers[1]?.keyframes).toEqual([sharedPoint(20, { exposure: 0.6, speed: 2, opacity: 0.4 })]);
  await inspectorTab(page, 'Layer keyframes');
  await expect(layerKeyframes(page, 'Video 2')).toBeVisible();

  await inspectorTab(page, 'Clip');
  const field = page.getByRole('spinbutton', { name: 'Layer speed rate', exact: true });
  await field.fill('3');
  for (const key of ['Control+d', 's', 'Delete', 'ArrowRight', 'Home', 'End', 'Space']) await field.press(key);
  expect(await current(page)).toEqual(edited);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().playing)).toBe(false);
  await field.press('Escape');
  await expect(field).toHaveValue('2');
  await openOptions(page, 'Clip actions');
  for (const name of ['Split at playhead', 'Duplicate selected clip', 'Delete selected clip'])
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('region', { name: 'Video timeline' }).focus();
  for (const key of ['s', 'Control+d', 'Delete']) await page.keyboard.press(key);
  expect(await current(page)).toEqual(edited);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(21);
  await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'false');
  await expect(diamond(page, 'Exposure')).toBeEnabled();
  expect((await current(page)).layers).toEqual(edited.layers);
});

test('an overlapping row-speed edit is rejected atomically, without a save or history step, and a valid correction is undoable', async ({
  page,
}) => {
  let document = await current(page);
  document = applyCommand(document, {
    type: 'layer-add',
    layer: {
      ...createLayer('upper', 'Video 2', false),
      keyframes: [sharedPoint(0, { speed: 1, exposure: 0.2, opacity: 0.8 })],
    },
  });
  document = applyCommand(document, {
    type: 'insert',
    clip: { ...createClip('upper-a', assets[0]!.id, 0, 30), layerId: 'upper', start: 0 },
    index: 2,
  });
  document = applyCommand(document, {
    type: 'insert',
    clip: { ...createClip('upper-b', assets[1]!.id, 30, 60), layerId: 'upper', start: 40 },
    index: 3,
  });
  await fixture(page, document);
  await page
    .locator('[data-clip-id="upper-a"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await seek(page, 0);
  const rate = page.getByRole('spinbutton', { name: 'Layer speed rate', exact: true });
  const before = await current(page);
  const saves = memory.saves;
  await rate.fill('0.5');
  expect(await current(page)).toEqual(before);
  await rate.press('Enter');
  await expect(rate.locator('..').getByRole('alert')).toContainText(
    'Clips on the same track cannot overlap except in an exact adjacent cross-dissolve.',
  );
  await expect(rate).toHaveValue('0.5');
  await expect(rate).toHaveAttribute('aria-invalid', 'true');
  expect(await current(page)).toEqual(before);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(saves);
  expect(memory.snapshot()).toEqual(document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await rate.press('Escape');
  await expect(rate).toHaveValue('1');
  await rate.fill('2');
  await rate.press('Enter');
  const changed = await current(page);
  expect(changed.layers[1]?.keyframes).toEqual([sharedPoint(0, { speed: 2, exposure: 0.2, opacity: 0.8 })]);
  expect(changed.clips).toEqual(before.clips);
  expect(changed.layers[0]).toEqual(before.layers[0]);
  expect(
    calculateLayout(changed)
      .clips.filter((placed) => placed.clip.layerId === 'upper')
      .map((placed) => [placed.start, placed.end]),
  ).toEqual([
    [0, 15],
    [40, 55],
  ]);
  const captured = await captureAt(page, 10);
  const slot = captured.state.assignedClipIds.indexOf('upper-a');
  expect(slot).toBeGreaterThanOrEqual(0);
  expect(captured.sourceFrames[slot]).toBe(20);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('numeric trim, mapped split, duplicate and overlay moves keep absolute row anchors and persist strict shared values on reload', async ({
  page,
}) => {
  let document = await current(page);
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[0]!,
      keyframes: [
        sharedPoint(10, { speed: 2, exposure: -0.2 }),
        sharedPoint(70, { speed: 2, exposure: 0.4 }, 'smooth'),
      ],
    },
  });
  document = applyCommand(document, {
    type: 'layer-add',
    layer: {
      ...createLayer('upper', 'Video 2', false),
      keyframes: [
        sharedPoint(5, { opacity: 0.5, exposure: 0.25 }),
        sharedPoint(90, { opacity: 0.9, exposure: 0.75 }, 'ease-out'),
      ],
    },
  });
  document = applyCommand(document, {
    type: 'insert',
    clip: { ...createClip('overlay', assets[1]!.id, 0, 40), layerId: 'upper', start: 20 },
    index: 2,
  });
  await fixture(page, document);
  const sourceIn = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await sourceIn.fill('10');
  await sourceIn.press('Enter');
  const trimmed = await current(page);
  expect(trimmed.clips[0]).toMatchObject({ sourceIn: 10, sourceOut: 60 });
  expect(trimmed.layers).toEqual(document.layers);
  await seek(page, 10);
  await clipAction(page, 'Split at playhead');
  const split = await current(page);
  expect(split.clips).toHaveLength(4);
  expect(split.clips[0]?.sourceOut).toBe(30);
  expect(split.clips[1]?.sourceIn).toBe(30);
  expect(split.layers).toEqual([
    {
      ...document.layers[0]!,
      transitions: [
        { leftId: 'first', rightId: split.clips[1]!.id, type: 'cut', duration: 0 },
        { leftId: split.clips[1]!.id, rightId: 'second', type: 'cut', duration: 0 },
      ],
    },
    document.layers[1]!,
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(trimmed);
  await page.getByRole('region', { name: 'Video timeline' }).focus();
  await page.keyboard.press('Control+d');
  const duplicated = await current(page);
  const copy = duplicated.clips[1]!;
  expect(copy.id).not.toBe('first');
  expect(copy).toEqual({ ...trimmed.clips[0]!, id: copy.id, start: 25 });
  expect(calculateLayout(duplicated).clips.find((placed) => placed.clip.id === copy.id)?.start).toBe(25);
  expect(duplicated.layers).toEqual([
    {
      ...document.layers[0]!,
      transitions: [
        { leftId: 'first', rightId: copy.id, type: 'cut', duration: 0 },
        { leftId: copy.id, rightId: 'second', type: 'cut', duration: 0 },
      ],
    },
    document.layers[1]!,
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(trimmed);
  await page
    .locator('[data-clip-id="overlay"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  const start = page.getByRole('spinbutton', { name: 'Clip timeline start', exact: true });
  await start.fill('80');
  await start.press('Enter');
  await sourceIn.fill('10');
  await sourceIn.press('Enter');
  const moved = await current(page);
  expect(moved.clips.find((clip) => clip.id === 'overlay')).toMatchObject({ start: 80, sourceIn: 10, sourceOut: 40 });
  expect(moved.layers).toEqual(document.layers);
  await expect(page.getByRole('button', { name: 'Layer keyframe 5 on Video 2', exact: true })).toHaveCount(1);
  await page.evaluate(() => window.pascapLab!.flush());
  const saved = memory.snapshot();
  expect(saved.schemaVersion).toBe(12);
  expect(saved.layers).toEqual(document.layers);
  expect(saved.clips).toEqual(moved.clips);
  for (const layer of saved.layers)
    for (const point of layer.keyframes)
      expect(Object.keys(point.values).sort()).toEqual(Object.keys(EMPTY_KEY_VALUES).sort());
  for (const clip of saved.clips) expect(clip).not.toHaveProperty('animation');
  await page.reload();
  await ready(page, saved);
  expect((await current(page)).layers).toEqual(document.layers);
  expect((await current(page)).clips).toEqual(moved.clips);
  await page
    .locator('[data-clip-id="overlay"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(sourceIn).toHaveValue('10');
  await expect(start).toHaveValue('80');
  await expect(page.getByRole('button', { name: 'Layer keyframe 5 on Video 2', exact: true })).toHaveCount(1);
});
