import { randomUUID } from 'node:crypto';
import { jobSchema, runsInBackground, type MediaJob } from '../shared/media.js';
import { whileSerial } from '../shared/serial.js';
import { errorMessage, ServiceError } from './errors.js';

export interface JobContext {
  id: string;
  signal: AbortSignal;
  update: (progress: number, message: string) => void;
}
interface Entry {
  job: MediaJob;
  controller: AbortController;
  task: (context: JobContext) => Promise<unknown>;
  settled: ((job: MediaJob) => Promise<void>) | null;
  done: Promise<void>;
  finish: () => void;
}

/**
 * One heavy media task at a time, FIFO except background jobs, which wait for the others.
 * Jobs themselves never own mutable editor documents.
 */
export class JobQueue {
  readonly #entries = new Map<string, Entry>();
  readonly #pending: Entry[] = [];
  #running = false;
  restoreCompleted(input: MediaJob): void {
    const job = jobSchema.parse(input);
    if (job.state !== 'completed' || job.kind !== 'export' || job.progress !== 1 || !job.outputUrl || !job.receiptUrl)
      throw new ServiceError('Only verified completed exports can be restored.', 422);
    if (this.#entries.has(job.id)) return;
    this.#entries.set(job.id, {
      job,
      controller: new AbortController(),
      task: async () => {},
      settled: null,
      done: Promise.resolve(),
      finish: () => {},
    });
  }
  submit(kind: MediaJob['kind'], label: string, task: Entry['task'], settled: Entry['settled'] = null): MediaJob {
    const job: MediaJob = {
      id: randomUUID(),
      kind,
      label,
      state: 'queued',
      progress: 0,
      message: 'Waiting for the media worker',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      outputUrl: null,
      receiptUrl: null,
    };
    let finish = (): void => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Entry = { job, controller: new AbortController(), task, settled, done, finish };
    this.#entries.set(job.id, entry);
    this.#pending.push(entry);
    void this.#drain();
    return { ...job };
  }
  get(id: string): MediaJob {
    const entry = this.#entries.get(id);
    if (!entry) throw new ServiceError('Job not found.', 404);
    return { ...entry.job };
  }
  list(): MediaJob[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry.job })).reverse();
  }
  cancel(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) throw new ServiceError('Job not found.', 404);
    if (['queued', 'running'].includes(entry.job.state)) entry.controller.abort();
  }
  setOutput(id: string, outputUrl: string, receiptUrl: string): void {
    const entry = this.#entries.get(id);
    if (entry) {
      entry.job.outputUrl = outputUrl;
      entry.job.receiptUrl = receiptUrl;
    }
  }
  async wait(id: string): Promise<MediaJob> {
    const entry = this.#entries.get(id);
    if (!entry) throw new ServiceError('Job not found.', 404);
    await entry.done;
    return this.get(id);
  }
  async close(): Promise<void> {
    for (const entry of this.#entries.values())
      if (['queued', 'running'].includes(entry.job.state)) entry.controller.abort();
    await Promise.all([...this.#entries.values()].map((entry) => entry.done));
  }
  /** Resolves once no job is queued or running, including jobs submitted meanwhile. */
  async idle(): Promise<void> {
    await whileSerial(
      () => [...this.#entries.values()].some((entry) => ['queued', 'running'].includes(entry.job.state)),
      () => Promise.all([...this.#entries.values()].map((entry) => entry.done)),
    );
  }
  #next(): Entry {
    const index = this.#pending.findIndex((entry) => !runsInBackground(entry.job));
    return this.#pending.splice(Math.max(0, index), 1)[0]!;
  }
  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await whileSerial(
      () => {
        if (this.#pending.length > 0) return true;
        // Release before the helper resolves, so a submission in the final
        // drain microtask cannot observe a stale running latch and be stranded.
        this.#running = false;
        return false;
      },
      () => this.#runEntry(this.#next()),
    );
  }
  async #runEntry(current: Entry): Promise<void> {
    try {
      if (current.controller.signal.aborted) throw new ServiceError('Job cancelled.', 499);
      current.job.state = 'running';
      const result = await current.task({
        id: current.job.id,
        signal: current.controller.signal,
        update: (progress, message) => {
          current.job.progress = Math.max(0, Math.min(0.99, progress));
          current.job.message = message;
        },
      });
      current.job.state = 'completed';
      current.job.progress = 1;
      current.job.message = typeof result === 'string' ? result : 'Complete';
    } catch (error) {
      current.job.state = current.controller.signal.aborted ? 'cancelled' : 'failed';
      current.job.message = errorMessage(error);
    } finally {
      current.job.finishedAt = new Date().toISOString();
      try {
        await current.settled?.({ ...current.job });
      } catch (error) {
        current.job.state = 'failed';
        current.job.message = `Cannot persist job result: ${errorMessage(error)}`;
      }
      current.finish();
    }
  }
}
