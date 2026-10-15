import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoReaderCommand, VideoReaderReport } from '../../src/preview/video-protocol.js';
import { VideoStreams } from '../../src/preview/video-streams.js';

interface FakeFrame {
  closed: boolean;
  close(): void;
}

class FakeWorker {
  static last: FakeWorker;
  readonly commands: VideoReaderCommand[] = [];
  onmessage: ((event: MessageEvent<VideoReaderReport>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor(
    readonly url: string | URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.last = this;
  }
  postMessage(command: VideoReaderCommand): void {
    this.commands.push(structuredClone(command));
  }
  terminate(): void {
    this.terminated = true;
  }
  report(message: VideoReaderReport): void {
    this.onmessage?.({ data: message } as MessageEvent<VideoReaderReport>);
  }
}

function frame(): FakeFrame {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
  };
}
function deliver(lane: number, sourceFrame: number, generation = 1): FakeFrame {
  const decoded = frame();
  FakeWorker.last.report({ kind: 'frame', lane, generation, sourceFrame, frame: decoded as unknown as VideoFrame });
  return decoded;
}
function credits(): VideoReaderCommand[] {
  return FakeWorker.last.commands.filter((command) => command.kind === 'credit');
}

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { href: 'http://127.0.0.1:4318/editor' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('page video streams', () => {
  it('starts one module worker and resolves proxy URLs against the editor', () => {
    const streams = new VideoStreams(2);
    expect(FakeWorker.last.options).toEqual({ type: 'module', name: 'pascap-video-reader' });
    streams.start(1, '/api/media/a/proxy', [3, 4], true, false);
    expect(FakeWorker.last.commands).toEqual([
      {
        kind: 'start',
        lane: 1,
        generation: 1,
        url: 'http://127.0.0.1:4318/api/media/a/proxy',
        frames: [3, 4],
        reverse: false,
        complete: true,
      },
    ]);
    expect(() => streams.start(2, '/x', [0], true, false)).toThrow('outside the decoder budget');
    streams.dispose();
    expect(FakeWorker.last.terminated).toBe(true);
  });

  it('presents the exact frame, drops passed ones and returns one credit with the needed frame', () => {
    const streams = new VideoStreams(1);
    streams.start(0, '/p', [1, 2, 3, 4], true, false);
    const passed = [deliver(0, 1), deliver(0, 2)];
    deliver(0, 3);
    const taken = streams.take(0, 3) as unknown as FakeFrame;
    expect(taken.closed).toBe(false);
    expect(passed.every((item) => item.closed)).toBe(true);
    expect(credits()).toEqual([{ kind: 'credit', lane: 0, generation: 1, count: 3, needed: 3 }]);
    expect(streams).toMatchObject({ decodedFrames: 3, droppedFrames: 2 });
    expect(streams.take(0, 4)).toBeNull();
    deliver(0, 6);
    expect(() => streams.take(0, 5)).toThrow('Video decoder 1 skipped source frame 5.');
    streams.dispose();
  });

  it('drops passed frames above the needed one on a reversed lane', () => {
    const streams = new VideoStreams(1);
    streams.start(0, '/p', [9, 8, 7, 6], true, true);
    expect(FakeWorker.last.commands[0]).toMatchObject({ kind: 'start', frames: [9, 8, 7, 6], reverse: true });
    const passed = [deliver(0, 9), deliver(0, 8)];
    deliver(0, 7);
    const taken = streams.take(0, 7) as unknown as FakeFrame;
    expect(taken.closed).toBe(false);
    expect(passed.every((item) => item.closed)).toBe(true);
    expect(credits()).toEqual([{ kind: 'credit', lane: 0, generation: 1, count: 3, needed: 7 }]);
    deliver(0, 4);
    expect(() => streams.take(0, 6)).toThrow('Video decoder 1 skipped source frame 6.');
    streams.start(0, '/p', [1, 2], true, false);
    deliver(0, 2, 2);
    expect(streams.take(0, 2)).not.toBeNull();
    streams.dispose();
  });

  it('closes frames of a superseded stream without crediting them', () => {
    const streams = new VideoStreams(1);
    streams.start(0, '/p', [1], true, false);
    const queued = deliver(0, 1);
    streams.start(0, '/p', [9], true, false);
    expect(queued.closed).toBe(true);
    const late = deliver(0, 1, 1);
    expect(late.closed).toBe(true);
    expect(streams.queued(0)).toBe(0);
    deliver(0, 9, 2);
    expect(streams.queued(0)).toBe(1);
    streams.stop(0);
    expect(FakeWorker.last.commands.at(-1)).toEqual({ kind: 'stop', lane: 0 });
    expect(streams.queued(0)).toBe(0);
    expect(credits()).toEqual([]);
  });

  it('waits until a frame heads the queue with enough frames decoded', async () => {
    const streams = new VideoStreams(1);
    streams.start(0, '/p', [4, 5, 6], true, false);
    const ready = vi.fn();
    void streams.ready(0, 4, 2, new AbortController().signal).then(ready);
    deliver(0, 4);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    deliver(0, 5);
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
    streams.dispose();
  });

  it('rejects a wait on failure, supersession, cancellation and its deadline', async () => {
    vi.useFakeTimers();
    const streams = new VideoStreams(1);
    streams.start(0, '/p', [4], true, false);
    const failed = streams.ready(0, 4, 1, new AbortController().signal);
    FakeWorker.last.report({ kind: 'failed', lane: 0, generation: 1, message: 'Decoding failed.' });
    await expect(failed).rejects.toThrow('Decoding failed.');
    expect(() => streams.take(0, 4)).toThrow('Decoding failed.');

    streams.start(0, '/p', [4], true, false);
    const superseded = streams.ready(0, 4, 1, new AbortController().signal);
    streams.stop(0);
    await expect(superseded).rejects.toMatchObject({ name: 'AbortError' });

    streams.start(0, '/p', [4], true, false);
    const controller = new AbortController();
    const aborted = streams.ready(0, 4, 1, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    const late = streams.ready(0, 4, 1, new AbortController().signal);
    const expectation = expect(late).rejects.toThrow(
      'Video decoder 1 did not deliver source frame 4 within 5 seconds.',
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
    streams.dispose();
  });

  it('fails every decoder when the worker itself fails', async () => {
    const streams = new VideoStreams(2);
    streams.start(1, '/p', [0], true, false);
    const waiting = streams.ready(1, 0, 1, new AbortController().signal);
    FakeWorker.last.onerror?.();
    await expect(waiting).rejects.toThrow('The video decoder worker failed.');
    expect(() => streams.take(0, 0)).toThrow('The video decoder worker failed.');
    streams.dispose();
  });
});
