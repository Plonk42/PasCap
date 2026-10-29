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
  autoAdjustWindow,
  scaleCorrection,
  type AutoCorrection,
} from '../../src/shared/auto-adjust.js';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { analysisSize, frameIlluminant, poolWhiteBalance, type AnalysisFrame } from '../../src/shared/white-balance.js';
import { analysisFrameArgs } from '../../src/server/stills.js';
import { autoAdjustCommand } from '../../src/shared/auto-colour.js';
import { layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { autoAdjustCommands, autoAdjustTarget, type AutoAdjustContext } from '../../src/web/auto-adjust.js';
import { gradeOwnerOf } from '../../src/web/colour-owner.js';
import { expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

/**
 * A disposable proxy in the editing-proxy format: 30 black frames, then 90 frames of coloured patches
 * (40 × 36, aligned with the 4:2:0 chroma) shot flat, with lifted blacks and lowered whites, under a
 * blue cast. It replaces pattern-a's proxy in this spec. `scale` enlarges it, keeping the patches aligned.
 */
async function flatProxy(directory: string, scale = 1): Promise<Buffer> {
  const output = path.join(directory, `flat-patches-${scale}.mp4`);
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
      `scale=${320 * scale}:${180 * scale}:flags=neighbor`,
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
  await inspectorTab(page, 'Clip grade');
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

/** The pixels the analysis reads, decoded in the page. */
async function pageFrames(page: Page, frames: readonly number[]): Promise<Map<number, AnalysisFrame>> {
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
  return new Map<number, AnalysisFrame>(
    encoded.map(({ source, width, height, data }) => [
      source,
      { width, height, data: new Uint8ClampedArray(Buffer.from(data, 'base64')) },
    ]),
  );
}

/** The correction the shared estimator fits to the pixels the page decodes. */
async function expectedCorrection(page: Page, frames = autoAdjustFrames(30, 120)): Promise<AutoCorrection> {
  const images = await pageFrames(page, frames);
  const correction = analyseAutoAdjust(frames.map((source) => images.get(source)!));
  if (!correction) throw new Error('Expected a correction for these frames.');
  return correction;
}

/** Source frames a keyframe at `frame` analyses: within 1 s of it, in the flat clip (source 30 at frame 0). */
function keyframeFrames(document: ProjectDocument, frame: number): number[] {
  const clip = calculateLayout(document).clips.find((item) => item.clip.id === 'flat')!;
  return autoAdjustWindow(clip, frame).map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start));
}

/** Auto on the flat clip's grade, with the playhead at `playhead`. */
function context(document: ProjectDocument, playhead: number, clipId = 'flat'): AutoAdjustContext {
  return { project: document, clipId, layout: calculateLayout(document), assets, playhead };
}

/** The flat clip's grade keyed at the source frame shown at project frame `frame`, at the initial intensity. */
function keyframed(document: ProjectDocument, frame: number, correction: AutoCorrection): ProjectDocument {
  const at = context(document, frame);
  const target = autoAdjustTarget(at, 'playhead').target!;
  const commands = autoAdjustCommands(at, target, 'keyframe', new Map([['flat', correction]]), 0.8);
  return commands.reduce(applyCommand, document);
}

const auto = (page: Page) => page.locator('summary[aria-label="Auto adjust"]');
const apply = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true });
const intensity = (page: Page) => page.getByRole('spinbutton', { name: 'Auto adjust intensity', exact: true });
/** A Source (Playhead, This clip, Every clip on Track 1) or Apply as (Grade values, Keyframe at playhead) choice. */
const choice = (
  page: Page,
  name: 'Playhead' | 'This clip' | 'Every clip on Track 1' | 'Grade values' | 'Keyframe at playhead',
) => page.getByRole('radio', { name, exact: true });
const flatGrade = (document: ProjectDocument) => document.clips.find((clip) => clip.id === 'flat')!.grade;
const selectClip = (page: Page, clipId: string) =>
  page.locator(`[data-clip-id="${clipId}"] .timeline-clip-body`).click();

/** The flat clip's grade values set by Auto. */
function applied(document: ProjectDocument, correction: AutoCorrection, intensity: number): ProjectDocument {
  const owner = gradeOwnerOf(document, 'flat')!;
  return applyCommand(document, autoAdjustCommand(owner, correction, intensity, { kind: 'clip', clipId: 'flat' })!);
}

test('the service reads the same pixels as the page for the estimate operation, and fits the same correction', async ({
  page,
}) => {
  const frames = autoAdjustFrames(30, 120);
  const small = proxy;
  const large = await flatProxy(directory, 4);
  try {
    await compareDecodes(page, frames, [
      [1, small],
      [4, large],
    ]);
  } finally {
    proxy = small;
  }
});

async function compareDecodes(
  page: Page,
  frames: number[],
  proxies: readonly (readonly [number, Buffer])[],
): Promise<void> {
  for (const [scale, bytes] of proxies) {
    proxy = bytes;
    const browser = await pageFrames(page, frames);
    const size = analysisSize(320 * scale, 180 * scale);
    const service = new Map<number, AnalysisFrame>();
    for (const frame of frames) {
      const { stdout } = await promisify(execFile)(
        process.env['PASCAP_FFMPEG'] ?? 'ffmpeg',
        analysisFrameArgs(path.join(directory, `flat-patches-${scale}.mp4`), size, frame, 'rgba'),
        { encoding: 'buffer', maxBuffer: size.width * size.height * 4 + 1 },
      );
      service.set(frame, { ...size, data: new Uint8Array(stdout) });
    }
    let difference = 0;
    for (const frame of frames) {
      const [left, right] = [browser.get(frame)!, service.get(frame)!];
      expect([right.width, right.height]).toEqual([left.width, left.height]);
      for (let index = 0; index < left.data.length; index++)
        difference += Math.abs(left.data[index]! - right.data[index]!);
    }
    // Colour conversion and chroma upsampling round differently, and Chrome's unscaled readback (libyuv)
    // approximates BT.709's blue coefficient (2.0 for 2.112): RGB codes differ by about one on average.
    const meanDifference = difference / (frames.length * size.width * size.height * 3);
    expect(meanDifference, `mean RGB code difference at ${scale}×`).toBeLessThan(1.5);
    const ordered = (images: Map<number, AnalysisFrame>) => frames.map((frame) => images.get(frame)!);
    const fromBrowser = analyseAutoAdjust(ordered(browser))!;
    const fromService = analyseAutoAdjust(ordered(service))!;
    for (const setting of AUTO_ADJUST_SETTINGS)
      expect(Math.abs(fromService[setting] - fromBrowser[setting]), `${setting} at ${scale}×`).toBeLessThanOrEqual(
        0.07,
      );
    const balanceBrowser = poolWhiteBalance(ordered(browser).map(frameIlluminant))!;
    const balanceService = poolWhiteBalance(ordered(service).map(frameIlluminant))!;
    expect(Math.abs(balanceService.temperature - balanceBrowser.temperature)).toBeLessThanOrEqual(0.07);
    expect(Math.abs(balanceService.tint - balanceBrowser.tint)).toBeLessThanOrEqual(0.03);
    if (scale === 1) await expectExactConversion(service.get(frames[8]!)!, frames[8]!);
  }
}

/** The service's pixels at the patch centres are the exact BT.709 limited-range conversion of the proxy's codes. */
async function expectExactConversion(image: AnalysisFrame, frame: number): Promise<void> {
  const { stdout: yuv } = await promisify(execFile)(
    process.env['PASCAP_FFMPEG'] ?? 'ffmpeg',
    analysisFrameArgs(path.join(directory, 'flat-patches-1.mp4'), { width: 320, height: 180 }, frame, 'rgba').map(
      (arg) => (arg.startsWith('scale=') ? 'format=yuv420p' : arg),
    ),
    { encoding: 'buffer', maxBuffer: 320 * 180 * 2 },
  );
  for (let y = 18; y < 180; y += 36)
    for (let x = 20; x < 320; x += 40) {
      const chroma = (y >> 1) * 160 + (x >> 1);
      const luma = (yuv[y * 320 + x]! - 16) / 219;
      const [cb, cr] = [yuv[320 * 180 + chroma]!, yuv[320 * 225 + chroma]!].map((code) => (code - 128) / 224);
      const exact = [luma + 1.5748 * cr!, luma - 0.18732 * cb! - 0.46812 * cr!, luma + 1.8556 * cb!];
      for (const [channel, value] of exact.entries())
        expect(
          Math.abs(image.data[(y * 320 + x) * 4 + channel]! - Math.min(255, Math.max(0, value * 255))),
        ).toBeLessThanOrEqual(1);
    }
}

test('previews the analysed correction, and Apply sets the eleven settings in one Undo step', async ({ page }) => {
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

  // Escape cancels: the preview returns to the clip's grade and nothing is edited.
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
  for (const setting of AUTO_ADJUST_SETTINGS) expect(flatGrade(expected).colour[setting]).toBe(correction[setting]);
  expect(expected.layers).toEqual(before.layers);
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
  expect(flatGrade(half).colour.contrast).toBe(scaleCorrection(correction, 0.5).contrast);

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
  expect(flatGrade(strong).colour.temperature).toBeGreaterThan(correction.temperature);
  expect(flatGrade(strong).colour.contrast).toBeGreaterThan(correction.contrast);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(half);
});

test('leaves animated settings and keyframes unchanged and says so', async ({ page }) => {
  const seeded = await current(page);
  flatGrade(seeded).colour = { ...flatGrade(seeded).colour, exposure: 0.25, hue: 15, hdr: 0.3, vibrance: 0.4 };
  flatGrade(seeded).keyframes = [
    layerKeyAsGradeKey(sharedPoint(50, { exposure: 0.5 })),
    layerKeyAsGradeKey(sharedPoint(110, { saturation: 1.3 }, 'smooth')),
  ];
  memory.seed(seeded);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await inspectorTab(page, 'Clip grade');
  await seek(page, 45);
  const correction = await expectedCorrection(page);
  await auto(page).click();
  // The grade animates Exposure and Saturation: Auto starts on a keyframe, the grade values remain a choice.
  await expect(choice(page, 'Playhead')).toBeChecked();
  await expect(choice(page, 'Keyframe at playhead')).toBeChecked();
  await choice(page, 'This clip').check();
  await expect(choice(page, 'Grade values')).toBeChecked();
  await expect(page.getByText('Saturation is animated: not changed', { exact: true })).toBeVisible();
  await expect(page.getByText('Exposure is animated: not changed', { exact: true })).toBeVisible();
  await apply(page).click();
  const expected = applied(seeded, correction, 0.8);
  await expect.poll(() => current(page)).toEqual(expected);
  const colour = flatGrade(expected).colour;
  expect([colour.exposure, colour.saturation, colour.hue, colour.hdr]).toEqual([0.25, 1, 15, 0.3]);
  expect(colour.blacks).toBe(correction.blacks);
  expect(colour.vibrance).toBe(correction.vibrance);
  expect(flatGrade(expected).keyframes).toEqual(flatGrade(seeded).keyframes);
  expect(expected.layers).toEqual(seeded.layers);
});

test('Keyframe at playhead keys the eleven settings from the frames around it, one keyframe per run', async ({
  page,
}) => {
  const before = await current(page);
  const first = await expectedCorrection(page, keyframeFrames(before, 45));
  const graded = await checksum(page);
  await auto(page).click();
  await expect(choice(page, 'This clip')).toBeChecked();
  await expect(choice(page, 'Grade values')).toBeChecked();
  // A keyframe takes the light at the playhead: it needs the Playhead source.
  await expect(choice(page, 'Keyframe at playhead')).toBeDisabled();
  await expect(apply(page)).toBeVisible();
  const reads = proxyReads;
  await choice(page, 'Playhead').check();
  await choice(page, 'Keyframe at playhead').check();
  await expect(apply(page)).toBeVisible();
  await expect(intensity(page)).toHaveValue('80');
  expect(proxyReads).toBeGreaterThan(reads);
  await expect.poll(() => checksum(page)).not.toBe(graded);
  expect(await current(page)).toEqual(before);
  await apply(page).click();
  await expect(apply(page)).toHaveCount(0);
  const once = keyframed(before, 45, first);
  await expect.poll(() => current(page)).toEqual(once);
  // Project frame 45 shows source frame 75 of the flat clip.
  const key = flatGrade(once).keyframes[0]!;
  expect(key.frame).toBe(75);
  for (const setting of AUTO_ADJUST_SETTINGS) expect(key.values[setting]).toBe(first[setting]);
  expect(flatGrade(once).colour).toEqual(flatGrade(before).colour);
  expect(once.layers).toEqual(before.layers);

  // Now animated, Auto starts on a keyframe; another frame is another analysis and another keyframe.
  await seek(page, 80);
  const second = await expectedCorrection(page, keyframeFrames(before, 80));
  await auto(page).click();
  await expect(choice(page, 'Keyframe at playhead')).toBeChecked();
  await expect(apply(page)).toBeVisible();
  await apply(page).click();
  const twice = keyframed(once, 80, second);
  await expect.poll(() => current(page)).toEqual(twice);
  expect(flatGrade(twice).keyframes.map((point) => point.frame)).toEqual([75, 110]);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(once);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

test('Grade values from the playhead set the clip grade from the second around it, sharing the keyframe analysis', async ({
  page,
}) => {
  const before = await current(page);
  const correction = await expectedCorrection(page, keyframeFrames(before, 45));
  await auto(page).click();
  await expect(apply(page)).toBeVisible();
  await choice(page, 'Playhead').check();
  await expect(choice(page, 'Grade values')).toBeChecked();
  await expect(apply(page)).toBeVisible();
  // A keyframe analyses the same frames: switching to it decodes nothing more.
  const reads = proxyReads;
  await choice(page, 'Keyframe at playhead').check();
  await expect(apply(page)).toBeVisible();
  await choice(page, 'Grade values').check();
  await expect(apply(page)).toBeVisible();
  expect(proxyReads).toBe(reads);
  await apply(page).click();
  await expect(apply(page)).toHaveCount(0);
  const expected = applied(before, correction, 0.8);
  await expect.poll(() => current(page)).toEqual(expected);
  for (const setting of AUTO_ADJUST_SETTINGS) expect(flatGrade(expected).colour[setting]).toBe(correction[setting]);
  expect(flatGrade(expected).keyframes).toEqual(flatGrade(before).keyframes);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

test('the Track source grades each clip of the track on its own in one Undo step, never a keyframe', async ({
  page,
}) => {
  // A second flat range replaces the black clip, so that both clips can be analysed.
  const seeded = await current(page);
  seeded.clips[1] = { ...seeded.clips[1]!, id: 'later', sourceIn: 40, sourceOut: 120 };
  // The later clip's grade animates Exposure, which applying values leaves to its keyframe.
  seeded.clips[1].grade.keyframes = [layerKeyAsGradeKey(sharedPoint(60, { exposure: 0.2 }))];
  seeded.layers[0]!.transitions = [{ leftId: 'flat', rightId: 'later', type: 'cut', duration: 0 }];
  memory.seed(projectSchema.parse(seeded));
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
  await inspectorTab(page, 'Clip grade');
  await seek(page, 45);
  const before = await current(page);
  const target = autoAdjustTarget(context(before, 45), 'track').target!;
  expect(target.parts.map(({ clip, sourceFrames }) => [clip.clip.id, sourceFrames])).toEqual([
    ['flat', autoAdjustFrames(30, 120)],
    ['later', autoAdjustFrames(40, 120)],
  ]);
  const corrections = new Map([
    ['flat', await expectedCorrection(page, autoAdjustFrames(30, 120))],
    ['later', await expectedCorrection(page, autoAdjustFrames(40, 120))],
  ]);
  await auto(page).click();
  await expect(apply(page)).toBeVisible();
  await choice(page, 'Playhead').check();
  await choice(page, 'Keyframe at playhead').check();
  await choice(page, 'Every clip on Track 1').check();
  await expect(choice(page, 'Grade values')).toBeChecked();
  await expect(choice(page, 'Keyframe at playhead')).toBeDisabled();
  // Keyframes go to the selected clip only; the grade values reach each clip's grade.
  await expect(page.locator('label', { has: choice(page, 'Keyframe at playhead') })).toHaveAttribute(
    'title',
    'Keyframes go to this clip only, at the playhead.',
  );
  await expect(page.locator('label', { has: choice(page, 'Grade values') })).toContainText('each clip’s grade');
  await expect(page.locator('.auto-adjust-source')).toHaveText('From 2 clips on Track 1, each on its own');
  const applyAll = page.getByRole('button', { name: 'Apply to 2 clips', exact: true });
  await expect(applyAll).toBeVisible();
  await expect(page.locator('.auto-adjust-scope')).toHaveText('1 of 2 clips keep their animated settings.');
  await expect(page.getByText('Exposure is animated: not changed', { exact: true })).toBeVisible();
  await applyAll.click();
  const expected = autoAdjustCommands(context(before, 45), target, 'values', corrections, 0.8).reduce(
    applyCommand,
    before,
  );
  await expect.poll(() => current(page)).toEqual(expected);
  expect(expected.clips.map((clip) => clip.grade.colour.temperature)).toEqual([
    corrections.get('flat')!.temperature,
    corrections.get('later')!.temperature,
  ]);
  expect(expected.layers).toEqual(before.layers);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

test('explains when it cannot run, and a cancelled or failed analysis leaves no edit', async ({ page }) => {
  const before = await current(page);
  const graded = await checksum(page);
  // Auto writes clip grades only.
  await inspectorTab(page, 'Track colour');
  await expect(auto(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Auto adjust', exact: true })).toHaveCount(0);
  await inspectorTab(page, 'Clip grade');

  // Off the clip, the Playhead source explains itself; the whole clip remains a choice.
  await seek(page, 100);
  await auto(page).click();
  await choice(page, 'Playhead').check();
  await expect(page.locator('.auto-adjust-panel')).toContainText(
    'Move the playhead over this clip to analyse 1 s around it.',
  );
  await expect(apply(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Each clip of the track is analysed on its own, and the black one has nothing to measure.
  await auto(page).click();
  await choice(page, 'Every clip on Track 1').check();
  await expect(page.locator('.auto-adjust-panel').getByRole('alert')).toHaveText(
    /^Clip 2 \(pattern-a\): These frames are too dark or too uniform to analyse\.$/,
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // The dark clip is black throughout: nothing to measure.
  await selectClip(page, 'dark');
  await auto(page).click();
  await expect(page.locator('.auto-adjust-panel').getByRole('alert')).toHaveText(
    'These frames are too dark or too uniform to analyse.',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.auto-adjust-panel').getByRole('alert')).toHaveCount(0);

  // Escape during the analysis cancels it.
  await selectClip(page, 'flat');
  await seek(page, 45);
  hold();
  await auto(page).click();
  await expect(page.locator('.auto-adjust-progress')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.auto-adjust-progress')).toHaveCount(0);
  release();

  // So does selecting another clip; an outside click closes a finished analysis like Cancel.
  hold();
  await auto(page).click();
  await expect(page.locator('.auto-adjust-progress')).toBeVisible();
  await selectClip(page, 'dark');
  release();
  await selectClip(page, 'flat');
  await seek(page, 45);
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
