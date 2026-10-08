import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { audioAssetSchema, type AudioAsset } from '../../src/shared/audio.js';
import { applyCommand } from '../../src/shared/commands.js';
import { mediaAssetSchema, type MediaAsset } from '../../src/shared/media.js';
import {
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type ProjectDocument,
  type Transition,
} from '../../src/shared/model.js';
import { validateSourceRanges } from '../../src/shared/source-range.js';
import { calculateLayout, layerClips } from '../../src/shared/timeline.js';
import { clipAction, expandedInspectorPreferences, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

const PROJECT_ID = 'browser-rush-editing';
let assets: MediaAsset[];
let audioAssets: AudioAsset[];
let memory: MemoryProjects;
let unexpectedApi: string[];

test.beforeEach(async ({ page, request }) => {
  unexpectedApi = [];
  audioAssets = [];
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
    '/api/media': { assets },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && pathname === '/api/audio') {
      await route.fulfill({ json: { assets: audioAssets } });
      return;
    }
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    const media = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
    if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) {
      await route.continue();
      return;
    }
    const audio = /^\/api\/audio\/([^/]+)\/playback$/.exec(pathname);
    if ((method === 'GET' || method === 'HEAD') && audio && audioAssets.some((asset) => asset.id === audio[1])) {
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
  document.layers[0]!.keyframes = [sharedPoint(12, { exposure: 0.3 }), sharedPoint(500, { hue: 20 }, 'hold')];
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

async function markRange(page: Page, inFrame: number, outFrame: number, buttons = false): Promise<void> {
  await seek(page, inFrame);
  if (buttons) await page.getByRole('button', { name: 'Mark cut IN', exact: true }).click();
  else await shortcut(page, 'i');
  await seek(page, outFrame - 1);
  if (buttons) await page.getByRole('button', { name: 'Mark cut OUT', exact: true }).click();
  else await shortcut(page, 'o');
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
  // CSSOM serialises subpixel lengths to fewer significant digits; frame marks above remain exact.
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
  expect(next.schemaVersion).toBe(12);
  expect(next.media).toEqual(before.media);
  expect(next.layers).toEqual(
    before.layers.map((layer) => ({ ...layer, transitions: transitions[layer.id] ?? layer.transitions })),
  );
  expect(next.music).toEqual(before.music);
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
        const index = state.assignedClipIds.indexOf(id);
        const video = document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]')[index];
        return video && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          ? Math.floor((video.currentTime * 30000) / 1001 + 1e-7)
          : null;
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
  await page.getByRole('button', { name: 'Apply source range', exact: true }).click();
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', String(sourceIn));
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', String(sourceOut));
}

async function addExcerpt(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Add source excerpt to timeline', exact: true }).click();
  const feedback = page.locator('.source-add-feedback');
  await expect(feedback).toHaveAttribute('data-added-clip-id', /^[a-zA-Z0-9_-]+$/);
  await expect(feedback).toHaveText('Excerpt added · mark another range');
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
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame', exact: true })).toHaveValue('90');
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
  const decoder = await page.locator('video[data-source-decoder]').elementHandle();
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
    expect(await current(page)).toEqual(before);
    ids.push(await addExcerpt(page));
    const next = await current(page);
    expect(next.clips.slice(0, -1)).toEqual(before.clips);
    expect(next.clips.at(-1)).toEqual({
      ...createClip(ids.at(-1)!, assets[0]!.id, sourceIn, sourceOut),
      start: before.clips.length * 80,
    });
    await ready(page, next);
    await expect(page.getByRole('region', { name: 'Source review', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pin source review', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', String(sourceOut - 1));
    await expect(page.locator('.source-review')).toHaveAttribute('data-source-excerpt-count', String(ids.length));
    expect(
      await page.locator('video[data-source-decoder]').evaluate((video, original) => video === original, decoder),
    ).toBe(true);
    expect(
      await page.locator('video[data-source-decoder]').evaluate((element) => {
        const video = element as HTMLVideoElement;
        return { muted: video.muted, defaultMuted: video.defaultMuted, volume: video.volume, paused: video.paused };
      }),
    ).toEqual({ muted: true, defaultMuted: true, volume: 0, paused: true });
    await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
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
  await expect(badge).toHaveText('3 excerpts');
  await sourceRange(page, 5, 35);
  expect((await current(page)).clips).toEqual(added.clips);

  await page.locator('.source-excerpts > summary').click();
  await expect(page.locator('.source-excerpts > summary')).toHaveText('3 excerpts from this rush');
  for (const [index, excerpt] of added.clips.entries()) {
    const row = page.locator(`.source-excerpt-row[data-clip-id="${excerpt.id}"]`);
    await expect(row.locator('.source-excerpt-range')).toHaveAttribute(
      'title',
      `Original source frames ${excerpt.sourceIn} → ${excerpt.sourceOut}, OUT exclusive`,
    );
    await expect(row.locator('.source-excerpt-layer')).toHaveText('Video 1');
    await expect(row.getByRole('button', { name: `Show excerpt ${index + 1} on timeline`, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.getByRole('slider', { name: 'Timeline zoom', exact: true }).fill('180');
  await expect
    .poll(() => page.locator('.timeline-scroll').evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(500);
  await page.locator('.timeline-scroll').evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
  });
  const viewport = (await page.locator('.timeline-scroll').boundingBox())!;
  const offscreen = (await clip(page, ids[0]!).boundingBox())!;
  expect(offscreen.x + offscreen.width).toBeLessThan(viewport.x);
  await page.getByRole('button', { name: 'Show excerpt 1 on timeline', exact: true }).click();
  await expect(clip(page, ids[0]!).locator('.timeline-clip-body')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft)).toBe(0);
  await expect(clip(page, ids[0]!)).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
  expect((await current(page)).clips).toEqual(added.clips);

  await page.setViewportSize({ width: 1440, height: 900 });
  await selectClip(page, ids[2]!);
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await input.fill('50');
  await input.press('Enter');
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('1.2');
  const edited = await current(page);
  expect(edited.clips.slice(0, 2)).toEqual(added.clips.slice(0, 2));
  expect(edited.clips[2]).toEqual({
    ...added.clips[2]!,
    sourceIn: 50,
  });
  expect(edited.layers[0]!.colour).toEqual({ ...added.layers[0]!.colour, saturation: 1.2 });
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
  await expect(badge).toHaveText('3 excerpts');
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(1);
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().decoderCount)).toBe(2);
});

test('rush excerpt popup leaves review geometry and Add reachable on a short laptop screen, with isolated Escape and outside-click addition', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 30);
  const before = await current(page);
  const sourceBox = await page.locator('.source-preview').boundingBox();
  const add = page.getByRole('button', { name: 'Add source excerpt to timeline', exact: true });
  await expect(add).toBeInViewport();
  const trigger = page.locator('.source-excerpts > summary');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.source-excerpt-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Show excerpt 2 on timeline', exact: true })).toBeVisible();
  expect(await page.locator('.source-preview').boundingBox()).toEqual(sourceBox);
  await expect(add).toBeInViewport();
  await page.getByRole('button', { name: 'Show excerpt 1 on timeline', exact: true }).focus();
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

test('visible split then S selects each right piece, preserves boundaries and deletes without another selection', async ({
  page,
}) => {
  const document = dissolvedSequence();
  document.layers[0]!.colour = { ...document.layers[0]!.colour, contrast: 1.25, saturation: 0.7, hue: 20 };
  document.layers[0]!.opacity = 0.65;
  document.layers[0]!.keyframes = [
    sharedPoint(20, { exposure: 0.2, speed: 1 }),
    sharedPoint(400, { speed: 1, opacity: 0.8 }, 'hold'),
  ];
  await fixture(page, document);
  const before = await current(page);
  await seek(page, 30);
  await expect(page.locator('[aria-label="Rush editing actions"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Split at playhead', exact: true })).toBeVisible();
  await clipAction(page, 'Split at playhead');
  await expect(page.locator('summary[aria-label="Clip actions"]')).toHaveAttribute('aria-expanded', 'false');
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
  document.layers[0]!.keyframes = [sharedPoint(12, { exposure: 0.25 }), sharedPoint(500, { hue: 30 }, 'smooth')];
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

test('I/O middle removal is transient then one edit, preserving absolute eleven-channel row points, music and overlays', async ({
  page,
  request,
}) => {
  const music = await fixtureMusic(request);
  const document = dissolvedSequence();
  document.layers[0]!.keyframes = [
    sharedPoint(
      15,
      {
        opacity: 0.7,
        speed: 1,
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
    sharedPoint(1_000, { speed: 1, exposure: 0.6 }, 'smooth'),
  ];
  document.layers.push({
    ...createLayer('upper', 'Video 2', false),
    opacity: 0.75,
    keyframes: [sharedPoint(200, { opacity: 0.6, hue: 35 }, 'ease-in')],
  });
  document.clips[0] = {
    ...document.clips[0]!,
    speed: { mode: 'constant', rate: 2 },
  };
  document.layers[0]!.colour = { ...document.layers[0]!.colour, exposure: -0.2, saturation: 0.6 };
  document.layers[0]!.opacity = 0.65;
  document.clips.splice(1, 0, {
    ...createClip('fixed-overlay', assets[1]!.id, 0, 20),
    layerId: 'upper',
    start: 230,
  });
  document.music = [
    {
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
    },
  ];
  document.media.audioIds = [music.id];
  await fixture(page, document);
  const before = await current(page);
  const saves = memory.saves;

  // Valid marks can still produce a transition-invalid result. Keep both marks and the whole history atomically.
  await markRange(page, 0, 89, true);
  await expect(page.getByRole('button', { name: 'Cut marked range', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cut marked range', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('Fade/transition regions overlap or exceed clip a.');
  await expectCutOverlay(page, 0, 89);
  expect(await current(page)).toEqual(before);
  await flush(page);
  expect(memory.saves).toBe(saves);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear cut marks', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();

  await markRange(page, 20, 40);
  await expectCutOverlay(page, 20, 40);
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(2);
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
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
  await expect(page.locator('.timeline-cut-selection')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cut marked range', exact: true })).toBeDisabled();
  await flush(page);
  expect(memory.saves).toBe(saves + 1);
  expect(memory.snapshot()).toEqual({ ...next, revision: before.revision + 1 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await current(page)).toEqual(next);
  await selectClip(page, right.id);
  const out = page.getByRole('spinbutton', { name: 'Source OUT frame', exact: true });
  await out.fill('100');
  await out.press('Enter');
  const independent = await current(page);
  expect(independent.clips.find((item) => item.id === 'a')).toEqual(next.clips[0]);
  expect(independent.clips.find((item) => item.id === right.id)).toEqual({ ...right, sourceOut: 100 });
  unchangedOthers(before, independent, ['a'], { 'video-1': cutTransitions });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(next);
});

test('overlay middle cuts keep their gap and neighbours fixed; visible quick trims keep absolute placement semantics', async ({
  page,
}) => {
  const document = sequence();
  document.layers.push({
    ...createLayer('upper', 'Video 2', false),
    opacity: 0.8,
    keyframes: [sharedPoint(10, { speed: 1, exposure: 0.2 }), sharedPoint(500, { speed: 1, hue: 25 }, 'hold')],
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
  await expect(page.locator('.rush-edit-mode')).toHaveText('Positioned track');
  const firstTrackTop = await clip(page, 'a').evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.top),
  );
  const overlayTop = await clip(page, 'top').evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.top),
  );
  expect(overlayTop - firstTrackTop).toBe(88);
  await markRange(page, 60, 80, true);
  await expectCutOverlay(page, 60, 80);
  await page.getByRole('button', { name: 'Cut marked range', exact: true }).click();
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
  document.layers[0]!.keyframes = [sharedPoint(20, { opacity: 0.7 }), sharedPoint(800, { exposure: 0.5 }, 'hold')];
  const cases = [
    { name: 'prefix', inFrame: 0, outFrame: 20, sourceIn: 35, sourceOut: 105 },
    { name: 'suffix', inFrame: 70, outFrame: 90, sourceIn: 15, sourceOut: 85 },
    { name: 'whole', inFrame: 0, outFrame: 90, sourceIn: null, sourceOut: null },
  ];
  for (const scenario of cases) {
    await fixture(page, document);
    const before = await current(page);
    const saves = memory.saves;
    await markRange(page, scenario.inFrame, scenario.outFrame, true);
    await expectCutOverlay(page, scenario.inFrame, scenario.outFrame);
    await page.getByRole('button', { name: 'Cut marked range', exact: true }).click();
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
  only.layers[0]!.keyframes = document.layers[0]!.keyframes;
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
  await ready(page, empty);
  await expect(page.getByRole('button', { name: 'Delete selected clip', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('partial, reversed and outside marks are rejected; input and source shortcuts cannot leak timeline edits', async ({
  page,
}) => {
  const before = await current(page);
  await seek(page, 20);
  await shortcut(page, 'i');
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Cut marked range', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cut marked range', exact: true })).toHaveAttribute(
    'title',
    'Set both IN and OUT marks before removing a range.',
  );
  await seek(page, 10);
  await shortcut(page, 'o');
  await expect(page.locator('.timeline-cut-selection')).toHaveCount(0);
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Cut marked range', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cut marked range', exact: true })).toHaveAttribute(
    'title',
    'Cut OUT must be after IN (exclusive).',
  );
  await shortcut(page, 'Shift+Delete');
  await expect(page.locator('.error-banner')).toContainText('Cut OUT must be after IN (exclusive).');
  expect(await current(page)).toEqual(before);
  await seek(page, 100);
  for (const name of [
    'Mark cut IN',
    'Mark cut OUT',
    'Split at playhead',
    'Trim start to playhead',
    'Trim end to playhead',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  }
  await shortcut(page, 'i');
  await expect(page.locator('.error-banner')).toContainText(
    'Place the playhead inside the selected excerpt to mark a cut.',
  );
  expect(await current(page)).toEqual(before);
  await page.getByRole('button', { name: 'Clear cut marks', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await markRange(page, 20, 31);
  await expectCutOverlay(page, 20, 31);
  const keys = ['i', 'o', 'q', 'w', 's', 'Shift+Delete'];
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await input.focus();
  for (const key of keys) await input.press(key);
  await expect(input).toHaveValue('15');
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
  expect(await current(page)).toEqual(before);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(30);
  await flush(page);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.source-add-feedback')).not.toHaveAttribute('data-added-clip-id', /./);
});

test('selection, clear, Escape, timing, Undo and project switching invalidate only transient cut marks', async ({
  page,
}) => {
  const before = await current(page);
  await markRange(page, 10, 20);
  await selectClip(page, 'b');
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
  await selectClip(page, 'a');
  await markRange(page, 10, 20);
  await page.getByRole('button', { name: 'Clear cut marks', exact: true }).click();
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
  await markRange(page, 10, 20);
  await shortcut(page, 'Escape');
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
  await markRange(page, 10, 20);
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await input.fill('20');
  await input.press('Enter');
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
  await ready(page, await current(page));
  await markRange(page, 10, 20);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await ready(page, before);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 12, 24);
  await markRange(page, 10, 20);
  const other = createProject('browser-rush-second', 'Other rush · memory-only');
  other.media.videoIds = assets.map((asset) => asset.id);
  other.clips = [createClip('other-a', assets[0]!.id, 0, 120)];
  other.layers[0]!.keyframes = [sharedPoint(40, { exposure: 0.4 }, 'hold')];
  memory.seed(other);
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.getByRole('button', { name: `Open ${other.title}`, exact: true }).click();
  await ready(page, other);
  expect(await current(page)).toEqual(other);
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
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
  await expect(page.locator('.timeline-cut-mark')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '12');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '24');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
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
    .poll(() => page.getByRole('spinbutton', { name: 'Source IN frame', exact: true }).inputValue())
    .toBe('0');
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
      .poll(() => page.getByRole('spinbutton', { name: 'Source IN frame', exact: true }).inputValue())
      .toBe('0');
    expect(await current(page)).toEqual(before);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else
      await clip(page, 'a')
        .locator('[data-trim-handle="in"]')
        .dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
    await page.mouse.up();
    await expect(page.locator('.timeline-surface')).not.toHaveClass(/trim-drafting/);
    await expect(page.locator('.timeline-surface')).toHaveAttribute('data-leading', '32');
    await expect(page.getByRole('spinbutton', { name: 'Source IN frame', exact: true })).toHaveValue('90');
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
  document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0.2 }), sharedPoint(500, { hue: 20 }, 'hold')];
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
  document.layers.push({
    ...createLayer('upper', 'Video 2', false),
    keyframes: [sharedPoint(10, { exposure: 0.25 }), sharedPoint(500, { hue: 20 }, 'hold')],
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
  const decoder = await page.locator('video[data-source-decoder]').elementHandle();
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
  await page.getByRole('button', { name: 'Add source excerpt to timeline', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText(
    'Clips on the same track cannot overlap except in an exact adjacent cross-dissolve.',
  );
  await expect(page.locator('.source-add-feedback')).toHaveText('');
  await expect(page.locator('.source-add-feedback')).not.toHaveAttribute('data-added-clip-id', /./);
  await expect(page.getByRole('region', { name: 'Source review', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin source review', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.source-preview')).toHaveAttribute('data-media-id', assets[0]!.id);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '29');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '10');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '30');
  await expect(page.locator('.source-review')).toHaveAttribute('data-source-excerpt-count', String(excerptCount));
  expect(
    await page.locator('video[data-source-decoder]').evaluate((video, original) => video === original, decoder),
  ).toBe(true);
  expect(await current(page)).toEqual(added);
  await flush(page);
  expect(memory.saves).toBe(saves);
  expect(memory.snapshot().clips).toEqual(added.clips);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('source proxy Play/Pause advances observed frames and stops at exclusive OUT without project edits', async ({
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
  expect(
    await page.locator('video[data-source-decoder]').evaluate((video: HTMLVideoElement) => ({
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      loop: video.loop,
    })),
  ).toEqual({ paused: true, muted: true, volume: 0, loop: false });
  await page.getByRole('button', { name: 'Play source preview', exact: true }).press('Space');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '71');
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(1);
  expect(await page.locator('video[data-source-decoder]').evaluate((video: HTMLVideoElement) => video.paused)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Play source preview', exact: true }).press('Enter');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  const restarted = Number(await page.locator('.source-preview').getAttribute('data-source-frame'));
  expect(restarted).toBeGreaterThanOrEqual(12);
  expect(restarted).toBeLessThan(71);
  await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  expect(await current(page)).toEqual(before);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(30);
  await flush(page);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

for (const action of ['scrub', 'mark', 'apply', 'reset', 'trim'] as const) {
  test(`source ${action} pauses proxy playback without timeline history or saves`, async ({ page }) => {
    const before = await current(page);
    await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
    await sourceRange(page, 10, 110);
    await sourceFrame(page, 20);
    await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
    if (action === 'scrub') await sourceFrame(page, 60);
    if (action === 'mark') await page.getByRole('button', { name: 'Mark source OUT', exact: true }).click();
    if (action === 'apply') await sourceRange(page, 30, 100);
    if (action === 'reset') await page.getByRole('button', { name: 'Reset source range', exact: true }).click();
    if (action === 'trim')
      await page.getByRole('slider', { name: 'Trim source start', exact: true }).press('ArrowRight');
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
    expect(await page.locator('video[data-source-decoder]').evaluate((video: HTMLVideoElement) => video.paused)).toBe(
      true,
    );
    expect(await current(page)).toEqual(before);
    await flush(page);
    expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
}

test('a one-frame source range remains exact; unapplied numeric drafts are not played or inserted', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceRange(page, 50, 51);
  await sourceFrame(page, 0);
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('10');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('100');
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '50');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  await expect(page.getByRole('spinbutton', { name: 'Source IN', exact: true })).toHaveValue('10');
  const id = await addExcerpt(page);
  expect((await current(page)).clips.find((clip) => clip.id === id)).toMatchObject({ sourceIn: 50, sourceOut: 51 });
});

for (const action of ['pause', 'scrub', 'tab', 'asset', 'project', 'close'] as const) {
  test(`an actual source native play deferred across ${action} never restarts an obsolete viewer`, async ({ page }) => {
    await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
    await sourceFrame(page, 20);
    await page.evaluate(() => {
      const video = globalThis.document.querySelector<HTMLVideoElement>('video[data-source-decoder]')!;
      const nativePlay = video.play.bind(video);
      const scope = globalThis as unknown as { releaseSourcePlay: () => Promise<void>; oldSource: HTMLVideoElement };
      scope.oldSource = video;
      video.play = () => {
        // Start the real native operation while its resource still exists, but
        // gate completion across cancellation. Calling play on a disposed,
        // src-less video can remain pending and is not an obsolete completion.
        const playing = nativePlay();
        const released = new Promise<void>((resolve) => {
          scope.releaseSourcePlay = async () => resolve();
        });
        return playing.then(() => released);
      };
    });
    await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
    await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'starting');
    await page.waitForFunction(
      () => typeof (globalThis as unknown as { releaseSourcePlay?: unknown }).releaseSourcePlay === 'function',
    );
    if (action === 'pause') await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
    if (action === 'scrub') await sourceFrame(page, 55);
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
      await expect(page.locator('video[data-source-decoder]')).toHaveCount(0);
    if (action === 'asset')
      await expect(page.locator('.source-preview')).toHaveAttribute('data-media-id', assets[1]!.id);
    await page.evaluate(async () => {
      await (globalThis as unknown as { releaseSourcePlay: () => Promise<void> }).releaseSourcePlay().catch(() => {});
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect(await page.evaluate(() => (globalThis as unknown as { oldSource: HTMLVideoElement }).oldSource.paused)).toBe(
      true,
    );
    if (action === 'pause' || action === 'scrub') {
      await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
      await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeEnabled();
    }
    if (action === 'scrub') await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '55');
    await flush(page);
    expect(memory.saves).toBe(0);
  });
}

test('source play failure stays explicit and Retry restores the one muted proxy decoder', async ({ page }) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 20);
  await page.locator('video[data-source-decoder]').evaluate((video: HTMLVideoElement) => {
    video.play = () => Promise.reject(new Error('Deliberate source play rejection'));
  });
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview [role="alert"]')).toContainText('Deliberate source play rejection');
  await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '20');
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'playing');
  await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
  await flush(page);
  expect(memory.saves).toBe(0);
});

test('a cancelled never-settling source play has a bounded failure and reachable Retry', async ({ page }) => {
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  await sourceFrame(page, 20);
  await page.locator('video[data-source-decoder]').evaluate((video: HTMLVideoElement) => {
    video.play = () => new Promise<void>(() => {});
  });
  await page.getByRole('button', { name: 'Play source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'starting');
  await page.getByRole('button', { name: 'Pause source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-status', 'paused');
  await expect(page.locator('.source-preview [role="alert"]')).toContainText('start did not finish within 5 seconds.');
  await page.getByRole('button', { name: 'Retry source preview', exact: true }).click();
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '20');
  await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeEnabled();
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(1);
  await flush(page);
  expect(memory.saves).toBe(0);
});

test('source IN/OUT targets, omitted footage and reversible drafts remain reachable on a short compact viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true }).click();
  // The compact Media drawer intentionally covers the left of the viewer.
  await page.getByRole('button', { name: 'Toggle Media panel', exact: true }).click();
  await sourceRange(page, 25, 90);
  await sourceFrame(page, 50);
  const handles = page.locator('.source-trim-handle');
  const sizes = await handles.evaluateAll((elements) =>
    elements.map((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      text: element.textContent?.trim(),
    })),
  );
  expect(sizes).toEqual([
    { width: 30, height: 28, text: 'IN' },
    { width: 30, height: 28, text: 'OUT' },
  ]);
  await expect(page.locator('.source-range-description')).toContainText('25 before / 30 after');
  for (const edge of ['before', 'after'])
    expect(
      await page.locator(`.source-range-omitted.${edge}`).evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(0);
  const handle = page.getByRole('slider', { name: 'Trim source start', exact: true });
  // A merely intersecting handle can sit behind the pinned source header in
  // Firefox. Scroll it into the usable viewport before starting real capture.
  await handle.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const box = await handle.boundingBox();
  if (!box) throw new Error('Source IN handle must be visible');
  expect(
    await handle.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    }),
  ).toBe(true);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2);
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-range-draft', 'true');
  await expect(page.getByRole('button', { name: 'Play source preview', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '25');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '50');
  await handle.press('Home');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-in', '0');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '0');
  await page.getByRole('slider', { name: 'Trim source end', exact: true }).press('End');
  await expect(page.locator('.source-range-strip')).toHaveAttribute('data-source-out', '120');
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '119');
  await flush(page);
  expect(memory.saves).toBe(0);
});
