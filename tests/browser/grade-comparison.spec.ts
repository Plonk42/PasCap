import { test as browserTest, expect, type Locator, type Page } from '@playwright/test';
import type { PreviewDiagnostics } from '../../src/preview/engine.js';
import type { AudioAsset } from '../../src/shared/audio.js';
import { COLOUR_CONTROLS, createColourSettings, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { expandedInspectorPreferences, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';
import { installMusicEvidence, observeMusicPlayback, observeRealtimeHeadroom } from './music-evidence.js';

interface PixelSummary {
  checksum: number;
  bytes: number;
  rgbSum: number;
  nonblackPixels: number;
  opaque: boolean;
}

interface PlaybackObservations {
  notifications: number;
  gradedDraws: number;
  ungradedDraws: number;
  activations: {
    frame: number;
    timestamp: number;
    detail: number;
    playing: boolean;
    status: string;
    trusted: boolean;
    ungraded: boolean;
    checkpoint?: {
      state: PreviewDiagnostics;
      starts: number;
      pauses: number;
      active: boolean;
      generation: number | undefined;
    };
  }[];
  maximumAVDrift: number;
  violations: string[];
  samples: { frame: number; requestedFrame: number; sourceFrame: number; ungraded: boolean; generation: number }[];
}

declare global {
  interface Window {
    gradeComparisonPixels: Record<string, Uint8Array>;
    gradeComparisonNativeEvents: { seeking: number; seeked: number; loadstart: number };
    gradeComparisonPlayback: PlaybackObservations;
  }
}

interface ComparisonFixture {
  memory: MemoryProjects;
  single: ProjectDocument;
  layered: ProjectDocument;
  neutral: ProjectDocument;
  other: ProjectDocument;
  playback: ProjectDocument;
  guard: {
    permittedSaves: number;
    writes: number;
    allowPCM: boolean;
    proxyReads: number;
    pcmReads: number;
    blocked: string[];
  };
}

function singleProject(id: string, title: string, video: MediaAsset): ProjectDocument {
  const document = createProject(id, title);
  document.media.videoIds = [video.id];
  const clip = createClip('comparison-clip', video.id, 8, 108, document.layers[0]!.id);
  document.layers[0]!.colour = {
    ...createColourSettings(),
    temperature: 0.2,
    tint: -0.15,
    exposure: 0.7,
    brightness: 0.02,
    contrast: 1.15,
    hue: 28,
    saturation: 0.65,
    highlights: -0.25,
    shadows: 0.12,
  };
  document.layers[0]!.colour.hsl.red = { hue: -12, saturation: -0.3, lightness: 0.04 };
  document.layers[0]!.colour.curves.master = [
    { x: 0, y: 0.02 },
    { x: 0.4, y: 0.53 },
    { x: 1, y: 0.98 },
  ];
  document.layers[0]!.colour.curves.blue[1]!.y = 0.8;
  document.clips = [clip];
  return projectSchema.parse(document);
}

function layeredProject(videos: readonly MediaAsset[]): ProjectDocument {
  const document = createProject('comparison-layered', 'Layered grade comparison · memory-only');
  document.media.videoIds = videos.map((video) => video.id);
  document.layers = [
    createLayer('comparison-bottom', 'Bottom dissolve'),
    createLayer('comparison-black', 'Black-fade row'),
    createLayer('comparison-top', 'Top dissolve'),
  ];
  for (const [index, layer] of document.layers.entries()) {
    const rate = [0.8, 1, 1.25][index]!;
    const sourceIn = [8, 0, 10][index]!;
    const sourceOut = [72, 72, 110][index]!;
    const duration = index === 1 ? 72 : 80;
    layer.opacity = 0.9 - index * 0.1;
    layer.colour = { ...createColourSettings(), hue: 15 + index * 10, exposure: 0.15, saturation: 0.8 };
    layer.colour.hsl.cyan = { hue: index * 5 - 8, saturation: -0.2, lightness: 0.03 };
    layer.colour.curves.master = [
      { x: 0, y: 0.015 },
      { x: 0.5, y: 0.6 },
      { x: 1, y: 0.95 },
    ];
    layer.colour.curves.red[1]!.y = 0.85;
    layer.openingFade = 12;
    layer.closingFade = 12;
    layer.keyframes = [
      sharedPoint(
        0,
        {
          speed: rate,
          opacity: 0.8 - index * 0.1,
          temperature: 0.2 - index * 0.1,
          tint: -0.15 + index * 0.1,
          exposure: 0.7 - index * 0.5,
          brightness: 0.03,
          contrast: 1.25,
          hue: 35 + index * 20,
          saturation: 0.55,
          highlights: -0.3,
          shadows: 0.2,
        },
        'smooth',
      ),
      // A colour-only point must disappear from the neutral reference, not
      // acquire fabricated speed/opacity participation to satisfy the schema.
      sharedPoint(40, { exposure: -0.4, hue: -25, saturation: 1.4 }),
      sharedPoint(143, {
        opacity: 0.65 + index * 0.05,
        temperature: -0.2,
        tint: 0.15,
        exposure: 0.4,
        brightness: -0.02,
        contrast: 0.8,
        hue: -40,
        saturation: 1.3,
        highlights: 0.15,
        shadows: -0.1,
      }),
    ];
    // Keep a static channel active on both participants of each dissolve,
    // alongside row animation. Otherwise fully keyed rows would mask every
    // row base and could not expose an incomplete row-colour bypass.
    const staticChannel = index === 0 ? 'hue' : index === 2 ? 'exposure' : null;
    if (staticChannel) {
      for (const point of layer.keyframes) point.values[staticChannel] = null;
    }
    const clips = [0, 1].map((member) => {
      const clip = createClip(
        `comparison-${index}-${member}`,
        videos[(index + member) % 2]!.id,
        sourceIn,
        sourceOut,
        layer.id,
      );
      clip.start = member ? duration - (index === 1 ? 0 : 16) : 0;
      // The retained row Speed must override this deliberately different base.
      clip.speed = { mode: 'constant', rate: 1.6 };
      return clip;
    });
    document.clips.push(...clips);
    layer.transitions = [
      {
        leftId: clips[0]!.id,
        rightId: clips[1]!.id,
        type: index === 1 ? 'fade-through-black' : 'cross-dissolve',
        duration: index === 1 ? 12 : 16,
      },
    ];
  }
  return projectSchema.parse(document);
}

/** Change colour alone; preserve every non-colour channel, easing and source map. */
function neutralProject(document: ProjectDocument, id: string, title: string): ProjectDocument {
  const neutral = projectSchema.parse({ ...document, id, title });
  for (const layer of neutral.layers) {
    layer.colour = { ...NEUTRAL_COLOUR };
    layer.keyframes = layer.keyframes.flatMap((point) => {
      const values = { ...point.values };
      for (const { key } of COLOUR_CONTROLS) values[key] = null;
      return Object.values(values).some((value) => value !== null) ? [{ ...point, values }] : [];
    });
  }
  return projectSchema.parse(neutral);
}

/** Structural oracle independent of pixels, with no hard-coded schema version. */
function nonColourContract(document: ProjectDocument) {
  const { id: _id, title: _title, clips, layers, ...rest } = document;
  const colourKeys = new Set<string>(COLOUR_CONTROLS.map(({ key }) => key));
  return {
    ...rest,
    clips,
    layers: layers.map(({ colour: _colour, ...layer }) => ({
      ...layer,
      keyframes: layer.keyframes.flatMap((point) => {
        const values = Object.fromEntries(Object.entries(point.values).filter(([key]) => !colourKeys.has(key)));
        return Object.values(values).some((value) => value !== null) ? [{ ...point, values }] : [];
      }),
    })),
  };
}

const test = browserTest.extend<{ comparison: ComparisonFixture }>({
  comparison: async ({ page, request }, use) => {
    // Metadata reads only. Never reset fixtures, import, prepare or touch the
    // service's real project store. Only these existing synthetic proxies/PCM
    // may subsequently reach the service through the page's deny-by-default API.
    const mediaResponse = await request.get('/api/media');
    expect(mediaResponse.ok()).toBe(true);
    const library = (await mediaResponse.json()) as { assets: MediaAsset[] };
    const videos = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
      const asset = library.assets.find((candidate) => candidate.name === name && candidate.status === 'ready');
      expect(asset, `Existing prepared synthetic ${name} is required.`).toBeDefined();
      expect(asset!.prepared).not.toBeNull();
      expect(asset!.metadata.frameCount).toBe(120);
      return asset!;
    });
    const audioResponse = await request.get('/api/audio');
    expect(audioResponse.ok()).toBe(true);
    const audio = (await audioResponse.json()) as { assets: AudioAsset[] };
    const song = audio.assets.find((asset) => asset.name === 'test-music.wav' && asset.status === 'ready');
    expect(song, 'Existing prepared synthetic test-music.wav is required.').toBeDefined();

    const single = singleProject('comparison-single', 'Static grade comparison · memory-only', videos[0]!);
    const layered = layeredProject(videos);
    const neutral = neutralProject(layered, 'comparison-neutral', 'Neutral colour reference · memory-only');
    const other = singleProject('comparison-other', 'Other grade comparison · memory-only', videos[1]!);
    const playback = createProject('comparison-music', 'Music grade comparison · memory-only');
    playback.media = { videoIds: [videos[0]!.id], audioIds: [song!.id] };
    playback.layers[0]!.colour = { ...single.layers[0]!.colour };
    playback.clips = [
      {
        ...createClip('music-comparison-clip', videos[0]!.id, 0, 120, playback.layers[0]!.id),
        // Sixteen seconds leaves time for four real native activations under
        // software rendering without guessing a particular callback schedule.
        speed: { mode: 'constant', rate: 0.25 },
      },
    ];
    playback.music = [
      {
        id: 'comparison-music-track',
        mediaId: song!.id,
        sourceIn: 0,
        sourceOut: 120,
        start: 0,
        duration: 480,
        gainDb: -12,
        fadeIn: 0,
        fadeOut: 0,
        loop: true,
      },
    ];
    projectSchema.parse(playback);

    const guard = {
      permittedSaves: 0,
      writes: 0,
      allowPCM: false,
      proxyReads: 0,
      pcmReads: 0,
      blocked: [] as string[],
    };
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (method === 'GET' && path === '/api/media') {
        await route.fulfill({ json: { assets: videos } });
        return;
      }
      if (method === 'GET' && path === '/api/audio') {
        await route.fulfill({ json: { assets: [song!] } });
        return;
      }
      if (method === 'GET' && path === '/api/jobs') {
        await route.fulfill({ json: { jobs: [] } });
        return;
      }
      if (method === 'GET' && path === '/api/health') {
        await route.continue();
        return;
      }
      const video = videos.find(
        (asset) =>
          path === `/api/media/${asset.id}/proxy` ||
          asset.prepared!.thumbnailFrames.some((frame) => path === `/api/media/${asset.id}/thumbnail/${frame}`),
      );
      if (video && (method === 'GET' || method === 'HEAD')) {
        if (path.endsWith('/proxy')) guard.proxyReads++;
        await route.continue();
        return;
      }
      if (guard.allowPCM && path === `/api/audio/${song!.id}/playback` && (method === 'GET' || method === 'HEAD')) {
        if (method === 'GET') {
          const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers()['range'] ?? '');
          expect(range, 'PCM reads must retain their actual bounded byte ranges.').not.toBeNull();
          const length = Number(range![2]) - Number(range![1]) + 1;
          expect(length).toBeGreaterThan(0);
          expect(length).toBeLessThanOrEqual(65_536);
          guard.pcmReads++;
        }
        await route.continue();
        return;
      }
      guard.blocked.push(`${method} ${path}`);
      await route.abort('blockedbyclient');
    });
    // These later routes take precedence over the catch-all. The extra wrapper
    // authorizes only the individual save/Undo explicitly exercised below.
    const memory = await memoryProjects(page, single);
    const documents = [single, layered, neutral, other, playback];
    for (const document of documents) memory.seed(document);
    await page.route(/\/api\/projects(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const known = path === '/api/projects' || documents.some((document) => path === `/api/projects/${document.id}`);
      if (known && request.method() === 'GET') {
        await route.fallback();
        return;
      }
      if (path === `/api/projects/${single.id}` && request.method() === 'PUT' && guard.permittedSaves > 0) {
        guard.permittedSaves--;
        guard.writes++;
        await route.fallback();
        return;
      }
      guard.blocked.push(`${request.method()} ${path}`);
      await route.abort('blockedbyclient');
    });
    await expandedInspectorPreferences(page);
    await page.addInitScript(() => {
      Reflect.set(globalThis, '__name', (fn: unknown) => fn);
      window.gradeComparisonPixels = {};
    });
    await use({ memory, single, layered, neutral, other, playback, guard });
    expect(guard.blocked, 'No import, preparation, source, export, reference or unexpected write is allowed.').toEqual(
      [],
    );
    expect(guard.proxyReads).toBeGreaterThan(0);
    expect(memory.saves).toBe(guard.writes);
  },
});

function compareButton(page: Page): Locator {
  return page.locator('.preview-heading').getByRole('button', { name: 'Show ungraded preview', exact: true });
}

async function expectMode(page: Page, ungraded: boolean): Promise<void> {
  const button = compareButton(page);
  await expect(button).toHaveAttribute('aria-pressed', String(ungraded));
  await expect(button).toHaveText(ungraded ? 'Ungraded' : 'Compare');
  expect(await button.evaluate((element) => element.tagName)).toBe('BUTTON');
  const badge = page.locator('.canvas-stage').getByText('Ungraded · colour bypassed', { exact: true });
  if (ungraded) await expect(badge).toBeVisible();
  else await expect(badge).toBeHidden();
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().ungraded)).toBe(ungraded);
}

async function openFixture(page: Page, document: ProjectDocument): Promise<void> {
  await page.goto(`/?project=${document.id}`);
  await page.waitForFunction(
    (id) => window.pascapLab?.project()?.id === id && window.pascapLab.engine.diagnostics().status === 'paused',
    document.id,
  );
  await expect(compareButton(page)).toBeEnabled();
  await expectMode(page, false);
}

async function openFromPicker(page: Page, document: ProjectDocument): Promise<void> {
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: `Open ${document.title}`, exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toHaveCount(0);
  await page.waitForFunction(
    (id) => window.pascapLab?.project()?.id === id && window.pascapLab.engine.diagnostics().status === 'paused',
    document.id,
  );
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue(document.title);
}

async function seek(page: Page, document: ProjectDocument, frame: number): Promise<PreviewDiagnostics> {
  const state = await page.evaluate(async (frame) => {
    const engine = window.pascapLab!.engine;
    await engine.seek(frame);
    return engine.diagnostics();
  }, frame);
  expect(state.status, state.message).toBe('paused');
  expect(state.frame).toBe(frame);
  expect(state.requestedFrame).toBe(frame);
  for (const sample of sampleTimeline(document, frame)) {
    const slot = state.assignedClipIds.indexOf(sample.clipId);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(state.decoderReady[slot]).toBe(true);
    expect(state.decodedSourceFrames[slot]).toBe(sample.sourceFrame);
  }
  return state;
}

/** Read-only with respect to the project/history/save: never update a document
 * to obtain pixels. Temporary reference bypass restores the prior editor mode. */
async function capture(page: Page, name: string, ungraded?: boolean): Promise<PixelSummary> {
  return page.evaluate(
    ({ name, ungraded }) => {
      const engine = window.pascapLab!.engine;
      const previous = engine.diagnostics().ungraded;
      try {
        if (ungraded !== undefined) engine.setUngraded(ungraded);
        const pixels = new Uint8Array(engine.capturePixels());
        window.gradeComparisonPixels[name] = pixels;
        let checksum = 2_166_136_261;
        let rgbSum = 0;
        let nonblackPixels = 0;
        let opaque = true;
        for (let index = 0; index < pixels.length; index++) {
          checksum = Math.imul(checksum ^ pixels[index]!, 16_777_619) >>> 0;
          if (index % 4 === 3) opaque &&= pixels[index] === 255;
          else rgbSum += pixels[index]!;
          if (index % 4 === 0 && pixels[index]! + pixels[index + 1]! + pixels[index + 2]! > 0) nonblackPixels++;
        }
        return { checksum, bytes: pixels.length, rgbSum, nonblackPixels, opaque };
      } finally {
        if (ungraded !== undefined) engine.setUngraded(previous);
      }
    },
    { name, ungraded },
  );
}

async function pixelDifference(page: Page, left: string, right: string) {
  return page.evaluate(
    ({ left, right }) => {
      const before = window.gradeComparisonPixels[left]!;
      const after = window.gradeComparisonPixels[right]!;
      if (!before || !after || before.length !== after.length)
        throw new Error('Missing or incompatible real captures.');
      let maximum = 0;
      let changed = 0;
      let alphaChanges = 0;
      for (let index = 0; index < before.length; index++) {
        const difference = Math.abs(before[index]! - after[index]!);
        maximum = Math.max(maximum, difference);
        if (difference) {
          changed++;
          if (index % 4 === 3) alphaChanges++;
        }
      }
      return { maximum, changed, alphaChanges };
    },
    { left, right },
  );
}

async function renderingBarrier(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function watchNativeSeeks(page: Page): Promise<void> {
  await renderingBarrier(page);
  await page.evaluate(() => {
    const events = { seeking: 0, seeked: 0, loadstart: 0 };
    window.gradeComparisonNativeEvents = events;
    for (const video of document.querySelectorAll('video[data-pascap-decoder]')) {
      video.addEventListener('seeking', () => events.seeking++);
      video.addEventListener('seeked', () => events.seeked++);
      video.addEventListener('loadstart', () => events.loadstart++);
    }
  });
}

async function pausedIdentity(page: Page) {
  return page.evaluate(() => {
    const state = window.pascapLab!.engine.diagnostics();
    return {
      status: state.status,
      playing: state.playing,
      frame: state.frame,
      requestedFrame: state.requestedFrame,
      decodedSourceFrames: state.decodedSourceFrames,
      decoderReady: state.decoderReady,
      assignedClipIds: state.assignedClipIds,
      decoderCount: state.decoderCount,
      observedDecodedFrames: state.observedDecodedFrames,
      seekSamples: state.seekSamples,
      native: { ...window.gradeComparisonNativeEvents },
    };
  });
}

async function expectPristine(page: Page, fixture: ComparisonFixture, document: ProjectDocument): Promise<void> {
  await page.evaluate(() => window.pascapLab!.flush());
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(document);
  expect(fixture.memory.snapshot(document.id)).toEqual(document);
  expect(fixture.memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
}

test('native click, Space and Enter compare the exact paused frame without seeking, saving or adding history', async ({
  page,
  comparison,
}) => {
  await openFixture(page, comparison.single);
  await seek(page, comparison.single, 30);
  await watchNativeSeeks(page);
  const original = await pausedIdentity(page);
  const graded = await capture(page, 'graded');
  expect(graded.bytes).toBe(1280 * 720 * 4);
  expect(graded.nonblackPixels).toBeGreaterThan(10_000);
  expect(graded.opaque).toBe(true);
  const reference = await capture(page, 'read-only-bypass', true);
  await expectMode(page, false);
  expect(await pausedIdentity(page)).toEqual(original);

  const button = compareButton(page);
  await button.click();
  await expectMode(page, true);
  await expect(button).toBeFocused();
  const ungraded = await capture(page, 'ungraded');
  expect(ungraded).toEqual(reference);
  expect((await pixelDifference(page, 'read-only-bypass', 'ungraded')).maximum).toBe(0);
  expect(ungraded.checksum).not.toBe(graded.checksum);
  expect((await pixelDifference(page, 'graded', 'ungraded')).changed).toBeGreaterThan(1000);
  await renderingBarrier(page);
  expect(await pausedIdentity(page)).toEqual(original);
  await expectPristine(page, comparison, comparison.single);

  await button.press('Space');
  await expectMode(page, false);
  expect(await capture(page, 'space-restored')).toEqual(graded);
  expect(await pixelDifference(page, 'graded', 'space-restored')).toEqual({ maximum: 0, changed: 0, alphaChanges: 0 });
  await button.press('Enter');
  await expectMode(page, true);
  expect(await capture(page, 'enter-bypass')).toEqual(ungraded);
  await expect(button).toBeFocused();
  await button.click();
  await expectMode(page, false);
  await capture(page, 'click-restored');
  expect((await pixelDifference(page, 'graded', 'click-restored')).maximum).toBe(0);

  // Comparison has no global C/U binding; native Space on its button must not
  // leak into the editor's global playback shortcut either.
  await page.getByRole('region', { name: 'Video timeline', exact: true }).focus();
  await page.keyboard.press('c');
  await page.keyboard.press('u');
  await expectMode(page, false);
  await renderingBarrier(page);
  expect(await pausedIdentity(page)).toEqual(original);
  await expectPristine(page, comparison, comparison.single);
});

test('bypasses row colour across dissolves, retaining coverage, black fades and speed', async ({
  page,
  comparison,
}) => {
  // Sixteen full software-rendered readbacks; hosted runner speed is not a correctness bound.
  test.setTimeout(60_000);
  const { layered, neutral } = comparison;
  expect(nonColourContract(neutral)).toEqual(nonColourContract(layered));
  expect(neutral.clips).toEqual(layered.clips);
  expect(neutral.layers.every((layer) => JSON.stringify(layer.colour) === JSON.stringify(NEUTRAL_COLOUR))).toBe(true);
  expect(
    neutral.layers.every((layer) =>
      layer.keyframes.every((point) => COLOUR_CONTROLS.every(({ key }) => point.values[key] === null)),
    ),
  ).toBe(true);
  expect(neutral.layers.map((layer) => layer.keyframes.map((point) => point.frame))).toEqual([
    [0, 143],
    [0, 143],
    [0, 143],
  ]);
  expect(neutral.layers.map((layer) => layer.keyframes[0]!.values.speed)).toEqual([0.8, 1, 1.25]);
  const layout = calculateLayout(layered);
  const referenceLayout = calculateLayout(neutral);
  expect(layout.duration).toBe(144);
  expect(referenceLayout.duration).toBe(layout.duration);
  expect(referenceLayout.transitions).toEqual(layout.transitions);
  expect(layout.transitions.map((region) => region.transition.type)).toEqual([
    'cross-dissolve',
    'fade-through-black',
    'cross-dissolve',
  ]);
  for (const [index, placed] of layout.clips.entries()) {
    const reference = referenceLayout.clips[index]!;
    expect({ start: reference.start, end: reference.end, duration: reference.duration }).toEqual({
      start: placed.start,
      end: placed.end,
      duration: placed.duration,
    });
    for (let frame = 0; frame < placed.duration; frame++)
      expect(reference.retiming.sourceAt(frame)).toBe(placed.retiming.sourceAt(frame));
  }
  const frames = [4, 70, 72, 138];
  expect(sampleTimeline(layered, 70)).toHaveLength(5);
  expect(sampleTimeline(layered, 70).filter((sample) => sample.blendWeight > 0 && sample.blendWeight < 1)).toHaveLength(
    4,
  );
  // Both dissolve pairs also retain distinct static bases alongside their row keys.
  expect(
    sampleTimeline(layered, 70)
      .filter((sample) => sample.layerId === 'comparison-bottom')
      .map((sample) => sample.colour.hue),
  ).toEqual([15, 15]);
  expect(
    sampleTimeline(layered, 70)
      .filter((sample) => sample.layerId === 'comparison-top')
      .map((sample) => sample.colour.exposure),
  ).toEqual([0.15, 0.15]);
  expect(sampleTimeline(layered, 72).find((sample) => sample.layerId === 'comparison-black')!.brightness).toBe(0);
  const evidence: {
    frame: number;
    graded: PixelSummary;
    bypass: PixelSummary;
    reference?: PixelSummary;
    maximum?: number;
  }[] = [];
  await openFixture(page, layered);
  for (const frame of frames) {
    const samples = sampleTimeline(layered, frame);
    expect(samples.map(({ colour: _colour, ...sample }) => sample)).toEqual(
      sampleTimeline(neutral, frame).map(({ colour: _colour, ...sample }) => sample),
    );
    expect(samples.some((sample) => sample.brightness < 1)).toBe(true);
    await seek(page, layered, frame);
    const graded = await capture(page, `graded-${frame}`);
    await compareButton(page).click();
    await expectMode(page, true);
    const bypass = await capture(page, `bypass-${frame}`);
    expect(bypass.rgbSum).toBeGreaterThan(0);
    expect(bypass.opaque).toBe(true);
    expect(bypass.checksum).not.toBe(graded.checksum);
    expect((await pixelDifference(page, `graded-${frame}`, `bypass-${frame}`)).changed).toBeGreaterThan(1000);
    await compareButton(page).click();
    await expectMode(page, false);
    await capture(page, `restored-${frame}`);
    expect((await pixelDifference(page, `graded-${frame}`, `restored-${frame}`)).maximum).toBe(0);
    evidence.push({ frame, graded, bypass });
  }
  await expectPristine(page, comparison, layered);
  // Real picker/load/seek yields a separately uploaded neutral reference;
  // Uint8Arrays stay in this page, avoiding serialization or screenshot loss.
  await openFromPicker(page, neutral);
  await expectMode(page, false);
  for (const item of evidence) {
    await seek(page, neutral, item.frame);
    item.reference = await capture(page, `reference-${item.frame}`, false);
    const difference = await pixelDifference(page, `bypass-${item.frame}`, `reference-${item.frame}`);
    item.maximum = difference.maximum;
    expect(difference.alphaChanges).toBe(0);
    // Existing one-byte tolerance for independently uploaded video textures;
    // return-to-grade captures above require exact equality on the same texture.
    expect(difference.maximum).toBeLessThanOrEqual(1);
  }
  await expectPristine(page, comparison, neutral);
  expect(comparison.memory.snapshot(layered.id)).toEqual(layered);
  await test.info().attach('grade-comparison-pixels', {
    body: JSON.stringify(
      { duration: layout.duration, layers: layered.layers.length, clips: layered.clips.length, frames: evidence },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('a colour edit while bypassed saves once, returns the new grade and has a separate Undo', async ({
  page,
  comparison,
}) => {
  await openFixture(page, comparison.single);
  await seek(page, comparison.single, 30);
  const graded = await capture(page, 'before-edit');
  await compareButton(page).click();
  await expectMode(page, true);
  const bypass = await capture(page, 'bypass-before-edit');
  await watchNativeSeeks(page);
  const identity = await pausedIdentity(page);
  comparison.guard.permittedSaves = 1;
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('1.2');
  await page.evaluate(() => window.pascapLab!.flush());
  await expect(page.getByRole('status', { name: 'Saved on this device', exact: true })).toContainText('Saved locally');
  expect(comparison.memory.saves).toBe(1);
  const saved = comparison.memory.snapshot(comparison.single.id);
  expect(saved).toEqual({
    ...comparison.single,
    revision: comparison.single.revision + 1,
    layers: comparison.single.layers.map((layer) => ({ ...layer, colour: { ...layer.colour, exposure: 1.2 } })),
  });
  await expectMode(page, true);
  expect(await capture(page, 'bypass-after-edit')).toEqual(bypass);
  expect((await pixelDifference(page, 'bypass-before-edit', 'bypass-after-edit')).maximum).toBe(0);
  await renderingBarrier(page);
  expect(await pausedIdentity(page)).toEqual(identity);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();

  await compareButton(page).click();
  await expectMode(page, false);
  const newGrade = await capture(page, 'after-edit');
  expect(newGrade.checksum).not.toBe(graded.checksum);
  expect((await pixelDifference(page, 'before-edit', 'after-edit')).changed).toBeGreaterThan(1000);
  await compareButton(page).click();
  await expectMode(page, true);
  comparison.guard.permittedSaves = 1;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.evaluate(() => window.pascapLab!.flush());
  expect(comparison.memory.saves).toBe(2);
  expect(comparison.memory.snapshot(comparison.single.id)).toEqual({
    ...comparison.single,
    revision: saved.revision + 1,
  });
  await expectMode(page, true);
  expect(await capture(page, 'bypass-after-undo')).toEqual(bypass);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await compareButton(page).click();
  await expectMode(page, false);
  await capture(page, 'grade-after-undo');
  expect((await pixelDifference(page, 'before-edit', 'grade-after-undo')).maximum).toBe(0);
  expect(comparison.memory.saves).toBe(2);
});

test('comparison survives seek and timing reload, but clears on project switches and browser reload', async ({
  page,
  comparison,
}) => {
  await openFixture(page, comparison.single);
  await compareButton(page).click();
  await expectMode(page, true);
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(1);
  await expectMode(page, true);
  await seek(page, comparison.single, 30);
  await expectMode(page, true);
  comparison.guard.permittedSaves = 1;
  const out = page.getByRole('spinbutton', { name: 'Source OUT frame', exact: true });
  await out.fill('96');
  await out.press('Enter');
  await page.waitForFunction(() => {
    const state = window.pascapLab!.engine.diagnostics();
    return state.status === 'paused' && state.duration === 88;
  });
  await page.evaluate(() => window.pascapLab!.flush());
  expect(comparison.memory.saves).toBe(1);
  const trimmed = comparison.memory.snapshot(comparison.single.id);
  expect(trimmed.clips[0]!.sourceOut).toBe(96);
  const state = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
  // Source OUT edits deliberately preview the retained final frame. Comparison
  // persists through that normal editor timing reload, not a fictitious seek.
  expect(state.frame).toBe(calculateLayout(trimmed).clips[0]!.end - 1);
  expect(state.ungraded).toBe(true);
  const sample = sampleTimeline(trimmed, state.frame)[0]!;
  const slot = state.assignedClipIds.indexOf(sample.clipId);
  expect(state.decoderReady[slot]).toBe(true);
  expect(state.decodedSourceFrames[slot]).toBe(sample.sourceFrame);
  await expectMode(page, true);
  expect(await capture(page, 'after-timing-reload')).toMatchObject({ opaque: true });
  await seek(page, trimmed, 30);
  await expectMode(page, true);

  await openFromPicker(page, comparison.other);
  await expectMode(page, false);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await openFromPicker(page, trimmed);
  await expectMode(page, false);
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(trimmed);
  await compareButton(page).click();
  await expectMode(page, true);
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expectMode(page, false);
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(trimmed);
  expect(comparison.memory.saves).toBe(1);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
});

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`comparison fits ${width}×${height} / 270px inspector with a visible native 28px target`, async ({
    page,
    comparison,
  }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() =>
      localStorage.setItem(
        'pascap-workspace-layout',
        JSON.stringify({
          mediaWidth: 300,
          inspectorWidth: 270,
          timelineHeight: 290,
          mediaOpen: false,
          inspectorOpen: true,
        }),
      ),
    );
    await openFixture(page, comparison.single);
    const inspector = page.getByRole('complementary', { name: 'Clip inspector', exact: true });
    await expect(inspector).toBeVisible();
    const divider = page.getByRole('slider', { name: 'Resize Clip panel', exact: true });
    await expect(divider).toHaveAttribute('aria-valuenow', '270');
    const button = compareButton(page);
    await expect(button).toBeInViewport({ ratio: 1 });
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(
      await button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && element.contains(hit);
      }),
    ).toBe(true);
    await button.click();
    await expectMode(page, true);
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.canvas-stage').getByText('Ungraded · colour bypassed', { exact: true })).toBeInViewport(
      {
        ratio: 1,
      },
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const heading = document.querySelector('.preview-heading')!;
          const inspector = document.querySelector('[aria-label="Clip inspector"]')!;
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            heading.scrollWidth <= heading.clientWidth &&
            inspector.scrollWidth <= inspector.clientWidth
          );
        }),
      )
      .toBe(true);
    await button.press('Space');
    await expectMode(page, false);
    await expectPristine(page, comparison, comparison.single);
  });
}

test('comparison during music playback preserves the real worklet epoch and strict source readiness', async ({
  page,
  comparison,
}) => {
  // About 18-19 s locally and under CI-like constraints; keep 3x for uncontrolled hosted runners.
  test.setTimeout(60_000);
  comparison.guard.allowPCM = true;
  await installMusicEvidence(page);
  await observeRealtimeHeadroom(page, test.info());
  await openFixture(page, comparison.playback);
  await observeMusicPlayback(page);
  const duration = calculateLayout(comparison.playback).duration;
  const sourceFrames = Array.from(
    { length: duration },
    (_, frame) => sampleTimeline(comparison.playback, frame)[0]!.sourceFrame,
  );
  await page.evaluate((sourceFrames) => {
    const engine = window.pascapLab!.engine;
    // Observe actual texture uploads, so a later decoded callback cannot be
    // mistaken for the source image of a legitimately retained Playing frame.
    // Pass all native GL calls through unchanged; never synthesize readiness.
    engine.capturePixels();
    const initial = engine.diagnostics();
    const uploaded = new Map<number, { frame: number; ready: boolean }>();
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'));
    for (const [slot, frame] of initial.decodedSourceFrames.entries())
      uploaded.set(slot, { frame, ready: initial.decoderReady[slot] === true });
    const gl = engine.canvas.getContext('webgl2')!;
    const texImage2D = gl.texImage2D;
    Reflect.set(gl, 'texImage2D', function (this: WebGL2RenderingContext, ...args: unknown[]) {
      const result = Reflect.apply(texImage2D, this, args);
      const video = args.at(-1);
      if (video instanceof HTMLVideoElement && video.dataset['pascapDecoder'] !== undefined) {
        // Native decoder identities are monotonic, not pool array positions
        // after the startup empty-project resize. DOM creation order matches
        // this unchanged two-slot fixture's pool, without guessing a source.
        const slot = videos.indexOf(video);
        const state = engine.diagnostics();
        uploaded.set(slot, {
          frame: state.decodedSourceFrames[slot]!,
          ready:
            state.decoderReady[slot] === true &&
            !video.seeking &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
        });
      }
      return result;
    });
    const evidence: PlaybackObservations = {
      notifications: 0,
      gradedDraws: 0,
      ungradedDraws: 0,
      activations: [],
      maximumAVDrift: 0,
      violations: [],
      samples: [],
    };
    window.gradeComparisonPlayback = evidence;
    const button = document.querySelector<HTMLButtonElement>('.preview-comparison-toggle')!;
    button.addEventListener(
      'click',
      (event) => {
        const state = engine.diagnostics();
        evidence.activations.push({
          frame: state.frame,
          timestamp: event.timeStamp,
          detail: event.detail,
          playing: state.playing,
          status: state.status,
          trusted: event.isTrusted,
          ungraded: !state.ungraded,
        });
      },
      { capture: true },
    );
    let rendered = window.pascapLab!.engine.diagnostics().renderedFrames;
    window.pascapLab!.engine.subscribe((state) => {
      if (state.status === 'error' && evidence.violations.length < 10) evidence.violations.push(state.message);
      if (state.status === 'playing' && state.playing) {
        evidence.notifications++;
        const music = window.musicStreamEvidence;
        const receipt = music.receipt;
        const output = music.context?.getOutputTimestamp();
        // Independent consumed-sample/output-device clock, never currentTime,
        // guessed video identities or the engine's own musicDriftFrames alone.
        const samples = receipt && output ? receipt.samples + output.contextTime! * 48_000 - receipt.contextFrame : NaN;
        const audioFrame = Math.floor((receipt?.startFrame ?? NaN) + samples / ((48_000 * 1001) / 30_000) + 1e-7);
        const drift = Math.abs(audioFrame - state.frame);
        evidence.maximumAVDrift = Math.max(evidence.maximumAVDrift, drift);
        if (
          (!Number.isFinite(drift) || drift > 1 || !state.audioClock || Math.abs(state.musicDriftFrames) > 1) &&
          evidence.violations.length < 10
        )
          evidence.violations.push(`Invalid Playing A/V bound at ${state.frame}: ${drift}`);
        const slot = state.assignedClipIds.indexOf('music-comparison-clip');
        const image = uploaded.get(slot);
        // Use the authoritative map, including held slow-motion images, not a
        // currentTime guess or the earliest inverse of a repeated source frame.
        if (
          (slot < 0 || !image?.ready || image.frame !== sourceFrames[state.frame] || state.decoderCount !== 2) &&
          evidence.violations.length < 10
        )
          evidence.violations.push(`Invalid accepted source at ${state.frame}: ${image?.frame}`);
        if (state.renderedFrames > rendered) {
          if (state.ungraded) evidence.ungradedDraws++;
          else evidence.gradedDraws++;
          const activation = evidence.activations.at(-1);
          if (
            activation &&
            !activation.checkpoint &&
            state.ungraded === activation.ungraded &&
            state.frame >= activation.frame + 2
          ) {
            // Retain the actual Playing draw in this task. CI protocol/DOM
            // checks can take several seconds while real output audio advances;
            // a later diagnostics read may correctly observe completion instead.
            activation.checkpoint = {
              state,
              starts: music.starts,
              pauses: music.pauses,
              active: music.active,
              generation: receipt?.generation,
            };
          }
          if (evidence.samples.length < 24)
            evidence.samples.push({
              frame: state.frame,
              requestedFrame: state.requestedFrame,
              sourceFrame: image?.frame ?? -1,
              ungraded: state.ungraded,
              generation: receipt?.generation ?? -1,
            });
        }
      }
      rendered = state.renderedFrames;
    });
  }, sourceFrames);
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await page.waitForFunction(() => {
    const state = window.pascapLab!.engine.diagnostics();
    return (
      state.status === 'error' || (state.status === 'playing' && state.frame >= 4 && window.musicStreamEvidence.active)
    );
  });
  const initial = await page.evaluate(() => ({
    state: window.pascapLab!.engine.diagnostics(),
    starts: window.musicStreamEvidence.starts,
    pauses: window.musicStreamEvidence.pauses,
    generation: window.musicStreamEvidence.receipt?.generation,
  }));
  expect(initial.state.playing).toBe(true);
  expect(['playing', 'buffering']).toContain(initial.state.status);
  expect(initial.starts).toBe(1);
  expect(initial.generation).toBeDefined();
  try {
    const activations = [
      ['click', true],
      ['Space', false],
      ['Enter', true],
      ['click', false],
    ] as const;
    for (const [activation, ungraded] of activations) {
      if (activation === 'click') await compareButton(page).click();
      else await compareButton(page).press(activation);
      const ready = await page.waitForFunction(
        ({ ungraded, duration }) => {
          const state = window.pascapLab!.engine.diagnostics();
          const activation = window.gradeComparisonPlayback.activations.at(-1);
          const button = document.querySelector<HTMLButtonElement>('.preview-comparison-toggle')!;
          const badge = document.querySelector('.preview-comparison-overlay');
          const modeReady =
            button.getAttribute('aria-pressed') === String(ungraded) &&
            button.textContent === (ungraded ? 'Ungraded' : 'Compare') &&
            button.tagName === 'BUTTON' &&
            Boolean(badge) === ungraded &&
            state.ungraded === ungraded;
          if (activation?.checkpoint && modeReady) return activation;
          // Completion is only an explicit failure escape, never a substitute
          // for a trusted activation followed by a real Playing draw.
          return state.status === 'error' || (!state.playing && state.frame === duration - 1)
            ? { ...activation, checkpoint: null }
            : null;
        },
        { ungraded, duration },
      );
      const observed = (await ready.jsonValue())!;
      await ready.dispose();
      expect(observed.trusted).toBe(true);
      expect(observed.playing).toBe(true);
      // Native input and the preceding Playing observation are different tasks.
      // Decoder buffering may begin between them; the retained post-activation
      // Playing draw below must still satisfy every source/audio/epoch bound.
      expect(['playing', 'buffering']).toContain(observed.status);
      expect(observed.ungraded).toBe(ungraded);
      expect(observed.detail).toBe(activation === 'click' ? 1 : 0);
      expect(observed.frame).toBeLessThan(duration - 1);
      expect(observed.checkpoint, 'Each native activation must produce a Playing draw before completion.').toBeTruthy();
      const checkpoint = observed.checkpoint!;
      expect(checkpoint.state.status, checkpoint.state.message).toBe('playing');
      expect(checkpoint.state.playing).toBe(true);
      expect(checkpoint.state.frame).toBeGreaterThanOrEqual(observed.frame! + 2);
      expect(checkpoint.state.frame).toBeLessThan(duration - 1);
      expect(checkpoint.state.ungraded).toBe(ungraded);
      expect(checkpoint.starts).toBe(initial.starts);
      expect(checkpoint.pauses).toBe(initial.pauses);
      expect(checkpoint.active).toBe(true);
      expect(checkpoint.generation).toBe(initial.generation);
    }
    // Buffering itself is permitted: software-renderer stall counts are not a
    // correctness gate. Actual accepted source frames and the audio epoch are.
    await page.waitForFunction(
      (duration) => {
        const state = window.pascapLab!.engine.diagnostics();
        return (
          state.status === 'error' || (!state.playing && state.status === 'paused' && state.frame === duration - 1)
        );
      },
      duration,
      { timeout: 35_000 },
    );
    const result = await page.evaluate(() => ({
      state: window.pascapLab!.engine.diagnostics(),
      observations: window.gradeComparisonPlayback,
      starts: window.musicStreamEvidence.starts,
      underruns: window.musicStreamEvidence.underruns,
      largestRange: window.musicStreamEvidence.largestRange,
    }));
    expect(result.state.status, result.state.message).toBe('paused');
    expect(result.state.frame).toBe(duration - 1);
    expect(result.state.decoderReady[result.state.assignedClipIds.indexOf('music-comparison-clip')]).toBe(true);
    expect(result.state.decodedSourceFrames[result.state.assignedClipIds.indexOf('music-comparison-clip')]).toBe(
      sourceFrames[duration - 1],
    );
    expect(result.observations.violations).toEqual([]);
    expect(result.observations.activations).toHaveLength(4);
    expect(result.observations.notifications).toBeGreaterThan(2);
    expect(result.observations.gradedDraws).toBeGreaterThan(0);
    expect(result.observations.ungradedDraws).toBeGreaterThan(0);
    expect(result.observations.maximumAVDrift).toBeLessThanOrEqual(1);
    expect(result.starts).toBe(1);
    expect(result.underruns).toBe(0);
    expect(result.largestRange).toBeLessThanOrEqual(65_536);
    expect(comparison.guard.pcmReads).toBeGreaterThan(0);
    await expectMode(page, false);
    await expectPristine(page, comparison, comparison.playback);
  } finally {
    await test.info().attach('grade-comparison-music', {
      body: JSON.stringify(
        await page.evaluate(() => ({
          state: window.pascapLab!.engine.diagnostics(),
          observations: window.gradeComparisonPlayback,
          starts: window.musicStreamEvidence.starts,
          pauses: window.musicStreamEvidence.pauses,
          underruns: window.musicStreamEvidence.underruns,
          receipt: window.musicStreamEvidence.receipt,
          receipts: window.musicStreamEvidence.samples,
          playback: window.musicStreamEvidence.playback,
          queueEvents: window.musicStreamEvidence.queueEvents,
          rangeTimings: window.musicStreamEvidence.rangeTimings,
          largestRange: window.musicStreamEvidence.largestRange,
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
});
