import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { EXPORT_RESOURCES } from '../shared/export.js';
import { ServiceError } from './errors.js';

interface RawProcessOptions { ffmpeg: string; cwd: string; signal: AbortSignal }
type InitialRead = { ok: true; result: IteratorResult<Buffer> } | { ok: false; cause: unknown };
export interface RawPassReport {
  peakReaders: number;
  peakEncoders: number;
  peakChildren: number;
  readerProcesses: number;
  encoderProcesses: number;
  largestReadChunkBytes: number;
}

/** Arbitrary pipe chunks are not frames; retain only one chunk per reader. */
export class RawFrameReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #initial: Promise<InitialRead> | null = null;
  #chunk: Buffer | null = null;
  #offset = 0;
  largestChunk = 0;
  private constructor(stream: Readable, private readonly label: string, private readonly check: () => void) {
    this.#iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }
  static create(stream: Readable, label: string, check: () => void): RawFrameReader {
    const reader = new RawFrameReader(stream, label, check);
    // Creating the iterator alone is lazy. Node flushStdio() resumes stdout on
    // child exit and can discard an untouched second reader while the first is
    // awaited. Begin consumption now; retain at most its first bounded chunk.
    // Record rejection immediately too: cancellation may precede the first frame request.
    reader.#initial = reader.#iterator.next().then(
      (result): InitialRead => ({ ok: true, result }),
      (cause: unknown): InitialRead => ({ ok: false, cause }),
    );
    return reader;
  }
  private async nextChunk(): Promise<IteratorResult<Buffer>> {
    const initial = this.#initial;
    if (initial === null) return this.#iterator.next();
    this.#initial = null;
    const settled = await initial;
    if (!settled.ok) throw settled.cause;
    return settled.result;
  }
  async readInto(frame: Buffer): Promise<boolean> {
    let filled = 0;
    while (filled < frame.length) {
      this.check();
      if (!this.#chunk) {
        const next = await this.nextChunk();
        this.check();
        if (next.done) {
          if (filled) throw new ServiceError(`${this.label} emitted a truncated raw frame (${filled}/${frame.length} bytes).`, 422);
          return false;
        }
        this.#chunk = next.value;
        this.#offset = 0;
        this.largestChunk = Math.max(this.largestChunk, next.value.length);
      }
      const count = Math.min(frame.length - filled, this.#chunk.length - this.#offset);
      this.#chunk.copy(frame, filled, this.#offset, this.#offset + count);
      filled += count;
      this.#offset += count;
      if (this.#offset === this.#chunk.length) this.#chunk = null;
    }
    return true;
  }
  async requireFrame(frame: Buffer): Promise<void> {
    if (!await this.readInto(frame)) throw new ServiceError(`${this.label} ended before its exact selected frame count / SOURCE OUT.`, 422);
  }
  async requireEnd(frame: Buffer): Promise<void> {
    if (await this.readInto(frame)) throw new ServiceError(`${this.label} emitted frames outside its selected range.`, 422);
  }
}

/** The callback honours backpressure even when write() returns true. */
export function writeRawFrame(stream: Writable, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => { if (error) reject(error); else resolve(); });
  });
}

function isPipeError(error: Error | null): boolean {
  return ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE'].includes((error as NodeJS.ErrnoException | null)?.code ?? '');
}

/** One pass owns at most two readers and one encoder; every child is reaped. */
export class RawVideoPass {
  readonly #active = new Map<ChildProcess, 'reader' | 'encoder'>();
  readonly #exits: Promise<void>[] = [];
  readonly #readers: RawFrameReader[] = [];
  readonly #report: RawPassReport = { peakReaders: 0, peakEncoders: 0, peakChildren: 0, readerProcesses: 0, encoderProcesses: 0, largestReadChunkBytes: 0 };
  #failure: Error | null = null;
  #stopping = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #cancel = (): void => this.fail(new ServiceError('Job cancelled.', 499));
  constructor(private readonly options: RawProcessOptions) {
    options.signal.addEventListener('abort', this.#cancel, { once: true });
    if (options.signal.aborted) this.#cancel();
  }
  check = (): void => {
    if (this.options.signal.aborted) throw new ServiceError('Job cancelled.', 499);
    if (this.#failure) throw this.#failure;
  };
  private child(args: readonly string[], label: string, role: 'reader' | 'encoder'): ChildProcess {
    this.check();
    const count = [...this.#active.values()].filter((value) => value === role).length;
    if (count >= (role === 'reader' ? 2 : 1)) throw new ServiceError('Raw video pass exceeded its two-reader / one-encoder bound.', 500);
    const child = spawn(this.options.ffmpeg, [...args], {
      cwd: this.options.cwd, shell: false,
      stdio: role === 'reader' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe']
    });
    this.#active.set(child, role);
    const readers = [...this.#active.values()].filter((value) => value === 'reader').length;
    this.#report.peakReaders = Math.max(this.#report.peakReaders, readers);
    this.#report.peakEncoders = Math.max(this.#report.peakEncoders, this.#active.size - readers);
    this.#report.peakChildren = Math.max(this.#report.peakChildren, this.#active.size);
    if (role === 'reader') this.#report.readerProcesses++;
    else this.#report.encoderProcesses++;
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-EXPORT_RESOURCES.stderrBytesPerChild); });
    child.stderr!.on('error', (error: Error) => this.fail(error));
    child.once('error', (error) => this.fail(new ServiceError(`Cannot start ${label}: ${error.message}`, 503)));
    this.#exits.push(new Promise((resolve) => child.once('close', (code) => {
      this.#active.delete(child);
      if (code !== 0) {
        const error = new ServiceError(`${label} exited ${code}: ${stderr.trim()}`, 422);
        if (!this.#stopping) this.fail(error);
        else if (code !== null && stderr.trim() && isPipeError(this.#failure)) this.#failure = error;
      }
      resolve();
    })));
    return child;
  }
  reader(args: readonly string[], label: string): RawFrameReader {
    const child = this.child(args, label, 'reader');
    child.stdout!.on('error', (error: Error) => this.fail(error));
    const reader = RawFrameReader.create(child.stdout!, label, this.check);
    this.#readers.push(reader);
    return reader;
  }
  encoder(args: readonly string[], label: string): Writable {
    const child = this.child(args, label, 'encoder');
    child.stdin!.on('error', (error: Error) => this.fail(error));
    return child.stdin!;
  }
  fail(error: Error): void {
    this.#failure ??= error;
    if (this.#stopping) return;
    this.#stopping = true;
    for (const child of this.#active.keys()) {
      child.kill('SIGTERM');
      child.stdout?.destroy();
      child.stdin?.destroy();
    }
    this.#timer = setTimeout(() => { for (const child of this.#active.keys()) child.kill('SIGKILL'); }, EXPORT_RESOURCES.terminateGraceMs);
    this.#timer.unref();
  }
  async finish(): Promise<RawPassReport> {
    await Promise.all(this.#exits);
    this.check();
    return { ...this.#report, largestReadChunkBytes: Math.max(0, ...this.#readers.map((reader) => reader.largestChunk)) };
  }
  dispose(): void {
    this.options.signal.removeEventListener('abort', this.#cancel);
    if (this.#timer) clearTimeout(this.#timer);
  }
}

export async function runRawVideoPass(options: RawProcessOptions, pump: (pass: RawVideoPass) => Promise<void>): Promise<RawPassReport> {
  const pass = new RawVideoPass(options);
  try {
    pass.check();
    await pump(pass);
    return await pass.finish();
  } catch (error) {
    pass.fail(error instanceof Error ? error : new Error(String(error)));
    await pass.finish(); // Always reap children; prefer cancellation / capped native diagnostics.
    throw error;
  } finally { pass.dispose(); }
}