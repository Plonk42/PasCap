import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicTrack } from '../../src/shared/model.js';
import { MusicReviewTransport, type MusicReviewState } from '../../src/web/music-review-transport.js';

/** A music output whose clock the test moves; start resolves when the test says so (or at once). */
class Output {
  clock = 0;
  running = false;
  synced = true;
  autoStart = true;
  failure: Error | null = null;
  tracks: MusicTrack[] = [];
  starts: number[] = [];
  disposed = false;
  #pending: { resolve: () => void; reject: (error: unknown) => void; frame: number } | null = null;
  configure = vi.fn(async (tracks: readonly MusicTrack[], _signal: AbortSignal): Promise<void> => {
    this.tracks = [...tracks];
  });
  start = vi.fn(
    (frame: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        this.starts.push(frame);
        if (this.failure) return reject(this.failure);
        const begin = (): void => {
          this.clock = frame;
          this.running = true;
          resolve();
        };
        signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
        if (this.autoStart) begin();
        else this.#pending = { resolve: begin, reject, frame };
      }),
  );
  release(): void {
    this.#pending?.resolve();
    this.#pending = null;
  }
  projectFrame = vi.fn((): number => Math.floor(this.clock));
  sync = vi.fn((): boolean => this.synced);
  pause = vi.fn((): void => {
    this.running = false;
  });
  dispose = vi.fn((): void => {
    this.disposed = true;
  });
}

const raf = new Map<number, FrameRequestCallback>();
let nextRaf = 0;
beforeEach(() => {
  raf.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    raf.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => raf.delete(id));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function tick(): void {
  const pending = [...raf.values()];
  raf.clear();
  pending.forEach((callback) => callback(0));
}

function fixture(frame = 20, count = 300) {
  const output = new Output();
  const states: MusicReviewState[] = [];
  const transport = new MusicReviewTransport(output, 'song', count, frame, (state) => states.push(state));
  return { output, states, transport };
}

describe('music review transport', () => {
  it('plays only the requested range of the recording, from the shown frame', async () => {
    const { output, transport } = fixture(20);
    transport.play(10, 40);
    expect(transport.state.status).toBe('starting');
    await settle();
    expect(output.tracks).toEqual([
      {
        id: 'music-review',
        mediaId: 'song',
        sourceIn: 10,
        sourceOut: 40,
        start: 10,
        duration: 30,
        gainDb: 0,
        fadeIn: 0,
        fadeOut: 0,
        loop: false,
      },
    ]);
    expect(output.starts).toEqual([20]);
    expect(transport.state).toEqual({ status: 'playing', frame: 20, error: '' });
    output.clock = 27.5;
    tick();
    expect(transport.state.frame).toBe(27);
  });

  it('starts at IN when the shown frame is outside the range or on its last frame', async () => {
    const outside = fixture(5);
    outside.transport.play(10, 40);
    await settle();
    expect(outside.output.starts).toEqual([10]);
    const last = fixture(39);
    last.transport.play(10, 40);
    await settle();
    expect(last.output.starts).toEqual([10]);
  });

  it('stops at OUT and shows its last frame, never looping', async () => {
    const { output, transport } = fixture(30);
    transport.play(10, 40);
    await settle();
    output.clock = 39.9;
    tick();
    expect(transport.state.status).toBe('playing');
    output.clock = 40.2;
    tick();
    expect(transport.state).toEqual({ status: 'paused', frame: 39, error: '' });
    expect(output.pause).toHaveBeenCalled();
    expect(raf.size).toBe(0);
  });

  it('pauses where the output clock is, and a seek pauses at the new frame', async () => {
    const { output, transport } = fixture(0);
    transport.play(0, 300);
    await settle();
    output.clock = 61.4;
    transport.pause();
    expect(transport.state).toEqual({ status: 'paused', frame: 61, error: '' });
    transport.play(0, 300);
    await settle();
    expect(output.starts).toEqual([0, 61]);
    transport.seek(150.6);
    expect(transport.state).toEqual({ status: 'paused', frame: 151, error: '' });
    expect(output.running).toBe(false);
  });

  it('cancels a start that has not begun without reporting an error', async () => {
    const { output, transport } = fixture(20);
    output.autoStart = false;
    transport.play(0, 300);
    await settle();
    transport.pause();
    await settle();
    expect(transport.state).toEqual({ status: 'paused', frame: 20, error: '' });
    output.release();
    await settle();
    expect(transport.state.status).toBe('paused');
  });

  it('restarts at the output clock after an underrun', async () => {
    const { output, transport } = fixture(0);
    transport.play(0, 300);
    await settle();
    output.clock = 45;
    output.synced = false;
    tick();
    output.synced = true;
    await settle();
    expect(output.starts).toEqual([0, 45]);
    expect(transport.state).toEqual({ status: 'playing', frame: 45, error: '' });
  });

  it('reports a failed start and can be played again', async () => {
    const { output, transport } = fixture(20);
    output.failure = new Error('Music request failed (409).');
    transport.play(0, 300);
    await settle();
    expect(transport.state).toEqual({ status: 'error', frame: 20, error: 'Music request failed (409).' });
    output.failure = null;
    transport.play(0, 300);
    await settle();
    expect(transport.state.status).toBe('playing');
  });

  it('disposes its output once and ignores later requests', async () => {
    const { output, states, transport } = fixture(20);
    transport.play(0, 300);
    await settle();
    transport.dispose();
    transport.dispose();
    const published = states.length;
    transport.play(0, 300);
    transport.seek(3);
    expect(output.dispose).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(published);
  });
});
