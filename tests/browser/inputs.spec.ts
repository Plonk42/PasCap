import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  addMusicTrack,
  adjustmentFrom0,
  adjustmentKeyframes,
  editAdjustmentPoint,
  editTransformKeyframe,
  expandedInspectorPreferences,
  gradePoint,
  inspectorTab,
  resetSetting,
  transformPoint,
} from './editor-helpers.js';
import { memoryProjects } from './memory-projects.js';

test.beforeEach(async ({ page, request }) => {
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const audio = (await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] };
  let document = createProject('preview-lab', 'Numeric controls · memory-only');
  document.media = {
    videoIds: library.assets.map((asset) => asset.id),
    audioIds: audio.assets.map((asset) => asset.id),
  };
  for (const [index, name] of ['pattern-a.mp4', 'pattern-b.mp4'].entries()) {
    const asset = library.assets.find((item) => item.name === name && item.status === 'ready');
    if (!asset) throw new Error('These tests require the dedicated synthetic browser fixture.');
    document = applyCommand(document, {
      type: 'insert',
      clip: createClip(index === 0 ? 'clip-a' : 'clip-b', asset.id, 15, 105),
      index,
    });
  }
  document = applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'clip-a', rightId: 'clip-b', type: 'cross-dissolve', duration: 18 },
  });
  document.adjustments = [adjustmentFrom0(calculateLayout(document).duration)];

  // Exercise real editor history/autosave without writing even the fixture's project store.
  await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto('/?project=preview-lab');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

/** Colour's keyframe line visits every stored adjustment keyframe. */
function colourStep(page: Page, direction: 'Previous' | 'Next'): Locator {
  return page.getByRole('button', { name: `${direction} Colour keyframe`, exact: true });
}

async function currentProject(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function setProject(page: Page, document: ProjectDocument): Promise<void> {
  await page.evaluate((next) => window.pascapLab!.setDocument(next), document);
  await page.waitForFunction((duration) => {
    const state = window.pascapLab?.engine.diagnostics();
    return state?.status === 'paused' && state.duration === duration;
  }, calculateLayout(document).duration);
}

async function commitNumber(page: Page, name: string, value: string): Promise<void> {
  if (/^(Transform|Opacity) keyframe/.test(name)) await inspectorTab(page, 'Track');
  else if (name.includes('keyframe')) await inspectorTab(page, 'Adjustment');
  else if (name.startsWith('Music')) await inspectorTab(page, 'Audio');
  else if (/Opening|Closing|Transition/.test(name)) await inspectorTab(page, 'Sequence');
  else if (
    /^(Temperature|Tint|Exposure|Brightness|Contrast|Hue|Saturation|Vibrance|Highlights|Shadows|Whites|Blacks)$/.test(
      name,
    )
  )
    await inspectorTab(page, 'Adjustment');
  else await inspectorTab(page, 'Clip');
  const field = page.getByRole('spinbutton', { name, exact: true });
  await field.fill(value);
  await field.press('Enter');
}

test('Enter and blur each commit once, while Escape and unchanged drafts do not create undo steps', async ({
  page,
}) => {
  const field = page.getByRole('textbox', { name: 'Source IN frame', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await field.fill('25');
  expect((await currentProject(page)).clips[0]?.sourceIn).toBe(15);
  await field.press('Enter');
  await expect(field).toBeFocused();
  expect((await currentProject(page)).clips[0]?.sourceIn).toBe(25);
  await field.press('Enter');
  await field.press('Tab');
  await undo.click();
  await expect(field).toHaveValue('00:00:15');
  await expect(undo).toBeDisabled();

  await field.fill('00:01:00');
  await field.press('Tab');
  expect((await currentProject(page)).clips[0]?.sourceIn).toBe(30);
  await undo.click();
  await expect(undo).toBeDisabled();
  await field.fill('42');
  await field.press('Escape');
  await expect(field).toHaveValue('00:00:15');
  await expect(field).toBeFocused();
  await field.fill('15.0');
  await field.press('Enter');
  await field.press('Tab');
  await expect(undo).toBeDisabled();
  expect((await currentProject(page)).clips[0]?.sourceIn).toBe(15);
});

test('empty, fractional, out-of-bounds and conflicting timing drafts stay editable with inline errors', async ({
  page,
}) => {
  const field = page.getByRole('textbox', { name: 'Source IN frame', exact: true });
  for (const draft of ['', '15.5', '-1', '999', '00:00:30', '00:00:00:00', 'not a frame']) {
    await field.fill(draft);
    await field.press('Enter');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveValue(draft);
    const error = field.locator('..').getByRole('alert');
    await expect(error).toContainText('Escape to restore 00:00:15');
    expect(await field.getAttribute('aria-errormessage')).toBe(await error.getAttribute('id'));
    expect((await currentProject(page)).clips[0]?.sourceIn).toBe(15);
    await field.press('Escape');
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await expect(field).toHaveValue('00:00:15');
  }
  const out = page.getByRole('textbox', { name: 'Source OUT frame', exact: true });
  await out.fill('999');
  await out.press('Enter');
  await expect(out.locator('..').getByRole('alert')).toContainText('Enter 120 or less');
  await out.press('Tab');
  expect((await currentProject(page)).clips[0]?.sourceOut).toBe(105);
  await out.press('Escape');
  await out.fill('25');
  await out.press('Enter');
  await expect(out.locator('..').getByRole('alert')).toContainText('conflicting fades');
  expect((await currentProject(page)).clips[0]?.sourceOut).toBe(105);
});

test('undo and external document updates replace stale drafts without moving input focus', async ({ page }) => {
  const field = page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true });
  await commitNumber(page, 'Clip speed rate', '1.5');
  await field.fill('3');
  // A programmatic toolbar activation does not blur the focused draft first.
  await page
    .getByRole('button', { name: 'Undo', exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(field).toHaveValue('1');
  await expect(field).toBeFocused();
  await field.press('Enter');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await field.fill('4');
  const next = applyCommand(await currentProject(page), {
    type: 'speed',
    clipId: 'clip-a',
    speed: { mode: 'constant', rate: 2 },
  });
  await setProject(page, next);
  await expect(field).toHaveValue('2');
  await expect(field).toBeFocused();
  await field.press('Escape');
  await field.press('Tab');
  expect((await currentProject(page)).clips[0]?.speed).toEqual({ mode: 'constant', rate: 2 });
});

test('the adjustment list labels time/value/easing, retains reordered input focus, and rejects keyframe collisions', async ({
  page,
}) => {
  let document = await currentProject(page);
  document.adjustments[0]!.keyframes = [
    gradePoint(20, { saturation: 0.2, exposure: -0.5 }, 'hold'),
    gradePoint(70, { saturation: 0.8, exposure: 0.5 }, 'smooth'),
  ];
  document = applyCommand(document, { type: 'layer-add', layer: createLayer('upper', 'Track 2', false) });
  document = applyCommand(document, {
    type: 'insert',
    clip: { ...createClip('other-row', document.clips[1]!.mediaId, 0, 30), layerId: 'upper', start: 90 },
    index: 2,
  });
  // Another owner with a keyframe at the same frame: the clip's own grade.
  document.clips[2]!.grade.keyframes = [gradePoint(80, { saturation: 0.6 }, 'hold')];
  await setProject(page, document);
  await inspectorTab(page, 'Adjustment');
  const keys = adjustmentKeyframes(page);
  await colourStep(page, 'Next').click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  await colourStep(page, 'Next').click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(70);
  await colourStep(page, 'Previous').click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  const row = await editAdjustmentPoint(page, 20);
  await expect(keys.getByRole('list')).toHaveAccessibleName('Edit adjustment keyframes');
  await expect(row.locator('.layer-keyframe-dependencies .layer-keyframe-chip')).toHaveText(['Exposure', 'Saturation']);
  const draft = row.getByRole('spinbutton', { name: 'Saturation keyframe value 20', exact: true });
  await draft.fill('0.4');
  expect((await currentProject(page)).adjustments[0]?.keyframes[0]?.values.saturation).toBe(0.2);
  await draft.press('Enter');
  const time = row.getByRole('spinbutton', { name: 'Adjustment keyframe frame 20', exact: true });
  await time.fill('80');
  await time.press('Enter');
  const moved = keys.getByRole('spinbutton', { name: 'Adjustment keyframe frame 80', exact: true });
  await expect(moved).toBeFocused();
  expect((await currentProject(page)).adjustments[0]?.keyframes).toEqual([
    gradePoint(70, { saturation: 0.8, exposure: 0.5 }, 'smooth'),
    gradePoint(80, { saturation: 0.4, exposure: -0.5 }, 'hold'),
  ]);
  await moved.fill('70');
  await moved.press('Enter');
  await expect(moved).toBeFocused();
  await expect(moved).toHaveValue('70');
  await expect(moved).toHaveAttribute('aria-invalid', 'true');
  await expect(moved.locator('..').getByRole('alert')).toContainText('already has a keyframe');
  expect((await currentProject(page)).adjustments[0]?.keyframes.map((point) => point.frame)).toEqual([70, 80]);
  await moved.press('Escape');
  await expect(moved).toHaveValue('80');
  const remove = keys.getByRole('button', { name: 'Delete adjustment keyframe 70', exact: true });
  await remove.focus();
  await remove.press('Enter');
  expect((await currentProject(page)).adjustments[0]?.keyframes).toEqual([
    gradePoint(80, { saturation: 0.4, exposure: -0.5 }, 'hold'),
  ]);
  const value = keys.getByRole('spinbutton', { name: 'Saturation keyframe value 80', exact: true });
  await value.fill('1.9');
  // Switching to another owner never applies the stale draft.
  await page
    .locator('[data-clip-id="other-row"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await inspectorTab(page, 'Clip grade');
  const otherKeys = page.getByRole('group', { name: /^Clip keyframes / });
  const otherValue = otherKeys.getByRole('spinbutton', { name: 'Saturation keyframe value 80', exact: true });
  await expect(otherKeys.getByRole('list', { name: 'Edit clip keyframes', exact: true })).toBeVisible();
  if ((await otherKeys.locator('.layer-keyframe-point-details').getAttribute('open')) === null)
    await otherKeys.getByLabel('Edit clip keyframe 80', { exact: true }).click();
  await expect(otherValue).toHaveValue('0.6');
  expect((await currentProject(page)).adjustments[0]?.keyframes[0]?.values.saturation).toBe(0.4);
  expect((await currentProject(page)).clips[2]?.grade.keyframes[0]?.values.saturation).toBe(0.6);
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await inspectorTab(page, 'Adjustment');
  await expect(
    adjustmentKeyframes(page).getByRole('list', { name: 'Edit adjustment keyframes', exact: true }),
  ).toBeVisible();
});

test('adjustment keyframe navigation reaches its keyframes and previews one at the last frame of the adjustment', async ({
  page,
}) => {
  let document = await currentProject(page);
  document = applyCommand(document, { type: 'trim', clipId: 'clip-a', sourceIn: 30, sourceOut: 90 });
  for (const clipId of ['clip-a', 'clip-b'])
    document = applyCommand(document, { type: 'speed', clipId, speed: { mode: 'constant', rate: 2 } });
  const last = calculateLayout(document).duration - 1;
  document.adjustments = [
    adjustmentFrom0(last + 1, [
      gradePoint(5, { exposure: 0.2 }, 'hold'),
      gradePoint(35, { exposure: 0.2 }, 'smooth'),
      gradePoint(40, { exposure: 0.2 }),
      gradePoint(last, { exposure: 0.2 }, 'hold'),
    ]),
  ];
  await setProject(page, document);
  await inspectorTab(page, 'Adjustment');
  const keys = adjustmentKeyframes(page);
  for (const frame of [5, 35, 40, last]) {
    await colourStep(page, 'Next').click();
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
  }
  await expect(colourStep(page, 'Previous')).toBeEnabled();
  await colourStep(page, 'Previous').click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(40);
  await inspectorTab(page, 'Adjustment');
  const main = page.locator('.keyframe-setting-navigation').filter({
    has: page.getByRole('button', { name: 'Keyframe Exposure', exact: true }),
  });
  await expect(main.getByRole('button')).toHaveCount(3);
  const previous = main.getByRole('button', { name: 'Previous Exposure keyframe', exact: true });
  const next = main.getByRole('button', { name: 'Next Exposure keyframe', exact: true });
  await expect(previous).toHaveAttribute('title', 'Go to frame in adjustment 35.');
  await expect(next).toHaveAttribute('title', `Go to frame in adjustment ${last}.`);
  await next.focus();
  await next.press('Enter');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(last);
  await expect(next).toBeFocused();
  await expect(previous).toHaveAttribute('title', 'Go to frame in adjustment 40.');
  await previous.press('Space');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(40);
  await expect(previous).toBeFocused();
  expect(await currentProject(page)).toEqual(document);
  const row = await editAdjustmentPoint(page, 35);
  const value = row.getByRole('spinbutton', { name: 'Exposure keyframe value 35', exact: true });
  await value.fill('0.3');
  expect((await currentProject(page)).adjustments[0]?.keyframes).toEqual(document.adjustments[0]?.keyframes);
  await value.press('Enter');
  await page.evaluate(() => window.pascapLab!.engine.seek(0));
  await inspectorTab(page, 'Adjustment');
  const exposure = page.getByRole('spinbutton', { name: 'Exposure', exact: true });
  await expect(exposure).toBeDisabled();
  const diamond = page
    .getByRole('complementary', { name: 'Properties' })
    .getByRole('button', { name: 'Keyframe Exposure', exact: true });
  await expect(diamond).toBeEnabled();
  await expect(diamond).toHaveAttribute('aria-pressed', 'false');
  await diamond.click();
  await commitNumber(page, 'Exposure', '1.5');
  const points = (await currentProject(page)).adjustments[0]!.keyframes;
  expect(points.map((point) => point.frame)).toEqual([0, 5, 35, 40, last]);
  expect(points.find((point) => point.frame === 35)).toEqual(gradePoint(35, { exposure: 0.3 }, 'smooth'));
  expect(points.find((point) => point.frame === 0)).toEqual(gradePoint(0, { exposure: 1.5 }));
  expect((await currentProject(page)).clips.map((clip) => clip.speed)).toEqual(
    document.clips.map((clip) => clip.speed),
  );
  await page.getByRole('button', { name: 'Reset colour', exact: true }).click();
  expect((await currentProject(page)).adjustments[0]?.keyframes[0]).toEqual(gradePoint(0, { exposure: 0 }));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await currentProject(page)).adjustments[0]?.keyframes).toEqual(points);
  await inspectorTab(page, 'Adjustment');
  await expect(keys.getByRole('list', { name: 'Edit adjustment keyframes', exact: true })).toBeVisible();
});

test('speed numbers commit explicitly and reset to 1× changes only speed in one undo step', async ({ page }) => {
  const before = await currentProject(page);
  const rate = page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true });
  await rate.fill('0.5');
  expect((await currentProject(page)).clips[0]?.speed).toEqual({ mode: 'constant', rate: 1 });
  await rate.press('Tab');
  expect((await currentProject(page)).clips[0]?.speed).toEqual({ mode: 'constant', rate: 0.5 });
  await page.getByRole('combobox', { name: 'Speed mode', exact: true }).selectOption('curve');
  const keyRate = page.getByRole('spinbutton', { name: 'Clip speed keyframe rate', exact: true });
  await keyRate.fill('1.6');
  const flat = (await currentProject(page)).clips[0]!.speed;
  expect(flat.mode === 'curve' && flat.keyframes[0]).toEqual({ frame: 15, rate: 0.5, interpolation: 'smooth' });
  await keyRate.press('Enter');
  await page.getByRole('combobox', { name: 'Clip speed keyframe easing', exact: true }).selectOption('ease-out');
  const curve = (await currentProject(page)).clips[0]!.speed;
  expect(curve.mode).toBe('curve');
  if (curve.mode !== 'curve') throw new Error('Curve expected');
  expect(curve.keyframes[0]).toEqual({ frame: 15, rate: 1.6, interpolation: 'ease-out' });
  expect(curve.keyframes.slice(1).every((key) => key.rate === 0.5)).toBe(true);
  await page.getByRole('button', { name: 'Reset speed to 1×', exact: true }).click();
  const reset = await currentProject(page);
  expect(reset.clips[0]).toEqual({ ...before.clips[0]!, speed: { mode: 'constant', rate: 1 } });
  expect(reset.clips[1]).toEqual(before.clips[1]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await currentProject(page)).clips[0]?.speed).toEqual(curve);
});

test('music commits preserve source/timeline units and validate range, duration, gain and combined fades', async ({
  page,
  request,
}) => {
  await inspectorTab(page, 'Audio');
  const audio = (await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] };
  const asset = audio.assets.find((item) => item.status === 'ready');
  if (!asset) throw new Error('Expected prepared synthetic music.');
  await addMusicTrack(page, asset.name);
  await page.getByText('Placement & fades', { exact: true }).click();
  const out = page.getByRole('spinbutton', { name: 'Music source OUT', exact: true });
  await out.fill('90');
  await out.press('Enter');
  await expect(out.locator('..').getByRole('alert')).toContainText('enable Loop music first');
  expect((await currentProject(page)).music[0]?.clips[0]?.sourceOut).toBe(asset.metadata.frameCount);
  await out.press('Escape');
  await page.getByRole('checkbox', { name: 'Loop music', exact: true }).check();
  await commitNumber(page, 'Music source IN', '15');
  await commitNumber(page, 'Music source OUT', '90');
  await commitNumber(page, 'Music timeline start', '10');
  await commitNumber(page, 'Music duration', '140');
  const gain = page.getByRole('spinbutton', { name: 'Music gain', exact: true });
  await gain.fill('-6');
  expect((await currentProject(page)).music[0]?.gainDb).toBe(0);
  await gain.press('Tab');
  await commitNumber(page, 'Music fade in', '10');
  await commitNumber(page, 'Music fade out', '15');
  const [track] = (await currentProject(page)).music;
  expect(track).toMatchObject({ gainDb: -6, openingFade: 10, closingFade: 15 });
  expect(track?.clips[0]).toMatchObject({ sourceIn: 15, sourceOut: 90, start: 10, duration: 140, loop: true });
  const duration = page.getByRole('spinbutton', { name: 'Music duration', exact: true });
  await duration.fill('20');
  await duration.press('Enter');
  await expect(duration.locator('..').getByRole('alert')).toContainText('Enter 25 or greater');
  await duration.press('Escape');
  const fade = page.getByRole('spinbutton', { name: 'Music fade in', exact: true });
  await fade.fill('126');
  await fade.press('Enter');
  await expect(fade.locator('..').getByRole('alert')).toContainText('Enter 125 or less');
  expect((await currentProject(page)).music[0]?.openingFade).toBe(10);
});

test('per-track fade/transition timing and positioned Transform key numbers use the same explicit commits', async ({
  page,
}) => {
  await commitNumber(page, 'Opening fade', '12');
  await commitNumber(page, 'Closing fade', '9');
  const transition = page.getByRole('spinbutton', { name: 'Transition duration', exact: true });
  await transition.fill('24');
  expect((await currentProject(page)).layers[0]!.transitions[0]).toMatchObject({ duration: 18 });
  await transition.press('Enter');
  const opening = page.getByRole('spinbutton', { name: 'Opening fade', exact: true });
  await opening.fill('80');
  await opening.press('Enter');
  await expect(opening.locator('..').getByRole('alert')).toContainText('Shorten the opening fade');
  expect((await currentProject(page)).layers[0]!.openingFade).toBe(12);
  await opening.press('Escape');

  let document = await currentProject(page);
  const upper = createLayer('upper', 'Track 2', false);
  upper.transform.keyframes = [
    transformPoint(5, { opacity: 0.5 }, 'hold'),
    transformPoint(10, { opacity: 0.8 }, 'smooth'),
  ];
  document = applyCommand(document, { type: 'layer-add', layer: upper });
  document = applyCommand(document, {
    type: 'insert',
    clip: { ...createClip('overlay', document.clips[1]!.mediaId, 0, 30), layerId: 'upper', start: 5 },
    index: 2,
  });
  await setProject(page, document);
  await page.locator('[data-clip-id="overlay"] .timeline-clip-body').click();
  await inspectorTab(page, 'Clip');
  const start = page.getByRole('spinbutton', { name: 'Clip timeline start', exact: true });
  await start.fill('80');
  expect((await currentProject(page)).clips[2]?.start).toBe(5);
  await start.press('Enter');
  await editTransformKeyframe(page, 10, 'Track 2');
  await commitNumber(page, 'Opacity keyframe value 10', '60');
  await commitNumber(page, 'Transform keyframe frame 10', '25');
  const edited = await currentProject(page);
  expect(edited.clips[2]).toMatchObject({ start: 80, sourceIn: 0, sourceOut: 30 });
  expect(edited.clips[2]).not.toHaveProperty('opacity');
  expect(edited.layers[1]!.transform.base.opacity).toBe(1);
  expect(edited.clips[2]).not.toHaveProperty('animation');
  expect(edited.layers[1]!.transform.keyframes).toEqual([
    transformPoint(5, { opacity: 0.5 }, 'hold'),
    transformPoint(25, { opacity: 0.6 }, 'smooth'),
  ]);
});

test('Colour resets target the adjustment colour or only participating settings at the active keyframe', async ({
  page,
}) => {
  await inspectorTab(page, 'Adjustment');
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.7');
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('1.3');
  await resetSetting(page, 'Exposure');
  let document = await currentProject(page);
  expect(document.adjustments[0]?.colour).toMatchObject({ exposure: 0, saturation: 1.3 });
  expect(document.adjustments[0]?.keyframes).toEqual([]);
  await page.getByRole('slider', { name: 'Contrast', exact: true }).fill('1.2');
  document = await currentProject(page);
  const base = { ...document.adjustments[0]!.colour };
  const other = gradePoint(110, { exposure: 1, saturation: 1.4 }, 'smooth');
  document.adjustments[0]!.keyframes = [gradePoint(5, { exposure: -0.5, saturation: 0.6 }, 'hold'), other];
  await setProject(page, document);
  const keys = adjustmentKeyframes(page);
  await editAdjustmentPoint(page, 5);
  await keys.getByRole('button', { name: 'Go to adjustment keyframe 5', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('-0.5');
  await resetSetting(page, 'Exposure');
  document = await currentProject(page);
  expect(document.adjustments[0]?.keyframes[0]).toEqual(gradePoint(5, { exposure: 0, saturation: 0.6 }, 'hold'));
  expect(document.adjustments[0]?.keyframes[1]).toEqual(other);
  await commitNumber(page, 'Adjustment keyframe frame 5', '8');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(keys.locator('[data-keyframe-frame="5"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(keys.locator('[data-keyframe-frame="8"]')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeDisabled();
  await keys.getByRole('button', { name: 'Go to adjustment keyframe 8', exact: true }).click();
  await resetSetting(page, 'Saturation');
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.25');
  document = await currentProject(page);
  expect(document.adjustments[0]?.colour).toEqual(base);
  expect(document.adjustments[0]?.keyframes).toEqual([gradePoint(8, { exposure: 0.25, saturation: 1 }, 'hold'), other]);
  await page.getByRole('button', { name: 'Reset colour', exact: true }).click();
  const reset = await currentProject(page);
  expect(reset.adjustments[0]?.colour).toEqual(base);
  expect(reset.adjustments[0]?.keyframes).toEqual([
    gradePoint(8, { exposure: NEUTRAL_COLOUR.exposure, saturation: NEUTRAL_COLOUR.saturation }, 'hold'),
    other,
  ]);
  await expect(page.getByRole('slider', { name: 'Contrast', exact: true })).toHaveValue('1.2');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await currentProject(page)).adjustments[0]?.keyframes).toEqual(document.adjustments[0]?.keyframes);
});
