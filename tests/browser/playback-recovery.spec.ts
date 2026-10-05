import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

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
    playingMusicNotifications: number;
    maximumMusicDriftFrames: number;
    driftViolations: number;
    maximumAVDriftFrames: number;
    avDriftViolations: number;
    bufferingEntries: number;
    firstBufferingFrame: number | null;
    avoidableBuffering: number;
    bufferingFrames: { accepted: number; requested: number; observed: number; ready: boolean; eligible: boolean }[];
    minimumDecoderCount: number;
    maximumDecoderCount: number;
    errors: number;
    firstError: string | null;
}

interface VideoCallbackGate {
    targetFrame: number | null;
    atOrAfter: boolean;
    heldFrame: number | null;
    heldCallbacks: number;
    releasedCallbacks: number;
    release: (() => void) | null;
    pendingSeek: Promise<void> | null;
}

declare global {
    interface Window {
        playbackRecoveryEvidence: PlaybackEvidence;
        playbackRecoveryGate: VideoCallbackGate;
    }
}

async function openRecoveryProject(page: Page, request: APIRequestContext, withMusic: boolean, slow = false): Promise<RecoveryFixture> {
    const mediaResponse = await request.get('/api/media');
    expect(mediaResponse.ok()).toBe(true);
    const assets = (await mediaResponse.json() as { assets: MediaAsset[] }).assets;
    const source = assets.find((asset) => asset.name === 'pattern-a.mp4' && asset.status === 'ready');
    expect(source, 'The existing prepared synthetic video is required.').toBeDefined();
    const project = createProject(`recovery-${withMusic}-${slow}`, 'Synthetic playback recovery');
    project.media.videoIds = [source!.id];
    project.clips = [createClip('recovery-clip', source!.id, 0, slow ? 9 : 90)];
    if (slow) project.clips[0]!.speed = { mode: 'constant', rate: 0.1 };
    if (withMusic) {
        const audioResponse = await request.get('/api/audio');
        expect(audioResponse.ok()).toBe(true);
        const audio = (await audioResponse.json() as { assets: AudioAsset[] }).assets
            .find((asset) => asset.name === 'test-music.wav' && asset.status === 'ready');
        expect(audio, 'The existing prepared synthetic WAV is required.').toBeDefined();
        project.media.audioIds = [audio!.id];
        // Music covers the entire playback, without a source wrap or placement boundary.
        project.music = { mediaId: audio!.id, sourceIn: 0, sourceOut: 120, start: 0, duration: 90, gainDb: -12, fadeIn: 0, fadeOut: 0, loop: false };
    }
    const memory = await memoryProjects(page, project);
    await page.addInitScript(() => {
        // Install before nested transpiled callbacks; init-script ordering is unspecified.
        Reflect.set(globalThis, '__name', (fn: unknown) => fn);
        const evidence: PlaybackEvidence = {
            musicStarts: 0, musicPauses: 0, deliberatePauseMusicCalls: 0, pausedGuard: true,
            unexpectedMusicStarts: 0, unexpectedResumes: 0,
            notifications: 0, playingMusicNotifications: 0,
            maximumMusicDriftFrames: 0, driftViolations: 0,
            maximumAVDriftFrames: 0, avDriftViolations: 0,
            bufferingEntries: 0, firstBufferingFrame: null,
            avoidableBuffering: 0, bufferingFrames: [],
            minimumDecoderCount: 2, maximumDecoderCount: 2,
            errors: 0, firstError: null,
        };
        window.playbackRecoveryEvidence = evidence;
        for (const method of ['play', 'pause'] as const) {
            const original: (this: HTMLMediaElement) => Promise<void> | void = HTMLMediaElement.prototype[method];
            Object.defineProperty(HTMLMediaElement.prototype, method, {
                value: function (this: HTMLMediaElement) {
                    if (this.dataset['pascapMusic']) {
                        if (method === 'play') {
                            evidence.musicStarts++;
                            if (evidence.pausedGuard) evidence.unexpectedMusicStarts++;
                        } else evidence.musicPauses++;
                    }
                    return original.call(this);
                },
            });
        }

        // Pass through real Chrome metadata unchanged. Only an explicitly armed,
        // matching source-frame callback is held; no fake media clock or decoded frame.
        const gate: VideoCallbackGate = {
            targetFrame: null, atOrAfter: false, heldFrame: null, heldCallbacks: 0, releasedCallbacks: 0,
            release: null, pendingSeek: null,
        };
        window.playbackRecoveryGate = gate;
        const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
        HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
            return requestFrame.call(this, (now, metadata) => {
                const frame = Math.round(metadata.mediaTime * 30_000 / 1_001);
                const target = gate.targetFrame;
                const matches = target !== null && (gate.atOrAfter ? frame >= target : frame === target);
                if (this.dataset['pascapDecoder'] !== undefined && matches && gate.heldCallbacks === 0) {
                    gate.heldFrame = frame; gate.heldCallbacks++;
                    gate.release = () => {
                        gate.targetFrame = null; gate.release = null; gate.releasedCallbacks++;
                        callback(now, metadata);
                    };
                    return;
                }
                callback(now, metadata);
            });
        };
    });
    await page.goto(`/?project=${project.id}`);
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
    expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(memory.snapshot());
    await page.evaluate((rate: number) => {
        const evidence = window.playbackRecoveryEvidence;
        // Exclude resource configuration, not any part of the tested playback.
        evidence.musicStarts = 0; evidence.musicPauses = 0;
        let previousStatus = window.pascapLab!.engine.diagnostics().status;
        window.pascapLab!.engine.subscribe((state) => {
            evidence.notifications++;
            evidence.minimumDecoderCount = Math.min(evidence.minimumDecoderCount, state.decoderCount);
            evidence.maximumDecoderCount = Math.max(evidence.maximumDecoderCount, state.decoderCount);
            if (state.status === 'error') {
                evidence.errors++;
                evidence.firstError ??= state.message;
            }
            if (evidence.pausedGuard && state.playing) evidence.unexpectedResumes++;
            if (state.status === 'buffering' && previousStatus !== 'buffering') {
                evidence.bufferingEntries++;
                evidence.firstBufferingFrame ??= state.frame;
                if (previousStatus === 'playing' && state.playing && !state.audioClock) {
                    // This fixture has exactly one unchanged clip, constant source IN=0,
                    // and no grades/topology/appearance edits. Require causal evidence for
                    // every buffer: no ready exact neighbour or retainable accepted frame.
                    const slot = state.assignedClipIds.indexOf('recovery-clip');
                    const observed = state.decodedSourceFrames[slot]!;
                    const ready = state.decoderReady[slot]!;
                    const mapped = [state.requestedFrame - 1, state.requestedFrame, state.requestedFrame + 1]
                        .filter((frame) => frame >= 0 && frame < state.duration)
                        .some((frame) => Math.floor(frame * rate + 1e-8) === observed);
                    const invalidEvidence = slot < 0 || !Number.isInteger(observed) || typeof ready !== 'boolean';
                    const eligible = invalidEvidence || (ready && mapped) || Math.abs(state.requestedFrame - state.frame) <= 1;
                    if (eligible) evidence.avoidableBuffering++;
                    evidence.bufferingFrames.push({ accepted: state.frame, requested: state.requestedFrame, observed, ready, eligible });
                }
            }
            previousStatus = state.status;
            // Check every subscription emission in actual playing state, not merely
            // the final sample (which resets drift on seek) or a buffering transition.
            if (state.status === 'playing' && state.playing && state.audioClock) {
                evidence.playingMusicNotifications++;
                const drift = Math.abs(state.musicDriftFrames);
                if (!Number.isFinite(drift) || drift > 1) evidence.driftViolations++;
                evidence.maximumMusicDriftFrames = Math.max(evidence.maximumMusicDriftFrames, drift);
                // This fixture maps audio source time directly to project time. Compare
                // its current integer frame with the actually accepted video frame too,
                // rather than treating audio-vs-clock diagnostics as A/V evidence.
                const music = document.querySelector<HTMLAudioElement>('audio[data-pascap-music]');
                const audioFrame = Math.floor((music?.currentTime ?? NaN) * 30_000 / 1_001 + 1e-7);
                const avDrift = Math.abs(audioFrame - state.frame);
                if (!Number.isFinite(avDrift) || avDrift > 1) evidence.avDriftViolations++;
                evidence.maximumAVDriftFrames = Math.max(evidence.maximumAVDriftFrames, avDrift);
            }
        });
    }, slow ? 0.1 : 1);
    return { memory, document: memory.snapshot() };
}

async function startPlayback(page: Page): Promise<void> {
    await page.evaluate(() => { window.playbackRecoveryEvidence.pausedGuard = false; });
    await page.getByRole('button', { name: 'Play preview', exact: true }).click();
}

async function waitForCompletion(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return state.status === 'error' || (!state.playing && state.status === 'paused' && state.frame === 89);
    }, undefined, { timeout: 35_000 });
}

async function assertPaused(page: Page, frame: number, musicStarts: number): Promise<void> {
    // Drain real animation callbacks after the cancelled operation has settled;
    // this is an ordering barrier, not a playback-speed or wall-time threshold.
    await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const paused = await page.evaluate(() => ({
        state: window.pascapLab!.engine.diagnostics(),
        musicPaused: document.querySelector<HTMLAudioElement>('audio[data-pascap-music]')!.paused,
        evidence: window.playbackRecoveryEvidence,
    }));
    expect(paused.state.status, paused.state.message).toBe('paused');
    expect(paused.state.playing).toBe(false);
    expect(paused.state.frame).toBe(frame);
    expect(paused.musicPaused).toBe(true);
    expect(paused.evidence.musicStarts).toBe(musicStarts);
    expect(paused.evidence.unexpectedMusicStarts).toBe(0);
    expect(paused.evidence.unexpectedResumes).toBe(0);
}

async function assertCompleted(page: Page, fixture: RecoveryFixture, withMusic: boolean, starts = 1): Promise<void> {
    await page.evaluate(() => { window.playbackRecoveryEvidence.pausedGuard = true; });
    await assertPaused(page, 89, withMusic ? starts : 0);
    const { state, evidence } = await page.evaluate(() => ({
        state: window.pascapLab!.engine.diagnostics(), evidence: window.playbackRecoveryEvidence,
    }));
    expect(state.duration).toBe(90);
    expect(state.audioClock).toBe(withMusic);
    expect(state.decoderCount).toBe(2);
    expect(state.boundaryStalls).toBe(0);
    expect(evidence.minimumDecoderCount).toBe(2);
    expect(evidence.maximumDecoderCount).toBe(2);
    expect(evidence.errors, evidence.firstError ?? 'No preview errors.').toBe(0);
    expect(evidence.avoidableBuffering, JSON.stringify(evidence.bufferingFrames)).toBe(0);
    expect(evidence.driftViolations).toBe(0);
    expect(evidence.avDriftViolations).toBe(0);
    if (withMusic) {
        expect(evidence.playingMusicNotifications).toBeGreaterThan(0);
        expect(evidence.maximumMusicDriftFrames).toBeLessThanOrEqual(1);
        expect(evidence.maximumAVDriftFrames).toBeLessThanOrEqual(1);
    }
    await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
    expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(fixture.document);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(fixture.memory.saves).toBe(0);
    expect(fixture.memory.snapshot()).toEqual(fixture.document);
}

async function attachEvidence(page: Page, browser: Browser, withMusic: boolean, slow: boolean): Promise<void> {
    const evidence = await page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        const gate = window.playbackRecoveryGate;
        return {
            renderer: state.renderer, status: state.status, message: state.message,
            frame: state.frame, duration: state.duration, decoderCount: state.decoderCount,
            stalls: state.stalls, boundaryStalls: state.boundaryStalls, stallMilliseconds: state.stallMilliseconds,
            ...window.playbackRecoveryEvidence,
            callbackGate: { heldFrame: gate.heldFrame, heldCallbacks: gate.heldCallbacks, releasedCallbacks: gate.releasedCallbacks },
        };
    });
    await test.info().attach('synthetic-playback-recovery', {
        body: JSON.stringify({ browser: browser.version(), withMusic, slow, ...evidence }, null, 2),
        contentType: 'application/json',
    });
}

for (const [withMusic, slow] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    test(`synthetic playback recovery ${withMusic ? 'with music' : 'video only'} ${slow ? 'held sources' : 'normal speed'}`, async ({ page, request, browser }) => {
        test.setTimeout(45_000);
        const fixture = await openRecoveryProject(page, request, withMusic, slow);
        try {
            await startPlayback(page);
            await waitForCompletion(page);
            await assertCompleted(page, fixture, withMusic);
            if (!withMusic && !slow) {
                const { state, evidence } = await page.evaluate(() => ({
                    state: window.pascapLab!.engine.diagnostics(), evidence: window.playbackRecoveryEvidence,
                }));
                // Each non-initial buffer must be justified by the exact observed-frame
                // contract, not an arbitrary software-renderer count/FPS allowance.
                expect(evidence.firstBufferingFrame).toBe(0);
                expect(evidence.bufferingEntries).toBe(1 + evidence.bufferingFrames.length);
                expect(state.stalls).toBe(evidence.bufferingEntries);
            }
        } finally { await attachEvidence(page, browser, withMusic, slow); }
    });
}

test('a withheld decoded callback buffers beyond one-frame eligibility, reports failure and permits explicit recovery', async ({ page, request, browser }) => {
    test.setTimeout(45_000);
    const fixture = await openRecoveryProject(page, request, false);
    try {
        await page.evaluate(() => {
            // Playing decoders may legitimately skip frame callbacks under load.
            // Hold the first genuine callback after source zero, whatever its frame;
            // unlike an exact requested seek, no particular playback callback is promised.
            window.playbackRecoveryGate.targetFrame = 1;
            window.playbackRecoveryGate.atOrAfter = true;
        });
        await startPlayback(page);
        await page.waitForFunction(() => {
            const gate = window.playbackRecoveryGate;
            const state = window.pascapLab!.engine.diagnostics();
            return gate.heldCallbacks === 1 && state.status === 'buffering' && state.requestedFrame > 1;
        });
        const blocked = await page.evaluate(() => ({ state: window.pascapLab!.engine.diagnostics(), evidence: window.playbackRecoveryEvidence }));
        expect(blocked.evidence.bufferingFrames.length).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.playbackRecoveryGate.heldFrame)).toBeGreaterThanOrEqual(1);
        expect(blocked.evidence.avoidableBuffering, JSON.stringify(blocked.evidence.bufferingFrames)).toBe(0);
        expect(blocked.state.requestedFrame - blocked.state.frame).toBeGreaterThan(1);
        // Keep withholding the genuine callback: no observed frame can satisfy the
        // required recovery seek. The existing bounded decoder deadline must report
        // the actual failure, never silently retain stale footage indefinitely.
        await waitForCompletion(page);
        const failed = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
        expect(failed.status).toBe('error'); expect(failed.playing).toBe(false);
        expect(failed.message).toContain('did not deliver the required frame within 5 seconds');
        expect(failed.decoderCount).toBe(2);
        await page.evaluate(() => window.playbackRecoveryGate.release!());
        await page.evaluate(() => window.pascapLab!.engine.seek(0));
        await assertPaused(page, 0, 0);
        await startPlayback(page); await waitForCompletion(page); await assertPaused(page, 89, 0);
        expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(fixture.document);
        expect(fixture.memory.saves).toBe(0);
        expect(await page.evaluate(() => window.playbackRecoveryGate.releasedCallbacks)).toBe(1);
    } finally {
        await page.evaluate(() => window.playbackRecoveryGate.release?.());
        await attachEvidence(page, browser, false, false);
    }
});

for (const withMusic of [false, true]) {
    test(`pause, seek and deliberate restart ${withMusic ? 'with music and a callback-gated cancellation' : 'video only'}`, async ({ page, request, browser }) => {
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
            expect(stopped.deliberatePauseMusicCalls).toBe(1);
            await assertPaused(page, stopped.frame, withMusic ? 1 : 0);

            if (withMusic) {
                // Deterministic real-browser cancellation: seek just one project/source
                // frame (39 -> 40), withholding its genuine callback until after pause.
                // Unlike a timed delay, the gate is asserted reached before cancellation.
                await page.evaluate(() => window.pascapLab!.engine.seek(39));
                await assertPaused(page, 39, 1);
                await page.evaluate(() => {
                    const gate = window.playbackRecoveryGate;
                    gate.targetFrame = 40;
                    gate.pendingSeek = window.pascapLab!.engine.seek(40);
                });
                await page.waitForFunction(() => window.playbackRecoveryGate.heldCallbacks === 1);
                const blocked = await page.evaluate(() => ({
                    state: window.pascapLab!.engine.diagnostics(),
                    heldFrame: window.playbackRecoveryGate.heldFrame,
                    released: window.playbackRecoveryGate.releasedCallbacks,
                }));
                expect(blocked.state.status).toBe('seeking');
                expect(blocked.state.playing).toBe(false);
                expect(blocked.state.frame).toBe(39);
                expect(blocked.heldFrame).toBe(40);
                expect(blocked.released).toBe(0);
                await page.evaluate(async () => {
                    const engine = window.pascapLab!.engine;
                    await engine.play(); // Busy seeking: must not implicitly start music.
                    engine.pause();
                    await window.playbackRecoveryGate.pendingSeek;
                    window.playbackRecoveryGate.release!();
                });
                await assertPaused(page, 39, 1);
                expect(await page.evaluate(() => window.playbackRecoveryGate.releasedCallbacks)).toBe(1);
            }

            await page.evaluate(() => window.pascapLab!.engine.seek(40));
            await assertPaused(page, 40, withMusic ? 1 : 0);
            await startPlayback(page);
            await waitForCompletion(page);
            await assertCompleted(page, fixture, withMusic, 2);
        } finally { await attachEvidence(page, browser, withMusic, false); }
    });
}