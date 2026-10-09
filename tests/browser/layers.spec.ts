import { expect, test, type Page } from '@playwright/test';
import type { ExportReceipt } from '../../src/server/export.js';
import { applyCommand } from '../../src/shared/commands.js';
import { createClip, createLayer, createProject, projectSchema } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import {
  closeOptions,
  editLayerPoint,
  expandedInspectorPreferences,
  freshExportLinks,
  inspectorTab,
  layerKeyframes,
  openOptions,
  sharedPoint,
  submitExport,
} from './editor-helpers.js';
import { memoryProjects } from './memory-projects.js';

test.beforeEach(async ({ page, request }) => {
  await expandedInspectorPreferences(page);
  const library = (await (await request.get('/api/media')).json()) as { assets: { id: string; name: string }[] };
  let project = createProject('preview-lab', 'Layered editor · memory-only');
  project.media.videoIds = library.assets.map((asset) => asset.id);
  project = applyCommand(project, {
    type: 'insert',
    clip: createClip('bottom', library.assets.find((asset) => asset.name === 'pattern-a.mp4')!.id, 0, 60),
    index: 0,
  });
  await memoryProjects(page, project);
  await page.goto('/?project=preview-lab');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
}
async function addOverlay(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Add video track', exact: true }).click();
  // Placement/trim regressions deliberately use a positioned track, not the new default.
  await openOptions(page, 'Track options Video track 2');
  const ripple = page.getByRole('checkbox', { name: 'Ripple on track Video track 2', exact: true });
  await expect(ripple).toBeChecked();
  await ripple.uncheck();
  await closeOptions(page);
  await page.getByRole('button', { name: 'Add pattern-b.mp4 to timeline', exact: true }).click();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  return page.evaluate(() => window.pascapLab!.project()!.clips.at(-1)!.id);
}
async function sourceAtPointer(page: Page, name: string, ratio: number): Promise<number> {
  const button = page.getByRole('button', { name: `Review ${name}`, exact: true });
  await button.scrollIntoViewIfNeeded();
  const bounds = (await button.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * ratio, bounds.y + bounds.height / 2);
  const expected = Math.round(ratio * 119);
  await expect
    .poll(async () => Number(await page.locator('.source-preview').getAttribute('data-source-frame')))
    .toBe(expected);
  return expected;
}

test('numeric GPU compositing matches source-over opacity and keyed group semantics', async ({ page }) => {
  const comparison = await page.evaluate(() => window.pascapLab!.verifyComposition());
  expect(comparison.cases).toBe(32);
  expect(comparison.meanAbsoluteError8Bit).toBeLessThan(0.6);
  expect(comparison.maxError8Bit).toBeLessThan(2);
});

test('adds layered clips, adjusts row opacity, hides/shows and releases unused decoders on undo/delete', async ({
  page,
}) => {
  await seek(page, 0);
  const topId = await addOverlay(page);
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.layers).toHaveLength(2);
  expect(project.clips[1]).toMatchObject({ layerId: project.layers[1]!.id, start: 0, sourceIn: 0, sourceOut: 120 });
  await expect(page.locator('.timeline-clip')).toHaveCount(2);
  await openOptions(page, 'Track options Video track 2');
  await expect(page.getByRole('slider', { name: 'Opacity of track Video track 2', exact: true })).toHaveCount(0);
  await closeOptions(page);
  await inspectorTab(page, 'Track');
  await page.getByRole('slider', { name: 'Opacity', exact: true }).fill('50');
  await seek(page, 30);
  const half = await page.evaluate(() => Array.from(window.pascapLab!.engine.capturePixels().slice(100_000, 100_012)));
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(sampleTimeline(project, 30).map((layer) => layer.opacity)).toEqual([1, 0.5]);
  expect(project.layers[1]!.opacity).toBe(0.5);
  expect(project.layers[0]!.opacity).toBe(1);
  expect(project.clips.every((clip) => !('opacity' in clip))).toBe(true);
  await page.getByRole('button', { name: 'Hide track Video track 2', exact: true }).click();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  const hidden = await page.evaluate(() =>
    Array.from(window.pascapLab!.engine.capturePixels().slice(100_000, 100_012)),
  );
  expect(hidden).not.toEqual(half);
  await page.getByRole('button', { name: 'Show track Video track 2', exact: true }).click();
  await inspectorTab(page, 'Clip');
  await page.getByRole('spinbutton', { name: 'Clip timeline start', exact: true }).fill('90');
  await page.getByRole('spinbutton', { name: 'Clip timeline start', exact: true }).press('Enter');
  await seek(page, 70);
  const black = await page.evaluate(() => {
    const pixels = window.pascapLab!.engine.capturePixels();
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4)
      sum += pixels[index]! + pixels[index + 1]! + pixels[index + 2]!;
    return sum;
  });
  expect(black).toBe(0);
  await seek(page, 100);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().assignedClipIds)).toContain(topId);
  await openOptions(page, 'Track options Video track 2');
  await page.getByRole('button', { name: 'Delete track Video track 2', exact: true }).click();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().decoderCount === 2);
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers.length)).toBe(2);
});

test('reorders independently positioned video tracks without altering source ranges', async ({ page }) => {
  await addOverlay(page);
  await page.getByRole('button', { name: 'Add video track', exact: true }).click();
  await openOptions(page, 'Track options Video track 3');
  await page.getByRole('checkbox', { name: 'Ripple on track Video track 3', exact: true }).uncheck();
  await closeOptions(page);
  await page.getByRole('button', { name: 'Add recording-03.mp4 to timeline', exact: true }).click();
  const before = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  await openOptions(page, 'Track options Video track 3');
  await page.getByRole('button', { name: 'Lower track Video track 3', exact: true }).click();
  await closeOptions(page);
  const after = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(after.layers.map((layer) => layer.name)).toEqual(['Video track 1', 'Video track 3', 'Video track 2']);
  expect(after.clips).toEqual(before.clips);
  await openOptions(page, 'Track options Video track 2');
  await page.getByRole('button', { name: 'Delete track Video track 2', exact: true }).click();
  await page.getByRole('button', { name: 'Add video track', exact: true }).click();
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers.map((layer) => layer.name))).toEqual([
    'Video track 1',
    'Video track 3',
    'Video track 2',
  ]);
});

test('shares row opacity and individual colour channels at project points and keeps their anchors through trim/reload', async ({
  page,
}) => {
  const id = await addOverlay(page);
  await seek(page, 0);
  const inspector = page.getByRole('complementary', { name: 'Clip inspector' });
  await inspectorTab(page, 'Track');
  await page.getByRole('slider', { name: 'Opacity', exact: true }).fill('0');
  await inspector.getByRole('button', { name: 'Keyframe Opacity', exact: true }).click();
  await seek(page, 60);
  await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toBeDisabled();
  await inspector.getByRole('button', { name: 'Keyframe Opacity', exact: true }).click();
  await page.getByRole('slider', { name: 'Opacity', exact: true }).fill('100');
  await inspector.getByRole('button', { name: 'Keyframe Exposure', exact: true }).click();
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('1');
  await seek(page, 0);
  await inspector.getByRole('button', { name: 'Keyframe Exposure', exact: true }).click();
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('-1');
  await expect(inspector.getByRole('button', { name: 'Keyframe Track opacity', exact: true })).toHaveCount(0);
  await seek(page, 30);
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  const sample = sampleTimeline(project, 30).find((layer) => layer.clipId === id)!;
  expect(sample.opacity).toBeCloseTo(0.5);
  expect(sample.colour.exposure).toBeCloseTo(0);
  const points = [sharedPoint(0, { opacity: 0, exposure: -1 }), sharedPoint(60, { opacity: 1, exposure: 1 })];
  expect(project.layers[1]?.keyframes).toEqual(points);
  expect(project.clips[1]).not.toHaveProperty('correction');
  expect(project.layers[1]!.colour.exposure).toBe(0);
  expect(project.clips[1]).not.toHaveProperty('opacity');
  expect(project.layers[1]!.opacity).toBe(0);
  await expect(page.getByRole('checkbox', { name: 'Animate colour adjustments', exact: true })).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await page.getByRole('textbox', { name: 'Source IN frame', exact: true }).fill('15');
  await page.getByRole('textbox', { name: 'Source IN frame', exact: true }).press('Enter');
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.layers[1]?.keyframes).toEqual(points);
  expect(project.clips.find((clip) => clip.id === id)).not.toHaveProperty('animation');
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.layers[1]?.keyframes).toEqual(points);
  expect(project.layers[0]?.keyframes).toEqual([]);
});

test('clip speed keys support easing, removal and their own duration while shared points stay put', async ({
  page,
}) => {
  await expect(
    page.getByRole('combobox', { name: 'Speed mode', exact: true }).locator('option[value="keyframes"]'),
  ).toHaveCount(0);
  const inspector = page.getByRole('complementary', { name: 'Clip inspector' });
  const diamond = inspector.getByRole('button', { name: 'Keyframe Speed', exact: true });
  const speedOf = async () =>
    projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).clips[0]!.speed;
  const duration = async () =>
    calculateLayout(projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()))).duration;
  await seek(page, 0);
  await inspectorTab(page, 'Track');
  await inspector.getByRole('button', { name: 'Keyframe Exposure', exact: true }).click();
  await inspectorTab(page, 'Clip');
  await diamond.click();
  const rate = page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true });
  await rate.fill('0.5');
  await rate.press('Enter');
  await seek(page, 30);
  await expect(rate).toBeDisabled();
  await diamond.click();
  await rate.fill('2');
  await rate.press('Enter');
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.layers[0]?.keyframes).toEqual([sharedPoint(0, { exposure: 0 })]);
  expect(project.clips[0]?.speed).toEqual({
    mode: 'curve',
    keyframes: [
      { frame: 0, rate: 0.5, interpolation: 'linear' },
      { frame: 15, rate: 2, interpolation: 'linear' },
    ],
  });
  // 15 × ln(4) / 1.5 ≈ 13.86 output frames to source 15, then 45 source frames at 2×.
  expect(calculateLayout(project).duration).toBe(36);
  await page
    .getByRole('combobox', { name: 'Selected clip speed keyframe', exact: true })
    .selectOption({ label: 'Keyframe 1 · source 0' });
  await page.getByRole('combobox', { name: 'Clip speed keyframe easing', exact: true }).selectOption('smooth');
  const smooth = await speedOf();
  expect(smooth.mode === 'curve' && smooth.keyframes[0]!.interpolation).toBe('smooth');
  expect(await duration()).toBe(37);
  await seek(page, 0);
  await expect(diamond).toHaveAttribute('aria-pressed', 'true');
  await diamond.click();
  expect(await speedOf()).toEqual({ mode: 'curve', keyframes: [{ frame: 15, rate: 2, interpolation: 'linear' }] });
  expect(await duration()).toBe(30);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await speedOf()).toEqual(smooth);
  await seek(page, 20);
  await inspectorTab(page, 'Track');
  await inspector.getByRole('button', { name: 'Keyframe Opacity', exact: true }).click();
  const state = await page.evaluate(() => {
    window.pascapLab!.engine.capturePixels();
    return window.pascapLab!.engine.diagnostics();
  });
  expect(state.status, state.message).toBe('paused');
  await inspectorTab(page, 'Clip');
  await page
    .getByRole('combobox', { name: 'Selected clip speed keyframe', exact: true })
    .selectOption({ label: 'Keyframe 2 · source 15' });
  await page.getByRole('button', { name: 'Delete clip speed keyframe', exact: true }).click();
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.layers[0]?.keyframes).toEqual([sharedPoint(0, { exposure: 0 }), sharedPoint(20, { opacity: 1 })]);
  expect(project.clips[0]?.speed).toEqual({
    mode: 'curve',
    keyframes: [{ frame: 0, rate: 0.5, interpolation: 'smooth' }],
  });
  expect(calculateLayout(project).duration).toBe(120);
  expect(calculateLayout(project).clips[0]?.retiming.sourceAt(40)).toBe(20);
});

test('collapses/expands Inspector sections and remembers the choice across reloads', async ({ page }) => {
  await inspectorTab(page, 'Track');
  const summary = page.getByLabel('Colour section', { exact: true });
  await summary.click();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await inspectorTab(page, 'Track');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeHidden();
  await page.getByLabel('Colour section', { exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeVisible();
  await inspectorTab(page, 'Clip');
  await page.getByLabel('Speed section', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Speed mode', exact: true })).toBeHidden();
});

test('hover scrubs a single muted source decoder while the project playhead stays unchanged', async ({ page }) => {
  await seek(page, 20);
  await sourceAtPointer(page, 'pattern-a.mp4', 0.25);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(20);
  await sourceAtPointer(page, 'pattern-a.mp4', 0.9);
  await sourceAtPointer(page, 'pattern-a.mp4', 0.1);
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(1);
  const mediaId = await page
    .getByRole('article')
    .filter({ has: page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true }) })
    .getAttribute('data-media-id');
  await sourceAtPointer(page, 'pattern-b.mp4', 0.5);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-media-id', mediaId!);
  expect(
    await page
      .locator('video[data-source-decoder]')
      .evaluate((video) => (video as HTMLVideoElement).muted && (video as HTMLVideoElement).paused),
  ).toBe(true);
  await page.getByRole('button', { name: 'Close source review' }).click();
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(0);
});

test('pre-trims media and carries the recoverable range into plus, reload and drag insertion', async ({ page }) => {
  let keyed = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  const anchors = [sharedPoint(10, { exposure: -0.2 }), sharedPoint(90, { exposure: 0.2 }, 'smooth')];
  keyed = applyCommand(keyed, { type: 'layer-update', layer: { ...keyed.layers[0]!, keyframes: anchors } });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), keyed);
  await sourceAtPointer(page, 'pattern-b.mp4', 0.4);
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('20');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('95');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).press('Enter');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips.length)).toBe(1);
  expect(projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).layers[0]?.keyframes).toEqual(
    anchors,
  );
  await page.getByRole('button', { name: 'Add pattern-b.mp4 to timeline', exact: true }).click();
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips.at(-1)).toMatchObject({ sourceIn: 20, sourceOut: 95 });
  expect(project.layers[0]?.keyframes).toEqual(anchors);
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).layers[0]?.keyframes).toEqual(
    anchors,
  );
  await sourceAtPointer(page, 'pattern-b.mp4', 0.4);
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue('20');
  const source = page
    .getByRole('article')
    .filter({ has: page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true }) });
  const surface = page.locator('.timeline-surface');
  const leading = Number(await surface.getAttribute('data-leading'));
  const scale = Number(await surface.getAttribute('data-pixels-per-frame'));
  await source.dragTo(surface, { targetPosition: { x: leading + 40 * scale, y: 95 } });
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips).toHaveLength(3);
  expect(project.clips.filter((clip) => clip.sourceIn === 20 && clip.sourceOut === 95)).toHaveLength(2);
  expect(project.layers[0]?.keyframes).toEqual(anchors);
  await page.getByRole('tab', { name: 'Source preview', exact: true }).click();
  await page.getByRole('button', { name: 'Close source review' }).click();
  await page.getByRole('button', { name: /Select pattern-b.mp4, clip 2/ }).click();
  await page.getByRole('button', { name: 'Restore full recording' }).click();
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[1]!.sourceOut)).toBe(120);
  expect(projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).layers[0]?.keyframes).toEqual(
    anchors,
  );
});

test('source handle drafts cancel cleanly and I/O marks remain independent of timeline edits', async ({ page }) => {
  await sourceAtPointer(page, 'pattern-a.mp4', 0.2);
  await page.getByRole('button', { name: 'Review source frame of pattern-a.mp4', exact: true }).press('i');
  const marked = Number(await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).inputValue());
  expect(marked).toBe(24);
  const handle = page.getByRole('slider', { name: 'Trim source start', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 45, box.y + 10, { steps: 4 });
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-range-draft', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue(String(marked));
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[0]!.sourceIn)).toBe(0);
  await handle.press('Home');
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue('0');
});

test('layered native UI export includes keyed opacity and colour in an immutable verified receipt', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await addOverlay(page);
  let document = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  for (const clip of document.clips)
    document = applyCommand(document, { type: 'trim', clipId: clip.id, sourceIn: 0, sourceOut: 12 });
  const upper = document.clips[1]!;
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers.find((layer) => layer.id === upper.layerId)!,
      keyframes: [
        sharedPoint(0, { opacity: 0, exposure: -0.2 }),
        sharedPoint(11, { opacity: 0.8, exposure: 0.2 }, 'smooth'),
      ],
    },
  });
  await page.evaluate((project) => window.pascapLab!.setDocument(project), document);
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  const accepted = await submitExport(page);
  const { receiptUrl } = await freshExportLinks(page, request, accepted, 90_000);
  const receipt = (await (await request.get(receiptUrl)).json()) as ExportReceipt;
  const snapshot = projectSchema.parse(receipt.snapshot);
  expect(snapshot.schemaVersion).toBe(13);
  expect(snapshot.layers).toHaveLength(2);
  expect(snapshot.layers[1]?.keyframes).toEqual(document.layers[1]?.keyframes);
  expect(snapshot.clips[1]).not.toHaveProperty('animation');
  expect(receipt.settings.pipeline).toBe('sequential-layered');
  expect(receipt.musicSources).toEqual([]);
  expect(receipt.settings.audio).toEqual([]);
  expect(receipt.verification.audio).toBeNull();
  expect(receipt.verification.frameCount).toBe(calculateLayout(document).duration);
  await seek(page, 0);
  await inspectorTab(page, 'Track');
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.7');
  const again = (await (await request.get(receiptUrl)).json()) as { snapshot: unknown };
  expect(projectSchema.parse(again.snapshot)).toEqual(snapshot);
});

test('plays three simultaneous sources through row-wide rate/grade curves, a track dissolve and repeated music wraps', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(40_000);
  const library = (await (await request.get('/api/media')).json()) as { assets: { id: string; name: string }[] };
  const music = (await (await request.get('/api/audio')).json()) as { assets: { id: string }[] };
  const red = library.assets.find((asset) => asset.name === 'pattern-a.mp4')!.id;
  const blue = library.assets.find((asset) => asset.name === 'pattern-b.mp4')!.id;
  let project = createProject('preview-lab', 'Simultaneous sources · disposable');
  project.media = {
    videoIds: library.assets.map((asset) => asset.id),
    audioIds: music.assets.map((asset) => asset.id),
  };
  project.revision = await page.evaluate(() => window.pascapLab!.project()!.revision);
  project = applyCommand(project, { type: 'insert', clip: createClip('first', red, 0, 45), index: 0 });
  project = applyCommand(project, { type: 'insert', clip: createClip('second', blue, 0, 45), index: 1 });
  project = applyCommand(project, {
    type: 'transition',
    transition: { leftId: 'first', rightId: 'second', type: 'cross-dissolve', duration: 15 },
  });
  project = applyCommand(project, {
    type: 'layer-update',
    layer: {
      ...project.layers[0]!,
      keyframes: [
        sharedPoint(0, { exposure: -0.4, opacity: 0.6 }),
        sharedPoint(24, { exposure: 0.4, opacity: 1 }, 'smooth'),
      ],
    },
  });
  project = applyCommand(project, {
    type: 'layer-add',
    layer: createLayer('upper', 'Video track 2', false),
  });
  const clip = { ...createClip('upper-clip', blue, 0, 80), layerId: 'upper', start: 5 };
  project.layers.find((layer) => layer.id === 'upper')!.opacity = 0.8;
  project = applyCommand(project, { type: 'insert', clip, index: 2 });
  project = applyCommand(project, {
    type: 'layer-update',
    layer: {
      ...project.layers[1]!,
      keyframes: [
        sharedPoint(0, { opacity: 0, exposure: -0.4, saturation: 1 }, 'smooth'),
        sharedPoint(79, { opacity: 1, exposure: 0.4, saturation: 0.6 }),
      ],
    },
  });
  // Each clip's own speed curve varies its decoder playback rate.
  const curves: Record<string, [number, number, 'linear' | 'smooth', number]> = {
    first: [0.5, 2, 'linear', 45],
    second: [2, 0.5, 'smooth', 45],
    'upper-clip': [0.7, 1.4, 'smooth', 80],
  };
  for (const [clipId, [from, to, interpolation, last]] of Object.entries(curves))
    project = applyCommand(project, {
      type: 'speed',
      clipId,
      speed: {
        mode: 'curve',
        keyframes: [
          { frame: 0, rate: from, interpolation },
          { frame: last, rate: to, interpolation },
        ],
      },
    });
  const layout = calculateLayout(project);
  const dissolve = layout.transitions[0]!;
  const during = sampleTimeline(project, dissolve.start + 7).filter((layer) => layer.layerId === 'video-1');
  expect(during).toHaveLength(2);
  expect(during[0]?.colour).toEqual(during[1]?.colour);
  expect(during[0]?.opacity).toBe(during[1]?.opacity);
  expect(layout.clips[1]!.retiming.rateAt(7)).not.toBeCloseTo(layout.clips[0]!.retiming.rateAt(dissolve.start + 7));
  const duration = calculateLayout(project).duration;
  project = applyCommand(project, {
    type: 'music',
    music: [
      {
        id: 'layers-music',
        mediaId: music.assets[0]!.id,
        sourceIn: 0,
        sourceOut: 30,
        start: 0,
        duration,
        gainDb: -9,
        fadeIn: 5,
        fadeOut: 5,
        loop: true,
      },
    ],
  });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), project);
  await page.waitForFunction((expected) => {
    const state = window.pascapLab?.engine.diagnostics();
    return state?.status === 'paused' && state.duration === expected;
  }, duration);
  const aligned = await page.evaluate(async (frame) => {
    const engine = window.pascapLab!.engine;
    await engine.seek(frame);
    await engine.play();
    return {
      state: engine.diagnostics(),
      rates: Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'),
        (video) => video.playbackRate,
      ),
    };
  }, dissolve.start + 7);
  expect(aligned.state.status, aligned.state.message).toBe('playing');
  expect(aligned.state.activeDecoders).toBe(3);
  for (const sample of sampleTimeline(project, aligned.state.frame)) {
    const slot = aligned.state.assignedClipIds.indexOf(sample.clipId);
    const placed = layout.clips.find((item) => item.clip.id === sample.clipId)!;
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(aligned.rates[slot]).toBeCloseTo(placed.retiming.rateAt(aligned.state.frame - placed.start), 6);
  }
  await page.evaluate(() => window.pascapLab!.engine.pause());
  for (let pass = 0; pass < 2; pass++) {
    await page.evaluate(async () => {
      await window.pascapLab!.engine.seek(0);
      await window.pascapLab!.engine.play();
    });
    await page.waitForFunction(() => window.pascapLab!.engine.diagnostics().activeDecoders >= 3, undefined, {
      timeout: 12_000,
    });
    await page.waitForFunction(
      () => {
        const state = window.pascapLab!.engine.diagnostics();
        return (
          state.status === 'error' ||
          (!state.playing && state.status === 'paused' && state.frame === state.duration - 1)
        );
      },
      undefined,
      { timeout: 15_000 },
    );
    const state = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
    if (state.status !== 'paused') {
      const decoders = await page.locator('video[data-pascap-decoder]').evaluateAll((elements) =>
        elements.map((element) => {
          const video = element as HTMLVideoElement;
          return {
            index: video.dataset.pascapDecoder,
            currentTime: video.currentTime,
            paused: video.paused,
            ended: video.ended,
            seeking: video.seeking,
            readyState: video.readyState,
            rate: video.playbackRate,
            error: video.error?.message ?? null,
          };
        }),
      );
      const required = sampleTimeline(project, state.requestedFrame, layout).map(({ clipId, sourceFrame }) => ({
        clipId,
        sourceFrame,
      }));
      await testInfo.attach('layered-playback-failure', {
        body: JSON.stringify({ pass, state, required, decoders }),
        contentType: 'application/json',
      });
    }
    expect(state.status, state.message).toBe('paused');
    expect(state.frame).toBe(duration - 1);
    expect(state.decoderCount).toBe(4);
    expect(state.audioClock).toBe(true);
    await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(4);
  }
});

test('edits shared values outside the source excerpt and duration without moving unrelated points or bases', async ({
  page,
}) => {
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  const original = project.clips[0]!;
  project = applyCommand(project, {
    type: 'layer-update',
    layer: {
      ...project.layers[0]!,
      keyframes: [sharedPoint(5, { opacity: 0.2, exposure: -0.5 }, 'smooth'), sharedPoint(110, { exposure: 2 })],
    },
  });
  project = applyCommand(project, { type: 'trim', clipId: original.id, sourceIn: 30, sourceOut: 90 });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), project);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  const row = await editLayerPoint(page, 'Video track 1', 5);
  await row.getByRole('spinbutton', { name: 'Opacity keyframe value 5', exact: true }).fill('80');
  const opacityFrame = row.getByRole('spinbutton', { name: 'Track keyframe frame 5', exact: true });
  await opacityFrame.fill('8');
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers[0]!.keyframes[0]!.frame)).toBe(5);
  await opacityFrame.press('Enter');
  const outside = await editLayerPoint(page, 'Video track 1', 110);
  await expect(outside.locator('.keyframe-row-skipped')).toHaveText('Outside duration');
  await outside.getByRole('spinbutton', { name: 'Exposure keyframe value 110', exact: true }).fill('3');
  await layerKeyframes(page, 'Video track 1')
    .getByRole('button', { name: 'Go to track keyframe 8', exact: true })
    .click();
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.7');
  const edited = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(edited.layers[0]?.keyframes).toEqual([
    sharedPoint(8, { opacity: 0.8, exposure: 0.7 }, 'smooth'),
    sharedPoint(110, { exposure: 3 }),
  ]);
  expect(edited.clips[0]).toEqual({ ...original, sourceIn: 30, sourceOut: 90 });
});

test('source-range choices are per project and do not alter already inserted excerpts', async ({ page }) => {
  let keyed = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  const anchors = [sharedPoint(20, { exposure: 0.3 }), sharedPoint(70, { opacity: 0.6 }, 'smooth')];
  keyed = applyCommand(keyed, { type: 'layer-update', layer: { ...keyed.layers[0]!, keyframes: anchors } });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), keyed);
  await sourceAtPointer(page, 'pattern-a.mp4', 0.25);
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('30');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('80');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).press('Enter');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[0]!.sourceIn)).toBe(0);
  expect(projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).layers[0]?.keyframes).toEqual(
    anchors,
  );
  await page.getByRole('button', { name: 'Close source review' }).click();
  await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('textbox', { name: 'New project title' }).fill('New source review project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue(
    'New source review project',
  );
  const fresh = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(fresh.layers[0]?.keyframes).toEqual([]);
  expect(fresh.media).toEqual({ videoIds: [], audioIds: [] });
  // The memory-only source-choice fixture explicitly imports this rush into its new bin.
  fresh.media.videoIds = [keyed.clips[0]!.mediaId];
  await page.evaluate((document) => window.pascapLab!.setDocument(document), fresh);
  await page.evaluate(() => window.pascapLab!.flush());
  await sourceAtPointer(page, 'pattern-a.mp4', 0.25);
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue('0');
  await expect(page.getByRole('spinbutton', { name: 'Source OUT', exact: true })).toHaveValue('120');
});

test('overlay trims hold the opposite edge, preserve keys, cancel drafts and commit one undoable gesture', async ({
  page,
}) => {
  const id = await addOverlay(page);
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  project = applyCommand(project, { type: 'trim-place', clipId: id, sourceIn: 20, sourceOut: 100, start: 20 });
  const layer = project.layers.find((item) => item.id === project.clips.find((clip) => clip.id === id)!.layerId)!;
  project = applyCommand(project, {
    type: 'layer-update',
    layer: {
      ...layer,
      keyframes: [sharedPoint(10, { opacity: 0.4 }), sharedPoint(110, { opacity: 0.8 }, 'smooth')],
    },
  });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), project);
  await page.evaluate(() => window.pascapLab!.flush());
  await page.waitForFunction(() => window.pascapLab!.engine.diagnostics().status === 'paused');
  await page.getByRole('button', { name: 'Toggle snapping' }).click();
  const handle = (edge: 'in' | 'out') => page.locator(`[data-clip-id="${id}"] [data-trim-handle="${edge}"]`);
  const move = async (edge: 'in' | 'out', delta: number, cancel = false): Promise<void> => {
    await handle(edge).scrollIntoViewIfNeeded();
    const box = (await handle(edge).boundingBox())!;
    const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + delta * scale, box.y + box.height / 2, { steps: 5 });
    if (cancel) {
      expect(
        await page.evaluate(
          (clipId) => window.pascapLab!.project()!.clips.find((clip) => clip.id === clipId)!.sourceIn,
          id,
        ),
      ).toBe(20);
      await page.keyboard.press('Escape');
    }
    await page.mouse.up();
    await page.waitForFunction(() => window.pascapLab!.engine.diagnostics().status === 'paused');
  };
  await move('in', 10, true);
  expect(
    await page.evaluate((clipId) => window.pascapLab!.project()!.clips.find((clip) => clip.id === clipId), id),
  ).toMatchObject({ sourceIn: 20, start: 20 });
  await move('in', 10);
  let edited = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(edited.clips.find((clip) => clip.id === id)).toMatchObject({ sourceIn: 30, sourceOut: 100, start: 30 });
  expect(calculateLayout(edited).clips.find((placed) => placed.clip.id === id)?.end).toBe(100);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(
    await page.evaluate((clipId) => window.pascapLab!.project()!.clips.find((clip) => clip.id === clipId), id),
  ).toMatchObject({ sourceIn: 20, start: 20 });
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await handle('in').focus();
  await page.keyboard.press('ArrowRight');
  expect(
    await page.evaluate((clipId) => window.pascapLab!.project()!.clips.find((clip) => clip.id === clipId), id),
  ).toMatchObject({ sourceIn: 31, start: 31 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await move('in', -30);
  await move('out', 20);
  edited = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(edited.clips.find((clip) => clip.id === id)).toMatchObject({ sourceIn: 0, sourceOut: 120, start: 0 });
  expect(edited.layers[1]?.keyframes).toEqual(project.layers[1]?.keyframes);
  expect(edited.layers[1]?.keyframes.map((point) => point.frame)).toEqual([10, 110]);
  expect(edited.clips[0]).toEqual(project.clips[0]);
});

test('cross-layer dragging uses scrolled lane coordinates and inserts before the requested Ripple track boundary', async ({
  page,
  request,
}) => {
  const library = (await (await request.get('/api/media')).json()) as { assets: { id: string; name: string }[] };
  const red = library.assets.find((asset) => asset.name === 'pattern-a.mp4')!.id;
  const blue = library.assets.find((asset) => asset.name === 'pattern-b.mp4')!.id;
  let project = createProject('preview-lab', 'Scrolled layer drop · disposable');
  project.media.videoIds = library.assets.map((asset) => asset.id);
  project.revision = await page.evaluate(() => window.pascapLab!.project()!.revision);
  for (let index = 2; index <= 5; index++)
    project = applyCommand(project, {
      type: 'layer-add',
      layer: createLayer(`layer-${index}`, `Video track ${index}`, false),
    });
  project = applyCommand(project, { type: 'insert', clip: createClip('a', red, 0, 30), index: 0 });
  project = applyCommand(project, {
    type: 'insert',
    clip: { ...createClip('moving', blue, 0, 30), layerId: 'layer-5', start: 35 },
    index: 1,
  });
  project = applyCommand(project, { type: 'insert', clip: createClip('b', red, 30, 60), index: 2 });
  project = applyCommand(project, {
    type: 'insert',
    clip: { ...createClip('c', blue, 0, 120), speed: { mode: 'constant', rate: 0.5 } },
    index: 3,
  });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), project);
  await page.waitForFunction(() => window.pascapLab!.engine.diagnostics().status === 'paused');
  await page.getByRole('slider', { name: 'Timeline zoom' }).fill('180');
  const scroll = page.locator('.timeline-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.scrollLeft = 128;
  });
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const moving = page.locator('[data-clip-id="moving"]');
  await expect(moving).toBeInViewport();
  const sourceBox = (await moving.boundingBox())!;
  const viewport = (await scroll.boundingBox())!;
  // Start on the actual scrolled last row before revealing the first-row target.
  // dragTo scrolls both endpoints before pointerdown, which can put a different
  // first-row clip under the saved start coordinates when the rows are far apart.
  await page.mouse.move(sourceBox.x + 24, sourceBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 38, sourceBox.y + 30, { steps: 3 });
  await page.mouse.move(viewport.x + 100, viewport.y + 34, { steps: 5 });
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
  const targetBox = (await page.locator('[data-clip-id="b"] .timeline-clip-body').boundingBox())!;
  await page.mouse.move(targetBox.x + 10, targetBox.y + 30, { steps: 5 });
  await expect(page.locator('.timeline-drop-preview')).toHaveAttribute('data-drop-layer', 'video-1');
  await expect(page.locator('.timeline-drop-preview')).toHaveAttribute('data-drop-start', '30');
  await page.mouse.up();
  const edited = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(
    calculateLayout(edited)
      .clips.filter((placed) => placed.clip.layerId === 'video-1')
      .map((placed) => placed.clip.id),
  ).toEqual(['a', 'moving', 'b', 'c']);
  expect(edited.clips.find((clip) => clip.id === 'moving')).toMatchObject({
    layerId: 'video-1',
    sourceIn: 0,
    sourceOut: 30,
  });
  await expect(page.locator('.layer-control.selected .layer-select')).toHaveAttribute(
    'aria-label',
    'Select track Video track 1',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(
    await page.evaluate(() => window.pascapLab!.project()!.clips.find((clip) => clip.id === 'moving')),
  ).toMatchObject({ layerId: 'layer-5', start: 35 });
});

test('the track header Ripple toggle mirrors Layer options and switches in one Undo step', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Toggle Ripple on Video track 1', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers[0]!.ripple)).toBe(false);
  await openOptions(page, 'Track options Video track 1');
  await expect(page.getByRole('checkbox', { name: 'Ripple on track Video track 1', exact: true })).not.toBeChecked();
  await closeOptions(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.layer-kind')).toHaveCount(0);
  await expect(page.locator('.rush-edit-mode')).toHaveCount(0);
  // The active empty track names itself as the insertion target; idle timelines show no status line.
  await expect(page.locator('.timeline-lane-placeholder')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add video track', exact: true }).click();
  await expect(page.locator('[data-layer-lane] .timeline-lane-placeholder')).toHaveText(['Insert here']);
  await expect(page.locator('.timeline-bottom')).toHaveCount(0);
});
