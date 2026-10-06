import type { MusicTrack } from '../shared/model.js';
import {
  decodeMusicRange,
  MUSIC_BYTES_PER_SAMPLE,
  MUSIC_CHANNELS,
  MUSIC_CHUNK_SAMPLES,
  MUSIC_QUEUE_CHUNKS,
  MUSIC_SAMPLE_RATE,
  MUSIC_SAMPLES_PER_FRAME,
  musicReadAt,
  type MusicChunk,
} from '../shared/music-stream.js';
import { forEachSerial, whileSerial } from '../shared/serial.js';
import workletUrl from './music-worklet.ts?worker&url';

interface PlaybackRun {
  generation: number;
  frame: number;
  controller: AbortController;
  detach: () => void;
  queued: number;
  credits: number;
  pumping: boolean;
  underrun: boolean;
  error: Error | null;
  contextStart: number | null;
  started: ((contextStart: number) => void) | null;
  cancelled: ((error?: Error) => void) | null;
}

function aborted(): DOMException {
  return new DOMException('Music operation cancelled', 'AbortError');
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal, deadlineMessage?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = (): void =>
      reject(
        signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
          ? new Error(deadlineMessage ?? 'Music operation did not become ready within 10 seconds.')
          : aborted(),
      );
    signal.addEventListener('abort', cancel, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

/** A render origin is not audible until the output device has reached it. */
async function waitForOutput(context: AudioContext, origin: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let callback = 0;
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      cancelAnimationFrame(callback);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve();
    };
    const cancel = (): void => finish(aborted());
    const timeout = setTimeout(
      () => finish(new Error('Music output did not reach its rendered source within 5 seconds.')),
      5_000,
    );
    const check = (): void => {
      if (signal.aborted) {
        cancel();
        return;
      }
      const timestamp = context.getOutputTimestamp();
      if (timestamp.performanceTime! > 0 && timestamp.contextTime! >= origin) {
        finish();
        return;
      }
      callback = requestAnimationFrame(check);
    };
    signal.addEventListener('abort', cancel, { once: true });
    check();
  });
}

/** Read one exact bounded response; HTML/error bodies or ignored Range requests are not PCM. */
async function readBytes(response: Response, length: number): Promise<ArrayBuffer> {
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

export class MusicPlayback {
  #context: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #setupPromise: Promise<void> | null = null;
  #processorError: Error | null = null;
  #track: MusicTrack | null = null;
  #samples = 0;
  #run: PlaybackRun | null = null;
  #running = false;
  #clockTime = 0;
  #clockFrame = 0;
  #lastPosition = 0;
  #disposed = false;
  #lastErrorFrames = 0;
  #generation = 0;

  get clockSeconds(): number {
    if (!this.#context) return performance.now() / 1000;
    const time = this.#context.getOutputTimestamp().contextTime;
    if (time === undefined || !Number.isFinite(time) || time < 0)
      throw new Error('Music output has an invalid presentation clock.');
    return time;
  }
  get errorFrames(): number {
    return this.#lastErrorFrames;
  }
  get hasMusic(): boolean {
    return this.#track !== null;
  }
  #url(): string {
    return new URL(`/api/audio/${this.#track!.mediaId}/playback`, location.href).href;
  }
  #requireCurrent(signal: AbortSignal, generation: number): void {
    if (signal.aborted || this.#disposed || generation !== this.#generation) throw aborted();
  }
  async #fetch(init: RequestInit, signal: AbortSignal): Promise<Response> {
    const response = await fetch(this.#url(), {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      if (init.method === 'HEAD')
        throw new Error(
          `Music request failed (${response.status}). Check source availability and prepare the current music cache explicitly.`,
        );
      const message = await readBytes(response, Math.min(Number(response.headers.get('content-length')) || 0, 16_384));
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
  async configure(track: MusicTrack | null, signal: AbortSignal): Promise<void> {
    this.pause();
    this.#track = track ? { ...track } : null;
    this.#samples = 0;
    this.#lastErrorFrames = 0;
    const generation = this.#generation;
    if (!track) return;
    const response = await this.#fetch({ method: 'HEAD' }, signal);
    this.#requireCurrent(signal, generation);
    const samples = Number(response.headers.get('content-length')) / MUSIC_BYTES_PER_SAMPLE;
    if (
      !Number.isSafeInteger(samples) ||
      samples <= 0 ||
      samples < Math.round(track.sourceOut * MUSIC_SAMPLES_PER_FRAME)
    )
      throw new Error('Music exceeds the complete prepared PCM16 sample range.');
    this.#samples = samples;
  }
  async #setup(): Promise<void> {
    if (!this.#context) this.#context = new AudioContext({ sampleRate: MUSIC_SAMPLE_RATE });
    this.#setupPromise ??= this.#context.audioWorklet.addModule(workletUrl).then(() => {
      if (this.#disposed) throw aborted();
      this.#node = new AudioWorkletNode(this.#context!, 'pascap-streaming-music', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [MUSIC_CHANNELS],
      });
      this.#node.port.onmessage = this.#onMessage;
      this.#node.onprocessorerror = () => {
        this.#processorError = new Error('Music audio processor failed. Reload the editor before restarting preview.');
        if (this.#run) this.#fail(this.#run, this.#processorError);
      };
      this.#node.connect(this.#context!.destination);
    });
    await this.#setupPromise;
  }
  async resumeContext(signal?: AbortSignal): Promise<void> {
    if (!this.#track) return;
    const generation = this.#generation;
    const deadline = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]);
    await abortable(this.#setup(), deadline, 'Music audio module did not load within 10 seconds.');
    this.#requireCurrent(deadline, generation);
    await abortable(this.#context!.resume(), deadline, 'Music audio context did not resume within 10 seconds.');
    this.#requireCurrent(deadline, generation);
  }
  #fail(run: PlaybackRun, error: Error): void {
    run.error = error;
    run.cancelled?.(error);
    run.controller.abort();
    this.#node?.port.postMessage({ kind: 'stop', generation: run.generation });
  }
  async #readRange(run: PlaybackRun, source: number, samples: number): Promise<ArrayBuffer> {
    if (source + samples > this.#samples) throw new Error('Music range exceeds its prepared source samples.');
    const begin = source * MUSIC_BYTES_PER_SAMPLE;
    const length = samples * MUSIC_BYTES_PER_SAMPLE;
    const response = await this.#fetch(
      { headers: { Range: `bytes=${begin}-${begin + length - 1}` } },
      run.controller.signal,
    );
    if (
      response.status !== 206 ||
      response.headers.get('content-range') !==
        `bytes ${begin}-${begin + length - 1}/${this.#samples * MUSIC_BYTES_PER_SAMPLE}` ||
      Number(response.headers.get('content-length')) !== length
    ) {
      await response.body?.cancel();
      throw new Error('Music server did not return the requested exact bounded PCM16 range.');
    }
    return readBytes(response, length);
  }
  async #readChunk(run: PlaybackRun): Promise<MusicChunk> {
    const track = this.#track!;
    const offset = run.queued;
    const data = new Float32Array(MUSIC_CHUNK_SAMPLES * MUSIC_CHANNELS);
    const sourceIn = Math.round(track.sourceIn * MUSIC_SAMPLES_PER_FRAME);
    const selectedSamples = Math.round(track.sourceOut * MUSIC_SAMPLES_PER_FRAME) - sourceIn;
    let loopBytes: ArrayBuffer | null = null;
    let filled = 0;
    await whileSerial(
      () => filled < MUSIC_CHUNK_SAMPLES,
      async () => {
        this.#requireCurrent(run.controller.signal, run.generation);
        const frame = run.frame + (offset + filled) / MUSIC_SAMPLES_PER_FRAME;
        const read = musicReadAt(track, frame, MUSIC_CHUNK_SAMPLES - filled);
        if (read.source !== null) {
          let bytes: ArrayBuffer | DataView<ArrayBuffer>;
          if (track.loop && selectedSamples <= MUSIC_CHUNK_SAMPLES) {
            // Reuse a bounded short selection only within this block. Each refill
            // still makes a fresh identity-guarded read, not one request per wrap.
            loopBytes ??= await this.#readRange(run, sourceIn, selectedSamples);
            const begin = (read.source - sourceIn) * MUSIC_BYTES_PER_SAMPLE;
            bytes = new DataView(loopBytes, begin, read.samples * MUSIC_BYTES_PER_SAMPLE);
          } else bytes = await this.#readRange(run, read.source, read.samples);
          this.#requireCurrent(run.controller.signal, run.generation);
          data.set(decodeMusicRange(bytes, track, frame), filled * MUSIC_CHANNELS);
        }
        filled += read.samples;
      },
    );
    run.queued += MUSIC_CHUNK_SAMPLES;
    return { offset, data };
  }
  async #pump(run: PlaybackRun): Promise<void> {
    if (run.pumping) return;
    run.pumping = true;
    try {
      await whileSerial(
        () => run.credits > 0,
        async () => {
          this.#requireCurrent(run.controller.signal, run.generation);
          run.credits--;
          const chunk = await this.#readChunk(run);
          this.#requireCurrent(run.controller.signal, run.generation);
          this.#node!.port.postMessage({ kind: 'chunk', generation: run.generation, chunk }, [chunk.data.buffer]);
        },
      );
    } catch (error) {
      if (this.#run === run && !run.controller.signal.aborted)
        this.#fail(run, error instanceof Error ? error : new Error('Music range read failed.'));
    } finally {
      run.pumping = false;
    }
  }
  #acceptReceipt(run: PlaybackRun, data: { startFrame: number; contextFrame: number; samples: number }): void {
    // Actual consumed samples and an independent rendering timestamp, not a
    // second reading of an approximate HTMLMediaElement position.
    if (
      run.contextStart === null ||
      data.startFrame !== run.frame ||
      !Number.isSafeInteger(data.contextFrame) ||
      !Number.isFinite(data.samples) ||
      data.samples < 0 ||
      data.samples > run.queued
    )
      this.#fail(run, new Error('Music rendered an invalid sample-clock receipt.'));
    else
      this.#lastErrorFrames = Math.abs(data.samples - (data.contextFrame - run.contextStart)) / MUSIC_SAMPLES_PER_FRAME;
    this.#node!.port.postMessage({ kind: 'ack', generation: run.generation });
  }
  readonly #onMessage = ({ data }: MessageEvent): void => {
    const run = this.#run;
    if (!run || data.generation !== run.generation || run.controller.signal.aborted) return;
    if (data.kind === 'started') {
      if (!Number.isSafeInteger(data.contextStart) || data.contextStart < 0)
        this.#fail(run, new Error('Music rendered an invalid clock origin.'));
      else {
        run.contextStart = data.contextStart;
        run.started?.(data.contextStart);
      }
    }
    if (data.kind === 'credit') {
      if (!Number.isInteger(data.count) || data.count < 1 || run.credits + data.count > MUSIC_QUEUE_CHUNKS)
        this.#fail(run, new Error('Music stream exceeded its bounded read credits.'));
      else {
        run.credits += data.count;
        void this.#pump(run);
      }
    }
    if (data.kind === 'rendered') this.#acceptReceipt(run, data);
    if (data.kind === 'underrun') {
      run.underrun = true;
      if (this.#running) run.controller.abort();
      else this.#fail(run, new Error('Music stream underrun before source output became ready.'));
    }
    if (data.kind === 'failed') this.#fail(run, new Error(data.message));
  };
  async start(frame: number, signal: AbortSignal): Promise<void> {
    if (this.#disposed) return;
    this.pause();
    const generation = this.#generation;
    this.#requireCurrent(signal, generation);
    if (!this.#track) {
      this.#clockFrame = frame;
      this.#clockTime = this.clockSeconds;
      this.#running = true;
      return;
    }
    if (this.#processorError) throw this.#processorError;
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
      run.cancelled?.();
    };
    const run: PlaybackRun = {
      generation,
      frame,
      controller,
      detach: () => signal.removeEventListener('abort', cancel),
      queued: 0,
      credits: 0,
      pumping: false,
      underrun: false,
      error: null,
      contextStart: null,
      started: null,
      cancelled: null,
    };
    this.#lastErrorFrames = 0;
    signal.addEventListener('abort', cancel, { once: true });
    this.#run = run;
    const preparationTimeout = setTimeout(
      () => this.#fail(run, new Error('Music did not become ready within 10 seconds.')),
      10_000,
    );
    try {
      await abortable(this.resumeContext(controller.signal), controller.signal);
      this.#requireCurrent(controller.signal, generation);
      const chunks: MusicChunk[] = [];
      await forEachSerial(Array.from({ length: MUSIC_QUEUE_CHUNKS }), async () => {
        chunks.push(await this.#readChunk(run));
      });
      this.#requireCurrent(controller.signal, generation);
      const contextStart = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          finish();
          reject(new Error('Music did not render its first sample within 5 seconds.'));
        }, 5_000);
        const finish = (): void => {
          clearTimeout(timeout);
          run.started = null;
          run.cancelled = null;
        };
        run.started = (value) => {
          finish();
          resolve(value);
        };
        run.cancelled = (error?: Error) => {
          finish();
          reject(error ?? aborted());
        };
        this.#node!.port.postMessage(
          { kind: 'start', generation, frame, chunks },
          chunks.map((chunk) => chunk.data.buffer),
        );
      });
      this.#requireCurrent(controller.signal, generation);
      const origin = contextStart / MUSIC_SAMPLE_RATE;
      await waitForOutput(this.#context!, origin, controller.signal);
      this.#requireCurrent(controller.signal, generation);
      this.#clockFrame = frame;
      this.#clockTime = origin;
      this.#running = true;
    } catch (error) {
      if (this.#run === run) this.pause();
      throw run.error ?? error;
    } finally {
      clearTimeout(preparationTimeout);
    }
  }
  #projectPosition(): number {
    const position =
      this.#clockFrame +
      (this.#running
        ? (Math.max(0, this.clockSeconds - this.#clockTime) * MUSIC_SAMPLE_RATE) / MUSIC_SAMPLES_PER_FRAME
        : 0);
    this.#lastPosition = position;
    return position;
  }
  projectFrame(): number {
    return Math.floor(this.#projectPosition() + 1e-7);
  }
  sync(): boolean {
    if (this.#run?.error) throw this.#run.error;
    if (!this.#track || !this.#running) return true;
    if (this.#context!.state !== 'running')
      throw new Error('Music audio context stopped unexpectedly. Retry preview explicitly.');
    return !this.#run?.underrun && this.#lastErrorFrames <= 1;
  }
  pause(): void {
    if (this.#running) {
      try {
        this.#clockFrame = this.#projectPosition();
      } catch {
        this.#clockFrame = this.#lastPosition;
      } // A failed clock must not prevent owned cancellation/cleanup.
    }
    this.#running = false;
    const run = this.#run;
    this.#run = null;
    if (run) {
      run.detach();
      run.controller.abort();
      run.cancelled?.();
      this.#node?.port.postMessage({ kind: 'stop', generation: run.generation });
    }
    this.#generation++;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.pause();
    this.#disposed = true;
    this.#track = null;
    if (this.#node) {
      this.#node.port.postMessage({ kind: 'dispose' });
      this.#node.port.onmessage = null;
      this.#node.port.close();
      this.#node.disconnect();
    }
    void this.#context?.close();
  }
}
