import { expect, test, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  editLayerPoint,
  expandedInspectorPreferences,
  inspectorTab,
  layerKeyframes,
  sharedPoint,
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

  // Exercise real editor history/autosave without writing even the fixture's project store.
  await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto('/?project=preview-lab');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

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
  if (name.includes('keyframe')) await inspectorTab(page, 'Layer keyframes');
  else if (name.startsWith('Music')) await inspectorTab(page, 'Audio');
  else if (/Opening|Closing|Transition/.test(name)) await inspectorTab(page, 'Sequence');
  else await inspectorTab(page, 'Clip');
  const field = page.getByRole('spinbutton', { name, exact: true });
  await field.fill(value);
  await field.press('Enter');
}

test('Enter and blur each commit once, while Escape and unchanged drafts do not create undo steps', async ({
  page,
}) => {
  const field = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await field.fill('25');
  expect((await currentProject(page)).clips[0]?.sourceIn).toBe(15);
  await field.press('Enter');
  await expect(field).toBeFocused();
  expect((await currentProject(page)).clips[0]?.sourceIn).toBe(25);
  await field.press('Enter');
  await field.press('Tab');
  await undo.click();
  await expect(field).toHaveValue('15');
  await expect(undo).toBeDisabled();

  await field.fill('30');
  await field.press('Tab');
  expect((await currentProject(page)).clips[0]?.sourceIn).toBe(30);
  await undo.click();
  await expect(undo).toBeDisabled();
  await field.fill('42');
  await field.press('Escape');
  await expect(field).toHaveValue('15');
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
  const field = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  for (const draft of ['', '15.5', '-1', '999']) {
    await field.fill(draft);
    await field.press('Enter');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveValue(draft);
    const error = field.locator('..').getByRole('alert');
    await expect(error).toContainText('Escape to restore 15');
    expect(await field.getAttribute('aria-errormessage')).toBe(await error.getAttribute('id'));
    expect((await currentProject(page)).clips[0]?.sourceIn).toBe(15);
    await field.press('Escape');
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await expect(field).toHaveValue('15');
  }
  const out = page.getByRole('spinbutton', { name: 'Source OUT frame', exact: true });
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

test('the shared list labels time/value/easing, retains reordered input focus, and rejects point collisions', async ({
  page,
}) => {
  let document = await currentProject(page);
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[0]!,
      keyframes: [
        sharedPoint(20, { clipOpacity: 0.2, exposure: -0.5 }, 'hold'),
        sharedPoint(70, { clipOpacity: 0.8, exposure: 0.5 }, 'smooth'),
      ],
    },
  });
  document = applyCommand(document, {
    type: 'layer-add',
    layer: { ...createLayer('upper', 'Video 2', false), keyframes: [sharedPoint(80, { clipOpacity: 0.4 }, 'hold')] },
  });
  document = applyCommand(document, {
    type: 'insert',
    clip: { ...createClip('other-row', document.clips[1]!.mediaId, 0, 30), layerId: 'upper', start: 90 },
    index: 2,
  });
  await setProject(page, document);
  await inspectorTab(page, 'Layer keyframes');
  const keys = layerKeyframes(page, 'Video 1');
  await keys.getByRole('button', { name: 'Next layer keyframe', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  await keys.getByRole('button', { name: 'Next layer keyframe', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(70);
  await keys.getByRole('button', { name: 'Previous layer keyframe', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  const row = await editLayerPoint(page, 'Video 1', 20);
  await expect(keys.getByRole('list')).toHaveAccessibleName('Edit layer keys');
  await expect(row.locator('.layer-keyframe-dependencies')).toHaveText('Clip opacity · Exposure');
  const draft = row.getByRole('spinbutton', { name: 'Clip opacity keyframe value 20', exact: true });
  await draft.fill('0.4');
  expect((await currentProject(page)).layers[0]?.keyframes[0]?.values.clipOpacity).toBe(0.2);
  await draft.press('Enter');
  const time = row.getByRole('spinbutton', { name: 'Layer keyframe frame 20', exact: true });
  await time.fill('80');
  await time.press('Enter');
  const moved = keys.getByRole('spinbutton', { name: 'Layer keyframe frame 80', exact: true });
  await expect(moved).toBeFocused();
  expect((await currentProject(page)).layers[0]?.keyframes).toEqual([
    sharedPoint(70, { clipOpacity: 0.8, exposure: 0.5 }, 'smooth'),
    sharedPoint(80, { clipOpacity: 0.4, exposure: -0.5 }, 'hold'),
  ]);
  await moved.fill('70');
  await moved.press('Enter');
  await expect(moved).toBeFocused();
  await expect(moved).toHaveValue('70');
  await expect(moved).toHaveAttribute('aria-invalid', 'true');
  await expect(moved.locator('..').getByRole('alert')).toContainText('already has a shared point');
  expect((await currentProject(page)).layers[0]?.keyframes.map((point) => point.frame)).toEqual([70, 80]);
  await moved.press('Escape');
  await expect(moved).toHaveValue('80');
  const remove = keys.getByRole('button', { name: 'Delete layer keyframe 70', exact: true });
  await remove.focus();
  await remove.press('Enter');
  expect((await currentProject(page)).layers[0]?.keyframes).toEqual([
    sharedPoint(80, { clipOpacity: 0.4, exposure: -0.5 }, 'hold'),
  ]);
  const value = keys.getByRole('spinbutton', { name: 'Clip opacity keyframe value 80', exact: true });
  await value.fill('0.9');
  await page
    .locator('[data-clip-id="other-row"] .timeline-clip-body')
    .evaluate((button) => (button as HTMLButtonElement).click());
  const otherKeys = layerKeyframes(page, 'Video 2');
  const otherValue = otherKeys.getByRole('spinbutton', { name: 'Clip opacity keyframe value 80', exact: true });
  await expect(otherKeys.getByRole('list', { name: 'Edit layer keys', exact: true })).toBeVisible();
  await expect(otherValue).toHaveValue('0.4');
  await expect(otherValue).toBeFocused();
  expect((await currentProject(page)).layers[0]?.keyframes[0]?.values.clipOpacity).toBe(0.4);
  expect((await currentProject(page)).layers[1]?.keyframes[0]?.values.clipOpacity).toBe(0.4);
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await inspectorTab(page, 'Layer keyframes');
  await expect(
    layerKeyframes(page, 'Video 1').getByRole('list', { name: 'Edit layer keys', exact: true }),
  ).toBeVisible();
});

test('row-speed navigation reaches project points and previews outside-duration points at the nearest frame', async ({
  page,
}) => {
  let document = await currentProject(page);
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[0]!,
      keyframes: [
        sharedPoint(5, { speed: 2 }, 'hold'),
        sharedPoint(35, { speed: 2 }, 'smooth'),
        sharedPoint(40, { speed: 2 }),
        sharedPoint(110, { speed: 2 }, 'hold'),
      ],
    },
  });
  document = applyCommand(document, { type: 'trim', clipId: 'clip-a', sourceIn: 30, sourceOut: 90 });
  await setProject(page, document);
  expect(document.layers[0]?.keyframes.map((point) => point.frame)).toEqual([5, 35, 40, 110]);
  await inspectorTab(page, 'Layer keyframes');
  const keys = layerKeyframes(page, 'Video 1');
  for (const frame of [5, 35, 40, calculateLayout(document).duration - 1]) {
    await keys.getByRole('button', { name: 'Next layer keyframe', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
  }
  await expect(keys.getByRole('button', { name: 'Next layer keyframe', exact: true })).toBeDisabled();
  await expect(keys.getByRole('button', { name: 'Previous layer keyframe', exact: true })).toBeEnabled();
  await expect(keys.locator('.layer-keyframe-inspected')).toContainText(
    'Stored point · timeline frame 110 · outside current duration',
  );
  const outside = await editLayerPoint(page, 'Video 1', 110);
  await expect(outside.locator('.keyframe-row-skipped')).toHaveText('Outside duration');
  await expect(outside.getByRole('button', { name: 'Go to layer keyframe 110', exact: true })).toHaveAttribute(
    'title',
    `Stored timeline frame 110; preview the nearest available frame ${calculateLayout(document).duration - 1}. The point stays in place.`,
  );
  await expect(keys.locator('.keyframe-row-skipped')).toHaveCount(1);
  await keys.getByRole('button', { name: 'Previous layer keyframe', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(40);
  const row = await editLayerPoint(page, 'Video 1', 35);
  const value = row.getByRole('spinbutton', { name: 'Speed keyframe value 35', exact: true });
  await value.fill('3');
  expect((await currentProject(page)).layers[0]?.keyframes).toEqual(document.layers[0]?.keyframes);
  await value.press('Enter');
  await page.evaluate(() => window.pascapLab!.engine.seek(0));
  await inspectorTab(page, 'Clip');
  const rate = page.getByRole('spinbutton', { name: 'Layer speed rate', exact: true });
  await expect(rate).toBeDisabled();
  const diamond = page
    .getByRole('complementary', { name: 'Clip inspector' })
    .getByRole('button', { name: 'Keyframe Speed', exact: true });
  await expect(diamond).toBeEnabled();
  await expect(diamond).toHaveAttribute('aria-pressed', 'false');
  await diamond.click();
  await commitNumber(page, 'Layer speed rate', '1.5');
  const points = (await currentProject(page)).layers[0]!.keyframes;
  expect(points.map((point) => point.frame)).toEqual([0, 5, 35, 40, 110]);
  expect(points.find((point) => point.frame === 35)).toEqual(sharedPoint(35, { speed: 3 }, 'smooth'));
  expect(points.find((point) => point.frame === 0)).toEqual(sharedPoint(0, { speed: 1.5 }));
  expect((await currentProject(page)).clips.map((clip) => clip.speed)).toEqual(
    document.clips.map((clip) => clip.speed),
  );
  await page.getByRole('button', { name: 'Reset speed to 1×', exact: true }).click();
  expect((await currentProject(page)).layers[0]?.keyframes[0]).toEqual(sharedPoint(0, { speed: 1 }));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await currentProject(page)).layers[0]?.keyframes).toEqual(points);
  await inspectorTab(page, 'Layer keyframes');
  await expect(keys.getByRole('list', { name: 'Edit layer keys', exact: true })).toBeVisible();
});

test('speed/ramp numbers commit explicitly and reset to 1× changes only speed in one undo step', async ({ page }) => {
  const before = await currentProject(page);
  const rate = page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true });
  await rate.fill('0.5');
  expect((await currentProject(page)).clips[0]?.speed).toEqual({ mode: 'constant', rate: 1 });
  await rate.press('Tab');
  expect((await currentProject(page)).clips[0]?.speed).toEqual({ mode: 'constant', rate: 0.5 });
  await page.getByRole('combobox', { name: 'Speed mode', exact: true }).selectOption('ramp-up');
  await commitNumber(page, 'Ramp start rate', '0.7');
  await commitNumber(page, 'Ramp end rate', '1.6');
  await page.getByRole('combobox', { name: 'Ramp curve', exact: true }).selectOption('ease-out');
  const ramp = (await currentProject(page)).clips[0]!.speed;
  expect(ramp).toEqual({ mode: 'ramp', startRate: 0.7, endRate: 1.6, curve: 'ease-out', anchorIn: 15, anchorOut: 105 });
  await page.getByRole('button', { name: 'Reset speed to 1×', exact: true }).click();
  const reset = await currentProject(page);
  expect(reset.clips[0]).toEqual({ ...before.clips[0]!, speed: { mode: 'constant', rate: 1 } });
  expect(reset.clips[1]).toEqual(before.clips[1]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await currentProject(page)).clips[0]?.speed).toEqual(ramp);
});

test('music commits preserve source/timeline units and validate range, duration, gain and combined fades', async ({
  page,
  request,
}) => {
  await inspectorTab(page, 'Audio');
  const audio = (await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] };
  const asset = audio.assets.find((item) => item.status === 'ready');
  if (!asset) throw new Error('Expected prepared synthetic music.');
  await page.getByRole('combobox', { name: 'Music recording', exact: true }).selectOption(asset.id);
  await page.getByText('Placement & fades', { exact: true }).click();
  const out = page.getByRole('spinbutton', { name: 'Music source OUT', exact: true });
  await out.fill('90');
  await out.press('Enter');
  await expect(out.locator('..').getByRole('alert')).toContainText('enable Loop music first');
  expect((await currentProject(page)).music?.sourceOut).toBe(asset.metadata.frameCount);
  await out.press('Escape');
  await page.getByRole('checkbox', { name: 'Loop music', exact: true }).check();
  await commitNumber(page, 'Music source IN', '15');
  await commitNumber(page, 'Music source OUT', '90');
  await commitNumber(page, 'Music timeline start', '10');
  await commitNumber(page, 'Music duration', '140');
  const gain = page.getByRole('spinbutton', { name: 'Music gain', exact: true });
  await gain.fill('-6');
  expect((await currentProject(page)).music?.gainDb).toBe(0);
  await gain.press('Tab');
  await commitNumber(page, 'Music fade in', '10');
  await commitNumber(page, 'Music fade out', '15');
  expect((await currentProject(page)).music).toMatchObject({
    sourceIn: 15,
    sourceOut: 90,
    start: 10,
    duration: 140,
    gainDb: -6,
    fadeIn: 10,
    fadeOut: 15,
    loop: true,
  });
  const duration = page.getByRole('spinbutton', { name: 'Music duration', exact: true });
  await duration.fill('20');
  await duration.press('Enter');
  await expect(duration.locator('..').getByRole('alert')).toContainText('Enter 25 or greater');
  await duration.press('Escape');
  const fade = page.getByRole('spinbutton', { name: 'Music fade in', exact: true });
  await fade.fill('126');
  await fade.press('Enter');
  await expect(fade.locator('..').getByRole('alert')).toContainText('Enter 125 or less');
  expect((await currentProject(page)).music?.fadeIn).toBe(10);
});

test('per-track fade/transition timing and positioned track key numbers use the same explicit commits', async ({
  page,
}) => {
  await commitNumber(page, 'Opening fade', '12');
  await commitNumber(page, 'Closing fade', '9');
  const transition = page.getByRole('spinbutton', { name: 'Transition duration', exact: true });
  await transition.fill('24');
  expect((await currentProject(page)).layers[0]!.transitions[0]?.duration).toBe(18);
  await transition.press('Enter');
  const opening = page.getByRole('spinbutton', { name: 'Opening fade', exact: true });
  await opening.fill('80');
  await opening.press('Enter');
  await expect(opening.locator('..').getByRole('alert')).toContainText('Shorten the opening fade');
  expect((await currentProject(page)).layers[0]!.openingFade).toBe(12);
  await opening.press('Escape');

  let document = await currentProject(page);
  document = applyCommand(document, {
    type: 'layer-add',
    layer: {
      ...createLayer('upper', 'Video 2', false),
      keyframes: [sharedPoint(5, { clipOpacity: 0.5 }, 'hold'), sharedPoint(10, { layerOpacity: 0.8 }, 'smooth')],
    },
  });
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
  await editLayerPoint(page, 'Video 2', 10);
  await commitNumber(page, 'Layer opacity keyframe value 10', '0.6');
  await commitNumber(page, 'Layer keyframe frame 10', '25');
  const edited = await currentProject(page);
  expect(edited.clips[2]).toMatchObject({ start: 80, sourceIn: 0, sourceOut: 30, opacity: 1 });
  expect(edited.clips[2]).not.toHaveProperty('animation');
  expect(edited.layers[1]?.keyframes).toEqual([
    sharedPoint(5, { clipOpacity: 0.5 }, 'hold'),
    sharedPoint(25, { layerOpacity: 0.6 }, 'smooth'),
  ]);
});

test('colour resets target the static base or only participating colours at the active project point', async ({
  page,
}) => {
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.7');
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('1.3');
  await page.getByRole('button', { name: 'Reset Exposure', exact: true }).click();
  let document = await currentProject(page);
  expect(document.clips[0]?.colour).toMatchObject({ exposure: 0, saturation: 1.3 });
  expect(document.layers[0]?.keyframes).toEqual([]);
  await page.getByRole('slider', { name: 'Contrast', exact: true }).fill('1.2');
  document = await currentProject(page);
  const base = { ...document.clips[0]!.colour };
  const other = sharedPoint(110, { exposure: 1, saturation: 1.4 }, 'smooth');
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[0]!,
      keyframes: [sharedPoint(5, { exposure: -0.5, saturation: 0.6, clipOpacity: 0.4 }, 'hold'), other],
    },
  });
  await setProject(page, document);
  const keys = layerKeyframes(page, 'Video 1');
  await editLayerPoint(page, 'Video 1', 5);
  await keys.getByRole('button', { name: 'Go to layer keyframe 5', exact: true }).click();
  await inspectorTab(page, 'Clip');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('-0.5');
  await page.getByRole('button', { name: 'Reset Exposure', exact: true }).click();
  document = await currentProject(page);
  expect(document.layers[0]?.keyframes[0]).toEqual(
    sharedPoint(5, { exposure: 0, saturation: 0.6, clipOpacity: 0.4 }, 'hold'),
  );
  expect(document.layers[0]?.keyframes[1]).toEqual(other);
  await commitNumber(page, 'Layer keyframe frame 5', '8');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(keys.locator('[data-keyframe-frame="5"]')).toHaveAttribute('aria-current', 'true');
  await inspectorTab(page, 'Clip');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await inspectorTab(page, 'Layer keyframes');
  await expect(keys.locator('[data-keyframe-frame="8"]')).toBeVisible();
  await inspectorTab(page, 'Clip');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeDisabled();
  await inspectorTab(page, 'Layer keyframes');
  await keys.getByRole('button', { name: 'Go to layer keyframe 8', exact: true }).click();
  await inspectorTab(page, 'Clip');
  await page.getByRole('button', { name: 'Reset Saturation', exact: true }).click();
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.25');
  document = await currentProject(page);
  expect(document.clips[0]?.colour).toEqual(base);
  expect(document.layers[0]?.keyframes).toEqual([
    sharedPoint(8, { exposure: 0.25, saturation: 1, clipOpacity: 0.4 }, 'hold'),
    other,
  ]);
  await page.getByRole('button', { name: 'Reset colour', exact: true }).click();
  const reset = await currentProject(page);
  expect(reset.clips[0]?.colour).toEqual(base);
  expect(reset.layers[0]?.keyframes).toEqual([
    sharedPoint(
      8,
      { exposure: NEUTRAL_COLOUR.exposure, saturation: NEUTRAL_COLOUR.saturation, clipOpacity: 0.4 },
      'hold',
    ),
    other,
  ]);
  await expect(page.getByRole('slider', { name: 'Contrast', exact: true })).toHaveValue('1.2');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await currentProject(page)).layers[0]?.keyframes).toEqual(document.layers[0]?.keyframes);
});
