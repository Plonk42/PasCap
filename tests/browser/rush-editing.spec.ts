import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { audioAssetSchema, type AudioAsset } from '../../src/shared/audio.js';
import { createColorSettings } from '../../src/shared/color.js';
import { applyCommand } from '../../src/shared/commands.js';
import { mediaAssetSchema, type MediaAsset } from '../../src/shared/media.js';
import {
  MOTION_ANALYSIS_VERSION,
  motionProfile,
  SMOOTH_TOLERANCE,
  smoothRanges,
  type MotionAnalysis,
} from '../../src/shared/motion-analysis.js';
import { rankedSmoothRanges } from '../../src/shared/recording-shots.js';
import {
  createClip,
  createLayer,
  createProject,
  PROJECT_SCHEMA_VERSION,
  projectSchema,
  type ProjectDocument,
  type Transition,
} from '../../src/shared/model.js';
import { validateSourceRanges } from '../../src/shared/source-range.js';
import { removeSelectedRange } from '../../src/shared/rush-editing.js';
import { durationLabel } from '../../src/web/display.js';
import { calculateLayout, layerClips } from '../../src/shared/timeline.js';
import {
  adjustmentFrom0,
  clipAction,
  closeOptions,
  expandedInspectorPreferences,
  gradePoint,
  inspectorTab,
  isWrite,
  openOptions,
  transformPoint,
} from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';
import { installVideoFrameGate } from './video-frame-gate.js';
import { singleClipLane } from '../music-lanes.js';

const PROJECT_ID = 'browser-rush-editing';
let assets: MediaAsset[];
let audioAssets: AudioAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];

test.beforeEach(async ({ page, request }) => {
  unexpectedApi = [];
  audioAssets = [];
  await installVideoFrameGate(page);
  // Read already prepared fixtures only. Missing fixtures fail; never prepare or register here.
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: unknown[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.map((item) => mediaAssetSchema.parse(item)).find((item) => item.name === name);
    if (
      !asset ||
      asset.status !== 'ready' ||
      !asset.prepared ||
      !asset.sourcePath.endsWith(`/synthetic-sources/${name}`)
    ) {
      throw new Error(
        `Rush browser regressions require the existing ready synthetic fixture ${name}; no preparation is attempted.`,
      );
    }
    expect(asset.metadata.frameCount).toBe(120);
    expect(asset.prepared.verification.frameCount).toBe(120);
    return asset;
  });

  // Project routes are installed afterwards and take precedence over this deny-by-default guard.
  // Only reads for these existing synthetic proxies/thumbnails (and explicitly selected fixture music) reach the server.
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets, missing: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && pathname === '/api/audio') {
      await route.fulfill({ json: { assets: audioAssets, missing: [] } });
      return;
    }
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    const media = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+|motion)$/.exec(pathname);
    if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) {
      await route.continue();
      return;
    }
    const audio = /^\/api\/audio\/([^/]+)\/(?:playback|analysis)$/.exec(pathname);
    if ((method === 'GET' || method === 'HEAD') && audio && audioAssets.some((asset) => asset.id === audio[1])) {
      await route.continue();
      return;
    }
    if (method === 'POST' && pathname === '/api/ops/music_waveform') {
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
  await page.goto(`/?project=${PROJECT_ID}`);
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test.afterEach(() => {
  expect(unexpectedApi, 'No import, preparation, export, reference, original-media or unowned API requests').toEqual(
    [],
  );
});

function sequence(): ProjectDocument {
  const document = createProject(PROJECT_ID, 'Rush editing · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [
    createClip('a', assets[0]!.id, 15, 105),
    { ...createClip('b', assets[1]!.id, 30, 90), start: 90 },
    { ...createClip('c', assets[0]!.id, 60, 120), start: 150 },
  ];
  document.layers[0]!.transitions = [
    { leftId: 'a', rightId: 'b', type: 'cut', duration: 0 },
    { leftId: 'b', rightId: 'c', type: 'cut', duration: 0 },
  ];
  return projectSchema.parse(document);
}

function dissolvedSequence(): ProjectDocument {
  let document = sequence();
  document = applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 12 },
  });
  document = applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'b', rightId: 'c', type: 'cross-dissolve', duration: 6 },
  });
  return applyCommand(document, { type: 'fades', layerId: document.layers[0]!.id, opening: 8, closing: 4 });
}

function omittedHeadSequence(): ProjectDocument {
  const document = sequence();
  document.clips = [
    createClip('a', assets[0]!.id, 90, 120),
    { ...createClip('b', assets[1]!.id, 30, 60), start: 30 },
    { ...createClip('c', assets[0]!.id, 60, 90), start: 60 },
  ];
  document.adjustments = [
    adjustmentFrom0(600, [gradePoint(12, { exposure: 0.3 }), gradePoint(500, { hue: 20 }, 'hold')]),
  ];
  return projectSchema.parse(document);
}

async function current(page: Page): Promise<ProjectDocument> {
  const document = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  validateSourceRanges(document, new Map(assets.map((asset) => [asset.id, asset.metadata.frameCount])));
  return document;
}

async function ready(page: Page, document: ProjectDocument): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab?.engine.diagnostics();
        return { status: state?.status, duration: state?.duration };
      }),
    )
    .toEqual({ status: document.clips.length ? 'paused' : 'empty', duration: calculateLayout(document).duration });
}

async function flush(page: Page): Promise<void> {
  await page.evaluate(() => window.pascapLab!.flush());
}

/** Kept ranges are project data: a range edit saves them and Undoes, but changes nothing else. */
function timelineOf(document: ProjectDocument) {
  const { selects: _selects, revision: _revision, ...rest } = document;
  return rest;
}

async function expectOnlyRangesSaved(page: Page, seed: ProjectDocument = sequence()): Promise<void> {
  await flush(page);
  expect(timelineOf(memory.snapshot())).toEqual(timelineOf(seed));
}

/** Reload a memory seed, not setDocument: each fixture starts with an empty Undo stack. */
async function fixture(page: Page, document: ProjectDocument): Promise<void> {
  await flush(page);
  for (const placed of calculateLayout(document).clips) {
    if (document.layers.find((layer) => layer.id === placed.clip.layerId)!.ripple) placed.clip.start = placed.start;
  }
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
}

async function fixtureMusic(request: APIRequestContext): Promise<AudioAsset> {
  const response = await request.get('/api/audio');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: unknown[] };
  const asset = library.assets
    .map((item) => audioAssetSchema.parse(item))
    .find((item) => item.name === 'test-music.wav');
  if (!asset || asset.status !== 'ready' || !asset.sourcePath.endsWith('/synthetic-sources/test-music.wav')) {
    throw new Error(
      'Music invariance requires the existing ready synthetic test-music.wav fixture; no audio preparation is attempted.',
    );
  }
  audioAssets = [asset];
  return asset;
}

function clip(page: Page, id: string) {
  return page.locator(`.timeline-clip[data-clip-id="${id}"]`);
}

async function selectClip(page: Page, id: string): Promise<void> {
  await clip(page, id).locator('.timeline-clip-body').click();
  await expect(clip(page, id).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await ready(page, await current(page));
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame, playing: state.playing };
      }),
    )
    .toEqual({ status: 'paused', frame, playing: false });
}

async function shortcut(page: Page, key: string): Promise<void> {
  await page.getByRole('region', { name: 'Video timeline', exact: true }).focus();
  await page.keyboard.press(key);
}

function rulerRange(page: Page) {
  return page.locator('.timeline-ruler-range');
}

/** Real pointer drag on the lower ruler half (below the playhead handle); Alt bypasses snapping. */
async function markRange(page: Page, inFrame: number, outFrame: number, reverse = false): Promise<void> {
  const box = (await page.getByLabel('Timeline ruler', { exact: true }).boundingBox())!;
  const origin = await frameOrigin(page);
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const y = box.y + box.height - 6;
  const [from, to] = reverse ? [outFrame, inFrame] : [inFrame, outFrame];
  await page.keyboard.down('Alt');
  await page.mouse.move(origin + from * scale, y);
  await page.mouse.down();
  await page.mouse.move(origin + ((from + to) / 2) * scale, y, { steps: 2 });
  await page.mouse.move(origin + to * scale, y);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(rulerRange(page)).toHaveAttribute('data-range-in', String(inFrame));
  await expect(rulerRange(page)).toHaveAttribute('data-range-out', String(outFrame));
}

async function expectCutOverlay(page: Page, inFrame: number, outFrame: number): Promise<void> {
  const selection = page.locator('.timeline-cut-selection');
  await expect(selection).toHaveAttribute('data-cut-in', String(inFrame));
  await expect(selection).toHaveAttribute('data-cut-out', String(outFrame));
  const geometry = await page.locator('.timeline-surface').evaluate((element) => ({
    scale: Number(element.getAttribute('data-pixels-per-frame')),
    leading: Number(element.getAttribute('data-leading')),
  }));
  const style = await selection.evaluate((element) => ({
    left: Number.parseFloat((element as HTMLElement).style.left),
    width: Number.parseFloat((element as HTMLElement).style.width),
  }));
  // CSSOM serializes subpixel lengths to fewer significant digits; frame marks above remain exact.
  expect(style.left).toBeCloseTo(geometry.leading + inFrame * geometry.scale, 2);
  expect(style.width).toBeCloseTo((outFrame - inFrame) * geometry.scale, 2);
}

function firstTrackGeometry(document: ProjectDocument) {
  return calculateLayout(document)
    .clips.filter((placed) => placed.clip.layerId === document.layers[0]!.id)
    .map((placed) => [placed.clip.id, placed.start, placed.duration, placed.end]);
}

function unchangedOthers(
  before: ProjectDocument,
  next: ProjectDocument,
  editedIds: readonly string[],
  transitions: Readonly<Record<string, readonly Transition[]>> = {},
): void {
  expect(next.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  expect(next.media).toEqual(before.media);
  expect(next.layers).toEqual(
    before.layers.map((layer) => ({ ...layer, transitions: transitions[layer.id] ?? layer.transitions })),
  );
  expect(next.music).toEqual(before.music);
  // Adjustments keep their project frames and keyframes through every clip edit.
  expect(next.adjustments).toEqual(before.adjustments);
  const layout = calculateLayout(next);
  for (const original of before.clips.filter((item) => !editedIds.includes(item.id))) {
    const placed = layout.clips.find((item) => item.clip.id === original.id)!;
    const ripple = before.layers.find((layer) => layer.id === original.layerId)!.ripple;
    expect(next.clips.find((item) => item.id === original.id)).toEqual({
      ...original,
      start: ripple ? placed.start : original.start,
    });
  }
}

async function decodedSource(page: Page, clipId: string, sourceFrame: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const state = window.pascapLab!.engine.diagnostics();
        return state.status === 'paused' ? state.decodedSourceFrames[state.assignedClipIds.indexOf(id)] : null;
      }, clipId),
    )
    .toBe(sourceFrame);
}

async function sourceFrame(page: Page, frame: number): Promise<void> {
  await page.getByRole('slider', { name: 'Source playhead', exact: true }).fill(String(frame));
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', String(frame));
  await expect(page.locator('.source-preview')).toHaveAttribute('data-buffering', 'false');
}

async function sourceRange(page: Page, sourceIn: number, sourceOut: number): Promise<void> {
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill(String(sourceIn));
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill(String(sourceOut));
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).press('Enter');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', String(sourceIn));
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', String(sourceOut));
}

/** The Add button names the applied range length it will insert, for example "Add clip 3.00 s to timeline". */
const ADD_EXCERPT = /^Add clip \d+\.\d{2} s to timeline$/;

async function addExcerpt(page: Page): Promise<string> {
  await page.getByRole('button', { name: ADD_EXCERPT }).click();
  const feedback = page.locator('.source-add-feedback');
  await expect(feedback).toHaveAttribute('data-added-clip-id', /^[a-zA-Z0-9_-]+$/);
  await expect(feedback).toHaveText('Clip added · mark another range');
  const id = await feedback.getAttribute('data-added-clip-id');
  if (!id) throw new Error('Successful source insertion must identify its new clip instance.');
  return id;
}

async function frameOrigin(page: Page): Promise<number> {
  return page
    .locator('.timeline-surface')
    .evaluate((element) => element.getBoundingClientRect().left + Number(element.getAttribute('data-leading')));
}

/** Real pointer capture and movement; observe drafts, never fake the drag with dispatchEvent. */
async function beginHeadTrim(page: Page): Promise<{ origin: number; scrollLeft: number; edgeX: number; y: number }> {
  const snap = page.getByRole('button', { name: 'Toggle snapping', exact: true });
  if ((await snap.getAttribute('aria-pressed')) === 'true') await snap.click();
  const handle = clip(page, 'a').locator('[data-trim-handle="in"]');
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const viewport = (await page.locator('.timeline-scroll').boundingBox())!;
  const origin = await frameOrigin(page);
  const scrollLeft = await page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft);
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const shift = Math.ceil(90 * scale);
  expect(shift).toBeGreaterThan(32);
  await expect(page.locator('.timeline-surface')).toHaveAttribute('data-leading', '32');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  expect(x).toBeGreaterThan(viewport.x + 28);
  await page.mouse.move(x, y);
  expect(await frameOrigin(page)).toBe(origin);
  await page.mouse.down();
  await expect(page.locator('.timeline-surface')).toHaveClass(/trim-drafting/);
  await expect
    .poll(() => page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft))
    .toBe(scrollLeft + shift);
  await expect(page.locator('.timeline-surface')).toHaveAttribute('data-leading', String(32 + shift));
  await expect.poll(() => frameOrigin(page)).toBe(origin);
  await expect(page.getByRole('textbox', { name: 'Source IN frame', exact: true })).toHaveValue('00:03:00');
  return { origin, scrollLeft, edgeX: viewport.x + 2, y };
}

test('three ranges from one rush keep the source pinned, independent, reloadable and horizontally revealable', async ({
  page,
}) => {
  const empty = createProject(PROJECT_ID, 'Repeated rush excerpts · memory-only');
  empty.media.videoIds = assets.map((asset) => asset.id);
  await fixture(page, empty);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 0);
  expect((await current(page)).clips).toEqual([]); // Review is not insertion.
  const decoder = await page.locator('canvas[data-source-decoder]').elementHandle();
  expect(decoder).not.toBeNull();
  const ids: string[] = [];
  for (const [sourceIn, sourceOut] of [
    [10, 90],
    [25, 105],
    [40, 120],
  ] as const) {
    const before = await current(page);
    await sourceFrame(page, sourceIn);
    await page.getByRole('button', { name: 'Review source frame of pattern-a.mp4', exact: true }).focus();
    await page.keyboard.press('i');
    await sourceFrame(page, sourceOut - 1);
    await page.getByRole('button', { name: 'Review source frame of pattern-a.mp4', exact: true }).focus();
    await page.keyboard.press('o');
    await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', String(sourceIn));
    await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', String(sourceOut));
    expect(timelineOf(await current(page))).toEqual(timelineOf(before));
    ids.push(await addExcerpt(page));
    const next = await current(page);
    expect(next.clips.slice(0, -1)).toEqual(before.clips);
    expect(next.clips.at(-1)).toEqual({
      ...createClip(ids.at(-1)!, assets[0]!.id, sourceIn, sourceOut),
      start: before.clips.length * 80,
    });
    await ready(page, next);
    await expect(page.getByRole('region', { name: 'Source review', exact: true })).toBeVisible();
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', String(sourceOut - 1));
    await expect(page.locator('.source-review')).toHaveAttribute('data-source-excerpt-count', String(ids.length));
    expect(
      await page.locator('canvas[data-source-decoder]').evaluate((canvas, original) => canvas === original, decoder),
    ).toBe(true);
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
    await expect(page.locator('.timeline-ruler-range')).toHaveCount(0);
  }
  expect(new Set(ids).size).toBe(3);
  const added = await current(page);
  expect(firstTrackGeometry(added)).toEqual([
    [ids[0], 0, 80, 80],
    [ids[1], 80, 80, 160],
    [ids[2], 160, 80, 240],
  ]);
  expect(calculateLayout(added).duration).toBe(240);
  const badge = page.locator(`.media-item[data-media-id="${assets[0]!.id}"] .media-usage-badge`);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('3 clips');
  await sourceRange(page, 5, 35);
  expect((await current(page)).clips).toEqual(added.clips);

  await page.locator('.source-excerpts > summary').click();
  await expect(page.locator('.source-excerpts > summary')).toHaveText('Show 3 clips');
  for (const [index, excerpt] of added.clips.entries()) {
    const row = page.locator(`.source-excerpt-row[data-clip-id="${excerpt.id}"]`);
    await expect(row.locator('.source-excerpt-range')).toHaveAttribute(
      'title',
      `Original source frames ${excerpt.sourceIn} → ${excerpt.sourceOut}, OUT exclusive`,
    );
    await expect(row.locator('.source-excerpt-layer')).toHaveText('Track 1');
    await expect(row.getByRole('button', { name: `Show clip ${index + 1} on timeline`, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('slider', { name: 'Timeline zoom', exact: true }).fill('180');
  await expect
    .poll(() => page.locator('.timeline-scroll').evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(400);
  await page.locator('.timeline-scroll').evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
  });
  const viewport = (await page.locator('.timeline-scroll').boundingBox())!;
  const offscreen = (await clip(page, ids[0]!).boundingBox())!;
  expect(offscreen.x).toBeLessThan(viewport.x);
  await page.getByRole('button', { name: 'Show clip 1 on timeline', exact: true }).click();
  await expect(clip(page, ids[0]!).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft)).toBe(0);
  await expect(clip(page, ids[0]!)).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
  expect((await current(page)).clips).toEqual(added.clips);

  await page.setViewportSize({ width: 1440, height: 900 });
  await selectClip(page, ids[2]!);
  const input = page.getByRole('textbox', { name: 'Source IN frame', exact: true });
  await input.fill('50');
  await input.press('Enter');
  await inspectorTab(page, 'Clip grade');
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('1.2');
  const edited = await current(page);
  expect(edited.clips.slice(0, 2)).toEqual(added.clips.slice(0, 2));
  expect(edited.clips[2]).toEqual({
    ...added.clips[2]!,
    sourceIn: 50,
    grade: { ...added.clips[2]!.grade, color: { ...added.clips[2]!.grade.color, saturation: 1.2 } },
  });
  expect(edited.layers).toEqual(added.layers);
  await flush(page);
  expect(memory.snapshot().clips).toEqual(edited.clips);
  await page.reload();
  await ready(page, memory.snapshot());
  expect(await current(page)).toEqual(memory.snapshot());
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 5);
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '5');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '35');
  await expect(page.locator('.source-review')).toHaveAttribute('data-source-excerpt-count', '3');
  await expect(badge).toHaveText('3 clips');
  await expect(page.locator('canvas[data-source-decoder]')).toHaveCount(1);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().decoderCount)).toBe(2);
});

test('rush excerpt popup leaves review geometry and Add reachable on a short laptop screen, with isolated Escape and outside-click addition', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 30);
  const before = await current(page);
  const sourceBox = await page.locator('.source-preview').boundingBox();
  const add = page.getByRole('button', { name: ADD_EXCERPT });
  await expect(add).toBeInViewport();
  const trigger = page.locator('.source-excerpts > summary');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.source-excerpt-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Show clip 2 on timeline', exact: true })).toBeVisible();
  expect(await page.locator('.source-preview').boundingBox()).toEqual(sourceBox);
  await expect(add).toBeInViewport();
  await page.getByRole('button', { name: 'Show clip 1 on timeline', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('region', { name: 'Source review', exact: true })).toBeVisible();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '30');
  expect(await current(page)).toEqual(before);
  await trigger.click();
  const id = await addExcerpt(page);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(add).toBeInViewport();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '30');
  await expect(page.locator('.source-range-editor')).toHaveCount(1);
  expect((await current(page)).clips).toEqual([
    ...before.clips,
    { ...createClip(id, assets[0]!.id, 0, 120), start: calculateLayout(before).duration },
  ]);
  await expect(page.locator('.source-review')).toHaveAttribute('data-source-excerpt-count', '3');
});

test('Duplicate is a clip context-menu action and zoom buttons step the retained slider', async ({ page }) => {
  const before = await current(page);
  await expect(page.locator('summary[aria-label="Clip actions"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Duplicate selected clip', exact: true })).toHaveCount(0);

  const body = clip(page, 'b').locator('.timeline-clip-body');
  await body.click({ button: 'right' });
  await expect(body).toHaveAttribute('aria-pressed', 'true');
  const duplicate = page.getByRole('button', { name: 'Duplicate selected clip', exact: true });
  await expect(duplicate).toBeVisible();
  await expect(duplicate).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(duplicate).toHaveCount(0);
  await expect(body).toBeFocused();
  expect(await current(page)).toEqual(before);

  await body.click({ button: 'right' });
  await duplicate.click();
  await expect(duplicate).toHaveCount(0);
  const after = await current(page);
  expect(after.clips).toHaveLength(before.clips.length + 1);
  const copy = after.clips.find((item) => !before.clips.some((original) => original.id === item.id))!;
  expect(copy).toMatchObject({ mediaId: assets[1]!.id, sourceIn: 30, sourceOut: 90 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);

  const slider = page.getByRole('slider', { name: 'Timeline zoom', exact: true });
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
  await slider.fill('48');
  await zoomIn.click();
  await expect(slider).toHaveValue('60');
  await zoomOut.click();
  await zoomOut.click();
  await expect(slider).toHaveValue('38');
  await slider.fill('180');
  await expect(zoomIn).toBeDisabled();
  await slider.fill('12');
  await expect(zoomOut).toBeDisabled();
  await expect(zoomIn).toBeEnabled();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`zoom out and Fit show the whole timeline extent without a horizontal scrollbar at ${viewport.width} × ${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const scroller = page.locator('.timeline-scroll');
    const overflow = () => scroller.evaluate((element) => element.scrollWidth - element.clientWidth);
    const slider = page.getByRole('slider', { name: 'Timeline zoom', exact: true });
    const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
    const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
    const fit = page.getByRole('button', { name: 'Fit', exact: true });

    await fit.click();
    expect(await overflow()).toBeLessThanOrEqual(0);

    // About 17 minutes, with a bookmark after the last clip.
    const long = sequence();
    long.layers[0]!.ripple = false;
    long.clips[2]!.start = 30000;
    long.bookmarks = [36000];
    await fixture(page, long);
    expect(await overflow()).toBeGreaterThan(0);
    await fit.click();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(zoomOut).toBeDisabled();
    await expect(zoomIn).toBeEnabled();
    expect(Number(await slider.getAttribute('min'))).toBeLessThan(12);
    const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
    expect(scale * 36000).toBeLessThan((await scroller.evaluate((element) => element.clientWidth)) - 96);
    expect(await page.locator('.ruler-tick').count()).toBeLessThan(20);

    await slider.fill('48');
    expect(await overflow()).toBeGreaterThan(0);
    await shortcut(page, 'f');
    await expect(zoomOut).toBeDisabled();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await slider.fill('12');
    await expect(zoomOut).toBeEnabled();
    for (let step = 0; step < 40 && (await zoomOut.isEnabled()); step++) await zoomOut.click();
    await expect(zoomOut).toBeDisabled();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
}

test('visible split then S selects each right piece, preserves boundaries and deletes without another selection', async ({
  page,
}) => {
  const document = dissolvedSequence();
  document.adjustments = [
    {
      ...adjustmentFrom0(200, [gradePoint(20, { exposure: 0.2 })]),
      color: { ...createColorSettings(), contrast: 1.25, saturation: 0.7, hue: 20 },
    },
  ];
  document.layers[0]!.transform.base.opacity = 0.65;
  document.layers[0]!.transform.keyframes = [transformPoint(400, { opacity: 0.8 }, 'hold')];
  await fixture(page, document);
  const before = await current(page);
  await seek(page, 30);
  await expect(page.locator('[aria-label="Clip editing actions"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Split at playhead', exact: true })).toBeVisible();
  await clipAction(page, 'Split at playhead');
  const first = await current(page);
  const rightId = first.clips[1]!.id;
  expect(first.clips[0]).toEqual({ ...before.clips[0]!, sourceOut: 45 });
  expect(first.clips[1]).toEqual({ ...before.clips[0]!, id: rightId, sourceIn: 45, start: 30 });
  expect(firstTrackGeometry(first)).toEqual([
    ['a', 0, 30, 30],
    [rightId, 30, 60, 90],
    ['b', 78, 60, 138],
    ['c', 132, 60, 192],
  ]);
  unchangedOthers(before, first, ['a'], {
    'video-1': [
      { leftId: 'a', rightId, type: 'cut', duration: 0 },
      { leftId: rightId, rightId: 'b', type: 'cross-dissolve', duration: 12 },
      before.layers[0]!.transitions[1]!,
    ],
  });
  await expect(clip(page, rightId).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await ready(page, first);
  await decodedSource(page, rightId, 45);
  await seek(page, 55);
  await shortcut(page, 's');
  const second = await current(page);
  const finalId = second.clips[2]!.id;
  expect(new Set(second.clips.map((item) => item.id)).size).toBe(5);
  expect(second.clips[1]).toEqual({ ...first.clips[1]!, sourceOut: 70 });
  expect(second.clips[2]).toEqual({ ...first.clips[1]!, id: finalId, sourceIn: 70, start: 55 });
  expect(firstTrackGeometry(second)).toEqual([
    ['a', 0, 30, 30],
    [rightId, 30, 25, 55],
    [finalId, 55, 35, 90],
    ['b', 78, 60, 138],
    ['c', 132, 60, 192],
  ]);
  const splitTransitions: Transition[] = [
    { leftId: 'a', rightId, type: 'cut', duration: 0 },
    { leftId: rightId, rightId: finalId, type: 'cut', duration: 0 },
    { leftId: finalId, rightId: 'b', type: 'cross-dissolve', duration: 12 },
    before.layers[0]!.transitions[1]!,
  ];
  expect(second.layers[0]!.transitions).toEqual(splitTransitions);
  unchangedOthers(before, second, ['a'], { 'video-1': splitTransitions });
  await expect(clip(page, finalId).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await ready(page, second);
  await decodedSource(page, finalId, 70);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(55);
  await expect(page.getByRole('button', { name: 'Split at playhead', exact: true })).toBeDisabled();
  await shortcut(page, 's');
  await expect(page.locator('.error-banner')).toContainText('Place the playhead inside the selected clip to split it.');
  expect(await current(page)).toEqual(second);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete selected clip', exact: true })).toBeVisible();
  await clipAction(page, 'Delete selected clip');
  const deleted = await current(page);
  expect(firstTrackGeometry(deleted)).toEqual([
    ['a', 0, 30, 30],
    [rightId, 30, 25, 55],
    ['b', 55, 60, 115],
    ['c', 109, 60, 169],
  ]);
  expect(deleted.clips).toEqual(
    second.clips
      .filter((item) => item.id !== finalId)
      .map((item) => ({ ...item, start: { a: 0, [rightId]: 30, b: 55, c: 109 }[item.id]! })),
  );
  unchangedOthers(before, deleted, ['a'], {
    'video-1': [
      { leftId: 'a', rightId, type: 'cut', duration: 0 },
      { leftId: rightId, rightId: 'b', type: 'cut', duration: 0 },
      before.layers[0]!.transitions[1]!,
    ],
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(second);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(first);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('Q and W retain the mapped displayed frame, ripple dissolves and recover both original endpoints', async ({
  page,
}) => {
  const document = dissolvedSequence();
  document.layers[0]!.openingFade = 5;
  document.clips[0]!.speed = { mode: 'constant', rate: 0.5 };
  document.adjustments = [
    adjustmentFrom0(600, [gradePoint(12, { exposure: 0.25 }), gradePoint(500, { hue: 30 }, 'smooth')]),
  ];
  await fixture(page, document);
  const before = await current(page);
  expect(firstTrackGeometry(before)).toEqual([
    ['a', 0, 180, 180],
    ['b', 168, 60, 228],
    ['c', 222, 60, 282],
  ]);
  await seek(page, 20);
  await decodedSource(page, 'a', 25);
  await shortcut(page, 'q');
  const headTrim = await current(page);
  expect(headTrim.clips[0]).toEqual({ ...before.clips[0]!, sourceIn: 25 });
  expect(firstTrackGeometry(headTrim)).toEqual([
    ['a', 0, 160, 160],
    ['b', 148, 60, 208],
    ['c', 202, 60, 262],
  ]);
  unchangedOthers(before, headTrim, ['a']);
  await ready(page, headTrim);
  await decodedSource(page, 'a', 25);
  await seek(page, 40);
  await decodedSource(page, 'a', 45);
  await shortcut(page, 'w');
  const bothTrimmed = await current(page);
  expect(bothTrimmed.clips[0]).toEqual({ ...headTrim.clips[0]!, sourceOut: 46 });
  expect(firstTrackGeometry(bothTrimmed)).toEqual([
    ['a', 0, 42, 42],
    ['b', 30, 60, 90],
    ['c', 84, 60, 144],
  ]);
  expect(bothTrimmed.layers[0]!.transitions).toEqual(before.layers[0]!.transitions);
  expect([bothTrimmed.layers[0]!.openingFade, bothTrimmed.layers[0]!.closingFade]).toEqual([5, 4]);
  unchangedOthers(before, bothTrimmed, ['a']);
  await ready(page, bothTrimmed);
  await decodedSource(page, 'a', 45);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(41);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(headTrim);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await current(page)).toEqual(bothTrimmed);
  const inHandle = clip(page, 'a').locator('[data-trim-handle="in"]');
  await inHandle.focus();
  await inHandle.press('Home');
  const restoredHead = await current(page);
  expect(restoredHead.clips[0]).toEqual({ ...bothTrimmed.clips[0]!, sourceIn: 0 });
  expect(firstTrackGeometry(restoredHead)).toEqual([
    ['a', 0, 92, 92],
    ['b', 80, 60, 140],
    ['c', 134, 60, 194],
  ]);
  const outHandle = clip(page, 'a').locator('[data-trim-handle="out"]');
  await outHandle.focus();
  await outHandle.press('End');
  const restored = await current(page);
  expect(restored.clips[0]).toEqual({ ...before.clips[0]!, sourceIn: 0, sourceOut: 120 });
  expect(firstTrackGeometry(restored)).toEqual([
    ['a', 0, 240, 240],
    ['b', 228, 60, 288],
    ['c', 282, 60, 342],
  ]);
  expect(restored.layers[0]!.transitions).toEqual(before.layers[0]!.transitions);
  unchangedOthers(before, restored, ['a']);
  for (const expected of [restoredHead, bothTrimmed, headTrim, before]) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await current(page)).toEqual(expected);
  }
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await ready(page, before);
  await flush(page);
  const saves = memory.saves;
  await seek(page, 0);
  await page.getByRole('button', { name: 'Trim end to playhead', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('Fade/transition regions overlap or exceed clip a.');
  expect(await current(page)).toEqual(before); // No fade reduction or hidden source clamping.
  await flush(page);
  expect(memory.saves).toBe(saves);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
});

test('I/O middle removal is transient then one edit, preserving absolute adjustment and Transform keyframes, music and overlays', async ({
  page,
  request,
}) => {
  const music = await fixtureMusic(request);
  const document = dissolvedSequence();
  document.adjustments = [
    {
      ...adjustmentFrom0(1100, [
        gradePoint(
          15,
          {
            temperature: 0.2,
            tint: -0.3,
            exposure: 0.3,
            brightness: 0.04,
            contrast: 1.1,
            hue: 20,
            saturation: 0.8,
            highlights: 0.2,
            shadows: -0.1,
          },
          'hold',
        ),
        gradePoint(1_000, { exposure: 0.6 }, 'smooth'),
      ]),
      color: { ...createColorSettings(), exposure: -0.2, saturation: 0.6 },
    },
  ];
  document.layers[0]!.transform.base.opacity = 0.65;
  document.layers[0]!.transform.keyframes = [transformPoint(15, { opacity: 0.7 }, 'hold')];
  const upper = createLayer('upper', 'Track 2', false);
  upper.transform.base.opacity = 0.75;
  upper.transform.keyframes = [transformPoint(200, { opacity: 0.6 }, 'ease-in')];
  document.layers.push(upper);
  const overlay = { ...createClip('fixed-overlay', assets[1]!.id, 0, 20), layerId: 'upper', start: 230 };
  overlay.grade.keyframes = [gradePoint(5, { hue: 35 }, 'ease-in')];
  document.clips.splice(1, 0, overlay);
  document.music = [
    singleClipLane({
      id: 'rush-music',
      mediaId: music.id,
      sourceIn: 10,
      sourceOut: 100,
      start: 25,
      duration: 180,
      gainDb: -9,
      fadeIn: 5,
      fadeOut: 10,
      loop: true,
    }),
  ];
  document.media.audioIds = [music.id];
  await fixture(page, document);
  const before = await current(page);
  const saves = memory.saves;

  // A valid range can still produce a transition-invalid result. Keep the range and the whole history atomically.
  await markRange(page, 0, 89);
  await expect(page.getByRole('button', { name: 'Delete selected range', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Delete selected range', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('Fade/transition regions overlap or exceed clip a.');
  await expectCutOverlay(page, 0, 89);
  expect(await current(page)).toEqual(before);
  await flush(page);
  expect(memory.saves).toBe(saves);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await shortcut(page, 'Escape');
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();

  await markRange(page, 20, 40);
  await expectCutOverlay(page, 20, 40);
  expect(await current(page)).toEqual(before);
  await flush(page);
  expect(memory.saves).toBe(saves);
  expect(memory.snapshot()).toEqual(before);
  await shortcut(page, 'Shift+Delete');
  const next = await current(page);
  const right = next.clips.find((item) => !before.clips.some((original) => original.id === item.id))!;
  expect(next.clips.map((item) => item.id)).toEqual(['a', right.id, 'fixed-overlay', 'b', 'c']);
  expect(next.clips[0]).toEqual({ ...before.clips[0]!, sourceOut: 35 });
  expect(right).toEqual({ ...before.clips[0]!, id: right.id, sourceIn: 55, start: 20 });
  expect(Object.keys(right)).toEqual(Object.keys(before.clips[0]!));
  expect(firstTrackGeometry(next)).toEqual([
    ['a', 0, 20, 20],
    [right.id, 20, 50, 70],
    ['b', 58, 60, 118],
    ['c', 112, 60, 172],
  ]);
  expect(firstTrackGeometry(next).at(-1)![3]).toBe(172);
  expect(calculateLayout(next).duration).toBe(250);
  const cutTransitions: Transition[] = [
    { leftId: 'a', rightId: right.id, type: 'cut', duration: 0 },
    { leftId: right.id, rightId: 'b', type: 'cross-dissolve', duration: 12 },
    before.layers[0]!.transitions[1]!,
  ];
  expect(next.layers[0]!.transitions).toEqual(cutTransitions);
  unchangedOthers(before, next, ['a'], { 'video-1': cutTransitions });
  expect([next.layers[0]!.openingFade, next.layers[0]!.closingFade]).toEqual([8, 4]);
  await expect(clip(page, right.id).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.timeline-ruler-range')).toHaveCount(0);
  await expect(page.locator('.timeline-cut-selection')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete selected range', exact: true })).toHaveCount(0);
  await flush(page);
  expect(memory.saves).toBe(saves + 1);
  expect(memory.snapshot()).toEqual({ ...next, revision: before.revision + 1 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await current(page)).toEqual(next);
  await selectClip(page, right.id);
  const out = page.getByRole('textbox', { name: 'Source OUT frame', exact: true });
  await out.fill('100');
  await out.press('Enter');
  const independent = await current(page);
  expect(independent.clips.find((item) => item.id === 'a')).toEqual(next.clips[0]);
  expect(independent.clips.find((item) => item.id === right.id)).toEqual({ ...right, sourceOut: 100 });
  unchangedOthers(before, independent, ['a'], { 'video-1': cutTransitions });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(next);
});

test('overlay middle cuts keep their gap and neighbors fixed; visible quick trims keep absolute placement semantics', async ({
  page,
}) => {
  const document = sequence();
  document.adjustments = [
    adjustmentFrom0(600, [gradePoint(10, { exposure: 0.2 }), gradePoint(500, { hue: 25 }, 'hold')]),
  ];
  const upper = createLayer('upper', 'Track 2', false);
  upper.transform.base.opacity = 0.8;
  upper.transform.keyframes = [transformPoint(10, { scale: 1.2 }), transformPoint(500, { rotation: 6 }, 'hold')];
  document.layers.push({
    ...upper,
    transitions: [
      { leftId: 'upper-before', rightId: 'top', type: 'cut', duration: 0 },
      { leftId: 'top', rightId: 'upper-after', type: 'cut', duration: 0 },
    ],
  });
  document.clips.push(
    { ...createClip('upper-before', assets[0]!.id, 0, 20), layerId: 'upper', start: 5 },
    { ...createClip('top', assets[1]!.id, 15, 105), layerId: 'upper', start: 40 },
    { ...createClip('upper-after', assets[0]!.id, 0, 20), layerId: 'upper', start: 140 },
  );
  await fixture(page, document);
  await selectClip(page, 'top');
  const before = await current(page);
  await expect(page.getByRole('button', { name: 'Toggle Ripple on Track 2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const firstTrackTop = await clip(page, 'a').evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.top),
  );
  const overlayTop = await clip(page, 'top').evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.top),
  );
  expect(overlayTop - firstTrackTop).toBe(78);
  await markRange(page, 60, 80);
  await expectCutOverlay(page, 60, 80);
  await page.getByRole('button', { name: 'Delete selected range', exact: true }).click();
  const cut = await current(page);
  const right = cut.clips.find((item) => !before.clips.some((original) => original.id === item.id))!;
  expect(cut.clips.find((item) => item.id === 'top')).toEqual({
    ...before.clips.find((item) => item.id === 'top')!,
    sourceOut: 35,
  });
  expect(right).toEqual({ ...before.clips.find((item) => item.id === 'top')!, id: right.id, sourceIn: 55, start: 80 });
  expect(
    calculateLayout(cut)
      .clips.filter((item) => item.clip.layerId === 'upper')
      .map((item) => [item.clip.id, item.start, item.duration, item.end]),
  ).toEqual([
    ['upper-before', 5, 20, 25],
    ['top', 40, 20, 60],
    [right.id, 80, 50, 130],
    ['upper-after', 140, 20, 160],
  ]);
  unchangedOthers(before, cut, ['top'], {
    upper: [
      { leftId: 'upper-before', rightId: 'top', type: 'cut', duration: 0 },
      { leftId: 'top', rightId: right.id, type: 'cut', duration: 0 },
      { leftId: right.id, rightId: 'upper-after', type: 'cut', duration: 0 },
    ],
  });
  expect(firstTrackGeometry(cut)).toEqual(firstTrackGeometry(before));
  expect(cut.layers[0]!.transitions).toEqual(before.layers[0]!.transitions);
  await expect(clip(page, right.id).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await selectClip(page, 'top');
  await seek(page, 60);
  await page.getByRole('button', { name: 'Trim start to playhead', exact: true }).click();
  const headTrim = await current(page);
  expect(headTrim.clips.find((item) => item.id === 'top')).toEqual({
    ...before.clips.find((item) => item.id === 'top')!,
    sourceIn: 35,
    start: 60,
  });
  expect(calculateLayout(headTrim).clips.find((item) => item.clip.id === 'top')).toMatchObject({
    start: 60,
    duration: 70,
    end: 130,
  });
  unchangedOthers(before, headTrim, ['top']);
  await ready(page, headTrim);
  await seek(page, 80);
  await page.getByRole('button', { name: 'Trim end to playhead', exact: true }).click();
  const bothTrimmed = await current(page);
  expect(bothTrimmed.clips.find((item) => item.id === 'top')).toEqual({
    ...headTrim.clips.find((item) => item.id === 'top')!,
    sourceOut: 56,
  });
  expect(calculateLayout(bothTrimmed).clips.find((item) => item.clip.id === 'top')).toMatchObject({
    start: 60,
    duration: 21,
    end: 81,
  });
  unchangedOthers(before, bothTrimmed, ['top']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(headTrim);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('prefix, suffix and whole Ripple track cuts retain only necessary IDs and undo once, including an empty track with dormant fades', async ({
  page,
}) => {
  const document = dissolvedSequence();
  document.layers[0]!.transform.keyframes = [transformPoint(20, { opacity: 0.7 })];
  document.adjustments = [adjustmentFrom0(900, [gradePoint(800, { exposure: 0.5 }, 'hold')])];
  const cases = [
    { name: 'prefix', inFrame: 0, outFrame: 20, sourceIn: 35, sourceOut: 105 },
    { name: 'suffix', inFrame: 70, outFrame: 90, sourceIn: 15, sourceOut: 85 },
    { name: 'whole', inFrame: 0, outFrame: 90, sourceIn: null, sourceOut: null },
  ];
  for (const scenario of cases) {
    await fixture(page, document);
    const before = await current(page);
    const saves = memory.saves;
    await markRange(page, scenario.inFrame, scenario.outFrame, scenario.name === 'suffix');
    await expectCutOverlay(page, scenario.inFrame, scenario.outFrame);
    await page.getByRole('button', { name: 'Delete selected range', exact: true }).click();
    const next = await current(page);
    expect(
      next.clips.every((item) => before.clips.some((original) => original.id === item.id)),
      scenario.name,
    ).toBe(true);
    if (scenario.sourceIn === null) {
      expect(next.clips).toEqual([
        { ...before.clips[1]!, start: 0 },
        { ...before.clips[2]!, start: 54 },
      ]);
      expect(firstTrackGeometry(next)).toEqual([
        ['b', 0, 60, 60],
        ['c', 54, 60, 114],
      ]);
      expect(next.layers[0]!.transitions).toEqual([before.layers[0]!.transitions[1]]);
      await expect(clip(page, 'b').locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
    } else {
      expect(next.clips[0]).toEqual({
        ...before.clips[0]!,
        sourceIn: scenario.sourceIn,
        sourceOut: scenario.sourceOut,
      });
      expect(firstTrackGeometry(next)).toEqual([
        ['a', 0, 70, 70],
        ['b', 58, 60, 118],
        ['c', 112, 60, 172],
      ]);
      expect(next.layers[0]!.transitions).toEqual(before.layers[0]!.transitions);
      await expect(clip(page, 'a').locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
    }
    unchangedOthers(before, next, ['a'], {
      'video-1': scenario.sourceIn === null ? [before.layers[0]!.transitions[1]!] : before.layers[0]!.transitions,
    });
    expect([next.layers[0]!.openingFade, next.layers[0]!.closingFade]).toEqual([8, 4]);
    await flush(page);
    expect(memory.saves).toBe(saves + 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await current(page)).toEqual(before);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  }
  const only = createProject(PROJECT_ID, 'Only excerpt · memory-only');
  only.media.videoIds = assets.map((asset) => asset.id);
  only.clips = [createClip('a', assets[0]!.id, 15, 105)];
  only.layers[0]!.transform = structuredClone(document.layers[0]!.transform);
  only.adjustments = structuredClone(document.adjustments);
  only.layers[0]!.openingFade = 8;
  only.layers[0]!.closingFade = 4;
  await fixture(page, only);
  const before = await current(page);
  await markRange(page, 0, 90);
  await shortcut(page, 'Shift+Delete');
  const empty = await current(page);
  expect(empty.clips).toEqual([]);
  expect(empty.layers[0]!.transitions).toEqual([]);
  expect([empty.layers[0]!.openingFade, empty.layers[0]!.closingFade]).toEqual([8, 4]);
  expect(empty.layers).toEqual(before.layers);
  expect(empty.adjustments).toEqual(before.adjustments);
  await ready(page, empty);
  await expect(page.getByRole('button', { name: 'Delete selected clip', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('missing, outside and empty ranges are rejected; click and Escape restore; input and source shortcuts cannot leak timeline edits', async ({
  page,
}) => {
  const before = await current(page);
  const cut = page.getByRole('button', { name: 'Delete selected range', exact: true });
  const ruler = page.getByLabel('Timeline ruler', { exact: true });
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const rulerX = async (frame: number): Promise<number> => (await frameOrigin(page)) + frame * scale;
  const rulerY = async (): Promise<number> => {
    const box = (await ruler.boundingBox())!;
    return box.y + box.height - 6;
  };
  const playhead = (): Promise<number> => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  await expect(cut).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete selected clip', exact: true })).toBeEnabled();
  for (const name of ['Mark cut IN', 'Mark cut OUT'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await seek(page, 20);
  await shortcut(page, 'i');
  await shortcut(page, 'o');
  await expect(rulerRange(page)).toHaveCount(0);

  // Clip a (0–90) is selected; a range over clip b only cannot cut a.
  await markRange(page, 100, 140, true);
  await expect.poll(playhead).toBe(100);
  await expect(page.locator('.timeline-cut-selection')).toHaveCount(0);
  await expect(cut).toBeDisabled();
  await expect(cut).toHaveAttribute('title', 'The selected range is outside the selected clip.');
  await shortcut(page, 'Shift+Delete');
  await expect(page.locator('.error-banner')).toContainText('The selected range is outside the selected clip.');
  expect(await current(page)).toEqual(before);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  // The range is independent of the clip: selecting the overlapped clip enables Cut range.
  await selectClip(page, 'b');
  await expectCutOverlay(page, 100, 140);
  await expect(cut).toBeEnabled();
  await selectClip(page, 'a');
  await expect(page.locator('.timeline-cut-selection')).toHaveCount(0);
  await expect(rulerRange(page)).toHaveAttribute('data-range-in', '100');

  // A plain click seeks and clears the range.
  await page.mouse.click(await rulerX(50), await rulerY());
  await expect(rulerRange(page)).toHaveCount(0);
  await expect.poll(playhead).toBe(50);
  await expect(cut).toHaveCount(0);

  // Dragging back to the starting frame selects nothing.
  await page.keyboard.down('Alt');
  await page.mouse.move(await rulerX(60), await rulerY());
  await page.mouse.down();
  await page.mouse.move(await rulerX(75), await rulerY(), { steps: 3 });
  await expect(rulerRange(page)).toHaveAttribute('data-range-out', '75');
  await expect(page.locator('.timeline-ruler-range-readout')).toHaveText('00:02:00 – 00:02:15');
  await page.mouse.move(await rulerX(60), await rulerY(), { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(rulerRange(page)).toHaveCount(0);

  // Escape cancels a drag, restoring the previous range and playhead without an edit.
  await markRange(page, 20, 31);
  await expectCutOverlay(page, 20, 31);
  await expect(page.locator('.timeline-ruler-range-readout')).toHaveText('00:00:20 – 00:01:01');
  // The readout sits inside the band, cut short there, never over the adjustment track below.
  const band = (await rulerRange(page).boundingBox())!;
  const readout = (await page.locator('.timeline-ruler-range-readout').boundingBox())!;
  expect(readout.x).toBeGreaterThanOrEqual(band.x);
  expect(readout.x + readout.width).toBeLessThanOrEqual(band.x + band.width + 0.5);
  expect(readout.y + readout.height).toBeLessThanOrEqual(band.y + band.height + 0.5);
  await page.keyboard.down('Alt');
  await page.mouse.move(await rulerX(60), await rulerY());
  await page.mouse.down();
  await page.mouse.move(await rulerX(80), await rulerY(), { steps: 3 });
  await expectCutOverlay(page, 60, 80);
  await expect.poll(playhead).toBe(79);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expectCutOverlay(page, 20, 31);
  await expect.poll(playhead).toBe(30);
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  // With a range selected, the start/end buttons and Home/End go to the range edges.
  await page.getByRole('button', { name: 'Go to selection start', exact: true }).click();
  await expect.poll(playhead).toBe(20);
  await page.getByRole('button', { name: 'Go to selection end', exact: true }).click();
  await expect.poll(playhead).toBe(30);
  await shortcut(page, 'Home');
  await expect.poll(playhead).toBe(20);
  await shortcut(page, 'End');
  await expect.poll(playhead).toBe(30);
  await expectCutOverlay(page, 20, 31);
  const keys = ['i', 'o', 'q', 'w', 's', 'Shift+Delete'];
  const input = page.getByRole('textbox', { name: 'Source IN frame', exact: true });
  await input.fill('00:00:15');
  await input.press('End');
  for (const key of keys) await input.press(key);
  await expect(input).toHaveValue('00:00:15ioqws');
  expect(await current(page)).toEqual(before);
  await input.press('Escape');
  await expect(input).toHaveValue('00:00:15');
  await expectCutOverlay(page, 20, 31);
  expect(await current(page)).toEqual(before);
  const search = page.getByRole('textbox', { name: 'Search media', exact: true });
  await search.focus();
  for (const key of keys) await search.press(key);
  expect(await current(page)).toEqual(before);
  await expectCutOverlay(page, 20, 31);
  await search.fill('');

  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 10);
  const sourceFocus = page.getByRole('button', { name: 'Review source frame of pattern-a.mp4', exact: true });
  await sourceFocus.focus();
  await sourceFocus.press('i');
  await sourceFrame(page, 29);
  await sourceFocus.focus();
  await sourceFocus.press('o');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '10');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '30');
  for (const key of ['q', 'w', 's', 'Shift+Delete']) await sourceFocus.press(key);
  const sourceInput = page.getByRole('spinbutton', { name: 'Source IN', exact: true });
  await sourceInput.focus();
  for (const key of keys) await sourceInput.press(key);
  await expect(sourceInput).toHaveValue('10');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '30');
  await expectCutOverlay(page, 20, 31);
  expect(timelineOf(await current(page))).toEqual(timelineOf(before));
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(30);
  await expectOnlyRangesSaved(page);
  await expect(page.locator('.source-add-feedback')).not.toHaveAttribute('data-added-clip-id', /./);
});

test('Play covers only the selected range: from IN or inside it, stopping on its last frame', async ({ page }) => {
  const before = await current(page);
  const play = page.getByRole('button', { name: 'Play preview', exact: true });
  const played = async (): Promise<{ first: number; last: number }> => {
    await page.evaluate(() => {
      const frames: number[] = [];
      Object.assign(globalThis, { rangeFrames: frames });
      window.pascapLab!.engine.subscribe((state) => {
        if (state.playing) frames.push(state.frame);
      });
    });
    await play.click();
    const frames = (): Promise<number[]> =>
      page.evaluate(() => (globalThis as unknown as { rangeFrames: number[] }).rangeFrames);
    await expect.poll(async () => (await frames()).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()), { timeout: 15_000 })
      .toMatchObject({ playing: false, status: 'paused', frame: 30 });
    const seen = await frames();
    return { first: Math.min(...seen), last: Math.max(...seen) };
  };
  await markRange(page, 20, 31);
  await expect(play).toHaveAttribute('title', 'Play the selected range or pause (Space)');
  // The drag left the playhead on the last frame, so Play restarts at IN.
  const fromIn = await played();
  expect(fromIn.first).toBeGreaterThanOrEqual(20);
  expect(fromIn.first).toBeLessThan(25);
  expect(fromIn.last).toBeLessThanOrEqual(30);
  await seek(page, 25);
  const inside = await played();
  expect(inside.first).toBeGreaterThanOrEqual(25);
  await seek(page, 60);
  expect((await played()).first).toBeLessThan(25);
  await expect(rulerRange(page)).toHaveAttribute('data-range-out', '31');
  expect(await current(page)).toEqual(before);

  await shortcut(page, 'Escape');
  await expect(play).toHaveAttribute('title', 'Play or pause (Space)');
  await seek(page, 20);
  await play.click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBeGreaterThan(31);
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
});

test('Play pressed while playback settles on its last frame restarts from the range IN, or the timeline start', async ({
  page,
}) => {
  // Withhold the decode of the settling last frame, so Play arrives while that seek is still pending.
  const replayWhileSettling = async (last: number, other: number): Promise<number> => {
    await seek(page, other);
    await page.evaluate((frame) => {
      const replayed: number[] = [];
      Object.assign(globalThis, { replayed });
      window.pascapLab!.engine.subscribe((diagnostics) => {
        if (diagnostics.playing) replayed.push(diagnostics.frame);
      });
      window.videoFrameGate.hold = true;
      void window.pascapLab!.engine.seek(frame);
    }, last);
    await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().status)).toBe('seeking');
    await page.getByRole('button', { name: 'Play preview', exact: true }).click();
    await page.evaluate(() => window.videoFrameGate.release());
    const replayed = (): Promise<number[]> =>
      page.evaluate(() => (globalThis as unknown as { replayed: number[] }).replayed);
    await expect.poll(async () => (await replayed()).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.evaluate(() => window.pascapLab!.engine.pause());
    return Math.min(...(await replayed()));
  };
  await markRange(page, 20, 31);
  const range = await replayWhileSettling(30, 25);
  expect(range).toBeGreaterThanOrEqual(20);
  expect(range).toBeLessThan(25);

  await shortcut(page, 'Escape');
  const duration = calculateLayout(await current(page)).duration;
  expect(await replayWhileSettling(duration - 1, duration - 20)).toBeLessThan(5);
});

test('clear, Escape, timing, Undo and project switching invalidate only the transient range; clip selection keeps it', async ({
  page,
}) => {
  const before = await current(page);
  await markRange(page, 10, 20);
  await selectClip(page, 'b');
  await expect(rulerRange(page)).toHaveAttribute('data-range-in', '10');
  await expect(page.locator('.timeline-cut-selection')).toHaveCount(0);
  await selectClip(page, 'a');
  await expectCutOverlay(page, 10, 20);
  await shortcut(page, 'Escape');
  await expect(rulerRange(page)).toHaveCount(0);
  await markRange(page, 10, 20);
  await shortcut(page, 'Escape');
  await expect(rulerRange(page)).toHaveCount(0);
  await markRange(page, 10, 20);
  const input = page.getByRole('textbox', { name: 'Source IN frame', exact: true });
  await input.fill('20');
  await input.press('Enter');
  await expect(rulerRange(page)).toHaveCount(0);
  await ready(page, await current(page));
  await markRange(page, 10, 20);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(rulerRange(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await ready(page, before);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 12, 24);
  await markRange(page, 10, 20);
  const other = createProject('browser-rush-second', 'Other rush · memory-only');
  other.media.videoIds = assets.map((asset) => asset.id);
  other.clips = [createClip('other-a', assets[0]!.id, 0, 120)];
  other.adjustments = [adjustmentFrom0(120, [gradePoint(40, { exposure: 0.4 }, 'hold')])];
  memory.seed(other);
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.getByRole('button', { name: `Open ${other.title}`, exact: true }).click();
  await ready(page, other);
  expect(await current(page)).toEqual(other);
  await expect(rulerRange(page)).toHaveCount(0);
  await expect(page.locator('.source-review')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '0');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '120');
  expect(memory.snapshot(other.id)).toEqual(other);
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.getByRole('button', { name: `Open ${before.title}`, exact: true }).click();
  await ready(page, memory.snapshot());
  expect(await current(page)).toEqual(memory.snapshot());
  expect(memory.snapshot().clips).toEqual(before.clips);
  expect(memory.snapshot().layers).toEqual(before.layers);
  await expect(rulerRange(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '12');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '24');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('transition and fade edits keep the range at its project frames; Cut range then removes exactly it', async ({
  page,
}) => {
  const before = await current(page);
  // Clip c starts at 150 until the dissolve below moves it to 120.
  await markRange(page, 150, 180);
  await page.locator('.boundary-button').first().click();
  await page.getByRole('combobox', { name: 'Transition type', exact: true }).selectOption('cross-dissolve');
  const dissolved = await current(page);
  expect(dissolved.layers[0]!.transitions[0]).toEqual({
    leftId: 'a',
    rightId: 'b',
    type: 'cross-dissolve',
    duration: 30,
  });
  expect(firstTrackGeometry(dissolved).map(([id, start]) => [id, start])).toEqual([
    ['a', 0],
    ['b', 60],
    ['c', 120],
  ]);
  await expect(rulerRange(page)).toHaveAttribute('data-range-in', '150');
  await expect(rulerRange(page)).toHaveAttribute('data-range-out', '180');
  await expect(page.locator('.timeline-ruler-range-readout')).toHaveText('00:05:00 – 00:06:00');
  const opening = page.getByRole('spinbutton', { name: 'Opening fade', exact: true });
  await opening.fill('8');
  await opening.press('Enter');
  const faded = await current(page);
  expect(faded.layers[0]!.openingFade).toBe(8);
  await expect(rulerRange(page)).toHaveAttribute('data-range-in', '150');
  await selectClip(page, 'c');
  await expectCutOverlay(page, 150, 180);
  await shortcut(page, 'Shift+Delete');
  expect(await current(page)).toEqual(
    applyCommand(faded, removeSelectedRange(faded, 'c', { inFrame: 150, outFrame: 180 }, 'unused')),
  );
  // One Undo per edit; Undo clears the range.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(faded);
  await expect(rulerRange(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(dissolved);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('Keep the cut in place lengthens both clips so the dissolve leaves later clips where they are', async ({
  page,
}) => {
  const before = await current(page);
  await page.locator('.boundary-button').first().click();
  await page.getByRole('checkbox', { name: 'Keep the cut in place', exact: true }).check();
  await page.getByRole('combobox', { name: 'Transition type', exact: true }).selectOption('cross-dissolve');
  const dissolved = await current(page);
  expect(dissolved).toEqual(
    applyCommand(before, {
      type: 'transition',
      transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 30 },
      keepCut: true,
    }),
  );
  // a gains 15 frames at its end and b 15 at its start: c still starts at 150.
  expect(firstTrackGeometry(dissolved).map(([id, start]) => [id, start])).toEqual([
    ['a', 0],
    ['b', 75],
    ['c', 150],
  ]);
  expect(dissolved.clips.map((clip) => [clip.id, clip.sourceIn, clip.sourceOut])).toEqual([
    ['a', 15, 120],
    ['b', 15, 90],
    ['c', 60, 120],
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

test('native first-clip edge autoscroll restores a head longer than 32px without a start jump or draft save', async ({
  page,
}) => {
  await fixture(page, omittedHeadSequence());
  const before = await current(page);
  const saves = memory.saves;
  const drag = await beginHeadTrim(page);
  expect(await current(page)).toEqual(before);
  await flush(page);
  expect(memory.saves).toBe(saves);
  await page.mouse.move(drag.edgeX, drag.y, { steps: 4 });
  await expect
    .poll(() => page.getByRole('textbox', { name: 'Source IN frame', exact: true }).inputValue())
    .toBe('00:00:00');
  await expect(clip(page, 'a').locator('[data-trim-handle="in"]')).toHaveAttribute('aria-valuenow', '0');
  expect(await current(page)).toEqual(before); // Inspector shows a draft; committed sourceIn is still 90.
  await flush(page);
  expect(memory.saves).toBe(saves);
  await page.mouse.up();
  const next = await current(page);
  expect(next.clips[0]).toEqual({ ...before.clips[0]!, sourceIn: 0 });
  unchangedOthers(before, next, ['a']);
  expect(firstTrackGeometry(next)).toEqual([
    ['a', 0, 120, 120],
    ['b', 120, 30, 150],
    ['c', 150, 30, 180],
  ]);
  expect(calculateLayout(next).duration).toBe(180);
  await expect(page.locator('.timeline-surface')).toHaveAttribute('data-leading', '32');
  await expect
    .poll(() => page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft))
    .toBe(drag.scrollLeft);
  await expect.poll(() => frameOrigin(page)).toBe(drag.origin);
  await ready(page, next);
  await decodedSource(page, 'a', 0);
  await flush(page);
  expect(memory.saves).toBe(saves + 1);
  expect(memory.snapshot()).toEqual({ ...next, revision: before.revision + 1 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('Escape and pointercancel discard native autoscrolled head drafts and restore the document, origin and scroll', async ({
  page,
}) => {
  for (const cancellation of ['Escape', 'pointercancel'] as const) {
    await fixture(page, omittedHeadSequence());
    const before = await current(page);
    const saves = memory.saves;
    const drag = await beginHeadTrim(page);
    await page.mouse.move(drag.edgeX, drag.y, { steps: 4 });
    await expect
      .poll(() => page.getByRole('textbox', { name: 'Source IN frame', exact: true }).inputValue())
      .toBe('00:00:00');
    expect(await current(page)).toEqual(before);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else
      await clip(page, 'a')
        .locator('[data-trim-handle="in"]')
        .dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
    await page.mouse.up();
    await expect(page.locator('.timeline-surface')).not.toHaveClass(/trim-drafting/);
    await expect(page.locator('.timeline-surface')).toHaveAttribute('data-leading', '32');
    await expect(page.getByRole('textbox', { name: 'Source IN frame', exact: true })).toHaveValue('00:03:00');
    await expect
      .poll(() => page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft))
      .toBe(drag.scrollLeft);
    await expect.poll(() => frameOrigin(page)).toBe(drag.origin);
    expect(await current(page)).toEqual(before);
    await ready(page, before);
    await flush(page);
    expect(memory.saves).toBe(saves);
    expect(memory.snapshot()).toEqual(before);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  }
});

test('native reorder of a cut excerpt commits its post-removal ripple ghost and subsequent trim realigns no clips manually', async ({
  page,
}) => {
  let document = sequence();
  document.clips[0] = { ...document.clips[0]!, sourceIn: 0, sourceOut: 120 };
  document.adjustments = [
    adjustmentFrom0(600, [gradePoint(10, { exposure: 0.2 }), gradePoint(500, { hue: 20 }, 'hold')]),
  ];
  document = applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'b', rightId: 'c', type: 'cross-dissolve', duration: 8 },
  });
  await fixture(page, document);
  const before = await current(page);
  await markRange(page, 30, 60);
  await shortcut(page, 'Shift+Delete');
  const cut = await current(page);
  const rightId = cut.clips[1]!.id;
  expect(firstTrackGeometry(cut)).toEqual([
    ['a', 0, 30, 30],
    [rightId, 30, 60, 90],
    ['b', 90, 60, 150],
    ['c', 142, 60, 202],
  ]);
  expect(cut.clips[0]).toEqual({ ...before.clips[0]!, sourceOut: 30 });
  expect(cut.clips[1]).toEqual({ ...before.clips[0]!, id: rightId, sourceIn: 60, start: 30 });
  await ready(page, cut);
  const moving = clip(page, rightId);
  await moving.scrollIntoViewIfNeeded();
  const box = (await moving.boundingBox())!;
  const lane = (await page.locator('[data-layer-lane="video-1"]').boundingBox())!;
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const origin = await frameOrigin(page);
  const scrollBefore = await page
    .locator('.timeline-scroll')
    .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  const grab = 12;
  await page.keyboard.down('Alt'); // Ripple is a track setting; Alt cannot turn it into arbitrary placement.
  await page.mouse.move(box.x + grab * scale, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + grab * scale + 12, box.y + 30, { steps: 3 });
  await page.mouse.move(origin + (150 + grab) * scale, lane.y + 38, { steps: 8 });
  await page.mouse.move(origin + (150 + grab) * scale, lane.y + 38);
  const ghost = page.locator('.timeline-drop-preview');
  await expect(ghost).toBeVisible();
  await expect(ghost).toContainText('Ripple insert');
  await expect(ghost).toHaveAttribute('data-drop-layer', 'video-1');
  await expect(ghost).toHaveAttribute('data-drop-valid', 'true');
  await expect(ghost).toHaveAttribute('data-drop-start', '142'); // Tail after removing the grabbed 60-frame excerpt, not old tail 202.
  expect(await current(page)).toEqual(cut);
  expect(
    await page
      .locator('.timeline-scroll')
      .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })),
  ).toEqual(scrollBefore);
  const plannedStart = Number(await ghost.getAttribute('data-drop-start'));
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const reordered = await current(page);
  expect(layerClips(reordered, 'video-1').map((item) => item.id)).toEqual(['a', 'b', 'c', rightId]);
  expect(calculateLayout(reordered).clips.find((item) => item.clip.id === rightId)?.start).toBe(plannedStart);
  expect(firstTrackGeometry(reordered)).toEqual([
    ['a', 0, 30, 30],
    ['b', 30, 60, 90],
    ['c', 82, 60, 142],
    [rightId, 142, 60, 202],
  ]);
  expect(reordered.clips.find((item) => item.id === rightId)).toEqual({ ...cut.clips[1]!, start: 142 });
  const reorderedTransitions: Transition[] = [
    { leftId: 'a', rightId: 'b', type: 'cut', duration: 0 },
    before.layers[0]!.transitions[1]!,
    { leftId: 'c', rightId, type: 'cut', duration: 0 },
  ];
  expect(reordered.layers[0]!.transitions).toEqual(reorderedTransitions);
  unchangedOthers(cut, reordered, [rightId], { 'video-1': reorderedTransitions });
  await selectClip(page, 'a');
  const handle = clip(page, 'a').locator('[data-trim-handle="out"]');
  await handle.focus();
  await handle.press('Shift+ArrowLeft');
  const trimmed = await current(page);
  expect(trimmed.clips[0]).toEqual({ ...reordered.clips[0]!, sourceOut: 20 });
  unchangedOthers(reordered, trimmed, ['a']);
  expect(firstTrackGeometry(trimmed)).toEqual([
    ['a', 0, 20, 20],
    ['b', 20, 60, 80],
    ['c', 72, 60, 132],
    [rightId, 132, 60, 192],
  ]);
  expect(calculateLayout(trimmed).duration).toBe(192);
  for (const expected of [reordered, cut, before]) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await current(page)).toEqual(expected);
  }
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('an overlapping source Add clears stale success feedback but keeps the source, range, frame and previous edit', async ({
  page,
}) => {
  const document = sequence();
  const upper = createLayer('upper', 'Track 2', false);
  upper.transform.keyframes = [transformPoint(10, { opacity: 0.8 }), transformPoint(500, { scale: 1.2 }, 'hold')];
  document.layers.push({
    ...upper,
    transitions: [{ leftId: 'top', rightId: 'occupied', type: 'cut', duration: 0 }],
  });
  document.clips.push(
    { ...createClip('top', assets[0]!.id, 15, 45), layerId: 'upper', start: 20 },
    { ...createClip('occupied', assets[1]!.id, 0, 30), layerId: 'upper', start: 50 },
  );
  await fixture(page, document);
  await selectClip(page, 'top');
  await seek(page, 80);
  const before = await current(page);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 10, 30);
  await sourceFrame(page, 29);
  const decoder = await page.locator('canvas[data-source-decoder]').elementHandle();
  const addedId = await addExcerpt(page);
  const added = await current(page);
  expect(added.clips.at(-1)).toEqual({ ...createClip(addedId, assets[0]!.id, 10, 30), layerId: 'upper', start: 80 });
  unchangedOthers(before, added, [], {
    upper: [
      { leftId: 'top', rightId: 'occupied', type: 'cut', duration: 0 },
      { leftId: 'occupied', rightId: addedId, type: 'cut', duration: 0 },
    ],
  });
  await ready(page, added);
  await flush(page);
  const saves = memory.saves;
  const excerptCount = added.clips.filter((item) => item.mediaId === assets[0]!.id).length;
  await seek(page, 30); // Direct engine navigation does not close the independent source viewer.
  await page.getByRole('button', { name: ADD_EXCERPT }).click();
  await expect(page.locator('.error-banner')).toContainText(
    'Clips on the same track cannot overlap except in an exact adjacent cross-dissolve.',
  );
  await expect(page.locator('.source-add-feedback')).toHaveText('');
  await expect(page.locator('.source-add-feedback')).not.toHaveAttribute('data-added-clip-id', /./);
  await expect(page.getByRole('region', { name: 'Source review', exact: true })).toBeVisible();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-media-id', assets[0]!.id);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '29');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '10');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '30');
  await expect(page.locator('.source-review')).toHaveAttribute('data-source-excerpt-count', String(excerptCount));
  expect(
    await page.locator('canvas[data-source-decoder]').evaluate((canvas, original) => canvas === original, decoder),
  ).toBe(true);
  expect(await current(page)).toEqual(added);
  await flush(page);
  expect(memory.saves).toBe(saves);
  expect(memory.snapshot().clips).toEqual(added.clips);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(timelineOf(await current(page))).toEqual(timelineOf(before));
});

test('source proxy Play/Pause advances decoded frames and stops at exclusive OUT without project edits', async ({
  page,
}) => {
  const before = await current(page);
  await seek(page, 30);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 12, 72);
  await sourceFrame(page, 5);
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  await expect
    .poll(async () => Number(await page.locator('.source-preview').getAttribute('data-source-frame')))
    .toBeGreaterThan(16);
  await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  const paused = Number(await page.locator('.source-preview').getAttribute('data-source-frame'));
  expect(paused).toBeGreaterThanOrEqual(12);
  expect(paused).toBeLessThan(72);
  await page.getByRole('button', { name: 'Play source preview', exact: true }).press('Space');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '71');
  await expect(page.locator('canvas[data-source-decoder]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Play source preview', exact: true }).press('Enter');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  const sourceFrameNow = async (): Promise<number> =>
    Number(await page.locator('.source-preview').getAttribute('data-source-frame'));
  // Restarting after OUT − 1 replaces the last image with IN or a later frame.
  await expect.poll(sourceFrameNow).toBeLessThan(71);
  expect(await sourceFrameNow()).toBeGreaterThanOrEqual(12);
  await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  expect(timelineOf(await current(page))).toEqual(timelineOf(before));
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(30);
  await expectOnlyRangesSaved(page);
});

test('Space plays and pauses the displayed preview: the source preview on its tab, the timeline otherwise', async ({
  page,
}) => {
  const before = await current(page);
  await seek(page, 30);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 12, 72);
  await sourceFrame(page, 20);
  const source = page.locator('.source-preview');
  const timelinePlaying = () => page.evaluate(() => window.pascapLab!.engine.diagnostics().playing);
  for (const control of [
    page.getByRole('button', { name: 'Review source frame of pattern-a.mp4', exact: true }),
    page.getByRole('tab', { name: 'Source preview', exact: true }),
  ]) {
    await control.click();
    await page.keyboard.press('Space');
    await expect(source).toHaveAttribute('data-source-status', 'playing');
    expect(await timelinePlaying()).toBe(false);
    await page.keyboard.press('Space');
    await expect(source).toHaveAttribute('data-source-status', 'paused');
  }
  await page.getByRole('tab', { name: 'Timeline preview', exact: true }).click();
  await page.keyboard.press('Space');
  await expect.poll(timelinePlaying).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(timelinePlaying).toBe(false);
  expect(timelineOf(await current(page))).toEqual(timelineOf(before));
  await expectOnlyRangesSaved(page);
});

for (const action of ['scrub', 'mark', 'apply', 'reset', 'trim'] as const) {
  test(`source ${action} pauses proxy playback without a timeline edit`, async ({ page }) => {
    const before = await current(page);
    await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
    await sourceRange(page, 10, 110);
    await sourceFrame(page, 20);
    await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
    if (action === 'scrub') await sourceFrame(page, 60);
    if (action === 'mark') await page.getByRole('button', { name: 'Review source frame of pattern-a.mp4' }).press('o');
    if (action === 'apply') await sourceRange(page, 30, 100);
    if (action === 'reset') await page.getByRole('slider', { name: 'Trim source start', exact: true }).press('Home');
    if (action === 'trim')
      await page.getByRole('slider', { name: 'Trim source start', exact: true }).press('ArrowRight');
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
    expect(timelineOf(await current(page))).toEqual(timelineOf(before));
    await expectOnlyRangesSaved(page);
  });
}

test('a one-frame source range remains exact; an Escape-canceled numeric draft is not played or inserted', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 50, 51);
  await sourceFrame(page, 0);
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('10');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('100');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).press('Escape');
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '50');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue('50');
  const id = await addExcerpt(page);
  expect((await current(page)).clips.find((clip) => clip.id === id)).toMatchObject({ sourceIn: 50, sourceOut: 51 });
});

test('Reset source range restores the whole recording, clears drafts and keeps the frame without project edits', async ({
  page,
}) => {
  const before = await current(page);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  const reset = page.getByRole('button', { name: 'Reset source range', exact: true });
  const count = String(assets[0]!.metadata.frameCount);
  await expect(reset).toHaveAttribute('aria-disabled', 'true');
  await expect(reset).toHaveAttribute('title', 'The range already covers the whole recording.');
  await sourceRange(page, 20, 60);
  await sourceFrame(page, 30);
  await expect(reset).toHaveAttribute('aria-disabled', 'false');
  // An invalid unapplied draft is replaced, with no stale error.
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('10');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).press('Enter');
  await expect(page.locator('.source-range-error')).toBeVisible();
  await reset.click();
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '0');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', count);
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue('0');
  await expect(page.getByRole('spinbutton', { name: 'Source OUT', exact: true })).toHaveValue(count);
  await expect(page.locator('.source-range-error')).toHaveCount(0);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '30');
  await expect(reset).toHaveAttribute('aria-disabled', 'true');
  // At the whole recording, a pending draft still makes Reset useful.
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('5');
  await expect(reset).toHaveAttribute('aria-disabled', 'false');
  await reset.click();
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
  const id = await addExcerpt(page);
  expect((await current(page)).clips.find((clip) => clip.id === id)).toMatchObject({
    sourceIn: 0,
    sourceOut: Number(count),
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

for (const action of ['pause', 'scrub', 'tab', 'asset', 'project', 'close'] as const) {
  test(`a source playback withheld before its first frame across ${action} never restarts an obsolete viewer`, async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
    await sourceFrame(page, 20);
    await page.evaluate(() => {
      window.videoFrameGate.hold = true;
    });
    await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'starting');
    await page.waitForFunction(() => window.videoFrameGate.heldFrames > 0);
    if (action === 'pause') await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
    if (action === 'scrub') await page.getByRole('slider', { name: 'Source playhead', exact: true }).fill('55');
    if (action === 'tab') await page.getByRole('tab', { name: 'Timeline preview', exact: true }).click();
    if (action === 'asset') await page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true }).click();
    if (action === 'project') {
      const other = createProject('browser-source-cancellation', 'Other source review · memory-only');
      other.media.videoIds = assets.map((asset) => asset.id);
      memory.seed(other);
      await page.getByRole('button', { name: 'Open projects', exact: true }).click();
      await page.getByRole('button', { name: `Open ${other.title}`, exact: true }).click();
      await ready(page, other);
    }
    if (action === 'close') await page.getByRole('button', { name: 'Close source review', exact: true }).click();
    if (action === 'tab' || action === 'project' || action === 'close')
      await expect(page.locator('canvas[data-source-decoder]')).toHaveCount(0);
    if (action === 'asset')
      await expect(page.locator('.source-preview')).toHaveAttribute('data-media-id', assets[1]!.id);
    await page.evaluate(async () => {
      window.videoFrameGate.release();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    if (action === 'pause') {
      await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
      await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '20');
    }
    if (action === 'scrub') {
      await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
      await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '55');
    }
    if (action === 'pause' || action === 'scrub')
      await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeEnabled();
    await flush(page);
    expect(memory.saves).toBe(0);
  });
}

test('a source decoder failure stays explicit and Retry restores the one proxy decoder', async ({ page }) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 20);
  await page.evaluate(() => {
    window.videoFrameGate.failNext = 'Deliberate source decoding failure';
  });
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview [role="alert"]')).toContainText('Deliberate source decoding failure');
  await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '20');
  await expect(page.locator('canvas[data-source-decoder]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
  await flush(page);
  expect(memory.saves).toBe(0);
});

test('a source decoder that stops delivering has a bounded failure and reachable Retry', async ({ page }) => {
  test.setTimeout(30_000);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 10, 110);
  await sourceFrame(page, 20);
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  await page.evaluate(() => {
    window.videoFrameGate.hold = true;
  });
  await expect(page.locator('.source-preview [role="alert"]')).toContainText('within 5 seconds', { timeout: 15_000 });
  await page.evaluate(() => window.videoFrameGate.release());
  await page.getByRole('button', { name: 'Retry source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeEnabled();
  await expect(page.locator('canvas[data-source-decoder]')).toHaveCount(1);
  await expectOnlyRangesSaved(page);
});

test('source IN/OUT targets, omitted footage and reversible drafts remain reachable at the minimum viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 25, 90);
  await sourceFrame(page, 50);
  const dock = page.locator('#source-view');
  expect(await dock.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
  const strip = page.locator('.source-range-strip');
  const track = (await strip.boundingBox())!;
  const at = (frame: number) => track.x + (track.width * frame) / 120;
  const play = page.getByRole('button', { name: 'Play source preview', exact: true });
  const playBox = (await play.boundingBox())!;
  expect(playBox).toMatchObject({ width: 36, height: 36 });
  expect(playBox.x + playBox.width).toBeLessThan(track.x);
  await expect(play).toBeInViewport();
  const snapshots = page.locator('.source-filmstrip img');
  await expect(snapshots).toHaveCount(5);
  await expect(strip).toHaveAttribute('data-snapshots', 'true');
  await expect(page.locator('.source-filmstrip-missing')).toHaveCount(0);
  const handles = await page
    .locator('.source-trim-handle')
    .evaluateAll((elements) =>
      elements.map((element) => ({ ...element.getBoundingClientRect().toJSON(), text: element.textContent })),
    );
  expect(handles.map(({ width, height, text }) => ({ width, height, text }))).toEqual([
    { width: 12, height: track.height, text: '' },
    { width: 12, height: track.height, text: '' },
  ]);
  expect(Math.abs(handles[0]!.right - at(25))).toBeLessThan(1);
  expect(Math.abs(handles[1]!.left - at(90))).toBeLessThan(1);
  for (const [edge, width] of [
    ['before', at(25) - track.x],
    ['after', track.x + track.width - at(90)],
  ] as const)
    expect(
      Math.abs(
        (await page
          .locator(`.source-range-omitted.${edge}`)
          .evaluate((element) => element.getBoundingClientRect().width)) - width,
      ),
    ).toBeLessThan(1);
  const handle = page.getByRole('slider', { name: 'Trim source start', exact: true });
  const box = (await handle.boundingBox())!;
  // The visible 12 px handle has a wider pointer target on both sides.
  for (const x of [box.x - 4, box.x + box.width / 2, box.x + box.width + 4])
    expect(
      await handle.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), {
        x,
        y: box.y + box.height / 2,
      }),
    ).toBe(true);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2);
  await expect(strip).toHaveAttribute('data-range-draft', 'true');
  await expect(page.locator('.source-drag-hint')).toHaveText('Release to apply · Esc to cancel');
  expect(await strip.boundingBox()).toEqual(track);
  await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(strip).toHaveAttribute('data-source-in', '25');
  await expect(page.locator('.source-drag-hint')).toHaveCount(0);
  await expect(page.locator('.source-range-description')).toHaveCount(0);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '50');
  await handle.press('Home');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '0');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '0');
  await page.getByRole('slider', { name: 'Trim source end', exact: true }).press('End');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '120');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '119');
  await expectOnlyRangesSaved(page);
});

test('missing source snapshots degrade explicitly without changing the track or starting preparation', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (isWrite(request)) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.route(/\/api\/media\/[^/]+\/thumbnail\/\d+$/, (route) => route.fulfill({ status: 404, body: '' }));
  // Reload so no thumbnail can come from the document's already decoded image cache.
  await fixture(page, sequence());
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 40);
  const strip = page.locator('.source-range-strip');
  await expect(strip).toHaveAttribute('data-snapshots', 'false');
  await expect(page.locator('.source-filmstrip-missing')).toHaveText('Snapshots unavailable');
  expect((await strip.boundingBox())!.height).toBe(44);
  await page.getByRole('slider', { name: 'Trim source start', exact: true }).press('Shift+ArrowRight');
  await expect(strip).toHaveAttribute('data-source-in', '10');
  await expectOnlyRangesSaved(page);
  expect(requests).toEqual(['PUT /api/projects/browser-rush-editing']);
});

/** Where the chart draws a tolerance: its plot spans the lower 70 % of the 0–100 viewBox, up to 8. */
const lineY = (tolerance: number): number => 100 - (tolerance / 8) * 72;

/** A jerky first second of reframing, then a steady pan, for the 120-frame fixture. */
function jerkyThenSteady(asset: MediaAsset): MotionAnalysis {
  const tx = Array.from({ length: 120 }, (_, frame) => {
    if (frame === 0) return null;
    return frame < 30 ? 3 * Math.sin(frame / 2) : 1.5;
  });
  const still = tx.map((value) => (value === null ? null : 0));
  return {
    version: MOTION_ANALYSIS_VERSION,
    verifiedAt: asset.prepared!.verification.verifiedAt,
    frameCount: 120,
    tx,
    ty: still,
    zoom: still,
    rotation: still,
    telemetry: [0, 1, 2, 3].map((time) => ({
      time,
      horizontalSpeed: 2 + 2 * time,
      verticalSpeed: 0,
      height: 30 + 5 * time,
      distance: null,
      iso: 100,
      shutter: null,
      ev: null,
      digitalZoom: null,
    })),
  };
}

test('the motion timeline shows jolts, allowed movement and the best steady range; Use applies it as IN/OUT', async ({
  page,
}) => {
  const asset = assets[0]!;
  const fps = 30000 / 1001;
  const analysis = jerkyThenSteady(asset);
  const profile = motionProfile(analysis, fps);
  const best = (tolerance: number) => rankedSmoothRanges(analysis, smoothRanges(profile, tolerance, fps), fps)[0]!;
  const steady = best(SMOOTH_TOLERANCE.initial);
  const tolerant = best(SMOOTH_TOLERANCE.max);
  const seconds = (part: { sourceIn: number; sourceOut: number }): string =>
    `${((part.sourceOut - part.sourceIn) / fps).toFixed(2)} s`;
  expect(steady.sourceIn).toBeGreaterThan(20);
  expect(tolerant.sourceIn).toBeLessThan(steady.sourceIn);
  const requests: string[] = [];
  await page.route(`**/api/media/${asset.id}/motion`, async (route) => {
    requests.push(route.request().method());
    await route.fulfill({ json: { analysis, job: null } });
  });
  const before = await current(page);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  const row = page.locator('.smooth-panel');
  await expect(row).toHaveAttribute('data-smooth-in', String(steady.sourceIn));
  await expect(row).toHaveAttribute('data-smooth-out', String(steady.sourceOut));
  await expect(page.getByRole('button', { name: 'Analyze camera motion', exact: true })).toHaveCount(0);
  const timeline = page.locator('.source-motion');
  const imageLane = timeline.locator('[data-lane="image"]');
  const band = imageLane.locator('.source-motion-band:not(.alternative)');
  await expect(band).toHaveAttribute('x', String(steady.sourceIn));
  await expect(band).toHaveAttribute('width', String(steady.sourceOut - steady.sourceIn));
  const tolerance = timeline.locator('.source-motion-tolerance');
  await expect(tolerance).toHaveAttribute('y1', String(lineY(SMOOTH_TOLERANCE.initial)));
  // The lanes sit directly under the range strip, in its column, and its playhead runs through them.
  const [stripBox, timelineBox, headBox] = await Promise.all([
    page.locator('.source-range-strip').boundingBox(),
    timeline.boundingBox(),
    page.locator('.source-range-head').boundingBox(),
  ]);
  expect(timelineBox!.x).toBeCloseTo(stripBox!.x, 0);
  expect(timelineBox!.width).toBeCloseTo(stripBox!.width, 0);
  expect(timelineBox!.y - (stripBox!.y + stripBox!.height)).toBeLessThan(8);
  expect(headBox!.y).toBeLessThan(stripBox!.y);
  expect(headBox!.y + headBox!.height).toBeCloseTo(timelineBox!.y + timelineBox!.height, 0);

  const use = page.getByRole('button', { name: /^Use best steady range / });
  // A sideways pan while the drone flies reads as an orbit.
  await expect(row.locator('.smooth-panel-summary')).toContainText(`orbit · ${seconds(steady)}`);
  await use.click();
  const strip = page.locator('.source-range-strip');
  await expect(strip).toHaveAttribute('data-source-in', String(steady.sourceIn));
  await expect(strip).toHaveAttribute('data-source-out', String(steady.sourceOut));
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', String(steady.sourceIn));
  await expect(use).toBeDisabled();
  await expect(use).toHaveText('In use');
  // Dragging the slider previews the suggestion before release; Escape restores it.
  const allowed = page.getByRole('slider', { name: 'Allowed movement', exact: true });
  const allowedBox = (await allowed.boundingBox())!;
  await page.mouse.move(allowedBox.x + allowedBox.width * 0.25, allowedBox.y + allowedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(allowedBox.x + allowedBox.width + 20, allowedBox.y + allowedBox.height / 2, { steps: 4 });
  await expect(tolerance).toHaveAttribute('y1', String(lineY(SMOOTH_TOLERANCE.max)));
  await expect(row).toHaveAttribute('data-smooth-in', String(tolerant.sourceIn));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(tolerance).toHaveAttribute('y1', String(lineY(SMOOTH_TOLERANCE.initial)));
  await expect(row).toHaveAttribute('data-smooth-in', String(steady.sourceIn));
  // The lanes hatch the footage outside IN/OUT like the strip.
  const omitted = await timeline
    .locator('.source-motion-omitted')
    .evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().width));
  expect(omitted[0]).toBeCloseTo((timelineBox!.width * steady.sourceIn) / 120, 0);
  expect(omitted[1]).toBeCloseTo((timelineBox!.width * (120 - steady.sourceOut)) / 120, 0);

  await page.getByRole('slider', { name: 'Allowed movement', exact: true }).fill(String(SMOOTH_TOLERANCE.max));
  await expect(row).toHaveAttribute('data-smooth-in', String(tolerant.sourceIn));
  await expect(tolerance).toHaveAttribute('y1', String(lineY(SMOOTH_TOLERANCE.max)));
  await expect(use).toBeEnabled();
  await expect(strip).toHaveAttribute('data-source-in', String(steady.sourceIn));

  // Clicking the timeline away from the dashed line scrubs the source like the strip does.
  await timeline.click({ position: { x: timelineBox!.width * 0.75, y: timelineBox!.height * 0.85 } });
  await expect
    .poll(async () => Number(await page.locator('.source-preview').getAttribute('data-source-frame')))
    .toBeGreaterThanOrEqual(88);
  expect(Number(await page.locator('.source-preview').getAttribute('data-source-frame'))).toBeLessThanOrEqual(91);
  // Hovering reads the values there in each lane, including the speed the drone recorded (8 m/s at 3 s).
  const readout = imageLane.locator('.source-motion-readout');
  const flightLane = timeline.locator('[data-lane="horizontalSpeed"]');
  await expect(readout).toContainText('00:03:00');
  await expect(flightLane).toContainText('Flight speed 8.0 m/s');
  await page.mouse.move(0, 0);
  await expect(readout).toHaveText('JoltsMovement');
  await expect(flightLane).toHaveText('Flight speed2.0 m/s – 8.0 m/s');

  // Flight data lanes are chosen in a popover; only values this recording has are offered.
  await openOptions(page, 'Flight data lanes');
  const seriesList = page.locator('.source-motion-series-list');
  await expect(seriesList.getByRole('checkbox')).toHaveCount(4);
  await expect(seriesList.getByRole('checkbox', { name: 'Distance from home' })).toHaveCount(0);
  await seriesList.getByRole('checkbox', { name: 'Height' }).check();
  await seriesList.getByRole('checkbox', { name: 'Flight speed' }).uncheck();
  await closeOptions(page);
  const heightLane = timeline.locator('[data-lane="height"]');
  await expect(heightLane).toHaveCount(1);
  await expect(flightLane).toHaveCount(0);
  await page.mouse.move(timelineBox!.x + timelineBox!.width * 0.75, timelineBox!.y + timelineBox!.height * 0.85);
  await expect(heightLane).toContainText('Height 45 m');
  await page.mouse.move(0, 0);

  // Collapsing hides the whole panel but its title and suggestion, and the choice is kept.
  await page.getByRole('button', { name: 'Collapse camera motion', exact: true }).click();
  await expect(row).toHaveAttribute('data-collapsed', 'true');
  await expect(timeline).toHaveCount(0);
  await expect(use).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Allowed movement', exact: true })).toHaveCount(0);
  await expect(page.locator('summary[aria-label="Flight data lanes"]')).toHaveCount(0);
  await expect(row.locator('.smooth-panel-summary')).toContainText(seconds(tolerant));
  await page.getByRole('button', { name: 'Close source review', exact: true }).click();
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(row).toHaveAttribute('data-collapsed', 'true');
  await page.getByRole('button', { name: 'Expand camera motion', exact: true }).click();
  await expect(heightLane).toHaveCount(1);

  // The analysis is kept for this session: reopening needs no new request.
  await page.getByRole('button', { name: 'Close source review', exact: true }).click();
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(row).toHaveAttribute('data-smooth-in', String(tolerant.sourceIn));
  expect(requests).toEqual(['GET']);

  // The dashed line itself is a handle: dragging it to the bottom asks for the steadiest footage only.
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', /^\d+$/);
  const frameBefore = await page.locator('.source-preview').getAttribute('data-source-frame');
  const box = (await imageLane.boundingBox())!;
  const lineAt = box.y + (lineY(SMOOTH_TOLERANCE.max) / 100) * box.height;
  await page.mouse.move(box.x + box.width * 0.4, lineAt);
  await expect(timeline).toHaveAttribute('data-near-tolerance', 'true');
  await expect(readout).toContainText('Allowed movement 6.0');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height + 20, { steps: 4 });
  await page.mouse.up();
  const slider = page.getByRole('slider', { name: 'Allowed movement', exact: true });
  await expect(slider).toHaveValue(String(SMOOTH_TOLERANCE.min));
  await expect(tolerance).toHaveAttribute('y1', String(lineY(SMOOTH_TOLERANCE.min)));
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', frameBefore!);
  expect(timelineOf(await current(page))).toEqual(timelineOf(before));
  await expectOnlyRangesSaved(page);
});

test('Use all keeps every steady range as a kept range in one Undo step, adding nothing to the timeline', async ({
  page,
}) => {
  const asset = assets[0]!;
  const fps = 30000 / 1001;
  const analysis = jerkyThenSteady(asset);
  const steady = smoothRanges(motionProfile(analysis, fps), SMOOTH_TOLERANCE.initial, fps);
  await page.route(`**/api/media/${asset.id}/motion`, (route) => route.fulfill({ json: { analysis, job: null } }));
  const before = await current(page);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  const useAll = page.getByRole('button', { name: /^Use all \d+ steady ranges as kept ranges$/ });
  await expect(useAll).toHaveText(`Use all ${steady.length}`);
  await useAll.click();
  const ranges = [...steady]
    .sort((a, b) => a.sourceIn - b.sourceIn)
    .map(({ sourceIn, sourceOut }) => ({ sourceIn, sourceOut }));
  await expect.poll(async () => (await current(page)).selects[asset.id]).toEqual(ranges);
  expect((await current(page)).clips).toEqual(before.clips);
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', String(ranges[0]!.sourceIn));
  await expect(useAll).toBeDisabled();
  await expect(useAll).toHaveText('All in use');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await current(page)).selects[asset.id]).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a proxy prepared before the analysis offers Analyze camera motion, which runs one background job', async ({
  page,
}) => {
  const asset = assets[0]!;
  const analysis = jerkyThenSteady(asset);
  const job = {
    id: 'motion-job',
    kind: 'motion',
    label: asset.name,
    state: 'running',
    progress: 0.5,
    message: 'Measuring camera motion',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    outputUrl: null,
    receiptUrl: null,
  };
  const posts: string[] = [];
  let polls = 0;
  await page.route(`**/api/media/${asset.id}/motion`, async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postData() ?? '');
      await route.fulfill({ status: 202, json: { job } });
      return;
    }
    await route.fulfill({ json: { analysis: polls >= 2 ? analysis : null, job: null } });
  });
  await page.route('**/api/jobs', async (route) => {
    if (!posts.length) {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    polls++;
    const done = polls >= 2;
    await route.fulfill({
      json: { jobs: [{ ...job, ...(done && { state: 'completed', progress: 1, finishedAt: job.createdAt }) }] },
    });
  });
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(page.locator('.source-motion')).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze camera motion', exact: true }).click();
  await expect(page.locator('.smooth-panel')).toContainText('Measuring camera motion… 50 %');
  await expect(page.locator('.smooth-panel')).toHaveAttribute('data-smooth-in', /^\d+$/);
  await expect(page.locator('.source-motion')).toHaveCount(1);
  expect(posts).toEqual(['{}']);
  await flush(page);
  expect(memory.saves).toBe(0);
});

test('a ready recording follows the camera motion analysis queued after preparation, without a button', async ({
  page,
}) => {
  const asset = assets[0]!;
  const analysis = jerkyThenSteady(asset);
  const job = {
    id: 'queued-motion-job',
    kind: 'motion',
    label: asset.name,
    state: 'queued',
    progress: 0,
    message: 'Waiting for the media worker',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    outputUrl: null,
    receiptUrl: null,
  };
  const methods: string[] = [];
  let state: Record<string, unknown> = {};
  await page.route(`**/api/media/${asset.id}/motion`, async (route) => {
    methods.push(route.request().method());
    const done = state.state === 'completed';
    await route.fulfill({ json: done ? { analysis, job: null } : { analysis: null, job: { ...job, ...state } } });
  });
  await page.route('**/api/jobs', (route) => route.fulfill({ json: { jobs: [{ ...job, ...state }] } }));
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  const panel = page.locator('.smooth-panel');
  await expect(panel).toContainText('Camera motion queued');
  await expect(page.getByRole('button', { name: 'Analyze camera motion', exact: true })).toHaveCount(0);
  state = { state: 'running', progress: 0.25 };
  await expect(panel).toContainText('Measuring camera motion… 25 %');
  state = { state: 'completed', progress: 1, finishedAt: job.createdAt };
  await expect(panel).toHaveAttribute('data-smooth-in', /^\d+$/);
  await expect(page.locator('.source-motion')).toHaveCount(1);
  expect(methods.every((method) => method === 'GET')).toBe(true);
  await flush(page);
  expect(memory.saves).toBe(0);
});

test('Media thumbnails dim the omitted head/tail of the applied source range, not drafts', async ({ page }) => {
  const item = page.locator(`.media-item[data-media-id="${assets[0]!.id}"]`);
  const review = page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true });
  const zones = () =>
    item.locator('.media-thumb').evaluate((thumb) => {
      const bounds = thumb.getBoundingClientRect();
      const width = (edge: string) =>
        thumb.querySelector(`.media-thumb-omitted.${edge}`)?.getBoundingClientRect().width;
      return { thumb: bounds.width, before: width('before'), after: width('after') };
    });
  const expectZones = async (sourceIn: number, sourceOut: number) => {
    const actual = await zones();
    const expected = (frames: number) => (frames ? (actual.thumb * frames) / 120 : undefined);
    for (const [edge, frames] of [
      ['before', sourceIn],
      ['after', 120 - sourceOut],
    ] as const) {
      if (!frames) expect(actual[edge]).toBeUndefined();
      else expect(Math.abs(actual[edge]! - expected(frames)!)).toBeLessThan(0.5);
    }
  };
  await review.click();
  await expectZones(0, 120);
  await expect(review).not.toHaveAccessibleDescription(/Selected range/);
  for (const [sourceIn, sourceOut] of [
    [30, 90],
    [30, 120],
    [0, 45],
    [59, 60],
  ] as const) {
    await sourceRange(page, sourceIn, sourceOut);
    await expect(item.locator('.media-thumb')).toHaveAttribute('data-source-in', String(sourceIn));
    await expect(item.locator('.media-thumb')).toHaveAttribute('data-source-out', String(sourceOut));
    await expectZones(sourceIn, sourceOut);
    await expect(review).toHaveAccessibleDescription(
      `Selected range: frames ${sourceIn} to ${sourceOut} of 120, OUT exclusive`,
    );
  }
  await expect(item.getByText(/IN \d+ · OUT \d+/)).toHaveCount(0);
  // Overlays never intercept the review button, hover marker or Add action.
  const thumb = (await item.locator('.media-thumb').boundingBox())!;
  expect(
    await review.evaluate(
      (button, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return button.contains(hit) && !hit?.classList.contains('media-thumb-omitted');
      },
      { x: thumb.x + 2, y: thumb.y + thumb.height / 2 },
    ),
  ).toBe(true);

  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('10');
  await expect(item.locator('.media-thumb')).toHaveAttribute('data-source-in', '59');
  await expectZones(59, 60);
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).press('Escape');
  await page.getByRole('slider', { name: 'Trim source end', exact: true }).press('End');
  await page.getByRole('slider', { name: 'Trim source start', exact: true }).press('Home');
  await expect(item.locator('.media-thumb')).toHaveAttribute('data-source-in', '0');
  await expect(item.locator('.media-thumb')).toHaveAttribute('data-source-out', '120');
  await expectZones(0, 120);
  await expect(review).not.toHaveAccessibleDescription(/Selected range/);

  await sourceRange(page, 20, 100);
  await openOptions(page, 'Media options');
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await closeOptions(page);
  await expect(page.locator('.media-items')).toHaveClass('media-items grid');
  await expectZones(20, 100);
  await expectOnlyRangesSaved(page);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
});

test('removing recordings from the project bin confirms used footage and Undo restores everything', async ({
  page,
}) => {
  const document = sequence();
  document.clips = document.clips.filter((item) => item.mediaId === assets[0]!.id);
  document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'c', type: 'cut', duration: 0 }];
  await fixture(page, document);
  const edited = async () => {
    const { revision: _revision, ...rest } = await current(page);
    return rest;
  };
  const before = await edited();
  const card = (index: number) => page.locator(`.media-item[data-media-id="${assets[index]!.id}"]`);
  const heading = page.getByRole('heading', { name: /^Media \d+$/ });
  const total = page.locator('.library-total');
  const duration = (items: MediaAsset[]) =>
    durationLabel(items.reduce((sum, item) => sum + item.metadata.durationSeconds, 0));
  const undo = page.getByRole('button', { name: 'Undo', exact: true });

  // An unused recording leaves immediately, with focus kept in the list.
  await expect(total).toHaveText(duration([assets[0]!, assets[1]!]));
  await page.getByRole('button', { name: 'Remove pattern-b.mp4 from project', exact: true }).click();
  await expect(card(1)).toHaveCount(0);
  await expect(heading).toHaveText('Media 1');
  await expect(total).toHaveText(duration([assets[0]!]));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card(0).locator('.media-checkbox')).toBeFocused();
  expect((await current(page)).media.videoIds).toEqual([assets[0]!.id]);
  expect((await current(page)).clips).toEqual(before.clips);
  await undo.click();
  await expect(heading).toHaveText('Media 2');
  expect(await edited()).toEqual(before);

  // A used recording asks first; canceling changes nothing and returns focus.
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(page.locator('canvas[data-source-decoder]')).toHaveCount(1);
  const trash = page.getByRole('button', { name: 'Remove pattern-a.mp4 from project', exact: true });
  await trash.click();
  const dialog = page.getByRole('dialog', { name: 'Remove pattern-a.mp4 from this project?', exact: true });
  await expect(dialog).toContainText('2 timeline clips using it will be removed too.');
  await expect(dialog).toContainText('Original recordings, prepared media and exported videos are kept.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trash).toBeFocused();
  expect(await edited()).toEqual(before);

  await trash.click();
  await dialog.getByRole('button', { name: 'Remove from project', exact: true }).click();
  await expect(card(0)).toHaveCount(0);
  await expect(page.locator('.timeline-clip')).toHaveCount(0);
  await expect(page.locator('canvas[data-source-decoder]')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Timeline preview', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  let removed = await current(page);
  expect(removed.clips).toEqual([]);
  expect(removed.media.videoIds).toEqual([assets[1]!.id]);
  await undo.click();
  await expect(page.locator('.timeline-clip')).toHaveCount(2);
  expect(await edited()).toEqual(before);

  // A selection is removed in one step from the selection header.
  await page.getByRole('checkbox', { name: 'Select visible recordings', exact: true }).check();
  await page.getByRole('button', { name: 'Remove selected from project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Remove 2 recordings from this project?', exact: true })).toContainText(
    '2 timeline clips using them will be removed too.',
  );
  await page.getByRole('button', { name: 'Remove from project', exact: true }).click();
  await expect(heading).toHaveText('Media 0');
  await expect(total).toHaveCount(0);
  await expect(page.locator('.library-summary')).toContainText('Select all');
  removed = await current(page);
  expect(removed.media.videoIds).toEqual([]);
  expect(removed.clips).toEqual([]);
  await flush(page);
  expect(memory.snapshot().media.videoIds).toEqual([]);
  await undo.click();
  await expect(heading).toHaveText('Media 2');
  expect(await edited()).toEqual(before);
});

test('removing a music recording removes its tracks after confirmation and keeps other media', async ({
  page,
  request,
}) => {
  const music = await fixtureMusic(request);
  const document = sequence();
  document.music = [
    singleClipLane({
      id: 'bin-music',
      mediaId: music.id,
      sourceIn: 0,
      sourceOut: 60,
      start: 10,
      duration: 60,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    }),
  ];
  document.media.audioIds = [music.id];
  await fixture(page, document);
  const before = await current(page);
  const row = page.locator(`[data-music-media-id="${music.id}"]`);
  await expect(row).toContainText('1 music clip');
  await row.getByRole('button', { name: `Remove ${music.name} from project`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Remove ${music.name} from this project?`, exact: true });
  await expect(dialog).toContainText('1 music clip using it will be removed too.');
  await dialog.getByRole('button', { name: 'Remove from project', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search media', exact: true })).toBeFocused();
  await expect(page.locator('[data-music-lane]')).toHaveCount(0);
  const removed = await current(page);
  expect(removed.music).toEqual([]);
  expect(removed.media).toEqual({ videoIds: before.media.videoIds, audioIds: [] });
  expect(removed.clips).toEqual(before.clips);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const { revision: _restored, ...restored } = await current(page);
  const { revision: _before, ...original } = before;
  expect(restored).toEqual(original);
});

test('an invalid exact source range keeps its draft, an actionable error and no dangling description', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 10, 40);
  const sourceIn = page.getByRole('spinbutton', { name: 'Source IN', exact: true });
  const sourceOut = page.getByRole('spinbutton', { name: 'Source OUT', exact: true });
  for (const field of [sourceIn, sourceOut]) await expect(field).not.toHaveAttribute('aria-describedby');
  await sourceIn.fill('50');
  await sourceIn.press('Enter');
  const error = 'Use whole source frames: 0 ≤ IN < OUT ≤ 120. OUT is exclusive.';
  await expect(page.locator('.source-range-description[role="alert"]')).toHaveText(error);
  for (const field of [sourceIn, sourceOut]) {
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription(error);
  }
  await expect(sourceIn).toHaveValue('50');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '10');
  await sourceIn.press('Escape');
  await expect(sourceIn).toHaveValue('10');
  await expect(page.locator('.source-range-description')).toHaveCount(0);
  for (const field of [sourceIn, sourceOut]) {
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await expect(field).not.toHaveAttribute('aria-describedby');
  }
  await expectOnlyRangesSaved(page);
});

test('stepping the numeric source IN and OUT applies each step to the range strip at once', async ({ page }) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 10, 40);
  const strip = page.locator('.source-range-strip');
  const sourceIn = page.getByRole('spinbutton', { name: 'Source IN', exact: true });
  const sourceOut = page.getByRole('spinbutton', { name: 'Source OUT', exact: true });
  await sourceIn.focus();
  await sourceIn.press('ArrowUp');
  await expect(strip).toHaveAttribute('data-source-in', '11');
  await expect(page.getByRole('slider', { name: 'Source playhead' })).toHaveValue('11');
  await sourceOut.focus();
  await sourceOut.press('ArrowDown');
  await expect(strip).toHaveAttribute('data-source-out', '39');
  await expect(page.getByRole('slider', { name: 'Source playhead' })).toHaveValue('38');
});

test('numeric source IN and OUT apply as a pair when focus leaves them, not between the two fields', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 10, 40);
  const strip = page.locator('.source-range-strip');
  const sourceIn = page.getByRole('spinbutton', { name: 'Source IN', exact: true });
  await sourceIn.fill('60');
  await sourceIn.press('Tab');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('90');
  await expect(page.locator('.source-range-description')).toHaveCount(0);
  await expect(strip).toHaveAttribute('data-source-in', '10');
  await page.getByRole('button', { name: 'Play source preview', exact: true }).focus();
  await expect(strip).toHaveAttribute('data-source-in', '60');
  await expect(strip).toHaveAttribute('data-source-out', '90');
});

test('with a range selected, Bookmark adds one at each end in a single Undo step', async ({ page }) => {
  const before = await current(page);
  const bookmark = page.locator('.timeline-bookmark-action');
  await expect(bookmark).not.toHaveClass(/range-accent/);
  await markRange(page, 20, 31);
  await expect(bookmark).toHaveClass(/range-accent/);
  await expect(bookmark).toHaveAccessibleName('Add bookmarks at range ends');
  await bookmark.click();
  expect((await current(page)).bookmarks).toEqual([20, 31]);
  await expect(rulerRange(page)).toHaveAttribute('data-range-out', '31');
  await expect(bookmark).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).bookmarks).toEqual(before.bookmarks);
});

test('applied ranges are the recording’s kept ranges: saved with the project, several per recording, one Undo step each', async ({
  page,
}) => {
  const id = assets[0]!.id;
  const kept = async () => (await current(page)).selects[id];
  const strip = page.locator('.source-range-strip');
  const trigger = page.locator('summary[aria-label="Kept ranges"]');
  const addRange = page.getByRole('button', { name: 'New range', exact: true });
  const choose = (index: number) => page.getByRole('button', { name: new RegExp(`^Kept range ${index},`) });
  const openList = async () => {
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    await expect(addRange).toBeVisible();
  };
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(trigger).toHaveText(/Whole recording/); // Nothing is kept yet: the whole recording is available.
  await sourceRange(page, 10, 40);
  expect(await kept()).toEqual([{ sourceIn: 10, sourceOut: 40 }]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.source-review')).toBeVisible(); // Applying never leaves Source preview.
  await expect(trigger).toHaveText(/1 kept range\b/);

  // New range keeps a range from a free displayed frame, else in the largest free stretch, one Undo step each.
  await sourceFrame(page, 60);
  await openList();
  await addRange.click();
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 40 },
    { sourceIn: 60, sourceOut: 120 },
  ]);
  await expect(strip).toHaveAttribute('data-source-in', '60');
  await expect(choose(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(choose(2)).toHaveAccessibleName('Kept range 2, 00:02:00 to 00:04:00, 2.00 s');
  await expect(page.locator('.source-range-kept')).toHaveCount(1);
  await addRange.click(); // The displayed frame is kept: the largest free stretch, 41–59, takes it.
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 40 },
    { sourceIn: 41, sourceOut: 59 },
    { sourceIn: 60, sourceOut: 120 },
  ]);
  await expect(choose(2)).toHaveAttribute('aria-pressed', 'true');

  // Removing one range is explicit and keeps the list open on the next row.
  await page.getByRole('button', { name: 'Remove kept range 2', exact: true }).click();
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 40 },
    { sourceIn: 60, sourceOut: 120 },
  ]);
  await expect(page.getByRole('button', { name: 'Remove kept range 2', exact: true })).toBeFocused();
  await choose(1).click();
  await expect(strip).toHaveAttribute('data-source-in', '10');
  await page.keyboard.press('Escape');

  // Handles stop one frame from the neighboring kept range instead of failing.
  const end = page.getByRole('slider', { name: 'Trim source end', exact: true });
  await expect(end).toHaveAttribute('aria-valuemax', '59');
  await end.press('End');
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 59 },
    { sourceIn: 60, sourceOut: 120 },
  ]);
  await end.press('ArrowRight');
  expect((await kept())![0]).toEqual({ sourceIn: 10, sourceOut: 59 });

  // Typed values are never constrained: an overlap is rejected, never merged or clamped.
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('70');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).press('Enter');
  await expect(page.locator('.source-range-error')).toContainText('separated by at least one frame');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).press('Escape');
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 59 },
    { sourceIn: 60, sourceOut: 120 },
  ]);

  // A click on another kept range on the strip edits that one; Shift-drag draws a new one in a free stretch.
  const box = (await strip.boundingBox())!;
  const at = (frame: number) => box.x + ((frame + 0.5) / 120) * box.width;
  await page.mouse.click(at(90), box.y + box.height / 2);
  await expect(strip).toHaveAttribute('data-source-in', '60');
  await sourceRange(page, 70, 120);
  await page.keyboard.down('Shift');
  await page.mouse.move(at(62), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(at(66), box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(at(100), box.y + box.height / 2, { steps: 4 }); // Stops one frame before the next range.
  await expect(strip).toHaveAttribute('data-drawing', 'true');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 59 },
    { sourceIn: 62, sourceOut: 69 },
    { sourceIn: 70, sourceOut: 120 },
  ]);
  await expect(strip).toHaveAttribute('data-source-in', '62');

  // The kept ranges are in the saved project and survive a reload; clips still copy the applied range.
  await flush(page);
  expect(memory.snapshot().selects[id]).toEqual(await kept());
  await page.reload();
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(strip).toHaveAttribute('data-source-in', '10');
  await openList();
  await choose(2).click();
  await expect(strip).toHaveAttribute('data-source-in', '62');
  await page.keyboard.press('Escape');
  const clipId = await addExcerpt(page);
  expect((await current(page)).clips.find((item) => item.id === clipId)).toMatchObject({
    sourceIn: 62,
    sourceOut: 69,
  });

  // Add all adds one clip per kept range in one Undo step, without leaving Source preview.
  const clips = (await current(page)).clips.length;
  await openList();
  await page.getByRole('button', { name: /^Add 3 clips to / }).click();
  await expect(page.locator('.source-add-feedback')).toHaveText('3 clips added · one per range');
  const added = (await current(page)).clips.slice(clips);
  expect(added.map(({ sourceIn, sourceOut }) => ({ sourceIn, sourceOut }))).toEqual(await kept());
  await expect(page.locator('.source-review')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).clips).toHaveLength(clips);
  await page.getByRole('tab', { name: 'Source preview', exact: true }).click();

  // Delete selected kept range removes only the active one, in one Undo step.
  const remove = page.getByRole('button', { name: 'Delete selected kept range', exact: true });
  await remove.click();
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 59 },
    { sourceIn: 70, sourceOut: 120 },
  ]);
  await expect(strip).toHaveAttribute('data-source-in', '70');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('tab', { name: 'Source preview', exact: true }).click();

  // Reset returns to the whole recording, removing every kept range in one step; Undo restores them.
  await page.getByRole('button', { name: 'Reset source range', exact: true }).click();
  expect(await kept()).toBeUndefined();
  await expect(strip).toHaveAttribute('data-source-in', '0');
  await expect(strip).toHaveAttribute('data-source-out', '120');
  await expect(trigger).toHaveText(/Whole recording/);
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await kept()).toEqual([
    { sourceIn: 10, sourceOut: 59 },
    { sourceIn: 62, sourceOut: 69 },
    { sourceIn: 70, sourceOut: 120 },
  ]);
});
