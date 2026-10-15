import { whileSerial } from '../shared/serial.js';
import { PROJECT_FPS } from '../shared/timing.js';
import { keyframeBefore, locateIndex, parseProxyIndex, type ProxyIndex } from './proxy-index.js';
import {
  DECODER_FRAME_BUDGET,
  REVERSE_GROUP_FRAMES,
  type VideoReaderCommand,
  type VideoReaderReport,
} from './video-protocol.js';

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
  /** Requested source frames not yet fed to the decoder, in output order. */
  wanted: number[];
  reverse: boolean;
  last: number;
  complete: boolean;
  /** The frame the clock needs now; frames it has passed are skipped. */
  needed: number;
  next: number;
  /** Frames posted to the page and not yet returned as credits. */
  outstanding: number;
  /** Requested frames fed to the decoder and not yet output. */
  inFlight: Set<number>;
  /** Reversed: decoded frames of the current GOP pass, highest first, not yet posted. */
  held: VideoFrame[];
  range: FrameRange | null;
  wake: (() => void) | null;
  done: boolean;
}

function ordered(frames: unknown, after: number, reverse: boolean): frames is number[] {
  if (!Array.isArray(frames)) return false;
  let previous = after;
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame) || frame < 0 || (reverse ? frame >= previous : frame <= previous)) return false;
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
 * requested frames are queued in the page or decoding at once. A reversed lane
 * decodes each GOP forward, holds at most REVERSE_GROUP_FRAMES of it and posts
 * them backwards under the same credits.
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
    for (const frame of stream.held) frame.close();
    stream.held.length = 0;
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
      reverse: command.reverse,
      last: command.frames.at(-1) ?? (command.reverse ? Number.MAX_SAFE_INTEGER : -1),
      complete: command.complete,
      needed: command.reverse ? Number.MAX_SAFE_INTEGER : 0,
      next: 0,
      outstanding: 0,
      inFlight: new Set(),
      held: [],
      range: null,
      wake: null,
      done: false,
    };
    this.#streams.set(command.lane, stream);
    if (
      typeof command.reverse !== 'boolean' ||
      !ordered(command.frames, stream.reverse ? Infinity : -1, stream.reverse)
    )
      this.#fail(stream, new Error('Video stream frames must follow its playback direction.'));
    else void this.#run(stream);
  }
  #extend(command: Extract<VideoReaderCommand, { kind: 'extend' }>): void {
    const stream = this.#streams.get(command.lane);
    if (stream?.generation !== command.generation) return;
    if (stream.complete || !ordered(command.frames, stream.last, stream.reverse)) {
      this.#fail(stream, new Error('Video stream extensions must continue its frames in order.'));
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
    stream.needed = stream.reverse ? Math.min(stream.needed, command.needed) : Math.max(stream.needed, command.needed);
    this.#wake(stream);
  }
  #passed(stream: Stream, frame: number): boolean {
    return stream.reverse ? frame > stream.needed : frame < stream.needed;
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
        () => (stream.reverse ? this.#stepReverse(stream, index, decoder) : this.#step(stream, index, decoder)),
      );
    } catch (error) {
      this.#fail(stream, error);
    }
  }
  async #finish(stream: Stream, decoder: VideoDecoder): Promise<void> {
    if (!stream.complete) return this.#sleep(stream);
    // A decoder may hold its last frames until more input or a flush.
    await decoder.flush();
    if (this.#current(stream)) {
      stream.done = true;
      decoder.close();
    }
  }
  async #step(stream: Stream, index: ProxyIndex, decoder: VideoDecoder): Promise<void> {
    while (stream.wanted.length && this.#passed(stream, stream.wanted[0]!)) stream.wanted.shift();
    const target = stream.wanted[0];
    if (target === undefined) return this.#finish(stream, decoder);
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
  /**
   * Post held frames highest first within credits; once none are held, decode
   * the GOP of the highest wanted frame forward from its keyframe, keeping at
   * most REVERSE_GROUP_FRAMES of its wanted frames, then flush.
   */
  async #stepReverse(stream: Stream, index: ProxyIndex, decoder: VideoDecoder): Promise<void> {
    while (stream.held.length && stream.outstanding < DECODER_FRAME_BUDGET) {
      const frame = stream.held.shift()!;
      if (this.#passed(stream, frame.timestamp)) {
        frame.close();
        continue;
      }
      stream.outstanding++;
      this.#post(stream, frame);
    }
    if (stream.held.length) return this.#sleep(stream);
    while (stream.wanted.length && this.#passed(stream, stream.wanted[0]!)) stream.wanted.shift();
    const target = stream.wanted[0];
    if (target === undefined) return this.#finish(stream, decoder);
    if (target >= index.frameCount)
      throw new Error(`Source frame ${target} is beyond the ${index.frameCount}-frame editing proxy.`);
    const key = keyframeBefore(index, target);
    const group = stream.wanted.filter((frame) => frame >= key).slice(0, REVERSE_GROUP_FRAMES);
    stream.inFlight = new Set(group);
    let sample = key;
    await whileSerial(
      () => this.#current(stream) && sample <= target,
      async () => {
        if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) return this.#sleep(stream);
        stream.next = sample;
        const chunk = await this.#chunk(stream, index, target);
        if (!this.#current(stream)) return;
        decoder.decode(chunk);
        sample++;
      },
    );
    if (!this.#current(stream)) return;
    await decoder.flush();
    if (!this.#current(stream)) return;
    const decoded = new Set(group);
    stream.wanted = stream.wanted.filter((frame) => !decoded.has(frame));
    stream.inFlight.clear();
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
    if (this.#passed(stream, sample)) {
      frame.close();
      return;
    }
    // A GOP pass outputs ascending frames: the newest is the highest held.
    if (stream.reverse) {
      stream.held.unshift(frame);
      return;
    }
    stream.outstanding++;
    this.#post(stream, frame);
  }
  #post(stream: Stream, frame: VideoFrame): void {
    this.#report(
      { kind: 'frame', lane: stream.lane, generation: stream.generation, sourceFrame: frame.timestamp, frame },
      [frame],
    );
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
