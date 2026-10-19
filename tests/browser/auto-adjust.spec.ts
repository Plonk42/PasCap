import { expect, test, type Page, type Route } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  analyseAutoAdjust,
  AUTO_ADJUST_SETTINGS,
  autoAdjustFrames,
  scaleCorrection,
  type AutoCorrection,
} from '../../src/shared/auto-adjust.js';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import type { AnalysisFrame } from '../../src/shared/white-balance.js';
import { autoAdjustCommand } from '../../src/web/auto-adjust.js';
import { expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

/**
 * A disposable proxy in the editing-proxy format: 30 black frames, then 90 frames of coloured patches
 * (40 × 36, aligned with the 4:2:0 chroma) shot flat, with lifted blacks and lowered whites, under a
 * blue cast. It replaces pattern-a's proxy in this spec.
 */
async function flatProxy(directory: string): Promise<Buffer> {
  const output = path.join(directory, 'flat-patches.mp4');
  const patch = 'floor(X/40)*5+floor(Y/36)*3';
  await promisify(execFile)(process.env['PASCAP_FFMPEG'] ?? 'ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'],
    ...['-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=30000/1001', '-frames:v', '120'],
    '-vf',
    [
      'format=yuv444p',
      `geq=lum='62+13*mod(${patch}\\,8)':cb='128+22*(mod(${patch}\\,3)-1)':cr='128+22*(mod(${patch}+1\\,3)-1)'`,
      'format=rgb24',
      'colorchannelmixer=rr=0.86:bb=1.14',
      "drawbox=c=black:t=fill:enable='lt(n\\,30)'",
      'scale=out_color_matrix=bt709:out_range=tv',
      'format=yuv420p',
      'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    ].join(','),
    ...['-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p'],
    ...['-g', '15', '-bf', '0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'],
    ...['-color_range', 'tv', '-video_track_timescale', '30000', '-movflags', '+faststart', output],
  ]);
  return readFile(output);
}

async function fulfilRange(route: Route, bytes: Buffer): Promise<void> {
  const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers()['range'] ?? '');
  if (!range) {
    await route.fulfill({ status: 200, contentType: 'video/mp4', body: bytes });
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(Number(range[2]), bytes.length - 1);
  await route.fulfill({
    status: 206,
    contentType: 'video/mp4',
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    body: bytes.subarray(start, end + 1),
  });
}

let directory: string;
let proxy: Buffer;
let memory: MemoryProjects;
let unexpected: string[];
let assets: MediaAsset[];
let proxyReads: number;
/** While set, reads of the flat proxy wait, so an analysis stays in progress. */
let held: Promise<void> | null = null;
let release = (): void => {};

function hold(): void {
  held = new Promise((resolve) => {
    release = () => {
      held = null;
      resolve();
    };
  });
}

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-auto-adjust-'));
  proxy = await flatProxy(directory);
});

test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  proxyReads = 0;
  held = null;
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources', name))
      throw new Error('Auto adjust tests require existing prepared synthetic videos; no import or preparation.');
    return asset;
  });
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [], missing: [] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    if (method === 'GET' && pathname === `/api/media/${assets[0]!.id}/proxy`) {
      proxyReads++;
      if (held) await held;
      // A cancelled analysis terminates its reader while a read waits.
      await fulfilRange(route, proxy).catch(() => undefined);
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
  const document = createProject('auto-adjust-memory', 'Auto adjust · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [createClip('flat', assets[0]!.id, 30, 120), createClip('dark', assets[0]!.id, 0, 30)];
  document.layers[0]!.transitions = [{ leftId: 'flat', rightId: 'dark', type: 'cut', duration: 0 }];
  document.layers.push(createLayer('empty', 'Empty row'));
  memory = await memoryProjects(
    page,
    applyCommand(document, { type: 'fades', layerId: 'video-1', opening: 0, closing: 0 }),
  );
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await inspectorTab(page, 'Track');
  await seek(page, 45);
});

test.afterEach(() => {
  release();
  expect(unexpected, 'No real-store writes, imports, preparation, exports or unowned media requests').toEqual([]);
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame };
      }),
    )
    .toEqual({ status: 'paused', frame });
}

async function checksum(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bytes = window.pascapLab!.engine.capturePixels();
    let sum = 2_166_136_261;
    for (let index = 0; index < bytes.length; index++) sum = Math.imul(sum ^ bytes[index]!, 16_777_619) >>> 0;
    return sum;
  });
}

/** The pixels the analysis reads, decoded in the page, and the correction the shared estimator fits to them. */
async function expectedCorrection(page: Page): Promise<AutoCorrection> {
  const frames = autoAdjustFrames(30, 120);
  const encoded = await page.evaluate(
    async ({ mediaId, sources }) => {
      const sampled = await window.pascapLab!.sampleFrames(mediaId, sources);
      return [...sampled].map(([source, image]) => {
        let binary = '';
        for (let index = 0; index < image.data.length; index += 8192)
          binary += String.fromCharCode(...image.data.subarray(index, index + 8192));
        return { source, width: image.width, height: image.height, data: btoa(binary) };
      });
    },
    { mediaId: assets[0]!.id, sources: frames },
  );
  const images = new Map<number, AnalysisFrame>(
    encoded.map(({ source, width, height, data }) => [
      source,
      { width, height, data: new Uint8ClampedArray(Buffer.from(data, 'base64')) },
    ]),
  );
  const correction = analyseAutoAdjust(frames.map((source) => images.get(source)!));
  if (!correction) throw new Error('Expected a correction for these frames.');
  return correction;
}

const auto = (page: Page) => page.locator('summary[aria-label="Auto adjust"]');
const apply = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true });
const intensity = (page: Page) => page.getByRole('spinbutton', { name: 'Auto adjust intensity', exact: true });

function applied(document: ProjectDocument, correction: AutoCorrection, intensity: number): ProjectDocument {
  return applyCommand(document, autoAdjustCommand(document.layers[0]!, correction, intensity)!);
}

test('previews the analysed correction, and Apply sets the ten settings in one Undo step', async ({ page }) => {
  const before = await current(page);
  const correction = await expectedCorrection(page);
  // Flat footage under a blue cast: warmed, black point lowered and contrast restored.
  expect(correction.temperature).toBeGreaterThan(0.1);
  expect(correction.blacks).toBeLessThan(0);
  expect(correction.contrast).toBeGreaterThan(1);
  const graded = await checksum(page);
  const reads = proxyReads;

  await auto(page).click();
  await expect(apply(page)).toBeVisible();
  await expect(intensity(page)).toHaveValue('80');
  expect(proxyReads).toBeGreaterThan(reads);
  await expect.poll(() => checksum(page)).not.toBe(graded);
  const previewed = await checksum(page);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  // Escape cancels: the preview returns to the track's grade and nothing is edited.
  await intensity(page).focus();
  await page.keyboard.press('Escape');
  await expect(apply(page)).toHaveCount(0);
  await expect(auto(page)).toBeFocused();
  await expect.poll(() => checksum(page)).toBe(graded);
  expect(await current(page)).toEqual(before);

  // Reopening the same clip reuses its analysis without decoding again.
  const decoded = proxyReads;
  await auto(page).click();
  await expect(apply(page)).toBeVisible();
  await expect.poll(() => checksum(page)).toBe(previewed);
  await apply(page).click();
  await expect(apply(page)).toHaveCount(0);
  expect(proxyReads).toBe(decoded);
  // The initial 80% applies exactly the analysed correction.
  const expected = applied(before, correction, 0.8);
  await expect.poll(() => current(page)).toEqual(expected);
  for (const setting of AUTO_ADJUST_SETTINGS) expect(expected.layers[0]!.colour[setting]).toBe(correction[setting]);
  await expect.poll(() => checksum(page)).toBe(previewed);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot()).toEqual({ ...expected, revision: expected.revision + 1 });

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect.poll(() => checksum(page)).toBe(graded);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await current(page)).toEqual(expected);
});

test('Intensity scales the correction, exaggerates it above 80%, and a later Apply replaces it in one Undo step', async ({
  page,
}) => {
  const before = await current(page);
  const correction = await expectedCorrection(page);
  const graded = await checksum(page);
  await auto(page).click();
  await expect(apply(page)).toBeVisible();
  await expect.poll(() => checksum(page)).not.toBe(graded);
  const suggested = await checksum(page);
  await intensity(page).fill('50');
  await intensity(page).press('Enter');
  await expect.poll(() => checksum(page)).not.toBe(suggested);
  expect(await current(page)).toEqual(before);
  await apply(page).click();
  const half = applied(before, correction, 0.5);
  await expect.poll(() => current(page)).toEqual(half);
  expect(half.layers[0]!.colour.contrast).toBe(scaleCorrection(correction, 0.5).contrast);

  // Reopening shows the intensity last applied; Reset intensity returns to 80%.
  await auto(page).click();
  await expect(intensity(page)).toHaveValue('50');
  await page.getByRole('button', { name: 'Reset intensity', exact: true }).click();
  await expect(intensity(page)).toHaveValue('80');
  await expect.poll(() => checksum(page)).toBe(suggested);
  // 100% exaggerates the analysed correction: warmer and more contrast than suggested.
  await intensity(page).fill('100');
  await intensity(page).press('Enter');
  await expect.poll(() => checksum(page)).not.toBe(suggested);
  await apply(page).click();
  const strong = applied(half, correction, 1);
  await expect.poll(() => current(page)).toEqual(strong);
  expect(strong.layers[0]!.colour.temperature).toBeGreaterThan(correction.temperature);
  expect(strong.layers[0]!.colour.contrast).toBeGreaterThan(correction.contrast);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(half);
});

test('leaves animated settings and keyframes unchanged and says so', async ({ page }) => {
  const seeded = await current(page);
  seeded.layers[0]!.colour = { ...seeded.layers[0]!.colour, exposure: 0.25, hue: 15, hdr: 0.3 };
  seeded.layers[0]!.keyframes = [
    sharedPoint(20, { exposure: 0.5, opacity: 0.8 }),
    sharedPoint(80, { saturation: 1.3 }, 'smooth'),
  ];
  memory.seed(seeded);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await inspectorTab(page, 'Track');
  await seek(page, 45);
  const correction = await expectedCorrection(page);
  await auto(page).click();
  await expect(page.getByText('Saturation is animated: not changed', { exact: true })).toBeVisible();
  await expect(page.getByText('Exposure is animated: not changed', { exact: true })).toBeVisible();
  await apply(page).click();
  const expected = applied(seeded, correction, 0.8);
  await expect.poll(() => current(page)).toEqual(expected);
  const colour = expected.layers[0]!.colour;
  expect([colour.exposure, colour.saturation, colour.hue, colour.hdr]).toEqual([0.25, 1, 15, 0.3]);
  expect(colour.blacks).toBe(correction.blacks);
  expect(expected.layers[0]!.keyframes).toEqual(seeded.layers[0]!.keyframes);
  expect(expected.layers[0]!.opacity).toBe(seeded.layers[0]!.opacity);
});

test('explains when it cannot run, and a cancelled or failed analysis leaves no edit', async ({ page }) => {
  const before = await current(page);
  const graded = await checksum(page);
  await page.getByRole('button', { name: 'Select track Empty row', exact: true }).click();
  const disabled = page.getByRole('button', { name: 'Auto adjust', exact: true });
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(disabled).toHaveAttribute('title', 'Move the playhead over a clip on Empty row to analyse it.');
  // Playwright never clicks an aria-disabled button; activate it from the keyboard instead.
  await disabled.focus();
  await page.keyboard.press('Enter');
  await expect(apply(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Select track Track 1', exact: true }).click();

  // The dark clip is black throughout: nothing to measure.
  await seek(page, 100);
  await auto(page).click();
  await expect(page.locator('.auto-adjust-panel').getByRole('alert')).toHaveText(
    'These frames are too dark or too uniform to analyse.',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.auto-adjust-panel').getByRole('alert')).toHaveCount(0);

  // Escape during the analysis cancels it.
  await seek(page, 45);
  hold();
  await auto(page).click();
  await expect(page.locator('.auto-adjust-progress')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.auto-adjust-progress')).toHaveCount(0);
  release();

  // So does changing track; an outside click closes a finished analysis like Cancel.
  hold();
  await auto(page).click();
  await expect(page.locator('.auto-adjust-progress')).toBeVisible();
  await page.getByRole('button', { name: 'Select track Empty row', exact: true }).click();
  release();
  await page.getByRole('button', { name: 'Select track Track 1', exact: true }).click();
  await auto(page).click();
  await expect(apply(page)).toBeVisible();
  await page.getByRole('heading', { level: 2, name: /^Media/ }).click();
  await expect(apply(page)).toHaveCount(0);

  await expect.poll(() => checksum(page)).toBe(graded);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
