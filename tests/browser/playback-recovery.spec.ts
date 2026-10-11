import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { PreviewDiagnostics } from '../../src/preview/engine.js';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';
import { installMusicEvidence, observeRealtimeHeadroom } from './music-evidence.js';
import { installVideoFrameGate } from './video-frame-gate.js';

interface RecoveryFixture {
  memory: MemoryProjects;
  document: ProjectDocument;
}

interface PlaybackEvidence {
  musicStarts: number;
  musicPauses: number;
  deliberatePauseMusicCalls: number;
  pausedGuard: boolean;
  unexpectedMusicStarts: number;
  unexpectedResumes: number;
  notifications: number;
  playingNotifications: number;
  playingMusicNotifications: number;
  maximumMusicDriftFrames: number;
  driftViolations: number;
  maximumAVDriftFrames: number;
  avDriftViolations: number;
  avDriftSamples: unknown[];
  sourceViolations: number;
  sourceSamples: unknown[];
  bufferingEntries: number;
  minimumDecoderCount: number;
  maximumDecoderCount: number;
  errors: number;
  firstError: string | null;
}

declare global {
  interface Window {
    playbackRecoveryEvidence: PlaybackEvidence;
  }
}

async function openRecoveryProject(
  page: Page,
  request: APIRequestContext,
  withMusic: boolean,
  slow = false,
): Promise<RecoveryFixture> {
  const mediaResponse = await request.get('/api/media');
  expect(mediaResponse.ok()).toBe(true);
  const assets = ((await mediaResponse.json()) as { assets: MediaAsset[] }).assets;
  const source = assets.find((asset) => asset.name === 'pattern-a.mp4' && asset.status === 'ready');
  expect(source, 'The existing prepared synthetic video is required.').toBeDefined();
  const project = createProject(`recovery-${withMusic}-${slow}`, 'Synthetic playback recovery');
  project.media.videoIds = [source!.id];
  project.clips = [createClip('recovery-clip', source!.id, 0, slow ? 9 : 90)];
  if (slow) project.clips[0]!.speed = { mode: 'constant', rate: 0.1 };
  if (withMusic) {
    const audioResponse = await request.get('/api/audio');
    expect(audioResponse.ok()).toBe(true);
    const audio = ((await audioResponse.json()) as { assets: AudioAsset[] }).assets.find(
      (asset) => asset.name === 'test-music.wav' && asset.status === 'ready',
    );
    expect(audio, 'The existing prepared synthetic WAV is required.').toBeDefined();
    project.media.audioIds = [audio!.id];
    // Music covers the entire playback, without a source wrap or placement boundary.
    project.music = [
      {
        id: 'recovery-music',
        mediaId: audio!.id,
        sourceIn: 0,
        sourceOut: 120,
        start: 0,
        duration: 90,
        gainDb: -12,
        fadeIn: 0,
        fadeOut: 0,
        loop: false,
      },
    ];
  }
  const memory = await memoryProjects(page, project);
  await installMusicEvidence(page);
  await observeRealtimeHeadroom(page, test.info());
  await installVideoFrameGate(page);
  await page.addInitScript(() => {
    // Install before nested transpiled callbacks; init-script ordering is unspecified.
    Reflect.set(globalThis, '__name', (fn: unknown) => fn);
    const evidence: PlaybackEvidence = {
      musicStarts: 0,
      musicPauses: 0,
      deliberatePauseMusicCalls: 0,
      pausedGuard: true,
      unexpectedMusicStarts: 0,
      unexpectedResumes: 0,
      notifications: 0,
      playingNotifications: 0,
      playingMusicNotifications: 0,
      maximumMusicDriftFrames: 0,
      driftViolations: 0,
      maximumAVDriftFrames: 0,
      avDriftViolations: 0,
      avDriftSamples: [],
      sourceViolations: 0,
      sourceSamples: [],
      bufferingEntries: 0,
      minimumDecoderCount: 2,
      maximumDecoderCount: 2,
      errors: 0,
      firstError: null,
    };
    window.playbackRecoveryEvidence = evidence;
    window.addEventListener('pascap-test-music-start', () => {
      evidence.musicStarts++;
      if (evidence.pausedGuard) evidence.unexpectedMusicStarts++;
    });
    window.addEventListener('pascap-test-music-stop', () => {
      evidence.musicPauses++;
    });
  });
  await page.goto(`/?project=${project.id}`);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(memory.snapshot());
  await page.evaluate(
    (rate: number) => {
      const evidence = window.playbackRecoveryEvidence;
      // Exclude resource configuration, not any part of the tested playback.
      evidence.musicStarts = 0;
      evidence.musicPauses = 0;
      let previousStatus = window.pascapLab!.engine.diagnostics().status;
      const checkMusic = (state: PreviewDiagnostics): void => {
        evidence.playingMusicNotifications++;
        const drift = Math.abs(state.musicDriftFrames);
        if (!Number.isFinite(drift) || drift > 1) evidence.driftViolations++;
        evidence.maximumMusicDriftFrames = Math.max(evidence.maximumMusicDriftFrames, drift);
        // Independently observed, actually consumed audio samples with their
        // rendering-thread timestamp, not engine.musicDriftFrames or frame.
        const music = window.musicStreamEvidence;
        const receipt = music.receipt;
        const output = music.context?.getOutputTimestamp();
        const sourceSamples =
          receipt && output ? receipt.samples + output.contextTime! * 48_000 - receipt.contextFrame : Number.NaN;
        const audioFrame = Math.floor(
          (receipt?.startFrame ?? Number.NaN) + sourceSamples / ((48_000 * 1_001) / 30_000) + 1e-7,
        );
        const avDrift = Math.abs(audioFrame - state.frame);
        if (!Number.isFinite(avDrift) || avDrift > 1) {
          evidence.avDriftViolations++;
          if (evidence.avDriftSamples.length < 10)
            evidence.avDriftSamples.push({ state, receipt, output, audioFrame, avDrift });
        }
        evidence.maximumAVDriftFrames = Math.max(evidence.maximumAVDriftFrames, avDrift);
      };
      window.pascapLab!.engine.subscribe((state) => {
        evidence.notifications++;
        evidence.minimumDecoderCount = Math.min(evidence.minimumDecoderCount, state.decoderCount);
        evidence.maximumDecoderCount = Math.max(evidence.maximumDecoderCount, state.decoderCount);
        if (state.status === 'error') {
          evidence.errors++;
          evidence.firstError ??= state.message;
        }
        if (evidence.pausedGuard && state.playing) evidence.unexpectedResumes++;
        if (state.status === 'buffering' && previousStatus === 'playing') evidence.bufferingEntries++;
        previousStatus = state.status;
        if (state.status !== 'playing' || !state.playing) return;
        // A Playing image is the exact source frame of the clock frame it was drawn for.
        evidence.playingNotifications++;
        const lane = state.assignedClipIds.indexOf('recovery-clip');
        const expected = Math.floor(state.frame * rate + 1e-8);
        if (state.requestedFrame !== state.frame || state.decodedSourceFrames[lane] !== expected) {
          evidence.sourceViolations++;
          if (evidence.sourceSamples.length < 10) evidence.sourceSamples.push({ state, expected });
        }
        if (state.audioClock) checkMusic(state);
      });
    },
    slow ? 0.1 : 1,
  );
  return { memory, document: memory.snapshot() };
}

async function startPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.playbackRecoveryEvidence.pausedGuard = false;
  });
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
}

async function waitForCompletion(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = window.pascapLab!.engine.diagnostics();
      return state.status === 'error' || (!state.playing && state.status === 'paused' && state.frame === 89);
    },
    undefined,
    { timeout: 35_000 },
  );
}

async function assertPaused(page: Page, frame: number, musicStarts: number): Promise<void> {
  // Drain real animation callbacks after the cancelled operation has settled;
  // this is an ordering barrier, not a playback-speed or wall-time threshold.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const paused = await page.evaluate(() => ({
    state: window.pascapLab!.engine.diagnostics(),
    musicPaused: !window.musicStreamEvidence.active,
    evidence: window.playbackRecoveryEvidence,
  }));
  expect(paused.state.status, paused.state.message).toBe('paused');
  expect(paused.state.playing).toBe(false);
  expect(paused.state.frame).toBe(frame);
  expect(paused.state.activeDecoders).toBe(0);
  expect(paused.musicPaused).toBe(true);
  expect(paused.evidence.musicStarts).toBe(musicStarts);
  expect(paused.evidence.unexpectedMusicStarts).toBe(0);
  expect(paused.evidence.unexpectedResumes).toBe(0);
}

async function assertCompleted(page: Page, fixture: RecoveryFixture, withMusic: boolean, starts = 1): Promise<void> {
  await page.evaluate(() => {
    window.playbackRecoveryEvidence.pausedGuard = true;
  });
  await assertPaused(page, 89, withMusic ? starts : 0);
  const { state, evidence } = await page.evaluate(() => ({
    state: window.pascapLab!.engine.diagnostics(),
    evidence: window.playbackRecoveryEvidence,
  }));
  expect(state.duration).toBe(90);
  expect(state.audioClock).toBe(withMusic);
  expect(state.decoderCount).toBe(2);
  expect(state.boundaryStalls).toBe(0);
  expect(evidence.minimumDecoderCount).toBe(2);
  expect(evidence.maximumDecoderCount).toBe(2);
  expect(evidence.errors, evidence.firstError ?? 'No preview errors.').toBe(0);
  expect(evidence.playingNotifications).toBeGreaterThan(0);
  expect(evidence.sourceViolations, JSON.stringify(evidence.sourceSamples)).toBe(0);
  expect(evidence.driftViolations).toBe(0);
  expect(evidence.avDriftViolations, JSON.stringify(evidence.avDriftSamples)).toBe(0);
  if (withMusic) {
    expect(evidence.playingMusicNotifications).toBeGreaterThan(0);
    expect(evidence.maximumMusicDriftFrames).toBeLessThanOrEqual(1);
    expect(evidence.maximumAVDriftFrames).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(fixture.document);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(fixture.memory.saves).toBe(0);
  expect(fixture.memory.snapshot()).toEqual(fixture.document);
}

async function attachEvidence(page: Page, browser: Browser, withMusic: boolean, slow: boolean): Promise<void> {
  const evidence = await page.evaluate(() => {
    const state = window.pascapLab!.engine.diagnostics();
    const gate = window.videoFrameGate;
    return {
      renderer: state.renderer,
      status: state.status,
      message: state.message,
      frame: state.frame,
      requestedFrame: state.requestedFrame,
      duration: state.duration,
      decoderCount: state.decoderCount,
      stalls: state.stalls,
      boundaryStalls: state.boundaryStalls,
      stallMilliseconds: state.stallMilliseconds,
      decodedFrames: state.decodedFrames,
      droppedDecodedFrames: state.droppedDecodedFrames,
      decodedSourceFrames: state.decodedSourceFrames,
      queuedFrames: state.queuedFrames,
      ...window.playbackRecoveryEvidence,
      frameGate: { heldFrames: gate.heldFrames, releasedFrames: gate.releasedFrames },
    };
  });
  await test.info().attach('synthetic-playback-recovery', {
    body: JSON.stringify({ browser: browser.version(), withMusic, slow, ...evidence }, null, 2),
    contentType: 'application/json',
  });
}

/** Withhold decoded frames from the first Playing notification at or after `frame`. */
async function holdFramesFrom(page: Page, frame: number): Promise<void> {
  await page.evaluate((from) => {
    const unsubscribe = window.pascapLab!.engine.subscribe((state) => {
      if (state.status !== 'playing' || state.frame < from) return;
      window.videoFrameGate.hold = true;
      queueMicrotask(unsubscribe);
    });
  }, frame);
}

for (const [withMusic, slow] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  test(`synthetic playback recovery ${withMusic ? 'with music' : 'video only'} ${slow ? 'held sources' : 'normal speed'}`, async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(45_000);
    const fixture = await openRecoveryProject(page, request, withMusic, slow);
    try {
      await startPlayback(page);
      await waitForCompletion(page);
      await assertCompleted(page, fixture, withMusic);
    } finally {
      await attachEvidence(page, browser, withMusic, slow);
    }
  });
}

test('a decoder that stops delivering holds the image, reports failure and permits explicit recovery', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(45_000);
  const fixture = await openRecoveryProject(page, request, false);
  try {
    await holdFramesFrom(page, 10);
    await startPlayback(page);
    await page.waitForFunction(() => {
      const state = window.pascapLab!.engine.diagnostics();
      return window.videoFrameGate.heldFrames > 0 && state.status === 'buffering';
    });
    const blocked = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
    expect(blocked).toMatchObject({ playing: true, message: 'Waiting for decoded frames', boundaryStalls: 0 });
    // Without music the clock waits at the first undecoded frame.
    expect(blocked.requestedFrame).toBeGreaterThan(blocked.frame);
    await page.waitForFunction(() => window.pascapLab!.engine.diagnostics().stallMilliseconds > 500);
    expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics())).toMatchObject({
      status: 'buffering',
      frame: blocked.frame,
      requestedFrame: blocked.requestedFrame,
    });
    await waitForCompletion(page);
    const failed = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
    expect(failed).toMatchObject({ status: 'error', playing: false, activeDecoders: 0, decoderCount: 2 });
    expect(failed.message).toBe(
      `Video decoder ${failed.assignedClipIds.indexOf('recovery-clip') + 1} did not deliver source frame ${blocked.requestedFrame} within 5 seconds.`,
    );
    await page.evaluate(() => window.videoFrameGate.release());
    await page.evaluate(() => window.pascapLab!.engine.seek(0));
    await assertPaused(page, 0, 0);
    await startPlayback(page);
    await waitForCompletion(page);
    await assertPaused(page, 89, 0);
    expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(fixture.document);
    expect(fixture.memory.saves).toBe(0);
  } finally {
    await page.evaluate(() => window.videoFrameGate.release());
    await attachEvidence(page, browser, false, false);
  }
});

test('music keeps its clock while a late decoder catches up by dropping passed frames', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(45_000);
  const fixture = await openRecoveryProject(page, request, true);
  try {
    await holdFramesFrom(page, 10);
    await startPlayback(page);
    await page.waitForFunction(() => {
      const state = window.pascapLab!.engine.diagnostics();
      return window.videoFrameGate.heldFrames > 0 && state.status === 'buffering' && state.requestedFrame >= 25;
    });
    const late = await page.evaluate(() => {
      const state = window.pascapLab!.engine.diagnostics();
      window.videoFrameGate.release();
      return state;
    });
    expect(late).toMatchObject({ playing: true, audioClock: true });
    expect(late.requestedFrame - late.frame).toBeGreaterThan(1);
    await waitForCompletion(page);
    await assertCompleted(page, fixture, true);
    const recovered = await page.evaluate(() => ({
      state: window.pascapLab!.engine.diagnostics(),
      evidence: window.playbackRecoveryEvidence,
    }));
    expect(recovered.state.droppedDecodedFrames).toBeGreaterThan(0);
    expect(recovered.evidence.bufferingEntries).toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => window.videoFrameGate.release());
    await attachEvidence(page, browser, true, false);
  }
});

for (const withMusic of [false, true]) {
  test(`pause, seek and deliberate restart ${withMusic ? 'with music and a withheld-seek cancellation' : 'video only'}`, async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(45_000);
    const fixture = await openRecoveryProject(page, request, withMusic);
    try {
      await startPlayback(page);
      await page.waitForFunction(() => {
        const engine = window.pascapLab!.engine;
        const state = engine.diagnostics();
        if (state.status === 'error') return true;
        if (state.status !== 'playing' || state.frame < 10) return false;
        const evidence = window.playbackRecoveryEvidence;
        const pauses = evidence.musicPauses;
        evidence.pausedGuard = true;
        engine.pause();
        evidence.deliberatePauseMusicCalls = evidence.musicPauses - pauses;
        return true;
      });
      const stopped = await page.evaluate(() => ({
        frame: window.pascapLab!.engine.diagnostics().frame,
        deliberatePauseMusicCalls: window.playbackRecoveryEvidence.deliberatePauseMusicCalls,
      }));
      expect(stopped.frame).toBeGreaterThanOrEqual(10);
      expect(stopped.frame).toBeLessThan(89);
      expect(stopped.deliberatePauseMusicCalls).toBe(withMusic ? 1 : 0);
      await assertPaused(page, stopped.frame, withMusic ? 1 : 0);

      if (withMusic) {
        // Deterministic cancellation: withhold the exact decoded frame of a
        // seek until after play() (busy, so no music) and pause.
        await page.evaluate(() => window.pascapLab!.engine.seek(39));
        await assertPaused(page, 39, 1);
        await page.evaluate(() => {
          window.videoFrameGate.hold = true;
          Reflect.set(window, 'pendingRecoverySeek', window.pascapLab!.engine.seek(40));
        });
        await page.waitForFunction(() => window.videoFrameGate.heldFrames === 1);
        const blocked = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
        expect(blocked).toMatchObject({ status: 'seeking', playing: false, frame: 39, requestedFrame: 40 });
        await page.evaluate(async () => {
          const engine = window.pascapLab!.engine;
          await engine.play();
          engine.pause();
          window.videoFrameGate.release();
          await Reflect.get(window, 'pendingRecoverySeek');
        });
        await assertPaused(page, 39, 1);
        expect(await page.evaluate(() => window.videoFrameGate.releasedFrames)).toBe(1);
      }

      await page.evaluate(() => window.pascapLab!.engine.seek(40));
      await assertPaused(page, 40, withMusic ? 1 : 0);
      await startPlayback(page);
      await waitForCompletion(page);
      await assertCompleted(page, fixture, withMusic, 2);
    } finally {
      await attachEvidence(page, browser, withMusic, false);
    }
  });
}
