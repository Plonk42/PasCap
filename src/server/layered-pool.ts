import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ColourSettings } from '../shared/colour.js';
import type { FrameSource } from './layered-frame.js';

/** CPU compositing threads per export, beside the unchanged native child bounds. */
export const MAX_COMPOSITOR_THREADS = 8;

export type CompositorTask =
  | { kind: 'rows'; output: Uint16Array; width: number; sources: FrameSource[]; start: number; end: number }
  | { kind: 'lut'; lut: Float32Array; colour: ColourSettings; start: number; end: number };
export interface CompositorReply {
  error: string | null;
}

function requireShared(view: ArrayBufferView): void {
  if (!(view.buffer instanceof SharedArrayBuffer))
    throw new Error('Worker compositing requires shared frame and LUT memory; it never copies frames.');
}

function bands(count: number, parts: number): Array<[number, number]> {
  const used = Math.min(parts, count);
  return Array.from({ length: used }, (_, index) => [
    Math.floor((index * count) / used),
    Math.floor(((index + 1) * count) / used),
  ]);
}

/**
 * Disjoint row/LUT bands over the export's existing shared buffers: no extra
 * frame, LUT or native process. One frame or LUT at a time.
 */
export class CompositorPool {
  readonly #workers: Worker[];
  #busy = false;
  #failure: Error | null = null;
  private constructor(threads: number) {
    // Source checkouts (tsx/Vitest) load the TypeScript worker; builds load the compiled file.
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(`./layered-worker.${source ? 'ts' : 'js'}`, import.meta.url);
    this.#workers = Array.from({ length: threads }, () => {
      const worker = new Worker(entry, source ? { execArgv: ['--import', 'tsx'] } : {});
      // A startup error or exit fails later bands instead of crashing the service or hanging a frame.
      worker.on('error', (error) => {
        this.#failure ??= error;
      });
      worker.on('exit', (code) => {
        this.#failure ??= new Error(`Compositor worker exited with code ${code}.`);
      });
      return worker;
    });
  }
  /** Null with fewer than three host cores: composite in process instead. */
  static forHost(cores = availableParallelism()): CompositorPool | null {
    const threads = Math.min(MAX_COMPOSITOR_THREADS, cores - 1);
    return threads >= 2 ? new CompositorPool(threads) : null;
  }
  get threads(): number {
    return this.#workers.length;
  }
  composeRows(output: Uint16Array, target: { width: number; height: number }, sources: FrameSource[]): Promise<void> {
    requireShared(output);
    for (const source of sources) {
      requireShared(source.rgb);
      if (source.lut) requireShared(source.lut);
    }
    return this.#run(
      bands(target.height, this.threads).map(([start, end]) => ({
        kind: 'rows',
        output,
        width: target.width,
        sources,
        start,
        end,
      })),
    );
  }
  fillLut(lut: Float32Array, colour: ColourSettings, size: number): Promise<void> {
    requireShared(lut);
    return this.#run(bands(size, this.threads).map(([start, end]) => ({ kind: 'lut', lut, colour, start, end })));
  }
  async close(): Promise<void> {
    await Promise.all(this.#workers.map((worker) => worker.terminate()));
  }
  async #run(tasks: CompositorTask[]): Promise<void> {
    if (this.#busy) throw new Error('Compositor bands run one frame or LUT at a time.');
    this.#busy = true;
    try {
      // Every band settles before returning, so no worker still writes shared memory after a failure.
      const results = await Promise.allSettled(tasks.map((task, index) => this.#send(this.#workers[index]!, task)));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      this.#busy = false;
    }
  }
  #send(worker: Worker, task: CompositorTask): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const onMessage = (reply: CompositorReply): void => {
        cleanup();
        if (reply.error === null) resolve();
        else reject(new Error(reply.error));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        cleanup();
        reject(new Error(`Compositor worker exited with code ${code}.`));
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage(task);
    });
  }
}
