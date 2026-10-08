import { MUSIC_SAMPLE_RATE, type MusicChunk } from '../shared/music-format.js';
import { MusicRenderer } from './music-renderer.js';

declare const currentFrame: number;
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class StreamingMusicProcessor extends AudioWorkletProcessor {
  #renderer: MusicRenderer | null = null;
  #reader: MessagePort | null = null;
  #generation = 0;
  #startFrame = 0;
  #contextStart: number | null = null;
  #receiptPending = false;
  #disposed = false;
  constructor() {
    super();
    this.port.onmessage = ({ data }) =>
      this.#guard(data.generation, () => {
        if (data.kind === 'dispose') {
          this.#renderer = null;
          this.#disposed = true;
          return;
        }
        if (data.kind === 'connect') {
          // Credits and refill blocks bypass the main thread through the reader worker.
          this.#reader = data.port as MessagePort;
          this.#reader.onmessage = ({ data: refill }) =>
            this.#guard(refill.generation, () => {
              if (refill.kind === 'chunk') this.#update(refill);
            });
          return;
        }
        if (data.kind === 'start') {
          if (sampleRate !== MUSIC_SAMPLE_RATE) throw new Error('Music requires a 48 kHz rendering context.');
          if (!this.#reader) throw new Error('Music reader is not connected.');
          this.#generation = data.generation;
          this.#startFrame = data.frame;
          this.#contextStart = null;
          this.#receiptPending = false;
          this.#renderer = new MusicRenderer();
          for (const chunk of data.chunks as MusicChunk[]) this.#renderer.enqueue(chunk);
        } else this.#update(data);
      });
  }
  #guard(generation: number, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.#renderer = null;
      this.port.postMessage({
        kind: 'failed',
        generation,
        message: error instanceof Error ? error.message : 'Music rendering failed.',
      });
    }
  }
  #update(data: { generation: number; kind: string; chunk: MusicChunk }): void {
    if (data.generation !== this.#generation) return;
    switch (data.kind) {
      case 'chunk':
        this.#renderer?.enqueue(data.chunk);
        break;
      case 'ack':
        this.#receiptPending = false;
        break;
      case 'stop':
        this.#renderer = null;
        break;
    }
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const renderer = this.#renderer;
    const left = outputs[0]?.[0];
    const right = outputs[0]?.[1];
    if (!renderer || !left || !right) return !this.#disposed;
    const starting = this.#contextStart === null;
    if (this.#contextStart === null) {
      this.#contextStart = currentFrame;
    }
    const result = renderer.render(left, right);
    if (starting && !result.underrun) {
      this.port.postMessage({
        kind: 'started',
        generation: this.#generation,
        contextStart: this.#contextStart,
        startFrame: this.#startFrame,
        contextFrame: currentFrame + left.length,
        samples: renderer.played,
      });
    }
    if (result.released)
      this.#reader?.postMessage({ kind: 'credit', generation: this.#generation, count: result.released });
    if (result.underrun) {
      this.port.postMessage({ kind: 'underrun', generation: this.#generation });
      this.#renderer = null;
    } else if (!this.#receiptPending) {
      // One unacknowledged receipt, not an unbounded message per render quantum.
      this.#receiptPending = true;
      this.port.postMessage({
        kind: 'rendered',
        generation: this.#generation,
        startFrame: this.#startFrame,
        contextFrame: currentFrame + left.length,
        samples: renderer.played,
        queued: renderer.queued,
      });
    }
    return !this.#disposed;
  }
}

registerProcessor('pascap-streaming-music', StreamingMusicProcessor);
