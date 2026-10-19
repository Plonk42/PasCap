import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';
import { SourceTransport, type SourceTransportState } from '../../src/web/source-transport.js';

interface FakeFrame {
  sourceFrame: number;
  closed: boolean;
  close(): void;
}

/** One WebCodecs decoder lane: requested frames are decoded when a test says so (or at once). */
class Frames {
  auto = true;
  generation = 0;
  url = '';
  pending: number[] = [];
  queue: FakeFrame[] = [];
  error: Error | null = null;
  readonly open = new Set<FakeFrame>();
  readonly starts: { url: string; frames: number[]; complete: boolean }[] = [];
  readonly listeners = new Set<() => void>();
  disposed = false;
  start = vi.fn((_lane: number, url: string, frames: number[], complete: boolean): void => {
    this.#reset();
    this.url = url;
    this.pending = [...frames];
    this.starts.push({ url, frames: [...frames], complete });
    if (this.auto) this.decode();
  });
  stop = vi.fn((_lane: number): void => this.#reset());
  dispose = vi.fn((): void => {
    this.#reset();
    this.disposed = true;
  });
  #reset(): void {
    this.queue.forEach((frame) => frame.close());
    this.queue = [];
    this.pending = [];
    this.error = null;
    this.generation++;
    this.listeners.forEach((listener) => listener());
  }
  decode(count = Infinity): void {
    for (let index = 0; index < count && this.queue.length < 6 && this.pending.length; index++) {
      const open = this.open;
      const frame: FakeFrame = {
        sourceFrame: this.pending.shift()!,
        closed: false,
        close() {
          this.closed = true;
          open.delete(this);
        },
      };
      open.add(frame);
      this.queue.push(frame);
    }
    this.listeners.forEach((listener) => listener());
  }
  fail(message: string): void {
    this.error = new Error(message);
    this.listeners.forEach((listener) => listener());
  }
  #advance(sourceFrame: number): void {
    if (this.error) throw this.error;
    while (this.queue.length && this.queue[0]!.sourceFrame < sourceFrame) this.queue.shift()!.close();
  }
  take = vi.fn((_lane: number, sourceFrame: number) => {
    this.#advance(sourceFrame);
    if (this.queue[0]?.sourceFrame !== sourceFrame) return null;
    const frame = this.queue.shift()!;
    if (this.auto) this.decode();
    return frame as unknown as VideoFrame;
  });
  ready = vi.fn(
    (_lane: number, sourceFrame: number, count: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        const generation = this.generation;
        const check = (): void => {
          if (signal.aborted || generation !== this.generation) {
            this.listeners.delete(check);
            reject(new DOMException('Cancelled', 'AbortError'));
            return;
          }
          try {
            this.#advance(sourceFrame);
          } catch (error) {
            this.listeners.delete(check);
            reject(error);
            return;
          }
          if (this.queue[0]?.sourceFrame === sourceFrame && this.queue.length >= count) {
            this.listeners.delete(check);
            resolve();
          }
        };
        this.listeners.add(check);
        signal.addEventListener('abort', check, { once: true });
        check();
      }),
  );
}

let now = 1000;
const raf = new Map<number, FrameRequestCallback>();
let nextRaf = 0;
beforeEach(() => {
  now = 1000;
  raf.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
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
/** Display callbacks at `frames` source frames after `anchor`. */
function tick(anchor: number, frames: number): void {
  now = anchor + framesToSeconds(frames + 0.1) * 1000;
  const pending = [...raf.values()];
  raf.clear();
  pending.forEach((callback) => callback(now));
}

function fixture(frame = 20, sourceIn = 10, sourceOut = 40) {
  const frames = new Frames();
  const drawn: number[] = [];
  const states: SourceTransportState[] = [];
  const range = { mediaId: 'pattern', sourceIn, sourceOut };
  const transport = new SourceTransport(
    frames,
    (decoded) => drawn.push((decoded as unknown as FakeFrame).sourceFrame),
    PROJECT_FPS,
    120,
    range,
    frame,
    (state) => states.push({ ...state }),
  );
  return { transport, frames, drawn, states, range };
}
async function loaded(frame = 20, sourceIn = 10, sourceOut = 40) {
  const f = fixture(frame, sourceIn, sourceOut);
  f.transport.load('/api/media/pattern/proxy');
  await settle();
  expect(f.transport.state).toMatchObject({ status: 'paused', frame });
  return f;
}
async function started(f: Awaited<ReturnType<typeof loaded>>): Promise<number> {
  f.transport.play();
  await settle();
  expect(f.transport.state.status).toBe('playing');
  return now;
}

describe('owned source proxy transport', () => {
  it('shows the requested exact frame on load and follows the latest seek', async () => {
    const f = fixture();
    f.transport.follow(34);
    expect(f.frames.start).not.toHaveBeenCalled();
    f.transport.load('/api/media/pattern/proxy');
    await settle();
    expect(f.frames.starts).toEqual([{ url: '/api/media/pattern/proxy', frames: [34], complete: true }]);
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 34 });
    expect(f.drawn).toEqual([34]);
    expect(f.frames.stop).toHaveBeenCalled();
    f.transport.dispose();
    expect(f.frames.open.size).toBe(0);
  });

  it.each([
    [-1, 0],
    [999, 119],
    [13.6, 14],
  ])('bounds source scrub %s to %s', async (requested, expected) => {
    const f = await loaded();
    f.transport.seek(requested);
    await settle();
    expect(f.transport.state.frame).toBe(expected);
    f.transport.dispose();
  });

  it('keeps the displayed image while a frame decodes, shows it, then the latest seek, never cancelling it', async () => {
    const f = await loaded();
    f.frames.auto = false;
    f.transport.seek(60);
    expect(f.transport.state).toMatchObject({ status: 'buffering', frame: 20, requestedFrame: 60 });
    f.transport.seek(25);
    f.transport.seek(45);
    expect(f.transport.state).toMatchObject({ status: 'buffering', frame: 20, requestedFrame: 45 });
    expect(f.frames.starts.at(-1)!.frames).toEqual([60]);
    f.frames.decode();
    await settle();
    expect(f.drawn).toEqual([20, 60]);
    expect(f.transport.state).toMatchObject({ status: 'buffering', frame: 60, requestedFrame: 45 });
    // The obsolete 25 is never decoded; 45 is a GOP keyframe, so it is decoded exactly at once.
    expect(f.frames.starts.at(-1)!.frames).toEqual([45]);
    f.frames.decode();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 45 });
    expect(f.drawn).toEqual([20, 60, 45]);
    f.transport.dispose();
  });

  it('shows the keyframe of a seek that arrived while decoding, then refines to the exact frame', async () => {
    const f = await loaded();
    f.frames.auto = false;
    f.transport.seek(60);
    f.transport.seek(83);
    f.frames.decode();
    await settle();
    expect(f.frames.starts.at(-1)!.frames).toEqual([75]);
    f.frames.decode();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'buffering', frame: 75, requestedFrame: 83 });
    expect(f.frames.starts.at(-1)!.frames).toEqual([83]);
    f.frames.decode();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 83 });
    expect(f.drawn).toEqual([20, 60, 75, 83]);
    // A seek while idle decodes exactly.
    f.transport.seek(88);
    expect(f.frames.starts.at(-1)!.frames).toEqual([88]);
    f.transport.dispose();
  });

  it('returns to the displayed frame when the latest seek asks for it', async () => {
    const f = await loaded(30);
    f.frames.auto = false;
    f.transport.seek(60);
    f.transport.follow(30);
    f.frames.decode();
    await settle();
    expect(f.frames.starts.at(-1)!.frames).toEqual([30]);
    f.frames.decode();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 30, requestedFrame: 30 });
    expect(f.drawn).toEqual([30, 60, 30]);
    f.transport.dispose();
  });

  it.each([
    [20, 20, [21, 22]],
    [5, 10, [10, 11]],
    [39, 10, [10, 11]],
    [75, 10, [10, 11]],
  ])('plays from frame %s at %s inside the applied IN/OUT', async (frame, start, first) => {
    const f = await loaded(frame);
    f.transport.play();
    expect(f.transport.state).toMatchObject({
      status: 'starting',
      requestedFrame: start,
      frame,
    });
    expect(f.frames.starts.at(-1)!.frames.slice(0, 2)).toEqual(first);
    expect(f.frames.starts.at(-1)!.frames.at(-1)).toBe(39);
    await settle();
    expect(f.transport.state.status).toBe('playing');
    f.transport.dispose();
  });

  it('presents every source frame on the wall clock and stops exactly on OUT − 1', async () => {
    const f = await loaded(30);
    const anchor = await started(f);
    for (let frame = 31; frame <= 38; frame++) {
      tick(anchor, frame - 30);
      expect(f.transport.state).toMatchObject({ status: 'playing', frame });
    }
    tick(anchor, 20);
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 39, requestedFrame: 39 });
    expect(f.drawn).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
    expect(raf.size).toBe(0);
    f.transport.play();
    await settle();
    expect(f.frames.starts.at(-1)!.frames[0]).toBe(10);
    f.transport.dispose();
  });

  it('stops the clock at a frame that is not decoded yet, then continues from it', async () => {
    const f = await loaded(20);
    const anchor = await started(f);
    f.frames.auto = false;
    for (let frame = 21; frame <= 26; frame++) tick(anchor, frame - 20);
    expect(f.transport.state.frame).toBe(26);
    tick(anchor, 7);
    tick(now, 30);
    expect(f.transport.state).toMatchObject({ status: 'playing', frame: 26 });
    f.frames.decode();
    tick(now, 0);
    expect(f.transport.state).toMatchObject({ status: 'playing', frame: 27 });
    tick(now - framesToSeconds(0.1) * 1000, 1);
    expect(f.transport.state.frame).toBe(28);
    expect(f.drawn.slice(-3)).toEqual([26, 27, 28]);
    f.transport.dispose();
  });

  it('reports a bounded stall without inventing frames', async () => {
    const f = await loaded(20);
    const anchor = await started(f);
    f.frames.auto = false;
    f.frames.queue.splice(0).forEach((frame) => frame.close());
    tick(anchor, 1);
    now += 4_900;
    tick(now, 0);
    expect(f.transport.state.status).toBe('playing');
    now += 200;
    tick(now, 0);
    expect(f.transport.state).toMatchObject({ status: 'error', frame: null });
    expect(f.transport.state.error).toContain('within 5 seconds');
    f.transport.dispose();
  });

  it('keeps a one-frame range exact without playing', async () => {
    const f = await loaded(4, 30, 31);
    f.transport.play();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 30 });
    f.transport.play();
    await settle();
    expect(f.frames.starts.map((start) => start.frames)).toEqual([[4], [30]]);
    f.transport.dispose();
  });

  it('pauses on the displayed exact frame without decoding it again', async () => {
    const f = await loaded(20);
    const anchor = await started(f);
    tick(anchor, 5);
    const starts = f.frames.starts.length;
    f.transport.pause();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 25, requestedFrame: 25 });
    expect(f.frames.starts).toHaveLength(starts);
    expect(raf.size).toBe(0);
    f.transport.dispose();
  });

  it('cancelling startup before its first frame keeps the displayed exact frame', async () => {
    const f = await loaded(5);
    f.frames.auto = false;
    f.transport.play();
    expect(f.transport.state).toMatchObject({ status: 'starting', frame: 5, requestedFrame: 10 });
    f.transport.pause();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 5, requestedFrame: 5 });
    f.frames.decode();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 5 });
    expect(f.drawn).toEqual([5]);
    expect(f.frames.starts).toHaveLength(2);
    f.transport.dispose();
  });

  it('a range change pauses playback first', async () => {
    const f = await loaded(20);
    const anchor = await started(f);
    tick(anchor, 2);
    f.transport.setRange({ ...f.range, sourceOut: 31 });
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 22 });
    f.transport.play();
    await settle();
    expect(f.frames.starts.at(-1)!.frames.at(-1)).toBe(30);
    f.transport.dispose();
  });

  it.each(['seek', 'play'] as const)('reports a decoder failure during %s', async (operation) => {
    const f = await loaded();
    f.frames.auto = false;
    if (operation === 'play') f.transport.play();
    else f.transport.seek(35);
    f.frames.fail('deliberate source failure');
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'error', frame: null, error: 'deliberate source failure' });
    f.transport.dispose();
  });

  it('disposal releases the decoder and ignores late frames', async () => {
    const f = await loaded();
    f.frames.auto = false;
    f.transport.seek(50);
    f.transport.dispose();
    const count = f.states.length;
    f.frames.decode();
    await settle();
    expect(f.frames.dispose).toHaveBeenCalledOnce();
    expect(f.states).toHaveLength(count);
    expect(f.frames.open.size).toBe(0);
  });
});
