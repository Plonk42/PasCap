import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { memoryProjects } from './memory-projects.js';
import { installMusicEvidence, observeRealtimeHeadroom } from './music-evidence.js';
import { singleClipLane } from '../music-lanes.js';

interface StallEvidence {
  longestTask: number;
  longTasks: number;
  bufferingEntries: number;
  errors: string[];
  witnesses: { at: number; message: string; requested: number; frame: number; decoded: [string, number][] }[];
  samples: { requested: number; decoded: [string, number][] }[];
}

declare global {
  interface Window {
    multiClipEvidence: StallEvidence;
  }
}

// #148 reproduction: stall counters are informational annotations, never speed gates.

/** Track clips as [recording, source IN, length]; every track starts at frame 0 with Ripple on. */
type TrackPlan = readonly (readonly [number, number, number])[];

const SCENARIOS: Record<
  string,
  {
    tracks: readonly TrackPlan[];
    dissolve?: readonly [number, number, number];
    /** Track Opacity keyframes as [track, frame, opacity]. */
    opacity?: readonly (readonly [number, number, number])[];
  }
> = {
  // One track with a cut every 25 frames.
  'one track, cuts': {
    tracks: [
      [
        [0, 0, 25],
        [1, 10, 25],
        [0, 30, 25],
        [1, 40, 25],
        [0, 60, 25],
        [1, 70, 25],
      ],
    ],
  },
  // Three enabled tracks with dense cuts (every 15–30 frames) and one dissolve.
  'three tracks, dense cuts and a dissolve': {
    tracks: [
      [
        [0, 0, 25],
        [1, 10, 25],
        [0, 30, 30],
        [1, 40, 30],
        [0, 60, 25],
        [1, 70, 25],
      ],
      [
        [2, 0, 30],
        [0, 20, 30],
        [2, 40, 30],
        [0, 60, 30],
        [2, 80, 30],
      ],
      [
        [1, 0, 15],
        [2, 15, 15],
        [1, 30, 15],
        [2, 45, 15],
        [1, 60, 15],
        [2, 75, 15],
        [1, 90, 15],
        [2, 5, 15],
        [1, 20, 15],
        [2, 35, 15],
      ],
    ],
    // Track 1, between its third and fourth clips, 10 frames.
    dissolve: [0, 2, 10],
  },
  // A cut base track under a top track fading in and out with Opacity keyframes.
  'two tracks, Opacity keyframe fades': {
    tracks: [
      [
        [0, 0, 50],
        [1, 20, 50],
        [0, 60, 50],
      ],
      [
        [2, 0, 75],
        [1, 30, 75],
      ],
    ],
    opacity: [
      [1, 0, 0],
      [1, 30, 1],
      [1, 60, 0.2],
      [1, 90, 1],
      [1, 120, 0],
      [1, 149, 0.6],
    ],
  },
};

function buildProject(
  name: string,
  recordings: readonly MediaAsset[],
  music: AudioAsset | null,
): { document: ProjectDocument; boundaries: number } {
  const scenario = SCENARIOS[name]!;
  let document = createProject(`multi-clip-${Object.keys(SCENARIOS).indexOf(name)}-${music ? 'music' : 'video'}`, name);
  document.media.videoIds = recordings.map((recording) => recording.id);
  let boundaries = 0;
  scenario.tracks.forEach((plan, track) => {
    const layerId = track ? `multi-track-${track}` : document.layers[0]!.id;
    if (track)
      document = applyCommand(document, { type: 'layer-add', layer: createLayer(layerId, `Track ${track + 1}`) });
    plan.forEach(([recording, sourceIn, length], index) => {
      const clip = createClip(`t${track}-c${index}`, recordings[recording]!.id, sourceIn, sourceIn + length, layerId);
      document = applyCommand(document, { type: 'insert', clip, index: document.clips.length });
    });
    boundaries += plan.length - 1;
  });
  if (scenario.dissolve) {
    const [track, left, duration] = scenario.dissolve;
    document = applyCommand(document, {
      type: 'transition',
      transition: { leftId: `t${track}-c${left}`, rightId: `t${track}-c${left + 1}`, type: 'cross-dissolve', duration },
    });
  }
  for (const [track, frame, value] of scenario.opacity ?? []) {
    const layerId = track ? `multi-track-${track}` : document.layers[0]!.id;
    document = applyCommand(document, { type: 'layer-key-toggle', layerId, frame, setting: 'opacity', value });
  }
  if (music) {
    const duration = calculateLayout(document).duration;
    document.media.audioIds = [music.id];
    document = applyCommand(document, {
      type: 'music',
      music: [
        singleClipLane({
          id: 'multi-clip-music',
          mediaId: music.id,
          sourceIn: 0,
          sourceOut: duration,
          start: 0,
          duration,
          gainDb: -12,
          fadeIn: 0,
          fadeOut: 0,
          loop: false,
        }),
      ],
    });
  }
  return { document, boundaries };
}

async function fixtureMedia(request: APIRequestContext): Promise<{ recordings: MediaAsset[]; music: AudioAsset }> {
  const assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const recordings = ['pattern-a.mp4', 'pattern-b.mp4', 'recording-03.mp4'].map((name) =>
    assets.find((asset) => asset.name === name && asset.status === 'ready'),
  );
  expect(recordings.every(Boolean), 'The three prepared synthetic recordings are required.').toBe(true);
  const audio = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets.find(
    (asset) => asset.name === 'test-music.wav' && asset.status === 'ready',
  );
  expect(audio, 'The prepared synthetic WAV is required.').toBeDefined();
  return { recordings: recordings as MediaAsset[], music: audio! };
}

async function playThrough(page: Page, duration: number): Promise<void> {
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await page.waitForFunction(
    (last) => {
      const state = window.pascapLab!.engine.diagnostics();
      return state.status === 'error' || (!state.playing && state.status === 'paused' && state.frame === last);
    },
    duration - 1,
    { timeout: 60_000 },
  );
}

for (const name of Object.keys(SCENARIOS)) {
  for (const withMusic of [false, true]) {
    test(`multi-clip playback reproduction: ${name}, ${withMusic ? 'with music' : 'video only'}`, async ({
      page,
      request,
      browser,
    }) => {
      test.setTimeout(75_000);
      const media = await fixtureMedia(request);
      const { document, boundaries } = buildProject(name, media.recordings, withMusic ? media.music : null);
      const duration = calculateLayout(document).duration;
      const memory = await memoryProjects(page, document);
      await installMusicEvidence(page);
      await observeRealtimeHeadroom(page, test.info());
      await page.addInitScript(() => {
        const evidence: StallEvidence = {
          longestTask: 0,
          longTasks: 0,
          bufferingEntries: 0,
          errors: [],
          witnesses: [],
          samples: [],
        };
        window.multiClipEvidence = evidence;
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              evidence.longTasks++;
              evidence.longestTask = Math.max(evidence.longestTask, entry.duration);
            }
          }).observe({ type: 'longtask' });
        } catch {
          // Long Tasks API unavailable: report zero, never a guess.
        }
      });
      await page.goto(`/?project=${document.id}`);
      await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
      await page.evaluate(() => {
        const evidence = window.multiClipEvidence;
        evidence.longestTask = 0;
        evidence.longTasks = 0;
        let previous = window.pascapLab!.engine.diagnostics().status;
        window.pascapLab!.engine.subscribe((state) => {
          if (state.status === 'buffering' && previous !== 'buffering') {
            evidence.bufferingEntries++;
            if (evidence.witnesses.length < 40)
              evidence.witnesses.push({
                at: performance.now(),
                message: state.message,
                requested: state.requestedFrame,
                frame: state.frame,
                decoded: state.assignedClipIds.flatMap((id, slot) =>
                  id === null ? [] : [[id, state.decodedSourceFrames[slot]!] as [string, number]],
                ),
              });
          }
          if (state.status === 'error') evidence.errors.push(state.message);
          previous = state.status;
        });
        const sample = (): void => {
          const state = window.pascapLab!.engine.diagnostics();
          if (state.status === 'playing' && evidence.samples.length < 2_000)
            evidence.samples.push({
              requested: state.requestedFrame,
              decoded: state.assignedClipIds.flatMap((id, slot) =>
                id === null ? [] : [[id, state.decodedSourceFrames[slot]!] as [string, number]],
              ),
            });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await playThrough(page, duration);
      const result = await page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return {
          state,
          evidence: window.multiClipEvidence,
          musicStarts: window.musicStreamEvidence.starts,
          underruns: window.musicStreamEvidence.underruns,
        };
      });
      const layout = calculateLayout(document);
      // Required minus presented source frame per active clip, sampled every display frame while Playing.
      const lags = new Map<number, number>();
      for (const sample of result.evidence.samples)
        for (const layer of sampleTimeline(document, sample.requested, layout)) {
          const decoded = sample.decoded.find(([id]) => id === layer.clipId)?.[1];
          if (decoded === undefined) continue;
          const lag = Math.max(-3, Math.min(3, layer.sourceFrame - decoded));
          lags.set(lag, (lags.get(lag) ?? 0) + 1);
        }
      const counters = {
        browser: browser.version(),
        renderer: result.state.renderer,
        viewport: page.viewportSize(),
        scenario: name,
        music: withMusic,
        duration,
        boundaries,
        stalls: result.state.stalls,
        boundaryStalls: result.state.boundaryStalls,
        midClipStalls: result.state.stalls - result.state.boundaryStalls,
        stallMilliseconds: Math.round(result.state.stallMilliseconds),
        renderedFrames: result.state.renderedFrames,
        repeatedFrames: duration - result.state.renderedFrames,
        decodedFrames: result.state.decodedFrames,
        droppedDecodedFrames: result.state.droppedDecodedFrames,
        musicStarts: result.musicStarts,
        musicUnderruns: result.underruns,
        longestTask: Math.round(result.evidence.longestTask),
        longTasks: result.evidence.longTasks,
        sourceLag: Object.fromEntries([...lags].sort((a, b) => a[0] - b[0])),
      };
      test.info().annotations.push({ type: 'multi-clip-stalls', description: JSON.stringify(counters) });
      console.log(`multi-clip-stalls ${JSON.stringify(counters)}`);
      await test.info().attach('stall-witnesses', {
        body: JSON.stringify(
          result.evidence.witnesses.map((witness) => ({
            ...witness,
            lag: sampleTimeline(document, witness.requested, layout).map((layer) => [
              layer.clipId,
              layer.sourceFrame - (witness.decoded.find(([id]) => id === layer.clipId)?.[1] ?? Number.NaN),
            ]),
          })),
          null,
          2,
        ),
        contentType: 'application/json',
      });
      expect(result.evidence.errors).toEqual([]);
      expect(result.state.status, result.state.message).toBe('paused');
      expect(result.state.frame).toBe(duration - 1);
      expect(memory.saves).toBe(0);
    });
  }
}
