import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECODER_FRAME_BUDGET, type VideoReaderReport } from '../../src/preview/video-protocol.js';
import { VideoReader, type DecoderPlatform } from '../../src/preview/video-source.js';
import { buildProxy } from './proxy-fixture.js';

interface FakeFrame {
  timestamp: number;
  closed: boolean;
  close(): void;
}

class FakeChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly byteLength: number;
  readonly first: number;
  constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    const data = init.data as Uint8Array;
    this.byteLength = data.byteLength;
    this.first = data[0]!;
  }
}

/** Decodes in order and outputs each frame on a later task, as a platform decoder does. */
class FakeDecoder {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  ondequeue: (() => void) | null = null;
  config: VideoDecoderConfig | null = null;
  readonly chunks: FakeChunk[] = [];
  #pending = 0;
  constructor(readonly init: VideoDecoderInit) {}
  configure(config: VideoDecoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }
  decode(chunk: FakeChunk): void {
    if (this.state !== 'configured') throw new Error('Decoder is not configured.');
    if (!this.chunks.length && chunk.type !== 'key') throw new Error('A key chunk must come first.');
    expect(chunk.first).toBe(chunk.timestamp & 0xff);
    this.chunks.push(chunk);
    this.#pending++;
    setTimeout(() => {
      this.#pending--;
      if (this.state !== 'configured') return;
      const frame: FakeFrame = {
        timestamp: chunk.timestamp,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      frames.push(frame);
      this.init.output(frame as unknown as VideoFrame);
      this.ondequeue?.();
    }, 0);
  }
  async flush(): Promise<void> {
    while (this.#pending) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  close(): void {
    this.state = 'closed';
  }
}

let frames: FakeFrame[] = [];
let decoders: FakeDecoder[] = [];
let reports: VideoReaderReport[] = [];
let requests: string[] = [];
let supported = true;
let file = buildProxy({ frames: 60 });

const platform: DecoderPlatform = {
  async fetch(url, init) {
    const range = (init.headers as Record<string, string>)['Range']!;
    requests.push(`${url} ${range}`);
    if (url.endsWith('/missing')) return Response.json({ error: 'The proxy is not verified and ready.' }, { status: 409 });
    if (url.endsWith('/whole')) return new Response(file.bytes, { status: 200 });
    const [start, end] = /bytes=(\d+)-(\d+)/.exec(range)!.slice(1).map(Number) as [number, number];
    return new Response(file.bytes.slice(start, Math.min(end + 1, file.bytes.length)), { status: 206 });
  },
  createDecoder(init) {
    const decoder = new FakeDecoder(init);
    decoders.push(decoder);
    return decoder as unknown as VideoDecoder;
  },
  supported: async () => supported,
};

function reader(): VideoReader {
  return new VideoReader(platform, (message) => reports.push(message));
}
function delivered(lane = 0): number[] {
  return reports.flatMap((report) =>
    report.kind === 'frame' && report.lane === lane ? [report.sourceFrame] : [],
  );
}
function failures(): string[] {
  return reports.flatMap((report) => (report.kind === 'failed' ? [report.message] : []));
}
async function settle(): Promise<void> {
  for (let index = 0; index < 40; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  frames = [];
  decoders = [];
  reports = [];
  requests = [];
  supported = true;
  file = buildProxy({ frames: 60 });
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebCodecs video reader', () => {
  it('decodes from the keyframe before the first frame, outputs only requested frames and closes the rest', async () => {
    const video = reader();
    video.receive({ kind: 'start', lane: 0, generation: 1, url: 'http://proxy/a', frames: [20, 21], complete: true });
    await settle();
    expect(delivered()).toEqual([20, 21]);
    expect(decoders[0]!.config).toMatchObject({
      codec: 'avc1.64001f',
      codedWidth: 1280,
      codedHeight: 720,
      optimizeForLatency: true,
    });
    expect(decoders[0]!.chunks.map((chunk) => [chunk.timestamp, chunk.type])).toEqual([
      [15, 'key'],
      ...[16, 17, 18, 19, 20, 21].map((frame) => [frame, 'delta']),
    ]);
    expect(requests).toEqual([
      'http://proxy/a bytes=0-65535',
      `http://proxy/a bytes=${file.offsets[15]}-${file.offsets[21]! + file.sizes[21]! - 1}`,
    ]);
    expect(frames.filter((frame) => ![20, 21].includes(frame.timestamp)).every((frame) => frame.closed)).toBe(true);
    expect(decoders[0]!.state).toBe('closed');
  });

  it('holds at most the frame budget until the page returns credits', async () => {
    const video = reader();
    const all = Array.from({ length: 30 }, (_value, frame) => frame);
    video.receive({ kind: 'start', lane: 2, generation: 4, url: 'http://proxy/a', frames: all, complete: false });
    await settle();
    expect(delivered(2)).toEqual(all.slice(0, DECODER_FRAME_BUDGET));
    video.receive({ kind: 'credit', lane: 2, generation: 4, count: 2, minimum: 2 });
    await settle();
    expect(delivered(2)).toEqual(all.slice(0, DECODER_FRAME_BUDGET + 2));
    expect(reports.every((report) => report.kind !== 'frame' || report.generation === 4)).toBe(true);
    video.receive({ kind: 'stop', lane: 2 });
    expect(decoders[0]!.state).toBe('closed');
  });

  it('skips straight to the keyframe a later frame depends on', async () => {
    const video = reader();
    video.receive({ kind: 'start', lane: 0, generation: 1, url: 'http://proxy/a', frames: [0, 16, 32], complete: true });
    await settle();
    expect(delivered()).toEqual([0, 16, 32]);
    expect(decoders[0]!.chunks.map((chunk) => chunk.timestamp)).toEqual([0, 15, 16, 30, 31, 32]);
  });

  it('drops frames the clock has passed and jumps to the keyframe before its minimum', async () => {
    const video = reader();
    const all = Array.from({ length: 40 }, (_value, frame) => frame);
    video.receive({ kind: 'start', lane: 0, generation: 1, url: 'http://proxy/a', frames: all, complete: true });
    await settle();
    expect(delivered()).toEqual(all.slice(0, DECODER_FRAME_BUDGET));
    video.receive({ kind: 'credit', lane: 0, generation: 1, count: DECODER_FRAME_BUDGET, minimum: 25 });
    await settle();
    expect(delivered().slice(DECODER_FRAME_BUDGET)).toEqual(all.slice(25, 25 + DECODER_FRAME_BUDGET));
    const decoded = decoders[0]!.chunks.map((chunk) => chunk.timestamp);
    expect(decoded).not.toContain(8);
    expect(decoded).toContain(15);
  });

  it('extends a running stream and rejects frames that do not continue it', async () => {
    const video = reader();
    video.receive({ kind: 'start', lane: 0, generation: 1, url: 'http://proxy/a', frames: [0, 1], complete: false });
    video.receive({ kind: 'extend', lane: 0, generation: 1, frames: [2, 3], complete: true });
    await settle();
    expect(delivered()).toEqual([0, 1, 2, 3]);
    video.receive({ kind: 'start', lane: 1, generation: 1, url: 'http://proxy/a', frames: [5], complete: false });
    video.receive({ kind: 'extend', lane: 1, generation: 1, frames: [4], complete: true });
    expect(failures()).toEqual(['Video stream extensions must continue its ascending frames.']);
  });

  it('closes late frames of a superseded stream and reads each index once', async () => {
    const video = reader();
    video.receive({ kind: 'start', lane: 0, generation: 1, url: 'http://proxy/a', frames: [10], complete: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    video.receive({ kind: 'start', lane: 0, generation: 2, url: 'http://proxy/a', frames: [40], complete: true });
    await settle();
    expect(reports).toEqual([expect.objectContaining({ kind: 'frame', generation: 2, sourceFrame: 40 })]);
    expect(requests.filter((request) => request.endsWith('bytes=0-65535'))).toHaveLength(1);
    expect(frames.filter((frame) => frame.timestamp !== 40).every((frame) => frame.closed)).toBe(true);
  });

  it.each([
    ['http://proxy/missing', [1], 'Editing proxy request failed (409): The proxy is not verified and ready.'],
    ['http://proxy/whole', [1], 'The editing proxy server ignored a range request.'],
    ['http://proxy/a', [60], 'Source frame 60 is beyond the 60-frame editing proxy.'],
  ])('reports %s %j as a failure', async (url, requested, message) => {
    const video = reader();
    video.receive({ kind: 'start', lane: 3, generation: 7, url, frames: requested, complete: true });
    await settle();
    expect(reports).toEqual([{ kind: 'failed', lane: 3, generation: 7, message }]);
  });

  it('reports an unsupported configuration and a decoder error', async () => {
    supported = false;
    const video = reader();
    video.receive({ kind: 'start', lane: 0, generation: 1, url: 'http://proxy/a', frames: [1], complete: true });
    await settle();
    expect(failures()).toEqual(['This browser cannot decode avc1.64001f editing proxies with WebCodecs.']);
    supported = true;
    const other = reader();
    other.receive({ kind: 'start', lane: 0, generation: 2, url: 'http://proxy/a', frames: [1], complete: false });
    await settle();
    decoders[0]!.init.error(new DOMException('Decoding failed.', 'EncodingError'));
    expect(failures().at(-1)).toBe('Decoding failed.');
    expect(decoders[0]!.state).toBe('closed');
  });

  it('rejects returning more credits than delivered frames', async () => {
    const video = reader();
    video.receive({ kind: 'start', lane: 0, generation: 1, url: 'http://proxy/a', frames: [0], complete: false });
    await settle();
    video.receive({ kind: 'credit', lane: 0, generation: 1, count: 2, minimum: 0 });
    expect(failures()).toEqual(['Video stream credits exceed its delivered frames.']);
  });
});
