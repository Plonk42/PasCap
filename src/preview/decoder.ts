import { framesToSeconds, PROJECT_FPS, secondsToFrames, type FrameRate } from '../shared/timing.js';

function abortError(): DOMException {
  return new DOMException('Obsolete media operation cancelled.', 'AbortError');
}

/** A reusable HTML video decoder, with observed frame identity rather than currentTime guesses. */
export class VideoDecoderSlot {
  readonly video: HTMLVideoElement;
  #url = '';
  #rate: FrameRate = PROJECT_FPS;
  #callbackId = 0;
  #disposed = false;
  readonly #listeners = new Set<() => void>();
  #presented = 0;
  #played = false;
  decodedFrame = -1;
  observedFrames = 0;
  lateCallbacks = 0;
  constructor(
    container: HTMLElement,
    readonly index: number,
    readonly onFrame?: () => void,
  ) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.dataset['pascapDecoder'] = String(index);
    // A tiny attached element keeps requestVideoFrameCallback active on Chrome.
    video.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
    container.append(video);
    this.video = video;
    if (!video.requestVideoFrameCallback)
      throw new Error('requestVideoFrameCallback is required. Use a current Chromium or Firefox browser.');
    this.#observe();
  }
  get ready(): boolean {
    return !this.video.seeking && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.decodedFrame >= 0;
  }
  get droppedFrames(): number {
    return this.video.getVideoPlaybackQuality().droppedVideoFrames;
  }
  get aspect(): number {
    return this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 16 / 9;
  }
  #observe(): void {
    this.#callbackId = this.video.requestVideoFrameCallback((_now, metadata) => {
      if (this.#disposed) return;
      if (this.#presented && metadata.presentedFrames > this.#presented + 1)
        this.lateCallbacks += metadata.presentedFrames - this.#presented - 1;
      this.#presented = metadata.presentedFrames;
      this.decodedFrame = secondsToFrames(metadata.mediaTime, this.#rate);
      this.observedFrames++;
      for (const listener of this.#listeners) listener();
      this.#observe();
      this.onFrame?.();
    });
  }
  async load(url: string, rate: FrameRate, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    this.#rate = rate;
    if (this.#url === url && !this.video.error && this.ready) return;
    this.pause();
    this.#url = url;
    this.decodedFrame = -1;
    this.#presented = 0;
    this.#played = false;
    this.video.cancelVideoFrameCallback(this.#callbackId);
    this.video.src = url;
    this.video.load();
    this.#observe();
    // Wait after resetting the resource: metadata from the previous recording
    // must never satisfy a load when the decoder is reused for a third clip.
    await this.#wait(
      () => this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.decodedFrame >= 0,
      signal,
    );
  }
  async seek(frame: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    this.pause();
    if (this.decodedFrame === frame && this.ready) return;
    // Seek inside the requested frame rather than onto a floating-point boundary.
    const seek = (): void => {
      this.video.currentTime = framesToSeconds(frame + 0.25, this.#rate);
    };
    // Gecko numbers paused redraws apart from played frames. If the IDs collide,
    // rVFC skips the new image as unchanged; one more seek presents a fresh ID.
    const ready = this.#wait(() => this.ready && this.decodedFrame === frame, signal, this.#played ? seek : undefined);
    seek();
    await ready;
    this.#played = false;
  }
  #wait(predicate: () => boolean, signal: AbortSignal, reseek?: () => void): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const events = ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'error'];
      let animationFrame = 0;
      const cleanup = (): void => {
        clearTimeout(timer);
        cancelAnimationFrame(animationFrame);
        this.#listeners.delete(check);
        signal.removeEventListener('abort', aborted);
        for (const event of events) this.video.removeEventListener(event, check);
        this.video.removeEventListener('seeked', seeked);
      };
      const check = (): void => {
        if (this.video.error) {
          cleanup();
          reject(new Error(`Decoder ${this.index + 1}: ${this.video.error.message || 'media decoding failed'}`));
        } else if (predicate()) {
          cleanup();
          resolve();
        }
      };
      // Each rendering update runs video frame callbacks before animation frames:
      // two updates after 'seeked' without the callback mean it was skipped.
      const missed = (): void => {
        if (this.video.seeking || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || predicate()) return;
        this.video.removeEventListener('seeked', seeked);
        reseek?.();
      };
      const seeked = (): void => {
        cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(() => {
          animationFrame = requestAnimationFrame(missed);
        });
      };
      const aborted = (): void => {
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Decoder ${this.index + 1} did not deliver the required frame within 5 seconds.`));
      }, 5_000);
      for (const event of events) this.video.addEventListener(event, check);
      if (reseek) this.video.addEventListener('seeked', seeked);
      this.#listeners.add(check);
      signal.addEventListener('abort', aborted, { once: true });
      check();
    });
  }
  async play(): Promise<void> {
    if (this.#disposed) return;
    this.#played = true;
    await this.video.play();
  }
  setRate(rate: number): void {
    this.video.playbackRate = Math.max(0.1, Math.min(8, rate));
  }
  pause(): void {
    this.video.pause();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.pause();
    this.video.cancelVideoFrameCallback(this.#callbackId);
    this.#listeners.clear();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}
