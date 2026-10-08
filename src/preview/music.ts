import { musicTracksSchema, type MusicTrack } from '../shared/model.js';
import {
  MUSIC_BYTES_PER_SAMPLE,
  MUSIC_CHANNELS,
  MUSIC_SAMPLE_RATE,
  MUSIC_SAMPLES_PER_FRAME,
  type MusicChunk,
} from '../shared/music-stream.js';
import { forEachSerial } from '../shared/serial.js';
import readerUrl from './music-reader.ts?worker&url';
import {
  fetchMusic,
  musicAborted as aborted,
  type MusicReaderCommand,
  type MusicReaderReport,
  type MusicSource,
} from './music-source.js';
import workletUrl from './music-worklet.ts?worker&url';

interface PlaybackRun {
  generation: number;
  frame: number;
  controller: AbortController;
  detach: () => void;
  underrun: boolean;
  error: Error | null;
  contextStart: number | null;
  prefilled: ((chunks: MusicChunk[]) => void) | null;
  started: ((contextStart: number) => void) | null;
  cancelled: ((error?: Error) => void) | null;
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

export class MusicPlayback {
  #context: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #reader: Worker | null = null;
  #setupPromise: Promise<void> | null = null;
  #processorError: Error | null = null;
  #readerError: Error | null = null;
  #tracks: MusicSource[] = [];
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
    return this.#tracks.length > 0;
  }
  #url(track: MusicTrack): string {
    return new URL(`/api/audio/${track.mediaId}/playback`, location.href).href;
  }
  #requireCurrent(signal: AbortSignal, generation: number): void {
    if (signal.aborted || this.#disposed || generation !== this.#generation) throw aborted();
  }
  async configure(tracks: readonly MusicTrack[], signal: AbortSignal): Promise<void> {
    this.pause();
    this.#tracks = [];
    this.#lastErrorFrames = 0;
    const generation = this.#generation;
    const snapshot = musicTracksSchema.parse(tracks);
    const configured: MusicSource[] = [];
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    await forEachSerial(snapshot, async (track) => {
      this.#requireCurrent(deadline, generation);
      const url = this.#url(track);
      const response = await abortable(fetchMusic(url, { method: 'HEAD' }, deadline), deadline);
      this.#requireCurrent(deadline, generation);
      const samples = Number(response.headers.get('content-length')) / MUSIC_BYTES_PER_SAMPLE;
      if (
        !Number.isSafeInteger(samples) ||
        samples <= 0 ||
        samples < Math.round(track.sourceOut * MUSIC_SAMPLES_PER_FRAME)
      )
        throw new Error(`Music instance ${track.id} exceeds the complete prepared PCM16 sample range.`);
      configured.push({ track, samples, url });
    });
    this.#requireCurrent(signal, generation);
    this.#tracks = configured;
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
      // Refills travel worker-to-worklet: preview rendering on this thread cannot delay them.
      const channel = new MessageChannel();
      this.#reader = new Worker(readerUrl, { type: 'module', name: 'pascap-music-reader' });
      this.#reader.onmessage = this.#onReaderMessage;
      this.#reader.onerror = () => {
        this.#readerError = new Error('Music reader failed. Reload the editor before restarting preview.');
        if (this.#run) this.#fail(this.#run, this.#readerError);
      };
      this.#node.port.postMessage({ kind: 'connect', port: channel.port1 }, [channel.port1]);
      this.#command({ kind: 'connect', port: channel.port2 }, [channel.port2]);
    });
    await this.#setupPromise;
  }
  #command(command: MusicReaderCommand, transfer: Transferable[] = []): void {
    this.#reader?.postMessage(command, transfer);
  }
  async resumeContext(signal?: AbortSignal): Promise<void> {
    if (!this.hasMusic) return;
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
  #acceptReceipt(
    run: PlaybackRun,
    data: { startFrame: number; contextFrame: number; samples: number; queued: number },
  ): void {
    // Actual consumed samples and an independent rendering timestamp, not a
    // second reading of an approximate HTMLMediaElement position.
    if (
      run.contextStart === null ||
      data.startFrame !== run.frame ||
      !Number.isSafeInteger(data.contextFrame) ||
      !Number.isSafeInteger(data.queued) ||
      !Number.isFinite(data.samples) ||
      data.samples < 0 ||
      data.samples > data.queued
    )
      this.#fail(run, new Error('Music rendered an invalid sample-clock receipt.'));
    else
      this.#lastErrorFrames = Math.abs(data.samples - (data.contextFrame - run.contextStart)) / MUSIC_SAMPLES_PER_FRAME;
    this.#node!.port.postMessage({ kind: 'ack', generation: run.generation });
  }
  readonly #onReaderMessage = ({ data }: MessageEvent<MusicReaderReport>): void => {
    const run = this.#run;
    if (run?.generation !== data.generation || run.controller.signal.aborted) return;
    if (data.kind === 'prefilled') run.prefilled?.(data.chunks);
    else this.#fail(run, new Error(data.message));
  };
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
    if (!this.hasMusic) {
      this.#clockFrame = frame;
      this.#clockTime = this.clockSeconds;
      this.#running = true;
      return;
    }
    if (this.#processorError) throw this.#processorError;
    if (this.#readerError) throw this.#readerError;
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
      underrun: false,
      error: null,
      contextStart: null,
      prefilled: null,
      started: null,
      cancelled: null,
    };
    this.#lastErrorFrames = 0;
    signal.addEventListener('abort', cancel, { once: true });
    controller.signal.addEventListener('abort', () => this.#command({ kind: 'stop', generation }), { once: true });
    this.#run = run;
    const preparationTimeout = setTimeout(
      () => this.#fail(run, new Error('Music did not become ready within 10 seconds.')),
      10_000,
    );
    try {
      await abortable(this.resumeContext(controller.signal), controller.signal);
      this.#requireCurrent(controller.signal, generation);
      const chunks = await new Promise<MusicChunk[]>((resolve, reject) => {
        const finish = (): void => {
          run.prefilled = null;
          run.cancelled = null;
        };
        run.prefilled = (value) => {
          finish();
          resolve(value);
        };
        run.cancelled = (error?: Error) => {
          finish();
          reject(error ?? aborted());
        };
        this.#command({ kind: 'prefill', generation, frame, sources: this.#tracks });
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
    if (!this.hasMusic || !this.#running) return true;
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
    this.#tracks = [];
    if (this.#node) {
      this.#node.port.postMessage({ kind: 'dispose' });
      this.#node.port.onmessage = null;
      this.#node.port.close();
      this.#node.disconnect();
    }
    if (this.#reader) {
      this.#reader.onmessage = null;
      this.#reader.terminate();
    }
    void this.#context?.close();
  }
}
