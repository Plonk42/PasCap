import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceTransport, type SourceTransportState } from '../../src/web/source-transport.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function fixture(frame = 20, sourceIn = 10, sourceOut = 40) {
  const video = Object.assign(new EventTarget(), {
    currentTime: framesToSeconds(frame + 0.25),
    paused: true,
    error: null,
  });
  const states: SourceTransportState[] = [];
  const decoder = {
    video: video as unknown as HTMLVideoElement,
    decodedFrame: frame,
    ready: true,
    load: vi.fn(async (_url: string, _rate: unknown, _signal: AbortSignal) => {}),
    seek: vi.fn(async (target: number, _signal: AbortSignal) => {
      decoder.ready = true;
      decoder.decodedFrame = target;
      video.currentTime = framesToSeconds(target + 0.25);
      video.paused = true;
    }),
    play: vi.fn(async () => {
      video.paused = false;
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
    dispose: vi.fn(() => {
      video.paused = true;
    }),
  };
  const range = { mediaId: 'pattern', sourceIn, sourceOut };
  const transport = new SourceTransport(decoder, PROJECT_FPS, 120, range, frame, (state) => states.push({ ...state }));
  const observed = (next: number) => {
    decoder.decodedFrame = next;
    video.currentTime = framesToSeconds(next + 0.25);
    transport.observed();
  };
  return { transport, decoder, video, states, observed, range };
}

afterEach(() => vi.useRealTimers());

describe('owned source proxy playback', () => {
  it('loads once and follows the latest seek without cancelling its resource load', async () => {
    const f = fixture();
    const loading = deferred();
    f.decoder.load.mockImplementation(() => loading.promise);
    const load = f.transport.load('/api/media/pattern/proxy');
    f.transport.follow(34);
    loading.resolve();
    await load;
    await settle();
    expect(f.decoder.load).toHaveBeenCalledTimes(1);
    expect(f.decoder.seek).toHaveBeenCalledWith(34, expect.any(AbortSignal));
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 34 });
    f.transport.dispose();
  });

  it.each([
    [-1, 0],
    [999, 119],
    [13.6, 14],
  ])('bounds source scrub %s to %s', async (requested, expected) => {
    const f = fixture();
    await f.transport.load('proxy');
    await settle();
    f.transport.seek(requested);
    await settle();
    expect(f.transport.state.frame).toBe(expected);
    f.transport.dispose();
  });

  it.each([
    [20, 20],
    [5, 10],
    [39, 10],
    [75, 10],
  ])('starts frame %s at %s inside applied IN/OUT', async (frame, start) => {
    const f = fixture(frame);
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    expect(f.decoder.seek).toHaveBeenLastCalledWith(start, expect.any(AbortSignal));
    expect(f.transport.state).toMatchObject({ status: 'playing', frame: start });
    expect(f.video.paused).toBe(false);
    f.transport.dispose();
  });

  it('publishes observed callbacks without seeking or accumulating React frame feedback', async () => {
    const f = fixture();
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    f.decoder.seek.mockClear();
    for (const frame of [21, 23, 26]) {
      f.observed(frame);
      f.transport.follow(frame);
    }
    expect(f.decoder.seek).not.toHaveBeenCalled();
    expect(f.transport.state).toMatchObject({ status: 'playing', frame: 26 });
    f.transport.dispose();
  });

  it.each([39, 40, 47])('pauses and seeks exact OUT−1 after observed frame %s; never loops', async (frame) => {
    const f = fixture();
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    f.observed(frame);
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 39, requestedFrame: 39 });
    expect(f.video.paused).toBe(true);
    expect(f.decoder.play).toHaveBeenCalledTimes(1);
    f.transport.dispose();
  });

  it('keeps a one-frame range exact without starting native playback', async () => {
    const f = fixture(4, 30, 31);
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 30 });
    expect(f.decoder.play).not.toHaveBeenCalled();
    f.transport.dispose();
  });

  it('pause captures the actual observed frame, not native currentTime', async () => {
    const f = fixture();
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    f.observed(25);
    f.video.currentTime = framesToSeconds(28.25);
    f.transport.pause();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 25 });
    f.transport.dispose();
  });

  it('cancelling startup during its initial seek reacquires a paused exact frame instead of staying busy', async () => {
    const f = fixture(5);
    await f.transport.load('proxy');
    await settle();
    const seeking = deferred();
    f.decoder.seek.mockImplementationOnce(() => {
      f.decoder.ready = false;
      return seeking.promise;
    });
    f.transport.play();
    expect(f.transport.state).toMatchObject({ status: 'starting', frame: null, requestedFrame: 10 });
    f.transport.pause();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 10 });
    seeking.resolve();
    await settle();
    expect(f.decoder.play).not.toHaveBeenCalled();
    f.transport.dispose();
  });

  it.each(['pause', 'seek', 'range', 'dispose'] as const)(
    'a late native play completion cannot restart after %s',
    async (action) => {
      const f = fixture();
      const playing = deferred();
      f.decoder.play.mockImplementation(async () => {
        await playing.promise;
        f.video.paused = false;
      });
      await f.transport.load('proxy');
      await settle();
      f.transport.play();
      await settle();
      expect(f.transport.state).toMatchObject({ status: 'starting', pendingPlay: true });
      if (action === 'pause') f.transport.pause();
      if (action === 'seek') f.transport.seek(50);
      if (action === 'range') f.transport.setRange({ ...f.range, sourceOut: 31 });
      if (action === 'dispose') f.transport.dispose();
      await settle();
      f.transport.play();
      expect(f.decoder.play).toHaveBeenCalledTimes(1);
      playing.resolve();
      await settle();
      expect(f.video.paused).toBe(true);
      if (action !== 'dispose') {
        expect(f.transport.state.pendingPlay).toBe(false);
        expect(f.transport.state.status).toBe('paused');
        f.transport.dispose();
      }
    },
  );

  it.each(['starting', 'playing'] as const)('reports a bounded %s timeout without inventing frames', async (status) => {
    vi.useFakeTimers();
    const f = fixture();
    const playing = deferred();
    if (status === 'starting') f.decoder.play.mockImplementation(() => playing.promise);
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.transport.state).toMatchObject({ status: 'error', frame: null });
    expect(f.transport.state.error).toContain('within 5 seconds');
    expect(f.video.paused).toBe(true);
    playing.resolve();
    await settle();
    expect(f.transport.state.status).toBe('error');
    f.transport.dispose();
  });

  it('real observed progress renews only the bounded stalled-frame deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    await vi.advanceTimersByTimeAsync(4_900);
    f.observed(21);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(f.transport.state.status).toBe('playing');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.transport.state.status).toBe('error');
    f.transport.dispose();
  });

  it('cancelling a never-settling native play still exposes a bounded Retry error', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const playing = deferred();
    f.decoder.play.mockImplementation(() => playing.promise);
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    f.transport.pause();
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', pendingPlay: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.transport.state.status).toBe('error');
    expect(f.transport.state.error).toContain('start did not finish');
    playing.resolve();
    await settle();
    expect(f.video.paused).toBe(true);
    f.transport.dispose();
  });

  it.each(['load', 'seek', 'play'] as const)('reports an owned %s rejection', async (operation) => {
    const f = fixture();
    f.decoder[operation].mockRejectedValueOnce(new Error('deliberate source failure'));
    await f.transport.load('proxy');
    await settle();
    if (operation === 'play') {
      f.transport.play();
      await settle();
    }
    expect(f.transport.state).toMatchObject({ status: 'error', frame: null, error: 'deliberate source failure' });
    f.transport.dispose();
  });

  it('an obsolete seek cannot replace its newer requested frame', async () => {
    const f = fixture();
    await f.transport.load('proxy');
    await settle();
    const old = deferred();
    f.decoder.seek.mockImplementationOnce(() => old.promise);
    f.transport.seek(60);
    const signal = f.decoder.seek.mock.calls.at(-1)![1];
    f.transport.seek(15);
    await settle();
    old.resolve();
    await settle();
    expect(signal.aborted).toBe(true);
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 15 });
    f.transport.dispose();
  });

  it('rejects a seek that did not deliver its exact rVFC frame', async () => {
    const f = fixture();
    f.decoder.seek.mockImplementation(async () => {});
    await f.transport.load('proxy');
    await settle();
    f.transport.seek(35);
    await settle();
    expect(f.transport.state.status).toBe('error');
    expect(f.transport.state.error).toContain('exact frame');
    f.transport.dispose();
  });

  it('disposal aborts the pending load and ignores late completions and frame callbacks', async () => {
    const f = fixture();
    const loading = deferred();
    f.decoder.load.mockImplementation(() => loading.promise);
    const load = f.transport.load('proxy');
    const signal = f.decoder.load.mock.calls[0]![2];
    f.transport.dispose();
    const count = f.states.length;
    loading.resolve();
    await load;
    f.observed(22);
    expect(signal.aborted).toBe(true);
    expect(f.decoder.dispose).toHaveBeenCalledTimes(1);
    expect(f.states).toHaveLength(count);
  });

  it('a native ended event retains the exact final included source frame', async () => {
    const f = fixture(100, 90, 120);
    await f.transport.load('proxy');
    await settle();
    f.transport.play();
    await settle();
    f.video.dispatchEvent(new Event('ended'));
    await settle();
    expect(f.transport.state).toMatchObject({ status: 'paused', frame: 119 });
    f.transport.dispose();
  });
});
