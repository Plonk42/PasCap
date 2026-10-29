import { expect, test, type Locator, type Page } from '@playwright/test';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { defaultSpatialKeyframe, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { expandedInspectorPreferences, inspectorTab, transformKeyframes, transformPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let assets: MediaAsset[];
let unexpectedApi: string[];

test.beforeEach(async ({ page, request }) => {
  assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets.filter((asset) =>
    ['pattern-a.mp4', 'pattern-b.mp4'].includes(asset.name),
  );
  unexpectedApi = [];
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [], missing: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && reads[pathname]) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    const video = /^\/api\/media\/([^/]+)\/(proxy|thumbnail\/\d+)$/.exec(pathname);
    if (route.request().method() === 'GET' && video && assets.some((asset) => asset.id === video[1])) {
      await route.continue();
      return;
    }
    unexpectedApi.push(`${route.request().method()} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  memory = await memoryProjects(page, sequence());
  await expandedInspectorPreferences(page);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.goto('/?project=timeline-points');
  await ready(page, sequence());
});
test.afterEach(() => {
  expect(unexpectedApi, 'Only existing synthetic proxy reads and memory project writes are allowed').toEqual([]);
});

function sequence(): ProjectDocument {
  const project = createProject('timeline-points', 'Timeline point movement · memory-only');
  project.media.videoIds = assets.map((asset) => asset.id);
  project.clips = [
    createClip('first', assets[0]!.id, 0, 60),
    { ...createClip('second', assets[1]!.id, 30, 90), start: 60 },
  ];
  project.layers[0]!.transitions = [{ leftId: 'first', rightId: 'second', type: 'cut', duration: 0 }];
  // Track Transform keyframes are the timeline's project-frame keyframe markers.
  project.layers[0]!.transform.keyframes = [
    transformPoint(20, { ...NEUTRAL_SPATIAL_POSE, scale: 1.6, opacity: 0.7 }, 'ease-in'),
    transformPoint(80, { scale: 0.8 }, 'hold'),
  ];
  return projectSchema.parse(project);
}
/** The project with one Transform keyframe moved, as a marker slide commits it. */
function moved(project: ProjectDocument, frame: number, nextFrame: number, layerId = 'video-1'): ProjectDocument {
  const next = structuredClone(project);
  const transform = next.layers.find((layer) => layer.id === layerId)!.transform;
  transform.keyframes = transform.keyframes
    .map((point) => (point.frame === frame ? { ...point, frame: nextFrame } : point))
    .sort((left, right) => left.frame - right.frame);
  return next;
}
async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}
async function ready(page: Page, project: ProjectDocument): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab?.engine.diagnostics();
        return { status: state?.status, duration: state?.duration };
      }),
    )
    .toEqual({ status: 'paused', duration: calculateLayout(project).duration });
}
async function fixture(page: Page, project: ProjectDocument): Promise<void> {
  // Persist the fixture's actual derived Ripple placements before testing edits.
  for (const placed of calculateLayout(project).clips) {
    if (project.layers.find((layer) => layer.id === placed.clip.layerId)!.ripple) placed.clip.start = placed.start;
  }
  memory.seed(project);
  await page.reload();
  await ready(page, project);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}
function marker(page: Page, frame: number, layerId = 'video-1'): Locator {
  return page.locator(`[data-transform-layer="${layerId}"][data-transform-keyframe="${frame}"]`);
}
async function begin(page: Page, frame = 20, layerId = 'video-1') {
  const target = marker(page, frame, layerId);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // A press alone is not a drag: the draft starts only after the 3-pixel threshold.
  await expect(page.locator('.timeline-surface')).not.toHaveClass(/keyframe-drafting/);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, scale, frame, target };
}
async function move(page: Page, start: Awaited<ReturnType<typeof begin>>, frame: number, alt = false): Promise<void> {
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(start.x + (frame - start.frame) * start.scale, start.y, { steps: 6 });
  await expect(page.locator('.timeline-surface')).toHaveClass(/keyframe-drafting/);
}
async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
}

test('dragging a marker moves all enabled settings/easing with preview-only drafts, one Undo, saved reload and focused destination', async ({
  page,
}) => {
  const before = await current(page);
  await seek(page, 5);
  await inspectorTab(page, 'Track');
  const start = await begin(page);
  await move(page, start, 30, true);
  await page.keyboard.up('Alt');
  await expect(marker(page, 30)).toHaveClass(/moving/);
  await expect(marker(page, 30)).toHaveAttribute('data-keyframe-origin', '20');
  await expect(marker(page, 30).locator('.timeline-layer-key-time')).toHaveText('00:01:00');
  await expect(page.locator('.timeline-bottom')).toContainText('all its settings move together');
  expect(await current(page)).toEqual(before);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const keys = transformKeyframes(page);
  await expect(keys.locator('[data-keyframe-frame="20"]')).toHaveCount(0);
  const chipNext = keys
    .locator('[data-keyframe-frame="30"] .layer-keyframe-chip')
    .getByRole('button', { name: 'Next Scale keyframe', exact: true });
  const triangle = page.getByRole('button', { name: 'Keyframe Scale', exact: true });
  const main = triangle.locator('..');
  await expect(main).toHaveClass(/\bkeyframe-setting-navigation\b/);
  await expect(main.getByRole('button')).toHaveCount(3);
  await expect(triangle).toBeDisabled();
  for (const arrow of [
    chipNext,
    main.getByRole('button', { name: 'Previous Scale keyframe', exact: true }),
    main.getByRole('button', { name: 'Next Scale keyframe', exact: true }),
  ]) {
    await expect(arrow).toHaveJSProperty('tagName', 'BUTTON');
    await expect(arrow).toHaveAttribute('aria-disabled', 'true');
    await expect(arrow).toHaveJSProperty('disabled', false);
    await expect(arrow).toHaveAttribute('tabindex', '-1');
    await arrow.focus();
    for (const activation of ['Enter', 'Space']) {
      await arrow.press(activation);
      await expect(arrow).toBeFocused();
      await expect(marker(page, 30)).toHaveClass(/moving/);
      expect(await current(page)).toEqual(before);
      await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(30);
    }
  }
  await expect(
    page.locator('.section-keyframe-line').getByRole('button', { name: 'Next Transform keyframe', exact: true }),
  ).toBeDisabled();
  await page.mouse.up();
  const expected = moved(before, 20, 30);
  expect(await current(page)).toEqual(expected);
  await expect(marker(page, 30)).toBeFocused();
  await expect(marker(page, 30)).not.toHaveClass(/moving/);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        frame: window.pascapLab!.engine.diagnostics().frame,
        status: window.pascapLab!.engine.diagnostics().status,
      })),
    )
    .toEqual({ frame: 30, status: 'paused' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await current(page)).toEqual(expected);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().layers[0]!.transform.keyframes).toEqual(expected.layers[0]!.transform.keyframes);
  await page.reload();
  await ready(page, expected);
  await expect(marker(page, 30)).toBeVisible();
});

for (const cancellation of ['Escape', 'pointercancel', 'lostcapture', 'blur'] as const) {
  test(`${cancellation} cancels the whole marker draft and restores the preview/document without a save`, async ({
    page,
  }) => {
    const before = await current(page);
    await seek(page, 5);
    const start = await begin(page);
    await move(page, start, 45, true);
    await expect(marker(page, 45)).toHaveClass(/moving/);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else
      await marker(page, 45).evaluate((element, kind) => {
        if (kind === 'lostcapture') (element as HTMLButtonElement).releasePointerCapture(1);
        else element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      }, cancellation);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect(page.locator('.timeline-surface')).not.toHaveClass(/keyframe-drafting/);
    await expect(marker(page, 20)).toBeVisible();
    expect(await current(page)).toEqual(before);
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(5);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
}

test('an occupied keyframe frame turns the draft red, never merges settings and rejects release without committing the last valid preview', async ({
  page,
}) => {
  const before = await current(page);
  await seek(page, 5);
  const start = await begin(page);
  await move(page, start, 50, true);
  await move(page, start, 80);
  await expect(page.locator('.timeline-transform-key.moving.invalid')).toHaveAttribute('data-transform-keyframe', '80');
  await expect(page.locator('.timeline-bottom')).toContainText('already exists');
  expect(await current(page)).toEqual(before);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator('.error-banner')).toContainText('already exists');
  expect(await current(page)).toEqual(before);
  await expect(marker(page, 20)).toBeFocused();
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('returning from an invalid destination to a free frame clears the error and commits only that final frame', async ({
  page,
}) => {
  const before = await current(page);
  const start = await begin(page);
  await move(page, start, 80, true);
  await expect(page.locator('.timeline-transform-key.moving')).toHaveClass(/invalid/);
  await move(page, start, 70);
  await expect(marker(page, 70)).not.toHaveClass(/invalid/);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(await current(page)).toEqual(moved(before, 20, 70));
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('click/Enter navigate without editing and marker arrows move one or ten frames without leaking timeline shortcuts', async ({
  page,
}) => {
  const before = await current(page);
  await inspectorTab(page, 'Clip');
  await marker(page, 20).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  // A Transform marker opens Track → Transform from any other tab.
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await marker(page, 80).focus();
  await marker(page, 80).press('Enter');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(80);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  expect(await current(page)).toEqual(before);
  await marker(page, 20).focus();
  await marker(page, 20).press('ArrowRight');
  await expect(marker(page, 21)).toBeFocused();
  await marker(page, 21).press('Shift+ArrowRight');
  await expect(marker(page, 31)).toBeFocused();
  expect((await current(page)).layers[0]!.transform.keyframes[0]).toEqual({
    ...before.layers[0]!.transform.keyframes[0]!,
    frame: 31,
  });
  expect((await current(page)).clips).toEqual(before.clips);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('Snap uses stationary boundaries/playhead, Alt bypasses it, and timeline frame zero is the minimum', async ({
  page,
}) => {
  const before = await current(page);
  let start = await begin(page);
  await move(page, start, 58);
  await expect(marker(page, 60)).toHaveClass(/moving/);
  await expect(page.locator('.snap-guide')).toHaveCount(1);
  // The Transform keyframe marker colour (#c4e9ff).
  await expect(page.locator('.snap-guide')).toHaveCSS('background-color', 'rgb(196, 233, 255)');
  await page.mouse.up();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  start = await begin(page);
  await move(page, start, 58, true);
  await expect(marker(page, 58)).toHaveClass(/moving/);
  await expect(page.locator('.snap-guide')).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  start = await begin(page);
  await move(page, start, -100, true);
  await expect(marker(page, 0)).toHaveClass(/moving/);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect((await current(page)).layers[0]!.transform.keyframes[0]).toEqual({
    ...before.layers[0]!.transform.keyframes[0]!,
    frame: 0,
  });
});

test('a keyboard keyframe move can go beyond the preview duration without an invalid seek', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = sequence();
  project.clips = [{ ...createClip('first', assets[0]!.id, 0, 60), speed: { mode: 'constant', rate: 0.5 } }];
  project.layers[0]!.transitions = [];
  project.layers[0]!.transform.keyframes = [
    transformPoint(0, { scale: 1 }, 'hold'),
    transformPoint(110, { scale: 1.5 }, 'hold'),
  ];
  await fixture(page, project);
  expect(calculateLayout(project).duration).toBe(120);
  await inspectorTab(page, 'Track');
  await marker(page, 110).focus();
  await marker(page, 110).press('Shift+ArrowRight');
  const expected = moved(project, 110, 120);
  expect(await current(page)).toEqual(expected);
  await ready(page, expected);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(119);
  const keys = transformKeyframes(page);
  await expect(keys.locator('[data-keyframe-frame="120"] .keyframe-row-skipped')).toHaveText('Outside duration');
  // Transform markers only seek; the list inspects a stored keyframe the preview cannot show.
  await keys.getByRole('button', { name: 'Go to Transform keyframe 120', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 120');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(119);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an empty positioned track has independently movable keyframes and marker selection follows its own track rather than another clip', async ({
  page,
}) => {
  const project = sequence();
  const empty = createLayer('empty-overlay', 'Track 2', false);
  empty.transform.keyframes = [transformPoint(20, { opacity: 0.5, rotation: 30 }, 'hold')];
  project.layers.push(empty);
  await fixture(page, project);
  await inspectorTab(page, 'Track');
  const start = await begin(page, 20, 'empty-overlay');
  await move(page, start, 35, true);
  await expect(transformKeyframes(page, 'Track 2')).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const next = await current(page);
  expect(next.layers[0]).toEqual(project.layers[0]);
  expect(next.clips).toEqual(project.clips);
  expect(next.layers[1]!.transform.keyframes).toEqual([{ ...project.layers[1]!.transform.keyframes[0]!, frame: 35 }]);
  await expect(marker(page, 35, 'empty-overlay')).toBeFocused();
  await inspectorTab(page, 'Clip');
  await expect(page.getByRole('tabpanel', { name: 'Clip', exact: true })).toContainText(
    'Select a clip on Track 2 to edit it.',
  );
});

test('horizontal autoscroll uses captured zoom/scroll coordinates and Escape restores the original viewport without saves', async ({
  page,
}) => {
  const project = sequence();
  project.clips = Array.from({ length: 20 }, (_, index) => createClip(`long-${index}`, assets[index % 2]!.id, 0, 120));
  project.layers[0]!.transitions = project.clips.slice(1).map((clip, index) => ({
    leftId: project.clips[index]!.id,
    rightId: clip.id,
    type: 'cut' as const,
    duration: 0 as const,
  }));
  project.layers[0]!.transform.keyframes = [transformPoint(20, { scale: 1.6 })];
  await fixture(page, project);
  await page.getByRole('slider', { name: 'Timeline zoom' }).fill('180');
  const viewport = page.locator('.timeline-scroll');
  const initial = await viewport.evaluate((element) => element.scrollLeft);
  const start = await begin(page);
  const bounds = (await viewport.boundingBox())!;
  await page.keyboard.down('Alt');
  await page.mouse.move(bounds.x + bounds.width - 8, start.y, { steps: 8 });
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(initial + 40);
  await expect(page.getByRole('slider', { name: 'Timeline zoom' })).toBeDisabled();
  expect(await current(page)).toEqual(project);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(initial);
  expect(await current(page)).toEqual(project);
  await expect(marker(page, 20)).toBeVisible();
});

test('moving a keyframe outside duration stores its time without extending footage, and setting navigation can find it', async ({
  page,
}) => {
  await inspectorTab(page, 'Track');
  const before = await current(page);
  const start = await begin(page);
  await move(page, start, 160, true);
  await expect(marker(page, 160)).toHaveClass(/moving/);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const next = await current(page);
  expect(calculateLayout(next).duration).toBe(120);
  expect(next.clips).toEqual(before.clips);
  expect(next.layers[0]!.transform.keyframes.map((point) => point.frame)).toEqual([80, 160]);
  await expect(marker(page, 160)).toBeFocused();
  const keys = transformKeyframes(page);
  await expect(keys.locator('[data-keyframe-frame="160"] .keyframe-row-skipped')).toHaveText('Outside duration');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(119);
  const previous = keys
    .locator('[data-keyframe-frame="160"] .layer-keyframe-chip')
    .getByRole('button', { name: 'Previous Scale keyframe', exact: true });
  await previous.scrollIntoViewIfNeeded();
  await previous.click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(80);
  const following = keys
    .locator('[data-keyframe-frame="80"] .layer-keyframe-chip')
    .getByRole('button', { name: 'Next Scale keyframe', exact: true });
  await following.scrollIntoViewIfNeeded();
  await following.click();
  await inspectorTab(page, 'Track');
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 160');
});

test('stored keyframes after the last clip keep their own markers without extending playback, and navigate without editing', async ({
  page,
}) => {
  const project = sequence();
  project.layers[0]!.transform.keyframes.push(
    transformPoint(160, { scale: 1.1 }, 'hold'),
    transformPoint(200, { rotation: 12 }, 'hold'),
  );
  await fixture(page, project);
  expect(calculateLayout(project).duration).toBe(120);
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const clipEnd = (await page.locator('[data-clip-id="second"]').boundingBox())!;
  for (const frame of [160, 200]) {
    const box = (await marker(page, frame).boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (clipEnd.x + clipEnd.width + (frame - 120) * scale))).toBeLessThanOrEqual(
      1,
    );
  }
  const surface = (await page.locator('.timeline-surface').boundingBox())!;
  const last = (await marker(page, 200).boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(surface.x + surface.width);
  await inspectorTab(page, 'Clip');
  await marker(page, 160).click();
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(119);
  await marker(page, 200).focus();
  await marker(page, 200).press('Enter');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(119);
  expect(await current(page)).toEqual(project);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  // The list inspects a stored keyframe the preview cannot show.
  const keys = transformKeyframes(page);
  await keys.getByRole('button', { name: 'Go to Transform keyframe 200', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 200 · outside current duration',
  );
  await expect(keys.locator('.keyframe-row.current')).toHaveAttribute('data-keyframe-frame', '200');
  expect(await current(page)).toEqual(project);
  await marker(page, 200).scrollIntoViewIfNeeded();
  const ruler = (await page.locator('.timeline-ruler').boundingBox())!;
  const target = (await marker(page, 200).boundingBox())!;
  await page.mouse.click(target.x + target.width / 2, ruler.y + ruler.height / 2);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()))
    .toMatchObject({ frame: 119, duration: 120 });
  // A ruler seek follows the playhead again instead of the stored keyframe.
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await keys.getByRole('button', { name: 'Delete Transform keyframe 160', exact: true }).click();
  expect((await current(page)).layers[0]!.transform.keyframes.map((point) => point.frame)).toEqual([20, 80, 200]);
  await expect(marker(page, 160)).toHaveCount(0);
  await expect(marker(page, 200)).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(project);
  await expect(marker(page, 160)).toBeVisible();
});

test('after every clip is removed, Delete on Transform markers and the stored keyframe panel remove keyframes, one Undo each', async ({
  page,
}) => {
  const project = sequence();
  project.layers[0]!.transform.keyframes = [
    transformPoint(20, { scale: 1.6 }),
    defaultSpatialKeyframe(40),
    transformPoint(80, { scale: 0.8 }, 'hold'),
  ];
  await fixture(page, project);
  for (const id of ['first', 'second']) {
    await page.locator(`[data-clip-id="${id}"]`).click();
    await page.getByRole('button', { name: 'Delete selected clip', exact: true }).click();
  }
  await expect(page.locator('[data-clip-id]')).toHaveCount(0);
  const emptied = await current(page);
  expect(emptied.clips).toEqual([]);
  expect(emptied.layers[0]!.transform.keyframes.map((point) => point.frame)).toEqual([20, 40, 80]);
  await expect(marker(page, 40)).toHaveAttribute('title', /Delete removes/);
  await marker(page, 20).focus();
  await marker(page, 20).press('Delete');
  await expect(marker(page, 20)).toHaveCount(0);
  expect((await current(page)).layers[0]!.transform.keyframes.map((point) => point.frame)).toEqual([40, 80]);
  await marker(page, 40).focus();
  await marker(page, 40).press('Backspace');
  await expect(marker(page, 40)).toHaveCount(0);
  expect((await current(page)).layers[0]!.transform.keyframes.map((point) => point.frame)).toEqual([80]);
  expect((await current(page)).clips).toEqual([]);
  await inspectorTab(page, 'Track');
  const keys = transformKeyframes(page);
  await keys.getByRole('button', { name: 'Go to Transform keyframe 80', exact: true }).click();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText('Stored keyframe · timeline frame 80');
  await keys.getByRole('button', { name: 'Delete stored Transform keyframe 80', exact: true }).click();
  await expect(marker(page, 80)).toHaveCount(0);
  await expect(keys.locator('.layer-keyframe-inspected')).toHaveCount(0);
  expect((await current(page)).layers[0]!.transform.keyframes).toEqual([]);
  for (let undo = 0; undo < 3; undo++) await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(emptied);
  await expect(marker(page, 20)).toBeVisible();
  await expect(marker(page, 40)).toBeVisible();
});
