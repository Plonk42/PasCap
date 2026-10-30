import type { Writable } from 'node:stream';
import { EXPORT_RESOURCES } from '../shared/export.js';
import type { DamagedRange } from '../shared/media.js';
import { clipSchema, type VideoClip } from '../shared/model.js';
import { whileSerial } from '../shared/serial.js';
import { compileRetiming, type Retiming } from '../shared/speed.js';
import { framesToSeconds } from '../shared/timing.js';
import { repairFilter } from './damage.js';
import { ServiceError } from './errors.js';
import { runRawVideoPass, writeRawFrame, type RawFrameReader, type RawVideoPass } from './raw-process.js';

/** One original excerpt a decoder emits as raw frames; reversed, last frame first. */
export interface SourceExcerpt {
  sourceIn: number;
  sourceOut: number;
  reverse: boolean;
}
export interface RawRetimingOptions {
  ffmpeg: string;
  cwd: string;
  /** Decoder arguments emitting exactly `excerpt`; see excerptInputArgs/excerptFilter. */
  decodeArgs: (excerpt: Readonly<SourceExcerpt>) => readonly string[];
  encodeArgs: readonly string[];
  clip: VideoClip;
  /** Authoritative placed map for row keys; omission compiles the clip's constant/ramp/custom base. */
  retiming?: Retiming;
  frameBytes: number;
  /** Optional caller-owned reusable frame; no extra buffer in layered passes. */
  frameBuffer?: Buffer;
  signal: AbortSignal;
  onProgress?: (frames: number, total: number) => void;
}
export interface RawRetimingReport {
  decodedFrames: number;
  outputFrames: number;
  frameBytes: number;
  rawFrameBuffers: number;
  largestReadChunkBytes: number;
  /** Serial original decoders: one forward, one per chunk reversed. */
  decoderProcesses: number;
}

/**
 * Forward excerpts decode from the file start (no seek). Reversed chunks seek:
 * registered originals have verified PTS n/fps from 0, so a seek strictly between
 * the preceding and first PTS lets accurate_seek drop exactly the earlier frames.
 */
export function excerptInputArgs(excerpt: Readonly<SourceExcerpt>): string[] {
  if (!excerpt.reverse || excerpt.sourceIn === 0) return [];
  return ['-ss', (framesToSeconds(excerpt.sourceIn) - framesToSeconds(1) / 4).toFixed(12)];
}
/**
 * Select the excerpt before `filter`, after repairing recorded damage; reversed
 * chunks end with FFmpeg's bounded `reverse` buffer.
 */
export function excerptFilter(
  excerpt: Readonly<SourceExcerpt>,
  filter: string,
  damage: readonly DamagedRange[],
): string {
  const frames = excerpt.sourceOut - excerpt.sourceIn;
  const repair = repairFilter(damage, excerptInputArgs(excerpt).length ? excerpt.sourceIn : 0);
  return excerpt.reverse
    ? `${repair}trim=end_frame=${frames},setpts=PTS-STARTPTS,${filter},reverse`
    : `${repair}trim=start_frame=${excerpt.sourceIn}:end_frame=${excerpt.sourceOut},setpts=PTS-STARTPTS,${filter}`;
}
/** Frames per reversed decoder chunk: the native reverse buffer stays within EXPORT_RESOURCES.reverseChunkBytes. */
export function reverseChunkFrames(frameBytes: number): number {
  return Math.max(1, Math.floor(EXPORT_RESOURCES.reverseChunkBytes / frameBytes));
}

function captureRetiming(clip: VideoClip, supplied: Retiming | undefined): Retiming {
  let map = supplied;
  // Only omission selects the static map; an explicitly invalid/null map must fail.
  if (supplied === undefined) map = compileRetiming(clip);
  if (!map || !Number.isSafeInteger(map.duration) || map.duration < 1 || map.duration > 2_147_483_647) {
    throw new ServiceError(
      'The shared retiming map duration must be a positive supported integer project-frame count.',
      422,
    );
  }
  if (
    typeof map.sourceAt !== 'function' ||
    typeof map.sourcePositionAt !== 'function' ||
    typeof map.outputAt !== 'function'
  ) {
    throw new ServiceError('The shared retiming map must expose sourceAt, sourcePositionAt and outputAt queries.', 422);
  }
  // Capture the duration and query functions, never materialize a duration-sized map.
  const captured = Object.freeze({
    duration: map.duration,
    sourceAt: map.sourceAt.bind(map),
    sourcePositionAt: map.sourcePositionAt.bind(map),
    outputAt: map.outputAt.bind(map),
  });
  const [first, last] = clip.reverse ? [clip.sourceOut, clip.sourceIn] : [clip.sourceIn, clip.sourceOut];
  if (captured.sourcePositionAt(0) !== first || captured.sourcePositionAt(captured.duration) !== last) {
    throw new ServiceError(
      'The shared retiming map continuous source positions must match the selected source endpoints.',
      422,
    );
  }
  return captured;
}

/** Discrete and continuous positions must stay in range and move only in the clip's direction. */
class MapCheck {
  #source: number;
  #position: number;
  readonly #sign: 1 | -1;
  constructor(private readonly clip: VideoClip) {
    this.#sign = clip.reverse ? -1 : 1;
    this.#source = clip.reverse ? clip.sourceOut : clip.sourceIn - 1;
    this.#position = clip.reverse ? clip.sourceOut : clip.sourceIn;
  }
  source(retiming: Retiming, output: number): number {
    const { sourceIn, sourceOut } = this.clip;
    const source = retiming.sourceAt(output);
    if (
      !Number.isSafeInteger(source) ||
      source < sourceIn ||
      source >= sourceOut ||
      (source - this.#source) * this.#sign < 0
    ) {
      throw new ServiceError('The shared retiming map is not a monotonic, in-range discrete source-frame map.', 422);
    }
    this.#source = source;
    const position = retiming.sourcePositionAt(output);
    if (
      !Number.isFinite(position) ||
      position < sourceIn ||
      position > sourceOut ||
      (position - this.#position) * this.#sign < 0
    ) {
      throw new ServiceError(
        'The shared retiming map is not a finite, monotonic, in-range continuous source-position map.',
        422,
      );
    }
    this.#position = position;
    return source;
  }
}

interface Pump {
  frame: Buffer;
  encoder: Writable;
  written: number;
}
function reportProgress(options: RawRetimingOptions, retiming: Retiming, written: number): void {
  const progressStep = Math.max(1, Math.floor(retiming.duration / 500));
  if (written === 1 || written % progressStep === 0 || written === retiming.duration)
    options.onProgress?.(written, retiming.duration);
}

async function pumpMappedFrames(
  options: RawRetimingOptions,
  retiming: Retiming,
  reader: RawFrameReader,
  pump: Pump,
  check: () => void,
): Promise<number> {
  const { frame } = pump;
  const map = new MapCheck(options.clip);
  let decoded = 0;
  for (let output = 0; output < retiming.duration; output++) {
    check();
    const source = map.source(retiming, output);
    while (options.clip.sourceIn + decoded <= source) {
      await reader.requireFrame(frame); // NOSONAR -- serial reads are the one-frame memory contract.
      decoded++;
      check();
    }
    await writeRawFrame(pump.encoder, frame); // NOSONAR -- serial writes enforce backpressure before reusing the frame buffer.
    reportProgress(options, retiming, ++pump.written);
  }
  pump.encoder.end();
  // Consume discarded frames at the exclusive OUT too; never hide decode errors.
  while (decoded < options.clip.sourceOut - options.clip.sourceIn) {
    check();
    await reader.requireFrame(frame); // NOSONAR -- discard incrementally, never buffer the remaining excerpt.
    decoded++;
  }
  if (await reader.readInto(frame))
    throw new ServiceError('Original decoder emitted frames outside the selected source range.', 422);
  return decoded;
}

/**
 * Reversed clips decode serial chunks from OUT down to IN. Each chunk decoder
 * emits its frames last first, buffering at most reverseChunkFrames output
 * frames natively; Node still holds one frame.
 */
async function pumpReversedFrames(
  options: RawRetimingOptions,
  retiming: Retiming,
  pass: RawVideoPass,
  pump: Pump,
): Promise<{ decoded: number; decoders: number }> {
  const { frame } = pump;
  const { sourceIn, sourceOut } = options.clip;
  const chunk = reverseChunkFrames(options.frameBytes);
  const map = new MapCheck(options.clip);
  let reader: RawFrameReader | null = null;
  let decoders = 0;
  let low = sourceOut; // Lowest frame of the current chunk.
  let held = sourceOut; // Frame in `frame`; sourceOut means none yet.
  const nextChunk = async (): Promise<RawFrameReader> => {
    if (reader) await pass.endReader(reader, frame);
    const high = low;
    low = Math.max(sourceIn, high - chunk);
    decoders++;
    return pass.reader(options.decodeArgs({ sourceIn: low, sourceOut: high, reverse: true }), 'Original decoder');
  };
  const nextImage = async (): Promise<void> => {
    if (held === low) reader = await nextChunk();
    await reader!.requireFrame(frame);
    held--;
    pass.check();
  };
  let output = 0;
  await whileSerial(
    () => output < retiming.duration,
    async () => {
      pass.check();
      const source = map.source(retiming, output);
      await whileSerial(() => held > source, nextImage);
      await writeRawFrame(pump.encoder, frame);
      reportProgress(options, retiming, ++pump.written);
      output++;
    },
  );
  pump.encoder.end();
  // Consume every remaining chunk down to IN too; never hide decode errors.
  await whileSerial(() => held > sourceIn, nextImage);
  if (reader) await pass.endReader(reader, frame);
  return { decoded: sourceOut - held, decoders };
}

/**
 * Native decoder -> exact shared sourceAt map -> native FFV1 encoder.
 * No whole-file/whole-excerpt buffers, no setpts speed approximation, no optical flow.
 * Every child is reaped before this resolves/rejects, including start/pipe errors.
 */
export async function retimeRawVideo(request: RawRetimingOptions): Promise<RawRetimingReport> {
  const options = { ...request, clip: clipSchema.parse(request.clip) };
  if (options.signal.aborted) throw new ServiceError('Job canceled.', 499);
  if (!Number.isSafeInteger(options.frameBytes) || options.frameBytes < 1)
    throw new Error('Raw frame size must be a positive safe integer.');
  if (options.frameBuffer && options.frameBuffer.length !== options.frameBytes)
    throw new Error('The reusable raw frame buffer has the wrong size.');
  Object.freeze(options.clip.speed);
  Object.freeze(options.clip);
  if (options.signal.aborted) throw new ServiceError('Job canceled.', 499);
  const retiming = captureRetiming(options.clip, options.retiming);
  let decoded = 0;
  let decoders = 1;
  let written = 0;
  const report = await runRawVideoPass(options, async (pass) => {
    const frame = options.frameBuffer ?? Buffer.allocUnsafe(options.frameBytes);
    if (options.clip.reverse) {
      const pump = { frame, encoder: pass.encoder(options.encodeArgs, 'lossless retiming encoder'), written: 0 };
      ({ decoded, decoders } = await pumpReversedFrames(options, retiming, pass, pump));
      written = pump.written;
      return;
    }
    const { sourceIn, sourceOut } = options.clip;
    const reader = pass.reader(options.decodeArgs({ sourceIn, sourceOut, reverse: false }), 'Original decoder');
    const pump = { frame, encoder: pass.encoder(options.encodeArgs, 'lossless retiming encoder'), written: 0 };
    decoded = await pumpMappedFrames(options, retiming, reader, pump, pass.check);
    written = pump.written;
  });
  return {
    decodedFrames: decoded,
    outputFrames: written,
    frameBytes: options.frameBytes,
    rawFrameBuffers: 1,
    largestReadChunkBytes: report.largestReadChunkBytes,
    decoderProcesses: decoders,
  };
}
