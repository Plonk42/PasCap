import { expect, test } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { memoryProjects } from './memory-projects.js';

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
    await page.addInitScript(() => {
        Reflect.set(globalThis, '__name', (fn: unknown) => fn);
        const evidence = { starts: 0, samples: [] as unknown[] };
        Reflect.set(window, 'musicClockEvidence', evidence);
        let context: AudioContext | null = null;
        const NativeContext = AudioContext;
        window.AudioContext = class extends NativeContext {
            constructor(options?: AudioContextOptions) { super(options); context = this; }
        };
        const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            ...currentTime,
            get(this: HTMLMediaElement) {
                const value = currentTime.get!.call(this) as number;
                if (this.dataset['pascapMusic'] && context && evidence.samples.length < 500) {
                    evidence.samples.push({ mediaTime: value, contextTime: context.currentTime, output: context.getOutputTimestamp?.(), paused: this.paused, seeking: this.seeking, ready: this.readyState });
                }
                return value;
            },
        });
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            if (this.dataset['pascapMusic']) evidence.starts++;
            return play.call(this);
        };
    });
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
        expect(await page.evaluate(() => Reflect.get(window, 'musicClockEvidence').starts)).toBe(1);
        expect(memory.saves).toBe(0);
    } finally {
        const evidence = await page.evaluate(() => ({ state: window.pascapLab!.engine.diagnostics(), ...Reflect.get(window, 'musicClockEvidence') }));
        await test.info().attach('music-clock', { body: JSON.stringify({ browser: browser.version(), ...evidence }, null, 2), contentType: 'application/json' });
    }
});