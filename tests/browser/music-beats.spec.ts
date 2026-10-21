import { expect, test, type Page } from '@playwright/test';
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
import { MUSIC_ANALYSIS_VERSION, musicBeatFrames, type MusicAnalysis } from '../../src/shared/music-analysis.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { singleClipLane } from '../music-lanes.js';
import { inspectorTab } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let video: MediaAsset;
let song: AudioAsset;
let memory: MemoryProjects;
let base: ProjectDocument;
let unexpected: string[];
let analysis: MusicAnalysis | null;

/** Twelve beats every 15 source frames from frame 5, a downbeat every fourth. */
const BEATS: MusicAnalysis['beats'] = Array.from({ length: 12 }, (_, index) => ({
  sample: Math.round((5 + 15 * index) * MUSIC_SAMPLES_PER_FRAME),
  strength: 0.8,
  downbeat: index % 4 === 0,
}));
const TRACK: MusicTrack = {
  id: 'beats-music',
  mediaId: '',
  sourceIn: 0,
  sourceOut: 120,
  start: 30,
  duration: 200,
  gainDb: 0,
  fadeIn: 0,
  fadeOut: 0,
  loop: true,
};

function synthetic(): MusicAnalysis {
  return {
    version: MUSIC_ANALYSIS_VERSION,
    source: { content: 'a'.repeat(64), bytes: 4, mtimeMs: 0 },
    sampleRate: 48_000,
    hop: 480,
    samples: Math.round(song.metadata.durationSeconds * 48_000),
    tempo: { bpm: 120, confidence: 0.9, curve: [{ fromSample: 0, bpm: 120 }] },
    meter: { beatsPerBar: 4, confidence: 0.8 },
    beats: BEATS,
    accents: [],
    loudness: [],
    sections: [],
  };
}

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  analysis = null;
  const videos = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const audio = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets;
  const preparedVideo = videos.find((asset) => asset.name === 'pattern-a.mp4' && asset.status === 'ready');
  const preparedSong = audio.find((asset) => asset.name === 'test-music.wav' && asset.status === 'ready');
  if (
    !preparedVideo ||
    !preparedSong ||
    preparedSong.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/test-music.wav')
  )
    throw new Error('Beat checks require the existing prepared synthetic fixtures.');
  video = preparedVideo;
  song = preparedSong;
  const reads: Record<string, unknown> = {
    '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
    '/api/media': { assets: [video], missing: [] },
    '/api/audio': { assets: [song], missing: [] },
    '/api/jobs': { jobs: [] },
    '/api/footage/roots': { roots: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    if (method === 'GET' && pathname === `/api/audio/${song.id}/analysis`) {
      await route.fulfill({ json: { analysis, job: null } });
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
  const document = createProject('music-beats-memory', 'Music beats · memory-only');
  document.media.videoIds = [video.id];
  document.media.audioIds = [song.id];
  document.clips = [createClip('beats-video', video.id, 0, 120)];
  base = document;
  memory = await memoryProjects(page, document);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
});

test.afterEach(() => expect(unexpected, 'Only memory-only edits and synthetic media reads').toEqual([]));

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function open(page: Page, bookmarks: number[] = []): Promise<ProjectDocument> {
  const document = projectSchema.parse({ ...base, music: [singleClipLane({ ...TRACK, mediaId: song.id })], bookmarks });
  memory.seed(document);
  await page.goto(`/?project=${document.id}`);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().duration))
    .toBe(calculateLayout(document).duration);
  await inspectorTab(page, 'Audio');
  return document;
}

const expected = (downbeats: boolean): number[] =>
  musicBeatFrames({ ...TRACK, mediaId: song.id }, BEATS)
    .filter((beat) => !downbeats || beat.downbeat)
    .map((beat) => beat.frame);

async function openBeats(page: Page): Promise<void> {
  await page.locator('summary[aria-label="Beats → bookmarks"]').click();
}

test('beat ticks follow the music track placement and loops, and Beats → bookmarks adds them in one Undo step', async ({
  page,
}) => {
  analysis = synthetic();
  await open(page);
  await expect(page.getByRole('status').filter({ hasText: '120 BPM · 4/4 · 12 beats' })).toBeVisible();
  const clip = page.locator('[data-music-id="beats-music"]');
  const ticks = clip.locator('.music-beats');
  await expect(ticks).toHaveAttribute('data-downbeats', String(expected(true).length));
  await expect(ticks).toHaveAttribute('data-beats', String(expected(false).length - expected(true).length));
  // Every tick sits on its beat's project frame, through the loop wrap.
  const width = await clip.evaluate((element) => element.getBoundingClientRect().width);
  const scale = width / TRACK.duration;
  const positions = await ticks.evaluate((svg) =>
    [...svg.querySelectorAll('path')].flatMap((path) =>
      [...(path.getAttribute('d') ?? '').matchAll(/M([\d.]+) /g)].map((match) => Number(match[1])),
    ),
  );
  const frames = positions.map((x) => TRACK.start + (x - 0.5) / scale).sort((a, b) => a - b);
  expect(frames).toHaveLength(expected(false).length);
  frames.forEach((frame, index) => expect(Math.abs(frame - expected(false)[index]!)).toBeLessThanOrEqual(1));

  await openBeats(page);
  await page.getByRole('button', { name: `All beats · ${expected(false).length}`, exact: true }).click();
  expect((await current(page)).bookmarks).toEqual(expected(false));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).bookmarks).toEqual([]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await openBeats(page);
  await page.getByRole('button', { name: `Downbeats only · ${expected(true).length}`, exact: true }).click();
  expect((await current(page)).bookmarks).toEqual(expected(true));

  // Existing bookmarks are skipped, never duplicated or merged.
  await openBeats(page);
  const downbeats = page.getByRole('button', { name: 'Downbeats only · 0', exact: true });
  await expect(downbeats).toHaveAttribute('aria-disabled', 'true');
  await expect(downbeats).toHaveAccessibleDescription('Every downbeat of this music clip is already a bookmark.');
  const beats = expected(false).length - expected(true).length;
  await page.getByRole('button', { name: `All beats · ${beats}`, exact: true }).click();
  expect((await current(page)).bookmarks).toEqual(expected(false));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).bookmarks).toEqual(expected(true));
});

test('Beats → bookmarks reports the bookmark limit and still offers downbeats only', async ({ page }) => {
  analysis = synthetic();
  const crowded = Array.from({ length: 995 }, (_, index) => 1_000 + index);
  await open(page, crowded);
  await openBeats(page);
  const all = page.getByRole('button', { name: `All beats · ${expected(false).length}`, exact: true });
  await expect(all).toHaveAttribute('aria-disabled', 'true');
  await expect(all).toHaveAccessibleDescription(
    `${expected(false).length} beats would exceed 1,000 bookmarks (995 already set). Add downbeats only instead.`,
  );
  // An unavailable choice is focusable but does nothing.
  await all.focus();
  await page.keyboard.press('Enter');
  expect((await current(page)).bookmarks).toEqual(crowded);
  await page.getByRole('button', { name: `Downbeats only · ${expected(true).length}`, exact: true }).click();
  expect((await current(page)).bookmarks).toEqual([...expected(true), ...crowded]);
});

test('without an analysis there are no ticks and Beats → bookmarks explains why it is unavailable', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByRole('status').filter({ hasText: 'Tempo and beats not analysed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analyse music', exact: true })).toBeVisible();
  const action = page.getByRole('button', { name: 'Beats → bookmarks', exact: true });
  await expect(action).toHaveAttribute('aria-disabled', 'true');
  await expect(action).toHaveAccessibleDescription('Analyse the music first to find its beats.');
  await expect(page.locator('.music-beats')).toHaveCount(0);
  await action.focus();
  await page.keyboard.press('Enter');
  expect((await current(page)).bookmarks).toEqual([]);
});
