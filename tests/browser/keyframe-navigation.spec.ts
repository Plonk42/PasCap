import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyCommand } from '../../src/shared/commands.js';
import { KEYFRAME_SETTINGS, type LayerKeyframe } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipKeyframeMarkers } from '../../src/web/clip-keyframe-markers.js';
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
  return inspector(page)
    .locator('.keyframe-setting-navigation')
    .getByRole('button', { name: `Keyframe ${label}`, exact: true });
}

function mainStep(page: Page, label: string, direction: 'Previous' | 'Next'): Locator {
  return diamond(page, label)
    .locator('..')
    .locator('.channel-keyframe-navigation')
    .getByRole('button', { name: `${direction} ${label} keyframe`, exact: true });
}

async function mainNavigate(page: Page, label: string, direction: 'Previous' | 'Next'): Promise<void> {
  await settingTab(page, label);
  const button = mainStep(page, label, direction);
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(button).toBeFocused();
}

async function guardedUnavailable(button: Locator): Promise<void> {
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAttribute('tabindex', '-1');
  await expect(button).toHaveJSProperty('disabled', false);
}

function sectionStep(page: Page, label: 'Colour' | 'Speed' | 'Transform', direction: 'Previous' | 'Next'): Locator {
  return inspector(page)
    .locator('.section-keyframe-line')
    .getByRole('button', { name: `${direction} ${label} keyframe`, exact: true });
}

async function step(page: Page, label: string, direction: 'Previous' | 'Next', rowFrame?: number): Promise<Locator> {
  // Chip arrows are stored-row controls: no inspection means that row, not the playhead.
  // Prefer the inspected/active row; for a nonparticipant use a neighbouring participant.
  await settingTab(page, 'Exposure');
  const document = await current(page);
  const layerId = await page.locator('.layer-control.selected').getAttribute('data-layer-id');
  const layer = document.layers.find((item) => item.id === layerId)!;
  const setting = KEYFRAME_SETTINGS.find((item) => item.label === label)!.key;
  const participants = layer.keyframes.filter((point) => point.values[setting] !== null);
  if (!participants.length) throw new Error(`No enabled ${label} chip exists on ${layer.name}.`);
  const keys = layerKeyframes(page, layer.name);
  const selectedRow = keys.locator('.keyframe-row[aria-current="true"]');
  const selected = (await selectedRow.count()) ? await selectedRow.getAttribute('data-keyframe-frame') : null;
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  const at = selected === null ? frame : Number(selected);
  const anchor =
    participants.find((point) => point.frame === at) ??
    (direction === 'Next'
      ? (participants.filter((point) => point.frame <= at).at(-1) ?? participants[0]!)
      : (participants.find((point) => point.frame >= at) ?? participants.at(-1)!));
  const row = keys.locator(`[data-keyframe-frame="${rowFrame ?? anchor.frame}"]`);
  const button = row
    .locator('.layer-keyframe-chip')
    .getByRole('button', { name: `${direction} ${label} keyframe`, exact: true });
  await expect(button).toHaveCount(1);
  return button;
}

async function navigate(page: Page, label: string, direction: 'Previous' | 'Next', rowFrame?: number): Promise<void> {
  const button = await step(page, label, direction, rowFrame);
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

async function goToPoint(page: Page, frame: number, name = 'Video track 1'): Promise<void> {
  await settingTab(page, 'Exposure');
  const button = layerKeyframes(page, name).getByRole('button', { name: `Go to track keyframe ${frame}`, exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.click();
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

test('unkeyed settings keep diamonds with visible guarded per-setting arrows and disabled section navigation', async ({
  page,
}) => {
  const document = await current(page);
  expect(KEYFRAME_SETTINGS).toHaveLength(11);
  await expect(inspector(page).getByRole('button', { name: /^Keyframe / })).toHaveCount(10);
  for (const { label } of KEYFRAME_SETTINGS) {
    await settingTab(page, label);
    const toggle = diamond(page, label);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle.locator('..')).toHaveClass('keyframe-setting-navigation');
    await expect(toggle.locator('..').getByRole('button')).toHaveCount(3);
    for (const direction of ['Previous', 'Next'] as const) {
      const button = mainStep(page, label, direction);
      await expect(button).toBeVisible();
      await guardedUnavailable(button);
      await expect(button).toHaveAttribute('title', `No ${direction.toLowerCase()} ${label} keyframe`);
      await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
      expect(await button.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
      await button.evaluate((element) => (element as HTMLButtonElement).click());
    }
  }
  await expect(inspector(page).locator('.layer-keyframe-chip')).toHaveCount(0);
  for (const label of ['Colour', 'Speed', 'Transform'] as const) {
    await settingTab(page, label === 'Colour' ? 'Exposure' : 'Speed');
    for (const direction of ['Previous', 'Next'] as const) {
      const button = sectionStep(page, label, direction);
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

test('Colour section arrows visit the Opacity/scalar union, skip Speed-only points and share chip inspection', async ({
  page,
}) => {
  const document = sequence([
    sharedPoint(10, { exposure: 0 }),
    sharedPoint(20, { speed: 1 }),
    sharedPoint(30, { opacity: 0 }),
    sharedPoint(50, { temperature: 0, tint: 0 }),
    sharedPoint(70, { speed: 1 }),
    sharedPoint(100, { shadows: 0 }),
    sharedPoint(130, { highlights: 0 }),
    sharedPoint(160, { brightness: 0 }),
  ]);
  await fixture(page, document);
  const next = sectionStep(page, 'Colour', 'Next');
  const previous = sectionStep(page, 'Colour', 'Previous');
  await expect(previous).toBeDisabled();
  await expect(
    inspector(page)
      .locator('.colour-controls')
      .locator('.keyframe-setting-navigation')
      .getByRole('button', { name: /^(Previous|Next) .* keyframe$/ }),
  ).toHaveCount(20);
  for (const frame of [10, 30, 50, 100, 130, 160]) {
    await next.scrollIntoViewIfNeeded();
    await next.click();
    await previewAt(page, Math.min(frame, 119));
    await expect(layerKeyframes(page, 'Video track 1').locator('.keyframe-row[aria-current="true"]')).toHaveAttribute(
      'data-keyframe-frame',
      String(frame),
    );
  }
  await expect(next).toBeDisabled();
  for (const frame of [130, 100, 50, 30, 10]) {
    await previous.scrollIntoViewIfNeeded();
    await previous.click();
    await previewAt(page, Math.min(frame, 119));
    await expect(layerKeyframes(page, 'Video track 1').locator('.keyframe-row[aria-current="true"]')).toHaveAttribute(
      'data-keyframe-frame',
      String(frame),
    );
  }
  await expect(previous).toBeDisabled();
  // Inspection on a Speed-only point is central too; Colour advances from that stored time.
  await goToPoint(page, 70);
  await next.scrollIntoViewIfNeeded();
  await next.click();
  await previewAt(page, 100);
  await expect(await step(page, 'Temperature', 'Previous', 50)).toBeEnabled();
  await navigate(page, 'Temperature', 'Previous', 50);
  await previewAt(page, 50);
  await next.scrollIntoViewIfNeeded();
  await next.click();
  await previewAt(page, 100);
  await expect(layerKeyframes(page, 'Video track 1').locator('.layer-keyframe-chip')).toHaveCount(9);
  await expect(diamond(page, 'Shadows')).toHaveAttribute('aria-pressed', 'true');
  await readOnly(page, document);
});

test('Speed section union includes clip-source and track Speed keys, excluding Colour-only points', async ({
  page,
}) => {
  const document = sequence([
    sharedPoint(10, { speed: 1 }),
    sharedPoint(20, { exposure: 0 }),
    sharedPoint(40, { speed: 1 }),
    sharedPoint(130, { speed: 1 }),
    sharedPoint(160, { speed: 1 }),
  ]);
  document.clips[0]!.speed = {
    mode: 'curve',
    keyframes: [0, 30, 60].map((frame) => ({ frame, rate: 1, interpolation: 'linear' })),
  };
  await fixture(page, document);
  const placed = calculateLayout(document).clips.find((item) => item.clip.id === 'first')!;
  const targets = [
    ...document.layers[0]!.keyframes.filter((key) => key.values.speed !== null).map((key) => key.frame),
    ...clipKeyframeMarkers(placed, document.layers[0]!)
      .filter((key) => key.type === 'speed')
      .map((key) => key.seekFrame),
  ].sort((left, right) => left - right);
  expect(targets).toEqual([0, 10, 30, 40, 59, 130, 160]);
  await settingTab(page, 'Speed');
  const next = sectionStep(page, 'Speed', 'Next');
  const previous = sectionStep(page, 'Speed', 'Previous');
  await expect(previous).toBeDisabled();
  await expect(
    inspector(page)
      .locator('.speed-settings')
      .locator('.keyframe-setting-navigation')
      .getByRole('button', { name: /^(Previous|Next) Speed keyframe$/ }),
  ).toHaveCount(2);
  for (const frame of targets.slice(1)) {
    await next.scrollIntoViewIfNeeded();
    await next.click();
    await previewAt(page, Math.min(frame, 119));
    if (frame >= 120) {
      await settingTab(page, 'Exposure');
      await expect(layerKeyframes(page, 'Video track 1').locator('.layer-keyframe-inspected')).toContainText(
        `Stored keyframe · timeline frame ${frame}`,
      );
      await settingTab(page, 'Speed');
    }
  }
  await expect(next).toBeDisabled();
  for (const frame of targets.slice(0, -1).reverse()) {
    await previous.scrollIntoViewIfNeeded();
    await previous.click();
    await previewAt(page, Math.min(frame, 119));
  }
  await expect(previous).toBeDisabled();
  // A stored-chip seek must also reset/advance section navigation's shared cursor.
  await goToPoint(page, 130);
  await navigate(page, 'Speed', 'Next', 130);
  await previewAt(page, 119);
  await expect(layerKeyframes(page, 'Video track 1').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 160',
  );
  await settingTab(page, 'Speed');
  await expect(next).toBeDisabled();
  await previous.scrollIntoViewIfNeeded();
  await previous.click();
  await previewAt(page, 119);
  await settingTab(page, 'Exposure');
  await expect(layerKeyframes(page, 'Video track 1').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 130',
  );
  await readOnly(page, document);
});

test('Transform section navigation retains off-trim and exclusive-OUT keys with truthful clamped previews', async ({
  page,
}) => {
  const document = sequence();
  const clip = document.clips[0]!;
  clip.spatial.keyframes = [0, 20, 60, 90].map((frame) => ({
    frame,
    interpolation: 'linear',
    values: { ...clip.spatial.base },
  }));
  await fixture(page, document);
  await settingTab(page, 'Speed');
  const next = sectionStep(page, 'Transform', 'Next');
  const previous = sectionStep(page, 'Transform', 'Previous');
  await expect(previous).toBeDisabled();
  for (const [frame, preview] of [
    [20, 20],
    [60, 59],
    [90, 59],
  ] as const) {
    await next.scrollIntoViewIfNeeded();
    await next.click();
    await previewAt(page, preview);
    await expect(
      inspector(page).getByRole('combobox', { name: 'Selected Transform keyframe', exact: true }),
    ).toHaveValue(String(frame));
    await expect(inspector(page).getByRole('region', { name: 'Stored Transform keyframe', exact: true })).toContainText(
      `Stored source frame ${frame}`,
    );
  }
  await expect(next).toBeDisabled();
  for (const [frame, preview] of [
    [60, 59],
    [20, 20],
    [0, 0],
  ] as const) {
    await previous.scrollIntoViewIfNeeded();
    await previous.click();
    await previewAt(page, preview);
    await expect(
      inspector(page).getByRole('combobox', { name: 'Selected Transform keyframe', exact: true }),
    ).toHaveValue(String(frame));
  }
  await expect(previous).toBeDisabled();
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
    await expect(diamond(page, label)).toBeEnabled();
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    if (key === 'speed')
      await expect(page.getByRole('spinbutton', { name: 'Track speed rate', exact: true })).toBeDisabled();
    else await expect(inspector(page).getByRole('slider', { name: label, exact: true })).toBeDisabled();
    const mainPrevious = mainStep(page, label, 'Previous');
    const mainNext = mainStep(page, label, 'Next');
    await guardedUnavailable(mainPrevious);
    await expect(mainNext).toHaveAttribute('title', `Go to timeline frame ${first}.`);
    await mainNavigate(page, label, 'Next');
    await previewAt(page, first);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'true');
    await guardedUnavailable(mainPrevious);
    await expect(mainNext).toHaveAttribute('title', `Go to timeline frame ${middle}.`);
    await mainNavigate(page, label, 'Next');
    await previewAt(page, middle);
    await mainNavigate(page, label, 'Previous');
    await previewAt(page, first);
    await seek(page, first + 1);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    await expect(mainPrevious).toHaveAttribute('title', `Go to timeline frame ${first}.`);
    await expect(mainNext).toHaveAttribute('title', `Go to timeline frame ${middle}.`);
    await mainNavigate(page, label, 'Next');
    await previewAt(page, middle);
    await mainNavigate(page, label, 'Next');
    await previewAt(page, last);
    await guardedUnavailable(mainNext);
    await expect(mainNext).toBeFocused();
    await mainNext.press('Enter');
    await mainNext.press('Space');
    await previewAt(page, last);
    await mainNavigate(page, label, 'Previous');
    await previewAt(page, middle);
    await readOnly(page, document);
    // Stored chips retain their own anchors after direct seeking clears inspection.
    await seek(page, 0);
    await settingTab(page, label);
    const firstPrevious = await step(page, label, 'Previous', first);
    await firstPrevious.scrollIntoViewIfNeeded();
    await expect(firstPrevious).toBeDisabled();
    await expect(await step(page, label, 'Next', first)).toHaveAttribute('title', `Go to timeline frame ${middle}.`);
    await goToPoint(page, first);
    await previewAt(page, first);
    await settingTab(page, label);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'true');
    await expect(await step(page, label, 'Previous')).toBeDisabled();
    await navigate(page, label, 'Next');
    await previewAt(page, middle);
    await navigate(page, label, 'Previous');
    await previewAt(page, first);
    await seek(page, first + 1);
    await settingTab(page, label);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    // With inspection cleared, different row chips keep their own strict anchors.
    await expect(await step(page, label, 'Previous', middle)).toHaveAttribute(
      'title',
      `Go to timeline frame ${first}.`,
    );
    await expect(await step(page, label, 'Next', first)).toHaveAttribute('title', `Go to timeline frame ${middle}.`);
    await navigate(page, label, 'Previous', middle);
    await previewAt(page, first);
    await navigate(page, label, 'Next');
    await previewAt(page, middle);
    await navigate(page, label, 'Next');
    await previewAt(page, last);
    const next = await step(page, label, 'Next');
    await next.scrollIntoViewIfNeeded();
    await expect(next).toBeVisible();
    await expect(next).toBeDisabled();
    await expect(await step(page, label, 'Previous')).toHaveAttribute('title', `Go to timeline frame ${middle}.`);
    await navigate(page, label, 'Previous');
    await previewAt(page, middle);
    expect(document.layers[0]!.keyframes.find((point) => point.frame === first)!.values[key]).toBe(
      key === 'speed' ? 1 : 0,
    );
    await readOnly(page, document);
  });
}

for (const empty of [false, true]) {
  test(`main per-setting arrows share off-duration inspection with headers and chips on an ${empty ? 'empty' : 'populated'} timeline`, async ({
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
    if (empty) {
      document.clips = [];
      document.layers[0]!.transitions = [];
    }
    await fixture(page, document);
    await goToPoint(page, 60);
    const keys = layerKeyframes(page, 'Video track 1');
    const next = mainStep(page, 'Exposure', 'Next');
    const previous = mainStep(page, 'Exposure', 'Previous');
    const actualFrame = empty ? 0 : 119;
    for (const frame of [120, 180, 240]) {
      const hint = empty
        ? `Stored timeline frame ${frame}; the timeline is empty, so there is no frame to preview.`
        : `Stored timeline frame ${frame}; preview the nearest available frame 119. The keyframe stays in place.`;
      await expect(next).toHaveAttribute('title', hint);
      await mainNavigate(page, 'Exposure', 'Next');
      if (empty) {
        expect(
          await page.evaluate(() => {
            const state = window.pascapLab!.engine.diagnostics();
            return { status: state.status, frame: state.frame, duration: state.duration };
          }),
        ).toEqual({ status: 'empty', frame: 0, duration: 0 });
      } else {
        await previewAt(page, 119);
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
      await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute(
        'data-keyframe-frame',
        String(frame),
      );
      await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
        `Stored keyframe · timeline frame ${frame}`,
      );
      await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
        empty ? 'No preview frame is available.' : 'Preview is at frame 119, not at this stored keyframe.',
      );
      await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'false');
      await expect(diamond(page, 'Exposure')).toHaveAttribute('title', new RegExp(`timeline frame ${actualFrame}\\.`));
      await expect(inspector(page).getByRole('slider', { name: 'Exposure', exact: true })).toBeDisabled();
    }
    await guardedUnavailable(next);
    await expect(next).toBeFocused();
    await next.press('Enter');
    await next.press('Space');
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '240');
    await expect(previous).toHaveAttribute('title', /Stored timeline frame 180;/);
    await sectionStep(page, 'Colour', 'Previous').scrollIntoViewIfNeeded();
    await sectionStep(page, 'Colour', 'Previous').click();
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '180');
    await navigate(page, 'Exposure', 'Previous', 180);
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '120');
    await sectionStep(page, 'Colour', 'Next').scrollIntoViewIfNeeded();
    await sectionStep(page, 'Colour', 'Next').click();
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '130');
    await mainNavigate(page, 'Exposure', 'Next');
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '180');
    await mainNavigate(page, 'Exposure', 'Previous');
    await expect(keys.locator('.keyframe-row[aria-current="true"]')).toHaveAttribute('data-keyframe-frame', '120');
    await readOnly(page, document);
  });
}

test('main diamond tabs through Previous/Next before its value controls and stored chips retain keyboard activation', async ({
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
  expect(
    await toggle.evaluate((button) =>
      Array.from(button.parentElement!.children, (child) => ({
        tag: child.tagName,
        label: child.getAttribute('aria-label'),
      })),
    ),
  ).toEqual([
    { tag: 'BUTTON', label: 'Keyframe Exposure' },
    { tag: 'SPAN', label: null },
  ]);
  const mainPrevious = mainStep(page, 'Exposure', 'Previous');
  const mainNext = mainStep(page, 'Exposure', 'Next');
  expect(
    await mainPrevious.evaluate((button) =>
      Array.from(button.parentElement!.children, (child) => child.getAttribute('aria-label')),
    ),
  ).toEqual(['Previous Exposure keyframe', 'Next Exposure keyframe']);
  expect(await toggle.evaluate((button) => button.parentElement!.nextElementSibling)).toBeNull();
  await toggle.focus();
  await page.keyboard.press('Tab');
  await expect(mainPrevious).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(mainNext).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Exposure', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(mainNext).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(mainPrevious).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(toggle).toBeFocused();
  await mainNext.focus();
  await mainNext.press('Enter');
  await previewAt(page, 50);
  await expect(mainNext).toBeFocused();
  await guardedUnavailable(mainNext);
  await toggle.focus();
  await page.keyboard.press('Tab');
  await expect(mainPrevious).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeFocused();
  await mainPrevious.focus();
  await mainPrevious.press('Space');
  await previewAt(page, 30);
  await expect(mainPrevious).toBeFocused();
  const previous = await step(page, 'Exposure', 'Previous', 30);
  const next = await step(page, 'Exposure', 'Next', 30);
  await previous.scrollIntoViewIfNeeded();
  expect(
    await previous.evaluate((button) =>
      Array.from(button.parentElement!.children, (child) => child.getAttribute('aria-label')),
    ),
  ).toEqual(['Previous Exposure keyframe', 'Next Exposure keyframe']);
  await previous.focus();
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(previous).toBeFocused();
  await page.keyboard.press('Tab');
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
      await settingTab(page, label);
      const main = mainStep(page, label, direction);
      await expect(main).toBeVisible();
      await guardedUnavailable(main);
      await main.evaluate((element) => (element as HTMLButtonElement).click());
      const button = await step(page, label, direction);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
    }
  }
  for (const label of ['Colour', 'Speed', 'Transform'] as const) {
    await settingTab(page, label === 'Colour' ? 'Exposure' : 'Speed');
    for (const direction of ['Previous', 'Next'] as const)
      await expect(sectionStep(page, label, direction)).toBeDisabled();
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await previewAt(page, 45);
  await readOnly(page, document);
});

test('no opened project keeps main diamonds and Colour section navigation disabled without phantom chips or writes', async ({
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
    await expect(diamond(page, label).locator('..').getByRole('button')).toHaveCount(3);
    for (const direction of ['Previous', 'Next'] as const) {
      const button = mainStep(page, label, direction);
      await expect(button).toBeVisible();
      await guardedUnavailable(button);
      await button.evaluate((element) => (element as HTMLButtonElement).click());
    }
  }
  await expect(inspector(page).locator('.layer-keyframe-chip')).toHaveCount(0);
  for (const direction of ['Previous', 'Next'] as const) {
    await expect(sectionStep(page, 'Colour', direction)).toBeVisible();
    await expect(sectionStep(page, 'Colour', direction)).toBeDisabled();
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
  await goToPoint(page, 20, 'Video track 2');
  await previewAt(page, 20);
  const next = await step(page, 'Opacity', 'Next', 20);
  await next.scrollIntoViewIfNeeded();
  await next.focus();
  await next.press('Enter');
  await previewAt(page, 119);
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
  const previous = await step(page, 'Opacity', 'Previous', 20);
  await previous.scrollIntoViewIfNeeded();
  await previous.press('Space');
  await previewAt(page, 20);
  await next.scrollIntoViewIfNeeded();
  await next.press('Space');
  await previewAt(page, 119);
  await expect(next).toBeFocused();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 130',
  );
  await closeOptions(page);
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Opacity', 'Next')).toHaveAttribute('title', /Stored timeline frame 160;/);
  await inspectorTab(page, 'Track keyframes');
  await layerKeyframes(page, 'Video track 2').getByRole('button', { name: 'Next track keyframe', exact: true }).click();
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 140',
  );
  await inspectorTab(page, 'Clip');
  await navigate(page, 'Opacity', 'Next');
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 160',
  );
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Opacity', 'Next')).toBeDisabled();
  await navigate(page, 'Opacity', 'Previous');
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
    await navigate(page, 'Exposure', 'Next');
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
  await expect(await step(page, 'Exposure', 'Next')).toBeDisabled();
  await inspectorTab(page, 'Track keyframes');
  await keys.getByRole('button', { name: 'Previous track keyframe', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 180');
  await keys.getByRole('button', { name: 'Go to track keyframe 120', exact: true }).click();
  await keys.getByRole('button', { name: 'Next track keyframe', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 130');
  await inspectorTab(page, 'Clip');
  await navigate(page, 'Exposure', 'Next');
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 180');
  await inspectorTab(page, 'Clip');
  await navigate(page, 'Exposure', 'Previous');
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 120');
  await keys.getByRole('button', { name: 'Follow playhead', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Exposure', 'Next', 60)).toHaveAttribute('title', /Stored timeline frame 120;/);
  await navigate(page, 'Exposure', 'Previous', 120);
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
  await goToPoint(page, 30);
  for (const frame of [30, 60, 90]) {
    await inspectorTab(page, 'Clip');
    if (frame !== 30) await navigate(page, 'Exposure', 'Next');
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
  await expect(await step(page, 'Exposure', 'Next')).toBeDisabled();
  await navigate(page, 'Exposure', 'Previous');
  await inspectorTab(page, 'Track keyframes');
  await keys.getByRole('button', { name: 'Previous track keyframe', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 45');
  await inspectorTab(page, 'Clip');
  await navigate(page, 'Exposure', 'Next');
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 60');
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Exposure', 'Next')).toHaveAttribute(
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
  await navigate(page, 'Exposure', 'Next');
  await previewAt(page, 119);
  await page.getByRole('button', { name: 'Select track Video track 2', exact: true }).click();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 2').locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Opacity', 'Next', 30)).toHaveAttribute('title', /Stored timeline frame 130;/);
  await expect(
    layerKeyframes(page, 'Video track 2').getByRole('button', { name: 'Next Exposure keyframe', exact: true }),
  ).toHaveCount(0);
  await expect(sectionStep(page, 'Colour', 'Next')).toBeEnabled();
  await navigate(page, 'Opacity', 'Next', 30);
  await page.getByRole('button', { name: 'Select track Video track 1', exact: true }).click();
  await inspectorTab(page, 'Track keyframes');
  await expect(layerKeyframes(page, 'Video track 1').locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 150;/);
  await navigate(page, 'Exposure', 'Next');
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
  await expect(await step(page, 'Exposure', 'Previous', 20)).toBeDisabled();
  await expect(await step(page, 'Exposure', 'Next', 20)).toHaveAttribute('title', /Stored timeline frame 140;/);
  await expect(sectionStep(page, 'Colour', 'Previous')).toBeDisabled();
  await expect(sectionStep(page, 'Colour', 'Next')).toBeEnabled();
  await sectionStep(page, 'Colour', 'Next').scrollIntoViewIfNeeded();
  await sectionStep(page, 'Colour', 'Next').click();
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
  await sectionStep(page, 'Colour', 'Next').scrollIntoViewIfNeeded();
  await sectionStep(page, 'Colour', 'Next').click();
  await previewAt(page, 10);
  await navigate(page, 'Exposure', 'Next');
  await previewAt(page, 119);
  await navigate(page, 'Exposure', 'Next');
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 160');
  await page.getByRole('button', { name: 'Go to timeline end', exact: true }).click();
  await previewAt(page, 119);
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Exposure', 'Next', 10)).toHaveAttribute('title', /Stored timeline frame 130;/);
  await navigate(page, 'Exposure', 'Next', 10);
  await seek(page, 25);
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await navigate(page, 'Exposure', 'Next');
  await previewAt(page, 119);
  await navigate(page, 'Exposure', 'Next');
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  await previewAt(page, frame);
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Exposure', 'Next', 10)).toHaveAttribute(
    'title',
    'Stored timeline frame 130; preview the nearest available frame 119. The keyframe stays in place.',
  );
  // Section navigation resumes from the actual playback position, not the chip's stored anchor.
  const nextFrame = frame < 10 ? 10 : 130;
  await sectionStep(page, 'Colour', 'Next').scrollIntoViewIfNeeded();
  await sectionStep(page, 'Colour', 'Next').click();
  await previewAt(page, Math.min(nextFrame, 119));
  if (nextFrame === 130)
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 130');
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
  await navigate(page, 'Exposure', 'Next');
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
  await expect(await step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 180;/);
  await inspectorTab(page, 'Track keyframes');
  await expect(keys.getByRole('button', { name: 'Next track keyframe', exact: true })).toHaveAttribute(
    'title',
    /Stored timeline frame 160;/,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(await step(page, 'Exposure', 'Next')).toHaveAttribute('title', /Stored timeline frame 175;/);
  await page.evaluate(() => window.pascapLab!.flush());
  const writes = memory.saves;
  const before = await current(page);
  await navigate(page, 'Exposure', 'Next');
  await navigate(page, 'Exposure', 'Next');
  await navigate(page, 'Exposure', 'Previous');
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
        await settingTab(page, label);
        await diamond(page, label).scrollIntoViewIfNeeded();
        const main = mainStep(page, label, direction);
        await expect(main).toBeInViewport();
        expect(
          await main.evaluate((element) => {
            const button = element.getBoundingClientRect();
            const panel = element.closest('.inspector-panel')!.getBoundingClientRect();
            return (
              button.left >= panel.left && button.right <= panel.right && Number(getComputedStyle(element).opacity) > 0
            );
          }),
        ).toBe(true);
        const button = await step(page, label, direction);
        await button.scrollIntoViewIfNeeded();
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
    for (const label of ['Colour', 'Speed', 'Transform'] as const) {
      await settingTab(page, label === 'Colour' ? 'Exposure' : 'Speed');
      for (const direction of ['Previous', 'Next'] as const) {
        const button = sectionStep(page, label, direction);
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        expect(
          await button.evaluate((element) => {
            const button = element.getBoundingClientRect();
            const panel = element.closest('.inspector-panel')!.getBoundingClientRect();
            return button.left >= panel.left && button.right <= panel.right;
          }),
        ).toBe(true);
      }
    }
    expect(await inspector(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await readOnly(page, document);
});
