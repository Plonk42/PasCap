import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyCommand } from '../../src/shared/commands.js';
import { KEYFRAME_SETTINGS, type LayerKeyframe } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  closeOptions,
  editLayerPoint,
  expandedInspectorPreferences,
  layerKeyframes,
  openOptions,
  inspectorTab as openTab,
  settingTab,
  sharedPoint,
} from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let assets: MediaAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];

// These cases navigate Colour/Opacity, which share the Track tab with the keyframe list;
// "Clip" here means the playhead setting controls. Real Clip-tab checks use openTab.
async function inspectorTab(page: Page, name: 'Clip' | 'Track keyframes' | 'Sequence' | 'Track'): Promise<void> {
  await openTab(page, name === 'Clip' ? 'Track' : name);
}

test.beforeEach(async ({ page, request }) => {
  unexpectedApi = [];
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset) throw new Error('Navigation tests read only the already prepared dedicated synthetic fixtures.');
    return asset;
  });
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
  const document = sequence();
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.goto(`/?project=${document.id}`);
  await ready(page, document);
});

test.afterEach(() => {
  expect(unexpectedApi, 'No real project, import, preparation, reference, export or unowned media requests').toEqual(
    [],
  );
});

function sequence(keys: LayerKeyframe[] = []): ProjectDocument {
  let document = createProject('keyframe-navigation', 'Navigation · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.layers[0]!.keyframes = keys;
  document = applyCommand(document, { type: 'insert', clip: createClip('first', assets[0]!.id, 0, 60), index: 0 });
  return applyCommand(document, { type: 'insert', clip: createClip('second', assets[1]!.id, 30, 90), index: 1 });
}

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function ready(page: Page, document: ProjectDocument): Promise<void> {
  await page.waitForFunction(
    ({ id, duration }) => {
      const state = window.pascapLab?.engine.diagnostics();
      return (
        window.pascapLab?.project()?.id === id &&
        state?.status === (duration ? 'paused' : 'empty') &&
        state.duration === duration
      );
    },
    { id: document.id, duration: calculateLayout(document).duration },
  );
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 1')).toBeVisible();
}

async function fixture(page: Page, document: ProjectDocument): Promise<void> {
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}

function inspector(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Clip inspector', exact: true });
}

function diamond(page: Page, label: string): Locator {
  return inspector(page).getByRole('button', { name: `Keyframe ${label}`, exact: true });
}

function step(page: Page, label: string, direction: 'Previous' | 'Next'): Locator {
  return inspector(page).getByRole('button', { name: `${direction} ${label} keyframe`, exact: true });
}

async function previewAt(page: Page, frame: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { frame: state.frame, status: state.status };
      }),
    )
    .toEqual({ frame, status: 'paused' });
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await previewAt(page, frame);
}

async function readOnly(page: Page, document: ProjectDocument): Promise<void> {
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  expect(await current(page)).toEqual(document);
  expect(memory.snapshot(document.id)).toEqual(document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
}

function interleaved(): LayerKeyframe[] {
  return [3, 50, 89].flatMap((start) =>
    KEYFRAME_SETTINGS.map(({ key }, index) => sharedPoint(start + index * 3, { [key]: key === 'speed' ? 1 : 0 })),
  );
}

test('unkeyed settings retain their hollow diamonds and both visible disabled navigation buttons', async ({ page }) => {
  const document = await current(page);
  expect(KEYFRAME_SETTINGS).toHaveLength(11);
  await expect(inspector(page).getByRole('button', { name: /^Keyframe / })).toHaveCount(10);
  for (const { label } of KEYFRAME_SETTINGS) {
    await settingTab(page, label);
    const toggle = diamond(page, label);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    for (const direction of ['Previous', 'Next'] as const) {
      const button = step(page, label, direction);
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
      expect(await button.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
      await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    }
  }
  await inspectorTab(page, 'Track');
  for (const { label } of KEYFRAME_SETTINGS.filter((setting) => setting.key !== 'speed'))
    await expect(inspector(page).getByRole('slider', { name: label, exact: true })).toBeEnabled();
  await openTab(page, 'Clip');
  await expect(page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true })).toBeEnabled();
  await readOnly(page, document);
});

for (const [index, { key, label }] of KEYFRAME_SETTINGS.entries()) {
  test(`${label} navigates only its three interleaved participating points, including zero, gaps and exact ends`, async ({
    page,
  }) => {
    const document = sequence(interleaved());
    await fixture(page, document);
    const first = 3 + index * 3;
    const middle = 50 + index * 3;
    const last = 89 + index * 3;
    await settingTab(page, label);
    const previous = step(page, label, 'Previous');
    const next = step(page, label, 'Next');
    await expect(diamond(page, label)).toBeEnabled();
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    if (key === 'speed')
      await expect(page.getByRole('spinbutton', { name: 'Track speed rate', exact: true })).toBeDisabled();
    else await expect(inspector(page).getByRole('slider', { name: label, exact: true })).toBeDisabled();
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
    await next.click();
    await previewAt(page, first);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'true');
    await expect(previous).toBeDisabled();
    await next.click();
    await previewAt(page, middle);
    await previous.click();
    await previewAt(page, first);
    await seek(page, first + 1);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    await expect(previous).toHaveAttribute('title', `Go to timeline frame ${first}.`);
    await expect(next).toHaveAttribute('title', `Go to timeline frame ${middle}.`);
    await previous.click();
    await previewAt(page, first);
    await next.click();
    await previewAt(page, middle);
    await next.click();
    await previewAt(page, last);
    await expect(next).toBeVisible();
    await expect(next).toBeDisabled();
    await expect(previous).toHaveAttribute('title', `Go to timeline frame ${middle}.`);
    await previous.click();
    await previewAt(page, middle);
    expect(document.layers[0]!.keyframes.find((point) => point.frame === first)!.values[key]).toBe(
      key === 'speed' ? 1 : 0,
    );
    await readOnly(page, document);
  });
}

test('diamond, previous, next and reset keep native Tab order and keyboard activation without editing', async ({
  page,
}) => {
  const document = sequence([
    sharedPoint(10, { exposure: 0.5 }),
    sharedPoint(30, { exposure: 1 }),
    sharedPoint(50, { exposure: 1.5 }),
  ]);
  await fixture(page, document);
  await seek(page, 30);
  const toggle = diamond(page, 'Exposure');
  const previous = step(page, 'Exposure', 'Previous');
  const next = step(page, 'Exposure', 'Next');
  expect(
    await toggle.evaluate((button) =>
      Array.from(button.parentElement!.children, (child) => ({
        tag: child.tagName,
        label: child.getAttribute('aria-label'),
      })),
    ),
  ).toEqual([
    { tag: 'BUTTON', label: 'Keyframe Exposure' },
    { tag: 'BUTTON', label: 'Previous Exposure keyframe' },
    { tag: 'BUTTON', label: 'Next Exposure keyframe' },
  ]);
  expect(await toggle.evaluate((button) => button.parentElement!.nextElementSibling)).toBeNull();
  await toggle.focus();
  await page.keyboard.press('Tab');
  await expect(previous).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(next).toBeFocused();
  await next.press('Enter');
  await previewAt(page, 50);
  await previous.focus();
  await previous.press('Space');
  await previewAt(page, 30);
  await expect(previous).toBeFocused();
  await readOnly(page, document);
});

test('all eleven setting buttons remain present and disabled throughout a native trim draft', async ({ page }) => {
  const document = sequence(interleaved());
  await fixture(page, document);
  await seek(page, 45);
  const handle = page.getByRole('slider', { name: 'Trim end of pattern-a.mp4, clip 1', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (const { label } of KEYFRAME_SETTINGS) {
    await settingTab(page, label);
    await expect(diamond(page, label)).toBeDisabled();
    for (const direction of ['Previous', 'Next'] as const) {
      await expect(step(page, label, direction)).toBeVisible();
      await expect(step(page, label, direction)).toBeDisabled();
    }
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await previewAt(page, 45);
  await readOnly(page, document);
});

test('no opened project keeps all setting buttons visible and disabled without a hidden create or save', async ({
  page,
}) => {
  await page.route(/\/api\/projects(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { projects: [] } });
      return;
    }
    unexpectedApi.push(`${route.request().method()} /api/projects`);
    await route.abort('blockedbyclient');
  });
  await page.goto('/?project=missing');
  const dialog = page.getByRole('dialog', { name: 'Projects', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await inspectorTab(page, 'Track');
  // Speed is clip-owned, so without a project only the ten Track settings exist.
  for (const { label } of KEYFRAME_SETTINGS.filter((setting) => setting.key !== 'speed')) {
    await expect(diamond(page, label)).toBeDisabled();
    for (const direction of ['Previous', 'Next'] as const) {
      await expect(step(page, label, direction)).toBeVisible();
      await expect(step(page, label, direction)).toBeDisabled();
    }
  }
  expect(await page.evaluate(() => window.pascapLab!.project())).toBeNull();
  expect(memory.saves).toBe(0);
});

test('single opacity navigation on a selected empty row preserves Inspector context and shares the cursor without stealing focus', async ({
  page,
}) => {
  let document = sequence([sharedPoint(10, { opacity: 0 }), sharedPoint(100, { opacity: 0.5 })]);
  document = applyCommand(document, {
    type: 'layer-add',
    layer: {
      ...createLayer('upper', 'Video track 2', false),
      keyframes: [
        sharedPoint(20, { opacity: 0 }),
        sharedPoint(130, { opacity: 0.5 }),
        sharedPoint(140, { brightness: 0 }),
        sharedPoint(160, { opacity: 1 }),
      ],
    },
  });
  await fixture(page, document);
  await inspectorTab(page, 'Sequence');
  await openOptions(page, 'Workspace options');
  await page.getByRole('button', { name: 'Toggle Clip panel', exact: true }).click();
  await closeOptions(page);
  await expect(inspector(page)).toBeHidden();
  await openOptions(page, 'Track options Video track 2');
  const options = page.getByRole('group', { name: 'Track options Video track 2', exact: true });
  await expect(options.getByRole('slider')).toHaveCount(0);
  await expect(options.getByRole('button', { name: /Opacity keyframe/ })).toHaveCount(0);
  await closeOptions(page);
  await openOptions(page, 'Workspace options');
  await page.getByRole('button', { name: 'Toggle Clip panel', exact: true }).click();
  await closeOptions(page);
  await page.getByRole('button', { name: 'Select track Video track 2', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  const next = step(page, 'Opacity', 'Next');
  await next.focus();
  await next.press('Enter');
  await previewAt(page, 20);
  await expect(next).toBeFocused();
  await expect(inspector(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  await closeOptions(page);
  await openTab(page, 'Clip');
  await expect(inspector(page).locator('[role="tabpanel"]:not([hidden])')).toContainText(
    'Select a clip on Video track 2 to edit it.',
  );
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2')).toBeVisible();
  await expect(page.locator('.layer-control.selected')).toHaveAttribute('data-layer-id', 'upper');
  await inspectorTab(page, 'Clip');
  await next.press('Space');
  await previewAt(page, 119);
  await expect(next).toBeFocused();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 130',
  );
  await closeOptions(page);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Opacity', 'Next')).toHaveAttribute('title', /Stored timeline frame 160;/);
  await inspectorTab(page, 'Track keyframes');
  await layerKeyframes(page, 'Video track 2').getByRole('button', { name: 'Next track keyframe', exact: true }).click();
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 140',
  );
  await inspectorTab(page, 'Clip');
  await step(page, 'Opacity', 'Next').click();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 160',
  );
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Opacity', 'Next')).toBeDisabled();
  await step(page, 'Opacity', 'Previous').click();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 130',
  );
  await readOnly(page, document);
});

test('successive outside-duration setting, row and list navigation keeps one truthful stored cursor and real clamped source/playhead frames', async ({
  page,
}) => {
  const document = sequence([
    sharedPoint(10, { exposure: 0 }),
    sharedPoint(60, { exposure: 0.5 }),
    sharedPoint(120, { exposure: 1 }),
    sharedPoint(130, { brightness: 0 }),
    sharedPoint(180, { exposure: 1.5 }),
    sharedPoint(240, { exposure: 2 }),
  ]);
  await fixture(page, document);
  await page
    .locator('[data-clip-id="second"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await previewAt(page, 60);
  const keys = layerKeyframes(page, 'Video track 1');
  await editLayerPoint(page, 'Video track 1', 120);
  for (const frame of [120, 180, 240]) {
    await inspectorTab(page, 'Clip');
    await step(page, 'Exposure', 'Next').click();
    await previewAt(page, 119);
    await inspectorTab(page, 'Track keyframes');
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
      `Stored keyframe · timeline frame ${frame} · outside current duration`,
    );
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
      'Preview is at frame 119, not at this stored keyframe.',
    );
    await expect(keys.locator('.layer-keyframe-current')).toContainText('Timeline frame 119');
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute(
      'data-keyframe-frame',
      String(frame),
    );
    await inspectorTab(page, 'Clip');
    await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'false');
    await expect(diamond(page, 'Exposure')).toHaveAttribute('title', /timeline frame 119\./);
    await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeDisabled();
    await openTab(page, 'Clip');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.pascapLab!.engine.diagnostics();
          const index = state.assignedClipIds.indexOf('second');
          return { ready: state.decoderReady[index], sourceFrame: state.decodedSourceFrames[index] };
        }),
      )
      .toEqual({ ready: true, sourceFrame: 89 });
  }
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toBeDisabled();
  await inspectorTab(page, 'Track keyframes');
  await keys.getByRole('button', { name: 'Previous track keyframe', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 180');
  await keys.getByRole('button', { name: 'Go to track keyframe 120', exact: true }).click();
  await keys.getByRole('button', { name: 'Next track keyframe', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 130');
  await inspectorTab(page, 'Clip');
  await step(page, 'Exposure', 'Next').click();
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 180');
  await inspectorTab(page, 'Clip');
  await step(page, 'Exposure', 'Previous').click();
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 120');
  await keys.getByRole('button', { name: 'Follow playhead', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 120;/);
  await step(page, 'Exposure', 'Previous').click();
  await previewAt(page, 60);
  await readOnly(page, document);
});

test('an empty timeline can inspect successive stored keys, without pretending that a preview or keyed diamond exists there', async ({
  page,
}) => {
  const document = createProject('keyframe-navigation', 'Empty timeline · memory-only');
  document.layers[0]!.keyframes = [
    sharedPoint(30, { exposure: 0 }),
    sharedPoint(45, { brightness: 0 }),
    sharedPoint(60, { exposure: 1 }),
    sharedPoint(90, { exposure: 2 }),
  ];
  await fixture(page, document);
  const keys = layerKeyframes(page, 'Video track 1');
  await editLayerPoint(page, 'Video track 1', 30);
  for (const frame of [30, 60, 90]) {
    await inspectorTab(page, 'Clip');
    await step(page, 'Exposure', 'Next').click();
    await inspectorTab(page, 'Track keyframes');
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(`Stored keyframe · timeline frame ${frame}`);
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText('No preview frame is available.');
    await expect(keys.locator('.layer-keyframe-current')).toHaveText('Empty timeline · no preview frame');
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute(
      'data-keyframe-frame',
      String(frame),
    );
    expect(
      await page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame, duration: state.duration };
      }),
    ).toEqual({ status: 'empty', frame: 0, duration: 0 });
    await inspectorTab(page, 'Clip');
    await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'false');
    await expect(diamond(page, 'Exposure')).toHaveAttribute('title', /timeline frame 0\./);
  }
  await expect(step(page, 'Exposure', 'Next')).toBeDisabled();
  await step(page, 'Exposure', 'Previous').click();
  await inspectorTab(page, 'Track keyframes');
  await keys.getByRole('button', { name: 'Previous track keyframe', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 45');
  await inspectorTab(page, 'Clip');
  await step(page, 'Exposure', 'Next').click();
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 60');
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute(
    'title',
    'Stored timeline frame 90; the timeline is empty, so there is no frame to preview.',
  );
  await readOnly(page, document);
});

test('row and project switches discard the old stored cursor even when layer IDs are reused', async ({ page }) => {
  let document = sequence([
    sharedPoint(10, { exposure: 0 }),
    sharedPoint(100, { exposure: 1 }),
    sharedPoint(150, { exposure: 2 }),
  ]);
  document = applyCommand(document, {
    type: 'layer-add',
    layer: {
      ...createLayer('upper', 'Video track 2', false),
      keyframes: [sharedPoint(30, { opacity: 0 }), sharedPoint(130, { opacity: 1 })],
    },
  });
  await fixture(page, document);
  await seek(page, 100);
  await step(page, 'Exposure', 'Next').click();
  await previewAt(page, 119);
  await page.getByRole('button', { name: 'Select track Video track 2', exact: true }).click();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Opacity', 'Next')).toHaveAttribute('title', /Stored timeline frame 130;/);
  await expect(step(page, 'Exposure', 'Next')).toBeDisabled();
  await step(page, 'Opacity', 'Next').click();
  await page.getByRole('button', { name: 'Select track Video track 1', exact: true }).click();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 1').locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 150;/);
  await step(page, 'Exposure', 'Next').click();
  const other = {
    ...sequence([sharedPoint(20, { exposure: 0 }), sharedPoint(140, { exposure: 1 })]),
    id: 'other-navigation',
    title: 'Other navigation · memory-only',
  };
  memory.seed(other);
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: `Open ${other.title}`, exact: true })
    .click();
  await ready(page, other);
  await previewAt(page, 0);
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 1').locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Previous')).toBeDisabled();
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute('title', 'Go to timeline frame 20.');
  await step(page, 'Exposure', 'Next').click();
  await previewAt(page, 20);
  await readOnly(page, other);
  expect(memory.snapshot(document.id)).toEqual(document);
});

test('manual seeking to the same clamped last frame, direct seeks and playback reset stored inspection', async ({
  page,
}) => {
  const document = sequence([
    sharedPoint(10, { exposure: 0 }),
    sharedPoint(130, { exposure: 1 }),
    sharedPoint(160, { exposure: 2 }),
  ]);
  await fixture(page, document);
  const keys = layerKeyframes(page, 'Video track 1');
  await step(page, 'Exposure', 'Next').click();
  await previewAt(page, 10);
  await step(page, 'Exposure', 'Next').click();
  await previewAt(page, 119);
  await step(page, 'Exposure', 'Next').click();
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 160');
  await page.getByRole('button', { name: 'Go to timeline end', exact: true }).click();
  await previewAt(page, 119);
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 130;/);
  await step(page, 'Exposure', 'Next').click();
  await seek(page, 25);
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await step(page, 'Exposure', 'Next').click();
  await previewAt(page, 119);
  await step(page, 'Exposure', 'Next').click();
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  await previewAt(page, frame);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute(
    'title',
    frame < 10
      ? 'Go to timeline frame 10.'
      : 'Stored timeline frame 130; preview the nearest available frame 119. The keyframe stays in place.',
  );
  await readOnly(page, document);
});

test('point moves and history retain input identity and the shared cursor, while deletion safely resumes playhead navigation', async ({
  page,
}) => {
  const document = sequence([
    sharedPoint(10, { exposure: 0 }),
    sharedPoint(150, { exposure: 1 }),
    sharedPoint(160, { brightness: 0 }),
    sharedPoint(180, { exposure: 2 }),
  ]);
  await fixture(page, document);
  await seek(page, 10);
  await step(page, 'Exposure', 'Next').click();
  await previewAt(page, 119);
  const keys = layerKeyframes(page, 'Video track 1');
  const row = await editLayerPoint(page, 'Video track 1', 150);
  const time = row.getByRole('spinbutton', { name: 'Track keyframe frame 150', exact: true });
  const id = await time.getAttribute('id');
  await time.fill('175');
  await time.press('Enter');
  const moved = keys.getByRole('spinbutton', { name: 'Track keyframe frame 175', exact: true });
  await expect(moved).toBeFocused();
  await expect(moved).toHaveAttribute('id', id!);
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 175');
  await page
    .getByRole('button', { name: 'Undo', exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(time).toBeFocused();
  await expect(time).toHaveAttribute('id', id!);
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 150');
  expect(await current(page)).toEqual(document);
  await page
    .getByRole('button', { name: 'Redo', exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(moved).toBeFocused();
  await keys.getByRole('button', { name: 'Delete track keyframe 175', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 180;/);
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.getByRole('button', { name: 'Next track keyframe', exact: true })).toHaveAttribute(
    'title',
    /Stored timeline frame 160;/,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 175;/);
  await page.evaluate(() => window.pascapLab!.flush());
  const writes = memory.saves;
  const before = await current(page);
  await step(page, 'Exposure', 'Next').click();
  await step(page, 'Exposure', 'Next').click();
  await step(page, 'Exposure', 'Previous').click();
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(writes);
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
});

test('all navigation groups fit the 270px inspector at the default and minimum viewports without overflow or hidden buttons', async ({
  page,
}) => {
  const document = sequence(interleaved());
  await fixture(page, document);
  const resizer = page.getByRole('slider', { name: 'Resize Clip panel', exact: true });
  await resizer.focus();
  for (let index = 0; index < 6; index++) await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', '270');
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect(resizer).toHaveAttribute('aria-valuenow', '270');
    for (const { label } of KEYFRAME_SETTINGS) {
      await settingTab(page, label);
      await diamond(page, label).scrollIntoViewIfNeeded();
      for (const direction of ['Previous', 'Next'] as const) {
        const button = step(page, label, direction);
        await expect(button).toBeVisible();
        expect(
          await button.evaluate((element) => {
            const button = element.getBoundingClientRect();
            const panel = element.closest('.inspector-panel')!.getBoundingClientRect();
            return (
              button.left >= panel.left && button.right <= panel.right && Number(getComputedStyle(element).opacity) > 0
            );
          }),
        ).toBe(true);
      }
    }
    expect(await inspector(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await readOnly(page, document);
});
