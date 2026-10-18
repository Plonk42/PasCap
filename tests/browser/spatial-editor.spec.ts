import { expect, test, type Page } from '@playwright/test';
import type { MediaAsset } from '../../src/shared/media.js';
import { uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import {
  defaultSpatialKeyframe,
  evaluateSpatial,
  NEUTRAL_SPATIAL_POSE,
  type SpatialKeyframe,
  type SpatialKeyValues,
} from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { formatTimecode } from '../../src/shared/timing.js';
import { SPATIAL_CONTROLS } from '../../src/web/spatial-editor.js';
import {
  currentKeyframeRow,
  editTransformKeyframe,
  expandedInspectorPreferences,
  transformKeyframes,
} from './editor-helpers.js';
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
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [], missing: [] },
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
  await page.addInitScript(() => {
    localStorage.setItem('pascap-section-transform', 'open');
    if (localStorage.getItem('pascap-inspector-tab') === null) localStorage.setItem('pascap-inspector-tab', 'track');
  });
  await page.goto(`/?project=${document.id}`);
  await ready(page, document);
});

test.afterEach(() =>
  expect(unexpected, 'Only prepared synthetic reads and memory-only project writes are allowed').toEqual([]),
);

const NO_VALUES: SpatialKeyValues = {
  cropLeft: null,
  cropRight: null,
  cropTop: null,
  cropBottom: null,
  scale: null,
  translateX: null,
  translateY: null,
  rotation: null,
};

function key(frame: number, values: Partial<SpatialKeyValues>, curve: 'linear' | 'ease-in' | 'hold' | 'smooth') {
  return { ...uniformKeyframe(frame, { ...NO_VALUES, ...values }, curve), reset: false } as SpatialKeyframe;
}

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
const transform = (document: ProjectDocument, index = 0) => document.layers[index]!.transform;
const capture = (page: Page, label: string) => page.getByRole('button', { name: `Keyframe ${label}`, exact: true });
const exact = (page: Page, label: string, storedFrame?: number) =>
  page.getByRole('spinbutton', {
    name: storedFrame === undefined ? `Transform ${label}` : `${label} keyframe value ${storedFrame}`,
    exact: true,
  });
/** Main per-setting arrows, beside each capture triangle; stored chips carry the same names. */
const mainStep = (page: Page, direction: 'Previous' | 'Next', label: string) =>
  page
    .locator('.spatial-editor .keyframe-setting-navigation')
    .getByRole('button', { name: `${direction} ${label} keyframe`, exact: true });
async function expectSelected(page: Page, frame: number): Promise<void> {
  await expect(currentKeyframeRow(transformKeyframes(page))).toHaveAttribute('data-keyframe-frame', String(frame));
}

test('Transform lives in Track and all eight exact fields edit only the track base with no implicit keys', async ({
  page,
}) => {
  await page.getByRole('tab', { name: 'Clip', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'Track', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Track Transform editor', exact: true })).toBeVisible();
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
    expect(transform(await current(page)).base[control.key]).toBe(values[index]);
    expect(transform(await current(page)).keyframes).toEqual([]);
  }
  const after = await current(page);
  expect(after.clips).toEqual(before.clips);
  expect(after.layers[0]!.colour).toEqual(before.layers[0]!.colour);
  expect(calculateLayout(after).duration).toBe(calculateLayout(before).duration);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(transform(await current(page)).base.rotation).toBe(0);
});

test('invalid crop drafts remain editable without clamping and Escape restores; crossing crops are accepted', async ({
  page,
}) => {
  await exact(page, 'Crop right').fill('0.6');
  await exact(page, 'Crop right').press('Enter');
  const before = await current(page);
  const left = exact(page, 'Crop left');
  await left.fill('1.01');
  await left.press('Enter');
  await expect(left).toHaveAttribute('aria-invalid', 'true');
  await expect(left).toHaveValue('1.01');
  expect(await current(page)).toEqual(before);
  await left.press('Escape');
  await expect(left).toHaveValue('0');
  // Opposite edges that meet or cross simply cover nothing; they are never repaired.
  await left.fill('0.456789');
  await left.press('Enter');
  await expect(left).toHaveAttribute('aria-invalid', 'false');
  expect(transform(await current(page)).base).toMatchObject({ cropLeft: 0.456789, cropRight: 0.6 });
});

test('real native slider drafts preview live, commit on release once, cancel on Escape and Undo restores', async ({
  page,
}) => {
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
  expect(memory.saves).toBe(0);
  await page.mouse.up();
  expect(transform(await current(page)).base.scale).toBeGreaterThan(1);
  expect(transform(await current(page)).keyframes).toEqual([]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('each setting has its own capture button keying only that setting at the playhead', async ({ page }) => {
  const before = await seed(page, (document) => {
    document.clips[0]!.speed = { mode: 'constant', rate: 0.75 };
    transform(document).base.scale = 1.5;
    transform(document).base.rotation = 20;
    transform(document).keyframes = [key(0, { scale: 1 }, 'linear'), key(100, { scale: 3 }, 'smooth')];
  });
  await seek(page, 5);
  const evaluated = evaluateSpatial(transform(before), 5);
  // Scale is animated without a key here, so it is read-only; Rotation is unkeyed and still edits its base.
  await expect(exact(page, 'Scale')).toBeDisabled();
  await expect(exact(page, 'Rotation')).toBeEnabled();
  const poseFields = page.locator('.spatial-editor > .spatial-pose-fields .spatial-pose-field');
  await expect(poseFields.filter({ hasText: 'Scale' }).locator('.setting-locked-cue')).toHaveText(
    'Add a keyframe ▽ to edit',
  );
  await expect(poseFields.filter({ hasText: 'Rotation' }).locator('.setting-locked-cue')).toHaveCount(0);
  await expect(capture(page, 'Scale')).toHaveAttribute('aria-pressed', 'false');
  await capture(page, 'Scale').focus();
  await capture(page, 'Scale').press('Enter');
  await expect(capture(page, 'Scale')).toHaveAttribute('aria-pressed', 'true');
  await expect(poseFields.filter({ hasText: 'Scale' }).locator('.setting-locked-cue')).toHaveCount(0);
  await expect(capture(page, 'Rotation')).toHaveAttribute('aria-pressed', 'false');
  const captured = await current(page);
  expect(transform(captured).keyframes.find((point) => point.frame === 5)).toEqual(
    key(5, { scale: evaluated.scale }, 'linear'),
  );
  expect(transform(captured).base).toEqual(transform(before).base);
  expect(captured.clips).toEqual(before.clips);
  await exact(page, 'Scale').fill('2.3456789');
  await exact(page, 'Scale').press('Enter');
  expect(transform(await current(page)).keyframes.find((point) => point.frame === 5)!.values.scale).toBe(2.3456789);
  // Rotation joins the same key without touching Scale, then leaves it again.
  await capture(page, 'Rotation').click();
  const joined = transform(await current(page)).keyframes.find((point) => point.frame === 5)!;
  expect(joined.values).toMatchObject({ scale: 2.3456789, rotation: 20, translateX: null });
  await capture(page, 'Rotation').click();
  expect(transform(await current(page)).keyframes.find((point) => point.frame === 5)!.values.rotation).toBeNull();
  await seek(page, 20);
  await expect(exact(page, 'Scale')).toBeDisabled();
  await expect(exact(page, 'Rotation')).toBeEnabled();
  expect(transform(await current(page)).keyframes).toHaveLength(3);
});

test('per-setting Previous/Next visit only that setting’s keys; the timeline marks Transform keys at the lane top', async ({
  page,
}) => {
  const before = await seed(page, (document) => {
    transform(document).keyframes = [
      key(10, { scale: 1 }, 'linear'),
      key(40, { rotation: 45 }, 'linear'),
      key(70, { scale: 2 }, 'linear'),
    ];
  });
  await seek(page, 0);
  const marker = page.locator('[data-transform-layer="video-1"]');
  await expect(marker).toHaveCount(3);
  await expect(marker.nth(1)).toHaveAccessibleName(/Rotation/);
  await expect(marker.nth(0)).toHaveAccessibleName(/\(Scale\)/);
  await expect(marker.first()).toHaveText('▼');
  const clipBox = (await page.locator('[data-clip-id="one"]').boundingBox())!;
  const markerBox = (await marker.first().boundingBox())!;
  expect(markerBox.y - clipBox.y).toBeLessThan(10);
  // No clip-owned Transform lane remains inside clips.
  await expect(page.locator('[data-clip-keyframe="transform"]')).toHaveCount(0);
  await mainStep(page, 'Next', 'Scale').click();
  await expectSelected(page, 10);
  await mainStep(page, 'Next', 'Scale').click();
  // Frame 40 enables only Rotation, so Scale skips straight to its next key.
  await expectSelected(page, 70);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(70);
  await mainStep(page, 'Previous', 'Rotation').click();
  await expectSelected(page, 40);
  await expect(mainStep(page, 'Next', 'Rotation')).toHaveAttribute('aria-disabled', 'true');
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

const transformMarker = (page: Page, frame: number) =>
  page.locator(`[data-transform-layer="video-1"][data-transform-keyframe="${frame}"]`);

async function seedScaleKeys(page: Page, frames: readonly number[]): Promise<ProjectDocument> {
  return seed(page, (document) => {
    transform(document).keyframes = frames.map((frame, index) =>
      key(frame, { scale: 1 + index }, index ? 'ease-in' : 'linear'),
    );
  });
}

test('a Transform marker click opens Track → Transform, even from the Clip tab with the section collapsed', async ({
  page,
}) => {
  const before = await seedScaleKeys(page, [40, 80]);
  const section = page.getByRole('button', { name: 'Transform section', exact: true });
  await section.click();
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('tab', { name: 'Clip', exact: true }).click();
  await transformMarker(page, 40).click();
  await expect(page.getByRole('tab', { name: 'Track', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // The section is scrolled to the top of the Inspector, its first setting visible below the heading.
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toBeInViewport();
  await expect(page.getByRole('slider', { name: 'Transform Crop left', exact: true })).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(40);
  await expectSelected(page, 40);
  expect(await current(page)).toEqual(before);
});

test('sliding a Transform marker previews without saving, commits one Undo and rejects collisions', async ({
  page,
}) => {
  const before = await seedScaleKeys(page, [40, 80]);
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const box = (await transformMarker(page, 40).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10 * scale, y, { steps: 6 });
  await expect(page.locator('.timeline-transform-key.moving')).toHaveAttribute('data-transform-keyframe', '50');
  await expect(page.locator('.timeline-bottom')).toContainText(`Transform keyframe · ${formatTimecode(50)}`);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await page.mouse.up();
  const moved = await current(page);
  expect(transform(moved).keyframes.map((item) => [item.frame, item.easing.scale, item.values.scale])).toEqual([
    [50, 'linear', 1],
    [80, 'ease-in', 2],
  ]);
  expect(moved.clips).toEqual(before.clips);
  await expect(transformMarker(page, 50)).toBeFocused();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  const start = (await transformMarker(page, 40).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 40 * scale, start.y + start.height / 2, { steps: 6 });
  await expect(page.locator('.timeline-transform-key.moving')).toHaveClass(/invalid/);
  await page.mouse.up();
  expect(await current(page)).toEqual(before);
});

test('a Transform marker snaps to the playhead, Alt bypasses it, and arrow keys move it one frame', async ({
  page,
}) => {
  const before = await seedScaleKeys(page, [40, 80]);
  await seek(page, 63);
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const box = (await transformMarker(page, 40).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 21 * scale, y, { steps: 4 });
  await expect(page.locator('.timeline-transform-key.moving')).toHaveAttribute('data-transform-keyframe', '63');
  await expect(page.locator('.snap-guide')).toHaveCount(1);
  // The Transform keyframe icon colour (#c4e9ff).
  await expect(page.locator('.snap-guide')).toHaveCSS('background-color', 'rgb(196, 233, 255)');
  await page.keyboard.down('Alt');
  await page.mouse.move(x + 21 * scale + 1, y);
  await page.mouse.move(x + 21 * scale, y);
  await expect(page.locator('.timeline-transform-key.moving')).toHaveAttribute('data-transform-keyframe', '61');
  await expect(page.locator('.snap-guide')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.up('Alt');
  await page.mouse.up();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await transformMarker(page, 40).focus();
  await transformMarker(page, 40).press('ArrowRight');
  await expect(transformMarker(page, 41)).toBeFocused();
  await transformMarker(page, 41).press('Shift+ArrowRight');
  await expect(transformMarker(page, 51)).toBeFocused();
  expect(transform(await current(page)).keyframes.map((item) => item.frame)).toEqual([51, 80]);
});

test('a default Transform keyframe returns every setting to neutral from its frame, never reaching back', async ({
  page,
}) => {
  await seed(page, (document) => {
    transform(document).base.rotation = 30;
    transform(document).keyframes = [key(10, { scale: 2 }, 'linear')];
  });
  const toggle = page.getByRole('button', { name: 'Add default Transform keyframe', exact: true });
  await seek(page, 10);
  // An ordinary keyframe is never replaced: the toggle is unavailable there and Enter does nothing.
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await toggle.focus();
  await toggle.press('Enter');
  expect(transform(await current(page)).keyframes).toHaveLength(1);
  await seek(page, 60);
  await toggle.click();
  const added = await current(page);
  expect(transform(added).keyframes).toEqual([key(10, { scale: 2 }, 'linear'), defaultSpatialKeyframe(60)]);
  const remove = page.getByRole('button', { name: 'Remove default Transform keyframe', exact: true });
  await expect(remove).toHaveAttribute('aria-pressed', 'true');
  await expect(transformMarker(page, 60)).toHaveClass(/reset/);
  await expect(transformKeyframes(page)).toContainText('Default');
  // Rotation keeps its saved base before the default keyframe; Scale, keyed earlier, eases into it.
  expect(evaluateSpatial(transform(added), 10)).toMatchObject({ rotation: 30, scale: 2 });
  expect(evaluateSpatial(transform(added), 35)).toMatchObject({ rotation: 30, scale: 1.5 });
  expect(evaluateSpatial(transform(added), 60)).toEqual(NEUTRAL_SPATIAL_POSE);
  await expect(exact(page, 'Rotation')).toHaveValue('0');
  await seek(page, 30);
  await expect(exact(page, 'Rotation')).toHaveValue('30');
  await seek(page, 60);
  await remove.click();
  expect(transform(await current(page)).keyframes).toEqual([key(10, { scale: 2 }, 'linear')]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(transform(await current(page)).keyframes).toEqual([key(10, { scale: 2 }, 'linear')]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('Reset works like Colour: the whole base unanimated, only the playhead keyframe once animated', async ({
  page,
}) => {
  const before = await seed(page, (document) => {
    transform(document).base.scale = 1.456789;
    transform(document).base.rotation = 12;
  });
  const reset = page.getByRole('button', { name: 'Reset transform', exact: true });
  await reset.click();
  expect(transform(await current(page))).toEqual({ base: NEUTRAL_SPATIAL_POSE, keyframes: [] });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);

  const animated = await seed(page, (document) => {
    transform(document).keyframes = [key(20, { scale: 2, translateX: 0.3 }, 'linear'), key(50, { scale: 3 }, 'hold')];
  });
  await seek(page, 35);
  await expect(reset).toBeDisabled();
  await seek(page, 20);
  await reset.click();
  const after = await current(page);
  expect(transform(after).keyframes[0]!.values).toMatchObject({ scale: 1, translateX: 0, rotation: null });
  expect(transform(after).keyframes[1]).toEqual(transform(animated).keyframes[1]);
  expect(transform(after).base).toEqual(transform(animated).base);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(animated);
});

test('stored keyframes keep frame input focus through move/Undo, reject collisions and edit easing', async ({
  page,
}) => {
  const before = await seed(page, (document) => {
    transform(document).base.scale = 1.5;
    transform(document).keyframes = [0, 100].map((frame) => key(frame, { ...NEUTRAL_SPATIAL_POSE }, 'linear'));
  });
  await editTransformKeyframe(page, 0);
  const time = page.getByRole('spinbutton', { name: 'Transform keyframe frame 0', exact: true });
  await time.fill('40');
  await time.press('Enter');
  const moved = page.getByRole('spinbutton', { name: 'Transform keyframe frame 40', exact: true });
  await expect(moved).toBeFocused();
  await expect(moved).toHaveValue('40');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(time).toHaveValue('0');
  await time.fill('100');
  await time.press('Enter');
  await expect(time).toHaveAttribute('aria-invalid', 'true');
  await expect(time).toHaveValue('100');
  expect(await current(page)).toEqual(before);
  await time.press('Escape');
  await page.getByRole('combobox', { name: 'Transform keyframe easing 0', exact: true }).selectOption('ease-in');
  for (const control of SPATIAL_CONTROLS) {
    const field = exact(page, control.label, 0);
    const value = control.key === 'scale' ? 1.23456789 : 0.123456789;
    await field.fill(String(value));
    await field.press('Enter');
    expect(transform(await current(page)).keyframes[0]!.values[control.key]).toBe(value);
  }
  const after = await current(page);
  expect(transform(after).base).toEqual(transform(before).base);
  expect(new Set(Object.values(transform(after).keyframes[0]!.easing))).toEqual(new Set(['ease-in']));
  expect(after.clips).toEqual(before.clips);
});

test('stored navigation reaches keyframes after the duration through the nearest frame without save/history', async ({
  page,
}) => {
  const before = await seed(page, (document) => {
    transform(document).keyframes = [0, 41, 119, 300].map((frame) => key(frame, { ...NEUTRAL_SPATIAL_POSE }, 'linear'));
  });
  expect(calculateLayout(before).duration).toBe(120);
  const list = transformKeyframes(page);
  for (const frame of [0, 41, 119, 300]) {
    await list.getByRole('button', { name: `Go to Transform keyframe ${frame}`, exact: true }).click();
    const output = Math.min(frame, 119);
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(output);
    await expectSelected(page, frame);
  }
  await expect(list.locator('.layer-keyframe-inspected')).toContainText(
    'Stored keyframe · timeline frame 300 · outside current duration',
  );
  // The shared list explains only keyframes the preview cannot show, so stepping never flashes it.
  await list.getByRole('button', { name: 'Go to Transform keyframe 41', exact: true }).click();
  await expect(list.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await list.getByRole('button', { name: 'Go to Transform keyframe 300', exact: true }).click();
  await list.getByRole('button', { name: 'Follow playhead', exact: true }).click();
  await expect(list.locator('.layer-keyframe-inspected')).toHaveCount(0);
  await list.getByRole('button', { name: 'Go to Transform keyframe 300', exact: true }).click();
  // Two stored keyframes preview the same last frame; the cursor still steps between them.
  await page.getByRole('button', { name: 'Previous Transform keyframe', exact: true }).click();
  await expectSelected(page, 119);
  await page.getByRole('button', { name: 'Next Transform keyframe', exact: true }).click();
  await expectSelected(page, 300);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('stored rows start closed, select on a click anywhere and step each setting from its chips', async ({ page }) => {
  const before = await seed(page, (document) => {
    transform(document).keyframes = [
      key(10, { scale: 2 }, 'linear'),
      key(40, { rotation: 45 }, 'linear'),
      key(70, { scale: 3 }, 'linear'),
    ];
  });
  const list = transformKeyframes(page);
  await expect(list.locator('.keyframe-row')).toHaveCount(3);
  await expect(list.locator('details[open]')).toHaveCount(0);
  // A real click on the chip text, not on the timecode, selects the row.
  const chip = list.locator('[data-keyframe-frame="40"] .layer-keyframe-chip');
  await chip.scrollIntoViewIfNeeded();
  const box = (await chip.boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(40);
  await expectSelected(page, 40);
  // Chips carry the same per-setting arrows as Colour's.
  const scaleNext = list.locator('[data-keyframe-frame="10"]').getByRole('button', { name: 'Next Scale keyframe' });
  await scaleNext.click();
  await expectSelected(page, 70);
  await expect(list.locator('details[open]')).toHaveCount(0);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('last-key deletion reveals the preserved base', async ({ page }) => {
  const before = await seed(page, (document) => {
    transform(document).base.scale = 1.456789;
    transform(document).keyframes = [key(0, { scale: 2 }, 'hold')];
  });
  await page.getByRole('button', { name: 'Delete Transform keyframe 0', exact: true }).click();
  await expect(exact(page, 'Scale')).toHaveValue('1.456789');
  expect(transform(await current(page)).base).toEqual(transform(before).base);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

test('track context cancels invalid drafts instead of applying them to another track', async ({ page }) => {
  await seed(page, (document) => {
    document.layers.push(createLayer('video-2', 'Track 2'));
  });
  const field = exact(page, 'Scale');
  await field.fill('9.1234567');
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Select track Track 2', exact: true }).click();
  await expect(exact(page, 'Scale')).toHaveValue('1');
  await expect(exact(page, 'Scale')).toHaveAttribute('aria-invalid', 'false');
  await exact(page, 'Scale').fill('1.25');
  await exact(page, 'Scale').press('Enter');
  const after = await current(page);
  expect(transform(after, 0)).toEqual({ base: NEUTRAL_SPATIAL_POSE, keyframes: [] });
  expect(transform(after, 1).base.scale).toBe(1.25);
});

test('bulk expansion includes Transform in Track while heading help and tab navigation retain normal focus', async ({
  page,
}) => {
  const before = await current(page);
  // HSL ranges and Colour curves start collapsed: a mixed tab offers Collapse all first.
  await page.getByRole('button', { name: 'Collapse all Track sections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const help = page.getByRole('button', { name: 'Transform animation help', exact: true });
  await help.click();
  await expect(
    page.getByText('Crop, scale, move and rotate every clip on this track.', { exact: false }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Transform section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Expand all Track sections', exact: true }).click();
  await expect(exact(page, 'Scale')).toBeVisible();
  await page.getByRole('tab', { name: 'Track', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Clip', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(exact(page, 'Scale')).toBeVisible();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('Transform controls fit the 270px Inspector at the default and minimum viewports with all stored fields reachable', async ({
  page,
}) => {
  await seed(page, (document) => {
    transform(document).keyframes = [key(0, { ...NEUTRAL_SPATIAL_POSE }, 'linear')];
  });
  const divider = page.getByRole('slider', { name: 'Resize Properties panel', exact: true });
  await divider.focus();
  for (let index = 0; index < 4; index++) await divider.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '270');
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect(divider).toHaveAttribute('aria-valuenow', '270');
    const editor = page.getByRole('region', { name: 'Track Transform editor', exact: true });
    await expect(editor).toBeVisible();
    await editTransformKeyframe(page, 0);
    for (const stored of [undefined, 0]) {
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

const speedMarker = (page: Page, source: number) =>
  page.locator(`[data-clip-id="one"] [data-clip-keyframe="speed"][data-source-frame="${source}"]`);

/** Rate 1 up to source 80, then 2×: output frames equal source frames before key 80. */
async function seedSpeedKeys(page: Page): Promise<ProjectDocument> {
  return seed(page, (document) => {
    document.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 40, rate: 1, interpolation: 'hold' },
        { frame: 80, rate: 2, interpolation: 'hold' },
      ],
    };
  });
}

test('sliding a Speed marker previews without saving, retimes the clip in one Undo and rejects collisions', async ({
  page,
}) => {
  const before = await seedSpeedKeys(page);
  expect(calculateLayout(before).duration).toBe(100);
  await expect(speedMarker(page, 80)).toHaveAttribute(
    'title',
    /^Speed · source frame 80 · 2× · .* · Drag to move; Arrow keys: 1 source frame, Shift: 10$/,
  );
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const box = (await speedMarker(page, 80).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 10 * scale, y, { steps: 6 });
  await expect(page.locator('.timeline-clip-key.speed.moving')).toHaveAttribute('data-source-frame', '70');
  await expect(page.locator('.timeline-bottom')).toContainText('Speed keyframe · source frame 70');
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await page.mouse.up();
  const moved = await current(page);
  expect(moved.clips[0]!.speed).toEqual({
    mode: 'curve',
    keyframes: [
      { frame: 40, rate: 1, interpolation: 'hold' },
      { frame: 70, rate: 2, interpolation: 'hold' },
    ],
  });
  // 70 source frames at 1× then 50 at 2×.
  expect(calculateLayout(moved).duration).toBe(95);
  await ready(page, moved);
  await expect(speedMarker(page, 70)).toBeFocused();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await ready(page, before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  const start = (await speedMarker(page, 80).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 - 40 * scale, start.y + start.height / 2, { steps: 6 });
  await expect(page.locator('.timeline-clip-key.speed.moving')).toHaveClass(/invalid/);
  await page.mouse.up();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a Speed marker click opens Clip → Speed; Escape cancels its slide and arrow keys move it one source frame', async ({
  page,
}) => {
  const before = await seedSpeedKeys(page);
  await page.getByRole('tab', { name: 'Clip', exact: true }).click();
  const section = page.getByRole('button', { name: 'Speed section', exact: true });
  await section.click();
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('tab', { name: 'Track', exact: true }).click();
  await speedMarker(page, 40).click();
  await expect(page.getByRole('tab', { name: 'Clip', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Speed section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(40);
  expect(await current(page)).toEqual(before);

  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const box = (await speedMarker(page, 40).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12 * scale, box.y + box.height / 2, { steps: 6 });
  await expect(page.locator('.timeline-clip-key.speed.moving')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);

  await speedMarker(page, 40).focus();
  await speedMarker(page, 40).press('ArrowRight');
  await expect(speedMarker(page, 41)).toBeFocused();
  await speedMarker(page, 41).press('Shift+ArrowRight');
  await expect(speedMarker(page, 51)).toBeFocused();
  const stepped = await current(page);
  expect(stepped.clips[0]!.speed).toEqual({
    mode: 'curve',
    keyframes: [
      { frame: 51, rate: 1, interpolation: 'hold' },
      { frame: 80, rate: 2, interpolation: 'hold' },
    ],
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
