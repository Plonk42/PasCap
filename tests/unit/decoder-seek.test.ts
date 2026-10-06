import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoDecoderSlot } from '../../src/preview/decoder.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

// Native element boundary only: seeks complete and frames are presented when a
// test says so, as in Firefox where a paused redraw's rVFC can be skipped.
class NativeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  preload = '';
  disablePictureInPicture = false;
  readonly dataset: Record<string, string> = {};
  readonly style = { cssText: '' };
  src = '';
  error = null;
  readyState = 0;
  seeking = false;
  paused = true;
  playbackRate = 1;
  readonly seeks: number[] = [];
  #time = 0;
  #presented = 0;
  #nextCallback = 0;
  readonly #callbacks = new Map<number, VideoFrameRequestCallback>();
  get currentTime(): number {
    return this.#time;
  }
  set currentTime(seconds: number) {
    this.#time = seconds;
    this.seeks.push(seconds);
    this.seeking = true;
  }
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    this.#callbacks.set(++this.#nextCallback, callback);
    return this.#nextCallback;
  }
  cancelVideoFrameCallback(id: number): void {
    this.#callbacks.delete(id);
  }
  present(frame: number): void {
    this.readyState = 4;
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    const metadata = {
      mediaTime: framesToSeconds(frame),
      presentedFrames: ++this.#presented,
    } as VideoFrameCallbackMetadata;
    for (const callback of callbacks) callback(0, metadata);
  }
  completeSeek(frame: number | null): void {
    this.seeking = false;
    if (frame !== null) this.present(frame);
    this.dispatchEvent(new Event('seeked'));
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  load(): void {
    this.readyState = 0;
  }
  remove(): void {}
  async play(): Promise<void> {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  getVideoPlaybackQuality(): { droppedVideoFrames: number } {
    return { droppedVideoFrames: 0 };
  }
}

let video: NativeVideo;
let nextAnimationFrame = 0;
const animationFrames = new Map<number, FrameRequestCallback>();
const target = (frame: number): number => framesToSeconds(frame + 0.25);
function renderingUpdate(): void {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of callbacks) callback(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  video = new NativeVideo();
  animationFrames.clear();
  vi.stubGlobal('document', { createElement: () => video });
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrames.set(++nextAnimationFrame, callback);
    return nextAnimationFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    animationFrames.delete(id);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function playedSlot(): Promise<VideoDecoderSlot> {
  const slot = new VideoDecoderSlot({ append: vi.fn() } as unknown as HTMLElement, 0);
  const loading = slot.load('/proxy', PROJECT_FPS, new AbortController().signal);
  video.present(0);
  await loading;
  await slot.play();
  video.present(1);
  expect(slot.decodedFrame).toBe(1);
  return slot;
}

describe('paused seek presentation', () => {
  it('re-presents the same frame once when a completed seek after playback renders without its callback', async () => {
    const slot = await playedSlot();
    const seeking = slot.seek(2, new AbortController().signal);
    expect(video.paused).toBe(true);
    video.completeSeek(null);
    renderingUpdate();
    expect(video.seeks).toEqual([target(2)]);
    renderingUpdate();
    expect(video.seeks).toEqual([target(2), target(2)]);
    video.completeSeek(2);
    await seeking;
    expect(slot.decodedFrame).toBe(2);
    renderingUpdate();
    renderingUpdate();
    expect(video.seeks).toHaveLength(2);
  });

  it('accepts a callback delivered within the rendering updates without another seek', async () => {
    const slot = await playedSlot();
    const seeking = slot.seek(3, new AbortController().signal);
    video.completeSeek(null);
    renderingUpdate();
    video.present(3);
    await seeking;
    renderingUpdate();
    renderingUpdate();
    expect(slot.decodedFrame).toBe(3);
    expect(video.seeks).toEqual([target(3)]);
  });

  it('keeps a genuinely withheld callback an explicit deadline failure after one re-presentation', async () => {
    const slot = await playedSlot();
    const seeking = slot.seek(2, new AbortController().signal);
    const failure = expect(seeking).rejects.toThrow('Decoder 1 did not deliver the required frame within 5 seconds.');
    video.completeSeek(null);
    renderingUpdate();
    renderingUpdate();
    video.completeSeek(null);
    renderingUpdate();
    renderingUpdate();
    renderingUpdate();
    expect(video.seeks).toEqual([target(2), target(2)]);
    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
    expect(slot.decodedFrame).toBe(1);
  });

  it('does not re-present while the requested seek is still in progress', async () => {
    const slot = await playedSlot();
    const seeking = slot.seek(2, new AbortController().signal);
    video.dispatchEvent(new Event('seeked'));
    renderingUpdate();
    renderingUpdate();
    expect(video.seeks).toEqual([target(2)]);
    video.completeSeek(2);
    await seeking;
    expect(slot.decodedFrame).toBe(2);
  });

  it('does not repeat paused seeks without intervening playback', async () => {
    const slot = await playedSlot();
    const first = slot.seek(2, new AbortController().signal);
    video.completeSeek(2);
    await first;
    const second = slot.seek(4, new AbortController().signal);
    const failure = expect(second).rejects.toThrow('within 5 seconds');
    video.completeSeek(null);
    renderingUpdate();
    renderingUpdate();
    expect(video.seeks).toEqual([target(2), target(4)]);
    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
  });

  it('cancels the pending re-presentation with the seek', async () => {
    const slot = await playedSlot();
    const controller = new AbortController();
    const seeking = slot.seek(2, controller.signal);
    video.completeSeek(null);
    renderingUpdate();
    controller.abort();
    await expect(seeking).rejects.toMatchObject({ name: 'AbortError' });
    renderingUpdate();
    renderingUpdate();
    expect(video.seeks).toEqual([target(2)]);
  });
});
