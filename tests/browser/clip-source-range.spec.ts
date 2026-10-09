import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyCommand } from '../../src/shared/commands.js';
import { mediaAssetSchema, type MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { formatTimecode } from '../../src/shared/timing.js';
import { expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

const PROJECT_ID = 'clip-source-range-memory';
let assets: MediaAsset[];
let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: unknown[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const matches = library.assets
      .map((item) => mediaAssetSchema.parse(item))
      .filter((asset) => asset.name === name && asset.sourcePath.endsWith(`/synthetic-sources/${name}`));
    expect(matches, `Exactly one existing synthetic fixture ${name}`).toHaveLength(1);
    const asset = matches[0]!;
    expect(asset.status).toBe('ready');
    expect(asset.prepared).not.toBeNull();
    expect(asset.metadata.frameCount).toBe(120);
    expect(asset.prepared!.verification.frameCount).toBe(120);
    return asset;
  });
  // Installed before memoryProjects: project CRUD is intercepted by its strict,
  // revisioned routes. No unmatched write or original-media read can reach disk.
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const reads: Record<string, unknown> = {
      '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
      '/api/media': { assets },
      '/api/audio': { assets: [] },
      '/api/jobs': { jobs: [] },
    };
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
  await expandedInspectorPreferences(page);
});

test.afterEach(() => {
  expect(unexpected, 'Only memory project CRUD and existing pattern-a/b proxy/thumbnail reads are allowed').toEqual([]);
});

function sequence(ripple = true, retimed = false): ProjectDocument {
  const document = createProject(PROJECT_ID, 'Clip Source range · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.layers[0]!.ripple = ripple;
  document.layers[0]!.keyframes = [sharedPoint(12, { exposure: 0.25 }), sharedPoint(500, { tint: 0.1 }, 'hold')];
  const first = { ...createClip('a', assets[0]!.id, 15, 105), start: 30 };
  if (retimed) first.speed = { mode: 'constant', rate: 0.5 };
  first.spatial.keyframes = [
    { frame: 0, interpolation: 'linear', values: { ...first.spatial.base } },
    { frame: 120, interpolation: 'smooth', values: { ...first.spatial.base, translateX: 0.1 } },
  ];
  document.clips = [first, { ...createClip('b', assets[1]!.id, 30, 90), start: ripple ? (retimed ? 210 : 120) : 230 }];
  document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
  return projectSchema.parse(document);
}

async function open(page: Page, document = sequence()): Promise<ProjectDocument> {
  memory = await memoryProjects(page, document);
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page, document);
  await expect(undo(page)).toBeDisabled();
  await expect(field(page, 'in')).toHaveValue(formatTimecode(document.clips[0]!.sourceIn));
  return document;
}

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function ready(page: Page, document: ProjectDocument, frame?: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab?.engine.diagnostics();
        return { status: state?.status, duration: state?.duration };
      }),
    )
    .toEqual({ status: 'paused', duration: calculateLayout(document).duration });
  if (frame !== undefined)
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
}

function field(page: Page, edge: 'in' | 'out'): Locator {
  return page.getByRole('textbox', { name: `Source ${edge.toUpperCase()} frame`, exact: true, includeHidden: true });
}

function handle(page: Page, edge: 'in' | 'out'): Locator {
  return page.getByRole('slider', { name: `Trim clip source ${edge === 'in' ? 'start' : 'end'}`, exact: true });
}

function undo(page: Page): Locator {
  return page.getByRole('button', { name: 'Undo', exact: true });
}

async function flush(page: Page): Promise<void> {
  await page.evaluate(() => window.pascapLab!.flush());
}

async function untouched(page: Page, before: ProjectDocument, saves: number): Promise<void> {
  expect(await current(page)).toEqual(before);
  await flush(page);
  expect(memory.saves).toBe(saves);
  expect(memory.snapshot()).toEqual(before);
  await expect(undo(page)).toBeDisabled();
}

async function begin(page: Page, edge: 'in' | 'out') {
  const target = handle(page, edge);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const width = (await page.locator('.clip-source-bar').boundingBox())!.width;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  expect(await target.evaluate((element) => element.hasPointerCapture(1))).toBe(true);
  await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-range-draft', 'true');
  return { target, x, y, width };
}

test('frame/timecode fields: Enter/blur, Escape, no-op edits and one-step Undo/Redo', async ({ page }) => {
  const before = await open(page);
  const input = field(page, 'in');
  await input.fill('25');
  await untouched(page, before, 0);
  await input.press('Enter');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('00:00:00:25');
  const next = applyCommand(before, { type: 'trim', clipId: 'a', sourceIn: 25, sourceOut: 105 });
  expect(await current(page)).toEqual(next);
  await input.press('Enter');
  await input.press('Tab');
  await flush(page);
  expect(memory.saves).toBe(1);
  expect(memory.snapshot()).toEqual({ ...next, revision: before.revision + 1 });
  await undo(page).click();
  expect(await current(page)).toEqual(before);
  await expect(undo(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await current(page)).toEqual(next);
  await undo(page).click();
  await input.fill('00:00:01:00');
  await input.press('Tab');
  expect(await current(page)).toEqual(
    applyCommand(before, { type: 'trim', clipId: 'a', sourceIn: 30, sourceOut: 105 }),
  );
  await expect(input).toHaveValue('00:00:01:00');
  await undo(page).click();
  await expect(undo(page)).toBeDisabled();
  await flush(page);
  const stableSaves = memory.saves;
  await input.fill('42');
  await input.press('Escape');
  await expect(input).toHaveValue('00:00:00:15');
  await expect(input).toBeFocused();
  for (const notation of ['15', '00:00:00:15']) {
    await input.fill(notation);
    await input.press('Enter');
    await input.press('Tab');
    expect(await current(page)).toEqual(before);
    await expect(undo(page)).toBeDisabled();
  }
  await flush(page);
  expect(memory.saves).toBe(stableSaves);
});

test('invalid frame/timecode drafts retain text/errors without clamping, saves or history', async ({ page }) => {
  const before = await open(page);
  for (const edge of ['in', 'out'] as const) {
    const input = field(page, edge);
    const drafts =
      edge === 'in'
        ? ['', '15.5', '-1', '105', '00:00:00:30', '00:60:00:00', 'NaN']
        : ['15', '121', '00:00:04:01', '00:00:99:00'];
    for (const draft of drafts) {
      await input.fill(draft);
      await input.press('Enter');
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(input).toHaveValue(draft);
      const error = input.locator('..').getByRole('alert');
      await expect(error).toContainText(`Escape to restore ${formatTimecode(edge === 'in' ? 15 : 105)}`);
      expect(await input.getAttribute('aria-errormessage')).toBe(await error.getAttribute('id'));
      await input.press('Tab');
      await untouched(page, before, 0);
      await expect(input).toHaveValue(draft);
      await input.press('Escape');
      await expect(input).toHaveAttribute('aria-invalid', 'false');
      await expect(input).toHaveValue(formatTimecode(edge === 'in' ? 15 : 105));
    }
  }
});

for (const ripple of [true, false]) {
  test(`${ripple ? 'Ripple' : 'Positioned'}: retimed capture-relative drafts and one fixed-start trim`, async ({
    page,
  }) => {
    const before = await open(page, sequence(ripple, true));
    await page.evaluate(() => window.pascapLab!.engine.seek(45));
    await ready(page, before, 45);
    const drag = await begin(page, 'in');
    for (const delta of [10, 15]) {
      await page.mouse.move(drag.x + (delta * drag.width) / 120, drag.y, { steps: 3 });
      const draft = applyCommand(before, { type: 'trim', clipId: 'a', sourceIn: 15 + delta, sourceOut: 105 });
      await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-source-in', String(15 + delta));
      await expect(field(page, 'in')).toHaveValue(formatTimecode(15 + delta));
      await expect(field(page, 'in')).toBeDisabled();
      await ready(page, draft, 30);
      await untouched(page, before, 0);
    }
    await page.mouse.up();
    const next = applyCommand(before, { type: 'trim', clipId: 'a', sourceIn: 30, sourceOut: 105 });
    expect(await current(page)).toEqual(next);
    expect(next.clips[0]!.start).toBe(30);
    expect(next.clips[1]!.start).toBe(ripple ? 180 : 230);
    expect(next.layers).toEqual(before.layers);
    expect(next.clips[0]!.speed).toEqual(before.clips[0]!.speed);
    expect(next.clips[0]!.spatial).toEqual(before.clips[0]!.spatial);
    await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-range-draft', 'false');
    await flush(page);
    expect(memory.saves).toBe(1);
    expect(memory.snapshot()).toEqual({ ...next, revision: before.revision + 1 });
    await undo(page).click();
    expect(await current(page)).toEqual(before);
    await expect(undo(page)).toBeDisabled();
    // The exact field must use the same fixed-start semantics, not retained OUT.
    await field(page, 'in').fill('00:00:01:00');
    await field(page, 'in').press('Enter');
    expect(await current(page)).toEqual(next);
    await undo(page).click();
    await expect(undo(page)).toBeDisabled();
  });
}

test('final transition-invalid OUT rejects the gesture, not the last valid draft', async ({ page }) => {
  const document = applyCommand(sequence(), {
    type: 'transition',
    transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 18 },
  });
  const before = await open(page, document);
  const drag = await begin(page, 'out');
  await page.mouse.move(drag.x - (15 * drag.width) / 120, drag.y, { steps: 3 });
  await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-source-out', '90');
  await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-invalid', 'false');
  await ready(page, applyCommand(before, { type: 'trim', clipId: 'a', sourceIn: 15, sourceOut: 90 }));
  await untouched(page, before, 0);
  await page.mouse.move(drag.x - (80 * drag.width) / 120, drag.y, { steps: 3 });
  await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-source-out', '25');
  await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-invalid', 'true');
  await page.mouse.up();
  await expect(page.locator('.clip-source-range').getByRole('alert')).toContainText('conflicting fades');
  await expect(field(page, 'out')).toHaveValue('00:00:03:15');
  await ready(page, before);
  await untouched(page, before, 0);
  await field(page, 'out').fill('00:00:00:25');
  await field(page, 'out').press('Enter');
  await expect(field(page, 'out')).toHaveAttribute('aria-invalid', 'true');
  await untouched(page, before, 0);
});

test('Escape, pointercancel, lost capture and window blur restore range/preview without saving', async ({ page }) => {
  const before = await open(page, sequence(true, true));
  for (const cancellation of ['Escape', 'pointercancel', 'lostcapture', 'windowblur'] as const) {
    await page.evaluate(() => window.pascapLab!.engine.seek(45));
    await ready(page, before, 45);
    const drag = await begin(page, 'in');
    await page.mouse.move(drag.x + (15 * drag.width) / 120, drag.y, { steps: 3 });
    await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-source-in', '30');
    await ready(page, applyCommand(before, { type: 'trim', clipId: 'a', sourceIn: 30, sourceOut: 105 }), 30);
    await untouched(page, before, 0);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'pointercancel')
      await drag.target.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
    else if (cancellation === 'lostcapture') await drag.target.evaluate((element) => element.releasePointerCapture(1));
    else await page.evaluate(() => globalThis.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await expect(page.locator('.clip-source-bar')).toHaveAttribute('data-range-draft', 'false');
    await expect(field(page, 'in')).toHaveValue('00:00:00:15');
    await expect(field(page, 'in')).toBeEnabled();
    expect(await drag.target.evaluate((element) => element.hasPointerCapture(1))).toBe(false);
    await ready(page, before, 45);
    await untouched(page, before, 0);
  }
});

test('pointer source bounds and unchanged release preserve one-step history', async ({ page }) => {
  const before = await open(page);
  const unchanged = await begin(page, 'in');
  await page.mouse.up();
  expect(await unchanged.target.evaluate((element) => element.hasPointerCapture(1))).toBe(false);
  await untouched(page, before, 0);
  for (const edge of ['in', 'out'] as const) {
    const drag = await begin(page, edge);
    // Travel one source frame beyond the original endpoint, still inside the viewport.
    await page.mouse.move(drag.x + ((edge === 'in' ? -16 : 16) * drag.width) / 120, drag.y, { steps: 3 });
    const sourceIn = edge === 'in' ? 0 : 15;
    const sourceOut = edge === 'out' ? 120 : 105;
    await expect(drag.target).toHaveAttribute('aria-valuenow', String(edge === 'in' ? sourceIn : sourceOut));
    await page.mouse.up();
    expect(await current(page)).toEqual(applyCommand(before, { type: 'trim', clipId: 'a', sourceIn, sourceOut }));
    await undo(page).click();
    expect(await current(page)).toEqual(before);
    await expect(undo(page)).toBeDisabled();
  }
});

for (const ripple of [true, false]) {
  test(`${ripple ? 'Ripple' : 'Positioned'}: native arrows/Shift/Home/End and strict bounds`, async ({ page }) => {
    const before = await open(page, sequence(ripple));
    for (const { edge, key, boundary } of [
      { edge: 'in', key: 'ArrowRight', boundary: 16 },
      { edge: 'in', key: 'Shift+ArrowRight', boundary: 25 },
      { edge: 'in', key: 'ArrowLeft', boundary: 14 },
      { edge: 'in', key: 'Shift+ArrowLeft', boundary: 5 },
      { edge: 'in', key: 'Home', boundary: 0 },
      { edge: 'in', key: 'End', boundary: 104 },
      { edge: 'out', key: 'ArrowRight', boundary: 106 },
      { edge: 'out', key: 'Shift+ArrowLeft', boundary: 95 },
      { edge: 'out', key: 'Home', boundary: 16 },
      { edge: 'out', key: 'End', boundary: 120 },
    ] as const) {
      const target = handle(page, edge);
      await target.focus();
      await target.press(key);
      await expect(target).toBeFocused();
      await expect(target).toHaveAttribute('aria-valuenow', String(boundary));
      await expect(field(page, edge)).toHaveValue(formatTimecode(boundary));
      const next = applyCommand(before, {
        type: 'trim',
        clipId: 'a',
        sourceIn: edge === 'in' ? boundary : 15,
        sourceOut: edge === 'out' ? boundary : 105,
      });
      expect(await current(page)).toEqual(next);
      expect(next.clips[0]!.start).toBe(30);
      expect(next.layers).toEqual(before.layers);
      await undo(page).click();
      expect(await current(page)).toEqual(before);
      await expect(undo(page)).toBeDisabled();
    }
    for (const { edge, boundaryKey, rejectedKey, error } of [
      { edge: 'in', boundaryKey: 'Home', rejectedKey: 'ArrowLeft', error: 'inside the original recording' },
      { edge: 'out', boundaryKey: 'End', rejectedKey: 'ArrowRight', error: 'inside the original recording' },
      { edge: 'in', boundaryKey: 'End', rejectedKey: 'ArrowRight', error: 'Source OUT must be after IN' },
      { edge: 'out', boundaryKey: 'Home', rejectedKey: 'ArrowLeft', error: 'Source OUT must be after IN' },
    ] as const) {
      const target = handle(page, edge);
      await target.press(boundaryKey);
      const atBound = await current(page);
      await flush(page);
      const saves = memory.saves;
      await target.press(rejectedKey);
      await expect(page.locator('.clip-source-range').getByRole('alert')).toContainText(error);
      expect(await current(page)).toEqual(atBound);
      await flush(page);
      expect(memory.saves).toBe(saves);
      await undo(page).click();
      expect(await current(page)).toEqual(before);
      await expect(undo(page)).toBeDisabled();
    }
  });
}

test('collapse/tabs retain draft identity; clip selection replaces context without applying it', async ({ page }) => {
  const before = await open(page);
  const input = field(page, 'in');
  await input.fill('15.5');
  await input.press('Enter');
  const node = await input.elementHandle();
  if (!node) throw new Error('Source field must be mounted.');
  const section = page.getByRole('button', { name: 'Range section', exact: true });
  await section.click();
  await expect(input).toBeHidden();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await inspectorTab(page, 'Track');
  await inspectorTab(page, 'Clip');
  await section.click();
  await expect(input).toHaveValue('15.5');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(await input.evaluate((element, previous) => element === previous, node)).toBe(true);
  await untouched(page, before, 0);
  // No blur-based valid commit: select while the former invalid draft is mounted.
  await page.locator('[data-clip-id="b"] .timeline-clip-body').click();
  await expect(input).toHaveValue('00:00:01:00');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  expect(await node.evaluate((element) => element.isConnected)).toBe(false);
  await input.press('Enter');
  await input.press('Tab');
  await untouched(page, before, 0);
  await page.locator('[data-clip-id="a"] .timeline-clip-body').click();
  await expect(input).toHaveValue('00:00:00:15');
  await untouched(page, before, 0);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`${viewport.width}×${viewport.height}: original hatching and controls at 270px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const before = await open(page);
    const divider = page.getByRole('slider', { name: 'Resize Clip panel', exact: true });
    await divider.focus();
    for (let index = 0; index < 4; index++) await divider.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '270');
    const bar = page.locator('.clip-source-bar');
    await bar.scrollIntoViewIfNeeded();
    await expect(bar).toHaveAttribute('data-source-in', '15');
    await expect(bar).toHaveAttribute('data-source-out', '105');
    const geometry = await bar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return ['.before', '.clip-source-selected', '.after'].map((selector) => {
        const child = element.querySelector(selector)!;
        const rect = child.getBoundingClientRect();
        return {
          left: (rect.left - bounds.left - element.clientLeft) / element.clientWidth,
          width: rect.width / element.clientWidth,
          background: getComputedStyle(child).backgroundImage,
        };
      });
    });
    for (const [index, [left, width]] of [
      [0, 0.125],
      [0.125, 0.75],
      [0.875, 0.125],
    ]
      .map(([left, width]) => [left!, width!] as const)
      .entries()) {
      expect(geometry[index]!.left).toBeCloseTo(left, 2);
      expect(geometry[index]!.width).toBeCloseTo(width, 2);
    }
    expect(geometry[0]!.background).toContain('repeating-linear-gradient');
    expect(geometry[2]!.background).toContain('repeating-linear-gradient');
    await expect(handle(page, 'in')).toHaveAttribute('aria-valuemin', '0');
    await expect(handle(page, 'in')).toHaveAttribute('aria-valuemax', '104');
    await expect(handle(page, 'out')).toHaveAttribute('aria-valuemin', '16');
    await expect(handle(page, 'out')).toHaveAttribute('aria-valuemax', '120');
    await expect(handle(page, 'out')).toHaveAttribute('aria-valuetext', '00:00:03:15, OUT exclusive');
    const barBounds = (await bar.boundingBox())!;
    for (const edge of ['in', 'out'] as const) {
      const target = handle(page, edge);
      const box = (await target.boundingBox())!;
      const fraction = edge === 'in' ? 15 / 120 : 105 / 120;
      expect(Math.abs(box.x + box.width / 2 - (barBounds.x + fraction * barBounds.width))).toBeLessThan(2);
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      await target.focus();
      await expect(target).toBeInViewport();
      await page.keyboard.press('Tab');
      await expect(edge === 'in' ? handle(page, 'out') : field(page, 'in')).toBeFocused();
      await field(page, edge).scrollIntoViewIfNeeded();
      const exact = (await field(page, edge).boundingBox())!;
      expect(exact.width).toBeGreaterThanOrEqual(60);
      expect(exact.x).toBeGreaterThanOrEqual(0);
      expect(exact.x + exact.width).toBeLessThanOrEqual(viewport.width);
      expect(exact.y).toBeGreaterThanOrEqual(barBounds.y + barBounds.height);
      await expect(field(page, edge)).toBeInViewport();
    }
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await test.info().attach(`source-range-${viewport.width}-trimmed`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await field(page, 'in').fill('00:00:00:30');
    await field(page, 'in').press('Enter');
    await expect(field(page, 'in')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(page, 'in').locator('..').getByRole('alert')).toBeInViewport();
    await test.info().attach(`source-range-${viewport.width}-invalid`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await field(page, 'in').press('Escape');
    await untouched(page, before, 0);
    await page.getByRole('button', { name: 'Restore full recording', exact: true }).click();
    expect(await current(page)).toEqual(
      applyCommand(before, { type: 'trim', clipId: 'a', sourceIn: 0, sourceOut: 120 }),
    );
    await expect(field(page, 'in')).toHaveValue('00:00:00:00');
    await expect(field(page, 'out')).toHaveValue('00:00:04:00');
    await expect(page.getByRole('button', { name: 'Restore full recording', exact: true })).toBeDisabled();
    expect(await bar.locator('.before').evaluate((element) => element.getBoundingClientRect().width)).toBe(0);
    expect(await bar.locator('.after').evaluate((element) => element.getBoundingClientRect().width)).toBe(0);
    await test.info().attach(`source-range-${viewport.width}-full`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await undo(page).click();
    expect(await current(page)).toEqual(before);
    await expect(undo(page)).toBeDisabled();
  });
}
