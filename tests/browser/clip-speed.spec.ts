import { expect, test, type Page } from '@playwright/test';
import { clipSpeedPreset } from '../../src/shared/clip-speed.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipAction, expandedInspectorPreferences, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let assets: MediaAsset[];
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset)
      throw new Error('Clip speed tests require existing prepared synthetic fixtures; no real work is admitted.');
    return asset;
  });
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
    if (route.request().method() === 'GET' && proxy && assets.some((asset) => asset.id === proxy[1])) {
      await route.continue();
      return;
    }
    unexpected.push(`${route.request().method()} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('clip-speed-memory', 'Clip speed · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [createClip('one', assets[0]!.id, 0, 120)];
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.goto(`/?project=${document.id}`);
  await ready(page, document);
});
test.afterEach(() =>
  expect(unexpected, 'Only existing synthetic proxy reads and memory-only project writes are allowed').toEqual([]),
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
async function seedCurve(page: Page, configure?: (document: ProjectDocument) => void): Promise<ProjectDocument> {
  const document = await current(page);
  document.clips[0]!.speed = clipSpeedPreset(document.clips[0]!, 'flat');
  configure?.(document);
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
function point(page: Page, frame: number) {
  return page.getByRole('button', { name: `Clip speed keyframe ${frame}`, exact: true });
}
async function beginDrag(page: Page, source = 60) {
  const button = point(page, source);
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  const plot = (await page.locator('.clip-speed-plot').boundingBox())!;
  const origin = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    width: plot.width,
    height: plot.height,
    source,
  };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await expect(page.getByRole('region', { name: 'Clip speed curve editor' })).toHaveAttribute('data-drafting', 'true');
  return origin;
}
async function moveDrag(
  page: Page,
  origin: Awaited<ReturnType<typeof beginDrag>>,
  source: number,
  rate: number,
): Promise<void> {
  await page.mouse.move(
    origin.x + ((source - origin.source) / 120) * origin.width,
    origin.y - (Math.log(rate) / Math.log(80)) * origin.height,
    { steps: 6 },
  );
}

test('Custom creates clip-only keys, visual presets remain editable, and a preset is one Undo', async ({ page }) => {
  const before = await current(page);
  await page.getByRole('combobox', { name: 'Speed mode', exact: true }).selectOption('curve');
  await expect(page.getByRole('region', { name: 'Clip speed curve editor' })).toBeVisible();
  await expect(page.locator('.clip-speed-point')).toHaveCount(5);
  const flat = await current(page);
  expect(flat.layers).toEqual(before.layers);
  expect(flat.clips[0]!.speed).toEqual(clipSpeedPreset(flat.clips[0]!, 'flat'));
  await page.getByRole('button', { name: 'Clip speed preset Slow centre', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clip speed preset Slow centre', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const changed = await current(page);
  expect(changed.clips[0]!.speed).toEqual(clipSpeedPreset(changed.clips[0]!, 'slow-centre'));
  expect(changed.layers).toEqual(before.layers);
  await ready(page, changed);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(flat);
});

test('exact frame/rate/easing fields preserve focus, reject collisions and keep decimal precision', async ({
  page,
}) => {
  const before = await seedCurve(page);
  await point(page, 60).click();
  const time = page.getByRole('spinbutton', { name: 'Clip speed keyframe source frame', exact: true });
  await time.fill('63');
  await time.press('Enter');
  await expect(time).toBeFocused();
  await expect(time).toHaveValue('63');
  const rate = page.getByRole('spinbutton', { name: 'Clip speed keyframe rate', exact: true });
  const beforeRate = await current(page);
  await rate.fill('1.234567');
  expect(await current(page)).toEqual(beforeRate);
  await rate.press('Enter');
  await expect(rate).toBeFocused();
  await expect(rate).toHaveValue('1.234567');
  await point(page, 63).focus();
  await point(page, 63).press('ArrowUp');
  await expect(rate).toHaveValue('1.244567');
  await point(page, 63).press('ArrowDown');
  await expect(rate).toHaveValue('1.234567');
  await page.getByRole('combobox', { name: 'Clip speed keyframe easing', exact: true }).selectOption('ease-out');
  let document = await current(page);
  if (document.clips[0]!.speed.mode !== 'curve') throw new Error('Curve expected');
  expect(document.clips[0]!.speed.keyframes[2]).toEqual({ frame: 63, rate: 1.234567, interpolation: 'ease-out' });
  const valid = document;
  await time.fill('90');
  await time.press('Enter');
  await expect(time).toHaveAttribute('aria-invalid', 'true');
  await expect(time.locator('..').getByRole('alert')).toContainText('already exists');
  expect(await current(page)).toEqual(valid);
  await time.press('Escape');
  await expect(time).toHaveValue('63');
  await time.fill('121');
  await time.press('Enter');
  await expect(time).toHaveAttribute('aria-invalid', 'true');
  expect(await current(page)).toEqual(valid);
  await time.press('Escape');
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await ready(page, memory.snapshot());
  document = await current(page);
  expect(document.clips[0]!.speed).toEqual(valid.clips[0]!.speed);
  expect(document.layers).toEqual(before.layers);
});

test('point click, source-boundary navigation and Add/Delete are explicit and reversible', async ({ page }) => {
  const before = await seedCurve(page);
  await seek(page, 10);
  await point(page, 60).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(60);
  await page.getByRole('button', { name: 'Next clip speed keyframe', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(90);
  await page.getByRole('button', { name: 'Next clip speed keyframe', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(119);
  await expect(page.getByRole('spinbutton', { name: 'Clip speed keyframe source frame' })).toHaveValue('120');
  await expect(page.locator('.clip-speed-outside')).toContainText('nearest available');
  expect(memory.saves).toBe(0);
  await seek(page, 10);
  await page.getByRole('button', { name: 'Add clip speed keyframe' }).click();
  await expect(page.locator('.clip-speed-point')).toHaveCount(6);
  await expect(page.getByRole('spinbutton', { name: 'Clip speed keyframe source frame' })).toHaveValue('10');
  await page.getByRole('button', { name: 'Delete clip speed keyframe' }).click();
  expect(await current(page)).toEqual(before);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(point(page, 10)).toBeVisible();
});

test('graph background seeks without an edit and key removal cannot drop below two points', async ({ page }) => {
  await seedCurve(page);
  const graph = page.getByRole('button', { name: 'Seek within clip speed curve' });
  await graph.scrollIntoViewIfNeeded();
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + (box.width * 10) / 120, box.y + box.height * 0.2);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(10);
  expect(memory.saves).toBe(0);
  for (let index = 0; index < 3; index++)
    await page.getByRole('button', { name: 'Delete clip speed keyframe' }).click();
  const document = await current(page);
  if (document.clips[0]!.speed.mode !== 'curve') throw new Error('Curve expected');
  expect(document.clips[0]!.speed.keyframes).toHaveLength(2);
  await expect(page.getByRole('button', { name: 'Delete clip speed keyframe' })).toBeDisabled();
});

test('native graph dragging previews live but commits only on release as one Undo', async ({ page }) => {
  const before = await seedCurve(page);
  await seek(page, 20);
  const start = await beginDrag(page);
  await moveDrag(page, start, 70, 2);
  await expect(point(page, 70)).toHaveClass(/moving/);
  expect(await current(page)).toEqual(before);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Keyframe Speed', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Split at playhead', exact: true })).toBeDisabled();
  await page.mouse.up();
  await expect(point(page, 70)).toBeFocused();
  const document = await current(page);
  if (document.clips[0]!.speed.mode !== 'curve') throw new Error('Curve expected');
  expect(document.clips[0]!.speed.keyframes[2]).toEqual({ frame: 70, rate: 2, interpolation: 'smooth' });
  expect(document.clips[0]!.sourceIn).toBe(0);
  expect(document.clips[0]!.sourceOut).toBe(120);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

for (const cancellation of ['Escape', 'pointercancel', 'lostcapture', 'blur'] as const) {
  test(`${cancellation} cancels the clip curve gesture and restores the original playhead without a save`, async ({
    page,
  }) => {
    const before = await seedCurve(page);
    await seek(page, 20);
    const start = await beginDrag(page);
    await moveDrag(page, start, 70, 2);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else
      await point(page, 70).evaluate((element, kind) => {
        if (kind === 'lostcapture') (element as HTMLButtonElement).releasePointerCapture(1);
        else element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      }, cancellation);
    await page.mouse.up();
    await expect(page.getByRole('region', { name: 'Clip speed curve editor' })).toHaveAttribute(
      'data-drafting',
      'false',
    );
    expect(await current(page)).toEqual(before);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(memory.saves).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          frame: window.pascapLab!.engine.diagnostics().frame,
          status: window.pascapLab!.engine.diagnostics().status,
        })),
      )
      .toEqual({ frame: 20, status: 'paused' });
  });
}

test('collision red feedback rejects release instead of merging or committing the last valid preview', async ({
  page,
}) => {
  const before = await seedCurve(page);
  await seek(page, 20);
  const start = await beginDrag(page);
  await moveDrag(page, start, 70, 2);
  await expect(point(page, 70)).toHaveClass(/moving/);
  await moveDrag(page, start, 90, 3);
  await expect(page.locator('.clip-speed-point.invalid')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.clip-speed-error')).toContainText('already exists');
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a curve that invalidates opening fades is rejected without shrinking them or changing sources', async ({
  page,
}) => {
  const before = await seedCurve(page, (document) => {
    document.layers[0]!.openingFade = 110;
  });
  const start = await beginDrag(page);
  await moveDrag(page, start, 60, 8);
  await expect(page.locator('.clip-speed-point.invalid')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.clip-speed-error')).toBeVisible();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('native point arrows edit frames/rates without leaking clip shortcuts, while Enter explicitly previews the point', async ({
  page,
}) => {
  const before = await seedCurve(page);
  const selected = point(page, 60);
  await selected.focus();
  await selected.press('ArrowRight');
  await expect(point(page, 61)).toBeFocused();
  await point(page, 61).press('Shift+ArrowUp');
  await expect(point(page, 61)).toBeFocused();
  const document = await current(page);
  if (document.clips[0]!.speed.mode !== 'curve') throw new Error('Curve expected');
  expect(document.clips[0]!.speed.keyframes[2]).toEqual({ frame: 61, rate: 1.1, interpolation: 'smooth' });
  await point(page, 61).press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        const video = Array.from(globalThis.document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'))[
          state.assignedClipIds.indexOf('one')
        ]!;
        return Math.floor((video.currentTime * 30000) / 1001 + 1e-7);
      }),
    )
    .toBe(61);
  await point(page, 61).press('Control+d');
  await point(page, 61).press('s');
  expect((await current(page)).clips).toHaveLength(1);
  const background = page.getByRole('button', { name: 'Seek within clip speed curve' });
  await background.focus();
  await background.press('Delete');
  expect(await current(page)).toEqual(document);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

test('duplicate/trim/split preserve independent clip curves and keep outside-trim points accessible', async ({
  page,
}) => {
  const before = await seedCurve(page);
  await clipAction(page, 'Duplicate selected clip');
  const duplicated = await current(page);
  expect(duplicated.clips[1]!.speed).toEqual(before.clips[0]!.speed);
  await point(page, 60).click();
  const rate = page.getByRole('spinbutton', { name: 'Clip speed keyframe rate' });
  await rate.fill('2');
  await rate.press('Enter');
  expect((await current(page)).clips[0]!).toEqual(duplicated.clips[0]!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const sourceIn = page.getByRole('textbox', { name: 'Source IN frame', exact: true });
  await sourceIn.fill('30');
  await sourceIn.press('Enter');
  const sourceOut = page.getByRole('textbox', { name: 'Source OUT frame', exact: true });
  await sourceOut.fill('90');
  await sourceOut.press('Enter');
  expect((await current(page)).clips[0]!.speed).toEqual(before.clips[0]!.speed);
  await expect(page.locator('.clip-speed-point')).toHaveCount(3);
  await page
    .getByRole('combobox', { name: 'Selected clip speed keyframe' })
    .selectOption({ label: 'Keyframe 1 · source 0 · outside clip' });
  await expect(page.locator('.clip-speed-outside')).toBeVisible();
  await page.getByRole('button', { name: 'Restore full recording' }).click();
  await seek(page, 60);
  await page.getByRole('region', { name: 'Video timeline' }).focus();
  await page.keyboard.press('s');
  const split = await current(page);
  expect(split.clips.map((item) => item.speed)).toEqual([before.clips[0]!.speed, before.clips[0]!.speed]);
});

test('row Speed override remains explicit and removing only it restores the clip curve unchanged', async ({ page }) => {
  const before = await seedCurve(page, (document) => {
    document.layers[0]!.keyframes = [sharedPoint(0, { speed: 2, exposure: 0.3 }, 'hold')];
  });
  await expect(page.locator('.clip-speed-override')).toContainText('Overridden by track Speed keyframes');
  await expect(page.getByRole('combobox', { name: 'Speed mode', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Keyframe Speed', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Clip speed curve editor' })).toBeVisible();
  const document = await current(page);
  expect(document.clips[0]!.speed).toEqual(before.clips[0]!.speed);
  expect(document.layers[0]!.keyframes).toEqual([sharedPoint(0, { exposure: 0.3 }, 'hold')]);
  expect(calculateLayout(document).duration).toBe(120);
});

test('custom mapped preview uses exact decoded source frames with only two video decoders', async ({ page }) => {
  const document = await seedCurve(page, (project) => {
    project.clips[0]!.speed = clipSpeedPreset(project.clips[0]!, 'slow-centre');
  });
  const placed = calculateLayout(document).clips[0]!;
  for (const frame of [
    0,
    1,
    Math.floor(placed.duration / 3),
    Math.floor((placed.duration * 2) / 3),
    placed.duration - 1,
  ]) {
    await seek(page, frame);
    const captured = await page.evaluate(() => {
      const state = window.pascapLab!.engine.diagnostics();
      const videos = Array.from(globalThis.document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'));
      const slot = state.assignedClipIds.indexOf('one');
      return {
        frame: Math.floor((videos[slot]!.currentTime * 30000) / 1001 + 1e-7),
        count: videos.length,
        status: state.status,
      };
    });
    expect(captured).toEqual({ frame: placed.retiming.sourceAt(frame), count: 2, status: 'paused' });
  }
  expect(await current(page)).toEqual(document);
  expect(memory.saves).toBe(0);
});

test('a slow clip-key click previews that exact original image instead of the preceding frame', async ({ page }) => {
  const before = await seedCurve(page, (document) => {
    document.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.5, interpolation: 'linear' },
        { frame: 60, rate: 0.75, interpolation: 'linear' },
        { frame: 120, rate: 1, interpolation: 'hold' },
      ],
    };
  });
  await point(page, 60).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        const video = Array.from(globalThis.document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'))[
          state.assignedClipIds.indexOf('one')
        ]!;
        return { source: Math.floor((video.currentTime * 30000) / 1001 + 1e-7), status: state.status };
      }),
    )
    .toEqual({ source: 60, status: 'paused' });
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('custom controls fit a 270px Inspector at the default and minimum viewports with accessible point hit targets', async ({
  page,
}) => {
  const before = await seedCurve(page);
  const resizer = page.getByRole('slider', { name: 'Resize Clip panel' });
  await resizer.focus();
  for (let index = 0; index < 4; index++) await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', '270');
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    const editor = page.getByRole('region', { name: 'Clip speed curve editor' });
    await expect(resizer).toHaveAttribute('aria-valuenow', '270');
    await expect(editor).toBeVisible();
    await point(page, 60).scrollIntoViewIfNeeded();
    await expect(point(page, 60)).toBeInViewport();
    const box = (await point(page, 60).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});
