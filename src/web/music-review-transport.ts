import type { MusicPlayback } from '../preview/music.js';
import type { MusicTrack } from '../shared/model.js';

export interface MusicReviewState {
  status: 'paused' | 'starting' | 'playing' | 'error';
  /** The play position in source frames of the recording. */
  frame: number;
  error: string;
}

type Output = Pick<MusicPlayback, 'configure' | 'start' | 'projectFrame' | 'sync' | 'pause' | 'dispose'>;

function aborted(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

/**
 * Plays one prepared music recording through its own music output, never the timeline's: the
 * played range is a single source at its own source frames, so the output clock is the position.
 */
export class MusicReviewTransport {
  state: MusicReviewState;
  #operation = new AbortController();
  #raf = 0;
  #first = 0;
  #last = 0;
  #disposed = false;

  constructor(
    readonly output: Output,
    readonly mediaId: string,
    readonly frameCount: number,
    frame: number,
    readonly changed: (state: MusicReviewState) => void,
  ) {
    this.state = { status: 'paused', frame: this.#clamp(frame), error: '' };
  }

  #clamp(frame: number): number {
    return Math.max(0, Math.min(this.frameCount - 1, Math.round(frame)));
  }

  #publish(state: MusicReviewState): void {
    if (this.#disposed) return;
    this.state = state;
    this.changed(state);
  }

  /** Stops the output and returns where it was: the clock while it played, else the shown frame. */
  #stop(): number {
    const playing = this.state.status === 'playing';
    this.#operation.abort();
    this.#operation = new AbortController();
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.output.pause();
    if (!playing) return this.state.frame;
    try {
      return Math.min(this.#last - 1, this.#clamp(this.output.projectFrame()));
    } catch {
      return this.state.frame;
    }
  }

  seek(frame: number): void {
    if (this.#disposed) return;
    this.#stop();
    this.#publish({ status: 'paused', frame: this.#clamp(frame), error: '' });
  }

  pause(): void {
    if (this.#disposed || (this.state.status !== 'playing' && this.state.status !== 'starting')) return;
    this.#publish({ status: 'paused', frame: this.#stop(), error: '' });
  }

  /** Play source frames `first` to `last` (exclusive) from the shown frame, else from `first`; never looping. */
  play(first: number, last: number): void {
    if (this.#disposed || this.state.status === 'playing' || this.state.status === 'starting') return;
    const shown = this.state.frame;
    const start = shown >= first && shown < last - 1 ? shown : first;
    this.#start(first, last, start);
  }

  #start(first: number, last: number, frame: number): void {
    this.#stop();
    const signal = this.#operation.signal;
    this.#first = first;
    this.#last = last;
    this.#publish({ status: 'starting', frame, error: '' });
    // Only the played range is a source, so the music ends in silence at OUT even before the next tick.
    const track: MusicTrack = {
      id: 'music-review',
      mediaId: this.mediaId,
      sourceIn: first,
      sourceOut: last,
      start: first,
      duration: last - first,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    };
    void (async () => {
      try {
        await this.output.configure([track], signal);
        if (signal.aborted) return;
        await this.output.start(frame, signal);
        if (signal.aborted) return;
        this.#publish({ status: 'playing', frame, error: '' });
        this.#raf = requestAnimationFrame(this.#tick);
      } catch (cause) {
        if (!signal.aborted && !aborted(cause)) this.#fail(cause);
      }
    })();
  }

  readonly #tick = (): void => {
    if (this.#disposed || this.state.status !== 'playing') return;
    try {
      const position = this.output.projectFrame();
      if (position >= this.#last) {
        this.#stop();
        this.#publish({ status: 'paused', frame: this.#last - 1, error: '' });
        return;
      }
      const frame = this.#clamp(position);
      // An underrun stops the output: start again where its clock is.
      if (!this.output.sync()) {
        this.#start(this.#first, this.#last, frame);
        return;
      }
      if (frame !== this.state.frame) this.#publish({ ...this.state, frame });
      this.#raf = requestAnimationFrame(this.#tick);
    } catch (cause) {
      this.#fail(cause);
    }
  };

  #fail(cause: unknown): void {
    const frame = this.state.frame;
    this.#stop();
    this.#publish({
      status: 'error',
      frame,
      error: cause instanceof Error ? cause.message : 'Cannot play this music recording.',
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#stop();
    this.#disposed = true;
    this.output.dispose();
  }
}
