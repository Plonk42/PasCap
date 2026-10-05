import { expect, test } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { memoryProjects } from './memory-projects.js';
import { installMusicEvidence } from './music-evidence.js';

for (const startFrame of [0, 40]) test(`streaming music clock at frame ${startFrame} completes without repeated audio restarts`, async ({ page, request, browser }) => {
    const videos = (await (await request.get('/api/media')).json() as { assets: MediaAsset[] }).assets;
    const audio = (await (await request.get('/api/audio')).json() as { assets: AudioAsset[] }).assets;
    const video = videos.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready')!;
    const song = audio.find((item) => item.name === 'test-music.wav' && item.status === 'ready')!;
    expect(video).toBeDefined(); expect(song).toBeDefined();
    const project = createProject('music-clock', 'Synthetic music clock');
    project.clips = [createClip('clock-clip', video.id, 0, 90)];
    project.media = { videoIds: [video.id], audioIds: [song.id] };
    project.music = { mediaId: song.id, sourceIn: 0, sourceOut: 120, start: 0, duration: 90, gainDb: -12, fadeIn: 0, fadeOut: 0, loop: false };
    const memory = await memoryProjects(page, project);
    await installMusicEvidence(page);
    await page.goto(`/?project=${project.id}`);
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
    if (startFrame) await page.evaluate((frame) => window.pascapLab!.engine.seek(frame), startFrame);
    await page.getByRole('button', { name: 'Play preview', exact: true }).click();
    try {
        await page.waitForFunction(() => {
            const state = window.pascapLab!.engine.diagnostics();
            return state.status === 'error' || (!state.playing && state.status === 'paused' && state.frame === 89);
        });
        const state = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
        expect(state.status, state.message).toBe('paused');
        expect(state.frame).toBe(89);
        const music = await page.evaluate(() => {
            const evidence = window.musicStreamEvidence;
            return { starts: evidence.starts, underruns: evidence.underruns, ranges: evidence.ranges, largestRange: evidence.largestRange };
        });
        expect(music.starts).toBe(1); expect(music.underruns).toBe(0);
        expect(music.ranges).toBeGreaterThan(4); expect(music.largestRange).toBeLessThanOrEqual(65_536);
        expect(memory.saves).toBe(0);
    } finally {
        const evidence = await page.evaluate(() => {
            const { context: _context, analyser: _analyser, signal: _signal, ...music } = window.musicStreamEvidence;
            return { state: window.pascapLab!.engine.diagnostics(), ...music };
        });
        await test.info().attach('music-clock', { body: JSON.stringify({ browser: browser.version(), ...evidence }, null, 2), contentType: 'application/json' });
    }
});

test('streamed PCM reaches the output with placement silence, real gain, selected-range loops and a clean pause', async ({ page, request, browser }) => {
    const videos = (await (await request.get('/api/media')).json() as { assets: MediaAsset[] }).assets;
    const audio = (await (await request.get('/api/audio')).json() as { assets: AudioAsset[] }).assets;
    const video = videos.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready')!;
    const song = audio.find((item) => item.name === 'test-music.wav' && item.status === 'ready')!;
    const project = createProject('music-signal', 'Synthetic PCM signal');
    project.clips = [createClip('signal-clip', video.id, 0, 90)];
    project.media = { videoIds: [video.id], audioIds: [song.id] };
    project.music = { mediaId: song.id, sourceIn: 10, sourceOut: 25, start: 10, duration: 60, gainDb: -6, fadeIn: 6, fadeOut: 6, loop: true };
    const memory = await memoryProjects(page, project); await installMusicEvidence(page);
    await page.goto(`/?project=${project.id}`);
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
    await page.evaluate(() => {
        const signal: { frame: number; peak: number }[] = [];
        Reflect.set(window, 'musicSignalEvidence', signal);
        const sample = (): void => {
            const state = window.pascapLab!.engine.diagnostics();
            const music = window.musicStreamEvidence;
            if (state.status === 'playing' && state.playing && music.analyser) {
                music.analyser.getFloatTimeDomainData(music.signal);
                signal.push({ frame: state.frame, peak: Math.max(...music.signal.map(Math.abs)) });
            }
            if (state.frame < 89 && state.status !== 'error') requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
    await page.getByRole('button', { name: 'Play preview', exact: true }).click();
    await page.waitForFunction(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return state.status === 'error' || (!state.playing && state.frame === 89);
    });
    const evidence = await page.evaluate(() => {
        const { context: _context, analyser: _analyser, signal: _signal, ...stream } = window.musicStreamEvidence;
        return { state: window.pascapLab!.engine.diagnostics(), stream, signal: Reflect.get(window, 'musicSignalEvidence') as { frame: number; peak: number }[] };
    });
    await test.info().attach('music-pcm-signal', { body: JSON.stringify({ browser: browser.version(), ...evidence }, null, 2), contentType: 'application/json' });
    expect(evidence.state.status, evidence.state.message).toBe('paused');
    expect(evidence.stream.starts).toBe(1); expect(evidence.stream.underruns).toBe(0); expect(evidence.stream.active).toBe(false);
    const before = evidence.signal.filter(sample => sample.frame >= 2 && sample.frame <= 4);
    const tone = evidence.signal.filter(sample => sample.frame >= 20 && sample.frame <= 55);
    const after = evidence.signal.filter(sample => sample.frame >= 78 && sample.frame <= 82);
    expect(before.length).toBeGreaterThan(0); expect(tone.length).toBeGreaterThan(0); expect(after.length).toBeGreaterThan(0);
    expect(before.every(sample => sample.peak === 0)).toBe(true); expect(after.every(sample => sample.peak === 0)).toBe(true);
    // Lavfi tone has amplitude 1/8; the -6 dB gain is linear and there is no normalization.
    const expectedPeak = 0.125 * 10 ** (-6 / 20);
    expect(tone.every(sample => Math.abs(sample.peak - expectedPeak) < 0.002)).toBe(true);
    expect(evidence.stream.ranges).toBeGreaterThan(8); expect(evidence.stream.largestRange).toBeLessThanOrEqual(65_536);
    await page.evaluate(() => window.pascapLab!.flush()); expect(memory.saves).toBe(0);
    expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(project);
});
