import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayback } from '../../src/preview/music.js';
import { musicGainAt, musicSourceFrame } from '../../src/shared/audio.js';
import { musicSchema, type MusicTrack } from '../../src/shared/model.js';
import { framesToSeconds, PROJECT_FPS, secondsToFrames } from '../../src/shared/timing.js';

// Exercise the real playback/source-map code. Only DOM and Web Audio boundaries
// are doubled; readiness is synchronous and no wall-clock timer advances media.
class AudioDouble extends EventTarget {
  src = '';
  preload = '';
  readonly dataset: Record<string, string> = {};
  readyState = 0;
  seeking = false;
  paused = true;
  ended = false;
  loop = false;
  error: MediaError | null = null;
  readonly seeks: number[] = [];
  #currentTime = 0;

  get currentTime(): number { return this.#currentTime; }
  set currentTime(seconds: number) {
    this.seeking = true;
    this.#currentTime = seconds; this.seeks.push(seconds);
    this.ended = false; this.readyState = 2; this.seeking = false;
    this.dispatchEvent(new Event('seeked')); this.dispatchEvent(new Event('canplay'));
  }
  // Playback progression is not a seek and must not call the currentTime setter.
  advanceSource(seconds: number): void {
    if (!this.paused && !this.ended) this.#currentTime += seconds;
  }
  play = vi.fn(async (): Promise<void> => { this.paused = false; });
  pause = vi.fn((): void => { this.paused = true; });
  load = vi.fn((): void => {
    this.#currentTime = 0; this.paused = true; this.seeking = false; this.ended = false;
    this.readyState = this.src ? 2 : 0;
    if (this.src) {
      this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('loadeddata'));
    }
  });
  removeAttribute = vi.fn((name: string): void => { if (name === 'src') this.src = ''; });
  remove = vi.fn((): void => {});
}

class AudioContextDouble {
  currentTime = 10;
  readonly destination = {};
  readonly gain = {
    gain: { setValueAtTime: vi.fn((_value: number, _time: number): void => {}) },
    connect: vi.fn((_destination: unknown): void => {}), disconnect: vi.fn((): void => {}),
  };
  readonly source = {
    connect: vi.fn((_gain: unknown): void => {}), disconnect: vi.fn((): void => {}),
  };
  constructor() { contexts.push(this); }
  resume = vi.fn(async (): Promise<void> => {});
  close = vi.fn(async (): Promise<void> => {});
  createGain = vi.fn(() => this.gain);
  createMediaElementSource = vi.fn((_element: AudioDouble) => this.source);
  createBuffer = vi.fn((): never => { throw new Error('Whole-file audio buffers are forbidden.'); });
  decodeAudioData = vi.fn((): never => { throw new Error('Whole-file audio decoding is forbidden.'); });
  createBufferSource = vi.fn((): never => { throw new Error('Buffer-backed playback is forbidden.'); });
}

const contexts: AudioContextDouble[] = [];
let audio: AudioDouble;
let playback: MusicPlayback;
const append = vi.fn((_element: AudioDouble): void => {});
const fetchAudio = vi.fn<typeof fetch>(() => { throw new Error('Playback must stream through its media element.'); });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function context(): AudioContextDouble {
  const value = contexts[0];
  if (!value) throw new Error('Web Audio context has not been created.');
  return value;
}
function advanceTogether(seconds: number): void {
  context().currentTime += seconds; audio.advanceSource(seconds);
}
function holdPlay(delaySeconds = 0): { requested: Promise<void>; resolve: () => void } {
  const requested = deferred(); const completed = deferred();
  audio.play.mockImplementationOnce(() => {
    audio.paused = false; requested.resolve(); return completed.promise;
  });
  return {
    requested: requested.promise,
    resolve: () => {
      // The selected media really advances before play() fulfills. A late promise
      // never undoes an intervening pause/load, even if its continuation is stale.
      advanceTogether(delaySeconds); completed.resolve();
    },
  };
}
function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return musicSchema.parse({
    mediaId: 'song', sourceIn: 10, sourceOut: 130, start: 0, duration: 120,
    gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false, ...overrides,
  });
}
async function configure(music: MusicTrack): Promise<void> {
  await playback.configure(music, new AbortController().signal);
}
function targetSeconds(music: MusicTrack, frame: number): number {
  const source = musicSourceFrame(music, frame);
  if (source === null) throw new Error('Expected a frame inside the selected music range.');
  return framesToSeconds(source);
}
async function start(music: MusicTrack, frame: number, delaySeconds = 0): Promise<number> {
  const target = targetSeconds(music, frame); const pending = holdPlay(delaySeconds);
  const started = playback.start(frame, new AbortController().signal);
  await pending.requested;
  expect(audio.currentTime).toBe(target);
  expect(audio.seeking).toBe(false); expect(audio.readyState).toBe(2);
  pending.resolve(); await started;
  return target;
}
function expectSteady(frame: number, elapsedSeconds: number): void {
  const expected = frame + secondsToFrames(elapsedSeconds, PROJECT_FPS, 'floor');
  const actual = playback.projectFrame();
  // Soft assertions expose both discarded startup position and its false drift.
  expect.soft(actual).toBe(expected);
  expect.soft(playback.sync(actual)).toBe(true);
  expect.soft(playback.errorFrames).toBeLessThanOrEqual(1);
}

beforeEach(() => {
  contexts.length = 0; audio = new AudioDouble(); append.mockClear(); fetchAudio.mockClear();
  vi.stubGlobal('document', {
    body: { append },
    createElement: vi.fn((name: string) => {
      if (name !== 'audio') throw new Error('Expected one streaming audio element.');
      return audio;
    }),
  });
  vi.stubGlobal('location', { href: 'http://127.0.0.1:4318/' });
  vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal('AudioContext', AudioContextDouble); vi.stubGlobal('fetch', fetchAudio);
  playback = new MusicPlayback();
});
afterEach(() => { playback.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('MusicPlayback startup phase and streaming clock', () => {
  it.each([0, 0.04, 0.1])('preserves source elapsed once when play resolves after %s seconds', async (delay) => {
    const music = track(); await configure(music);
    const target = await start(music, 20, delay);
    expect(target).toBe(framesToSeconds(30)); // source IN 10 + project offset 20
    expect(audio.currentTime).toBeCloseTo(target + delay, 12);
    expectSteady(20, delay);

    advanceTogether(0.075);
    expect(audio.currentTime).toBeCloseTo(target + delay + 0.075, 12);
    expectSteady(20, delay + 0.075); // floor the cumulative clock, not each increment
    expect(audio.seeks).toEqual([target]); expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('anchors project time, not source time, for a delayed start on a positioned track', async () => {
    const music = track({ start: 50 }); await configure(music);
    const target = await start(music, 70, 0.1);
    expect(target).toBe(framesToSeconds(30));
    expectSteady(70, 0.1);
    advanceTogether(0.04); expectSteady(70, 0.14);
    expect(audio.seeks).toEqual([target]);
  });

  it('keeps Web Audio authoritative after anchoring and still rejects actual drift above one frame', async () => {
    const music = track(); await configure(music); await start(music, 20);
    advanceTogether(framesToSeconds(1.25));
    expect(playback.projectFrame()).toBe(21); expect(playback.sync(21)).toBe(true);
    expect(playback.errorFrames).toBeCloseTo(0, 10);

    audio.advanceSource(framesToSeconds(2)); // media alone drifts; the context does not
    expect(playback.projectFrame()).toBe(21);
    expect(playback.sync(playback.projectFrame())).toBe(false);
    expect(playback.errorFrames).toBeCloseTo(2, 10);
    expect(audio.seeks).toHaveLength(1); expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('does not add video-frame quantisation to a genuine sub-frame audio drift', async () => {
    const music = track(); await configure(music); await start(music, 20);
    advanceTogether(framesToSeconds(1.75)); audio.advanceSource(framesToSeconds(0.5));
    expect(playback.projectFrame()).toBe(21);
    expect(playback.sync(21)).toBe(true);
    expect(playback.errorFrames).toBeCloseTo(0.5, 10);
    audio.advanceSource(framesToSeconds(0.6));
    expect(playback.sync(21)).toBe(false);
    expect(playback.errorFrames).toBeCloseTo(1.1, 10);
  });

  it('does not let an older play completion pause or replace a newer running clock', async () => {
    const music = track(); await configure(music);
    const pending = holdPlay(); const older = playback.start(8, new AbortController().signal).catch((error: unknown) => error);
    await pending.requested; playback.pause();
    await start(music, 40);
    const pauses = audio.pause.mock.calls.length;
    pending.resolve(); expect(await older).toMatchObject({ name: 'AbortError' });
    expect(playback.projectFrame()).toBe(40); expect(audio.paused).toBe(false);
    expect(audio.pause).toHaveBeenCalledTimes(pauses); expect(playback.sync(40)).toBe(true);
  });

  it('buffers at the selected loop boundary and reanchors inside that range, not the whole file', async () => {
    const music = track({ sourceOut: 40, start: 50, loop: true }); await configure(music);
    await start(music, 79);
    expect(musicSourceFrame(music, 79)).toBe(39);
    advanceTogether(framesToSeconds(2.25));
    expect(playback.projectFrame()).toBe(81);
    expect(musicSourceFrame(music, 81)).toBe(11);
    expect(playback.sync(81)).toBe(false); expect(playback.errorFrames).toBeGreaterThan(1);
    playback.pause(); await start(music, 81);
    expect(audio.currentTime).toBe(framesToSeconds(11));
    expect(playback.projectFrame()).toBe(81); expect(playback.sync(81)).toBe(true);
    expect(audio.seeks).toEqual([framesToSeconds(39), framesToSeconds(11)]);
    expect(audio.loop).toBe(false);
  });

  it.each([20, 170])('runs the project clock without playing audio outside music placement at frame %s', async (frame) => {
    const music = track({ start: 50 }); await configure(music);
    expect(musicSourceFrame(music, frame)).toBeNull();
    await playback.start(frame, new AbortController().signal);
    expect(playback.projectFrame()).toBe(frame); expect(playback.sync(frame)).toBe(true);
    advanceTogether(framesToSeconds(2.25));
    expect(playback.projectFrame()).toBe(frame + 2); expect(playback.sync(frame + 2)).toBe(true);
    expect(audio.currentTime).toBe(0); expect(audio.paused).toBe(true);
    expect(audio.seeks).toEqual([]); expect(audio.play).not.toHaveBeenCalled();
  });

  it.each(['pause', 'dispose', 'abort'] as const)('does not restart or replace the clock after %s during a late play promise', async (action) => {
    const music = track(); await configure(music); await start(music, 8); playback.pause();
    const previousFrame = playback.projectFrame(); expect(previousFrame).toBe(8);
    const controller = new AbortController(); const pending = holdPlay();
    // Attach rejection handling before cancelling; cancellation is never an
    // unhandled rejection, and pause/dispose may ignore or abort the stale start.
    const settled = playback.start(20, controller.signal).then(() => null, (error: unknown) => error);
    await pending.requested;
    if (action === 'abort') controller.abort();
    else playback[action]();
    pending.resolve(); const result = await settled;
    if (action === 'abort' || result !== null) expect(result).toMatchObject({ name: 'AbortError' });
    expect.soft(audio.paused).toBe(true);
    expect.soft(playback.projectFrame()).toBe(previousFrame);
    expect.soft(playback.sync(20)).toBe(true); // stopped playback cannot report new drift
    expect(audio.play).toHaveBeenCalledTimes(2);
    if (action === 'dispose') {
      expect(playback.hasMusic).toBe(false); expect(audio.remove).toHaveBeenCalledTimes(1);
      await playback.start(30, new AbortController().signal);
      expect(audio.play).toHaveBeenCalledTimes(2);
    }
  });

  it('reuses one streaming element/source/gain, applies real gain, and releases them without whole-file buffers', async () => {
    const music = track({ gainDb: -6, fadeIn: 10, fadeOut: 10 }); await configure(music);
    expect(audio.src).toBe('http://127.0.0.1:4318/api/audio/song/playback');
    expect(audio.preload).toBe('auto'); expect(audio.dataset['pascapMusic']).toBe('true');
    expect(append).toHaveBeenCalledExactlyOnceWith(audio);
    await start(music, 20); playback.pause(); await start(music, 115);
    expect(contexts).toHaveLength(1);
    const clock = context();
    expect(clock.createGain).toHaveBeenCalledTimes(1);
    expect(clock.createMediaElementSource).toHaveBeenCalledExactlyOnceWith(audio);
    expect(clock.source.connect).toHaveBeenCalledExactlyOnceWith(clock.gain);
    expect(clock.gain.connect).toHaveBeenCalledExactlyOnceWith(clock.destination);
    expect(clock.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(musicGainAt(music, 115), clock.currentTime);
    expect(clock.createBuffer).not.toHaveBeenCalled(); expect(clock.decodeAudioData).not.toHaveBeenCalled();
    expect(clock.createBufferSource).not.toHaveBeenCalled(); expect(fetchAudio).not.toHaveBeenCalled();
    await playback.configure(null, new AbortController().signal);
    expect(playback.hasMusic).toBe(false); expect(audio.src).toBe(''); expect(audio.readyState).toBe(0);
    playback.dispose();
    expect(audio.paused).toBe(true); expect(audio.remove).toHaveBeenCalledTimes(1);
    expect(clock.source.disconnect).toHaveBeenCalledTimes(1); expect(clock.gain.disconnect).toHaveBeenCalledTimes(1);
    expect(clock.close).toHaveBeenCalledTimes(1);
  });
});