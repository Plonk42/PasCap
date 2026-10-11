import type { VideoReaderCommand, VideoReaderReport } from './video-protocol.js';
import readerUrl from './video-reader.ts?worker&url';

const READY_DEADLINE_MS = 5_000;

interface Decoded {
  sourceFrame: number;
  frame: VideoFrame;
}
interface Lane {
  generation: number;
  queue: Decoded[];
  error: Error | null;
  readonly listeners: Set<() => void>;
}

function cancelled(): DOMException {
  return new DOMException('Obsolete video request cancelled.', 'AbortError');
}

/**
 * Page side of the video reader worker: one queue of exact decoded frames per
 * timeline decoder. Every frame is closed here once presented, passed by the
 * clock or superseded; each one presented or passed returns a worker credit.
 */
export class VideoStreams {
  readonly #worker: Worker;
  readonly #lanes: Lane[];
  #failure: Error | null = null;
  #disposed = false;
  decodedFrames = 0;
  droppedFrames = 0;

  constructor(lanes: number) {
    this.#lanes = Array.from({ length: lanes }, () => ({
      generation: 0,
      queue: [],
      error: null,
      listeners: new Set(),
    }));
    this.#worker = new Worker(readerUrl, { type: 'module', name: 'pascap-video-reader' });
    this.#worker.onmessage = this.#onMessage;
    this.#worker.onerror = () => {
      this.#failure = new Error('The video decoder worker failed. Reload the editor before playing again.');
      this.#lanes.forEach((lane) => this.#notify(lane));
    };
  }
  #lane(index: number): Lane {
    const lane = this.#lanes[index];
    if (!lane) throw new Error('Video decoder is outside the decoder budget.');
    return lane;
  }
  #command(command: VideoReaderCommand): void {
    if (!this.#disposed) this.#worker.postMessage(command);
  }
  #notify(lane: Lane): void {
    for (const listener of lane.listeners) listener();
  }
  #reset(lane: Lane): void {
    for (const item of lane.queue) item.frame.close();
    lane.queue.length = 0;
    lane.error = null;
    lane.generation++;
    this.#notify(lane);
  }
  readonly #onMessage = ({ data }: MessageEvent<VideoReaderReport>): void => {
    const lane = this.#lanes[data.lane];
    if (data.kind === 'frame') {
      if (this.#disposed || data.generation !== lane?.generation) {
        data.frame.close();
        return;
      }
      lane.queue.push({ sourceFrame: data.sourceFrame, frame: data.frame });
      this.decodedFrames++;
      this.#notify(lane);
    } else if (data.generation === lane?.generation) {
      lane.error = new Error(data.message);
      this.#notify(lane);
    }
  };
  /**
   * Close frames the clock has passed and, when `take`, the exact frame's queue
   * entry; return one credit per removed frame with the new minimum.
   */
  #advance(index: number, lane: Lane, sourceFrame: number, take: boolean): VideoFrame | null {
    if (this.#failure) throw this.#failure;
    if (lane.error) throw lane.error;
    let credits = 0;
    while (lane.queue.length && lane.queue[0]!.sourceFrame < sourceFrame) {
      lane.queue.shift()!.frame.close();
      this.droppedFrames++;
      credits++;
    }
    const head = lane.queue[0];
    if (head && head.sourceFrame !== sourceFrame)
      throw new Error(`Video decoder ${index + 1} skipped source frame ${sourceFrame}.`);
    if (head && take) {
      lane.queue.shift();
      credits++;
    }
    if (credits)
      this.#command({ kind: 'credit', lane: index, generation: lane.generation, count: credits, minimum: sourceFrame });
    return take ? (head?.frame ?? null) : null;
  }

  start(index: number, url: string, frames: number[], complete: boolean): void {
    const lane = this.#lane(index);
    this.#reset(lane);
    this.#command({
      kind: 'start',
      lane: index,
      generation: lane.generation,
      url: new URL(url, location.href).href,
      frames,
      complete,
    });
  }
  extend(index: number, frames: number[], complete: boolean): void {
    this.#command({ kind: 'extend', lane: index, generation: this.#lane(index).generation, frames, complete });
  }
  stop(index: number): void {
    this.#reset(this.#lane(index));
    this.#command({ kind: 'stop', lane: index });
  }
  queued(index: number): number {
    return this.#lane(index).queue.length;
  }
  /** The exact decoded frame, or null while it is not decoded yet. The caller closes it. */
  take(index: number, sourceFrame: number): VideoFrame | null {
    return this.#advance(index, this.#lane(index), sourceFrame, true);
  }
  /** Resolves once `sourceFrame` heads the queue with at least `count` frames decoded. */
  ready(index: number, sourceFrame: number, count: number, signal: AbortSignal): Promise<void> {
    const lane = this.#lane(index);
    const generation = lane.generation;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        lane.listeners.delete(check);
        signal.removeEventListener('abort', abort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = (): void => finish(cancelled());
      const check = (): void => {
        if (signal.aborted || lane.generation !== generation || this.#disposed) {
          abort();
          return;
        }
        try {
          this.#advance(index, lane, sourceFrame, false);
        } catch (error) {
          // #advance throws only the lane's or worker's Error.
          finish(error as Error);
          return;
        }
        if (lane.queue.length >= count) finish();
      };
      const timer = setTimeout(
        () =>
          finish(new Error(`Video decoder ${index + 1} did not deliver source frame ${sourceFrame} within 5 seconds.`)),
        READY_DEADLINE_MS,
      );
      lane.listeners.add(check);
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#lanes.forEach((lane) => this.#reset(lane));
    this.#disposed = true;
    this.#worker.onmessage = null;
    this.#worker.terminate();
  }
}
