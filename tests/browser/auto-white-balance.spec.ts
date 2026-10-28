import { expect, test, type Page, type Route } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyCommand } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  frameIlluminant,
  poolWhiteBalance,
  whiteBalanceWindow,
  type AnalysisFrame,
  type WhiteBalance,
} from '../../src/shared/white-balance.js';
import { whiteBalanceCommands } from '../../src/shared/auto-colour.js';
import { expandedInspectorPreferences, inspectorTab } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

/**
 * A disposable proxy in the editing-proxy format: 60 black frames, then 60 frames of grey patches
 * (40 × 36, aligned with the 4:2:0 chroma) under a blue cast. It replaces pattern-a's proxy in this spec.
 */
async function castProxy(directory: string): Promise<Buffer> {
  const output = path.join(directory, 'blue-cast-patches.mp4');
  await promisify(execFile)(process.env['PASCAP_FFMPEG'] ?? 'ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'],
    ...['-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=30000/1001', '-frames:v', '120'],
    '-vf',
    [
      'format=yuv444p',
      "geq=lum='48+18*mod(floor(X/40)*5+floor(Y/36)*3\\,8)':cb=128:cr=128",
      'format=rgb24',
      'colorchannelmixer=rr=0.82:bb=1.18',
      "drawbox=c=black:t=fill:enable='lt(n\\,60)'",
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
/** While set, reads of the cast proxy wait, so an analysis stays in progress. */
let held: Promise<void> | null = null;
let release = (): void => {};

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-awb-'));
  proxy = await castProxy(directory);
});

test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  held = null;
  const response = await request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources', name))
      throw new Error('Auto white balance tests require existing prepared synthetic videos; no import or preparation.');
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
  const document = createProject('auto-white-balance-memory', 'Auto white balance · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [createClip('cast', assets[0]!.id, 0, 120), createClip('plain', assets[1]!.id, 0, 60)];
  document.layers[0]!.transitions = [{ leftId: 'cast', rightId: 'plain', type: 'cut', duration: 0 }];
  document.layers.push(createLayer('empty', 'Empty row'));
  memory = await memoryProjects(
    page,
    applyCommand(document, { type: 'fades', layerId: 'video-1', opening: 0, closing: 0 }),
  );
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await inspectorTab(page, 'Track colour');
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

/** The pixels the analysis reads, decoded in the page and estimated here with the shared estimator. */
async function expectedBalance(page: Page, document: ProjectDocument, frame: number): Promise<WhiteBalance> {
  const placed = calculateLayout(document).clips.find((item) => frame >= item.start && frame < item.end)!;
  const projectFrames = whiteBalanceWindow(placed, frame);
  const sources = projectFrames.map((projectFrame) => placed.retiming.sourceAt(projectFrame - placed.start));
  const encoded = await page.evaluate(
    async ({ mediaId, frames }) => {
      const sampled = await window.pascapLab!.sampleFrames(mediaId, frames);
      return [...sampled].map(([source, image]) => {
        let binary = '';
        for (let index = 0; index < image.data.length; index += 8192)
          binary += String.fromCharCode(...image.data.subarray(index, index + 8192));
        return { source, width: image.width, height: image.height, data: btoa(binary) };
      });
    },
    { mediaId: placed.clip.mediaId, frames: sources },
  );
  const images = new Map<number, AnalysisFrame>(
    encoded.map(({ source, width, height, data }) => [
      source,
      { width, height, data: new Uint8ClampedArray(Buffer.from(data, 'base64')) },
    ]),
  );
  const balance = poolWhiteBalance(sources.map((source) => frameIlluminant(images.get(source)!)));
  if (!balance) throw new Error('Expected an estimate for these frames.');
  return balance;
}

function autoButton(page: Page) {
  return page.getByRole('button', { name: 'Auto white balance', exact: true });
}

async function captured(page: Page, expected: ProjectDocument): Promise<void> {
  await expect.poll(() => current(page)).toEqual(expected);
}

test('analysed pixels are exactly the compositor input of the clip at the playhead', async ({ page }) => {
  await seek(page, 60);
  const comparison = await page.evaluate(async (mediaId) => {
    const lab = window.pascapLab!;
    const image = (await lab.sampleFrames(mediaId, [60])).get(60)!;
    const canvas = lab.engine.capturePixels();
    const { width, height, data } = image;
    const scale = 1280 / width;
    let compared = 0;
    let largest = 0;
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++) {
        const centre = (y * width + x) * 4;
        let uniform = true;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            for (let channel = 0; channel < 3; channel++)
              uniform &&= data[((y + dy) * width + x + dx) * 4 + channel] === data[centre + channel];
        if (!uniform) continue;
        compared++;
        // Readback rows run bottom-up; compare the inner pixels of the magnified texel.
        for (const offset of [1, 2]) {
          const row = 719 - (y * scale + offset);
          const index = (row * 1280 + x * scale + offset) * 4;
          for (let channel = 0; channel < 3; channel++)
            largest = Math.max(largest, Math.abs(canvas[index + channel]! - data[centre + channel]!));
        }
      }
    const patch = (20 * width + 60) * 4;
    return { width, height, compared, largest, patch: [data[patch], data[patch + 1], data[patch + 2]] };
  }, assets[0]!.id);
  expect(comparison.width).toBe(320);
  expect(comparison.height).toBe(180);
  expect(comparison.compared).toBeGreaterThan(30_000);
  expect(comparison.largest).toBeLessThanOrEqual(1);
  // The blue cast survives decoding: blue well above red on a grey patch.
  expect(comparison.patch[2]! - comparison.patch[0]!).toBeGreaterThan(20);
});

test('keyframes the estimated Temperature and Tint at the playhead in one Undo step', async ({ page }) => {
  await seek(page, 60);
  const before = await current(page);
  const balance = await expectedBalance(page, before, 60);
  // A blue cast is corrected by warming.
  expect(balance.temperature).toBeGreaterThan(0.1);
  await expect(autoButton(page)).not.toHaveAttribute('aria-disabled');
  await autoButton(page).click();
  const expected = whiteBalanceCommands(before.layers[0]!, 60, balance).reduce(applyCommand, before);
  await captured(page, expected);
  await expect(page.getByRole('button', { name: 'Keyframe Temperature', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('spinbutton', { name: 'Temperature', exact: true })).toHaveValue(
    String(balance.temperature),
  );
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot()).toEqual({ ...expected, revision: expected.revision + 1 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await current(page)).toEqual(expected);
});

test('follows changing light between two runs and reruns update only their two values', async ({ page }) => {
  const seeded = await current(page);
  seeded.layers[0]!.keyframes = [
    layerKeyframe(90, { ...EMPTY_KEY_VALUES, temperature: 1.5, tint: -0.8, exposure: 0.5 }, 'smooth'),
  ];
  memory.seed(seeded);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await inspectorTab(page, 'Track colour');
  await seek(page, 90);
  const first = await expectedBalance(page, seeded, 90);
  await autoButton(page).click();
  const once = structuredClone(seeded);
  once.layers[0]!.keyframes[0]!.values = { ...once.layers[0]!.keyframes[0]!.values, ...first };
  await captured(page, once);

  await seek(page, 150);
  const second = await expectedBalance(page, once, 150);
  await autoButton(page).click();
  const twice = whiteBalanceCommands(once.layers[0]!, 150, second).reduce(applyCommand, once);
  await captured(page, twice);
  expect(twice.layers[0]!.keyframes.map((key) => key.frame)).toEqual([90, 150]);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(once);
});

test('explains when it cannot run, and a cancelled or failed analysis leaves no edit', async ({ page }) => {
  const before = await current(page);
  await page.getByRole('button', { name: 'Select track Empty row', exact: true }).click();
  await expect(autoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(autoButton(page)).toHaveAttribute('title', /Move the playhead over a clip on Empty row/);
  // Playwright never clicks an aria-disabled button; activate it from the keyboard instead.
  await autoButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.auto-white-balance').getByRole('alert')).toHaveCount(0);
  expect(await current(page)).toEqual(before);
  await page.getByRole('button', { name: 'Select track Track 1', exact: true }).click();

  // The first two seconds of the cast clip are black: nothing to measure within a second of frame 10.
  await seek(page, 10);
  await autoButton(page).click();
  await expect(page.locator('.auto-white-balance').getByRole('alert')).toContainText('too dark');
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await seek(page, 60);
  await expect(page.locator('.auto-white-balance').getByRole('alert')).toHaveCount(0);
  held = new Promise((resolve) => {
    release = () => {
      held = null;
      resolve();
    };
  });
  await autoButton(page).click();
  await expect(page.getByRole('button', { name: 'Cancel automatic white balance' })).toBeVisible();
  await expect(autoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await autoButton(page).press('Escape');
  await expect(page.getByRole('button', { name: 'Cancel automatic white balance' })).toHaveCount(0);
  release();

  // Changing track cancels too.
  held = new Promise((resolve) => {
    release = () => {
      held = null;
      resolve();
    };
  });
  await autoButton(page).click();
  await expect(page.getByRole('button', { name: 'Cancel automatic white balance' })).toBeVisible();
  await page.getByRole('button', { name: 'Select track Empty row', exact: true }).click();
  release();
  await page.getByRole('button', { name: 'Select track Track 1', exact: true }).click();
  await expect(autoButton(page)).not.toHaveAttribute('aria-disabled');
  await page.evaluate(() => window.pascapLab!.flush());
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.auto-white-balance').getByRole('alert')).toHaveCount(0);
});
