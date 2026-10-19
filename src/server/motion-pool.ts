import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { FrameMotion } from './motion.js';

/** Camera motion threads per analysis, like the export compositor's; no native process is added. */
export const MAX_MOTION_THREADS = 8;

export interface MotionTask {
  frames: Uint8Array;
  withPrevious: boolean;
}
export type MotionReply = { error: null; motions: (FrameMotion | null)[] } | { error: string };

/** Measures consecutive frame chunks in parallel; each worker handles one chunk at a time. */
export class MotionPool {
  readonly #workers: Worker[];
  readonly #tails: Promise<unknown>[];
  #failure: Error | null = null;
  private constructor(threads: number) {
    // Source checkouts (tsx/Vitest) load the TypeScript worker; builds load the compiled file.
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(`./motion-worker.${source ? 'ts' : 'js'}`, import.meta.url);
    this.#workers = Array.from({ length: threads }, () => {
      const worker = new Worker(entry, source ? { execArgv: ['--import', 'tsx'] } : {});
      worker.on('error', (error) => {
        this.#failure ??= error;
      });
      worker.on('exit', (code) => {
        this.#failure ??= new Error(`Camera motion worker exited with code ${code}.`);
      });
      return worker;
    });
    this.#tails = this.#workers.map(() => Promise.resolve());
  }
  /** Null with fewer than three host cores: measure in process instead. */
  static forHost(cores = availableParallelism()): MotionPool | null {
    const threads = Math.min(MAX_MOTION_THREADS, cores - 1);
    return threads >= 2 ? new MotionPool(threads) : null;
  }
  get threads(): number {
    return this.#workers.length;
  }
  /** Chunk `index` runs on worker `index % threads`; `frames` is transferred, not copied. */
  measure(index: number, task: MotionTask): Promise<(FrameMotion | null)[]> {
    const slot = index % this.threads;
    const result = this.#tails[slot]!.then(() => this.#send(this.#workers[slot]!, task));
    this.#tails[slot] = result.catch(() => {});
    return result;
  }
  async close(): Promise<void> {
    await Promise.all(this.#workers.map((worker) => worker.terminate()));
  }
  #send(worker: Worker, task: MotionTask): Promise<(FrameMotion | null)[]> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const onMessage = (reply: MotionReply): void => {
        cleanup();
        if (reply.error === null) resolve(reply.motions);
        else reject(new Error(reply.error));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        cleanup();
        reject(new Error(`Camera motion worker exited with code ${code}.`));
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage(task, [task.frames.buffer as ArrayBuffer]);
    });
  }
}
