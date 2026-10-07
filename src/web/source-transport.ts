import type { VideoDecoderSlot } from '../preview/decoder.js';
import type { MediaSelection } from '../shared/media-selection.js';
import { secondsToFrames, type FrameRate } from '../shared/timing.js';

export interface SourceTransportState {
  status: 'buffering' | 'paused' | 'starting' | 'playing' | 'error';
  requestedFrame: number;
  frame: number | null;
  pendingPlay: boolean;
  error: string;
}

type Decoder = Pick<
  VideoDecoderSlot,
  'video' | 'decodedFrame' | 'ready' | 'load' | 'seek' | 'play' | 'pause' | 'dispose'
>;

/** An owned, muted proxy transport. Frame identity comes exclusively from the decoder's rVFC. */
export class SourceTransport {
  state: SourceTransportState;
  #operation = new AbortController();
  #epoch = 0;
  #disposed = false;
  #loaded = false;
  #pendingPlay = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #playTimer: ReturnType<typeof setTimeout> | undefined;
  #range: Readonly<MediaSelection>;

  constructor(
    readonly decoder: Decoder,
    readonly rate: FrameRate,
    readonly frameCount: number,
    range: Readonly<MediaSelection>,
    frame: number,
    readonly changed: (state: SourceTransportState) => void,
  ) {
    this.#range = { ...range };
    this.state = { status: 'buffering', requestedFrame: frame, frame: null, pendingPlay: false, error: '' };
    decoder.video.addEventListener('error', this.#mediaError);
    decoder.video.addEventListener('ended', this.#ended);
  }

  #publish(state: SourceTransportState): void {
    if (this.#disposed) return;
    this.state = { ...state, pendingPlay: this.#pendingPlay };
    this.changed(this.state);
  }

  #cancel(): number {
    this.#operation.abort();
    this.#operation = new AbortController();
    clearTimeout(this.#timer);
    this.decoder.pause();
    return ++this.#epoch;
  }

  #current(epoch: number): boolean {
    return !this.#disposed && epoch === this.#epoch;
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

  #deadline(epoch: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#current(epoch)) this.#fail(new Error('Source playback did not deliver a frame within 5 seconds.'));
    }, 5_000);
  }

  async load(url: string): Promise<void> {
    const epoch = this.#epoch;
    try {
      await this.decoder.load(url, this.rate, this.#operation.signal);
      if (!this.#current(epoch)) return;
      this.#loaded = true;
      this.seek(this.state.requestedFrame);
    } catch (cause) {
      if (this.#current(epoch)) this.#fail(cause);
    }
  }

  /** Prop feedback from observed playback is not another seek. Explicit scrubs pause first. */
  follow(frame: number): void {
    if (this.#disposed || frame === this.state.frame || frame === this.state.requestedFrame) return;
    this.seek(frame);
  }

  #exact(frame: number): Promise<void> {
    if (
      this.decoder.decodedFrame === frame &&
      secondsToFrames(this.decoder.video.currentTime, this.rate, 'floor') !== frame
    )
      this.decoder.decodedFrame = -1;
    return this.decoder.seek(frame, this.#operation.signal).then(() => {
      if (
        !this.decoder.ready ||
        this.decoder.decodedFrame !== frame ||
        secondsToFrames(this.decoder.video.currentTime, this.rate, 'floor') !== frame
      )
        throw new Error('Source decoder has not delivered the requested exact frame.');
    });
  }

  seek(frame: number): void {
    if (this.#disposed) return;
    frame = Math.max(0, Math.min(this.frameCount - 1, Math.round(frame)));
    // An in-flight load owns its controller until ready; retain the latest seek.
    if (!this.#loaded) {
      this.#publish({ ...this.state, requestedFrame: frame });
      return;
    }
    const epoch = this.#cancel();
    this.#publish({ ...this.state, status: 'buffering', requestedFrame: frame, frame: null, error: '' });
    void this.#exact(frame)
      .then(() => {
        if (this.#current(epoch)) this.#publish({ ...this.state, status: 'paused', frame });
      })
      .catch((cause: unknown) => {
        if (this.#current(epoch)) this.#fail(cause);
      });
  }

  pause(): void {
    if (this.#disposed || (this.state.status !== 'playing' && this.state.status !== 'starting')) return;
    const frame = this.decoder.ready ? this.decoder.decodedFrame : (this.state.frame ?? this.state.requestedFrame);
    this.#cancel();
    this.seek(frame);
  }

  setRange(range: Readonly<MediaSelection>): void {
    if (range.sourceIn === this.#range.sourceIn && range.sourceOut === this.#range.sourceOut) return;
    this.pause();
    this.#range = { ...range };
  }

  play(): void {
    if (
      this.#disposed ||
      !this.#loaded ||
      this.#pendingPlay ||
      this.state.status !== 'paused' ||
      this.state.frame === null
    )
      return;
    const last = this.#range.sourceOut - 1;
    const start =
      this.state.frame >= this.#range.sourceIn && this.state.frame < last ? this.state.frame : this.#range.sourceIn;
    const epoch = this.#cancel();
    this.#publish({
      ...this.state,
      status: 'starting',
      requestedFrame: start,
      frame: start === this.state.frame ? start : null,
      error: '',
    });
    this.#deadline(epoch);
    void (async () => {
      try {
        await this.#exact(start);
        if (!this.#current(epoch)) return;
        this.#publish({ ...this.state, frame: start });
        if (start === last) {
          this.seek(last);
          return;
        }
        this.#pendingPlay = true;
        this.#publish(this.state);
        // Native play cannot be aborted. Keep a bounded failure even if its
        // owning operation is cancelled while the native promise stays pending.
        this.#playTimer = setTimeout(() => {
          if (this.#pendingPlay) this.#fail(new Error('Source playback start did not finish within 5 seconds.'));
        }, 5_000);
        try {
          await this.decoder.play();
        } finally {
          clearTimeout(this.#playTimer);
          this.#pendingPlay = false;
        }
        if (!this.#current(epoch)) {
          // Native play is not abortable. Its obsolete completion must never restart this source.
          this.decoder.pause();
          this.#publish(this.state);
          return;
        }
        this.#publish({ ...this.state, status: 'playing' });
        this.#deadline(epoch);
      } catch (cause) {
        if (this.#current(epoch)) this.#fail(cause);
        else this.#publish(this.state);
      }
    })();
  }

  observed(): void {
    if (this.#disposed || !this.decoder.ready || !['starting', 'playing'].includes(this.state.status)) return;
    const frame = this.decoder.decodedFrame;
    if (frame >= this.#range.sourceOut - 1) {
      this.seek(this.#range.sourceOut - 1);
      return;
    }
    if (frame < this.#range.sourceIn) return;
    this.#publish({ ...this.state, frame, requestedFrame: frame });
    if (this.state.status === 'playing') this.#deadline(this.#epoch);
  }

  readonly #mediaError = (): void => {
    this.#fail(new Error(this.decoder.video.error?.message || 'Source proxy decoding failed.'));
  };

  readonly #ended = (): void => {
    if (this.state.status === 'playing' || this.state.status === 'starting') this.seek(this.#range.sourceOut - 1);
  };

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancel();
    clearTimeout(this.#playTimer);
    this.decoder.video.removeEventListener('error', this.#mediaError);
    this.decoder.video.removeEventListener('ended', this.#ended);
    this.decoder.dispose();
  }
}
