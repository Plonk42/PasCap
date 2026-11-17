import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { MUSIC_ANALYSIS_VERSION, type MusicAnalysis } from '../../src/shared/music-analysis.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

let song: AudioAsset;
let memory: MemoryProjects;
let unexpected: string[];
let missing: string[];
let analysis: MusicAnalysis | null;

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  missing = [];
  analysis = null;
  const videos = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const audio = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets;
  const video = videos.find((asset) => asset.name === 'pattern-a.mp4' && asset.status === 'ready');
  const preparedSong = audio.find((asset) => asset.name === 'test-music.wav' && asset.status === 'ready');
  if (
    !video ||
    !preparedSong ||
    preparedSong.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/test-music.wav')
  )
    throw new Error('Music review checks require the prepared synthetic fixtures; no imports or preparation.');
  song = preparedSong;
  const reads: Record<string, () => unknown> = {
    '/api/health': () => ({
      name: 'PasCap',
      milestone: 'editing-and-export',
      frameRate: '30000/1001',
      workerConcurrency: 1,
      toolchain: null,
    }),
    '/api/media': () => ({ assets: [video], missing: [] }),
    '/api/audio': () => ({ assets: [song], missing }),
    '/api/jobs': () => ({ jobs: [] }),
    '/api/footage/roots': () => ({ roots: [] }),
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname]) {
      await route.fulfill({ json: reads[pathname]() });
      return;
    }
    if (method === 'GET' && pathname === `/api/audio/${song.id}/analysis` && analysis) {
      await route.fulfill({ json: { analysis, job: null } });
      return;
    }
    if (
      (method === 'GET' && pathname.startsWith(`/api/media/${video.id}/`)) ||
      (method === 'GET' && pathname === `/api/audio/${song.id}/analysis`) ||
      (method === 'POST' && pathname === '/api/ops/music_waveform') ||
      ((method === 'GET' || method === 'HEAD') && pathname === `/api/audio/${song.id}/playback`)
    ) {
      await route.continue();
      return;
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('music-review-memory', 'Music review · memory-only');
  document.media.videoIds = [video.id];
  document.media.audioIds = [song.id];
  document.clips = [createClip('music-review-video', video.id, 0, 120)];
  memory = await memoryProjects(page, document);
  await page.goto(`/?project=${document.id}`);
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
});

test.afterEach(() =>
  expect(unexpected, 'No real-store writes, native exports, preparation or unapproved media reads').toEqual([]),
);

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

const review = (page: Page) => page.locator('.music-review');
const status = (page: Page) => review(page).getAttribute('data-music-status');
const reviewFrame = async (page: Page) => Number(await review(page).getAttribute('data-music-frame'));
const timelinePlaying = (page: Page) => page.evaluate(() => window.pascapLab!.engine.diagnostics().playing);

async function openSong(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Listen to test-music.wav', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Source preview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Music review', exact: true })).toBeVisible();
}

test('plays a music recording from Media without placing, saving or adding history', async ({ page }) => {
  const before = await current(page);
  const saves = memory.saves;
  await openSong(page);
  await expect(page.getByRole('button', { name: 'Listen to test-music.wav', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('img', { name: 'Waveform for test-music.wav', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play music preview', exact: true }).click();
  await expect.poll(() => status(page)).toBe('playing');
  await expect.poll(() => reviewFrame(page)).toBeGreaterThan(10);
  // Space reaches the editor shortcut after a pointer press, which pauses this preview.
  await page.keyboard.press('Space');
  await expect.poll(() => status(page)).toBe('paused');
  const paused = await reviewFrame(page);
  expect(await timelinePlaying(page)).toBe(false);
  await page.getByRole('slider', { name: 'Music playhead', exact: true }).fill('150');
  await expect.poll(() => reviewFrame(page)).toBe(150);
  expect(paused).toBeGreaterThan(10);
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(saves);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  // Played to its end, it stops on the last frame without looping.
  await page.getByRole('button', { name: 'Play music preview', exact: true }).click();
  await expect.poll(() => status(page), { timeout: 10_000 }).toBe('paused');
  expect(await reviewFrame(page)).toBe(song.metadata.frameCount - 1);
});

test('music preview and timeline playback never play at once', async ({ page }) => {
  await openSong(page);
  await page.getByRole('button', { name: 'Play music preview', exact: true }).click();
  await expect.poll(() => status(page)).toBe('playing');
  // Playing the timeline shows it and pauses the music.
  await page.getByRole('tab', { name: 'Timeline preview', exact: true }).click();
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect.poll(() => timelinePlaying(page)).toBe(true);
  expect(await status(page)).toBe('paused');
  // Playing the music pauses the timeline.
  await page.getByRole('tab', { name: 'Source preview', exact: true }).click();
  expect(await timelinePlaying(page)).toBe(true);
  await page.getByRole('button', { name: 'Play music preview', exact: true }).click();
  await expect.poll(() => status(page)).toBe('playing');
  expect(await timelinePlaying(page)).toBe(false);
});

test('I and O mark a range that Add music clip places in one Undo step', async ({ page }) => {
  await openSong(page);
  const playhead = page.getByRole('slider', { name: 'Music playhead', exact: true });
  await playhead.fill('30');
  await playhead.press('i');
  await playhead.fill('90');
  await playhead.press('o');
  const strip = review(page).locator('.music-review-strip');
  await expect(strip).toHaveAttribute('data-source-in', '30');
  await expect(strip).toHaveAttribute('data-source-out', '91');
  await page.getByRole('button', { name: 'Add music clip 2.04 s to timeline', exact: true }).click();
  await expect(page.getByText('Music clip added to a new music track', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Source preview', exact: true })).toHaveAttribute('aria-selected', 'true');
  const added = await current(page);
  expect(added.music).toHaveLength(1);
  expect(added.music[0]!.clips).toEqual([
    {
      id: added.music[0]!.clips[0]!.id,
      mediaId: song.id,
      sourceIn: 30,
      sourceOut: 91,
      start: 0,
      duration: 61,
      loop: false,
    },
  ]);
  // A second add appends to the selected clip's track.
  await page.getByRole('button', { name: 'Add music clip 2.04 s to timeline', exact: true }).click();
  await expect.poll(async () => (await current(page)).music[0]!.clips.map((clip) => clip.start)).toEqual([0, 61]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await current(page)).music[0]!.clips).toHaveLength(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await current(page)).music).toEqual([]);
  expect(calculateLayout(await current(page)).duration).toBe(120);
  // Reset restores the whole recording; Escape closes Source preview.
  await page.getByRole('tab', { name: 'Source preview', exact: true }).click();
  await expect(strip).toHaveAttribute('data-source-in', '30');
  await page.getByRole('button', { name: 'Reset music range', exact: true }).click();
  await expect(strip).toHaveAttribute('data-source-out', String(song.metadata.frameCount));
  await playhead.press('Escape');
  await expect(page.getByRole('tab', { name: 'Source preview', exact: true })).toBeDisabled();
  await expect(page.getByRole('tab', { name: 'Timeline preview', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('a zoomed view follows the play position, and Previous/Next visit sections, downbeats and strong hits', async ({
  page,
}) => {
  const at = (frame: number): number => Math.round(frame * MUSIC_SAMPLES_PER_FRAME);
  analysis = {
    version: MUSIC_ANALYSIS_VERSION,
    source: { content: 'a'.repeat(64), bytes: 4, mtimeMs: 0 },
    sampleRate: 48_000,
    hop: 480,
    samples: Math.round(song.metadata.durationSeconds * 48_000),
    tempo: { bpm: 120, confidence: 0.9, curve: [{ fromSample: 0, bpm: 120 }] },
    meter: { beatsPerBar: 4, confidence: 0.8 },
    // Beats every 15 frames from 5, a downbeat every fourth: downbeats at 5, 65 and 125.
    beats: Array.from({ length: 12 }, (_, index) => ({
      sample: at(5 + 15 * index),
      strength: 0.8,
      downbeat: index % 4 === 0,
    })),
    hits: [
      { sample: at(12), strength: 0.9, band: 'low', strong: true },
      { sample: at(40), strength: 0.3, band: 'mid', strong: false },
      { sample: at(100), strength: 0.9, band: 'high', strong: true },
    ],
    loudness: [],
    tone: [],
    key: null,
    silences: [],
    swells: [],
    sections: [
      { fromSample: 0, toSample: at(90), kind: 'quiet', loudnessDb: -24 },
      { fromSample: at(90), toSample: at(170), kind: 'build', loudnessDb: -12 },
    ],
  };
  const count = song.metadata.frameCount;
  const saves = memory.saves;
  await openSong(page);
  await expect(page.getByRole('img', { name: 'Waveform for test-music.wav, zoomed', exact: true })).toBeVisible();
  const detail = review(page).locator('.music-review-detail');
  // The default 20 s show the whole 6 s file; 5 s show part of it, around the play position.
  await expect(detail).toHaveAttribute('data-window-end', String(count));
  await expect(page.getByRole('button', { name: 'Zoom out music', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Zoom in music', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in music', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Zoom in music', exact: true })).toBeDisabled();
  await expect(detail).toHaveAttribute('data-window-start', '0');
  await expect(detail).toHaveAttribute('data-window-end', '150');
  await expect(detail.locator('.music-beats')).toHaveAttribute('data-downbeats', '3');

  const go = (name: string) => page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Previous downbeat', exact: true })).toBeDisabled();
  await go('Next downbeat');
  await expect.poll(() => reviewFrame(page)).toBe(5);
  await go('Next downbeat');
  await go('Next downbeat');
  await expect.poll(() => reviewFrame(page)).toBe(125);
  await expect(page.getByRole('button', { name: 'Next downbeat', exact: true })).toBeDisabled();
  await go('Previous strong hit');
  await expect.poll(() => reviewFrame(page)).toBe(100);
  await expect(review(page).locator('.music-review-moment')).toHaveText('strong high hit · build');
  await expect(page.getByRole('button', { name: 'Next strong hit', exact: true })).toBeDisabled();
  await go('Previous section');
  await expect.poll(() => reviewFrame(page)).toBe(90);
  await go('Previous section');
  await expect.poll(() => reviewFrame(page)).toBe(0);

  // Leaving the view turns the page, starting just before the play position.
  await page.getByRole('slider', { name: 'Music playhead', exact: true }).fill(String(count - 5));
  await expect(detail).toHaveAttribute('data-window-start', String(count - 150));
  const zoomed = page.getByRole('slider', { name: 'Zoomed music playhead', exact: true });
  await zoomed.fill('60');
  await expect.poll(() => reviewFrame(page)).toBe(60);
  await expect(detail).toHaveAttribute('data-window-start', String(count - 150));
  await zoomed.press('i');
  await expect(detail).toHaveAttribute('data-source-in', '60');
  await expect(detail.locator('.music-review-edge.in')).toBeVisible();
  await expect(detail.locator('.music-review-edge.out')).toBeVisible();
  expect(memory.saves).toBe(saves);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a recording that cannot play says why', async ({ page }) => {
  missing = [song.id];
  await page.reload();
  await openSong(page);
  await expect(
    review(page).getByText(/The original is missing at .*test-music\.wav\. Relink it in Media/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play music preview', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add music clip 5.97 s to timeline', exact: true })).toBeDisabled();
});
