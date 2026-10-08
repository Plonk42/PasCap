import type { MusicTrack } from '../shared/model.js';
import {
  accumulateMusicRange,
  clampMusicMix,
  MUSIC_BYTES_PER_SAMPLE,
  MUSIC_CHANNELS,
  MUSIC_CHUNK_SAMPLES,
  MUSIC_QUEUE_CHUNKS,
  MUSIC_SAMPLES_PER_FRAME,
  musicReadAt,
  type MusicChunk,
} from '../shared/music-stream.js';
import { forEachSerial, whileSerial } from '../shared/serial.js';

export interface MusicSource {
  track: MusicTrack;
  samples: number;
  url: string;
}

export type MusicReaderCommand =
  | { kind: 'connect'; port: MessagePort }
  | { kind: 'prefill'; generation: number; frame: number; sources: MusicSource[] }
  | { kind: 'stop'; generation: number };

export type MusicReaderReport =
  | { kind: 'prefilled'; generation: number; chunks: MusicChunk[] }
  | { kind: 'failed'; generation: number; message: string };

interface ReaderRun {
  generation: number;
  frame: number;
  sources: MusicSource[];
  controller: AbortController;
  queued: number;
  credits: number;
  pumping: boolean;
}

export function musicAborted(): DOMException {
  return new DOMException('Music operation cancelled', 'AbortError');
}

/** Read one exact bounded response; HTML/error bodies or ignored Range requests are not PCM. */
export async function readMusicBytes(response: Response, length: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Music response has no readable body.');
  const output = new Uint8Array(length);
  let offset = 0;
  let ended = false;
  try {
    await whileSerial(
      () => !ended,
      async () => {
        const next = await reader.read();
        if (next.done) {
          ended = true;
          return;
        }
        if (next.value.length > length - offset) throw new Error('Music response exceeds its declared bounded range.');
        output.set(next.value, offset);
        offset += next.value.length;
      },
    );
    if (offset !== length) throw new Error('Music response ended before its complete PCM range.');
    return output.buffer;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function fetchMusic(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    if (init.method === 'HEAD')
      throw new Error(
        `Music request failed (${response.status}). Check source availability and prepare the current music cache explicitly.`,
      );
    const message = await readMusicBytes(
      response,
      Math.min(Number(response.headers.get('content-length')) || 0, 16_384),
    );
    let error = `Music request failed (${response.status}).`;
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(message));
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') error = body.error;
    } catch {
      /* Keep the actual HTTP failure, not an audio default. */
    }
    throw new Error(error);
  }
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream') {
    await response.body?.cancel();
    throw new Error('Music response is not the current PCM16 stream.');
  }
  return response;
}

/**
 * Serial bounded range reads, mixing and credit-controlled refill. It runs in a
 * dedicated worker that transfers blocks straight to the worklet, so long
 * main-thread rendering tasks cannot delay audio refills.
 */
export class MusicReader {
  readonly #report: (message: MusicReaderReport, transfer?: Transferable[]) => void;
  #port: MessagePort | null = null;
  #run: ReaderRun | null = null;

  constructor(report: (message: MusicReaderReport, transfer?: Transferable[]) => void) {
    this.#report = report;
  }

  receive(command: MusicReaderCommand): void {
    if (command.kind === 'connect') {
      this.#port = command.port;
      this.#port.onmessage = ({ data }: MessageEvent) => this.#credit(data);
    } else if (command.kind === 'stop') {
      if (this.#run?.generation === command.generation) this.#cancel();
    } else void this.#prefill(command);
  }

  #cancel(): void {
    const run = this.#run;
    this.#run = null;
    run?.controller.abort();
  }
  #requireCurrent(run: ReaderRun): void {
    if (run.controller.signal.aborted || this.#run !== run) throw musicAborted();
  }
  #fail(run: ReaderRun, error: unknown): void {
    if (this.#run !== run || run.controller.signal.aborted) return;
    this.#cancel();
    this.#report({
      kind: 'failed',
      generation: run.generation,
      message: error instanceof Error ? error.message : 'Music range read failed.',
    });
  }
  async #prefill(command: Extract<MusicReaderCommand, { kind: 'prefill' }>): Promise<void> {
    this.#cancel();
    const run: ReaderRun = {
      generation: command.generation,
      frame: command.frame,
      sources: command.sources,
      controller: new AbortController(),
      queued: 0,
      credits: 0,
      pumping: false,
    };
    this.#run = run;
    try {
      const chunks: MusicChunk[] = [];
      await forEachSerial(Array.from({ length: MUSIC_QUEUE_CHUNKS }), async () => {
        chunks.push(await this.#readChunk(run));
      });
      this.#requireCurrent(run);
      this.#report(
        { kind: 'prefilled', generation: run.generation, chunks },
        chunks.map((chunk) => chunk.data.buffer),
      );
    } catch (error) {
      this.#fail(run, error);
    }
  }
  #credit(data: { kind?: unknown; generation?: unknown; count?: unknown }): void {
    const run = this.#run;
    if (data.kind !== 'credit' || !run || data.generation !== run.generation || run.controller.signal.aborted) return;
    const count = data.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || run.credits + count > MUSIC_QUEUE_CHUNKS)
      this.#fail(run, new Error('Music stream exceeded its bounded read credits.'));
    else {
      run.credits += count;
      void this.#pump(run);
    }
  }
  async #readRange(run: ReaderRun, source: MusicSource, from: number, samples: number): Promise<ArrayBuffer> {
    if (from + samples > source.samples) throw new Error('Music range exceeds its prepared source samples.');
    const begin = from * MUSIC_BYTES_PER_SAMPLE;
    const length = samples * MUSIC_BYTES_PER_SAMPLE;
    const response = await fetchMusic(
      source.url,
      { headers: { Range: `bytes=${begin}-${begin + length - 1}` } },
      run.controller.signal,
    );
    if (
      response.status !== 206 ||
      response.headers.get('content-range') !==
        `bytes ${begin}-${begin + length - 1}/${source.samples * MUSIC_BYTES_PER_SAMPLE}` ||
      Number(response.headers.get('content-length')) !== length
    ) {
      await response.body?.cancel();
      throw new Error('Music server did not return the requested exact bounded PCM16 range.');
    }
    return readMusicBytes(response, length);
  }
  async #mixTrack(run: ReaderRun, source: MusicSource, data: Float32Array<ArrayBuffer>): Promise<void> {
    const { track } = source;
    const offset = run.queued;
    const sourceIn = Math.round(track.sourceIn * MUSIC_SAMPLES_PER_FRAME);
    const selectedSamples = Math.round(track.sourceOut * MUSIC_SAMPLES_PER_FRAME) - sourceIn;
    let loopBytes: ArrayBuffer | null = null;
    let filled = 0;
    await whileSerial(
      () => filled < MUSIC_CHUNK_SAMPLES,
      async () => {
        this.#requireCurrent(run);
        const frame = run.frame + (offset + filled) / MUSIC_SAMPLES_PER_FRAME;
        const read = musicReadAt(track, frame, MUSIC_CHUNK_SAMPLES - filled);
        if (read.source !== null) {
          let bytes: ArrayBuffer | DataView<ArrayBuffer>;
          if (track.loop && selectedSamples <= MUSIC_CHUNK_SAMPLES) {
            // Reuse a bounded short selection only within this block. Each refill
            // still makes a fresh identity-guarded read, not one request per wrap.
            loopBytes ??= await this.#readRange(run, source, sourceIn, selectedSamples);
            const begin = (read.source - sourceIn) * MUSIC_BYTES_PER_SAMPLE;
            bytes = new DataView(loopBytes, begin, read.samples * MUSIC_BYTES_PER_SAMPLE);
          } else bytes = await this.#readRange(run, source, read.source, read.samples);
          this.#requireCurrent(run);
          accumulateMusicRange(data, bytes, track, frame, filled);
        }
        filled += read.samples;
      },
    );
  }
  async #readChunk(run: ReaderRun): Promise<MusicChunk> {
    const offset = run.queued;
    const data = new Float32Array(MUSIC_CHUNK_SAMPLES * MUSIC_CHANNELS);
    // One mixed block and one <=64 KiB read/short-loop scratch, not eight queues.
    await forEachSerial(run.sources, async (source) => {
      this.#requireCurrent(run);
      await this.#mixTrack(run, source, data);
    });
    this.#requireCurrent(run);
    clampMusicMix(data);
    run.queued += MUSIC_CHUNK_SAMPLES;
    return { offset, data };
  }
  async #pump(run: ReaderRun): Promise<void> {
    if (run.pumping) return;
    run.pumping = true;
    try {
      await whileSerial(
        () => run.credits > 0,
        async () => {
          this.#requireCurrent(run);
          run.credits--;
          const chunk = await this.#readChunk(run);
          this.#requireCurrent(run);
          if (!this.#port) throw new Error('Music reader is not connected to the audio worklet.');
          this.#port.postMessage({ kind: 'chunk', generation: run.generation, chunk }, [chunk.data.buffer]);
        },
      );
    } catch (error) {
      this.#fail(run, error);
    } finally {
      run.pumping = false;
    }
  }
}
