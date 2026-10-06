import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUSIC_CHUNK_SAMPLES, MUSIC_SAMPLE_RATE, type MusicChunk } from '../../src/shared/music-format.js';

interface Processor {
  port: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let processor: Processor;
function send(data: object): void {
  processor.port.onmessage!({ data } as MessageEvent);
}
function chunks(count = 4): MusicChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    offset: index * MUSIC_CHUNK_SAMPLES,
    data: new Float32Array(MUSIC_CHUNK_SAMPLES * 2).fill((index + 1) / 8),
  }));
}
function render(frame: number, length = 128): Float32Array[] {
  vi.stubGlobal('currentFrame', frame);
  const output = [new Float32Array(length), new Float32Array(length)];
  expect(processor.process([], [output])).toBe(true);
  return output;
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('sampleRate', MUSIC_SAMPLE_RATE);
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      readonly port = { onmessage: null, postMessage: vi.fn() };
    },
  );
  let Constructor!: new () => Processor;
  vi.stubGlobal(
    'registerProcessor',
    vi.fn((name: string, value: new () => Processor) => {
      expect(name).toBe('pascap-streaming-music');
      Constructor = value;
    }),
  );
  await import('../../src/preview/music-worklet.js');
  processor = new Constructor();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('actual streaming worklet protocol', () => {
  it('anchors to its first real rendered block and limits receipts to one unacknowledged message', () => {
    send({ kind: 'start', generation: 7, frame: 40, chunks: chunks() });
    expect(render(1000)[0]!.every((value) => value === 0.125)).toBe(true);
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      kind: 'started',
      generation: 7,
      contextStart: 1000,
      startFrame: 40,
      contextFrame: 1128,
      samples: 128,
    });
    render(1128);
    render(1256);
    expect(processor.port.postMessage.mock.calls.filter(([message]) => message.kind === 'rendered')).toHaveLength(1);
    send({ kind: 'ack', generation: 7 });
    render(1384);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({
      kind: 'rendered',
      generation: 7,
      startFrame: 40,
      contextFrame: 1512,
      samples: 512,
    });
  });
  it('releases bounded refill credits, reports a real underrun and cannot consume across it', () => {
    send({ kind: 'start', generation: 2, frame: 0, chunks: chunks(1) });
    render(0, MUSIC_CHUNK_SAMPLES);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ kind: 'credit', generation: 2, count: 1 });
    expect(render(MUSIC_CHUNK_SAMPLES)[0]!.every((value) => value === 0)).toBe(true);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ kind: 'underrun', generation: 2 });
    const receipts = processor.port.postMessage.mock.calls.length;
    render(MUSIC_CHUNK_SAMPLES + 128);
    expect(processor.port.postMessage.mock.calls).toHaveLength(receipts);
  });
  it('discards stopped and obsolete epochs and restarts exactly at the deliberate new render origin', () => {
    send({ kind: 'start', generation: 1, frame: 0, chunks: chunks() });
    render(0);
    send({ kind: 'stop', generation: 1 });
    expect(render(128)[0]!.every((value) => value === 0)).toBe(true);
    send({ kind: 'start', generation: 2, frame: 40, chunks: chunks() });
    send({ kind: 'stop', generation: 1 });
    send({ kind: 'chunk', generation: 1, chunk: chunks(1)[0] });
    render(256);
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      kind: 'started',
      generation: 2,
      contextStart: 256,
      startFrame: 40,
      contextFrame: 384,
      samples: 128,
    });
    send({ kind: 'dispose' });
    expect(processor.process([], [[new Float32Array(128), new Float32Array(128)]])).toBe(false);
  });
  it('reports malformed blocks with the actual error instead of starting an invalid source', () => {
    send({ kind: 'start', generation: 3, frame: 0, chunks: [{ offset: 0, data: new Float32Array(4) }] });
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      kind: 'failed',
      generation: 3,
      message: 'Music blocks must be bounded, consecutive and credit-controlled.',
    });
    expect(render(0)[0]!.every((value) => value === 0)).toBe(true);
  });
});
