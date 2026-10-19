import type { VideoStreams } from '../preview/video-streams.js';
import { PROXY_GOP_FRAMES } from '../shared/media.js';
import type { MediaSelection } from '../shared/media-selection.js';
import { secondsToFrames, type FrameRate } from '../shared/timing.js';

export interface SourceTransportState {
  status: 'buffering' | 'paused' | 'starting' | 'playing' | 'error';
  requestedFrame: number;
  frame: number | null;
  error: string;
}

type Frames = Pick<VideoStreams, 'start' | 'stop' | 'take' | 'ready' | 'dispose'>;

const PLAYBACK_DEADLINE_MS = 5_000;
const PREFILL_FRAMES = 3;

/**
 * An owned, video-only proxy transport on one WebCodecs decoder. Every displayed
 * image is the exact decoded source frame it reports; playback follows the
 * wall clock and holds it while a frame is not decoded yet. Seeks never cancel
 * the frame being decoded: it is shown, then the latest seek, so images always
 * follow request order and a fast scrub keeps updating.
 */
export class SourceTransport {
  state: SourceTransportState;
  #operation = new AbortController();
  #disposed = false;
  #url: string | null = null;
  #range: Readonly<MediaSelection>;
  #raf = 0;
  #last = 0;
  #clockFrame = 0;
  #clockTime = 0;
  #clockHeld = false;
  #delivered = 0;
  #decoding = false;
  #pending: number | null = null;
  /** A seek arrived while another frame was decoding: the scrub outpaces the decoder. */
  #chasing = false;

  constructor(
    readonly frames: Frames,
    readonly draw: (frame: VideoFrame) => void,
    readonly rate: FrameRate,
    readonly frameCount: number,
    range: Readonly<MediaSelection>,
    frame: number,
    readonly changed: (state: SourceTransportState) => void,
  ) {
    this.#range = { ...range };
    this.state = { status: 'buffering', requestedFrame: frame, frame: null, error: '' };
  }

  #publish(state: SourceTransportState): void {
    if (this.#disposed) return;
    this.state = state;
    this.changed(state);
  }

  #cancel(): AbortSignal {
    this.#operation.abort();
    this.#operation = new AbortController();
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#decoding = false;
    this.#pending = null;
    this.#chasing = false;
    this.frames.stop(0);
    return this.#operation.signal;
  }

  #fail(cause: unknown): void {
    if (this.#disposed) return;
    this.#cancel();
    this.#publish({
      ...this.state,
      status: 'error',
      frame: null,
      error: cause instanceof Error ? cause.message : 'Cannot play this source proxy.',
    });
  }

  #present(frame: number): boolean {
    const decoded = this.frames.take(0, frame);
    if (!decoded) return false;
    try {
      this.draw(decoded);
    } finally {
      decoded.close();
    }
    return true;
  }

  load(url: string): void {
    this.#url = url;
    this.seek(this.state.requestedFrame);
  }

  /** Prop feedback from observed playback is not another seek. Explicit scrubs pause first. */
  follow(frame: number): void {
    if (this.#disposed || frame === this.state.requestedFrame) return;
    if (frame === this.state.frame && this.state.status !== 'buffering') return;
    this.seek(frame);
  }

  seek(frame: number): void {
    if (this.#disposed) return;
    frame = Math.max(0, Math.min(this.frameCount - 1, Math.round(frame)));
    if (this.#url === null) {
      this.#publish({ ...this.state, requestedFrame: frame });
      return;
    }
    if (this.#decoding) this.#chasing = true;
    else this.#cancel();
    this.#pending = frame;
    const shown = this.state.status === 'error' ? null : this.state.frame;
    this.#publish({ status: 'buffering', requestedFrame: frame, frame: shown, error: '' });
    if (!this.#decoding) this.#decodeNext();
  }

  /** While chasing, a target in another GOP shows its keyframe first: one decode instead of up to 15. */
  #decodeNext(): void {
    const url = this.#url;
    const target = this.#pending;
    if (url === null || target === null) return;
    const shown = this.state.frame;
    if (target === shown) {
      this.#pending = null;
      this.#chasing = false;
      this.#publish({ ...this.state, status: 'paused' });
      return;
    }
    const keyframe = target - (target % PROXY_GOP_FRAMES);
    const approximate = this.#chasing && keyframe !== target && (shown === null || shown < keyframe || shown > target);
    const frame = approximate ? keyframe : target;
    if (!approximate) this.#pending = null;
    this.#chasing = false;
    this.#decoding = true;
    const signal = this.#operation.signal;
    this.frames.start(0, url, [frame], true, false);
    void this.frames
      .ready(0, frame, 1, signal)
      .then(() => {
        if (signal.aborted || !this.#present(frame)) return;
        this.frames.stop(0);
        this.#decoding = false;
        const settled = this.#pending === null;
        this.#publish({ ...this.state, status: settled ? 'paused' : 'buffering', frame });
        this.#decodeNext();
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) this.#fail(cause);
      });
  }

  /** Pause on the displayed frame: playback always starts from, and keeps, a displayed frame. */
  pause(): void {
    const { status, frame } = this.state;
    if (this.#disposed || frame === null || (status !== 'playing' && status !== 'starting')) return;
    this.#cancel();
    this.#publish({ ...this.state, status: 'paused', requestedFrame: frame });
  }

  setRange(range: Readonly<MediaSelection>): void {
    if (range.sourceIn === this.#range.sourceIn && range.sourceOut === this.#range.sourceOut) return;
    this.pause();
    this.#range = { ...range };
  }

  /** Play the applied range from the displayed frame (else IN) and stop on OUT − 1, never looping. */
  play(): void {
    const url = this.#url;
    if (this.#disposed || url === null || this.state.status !== 'paused' || this.state.frame === null) return;
    const last = this.#range.sourceOut - 1;
    const shown = this.state.frame;
    const start = shown >= this.#range.sourceIn && shown < last ? shown : this.#range.sourceIn;
    if (start === last) {
      if (shown !== last) this.seek(last);
      return;
    }
    const signal = this.#cancel();
    this.#last = last;
    // The shown image stays on the canvas until the start frame replaces it.
    this.#publish({ status: 'starting', requestedFrame: start, frame: shown, error: '' });
    const first = start === shown ? start + 1 : start;
    const frames = Array.from({ length: last - first + 1 }, (_value, index) => first + index);
    this.frames.start(0, url, frames, true, false);
    void this.frames
      .ready(0, first, Math.min(PREFILL_FRAMES, frames.length), signal)
      .then(() => {
        if (signal.aborted) return;
        this.#clockFrame = start;
        this.#clockTime = performance.now();
        this.#clockHeld = false;
        this.#delivered = this.#clockTime;
        this.#publish({ ...this.state, status: 'playing' });
        this.#raf = requestAnimationFrame(this.#tick);
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) this.#fail(cause);
      });
  }

  readonly #tick = (now: number): void => {
    if (this.#disposed || this.state.status !== 'playing') return;
    this.#raf = requestAnimationFrame(this.#tick);
    try {
      const elapsed = Math.max(0, now - this.#clockTime) / 1000;
      const frame = this.#clockHeld
        ? this.#clockFrame
        : Math.min(this.#last, this.#clockFrame + secondsToFrames(elapsed, this.rate, 'floor'));
      if (frame !== this.state.frame) {
        if (!this.#present(frame)) {
          // The clock stops at a frame the decoder has not delivered yet.
          this.#clockFrame = frame;
          this.#clockHeld = true;
          if (now - this.#delivered > PLAYBACK_DEADLINE_MS)
            throw new Error('Source playback did not deliver a frame within 5 seconds.');
          return;
        }
        if (this.#clockHeld) {
          this.#clockTime = now;
          this.#clockHeld = false;
        }
        this.#delivered = now;
        this.#publish({ ...this.state, frame, requestedFrame: frame });
      }
      if (frame === this.#last) {
        this.#cancel();
        this.#publish({ ...this.state, status: 'paused' });
      }
    } catch (cause) {
      this.#fail(cause);
    }
  };

  dispose(): void {
    if (this.#disposed) return;
    this.#cancel();
    this.#disposed = true;
    this.frames.dispose();
  }
}
