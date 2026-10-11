import { whileSerial } from '../shared/serial.js';
import { PROJECT_FPS } from '../shared/timing.js';
import { keyframeBefore, locateIndex, parseProxyIndex, type ProxyIndex } from './proxy-index.js';
import { DECODER_FRAME_BUDGET, type VideoReaderCommand, type VideoReaderReport } from './video-protocol.js';

const HEAD_BYTES = 65_536;
const MAX_READ_FRAMES = 32;
const MAX_DECODE_QUEUE = 8;
const INDEX_CACHE = 16;

/** Browser services, injectable so the stream logic is testable without a media stack. */
export interface DecoderPlatform {
  fetch(url: string, init: RequestInit): Promise<Response>;
  createDecoder(init: VideoDecoderInit): VideoDecoder;
  supported(config: VideoDecoderConfig): Promise<boolean>;
}

interface FrameRange {
  first: number;
  last: number;
  start: number;
  bytes: Uint8Array;
}

interface Stream {
  lane: number;
  generation: number;
  url: string;
  controller: AbortController;
  decoder: VideoDecoder | null;
  /** Requested source frames not yet fed to the decoder, ascending. */
  wanted: number[];
  last: number;
  complete: boolean;
  minimum: number;
  next: number;
  /** Frames posted to the page and not yet returned as credits. */
  outstanding: number;
  /** Requested frames fed to the decoder and not yet output. */
  inFlight: Set<number>;
  range: FrameRange | null;
  wake: (() => void) | null;
  done: boolean;
}

function ascending(frames: unknown, after: number): frames is number[] {
  if (!Array.isArray(frames)) return false;
  let previous = after;
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame) || frame <= previous) return false;
    previous = frame;
  }
  return true;
}

function keyframeAfter(index: ProxyIndex, frame: number): number {
  let key = frame + 1;
  while (key < index.frameCount && !index.keyframes[key]) key++;
  return key;
}

async function failedRequest(response: Response): Promise<Error> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
      detail = `: ${body.error}`;
  } catch {
    /* Keep the actual HTTP status rather than a guessed reason. */
  }
  return new Error(`Editing proxy request failed (${response.status})${detail}`);
}

/**
 * One WebCodecs decoder per timeline lane, fed by bounded range reads of the
 * editing proxy. Output is credit-controlled: at most DECODER_FRAME_BUDGET
 * requested frames are queued in the page or decoding at once.
 */
export class VideoReader {
  readonly #platform: DecoderPlatform;
  readonly #report: (message: VideoReaderReport, transfer?: Transferable[]) => void;
  readonly #streams = new Map<number, Stream>();
  readonly #indexes = new Map<string, Promise<ProxyIndex>>();
  readonly #support = new Map<string, Promise<boolean>>();

  constructor(platform: DecoderPlatform, report: (message: VideoReaderReport, transfer?: Transferable[]) => void) {
    this.#platform = platform;
    this.#report = report;
  }

  receive(command: VideoReaderCommand): void {
    if (command.kind === 'start') this.#start(command);
    else if (command.kind === 'extend') this.#extend(command);
    else if (command.kind === 'credit') this.#credit(command);
    else {
      const stream = this.#streams.get(command.lane);
      if (stream) this.#cancel(stream);
    }
  }

  #current(stream: Stream): boolean {
    return this.#streams.get(stream.lane) === stream && !stream.controller.signal.aborted;
  }
  #wake(stream: Stream): void {
    const wake = stream.wake;
    stream.wake = null;
    wake?.();
  }
  #sleep(stream: Stream): Promise<void> {
    return new Promise((resolve) => {
      stream.wake = resolve;
    });
  }
  #cancel(stream: Stream): void {
    if (this.#streams.get(stream.lane) === stream) this.#streams.delete(stream.lane);
    stream.controller.abort();
    if (stream.decoder && stream.decoder.state !== 'closed') stream.decoder.close();
    stream.inFlight.clear();
    this.#wake(stream);
  }
  #fail(stream: Stream, error: unknown): void {
    if (!this.#current(stream) || (error instanceof DOMException && error.name === 'AbortError')) return;
    this.#cancel(stream);
    this.#report({
      kind: 'failed',
      lane: stream.lane,
      generation: stream.generation,
      message: error instanceof Error ? error.message : 'Video decoding failed.',
    });
  }

  #start(command: Extract<VideoReaderCommand, { kind: 'start' }>): void {
    const previous = this.#streams.get(command.lane);
    if (previous) this.#cancel(previous);
    const stream: Stream = {
      lane: command.lane,
      generation: command.generation,
      url: command.url,
      controller: new AbortController(),
      decoder: null,
      wanted: [...command.frames],
      last: command.frames.at(-1) ?? -1,
      complete: command.complete,
      minimum: 0,
      next: 0,
      outstanding: 0,
      inFlight: new Set(),
      range: null,
      wake: null,
      done: false,
    };
    this.#streams.set(command.lane, stream);
    if (!ascending(command.frames, -1)) this.#fail(stream, new Error('Video stream frames must ascend.'));
    else void this.#run(stream);
  }
  #extend(command: Extract<VideoReaderCommand, { kind: 'extend' }>): void {
    const stream = this.#streams.get(command.lane);
    if (stream?.generation !== command.generation) return;
    if (stream.complete || !ascending(command.frames, stream.last)) {
      this.#fail(stream, new Error('Video stream extensions must continue its ascending frames.'));
      return;
    }
    stream.wanted.push(...command.frames);
    stream.last = command.frames.at(-1) ?? stream.last;
    stream.complete = command.complete;
    this.#wake(stream);
  }
  #credit(command: Extract<VideoReaderCommand, { kind: 'credit' }>): void {
    const stream = this.#streams.get(command.lane);
    if (stream?.generation !== command.generation) return;
    if (!Number.isInteger(command.count) || command.count < 1 || command.count > stream.outstanding) {
      this.#fail(stream, new Error('Video stream credits exceed its delivered frames.'));
      return;
    }
    stream.outstanding -= command.count;
    stream.minimum = Math.max(stream.minimum, command.minimum);
    this.#wake(stream);
  }

  async #run(stream: Stream): Promise<void> {
    try {
      const index = await this.#index(stream.url);
      if (!this.#current(stream)) return;
      const config: VideoDecoderConfig = {
        codec: index.codec,
        description: index.description,
        codedWidth: index.width,
        codedHeight: index.height,
        optimizeForLatency: true,
      };
      if (!(await this.#supported(config)))
        throw new Error(`This browser cannot decode ${index.codec} editing proxies with WebCodecs.`);
      if (!this.#current(stream)) return;
      const decoder = this.#platform.createDecoder({
        output: (frame) => this.#output(stream, frame),
        error: (error) => this.#fail(stream, error),
      });
      stream.decoder = decoder;
      decoder.ondequeue = () => this.#wake(stream);
      decoder.configure(config);
      await whileSerial(
        () => this.#current(stream) && !stream.done,
        () => this.#step(stream, index, decoder),
      );
    } catch (error) {
      this.#fail(stream, error);
    }
  }
  async #step(stream: Stream, index: ProxyIndex, decoder: VideoDecoder): Promise<void> {
    while (stream.wanted.length && stream.wanted[0]! < stream.minimum) stream.wanted.shift();
    const target = stream.wanted[0];
    if (target === undefined) {
      if (!stream.complete) return this.#sleep(stream);
      // A decoder may hold its last frames until more input or a flush.
      await decoder.flush();
      if (this.#current(stream)) {
        stream.done = true;
        decoder.close();
      }
      return;
    }
    if (target >= index.frameCount)
      throw new Error(`Source frame ${target} is beyond the ${index.frameCount}-frame editing proxy.`);
    // Frames before the target's keyframe are never needed: skip straight to it.
    stream.next = Math.max(stream.next, keyframeBefore(index, target));
    const budgetFull = stream.outstanding + stream.inFlight.size >= DECODER_FRAME_BUDGET;
    if ((stream.next === target && budgetFull) || decoder.decodeQueueSize >= MAX_DECODE_QUEUE)
      return this.#sleep(stream);
    const chunk = await this.#chunk(stream, index, target);
    if (!this.#current(stream) || stream.wanted[0] !== target) return;
    decoder.decode(chunk);
    if (stream.next === target) {
      stream.inFlight.add(target);
      stream.wanted.shift();
    }
    stream.next++;
  }
  async #chunk(stream: Stream, index: ProxyIndex, target: number): Promise<EncodedVideoChunk> {
    const sample = stream.next;
    let range = stream.range;
    if (!range || sample < range.first || sample > range.last) {
      // Read through the last requested frame of this GOP, never past the next keyframe.
      const end = Math.min(keyframeAfter(index, target) - 1, sample + MAX_READ_FRAMES - 1);
      let last = Math.min(target, end);
      for (const frame of stream.wanted) if (frame <= end) last = Math.max(last, frame);
      const start = index.offsets[sample]!;
      const bytes = await this.#read(
        stream.url,
        start,
        index.offsets[last]! + index.sizes[last]!,
        stream.controller.signal,
      );
      range = { first: sample, last, start, bytes };
      stream.range = range;
    }
    const begin = index.offsets[sample]! - range.start;
    return new EncodedVideoChunk({
      type: index.keyframes[sample] ? 'key' : 'delta',
      timestamp: sample,
      data: range.bytes.subarray(begin, begin + index.sizes[sample]!),
    });
  }
  #output(stream: Stream, frame: VideoFrame): void {
    const sample = frame.timestamp;
    if (!this.#current(stream) || !stream.inFlight.delete(sample)) {
      frame.close();
      return;
    }
    this.#wake(stream);
    if (sample < stream.minimum) {
      frame.close();
      return;
    }
    stream.outstanding++;
    this.#report({ kind: 'frame', lane: stream.lane, generation: stream.generation, sourceFrame: sample, frame }, [
      frame,
    ]);
  }

  async #read(url: string, start: number, end: number, signal: AbortSignal, partial = false): Promise<Uint8Array> {
    const response = await this.#platform.fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
    if (response.status !== 206) {
      if (!response.ok) throw await failedRequest(response);
      await response.body?.cancel();
      throw new Error('The editing proxy server ignored a range request.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > end - start || (!partial && bytes.byteLength !== end - start))
      throw new Error('The editing proxy returned an incomplete byte range.');
    return bytes;
  }
  #index(url: string): Promise<ProxyIndex> {
    let index = this.#indexes.get(url);
    if (index === undefined)
      index = (async () => {
        const signal = AbortSignal.timeout(10_000);
        let bytes = await this.#read(url, 0, HEAD_BYTES, signal, true);
        const location = locateIndex(bytes);
        if (location.end > bytes.byteLength) bytes = await this.#read(url, 0, location.end, signal);
        return parseProxyIndex(bytes, PROJECT_FPS);
      })();
    else this.#indexes.delete(url);
    this.#indexes.set(url, index);
    if (this.#indexes.size > INDEX_CACHE) this.#indexes.delete(this.#indexes.keys().next().value!);
    index.catch(() => {
      if (this.#indexes.get(url) === index) this.#indexes.delete(url);
    });
    return index;
  }
  #supported(config: VideoDecoderConfig): Promise<boolean> {
    let supported = this.#support.get(config.codec);
    if (!supported) {
      supported = this.#platform.supported(config);
      this.#support.set(config.codec, supported);
    }
    return supported;
  }
}
