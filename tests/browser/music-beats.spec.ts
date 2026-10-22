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
import {
  MUSIC_ANALYSIS_VERSION,
  musicBeatFrames,
  musicHitFrames,
  musicSpans,
  type MusicAnalysis,
} from '../../src/shared/music-analysis.js';
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
/** Hits at source frames 12 (strong low), 20 (light high), 41 (strong mid), 70 (light mid) and 100 (strong high). */
const HITS: MusicAnalysis['hits'] = (
  [
    [12, 'low', true],
    [20, 'high', false],
    [41, 'mid', true],
    [70, 'mid', false],
    [100, 'high', true],
  ] as const
).map(([frame, band, strong]) => ({
  sample: Math.round(frame * MUSIC_SAMPLES_PER_FRAME),
  strength: strong ? 0.9 : 0.3,
  band,
  strong,
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
    hits: [],
    loudness: [],
    tone: [],
    key: null,
    silences: [],
    swells: [],
    sections: [],
  };
}

const at = (frame: number): number => Math.round(frame * MUSIC_SAMPLES_PER_FRAME);

/** A quiet half then a build, a gradual crescendo, a sudden drop and a short silence. */
function structured(): MusicAnalysis {
  return {
    ...synthetic(),
    key: { tonic: 'C', mode: 'minor', confidence: 0.6 },
    loudness: Array.from({ length: 40 }, (_, index) => (index < 20 ? -24 : -12)),
    tone: [
      [-20, -30, -50],
      [-12, -24, -44],
      [-8, -18, -36],
      [-6, -14, -30],
    ],
    sections: [
      { fromSample: 0, toSample: at(60), kind: 'quiet', loudnessDb: -24 },
      { fromSample: at(60), toSample: at(120), kind: 'build', loudnessDb: -12 },
    ],
    swells: [
      { fromSample: at(20), toSample: at(50), kind: 'crescendo', changeDb: 9, sudden: false },
      { fromSample: at(100), toSample: at(104), kind: 'decrescendo', changeDb: -12, sudden: true },
    ],
    silences: [{ fromSample: at(50), toSample: at(55) }],
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
      (method === 'POST' && pathname === '/api/ops/music_waveform') ||
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

async function frameX(page: Page, frame: number): Promise<number> {
  const surface = page.locator('.timeline-surface');
  const { left, leading, scale } = await surface.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    leading: Number(element.getAttribute('data-leading')),
    scale: Number(element.getAttribute('data-pixels-per-frame')),
  }));
  return left + leading + frame * scale;
}

const playhead = (page: Page): Promise<number> => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);

/** Clicks the lower half of the time ruler at `frame` and expects the playhead at `landing`. */
async function clickRuler(page: Page, frame: number, landing: number): Promise<void> {
  const ruler = (await page.locator('.timeline-ruler').boundingBox())!;
  await page.mouse.click(await frameX(page, frame), ruler.y + ruler.height - 5);
  await expect.poll(() => playhead(page)).toBe(landing);
}

test('beat ticks follow the music track placement and loops', async ({ page }) => {
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
  // Without sections, swells, silences or tone, the clip shows none of them.
  await expect(clip.locator('.music-section, .music-silence, .music-swells, .music-tone')).toHaveCount(0);
  await expect(page.getByText('Music structure', { exact: true })).toHaveCount(0);
});

test('the waveform draws every 10 ms for each pixel of the clip, through loops, and refines when zoomed', async ({
  page,
}) => {
  // Silence with one 50 ms hit 2.002 s into the recording (source frame 60), as the service reads it.
  const levels = new Int8Array(2 * Math.ceil(song.metadata.durationSeconds * 100));
  for (let bucket = 200; bucket < 205; bucket++) levels.set([-100, 127], bucket * 2);
  await page.route('**/api/ops/music_waveform', (route) =>
    route.fulfill({ json: { bucketSamples: 480, data: Buffer.from(levels.buffer).toString('base64') } }),
  );
  await open(page);
  const clip = page.locator('[data-music-id="beats-music"]');
  const waveform = clip.getByRole('img', { name: /^Waveform for music track 1/ });
  const outline = waveform.locator('path');
  /** The clip's frame offset of every drawn column that reaches near full scale, grouped into hits. */
  const hits = async (): Promise<{ columns: number; hits: number[] }> =>
    outline.evaluate((shape) => {
      const columns = Number(shape.parentElement!.getAttribute('viewBox')!.split(' ')[2]);
      const tokens = [...shape.getAttribute('d')!.matchAll(/([HV])(-?[\d.]+)/g)];
      let top = Number(/^M0 ([\d.]+)/.exec(shape.getAttribute('d')!)![1]);
      let from = 0;
      const tall: number[] = [];
      for (const [, command, value] of tokens) {
        if (command === 'V') top = Number(value);
        else {
          const to = Number(value);
          if (top < 5) tall.push((from + to) / 2);
          from = to;
          if (to === columns) break;
        }
      }
      const groups: number[] = [];
      for (const column of tall) if (groups.length === 0 || column - groups.at(-1)! > 3) groups.push(column);
      return { columns, hits: groups };
    });
  const width = async (): Promise<number> => (await clip.boundingBox())!.width;
  const first = await hits();
  // One column per pixel rather than a fixed 128 bars; the hit plays at 59.94 and, after the loop, at 179.94 frames.
  expect(Math.abs(first.columns - (await width()))).toBeLessThanOrEqual(1);
  expect(first.columns).toBeGreaterThan(128);
  expect(first.hits).toHaveLength(2);
  first.hits.forEach((column, index) =>
    expect(Math.abs((column / first.columns) * TRACK.duration - (59.94 + 120 * index))).toBeLessThan(2),
  );

  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await hits()).columns).toBeGreaterThan(first.columns);
  const zoomed = await hits();
  expect(zoomed.columns).toBeLessThanOrEqual(Math.ceil((TRACK.duration * MUSIC_SAMPLES_PER_FRAME) / 480));
  expect(zoomed.hits).toHaveLength(2);
});

test('Snap to beats snaps to the beats or downbeats where the music plays now, without editing the project', async ({
  page,
}) => {
  analysis = synthetic();
  await open(page);
  const toggle = page.getByRole('button', { name: 'Snap to beats', exact: true });
  const rulerBeats = page.locator('.timeline-ruler-beats');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(rulerBeats).toHaveCount(0);
  // 68 is three frames from the beat at 65, away from every clip edge.
  await clickRuler(page, 68, 68);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(rulerBeats).toHaveAttribute('data-downbeats', String(expected(true).length));
  await expect(rulerBeats).toHaveAttribute('data-beats', String(expected(false).length - expected(true).length));
  await clickRuler(page, 68, 65);
  // Alt bypasses beats like every other target.
  await page.keyboard.down('Alt');
  await clickRuler(page, 68, 68);
  await page.keyboard.up('Alt');

  await page.getByRole('group', { name: 'Beat snapping' }).locator('summary').click();
  await page.getByRole('radio', { name: 'Downbeats only', exact: true }).check();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(rulerBeats).toHaveAttribute('data-beats', '0');
  await expect(rulerBeats).toHaveAttribute('data-downbeats', String(expected(true).length));
  await clickRuler(page, 98, 95);
  await clickRuler(page, 68, 68);

  // Moving the music clip moves the beats it snaps to.
  await page.getByRole('button', { name: /^Move music track 1/ }).focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('[data-music-id="beats-music"]')).toHaveAttribute('data-music-start', '40');
  await clickRuler(page, 108, 105);

  // Snap off turns beat snapping off too and explains why.
  await page.getByRole('button', { name: 'Toggle snapping', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('title', 'Turn on Snap to snap to beats.');
  await expect(rulerBeats).toHaveCount(0);
  await clickRuler(page, 108, 108);
  await page.getByRole('button', { name: 'Toggle snapping', exact: true }).click();

  // The toggle returns to the last choice; the choice is a browser preference, not project data.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(rulerBeats).toHaveCount(0);
  await toggle.click();
  await expect(rulerBeats).toHaveAttribute('data-beats', '0');
  const document = await current(page);
  expect(document.bookmarks).toEqual([]);
  expect(document.music[0]!.clips[0]!.start).toBe(40);
  await page.evaluate(() => window.pascapLab!.flush());
  await page.goto(`/?project=${document.id}`);
  await expect(page.getByRole('button', { name: 'Snap to beats', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the music clip and Audio tab show the key, sections, swells, silences and tone where they play', async ({
  page,
}) => {
  const data = structured();
  analysis = data;
  await open(page);
  await expect(page.getByRole('status').filter({ hasText: '120 BPM · 4/4 · C minor · 12 beats' })).toBeVisible();
  const music = { ...TRACK, mediaId: song.id };
  const clip = page.locator('[data-music-id="beats-music"]');
  const sections = data.sections.flatMap((section) =>
    musicSpans(music, section.fromSample, section.toSample).map((span) => ({ ...span, kind: section.kind })),
  );
  expect(sections.map((section) => section.kind).sort()).toEqual(['build', 'build', 'quiet', 'quiet']);
  const drawn = await clip.locator('.music-section').evaluateAll((elements) =>
    elements.map((element) => ({
      start: Number(element.getAttribute('data-start')),
      end: Number(element.getAttribute('data-end')),
      kind: element.getAttribute('data-section'),
    })),
  );
  expect(drawn).toEqual([...sections].sort((left, right) => left.start - right.start));
  const silences = await clip
    .locator('.music-silence')
    .evaluateAll((elements) =>
      elements.map((element) => [
        Number(element.getAttribute('data-silence')),
        Number(element.getAttribute('data-end')),
      ]),
    );
  expect(silences).toEqual(
    musicSpans(music, data.silences[0]!.fromSample, data.silences[0]!.toSample).map((span) => [span.start, span.end]),
  );
  // The gradual crescendo repeats with the loop; the sudden drop's second repeat falls after the clip.
  const swells = clip.locator('.music-swells path');
  await expect(swells).toHaveCount(3);
  await expect(clip.locator('.music-swells path[data-sudden="true"]')).toHaveAttribute('data-swell', 'decrescendo');
  await expect(clip.locator('.music-tone path').first()).toBeAttached();

  // Hovering reads the music at the pointer.
  const body = (await clip.locator('.music-body').boundingBox())!;
  await page.mouse.move(await frameX(page, 100), body.y + body.height / 2);
  await expect(clip.locator('.music-readout')).toContainText('00:03:10 · build · −12 dB');
  await page.mouse.move(await frameX(page, 82), body.y + body.height / 2);
  await expect(clip.locator('.music-readout')).toContainText('silence');
  await page.mouse.move(body.x + body.width / 2, body.y - 40);
  await expect(clip.locator('.music-readout')).toHaveCount(0);

  // The same information is reachable by keyboard, and its timecodes seek.
  await page.getByText('Music structure', { exact: true }).click();
  const list = page.getByRole('region', { name: 'Sections' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list.getByRole('listitem').nth(1)).toContainText('build to 00:05:00 · −12 dB · low −7 dB');
  await page.getByRole('region', { name: 'Swells' }).getByRole('button', { name: '00:04:10', exact: true }).click();
  await expect.poll(() => playhead(page)).toBe(130);
  await expect(page.getByRole('region', { name: 'Silences' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('hits show as band marks where they play, in the readout and list, and Hits snapping uses strong ones', async ({
  page,
}) => {
  analysis = { ...synthetic(), hits: HITS };
  await open(page);
  await expect(page.getByRole('status').filter({ hasText: '120 BPM · 4/4 · 12 beats · 5 hits' })).toBeVisible();
  const placed = musicHitFrames({ ...TRACK, mediaId: song.id }, HITS);
  const strong = placed.filter((hit) => hit.strong);
  expect(placed.map((hit) => hit.frame)).toEqual([42, 50, 71, 100, 130, 162, 170, 191, 220]);
  const clip = page.locator('[data-music-id="beats-music"]');
  const marks = clip.locator('.music-hits');
  await expect(marks).toHaveAttribute('data-strong-hits', String(strong.length));
  await expect(marks).toHaveAttribute('data-light-hits', String(placed.length - strong.length));
  // Every mark sits on its hit's project frame, in its band, strong ones taller.
  const scale = (await clip.evaluate((element) => element.getBoundingClientRect().width)) / TRACK.duration;
  const drawn = await marks.evaluate((svg) =>
    [...svg.querySelectorAll('path')].flatMap((path) =>
      [...(path.getAttribute('d') ?? '').matchAll(/M([\d.]+) ([\d.]+)V/g)].map((match) => ({
        x: Number(match[1]),
        top: Number(match[2]),
        className: path.getAttribute('class'),
      })),
    ),
  );
  const byFrame = drawn
    .map((mark) => ({ ...mark, frame: Math.round(TRACK.start + (mark.x - 0.5) / scale) }))
    .sort((left, right) => left.frame - right.frame);
  expect(byFrame).toHaveLength(placed.length);
  byFrame.forEach((mark, index) => {
    const hit = placed[index]!;
    expect(Math.abs(mark.frame - hit.frame)).toBeLessThanOrEqual(1);
    expect(mark.className).toBe(`${hit.band} ${hit.strong ? 'strong' : 'light'}`);
    expect(mark.top).toBe(hit.strong ? 50 : 56);
  });

  const body = (await clip.locator('.music-body').boundingBox())!;
  await page.mouse.move(await frameX(page, 71), body.y + body.height / 2);
  await expect(clip.locator('.music-readout')).toContainText('strong mid hit');
  // Beats are named too, so the pulse and the hits can be told apart.
  await page.mouse.move(await frameX(page, 95.5), body.y + body.height / 2);
  await expect(clip.locator('.music-readout')).toHaveText('00:03:05 · downbeat');
  await page.mouse.move(await frameX(page, 65.5), body.y + body.height / 2);
  await expect(clip.locator('.music-readout')).toHaveText('00:02:05 · beat');
  await page.mouse.move(body.x + body.width / 2, body.y - 40);

  await page.getByText('Music structure', { exact: true }).click();
  const list = page.getByRole('region', { name: 'Strong hits' });
  await expect(list.getByRole('listitem')).toHaveCount(strong.length);
  await expect(list.getByRole('listitem').first()).toContainText('Low hit');
  await list.getByRole('button', { name: '00:04:10', exact: true }).click();
  await expect.poll(() => playhead(page)).toBe(130);

  const toggle = page.getByRole('button', { name: 'Snap to beats', exact: true });
  const rulerBeats = page.locator('.timeline-ruler-beats');
  await page.getByRole('group', { name: 'Beat snapping' }).locator('summary').click();
  await page.getByRole('radio', { name: 'Hits', exact: true }).check();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('title', 'Snapping to the strong hits of music clips · click to stop');
  await expect(rulerBeats).toHaveAttribute('data-hits', String(strong.length));
  await expect(rulerBeats).toHaveAttribute('data-beats', '0');
  await expect(rulerBeats).toHaveAttribute('data-downbeats', '0');
  await clickRuler(page, 73, 71);
  // A light hit, and the beat at 95, are not targets.
  await clickRuler(page, 102, 102);
  await clickRuler(page, 97, 97);

  await page.getByRole('group', { name: 'Beat snapping' }).locator('summary').click();
  await page.getByRole('radio', { name: 'Beats and hits', exact: true }).check();
  await expect(rulerBeats).toHaveAttribute('data-hits', String(strong.length));
  await expect(rulerBeats).toHaveAttribute('data-downbeats', String(expected(true).length));
  await clickRuler(page, 97, 95);
  await clickRuler(page, 73, 71);
  expect((await current(page)).bookmarks).toEqual([]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('without an analysis there are no ticks, structure or beats to snap to', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('status').filter({ hasText: 'Tempo and beats not analysed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analyse music', exact: true })).toBeVisible();
  await expect(page.locator('.music-beats, .music-section, .music-tone')).toHaveCount(0);
  await expect(page.getByText('Music structure', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Snap to beats', exact: true }).click();
  await expect(page.locator('.timeline-ruler-beats')).toHaveCount(0);
  await clickRuler(page, 68, 68);
  expect((await current(page)).bookmarks).toEqual([]);
});
