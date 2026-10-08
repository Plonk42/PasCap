import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { MediaAsset } from '../../src/shared/media.js';
import {
  createClip,
  createProject,
  projectSchema,
  type MusicTrack,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { inspectorTab } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';
import { installMusicEvidence, observeMusicPlayback, observeRealtimeHeadroom } from './music-evidence.js';

// Exercise actual native gutters/thumbs, not Chrome's default hidden headless scrollbar.
test.use({
  launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--autoplay-policy=no-user-gesture-required'] },
});

let video: MediaAsset;
let song: AudioAsset;
let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const videos = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const audio = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets;
  const preparedVideo = videos.find((asset) => asset.name === 'pattern-a.mp4' && asset.status === 'ready');
  const preparedSong = audio.find((asset) => asset.name === 'test-music.wav' && asset.status === 'ready');
  if (
    !preparedVideo ||
    preparedVideo.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/pattern-a.mp4') ||
    !preparedSong ||
    preparedSong.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/test-music.wav')
  )
    throw new Error(
      'Multi-music checks require existing prepared synthetic fixtures; no imports or preparation of real media.',
    );
  video = preparedVideo;
  song = preparedSong;
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets: [video] },
    '/api/audio': { assets: [song] },
    '/api/jobs': { jobs: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    if (
      (method === 'GET' && pathname.startsWith(`/api/media/${video.id}/`)) ||
      ((method === 'GET' || method === 'HEAD') && pathname === `/api/audio/${song.id}/playback`)
    ) {
      await route.continue();
      return;
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('multiple-music-memory', 'Multiple music · memory-only');
  document.media.videoIds = [video.id];
  document.clips = [createClip('music-video', video.id, 0, 120)];
  memory = await memoryProjects(page, document);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.goto(`/?project=${document.id}`);
  await ready(page, document);
});

test.afterEach(() =>
  expect(unexpected, 'No real-store writes, native exports, preparation or unapproved media reads').toEqual([]),
);

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function ready(page: Page, document: ProjectDocument): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab?.engine.diagnostics();
        return { status: state?.status, duration: state?.duration };
      }),
    )
    .toEqual({ status: 'paused', duration: calculateLayout(document).duration });
}

function track(id: string, settings: Partial<Omit<MusicTrack, 'id'>> = {}): MusicTrack {
  return {
    id,
    mediaId: song.id,
    sourceIn: 0,
    sourceOut: 120,
    start: 0,
    duration: 120,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    ...settings,
  };
}

async function seed(page: Page, tracks: MusicTrack[]): Promise<ProjectDocument> {
  const document = await current(page);
  document.media.audioIds = [song.id];
  document.music = tracks;
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  return document;
}

async function flush(page: Page): Promise<void> {
  await page.evaluate(() => window.pascapLab!.flush());
  const document = await current(page);
  expect({ ...memory.snapshot(), revision: document.revision }).toEqual(document);
}

async function select(page: Page, id: string): Promise<Locator> {
  await inspectorTab(page, 'Audio');
  await page.getByRole('combobox', { name: 'Music track', exact: true }).selectOption(id);
  const controls = page.locator(`[data-music-controls-id="${id}"]`);
  await expect(controls).toBeVisible();
  return controls;
}

async function number(controls: Locator, name: string, value: string): Promise<void> {
  const field = controls.getByRole('spinbutton', { name, exact: true });
  await field.fill(value);
  await field.press('Enter');
}

test('import is bin-only; add, duplicate recording, select, edit and trash retain independent identities, saves and history', async ({
  page,
}) => {
  const initial = await current(page);
  let imports = 0;
  await page.route('**/api/audio/register', async (route) => {
    imports++;
    expect(route.request().postDataJSON()).toEqual({ path: '/disposable/synthetic-music.wav' });
    await route.fulfill({
      status: 202,
      json: {
        asset: song,
        job: {
          id: 'memory-music-import',
          kind: 'audio',
          label: song.name,
          state: 'completed',
          progress: 1,
          message: 'Existing prepared synthetic audio reused',
          createdAt: '2026-10-07T10:00:00Z',
          finishedAt: '2026-10-07T10:00:00Z',
          outputUrl: null,
          receiptUrl: null,
        },
      },
    });
  });
  await inspectorTab(page, 'Audio');
  const add = page.getByRole('button', { name: 'Add music track', exact: true });
  await expect(add).toBeDisabled();
  await page.getByRole('textbox', { name: 'Music file path', exact: true }).fill('/disposable/synthetic-music.wav');
  await page.getByRole('button', { name: 'Import audio', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Music recording', exact: true }).locator('option')).toHaveCount(2);
  await flush(page);
  expect(imports).toBe(1);
  expect(memory.saves).toBe(1);
  expect(memory.snapshot().music).toEqual([]);
  expect(memory.snapshot().clips).toEqual(initial.clips);
  await expect(page.locator('[data-music-lane]')).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Music recording', exact: true }).selectOption(song.id);
  await flush(page);
  const first = (await current(page)).music[0]!;
  expect(first.id).toBeTruthy();
  expect(first).toMatchObject({ mediaId: song.id, duration: 120, start: 0, gainDb: 0 });
  expect(memory.saves).toBe(2);
  await add.click();
  await flush(page);
  const duplicated = await current(page);
  const second = duplicated.music[1]!;
  expect(duplicated.music).toHaveLength(2);
  expect(new Set(duplicated.music.map((item) => item.id)).size).toBe(2);
  expect(duplicated.music[0]).toEqual(first);
  expect({ ...second, id: first.id }).toEqual(first);
  expect(memory.saves).toBe(3);
  await expect(page.getByRole('combobox', { name: 'Music track', exact: true })).toHaveValue(second.id);

  const saves = memory.saves;
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  const controls = await select(page, first.id);
  await flush(page);
  expect(memory.saves).toBe(saves);
  expect((await current(page)).music).toEqual(duplicated.music);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
  await number(controls, 'Music gain', '-6.125');
  const edited = await current(page);
  expect(edited.music).toEqual([{ ...first, gainDb: -6.125 }, second]);
  await flush(page);
  expect(memory.saves).toBe(saves + 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).music).toEqual(duplicated.music);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await current(page)).music).toEqual(edited.music);
  await flush(page);
  const removalSaves = memory.saves;
  await select(page, second.id);
  await page.getByRole('button', { name: 'Delete selected music track', exact: true }).click();
  expect((await current(page)).music).toEqual([edited.music[0]]);
  await flush(page);
  expect(memory.saves).toBe(removalSaves + 1);
  expect(memory.snapshot().music).toEqual([edited.music[0]]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).music).toEqual(edited.music);
  await flush(page);
  await page.reload();
  await ready(page, edited);
  expect((await current(page)).music).toEqual(edited.music);
  await expect(page.locator('[data-music-lane]')).toHaveCount(2);
  expect(imports).toBe(1);
});

test('eight independent instances are the hard limit; removing one re-enables Add without modifying the others', async ({
  page,
}) => {
  const document = await seed(
    page,
    Array.from({ length: 7 }, (_, index) => track(`limit-${index}`)),
  );
  await inspectorTab(page, 'Audio');
  await page.getByRole('button', { name: 'Add music track', exact: true }).click();
  await flush(page);
  const eight = await current(page);
  expect(eight.music).toHaveLength(8);
  expect(eight.music.slice(0, 7)).toEqual(document.music);
  expect(new Set(eight.music.map((item) => item.id)).size).toBe(8);
  const add = page.getByRole('button', { name: 'Add music track', exact: true });
  await expect(add).toBeDisabled();
  await expect(add).toHaveAccessibleDescription(/at most 8 music tracks/);
  expect(memory.saves).toBe(1);
  await select(page, 'limit-3');
  await page.getByRole('button', { name: 'Delete selected music track', exact: true }).click();
  expect((await current(page)).music).toEqual(eight.music.filter((item) => item.id !== 'limit-3'));
  await expect(add).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).music).toEqual(eight.music);
  await expect(add).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).music).toEqual(document.music);
  await expect(add).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('invalid per-instance numeric drafts survive selection without save, clamping or cross-instance edits; music OUT extends duration', async ({
  page,
}) => {
  const document = await seed(page, [track('draft-a'), track('draft-b', { gainDb: -12 })]);
  const controls = await select(page, 'draft-a');
  const gain = controls.getByRole('spinbutton', { name: 'Music gain', exact: true });
  for (const value of ['', '-61', '13']) {
    await gain.fill(value);
    await gain.press('Enter');
    await expect(gain).toHaveAttribute('aria-invalid', 'true');
    await expect(gain).toHaveValue(value);
    await expect(gain.locator('..').getByRole('alert')).toBeVisible();
    await flush(page);
    expect((await current(page)).music).toEqual(document.music);
    expect(memory.saves).toBe(0);
    await gain.press('Escape');
  }
  await gain.fill('13');
  await gain.press('Enter');
  const other = await select(page, 'draft-b');
  await expect(other.getByRole('spinbutton', { name: 'Music gain', exact: true })).toHaveValue('-12');
  await expect(controls).toBeHidden();
  await select(page, 'draft-a');
  await expect(gain).toHaveValue('13');
  await expect(gain).toHaveAttribute('aria-invalid', 'true');
  await gain.press('Escape');
  await controls.getByRole('button', { name: 'Placement & fades', exact: true }).click();
  const start = controls.getByRole('spinbutton', { name: 'Music timeline start', exact: true });
  await start.fill('2147483647');
  await start.press('Enter');
  await expect(start).toHaveAttribute('aria-invalid', 'true');
  await flush(page);
  expect(memory.saves).toBe(0);
  expect((await current(page)).music).toEqual(document.music);
  await start.press('Escape');
  await number(controls, 'Music timeline start', '150');
  const extended = await current(page);
  expect(extended.music).toEqual([{ ...document.music[0]!, start: 150 }, document.music[1]]);
  expect(calculateLayout(extended).duration).toBe(270);
  await ready(page, extended);
  await flush(page);
  expect(memory.saves).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).music).toEqual(document.music);
  await ready(page, document);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

async function beginMove(page: Page, body: Locator, frames: number): Promise<number> {
  await body.scrollIntoViewIfNeeded();
  const box = (await body.boundingBox())!;
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  await body.evaluate((element) =>
    element.addEventListener(
      'pointerdown',
      (event) => {
        element.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId));
      },
      { once: true },
    ),
  );
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + 25, box.y + box.height / 2);
  await page.mouse.down();
  const id = Number(await body.getAttribute('data-test-pointer-id'));
  await page.mouse.move(box.x + 25 + frames * scale, box.y + box.height / 2, { steps: 6 });
  return id;
}

for (const cancellation of ['Escape', 'pointercancel', 'lostcapture', 'windowblur'] as const)
  test(`music ${cancellation} cancels the addressed lane's pointer draft; release and keyboard edits are one Undo only`, async ({
    page,
  }) => {
    const document = await seed(page, [track('gesture-a'), track('gesture-b', { start: 10, gainDb: -12 })]);
    const clip = page.locator('[data-music-id="gesture-b"]');
    const body = clip.getByRole('button', { name: `Move music track 2: ${song.name}`, exact: true });
    const id = await beginMove(page, body, 20);
    await expect(clip).toHaveAttribute('data-music-start', '30');
    expect((await current(page)).music).toEqual(document.music);
    await flush(page);
    expect(memory.saves).toBe(0);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'windowblur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else if (cancellation === 'pointercancel')
      await body.dispatchEvent('pointercancel', { pointerId: id, pointerType: 'mouse', isPrimary: true });
    else await body.evaluate((element, pointerId) => element.releasePointerCapture(pointerId), id);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect(clip).toHaveAttribute('data-music-start', '10');
    expect(await current(page)).toEqual(document);
    await flush(page);
    expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

    await beginMove(page, body, 20);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect((await current(page)).music).toEqual([document.music[0], { ...document.music[1]!, start: 30 }]);
    await flush(page);
    expect(memory.saves).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await current(page)).music).toEqual(document.music);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await ready(page, document);
    const out = clip.getByRole('button', { name: `Trim music duration, track 2: ${song.name}`, exact: true });
    await out.focus();
    await out.press('ArrowLeft');
    expect((await current(page)).music).toEqual([document.music[0], { ...document.music[1]!, duration: 119 }]);
    expect((await current(page)).clips).toEqual(document.clips);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await current(page)).music).toEqual(document.music);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

for (const width of [1440, 1024, 720, 640])
  test(`${width}px eight music lanes retain native wheel/thumb/focus access and selection creates no seek, history or save`, async ({
    page,
  }) => {
    const document = await seed(
      page,
      Array.from({ length: 8 }, (_, index) => track(`lane-${index}`, { gainDb: index === 0 ? 0 : -index })),
    );
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 720 });
    const viewport = page.locator('.timeline-scroll');
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await test
      .info()
      .attach(`music-lanes-${width}-before`, { body: await page.screenshot(), contentType: 'image/png' });
    const box = (await viewport.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Gecko bounds a native wheel event to a page of travel. Exercise successive
    // wheel gestures, rather than assuming one large delta reaches the final lane.
    const extent = await viewport.evaluate((element) => element.scrollHeight);
    for (let travelled = 0; travelled < extent; travelled += box.height / 2) {
      await page.mouse.wheel(0, box.height / 2);
    }
    const last = page.locator('[data-music-lane="lane-7"]');
    const button = last.getByRole('button', { name: `Select music track 8: ${song.name}`, exact: true });
    await expect(button).toBeInViewport();
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const size = await viewport.evaluate((element) => ({
      height: element.clientHeight,
      extent: element.scrollHeight,
      gutter: (element as HTMLElement).offsetWidth - element.clientWidth,
    }));
    expect(size.gutter).toBeGreaterThan(0);
    expect(size.extent).toBeGreaterThan(size.height);
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    const bounds = (await viewport.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width - size.gutter / 2,
      bounds.y + (size.height * size.height) / size.extent / 2,
    );
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - size.gutter / 2, bounds.y + size.height - 8, { steps: 6 });
    await page.mouse.up();
    await expect(button).toBeInViewport();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(button).not.toBeFocused();
    await button.focus();
    await expect(button).toBeFocused();
    await expect(button).toBeInViewport();
    // Focus the preceding native control without revealing it; Tab must reveal the next lane itself.
    await page
      .locator('[data-music-lane="lane-6"] .trim-handle.out')
      .evaluate((element) => (element as HTMLButtonElement).focus({ preventScroll: true }));
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect(button).toBeInViewport();
    const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
    await button.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('combobox', { name: 'Music track', exact: true })).toHaveValue('lane-7');
    await expect(page.getByRole('spinbutton', { name: 'Music gain', exact: true })).toHaveValue('-7');
    await expect(page.locator('[data-music-controls-id="lane-0"]')).toBeHidden();
    await expect(page.locator('.timeline-ruler')).toBeInViewport();
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const target = (await button.boundingBox())!;
    expect(target.width).toBeGreaterThanOrEqual(24);
    expect(target.height).toBeGreaterThanOrEqual(24);
    await flush(page);
    expect((await current(page)).music).toEqual(document.music);
    expect((await current(page)).clips).toEqual(document.clips);
    expect(memory.saves).toBe(0);
    expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await test
      .info()
      .attach(`music-lanes-${width}-selected`, { body: await page.screenshot(), contentType: 'image/png' });
  });

interface TailEvidence {
  playingSamples: number;
  tailFrames: number[];
  driftViolations: number;
  decoderCounts: number[];
  errors: string[];
  stopAudioFrames: number[];
}
declare global {
  interface Window {
    multiMusicTailEvidence: TailEvidence;
  }
}

test('actual mixed PCM gain/fades/placement continues over the last clip fade into black through max music OUT without extra decoder or restart', async ({
  page,
  request,
  browser,
}) => {
  const document = await current(page);
  document.clips = [createClip('tail-video', video.id, 0, 30)];
  document.layers[0]!.closingFade = 6;
  document.media.audioIds = [song.id];
  document.music = [
    track('tail-a', { sourceOut: 15, start: 10, duration: 40, gainDb: -12, fadeIn: 5, fadeOut: 10, loop: true }),
    track('tail-b', {
      sourceIn: 5,
      sourceOut: 30,
      start: 30,
      duration: 60,
      gainDb: -6,
      fadeIn: 10,
      fadeOut: 10,
      loop: true,
    }),
  ];
  expect(calculateLayout(document).duration).toBe(90);
  expect(calculateLayout(document).clips[0]!.end).toBe(30);
  // Read only the necessary first 30 source frames from the already prepared synthetic PCM.
  // The independent observer computes expected sums sample by sample in the real worklet thread.
  const byteLength = Math.round((30 * 48_000 * 1001) / 30_000) * 4;
  const pcm: number[] = [];
  for (let begin = 0; begin < byteLength; begin += 65_536) {
    const end = Math.min(byteLength, begin + 65_536) - 1;
    const response = await request.get(`/api/audio/${song.id}/playback`, {
      headers: { Range: `bytes=${begin}-${end}` },
    });
    expect(response.status()).toBe(206);
    const bytes = await response.body();
    expect(bytes).toHaveLength(end - begin + 1);
    for (let offset = 0; offset < bytes.length; offset += 2) pcm.push(bytes.readInt16LE(offset));
  }
  await installMusicEvidence(page, true, { pcm, tracks: document.music });
  await observeRealtimeHeadroom(page, test.info());
  memory.seed(document);
  await page.reload();
  await ready(page, document);
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
  await observeMusicPlayback(page);
  // Fade is anchored to the clip OUT, not stretched to the extended project OUT.
  const images = await page.evaluate(async () => {
    const engine = window.pascapLab!.engine;
    const images: { frame: number; rgb: number; black: boolean }[] = [];
    for (const frame of [23, 24, 27, 29, 30, 60, 89]) {
      await engine.seek(frame);
      const pixels = engine.capturePixels();
      let rgb = 0;
      let black = true;
      for (let index = 0; index < pixels.length; index += 4) {
        rgb += pixels[index]! + pixels[index + 1]! + pixels[index + 2]!;
        if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0 || pixels[index + 3] !== 255)
          black = false;
      }
      images.push({ frame, rgb, black });
    }
    await engine.seek(0);
    return images;
  });
  expect(images[0]!.rgb).toBeGreaterThan(0);
  expect(images[1]!.rgb).toBeGreaterThan(images[2]!.rgb);
  expect(images[2]!.rgb).toBeGreaterThan(images[3]!.rgb);
  expect(images.slice(4).every((image) => image.black)).toBe(true);
  await page.evaluate(() => {
    const evidence: TailEvidence = {
      playingSamples: 0,
      tailFrames: [],
      driftViolations: 0,
      decoderCounts: [],
      errors: [],
      stopAudioFrames: [],
    };
    window.multiMusicTailEvidence = evidence;
    const audioFrame = (): number => {
      const stream = window.musicStreamEvidence;
      const receipt = stream.receipt;
      const output = stream.context?.getOutputTimestamp();
      if (!receipt || !output || !Number.isFinite(output.contextTime)) return NaN;
      return (
        receipt.startFrame +
        (receipt.samples + output.contextTime! * 48_000 - receipt.contextFrame) / ((48_000 * 1001) / 30_000)
      );
    };
    window.addEventListener('pascap-test-music-stop', () => {
      if (window.musicStreamEvidence.starts) evidence.stopAudioFrames.push(audioFrame());
    });
    window.pascapLab!.engine.subscribe((state) => {
      if (state.status === 'error') evidence.errors.push(state.message);
      if (state.status !== 'playing') return;
      evidence.playingSamples++;
      evidence.decoderCounts.push(state.decoderCount);
      const clock = Math.floor(audioFrame() + 1e-7);
      if (
        !Number.isFinite(clock) ||
        Math.abs(state.frame - clock) > 1 ||
        !state.audioClock ||
        Math.abs(state.musicDriftFrames) > 1
      )
        evidence.driftViolations++;
      if (
        state.frame < 32 ||
        state.frame > 85 ||
        evidence.tailFrames.length >= 6 ||
        evidence.tailFrames.includes(state.frame)
      )
        return;
      evidence.tailFrames.push(state.frame);
      if (state.activeDecoders !== 0) evidence.errors.push('Music-only tail retained an active video decoder.');
      const pixels = window.pascapLab!.engine.capturePixels();
      for (let index = 0; index < pixels.length; index += 4)
        if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0 || pixels[index + 3] !== 255) {
          evidence.errors.push('Playing music-only tail is not opaque black.');
          break;
        }
    });
  });
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  try {
    await page.waitForFunction(() => {
      const state = window.pascapLab!.engine.diagnostics();
      return state.status === 'error' || (!state.playing && state.status === 'paused' && state.frame === 89);
    });
    await page.waitForFunction(
      () =>
        window.pascapLab!.engine.diagnostics().status === 'error' ||
        window.musicStreamEvidence.renderedSignal.length === 90,
    );
    const result = await page.evaluate(() => {
      const { context: _context, ...stream } = window.musicStreamEvidence;
      const pixels = window.pascapLab!.engine.capturePixels();
      let black = true;
      for (let index = 0; index < pixels.length; index += 4)
        if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0 || pixels[index + 3] !== 255)
          black = false;
      return { state: window.pascapLab!.engine.diagnostics(), stream, tail: window.multiMusicTailEvidence, black };
    });
    expect(result.state.status, result.state.message).toBe('paused');
    expect(result.state.duration).toBe(90);
    expect(result.state.frame).toBe(89);
    expect(result.state.activeDecoders).toBe(0);
    expect(result.state.decoderCount).toBe(2);
    expect(result.black).toBe(true);
    expect(result.stream.starts).toBe(1);
    expect(result.stream.underruns).toBe(0);
    expect(result.stream.receiptSampleViolations).toBe(0);
    expect(result.stream.active).toBe(false);
    expect(result.stream.ranges).toBeGreaterThan(8);
    expect(result.stream.largestRange).toBeLessThanOrEqual(65_536);
    expect(result.tail.playingSamples).toBeGreaterThan(5);
    expect(result.tail.tailFrames.length).toBeGreaterThan(1);
    expect(result.tail.driftViolations).toBe(0);
    expect(result.tail.errors).toEqual([]);
    expect(result.tail.decoderCounts.every((count) => count === 2)).toBe(true);
    expect(result.tail.stopAudioFrames).toHaveLength(1);
    expect(result.tail.stopAudioFrames[0]).toBeGreaterThanOrEqual(90);
    expect(result.tail.stopAudioFrames[0]).toBeLessThan(91);
    await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
    const signal = result.stream.renderedSignal;
    for (const entry of signal) {
      const samplesPerFrame = (48_000 * 1001) / 30_000;
      expect(entry.samples, `All rendered samples in project frame ${entry.frame}`).toBe(
        Math.ceil((entry.frame + 1) * samplesPerFrame) - Math.ceil(entry.frame * samplesPerFrame),
      );
      expect(entry.stereoDifference).toBe(0);
      expect(entry.mismatchedSamples, `PCM sum, source wraps, gain and both fades at frame ${entry.frame}`).toBe(0);
      expect(entry.maximumSampleError).toBeLessThanOrEqual(0.0000002);
    }
    expect(signal.slice(0, 10).every((entry) => entry.peak === 0 && entry.rightPeak === 0)).toBe(true);
    // Both tracks contribute during overlap; neither normalization nor replacement is allowed.
    expect(signal[40]!.peak).toBeGreaterThan(signal[20]!.peak);
    expect(signal[75]!.peak).toBeGreaterThan(signal[85]!.peak);
    expect(signal[85]!.peak).toBeGreaterThan(signal[89]!.peak);
    await flush(page);
    expect(memory.saves).toBe(0);
    expect(await current(page)).toEqual(document);
    await test
      .info()
      .attach('multiple-music-black-completion', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    const evidence = await page.evaluate(() => {
      const { context: _context, ...stream } = window.musicStreamEvidence;
      return { state: window.pascapLab!.engine.diagnostics(), stream, tail: window.multiMusicTailEvidence };
    });
    await test.info().attach('multiple-music-real-pcm-tail', {
      body: JSON.stringify({ browser: browser.version(), ...evidence }, null, 2),
      contentType: 'application/json',
    });
  }
});
