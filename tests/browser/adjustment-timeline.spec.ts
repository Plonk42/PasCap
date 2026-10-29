import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyCommand } from '../../src/shared/commands.js';
import { createAdjustment } from '../../src/shared/grade.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { expandedInspectorPreferences } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;

const current = (page: Page): Promise<ProjectDocument> => page.evaluate(() => window.pascapLab!.project()!);
const item = (page: Page, id: string): Locator => page.locator(`.adjustment-item[data-adjustment-id="${id}"]`);
const body = (page: Page, id: string): Locator => item(page, id).locator('.adjustment-body');
const ranges = async (page: Page) =>
  (await current(page)).adjustments.map(({ id, start, duration }) => ({ id, start, duration }));

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()))
    .toMatchObject({ status: 'paused', frame });
}

async function pixelsPerFrame(page: Page): Promise<number> {
  return Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
}

/** Presses on `target` and moves by whole frames, returning a function that releases the pointer. */
async function press(page: Page, target: Locator, frames: number, alt = true): Promise<() => Promise<void>> {
  const box = (await target.boundingBox())!;
  const scale = await pixelsPerFrame(page);
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (frames * scale) / 2, y, { steps: 3 });
  await page.mouse.move(x + frames * scale, y, { steps: 3 });
  return async () => {
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
  };
}

test.beforeEach(async ({ page, request }) => {
  const assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const asset = assets.find((entry) => entry.name === 'pattern-a.mp4' && entry.status === 'ready');
  if (!asset) throw new Error('Prepared synthetic video required.');
  let document = createProject('adjustment-timeline', 'Adjustment timeline · memory only');
  document.media.videoIds = [asset.id];
  document.clips = [createClip('one', asset.id, 0, 40), { ...createClip('two', asset.id, 40, 80), start: 40 }];
  document.layers[0]!.transitions = [{ leftId: 'one', rightId: 'two', type: 'cut', duration: 0 }];
  // Clips keep their own starts, so a moved selection changes nothing else.
  document.layers[0]!.ripple = false;
  const desaturated = createAdjustment('b', 50, 10);
  desaturated.colour.saturation = 0.4;
  document.adjustments = [createAdjustment('a', 10, 20), desaturated];
  document = applyCommand(document, {
    type: 'layer-key-toggle',
    adjustmentId: 'a',
    frame: 5,
    setting: 'exposure',
    value: 0.5,
  });
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await page.waitForFunction(() => window.pascapLab?.project() != null);
  await page.getByRole('slider', { name: 'Timeline zoom' }).fill('180');
  await seek(page, 0);
});

test('adjustments sit on a pinned track above the video tracks; a click selects one and opens its Colour', async ({
  page,
}) => {
  const lane = page.locator('.adjustment-lane');
  const track = page.locator('[data-layer-lane]').first();
  expect((await lane.boundingBox())!.y + 30).toBeLessThan((await track.boundingBox())!.y);
  await expect(page.locator('.layer-sidebar-adjustments')).toHaveText('Adjustments · 2 / 64');
  await expect(body(page, 'a')).toHaveAccessibleName('Adjustment 00:00:10 – 00:01:00');
  await expect(item(page, 'a').locator('[data-adjustment-keyframe="5"]')).toHaveAccessibleName(
    /Adjustment keyframe at 00:00:15/,
  );

  await body(page, 'a').click();
  await expect(body(page, 'a')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tab', { name: 'Colour', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inspector-pane .colour-target strong')).toHaveText('Adjustment 00:00:10 – 00:01:00');
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  expect(frame).toBeGreaterThanOrEqual(10);
  expect(frame).toBeLessThan(30);

  // A selected clip shows which adjustment also grades it at the playhead, without selecting it.
  await page.locator('[data-clip-id="one"] .timeline-clip-body').click();
  await seek(page, 20);
  await expect(body(page, 'a')).toHaveAttribute('aria-pressed', 'false');
  await expect(item(page, 'a')).toHaveClass(/grading/);
  await expect(body(page, 'a')).toHaveAccessibleName(/grades the selected clip/);
  await seek(page, 35);
  await expect(item(page, 'a')).not.toHaveClass(/grading/);
  expect(memory.saves).toBe(0);
});

test('dragging moves or trims an adjustment in one Undo step, refusing overlaps and restoring on Escape', async ({
  page,
}) => {
  const release = await press(page, body(page, 'a'), 10);
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '20');
  await expect(page.locator('.timeline-bottom')).toContainText('Adjustment 00:00:20 – 00:01:10');
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });
  await release();
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 20, duration: 20 });
  // Keyframes move with it: they count from its start.
  expect((await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([5]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });

  const overlap = await press(page, body(page, 'a'), 35);
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-valid', 'false');
  await expect(item(page, 'a')).toHaveClass(/invalid/);
  await expect(page.locator('.timeline-bottom')).toContainText('Adjustments cannot overlap');
  await overlap();
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '10');
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });

  const cancelled = await press(page, body(page, 'a'), 5);
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '15');
  await page.keyboard.press('Escape');
  await expect(item(page, 'a')).toHaveAttribute('data-adjustment-start', '10');
  await cancelled();
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });

  // Trimming the start keeps each keyframe on its project frame.
  const trim = await press(page, item(page, 'a').locator('.trim-handle.in'), 3);
  await trim();
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 13, duration: 17 });
  expect((await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([2]);
  const saves = memory.saves;
  await page.keyboard.press('Control+z');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 10, duration: 20 });
  await expect.poll(() => memory.saves).toBeGreaterThan(saves);
});

test('a moved adjustment snaps its edges to clip boundaries unless Alt is held', async ({ page }) => {
  // Its end lands at 39, one frame from the cut at 40; without snapping it would start at 19.
  const release = await press(page, body(page, 'a'), 8.8, false);
  await release();
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 20, duration: 20 });
});

test('keyboard moves, trims and deletes an adjustment', async ({ page }) => {
  await body(page, 'a').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 11, duration: 20 });
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 20 });
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.locator('.error-banner')).toContainText('An adjustment cannot start before the first frame.');
  expect(await ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 20 });
  await item(page, 'a').locator('.trim-handle.out').focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 10 });
  await body(page, 'a').focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => ranges(page)).toEqual([{ id: 'b', start: 50, duration: 10 }]);
  await expect(page.locator('.layer-sidebar-adjustments')).toHaveText('Adjustments · 1 / 64');
  await page.keyboard.press('Control+z');
  await expect.poll(() => ranges(page)).toContainEqual({ id: 'a', start: 1, duration: 10 });
});

test('an adjustment keyframe slides within its adjustment', async ({ page }) => {
  const marker = item(page, 'a').locator('[data-adjustment-keyframe="5"]');
  const release = await press(page, marker, 3);
  await expect(page.locator('.timeline-bottom')).toContainText('Adjustment keyframe · 00:00:18');
  await release();
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([8]);
  await expect(page.getByRole('tab', { name: 'Colour', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(body(page, 'a')).toHaveAttribute('aria-pressed', 'true');

  const outside = item(page, 'a').locator('[data-adjustment-keyframe="8"]');
  await outside.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([18]);
  await page.keyboard.press('Shift+ArrowRight');
  expect((await current(page)).adjustments[0]!.keyframes.map((key) => key.frame)).toEqual([18]);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes).toEqual([]);
});

/** Presses the empty adjustment track at `from` and drags to `to`, in project frames, with Alt. */
async function draw(page: Page, from: number, to: number): Promise<() => Promise<void>> {
  const lane = (await page.locator('.adjustment-lane').boundingBox())!;
  const scale = await pixelsPerFrame(page);
  const leading = Number(await page.locator('.timeline-surface').getAttribute('data-leading'));
  const y = lane.y + 4;
  await page.keyboard.down('Alt');
  await page.mouse.move(lane.x + leading + from * scale, y);
  await page.mouse.down();
  await page.mouse.move(lane.x + leading + ((from + to) / 2) * scale, y, { steps: 3 });
  await page.mouse.move(lane.x + leading + to * scale, y, { steps: 3 });
  return async () => {
    await page.mouse.up();
    await page.keyboard.up('Alt');
  };
}

test('drawing on the empty track creates a selected adjustment; an overlap is refused', async ({ page }) => {
  const blocked = await draw(page, 32, 55);
  await expect(page.locator('[data-adjustment-draft]')).toHaveAttribute('data-adjustment-valid', 'false');
  await expect(page.locator('.timeline-bottom')).toContainText('Adjustments cannot overlap');
  await blocked();
  await expect(page.locator('[data-adjustment-draft]')).toHaveCount(0);
  expect(await ranges(page)).toHaveLength(2);

  const release = await draw(page, 45, 32);
  await expect(page.locator('[data-adjustment-draft]')).toHaveAttribute('data-adjustment-start', '32');
  await expect(page.locator('.timeline-bottom')).toContainText('New adjustment 00:01:02 – 00:01:15');
  await release();
  await expect
    .poll(async () => (await ranges(page)).map(({ start, duration }) => [start, duration]))
    .toEqual([
      [10, 20],
      [32, 13],
      [50, 10],
    ]);
  const created = (await current(page)).adjustments[1]!;
  await expect(body(page, created.id)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#inspector-pane .colour-target strong')).toHaveText('Adjustment 00:01:02 – 00:01:15');
  await page.keyboard.press('Control+z');
  await expect.poll(() => ranges(page)).toHaveLength(2);

  // A click on the empty track only moves the playhead.
  const click = await draw(page, 40, 40);
  await click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(40);
  expect(await ranges(page)).toHaveLength(2);
});

test('Add adjustment covers the ruler range or the selected clip, with the reason when it cannot', async ({ page }) => {
  const add = page.getByRole('button', { name: 'Add adjustment', exact: true });
  // Selecting an adjustment leaves no clip selected.
  await body(page, 'b').press('Enter');
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await expect(add).toHaveAttribute('title', /Select a range on the time ruler or a clip first/);
  await page.locator('[data-clip-id="one"] .timeline-clip-body').click();
  await expect(add).toHaveAttribute('title', /Adjustments cannot overlap/);
  await add.dispatchEvent('click');
  expect(await ranges(page)).toHaveLength(2);

  const ruler = (await page.locator('.timeline-ruler').boundingBox())!;
  const scale = await pixelsPerFrame(page);
  const leading = Number(await page.locator('.timeline-surface').getAttribute('data-leading'));
  await page.keyboard.down('Alt');
  await page.mouse.move(ruler.x + leading + 62 * scale, ruler.y + 24);
  await page.mouse.down();
  await page.mouse.move(ruler.x + leading + 75 * scale, ruler.y + 24, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(add).not.toHaveAttribute('aria-disabled', 'true');
  await expect(add).toHaveAttribute('title', 'Add an adjustment over the selected range, 00:02:02 – 00:02:15');
  await add.click();
  await expect.poll(() => ranges(page)).toContainEqual(expect.objectContaining({ start: 62, duration: 13 }));
  await expect(page.locator('#inspector-pane .colour-target strong')).toHaveText('Adjustment 00:02:02 – 00:02:15');
});

test('Split and Delete act on the selected adjustment, keeping its grade and keyframes', async ({ page }) => {
  await body(page, 'a').focus();
  await body(page, 'a').press('Enter');
  await seek(page, 10);
  const split = page.getByRole('button', { name: 'Split at playhead', exact: true });
  await expect(split).toBeDisabled();
  await expect(split).toHaveAttribute('title', /Place the playhead inside the selected adjustment/);
  await seek(page, 20);
  await page.locator('.timeline-panel').focus();
  await page.keyboard.press('s');
  await expect
    .poll(async () => (await ranges(page)).map(({ start, duration }) => [start, duration]))
    .toEqual([
      [10, 10],
      [20, 10],
      [50, 10],
    ]);
  const pieces = (await current(page)).adjustments;
  expect(pieces[0]!.keyframes.map((key) => key.frame)).toEqual([5]);
  expect(pieces[1]!.keyframes.map((key) => key.frame)).toEqual([-5]);
  await expect(body(page, pieces[1]!.id)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Delete selected adjustment', exact: true }).click();
  await expect.poll(() => ranges(page)).toHaveLength(2);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect
    .poll(() => ranges(page))
    .toEqual([
      { id: 'a', start: 10, duration: 20 },
      { id: 'b', start: 50, duration: 10 },
    ]);
});

const clipStart = async (page: Page, id: string): Promise<number> =>
  (await current(page)).clips.find((clip) => clip.id === id)!.start;

/** Clip "two" and adjustment "b" selected together with Ctrl-click. */
async function selectTwoAndB(page: Page): Promise<void> {
  await page.locator('[data-clip-id="two"] .timeline-clip-body').click();
  await body(page, 'b').click({ modifiers: ['Control'] });
  await expect(body(page, 'b')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-clip-id="two"]')).toHaveClass(/\bselected\b/);
}

test('Ctrl-click selects clips and adjustments together: Colour edits neither, a drag moves both', async ({ page }) => {
  await selectTwoAndB(page);
  await page.getByRole('tab', { name: 'Colour', exact: true }).click();
  await expect(page.locator('#inspector-pane [role="tabpanel"]:not([hidden]) .inspector-empty')).toHaveText(
    '1 clip and 1 adjustment are selected: select one to edit its grade. Paste grade sets the same grade on all of them.',
  );
  await expect(
    page.getByRole('button', { name: 'Delete selected clips and adjustments', exact: true }),
  ).toHaveAttribute('title', 'Remove the selected 1 clip and 1 adjustment in one Undo step · Delete');

  const release = await press(page, body(page, 'b'), 5);
  await expect(item(page, 'b')).toHaveAttribute('data-adjustment-start', '55');
  await release();
  await expect.poll(() => clipStart(page, 'two')).toBe(45);
  expect(await ranges(page)).toContainEqual({ id: 'b', start: 55, duration: 10 });
  await expect(body(page, 'b')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+z');
  await expect.poll(() => clipStart(page, 'two')).toBe(40);
  expect(await ranges(page)).toContainEqual({ id: 'b', start: 50, duration: 10 });

  // Dragging the clip carries the adjustment too, by the same frames.
  const box = (await page.locator('[data-clip-id="two"]').boundingBox())!;
  const scale = await pixelsPerFrame(page);
  await page.mouse.move(box.x + 12 * scale, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 12 * scale + 12, box.y + 30, { steps: 3 });
  await page.mouse.move(box.x + 22 * scale, box.y + 30, { steps: 8 });
  await page.mouse.move(box.x + 22 * scale, box.y + 30);
  await expect(page.locator('[data-adjustment-ghost="b"]')).toHaveAttribute('data-adjustment-start', '60');
  await page.mouse.up();
  await expect.poll(() => clipStart(page, 'two')).toBe(50);
  expect(await ranges(page)).toContainEqual({ id: 'b', start: 60, duration: 10 });

  // Ctrl-click takes the clip out again, leaving the adjustment, and Delete removes what is selected.
  await page.locator('[data-clip-id="two"] .timeline-clip-body').click({ modifiers: ['Control'] });
  await expect(page.locator('[data-clip-id="two"]')).not.toHaveClass(/\bselected\b/);
  await expect(body(page, 'b')).toHaveAttribute('aria-pressed', 'true');
  await body(page, 'a').click({ modifiers: ['Control'] });
  const remove = page.getByRole('button', { name: 'Delete selected adjustments', exact: true });
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect.poll(() => ranges(page)).toEqual([]);
  expect((await current(page)).clips).toHaveLength(2);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await ranges(page)).length).toBe(2);
  // The Delete key removes the same selection in one Undo step.
  await body(page, 'a').click();
  await body(page, 'b').click({ modifiers: ['Control'] });
  await page.locator('.timeline-panel').focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => ranges(page)).toEqual([]);
  expect((await current(page)).clips).toHaveLength(2);
});

test('Copy grade and Paste grade work between clips and adjustments from the context menu', async ({ page }) => {
  await body(page, 'a').click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'Copy grade of this adjustment' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Duplicate selected clip' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await body(page, 'b').click({ button: 'right' });
  await page.getByRole('button', { name: 'Copy grade of this adjustment' }).click();
  await page.locator('[data-clip-id="one"] .timeline-clip-body').click({ button: 'right' });
  await page.getByRole('button', { name: 'Paste grade on this clip' }).click();
  await expect.poll(async () => (await current(page)).clips[0]!.grade.colour.saturation).toBe(0.4);

  // Pasting on a selected item pastes on the whole selection, keyframes removed, in one Undo step.
  await selectTwoAndB(page);
  await body(page, 'a').click({ modifiers: ['Control'] });
  await body(page, 'a').click({ button: 'right' });
  await page.getByRole('button', { name: 'Paste grade on 1 clip and 2 adjustments' }).click();
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes).toEqual([]);
  const pasted = await current(page);
  expect(pasted.clips[1]!.grade.colour.saturation).toBe(0.4);
  expect(pasted.adjustments[0]!.colour.saturation).toBe(0.4);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await current(page)).adjustments[0]!.keyframes).toHaveLength(1);
  expect((await current(page)).clips[1]!.grade.colour.saturation).toBe(1);
});
