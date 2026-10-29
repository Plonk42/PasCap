import { expect, test, type Locator, type Page } from '@playwright/test';
import { COLOUR_CONTROLS } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import type { GradeKeyframe } from '../../src/shared/grade.js';
import { KEYFRAME_SETTINGS, uniformKeyframe } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import type { SpatialKeyframe } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipKeyframeMarkers } from '../../src/web/clip-keyframe-markers.js';
import {
  adjustmentFrom0,
  adjustmentKeyframes,
  closeOptions,
  collapsePanel,
  currentKeyframeRow,
  editTransformKeyframe,
  expandedInspectorPreferences,
  expandPanel,
  gradePoint,
  openOptions,
  inspectorTab as openTab,
  settingTab,
  transformKeyframes,
  transformPoint,
} from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let assets: MediaAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];

// Opacity is a track Transform setting (Track tab), with Transform's own stored keyframe cursor; every other setting
// is a Colour setting of the adjustment at the playhead (Colour tab), whose stored chips step from their own rows.
function transformOwned(label: string): boolean {
  return label === 'Opacity';
}

function sliderName(label: string): string {
  return transformOwned(label) ? 'Transform Opacity' : label;
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
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [], missing: [] },
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

/** Two clips over 120 frames under one adjustment from frame 0, so its frames are timeline frames. */
function sequence(keys: GradeKeyframe[] = [], transform: SpatialKeyframe[] = []): ProjectDocument {
  let document = createProject('keyframe-navigation', 'Navigation · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.adjustments = [adjustmentFrom0(120, keys)];
  document.layers[0]!.transform.keyframes = transform;
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
  await openTab(page, 'Adjustment');
  await expect(adjustmentKeyframes(page)).toBeVisible();
}

async function fixture(page: Page, document: ProjectDocument): Promise<void> {
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}

function inspector(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Properties', exact: true });
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
  // Chip arrows are stored-row controls: without an inspected Transform keyframe they step from their row, not the
  // playhead. Prefer the inspected/active row; for a nonparticipant use a neighbouring participant.
  await settingTab(page, label);
  const document = await current(page);
  let participants: readonly { frame: number }[];
  let keys: Locator;
  if (transformOwned(label)) {
    const layerId = await page.locator('.layer-control.selected').getAttribute('data-layer-id');
    const layer = document.layers.find((item) => item.id === layerId)!;
    participants = layer.transform.keyframes.filter((point) => point.values.opacity !== null);
    keys = transformKeyframes(page, layer.name);
  } else {
    const setting = COLOUR_CONTROLS.find((item) => item.label === label)!.key;
    participants = document.adjustments[0]!.keyframes.filter((point) => point.values[setting] !== null);
    keys = adjustmentKeyframes(page);
  }
  if (!participants.length) throw new Error(`No enabled ${label} chip exists.`);
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

/** Select a stored keyframe from its row: Opacity's on the track's Transform list, the others' on the adjustment's. */
async function goToPoint(page: Page, frame: number, label = 'Exposure', name = 'Track 1'): Promise<void> {
  await settingTab(page, label);
  const button = transformOwned(label)
    ? transformKeyframes(page, name).getByRole('button', { name: `Go to Transform keyframe ${frame}`, exact: true })
    : adjustmentKeyframes(page).getByRole('button', { name: `Go to adjustment keyframe ${frame}`, exact: true });
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

/** Each setting keyed alone at three interleaved frames: Opacity on Track 1's Transform, the others on the adjustment. */
function interleaved(): ProjectDocument {
  const colour: GradeKeyframe[] = [];
  const transform: SpatialKeyframe[] = [];
  for (const start of [3, 43, 83])
    for (const [index, { key }] of KEYFRAME_SETTINGS.entries()) {
      if (key === 'opacity') transform.push(transformPoint(start + index * 2, { opacity: 0 }));
      else colour.push(gradePoint(start + index * 2, { [key]: 0 }));
    }
  return sequence(colour, transform);
}

function storedValue(
  document: ProjectDocument,
  key: (typeof KEYFRAME_SETTINGS)[number]['key'],
  frame: number,
): number | null {
  if (key === 'opacity')
    return document.layers[0]!.transform.keyframes.find((point) => point.frame === frame)!.values.opacity;
  return document.adjustments[0]!.keyframes.find((point) => point.frame === frame)!.values[key];
}

test('unkeyed settings keep diamonds with visible guarded per-setting arrows and disabled section navigation', async ({
  page,
}) => {
  const document = await current(page);
  expect(KEYFRAME_SETTINGS).toHaveLength(15);
  // Fourteen adjustment Colour diamonds in Colour; Opacity's joins the eight Transform capture buttons in Track.
  await openTab(page, 'Adjustment');
  await expect(inspector(page).getByRole('button', { name: /^Keyframe / })).toHaveCount(14);
  await openTab(page, 'Track');
  await expect(inspector(page).getByRole('button', { name: /^Keyframe / })).toHaveCount(9);
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
    await settingTab(page, label);
    for (const direction of ['Previous', 'Next'] as const) {
      const button = sectionStep(page, label, direction);
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
      expect(await button.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
      await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    }
  }
  for (const { label } of KEYFRAME_SETTINGS) {
    await settingTab(page, label);
    await expect(inspector(page).getByRole('slider', { name: sliderName(label), exact: true })).toBeEnabled();
  }
  await openTab(page, 'Clip');
  await expect(page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Keyframe Speed', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await readOnly(page, document);
});

test('Colour section arrows visit every adjustment keyframe, while stored chips step from their own rows', async ({
  page,
}) => {
  const document = sequence([
    gradePoint(10, { exposure: 0 }),
    gradePoint(30, { saturation: 0 }),
    gradePoint(50, { temperature: 0, tint: 0 }),
    gradePoint(80, { shadows: 0 }),
    gradePoint(100, { highlights: 0 }),
    gradePoint(110, { brightness: 0, exposure: 1 }),
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
  ).toHaveCount(28);
  for (const frame of [10, 30, 50, 80, 100, 110]) {
    await next.scrollIntoViewIfNeeded();
    await next.click();
    await previewAt(page, frame);
    await expect(currentKeyframeRow(adjustmentKeyframes(page))).toHaveAttribute('data-keyframe-frame', String(frame));
  }
  await expect(next).toBeDisabled();
  for (const frame of [100, 80, 50, 30, 10]) {
    await previous.scrollIntoViewIfNeeded();
    await previous.click();
    await previewAt(page, frame);
    await expect(currentKeyframeRow(adjustmentKeyframes(page))).toHaveAttribute('data-keyframe-frame', String(frame));
  }
  await expect(previous).toBeDisabled();
  // A stored chip steps from its own row; Colour then advances from the real playhead.
  await goToPoint(page, 50);
  await next.scrollIntoViewIfNeeded();
  await next.click();
  await previewAt(page, 80);
  await expect(await step(page, 'Temperature', 'Previous', 50)).toBeDisabled();
  await expect(await step(page, 'Temperature', 'Next', 50)).toBeDisabled();
  await navigate(page, 'Exposure', 'Next', 10);
  await previewAt(page, 110);
  await previous.scrollIntoViewIfNeeded();
  await previous.click();
  await previewAt(page, 100);
  await expect(adjustmentKeyframes(page).locator('.layer-keyframe-chip')).toHaveCount(8);
  await expect(diamond(page, 'Highlights')).toHaveAttribute('aria-pressed', 'true');
  await readOnly(page, document);
});

test('Speed section navigation visits only the clip speed keys, including off-trim and exclusive-OUT keys', async ({
  page,
}) => {
  const document = sequence([gradePoint(20, { exposure: 0 })], [transformPoint(40, { opacity: 0.5 })]);
  document.clips[0]!.speed = {
    mode: 'curve',
    keyframes: [0, 30, 60, 90].map((frame) => ({ frame, rate: 1, interpolation: 'linear' })),
  };
  await fixture(page, document);
  const placed = calculateLayout(document).clips.find((item) => item.clip.id === 'first')!;
  expect(
    clipKeyframeMarkers(placed)
      .filter((key) => key.type === 'speed')
      .map((key) => key.seekFrame),
  ).toEqual([0, 30, 59]);
  await settingTab(page, 'Speed');
  const next = sectionStep(page, 'Speed', 'Next');
  const previous = sectionStep(page, 'Speed', 'Previous');
  await expect(previous).toBeDisabled();
  await expect(inspector(page).locator('.speed-settings .section-keyframe-count')).toHaveText('4 keyframes');
  await expect(
    inspector(page)
      .locator('.speed-settings')
      .locator('.keyframe-setting-navigation')
      .getByRole('button', { name: /^(Previous|Next) Speed keyframe$/ }),
  ).toHaveCount(0);
  const stored = inspector(page).getByRole('spinbutton', { name: 'Clip speed keyframe source frame', exact: true });
  for (const [frame, preview] of [
    [30, 30],
    [60, 59],
    [90, 59],
  ] as const) {
    await next.scrollIntoViewIfNeeded();
    await next.click();
    await previewAt(page, preview);
    await expect(stored).toHaveValue(String(frame));
  }
  await expect(next).toBeDisabled();
  for (const [frame, preview] of [
    [60, 59],
    [30, 30],
    [0, 0],
  ] as const) {
    await previous.scrollIntoViewIfNeeded();
    await previous.click();
    await previewAt(page, preview);
    await expect(stored).toHaveValue(String(frame));
  }
  await expect(previous).toBeDisabled();
  await readOnly(page, document);
});

test('Transform section navigation retains keyframes after the duration with truthful clamped previews', async ({
  page,
}) => {
  const document = sequence();
  const track = document.layers[0]!.transform;
  track.keyframes = [0, 20, 130, 150].map((frame) => ({
    ...uniformKeyframe(frame, { ...track.base }, 'linear'),
    reset: false,
  }));
  expect(calculateLayout(document).duration).toBe(120);
  await fixture(page, document);
  await settingTab(page, 'Transform');
  const next = sectionStep(page, 'Transform', 'Next');
  const previous = sectionStep(page, 'Transform', 'Previous');
  await expect(previous).toBeDisabled();
  for (const [frame, preview] of [
    [20, 20],
    [130, 119],
    [150, 119],
  ] as const) {
    await next.scrollIntoViewIfNeeded();
    await next.click();
    await previewAt(page, preview);
    await expect(currentKeyframeRow(transformKeyframes(page))).toHaveAttribute('data-keyframe-frame', String(frame));
    if (frame !== preview)
      await expect(transformKeyframes(page).locator('.layer-keyframe-inspected')).toContainText(
        `Stored keyframe · timeline frame ${frame}`,
      );
  }
  await expect(next).toBeDisabled();
  for (const [frame, preview] of [
    [130, 119],
    [20, 20],
    [0, 0],
  ] as const) {
    await previous.scrollIntoViewIfNeeded();
    await previous.click();
    await previewAt(page, preview);
    await expect(currentKeyframeRow(transformKeyframes(page))).toHaveAttribute('data-keyframe-frame', String(frame));
  }
  await expect(previous).toBeDisabled();
  await readOnly(page, document);
});

for (const [index, { key, label }] of KEYFRAME_SETTINGS.entries()) {
  test(`${label} navigates only its three interleaved participating points, including zero, gaps and exact ends`, async ({
    page,
  }) => {
    const document = interleaved();
    await fixture(page, document);
    const first = 3 + index * 2;
    const middle = 43 + index * 2;
    const last = 83 + index * 2;
    const go = (frame: number): string =>
      `Go to ${transformOwned(label) ? 'timeline frame' : 'frame in adjustment'} ${frame}.`;
    await settingTab(page, label);
    await expect(diamond(page, label)).toBeEnabled();
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    await expect(inspector(page).getByRole('slider', { name: sliderName(label), exact: true })).toBeDisabled();
    const mainPrevious = mainStep(page, label, 'Previous');
    const mainNext = mainStep(page, label, 'Next');
    await guardedUnavailable(mainPrevious);
    await expect(mainNext).toHaveAttribute('title', go(first));
    await mainNavigate(page, label, 'Next');
    await previewAt(page, first);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'true');
    await guardedUnavailable(mainPrevious);
    await expect(mainNext).toHaveAttribute('title', go(middle));
    await mainNavigate(page, label, 'Next');
    await previewAt(page, middle);
    await mainNavigate(page, label, 'Previous');
    await previewAt(page, first);
    await seek(page, first + 1);
    await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'false');
    await expect(mainPrevious).toHaveAttribute('title', go(first));
    await expect(mainNext).toHaveAttribute('title', go(middle));
    await mainNavigate(page, label, 'Next');
    await previewAt(page, middle);
    await mainNavigate(page, label, 'Next');
    await previewAt(page, last);
    await guardedUnavailable(mainNext);
    await expect(mainNext).toBeFocused();
    // After a click Space would play; focused by keyboard, the unavailable button activates nothing.
    await mainNext.blur();
    await mainNext.focus();
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
    await expect(await step(page, label, 'Next', first)).toHaveAttribute('title', go(middle));
    await goToPoint(page, first, label);
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
    await expect(await step(page, label, 'Previous', middle)).toHaveAttribute('title', go(first));
    await expect(await step(page, label, 'Next', first)).toHaveAttribute('title', go(middle));
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
    await expect(await step(page, label, 'Previous')).toHaveAttribute('title', go(middle));
    await navigate(page, label, 'Previous');
    await previewAt(page, middle);
    expect(storedValue(document, key, first)).toBe(0);
    await readOnly(page, document);
  });
}

for (const empty of [false, true]) {
  test(`main Transform arrows share off-duration inspection with headers and chips on an ${empty ? 'empty' : 'populated'} timeline`, async ({
    page,
  }) => {
    const document = sequence(
      [],
      [
        transformPoint(10, { opacity: 0 }),
        transformPoint(60, { opacity: 0.25 }),
        transformPoint(120, { opacity: 0.5 }),
        transformPoint(130, { scale: 1 }),
        transformPoint(180, { opacity: 0.75 }),
        transformPoint(240, { opacity: 1 }),
      ],
    );
    if (empty) {
      document.clips = [];
      document.layers[0]!.transitions = [];
    }
    await fixture(page, document);
    await goToPoint(page, 60, 'Opacity');
    const keys = transformKeyframes(page);
    const next = mainStep(page, 'Opacity', 'Next');
    const previous = mainStep(page, 'Opacity', 'Previous');
    const actualFrame = empty ? 0 : 119;
    for (const frame of [120, 180, 240]) {
      const hint = empty
        ? `Stored timeline frame ${frame}; the timeline is empty, so there is no frame to preview.`
        : `Stored timeline frame ${frame}; preview the nearest available frame 119. The keyframe stays in place.`;
      await expect(next).toHaveAttribute('title', hint);
      await mainNavigate(page, 'Opacity', 'Next');
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
              return { status: state.status, sourceFrame: state.decodedSourceFrames[index] };
            }),
          )
          .toEqual({ status: 'paused', sourceFrame: 89 });
      }
      await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', String(frame));
      await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
        `Stored keyframe · timeline frame ${frame}`,
      );
      await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
        empty ? 'No preview frame is available.' : 'Preview is at frame 119, not at this stored keyframe.',
      );
      await expect(diamond(page, 'Opacity')).toHaveAttribute('aria-pressed', 'false');
      await expect(diamond(page, 'Opacity')).toHaveAttribute('title', new RegExp(`timeline frame ${actualFrame}\\.`));
      await expect(inspector(page).getByRole('slider', { name: 'Transform Opacity', exact: true })).toBeDisabled();
    }
    await guardedUnavailable(next);
    await expect(next).toBeFocused();
    // After a click Space would play; focused by keyboard, the unavailable button activates nothing.
    await next.blur();
    await next.focus();
    await next.press('Enter');
    await next.press('Space');
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', '240');
    await expect(previous).toHaveAttribute('title', /Stored timeline frame 180;/);
    await sectionStep(page, 'Transform', 'Previous').scrollIntoViewIfNeeded();
    await sectionStep(page, 'Transform', 'Previous').click();
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', '180');
    await navigate(page, 'Opacity', 'Previous', 180);
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', '120');
    await sectionStep(page, 'Transform', 'Next').scrollIntoViewIfNeeded();
    await sectionStep(page, 'Transform', 'Next').click();
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', '130');
    await mainNavigate(page, 'Opacity', 'Next');
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', '180');
    await mainNavigate(page, 'Opacity', 'Previous');
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', '120');
    await readOnly(page, document);
  });
}

test('main diamond tabs through Previous/Next before its value controls and stored chips retain keyboard activation', async ({
  page,
}) => {
  const document = sequence([
    gradePoint(10, { exposure: 0.5 }),
    gradePoint(30, { exposure: 1 }),
    gradePoint(50, { exposure: 1.5 }),
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
  // The chip steps from its own row, wherever the playhead is.
  await previous.focus();
  await previous.press('Space');
  await previewAt(page, 10);
  await expect(previous).toBeFocused();
  await readOnly(page, document);
});

test('all fifteen setting buttons remain present and disabled throughout a native trim draft', async ({ page }) => {
  const document = interleaved();
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
    await settingTab(page, label);
    for (const direction of ['Previous', 'Next'] as const)
      await expect(sectionStep(page, label, direction)).toBeDisabled();
  }
  await settingTab(page, 'Speed');
  await expect(page.getByRole('button', { name: 'Keyframe Speed', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await previewAt(page, 45);
  await readOnly(page, document);
});

test('no opened project keeps Transform buttons and section navigation disabled, without Colour diamonds, phantom chips or writes', async ({
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
  // Without a project there is no adjustment to grade, so Colour offers only an unavailable new one.
  await openTab(page, 'Colour');
  await expect(inspector(page).getByRole('button', { name: /^Keyframe / })).toHaveCount(0);
  await expect(sectionStep(page, 'Colour', 'Next')).toHaveCount(0);
  const create = inspector(page).getByRole('group', { name: 'New adjustment', exact: true }).getByRole('button');
  await expect(create).toHaveCount(2);
  for (const button of await create.all()) await expect(button).toBeDisabled();
  // Speed is clip-owned, so without a project only the track's nine Transform settings exist.
  await openTab(page, 'Track');
  const toggles = inspector(page)
    .locator('.keyframe-setting-navigation')
    .getByRole('button', { name: /^Keyframe / });
  await expect(toggles).toHaveCount(9);
  for (const toggle of await toggles.all()) {
    await expect(toggle).toBeDisabled();
    const label = (await toggle.getAttribute('aria-label'))!.slice('Keyframe '.length);
    await expect(toggle.locator('..').getByRole('button')).toHaveCount(3);
    for (const direction of ['Previous', 'Next'] as const) {
      const button = mainStep(page, label, direction);
      await expect(button).toBeVisible();
      await guardedUnavailable(button);
      await button.evaluate((element) => (element as HTMLButtonElement).click());
    }
  }
  await expect(inspector(page).locator('.layer-keyframe-chip')).toHaveCount(0);
  for (const direction of ['Previous', 'Next'] as const) {
    await expect(sectionStep(page, 'Transform', direction)).toBeVisible();
    await expect(sectionStep(page, 'Transform', direction)).toBeDisabled();
  }
  expect(await page.evaluate(() => window.pascapLab!.project())).toBeNull();
  expect(memory.saves).toBe(0);
});

test('single Opacity navigation on a selected empty track preserves Properties context and shares the Transform cursor without stealing focus', async ({
  page,
}) => {
  let document = sequence([], [transformPoint(10, { opacity: 0 }), transformPoint(100, { opacity: 0.5 })]);
  const upper = createLayer('upper', 'Track 2', false);
  upper.transform.keyframes = [
    transformPoint(20, { opacity: 0 }),
    transformPoint(130, { opacity: 0.5 }),
    transformPoint(140, { scale: 1 }),
    transformPoint(160, { opacity: 1 }),
  ];
  document = applyCommand(document, { type: 'layer-add', layer: upper });
  await fixture(page, document);
  await openTab(page, 'Track');
  await collapsePanel(page, 'Properties').click();
  await expect(inspector(page)).toBeHidden();
  await openOptions(page, 'Track options Track 2');
  const options = page.getByRole('group', { name: 'Track options Track 2', exact: true });
  await expect(options.getByRole('slider')).toHaveCount(0);
  await expect(options.getByRole('button', { name: /Opacity keyframe/ })).toHaveCount(0);
  await closeOptions(page);
  await expandPanel(page, 'Properties').click();
  await page.getByRole('button', { name: 'Select track Track 2', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  await goToPoint(page, 20, 'Opacity', 'Track 2');
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
    'Select a clip on Track 2 to edit it.',
  );
  await openTab(page, 'Track');
  await expect(transformKeyframes(page, 'Track 2')).toBeVisible();
  await expect(page.locator('.layer-control.selected')).toHaveAttribute('data-layer-id', 'upper');
  const previous = await step(page, 'Opacity', 'Previous', 20);
  await previous.scrollIntoViewIfNeeded();
  await previous.press('Space');
  await previewAt(page, 20);
  await next.scrollIntoViewIfNeeded();
  await next.press('Space');
  await previewAt(page, 119);
  await expect(next).toBeFocused();
  await expect(transformKeyframes(page, 'Track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 130',
  );
  await closeOptions(page);
  await expect(await step(page, 'Opacity', 'Next')).toHaveAttribute('title', /Stored timeline frame 160;/);
  await sectionStep(page, 'Transform', 'Next').click();
  await expect(transformKeyframes(page, 'Track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 140',
  );
  await navigate(page, 'Opacity', 'Next');
  await expect(transformKeyframes(page, 'Track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 160',
  );
  await expect(await step(page, 'Opacity', 'Next')).toBeDisabled();
  await navigate(page, 'Opacity', 'Previous');
  await expect(transformKeyframes(page, 'Track 2').locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 130',
  );
  await readOnly(page, document);
});

test('successive outside-duration setting, row and list navigation keeps one truthful Transform cursor and real clamped source/playhead frames', async ({
  page,
}) => {
  const document = sequence(
    [],
    [
      transformPoint(10, { opacity: 0 }),
      transformPoint(60, { opacity: 0.25 }),
      transformPoint(120, { opacity: 0.5 }),
      transformPoint(130, { scale: 1 }),
      transformPoint(180, { opacity: 0.75 }),
      transformPoint(240, { opacity: 1 }),
    ],
  );
  await fixture(page, document);
  await page
    .locator('[data-clip-id="second"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await previewAt(page, 60);
  const keys = transformKeyframes(page);
  await editTransformKeyframe(page, 120);
  for (const frame of [120, 180, 240]) {
    await navigate(page, 'Opacity', 'Next');
    await previewAt(page, 119);
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
      `Stored keyframe · timeline frame ${frame} · outside current duration`,
    );
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
      'Preview is at frame 119, not at this stored keyframe.',
    );
    await expect(keys.locator('.layer-keyframe-current')).toContainText('Timeline frame 119');
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', String(frame));
    await expect(diamond(page, 'Opacity')).toHaveAttribute('aria-pressed', 'false');
    await expect(diamond(page, 'Opacity')).toHaveAttribute('title', /timeline frame 119\./);
    await expect(page.getByRole('slider', { name: 'Transform Opacity', exact: true })).toBeDisabled();
    await openTab(page, 'Clip');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.pascapLab!.engine.diagnostics();
          const index = state.assignedClipIds.indexOf('second');
          return { status: state.status, sourceFrame: state.decodedSourceFrames[index] };
        }),
      )
      .toEqual({ status: 'paused', sourceFrame: 89 });
  }
  await expect(await step(page, 'Opacity', 'Next')).toBeDisabled();
  await sectionStep(page, 'Transform', 'Previous').click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 180');
  await keys.getByRole('button', { name: 'Go to Transform keyframe 120', exact: true }).click();
  await sectionStep(page, 'Transform', 'Next').click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 130');
  await navigate(page, 'Opacity', 'Next');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 180');
  await navigate(page, 'Opacity', 'Previous');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 120');
  await keys.getByRole('button', { name: 'Follow playhead', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(await step(page, 'Opacity', 'Next', 60)).toHaveAttribute('title', /Stored timeline frame 120;/);
  await navigate(page, 'Opacity', 'Previous', 120);
  await previewAt(page, 60);
  await readOnly(page, document);
});

test('an empty timeline can inspect successive stored Transform keys, without pretending that a preview or keyed button exists there', async ({
  page,
}) => {
  const document = createProject('keyframe-navigation', 'Empty timeline · memory-only');
  document.adjustments = [adjustmentFrom0(120)];
  document.layers[0]!.transform.keyframes = [
    transformPoint(30, { opacity: 0 }),
    transformPoint(45, { scale: 1 }),
    transformPoint(60, { opacity: 0.5 }),
    transformPoint(90, { opacity: 1 }),
  ];
  await fixture(page, document);
  const keys = transformKeyframes(page);
  await editTransformKeyframe(page, 30);
  await goToPoint(page, 30, 'Opacity');
  for (const frame of [30, 60, 90]) {
    if (frame !== 30) await navigate(page, 'Opacity', 'Next');
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText(`Stored keyframe · timeline frame ${frame}`);
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText('No preview frame is available.');
    await expect(keys.locator('.layer-keyframe-current')).toHaveText('Empty timeline · no preview frame');
    await expect(currentKeyframeRow(keys)).toHaveAttribute('data-keyframe-frame', String(frame));
    expect(
      await page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame, duration: state.duration };
      }),
    ).toEqual({ status: 'empty', frame: 0, duration: 0 });
    await expect(diamond(page, 'Opacity')).toHaveAttribute('aria-pressed', 'false');
    await expect(diamond(page, 'Opacity')).toHaveAttribute('title', /timeline frame 0\./);
  }
  await expect(await step(page, 'Opacity', 'Next')).toBeDisabled();
  await navigate(page, 'Opacity', 'Previous');
  await sectionStep(page, 'Transform', 'Previous').click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 45');
  await navigate(page, 'Opacity', 'Next');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 60');
  await expect(await step(page, 'Opacity', 'Next')).toHaveAttribute(
    'title',
    'Stored timeline frame 90; the timeline is empty, so there is no frame to preview.',
  );
  await readOnly(page, document);
});

test('track and project switches discard the old Transform cursor even when track IDs are reused', async ({ page }) => {
  let document = sequence(
    [],
    [
      transformPoint(10, { opacity: 0, scale: 1 }),
      transformPoint(100, { opacity: 0.5 }),
      transformPoint(150, { opacity: 1 }),
    ],
  );
  const upper = createLayer('upper', 'Track 2', false);
  upper.transform.keyframes = [transformPoint(30, { opacity: 0 }), transformPoint(130, { opacity: 1 })];
  document = applyCommand(document, { type: 'layer-add', layer: upper });
  await fixture(page, document);
  await seek(page, 100);
  await navigate(page, 'Opacity', 'Next');
  await previewAt(page, 119);
  await expect(transformKeyframes(page).locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 150',
  );
  await page.getByRole('button', { name: 'Select track Track 2', exact: true }).click();
  await expect(transformKeyframes(page, 'Track 2').locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(await step(page, 'Opacity', 'Next', 30)).toHaveAttribute('title', /Stored timeline frame 130;/);
  await expect(
    transformKeyframes(page, 'Track 2').getByRole('button', { name: 'Next Scale keyframe', exact: true }),
  ).toHaveCount(0);
  await expect(sectionStep(page, 'Transform', 'Next')).toBeEnabled();
  await navigate(page, 'Opacity', 'Next', 30);
  await page.getByRole('button', { name: 'Select track Track 1', exact: true }).click();
  await expect(transformKeyframes(page).locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(await step(page, 'Opacity', 'Next')).toHaveAttribute('title', /Stored timeline frame 150;/);
  await navigate(page, 'Opacity', 'Next');
  const other = {
    ...sequence([], [transformPoint(20, { opacity: 0 }), transformPoint(140, { opacity: 1 })]),
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
  await openTab(page, 'Track');
  await expect(transformKeyframes(page).locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(await step(page, 'Opacity', 'Previous', 20)).toBeDisabled();
  await expect(await step(page, 'Opacity', 'Next', 20)).toHaveAttribute('title', /Stored timeline frame 140;/);
  await expect(sectionStep(page, 'Transform', 'Previous')).toBeDisabled();
  await expect(sectionStep(page, 'Transform', 'Next')).toBeEnabled();
  await sectionStep(page, 'Transform', 'Next').scrollIntoViewIfNeeded();
  await sectionStep(page, 'Transform', 'Next').click();
  await previewAt(page, 20);
  await readOnly(page, other);
  expect(memory.snapshot(document.id)).toEqual(document);
});

test('manual seeking to the same clamped last frame, direct seeks and playback reset Transform inspection', async ({
  page,
}) => {
  const document = sequence(
    [],
    [transformPoint(10, { opacity: 0 }), transformPoint(130, { opacity: 0.5 }), transformPoint(160, { opacity: 1 })],
  );
  await fixture(page, document);
  const keys = transformKeyframes(page);
  await settingTab(page, 'Transform');
  await sectionStep(page, 'Transform', 'Next').scrollIntoViewIfNeeded();
  await sectionStep(page, 'Transform', 'Next').click();
  await previewAt(page, 10);
  await navigate(page, 'Opacity', 'Next');
  await previewAt(page, 119);
  await navigate(page, 'Opacity', 'Next');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 160');
  await page.getByRole('button', { name: 'Go to timeline end', exact: true }).click();
  await previewAt(page, 119);
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(await step(page, 'Opacity', 'Next', 10)).toHaveAttribute('title', /Stored timeline frame 130;/);
  await navigate(page, 'Opacity', 'Next', 10);
  await seek(page, 25);
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await navigate(page, 'Opacity', 'Next');
  await previewAt(page, 119);
  await navigate(page, 'Opacity', 'Next');
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  await previewAt(page, frame);
  await expect(await step(page, 'Opacity', 'Next', 10)).toHaveAttribute(
    'title',
    'Stored timeline frame 130; preview the nearest available frame 119. The keyframe stays in place.',
  );
  // Section navigation resumes from the actual playback position, not the chip's stored anchor.
  const nextFrame = frame < 10 ? 10 : 130;
  await sectionStep(page, 'Transform', 'Next').scrollIntoViewIfNeeded();
  await sectionStep(page, 'Transform', 'Next').click();
  await previewAt(page, Math.min(nextFrame, 119));
  if (nextFrame === 130)
    await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 130');
  await readOnly(page, document);
});

test('point moves and history retain input identity and the Transform cursor, while deletion safely resumes playhead navigation', async ({
  page,
}) => {
  const document = sequence(
    [],
    [
      transformPoint(10, { opacity: 0 }),
      transformPoint(150, { opacity: 0.5 }),
      transformPoint(160, { scale: 1 }),
      transformPoint(180, { opacity: 1 }),
    ],
  );
  await fixture(page, document);
  await seek(page, 10);
  await navigate(page, 'Opacity', 'Next');
  await previewAt(page, 119);
  const keys = transformKeyframes(page);
  const row = await editTransformKeyframe(page, 150);
  const time = row.getByRole('spinbutton', { name: 'Transform keyframe frame 150', exact: true });
  const id = await time.getAttribute('id');
  await time.fill('175');
  await time.press('Enter');
  const moved = keys.getByRole('spinbutton', { name: 'Transform keyframe frame 175', exact: true });
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
  await keys.getByRole('button', { name: 'Delete Transform keyframe 175', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(await step(page, 'Opacity', 'Next')).toHaveAttribute('title', /Stored timeline frame 180;/);
  // The section line resumes from the playhead too (its buttons carry no hints), then follows it again.
  await sectionStep(page, 'Transform', 'Next').click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 160');
  await keys.getByRole('button', { name: 'Follow playhead', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await expect(await step(page, 'Opacity', 'Next')).toHaveAttribute('title', /Stored timeline frame 175;/);
  await page.evaluate(() => window.pascapLab!.flush());
  const writes = memory.saves;
  const before = await current(page);
  await navigate(page, 'Opacity', 'Next');
  await navigate(page, 'Opacity', 'Next');
  await navigate(page, 'Opacity', 'Previous');
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(writes);
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
});

test('all navigation groups fit the 270px inspector at the default and minimum viewports without overflow or hidden buttons', async ({
  page,
}) => {
  // 38 s measured CI-like (software GL, two cores).
  test.setTimeout(120_000);
  const document = interleaved();
  await fixture(page, document);
  const resizer = page.getByRole('slider', { name: 'Resize Properties panel', exact: true });
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
      await settingTab(page, label);
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
