import type { Writable } from 'node:stream';
import { clipSchema, type VideoClip } from '../shared/model.js';
import { compileRetiming, type Retiming } from '../shared/speed.js';
import { ServiceError } from './errors.js';
import { runRawVideoPass, writeRawFrame, type RawFrameReader } from './raw-process.js';

export interface RawRetimingOptions {
  ffmpeg: string;
  cwd: string;
  decodeArgs: readonly string[];
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
  if (typeof map.sourceAt !== 'function' || typeof map.outputAt !== 'function' || typeof map.rateAt !== 'function') {
    throw new ServiceError('The shared retiming map must expose sourceAt, outputAt and rateAt queries.', 422);
  }
  // Capture the duration and query functions, never materialize a duration-sized map.
  return Object.freeze({
    duration: map.duration,
    sourceAt: map.sourceAt.bind(map),
    outputAt: map.outputAt.bind(map),
    rateAt: map.rateAt.bind(map),
  });
}

async function pumpMappedFrames(
  options: RawRetimingOptions,
  retiming: Retiming,
  reader: RawFrameReader,
  encoder: Writable,
  check: () => void,
): Promise<{ decoded: number; written: number }> {
  const frame = options.frameBuffer ?? Buffer.allocUnsafe(options.frameBytes);
  let decoded = 0;
  let written = 0;
  let previousSource = options.clip.sourceIn - 1;
  const progressStep = Math.max(1, Math.floor(retiming.duration / 500));
  for (let output = 0; output < retiming.duration; output++) {
    check();
    const source = retiming.sourceAt(output);
    if (
      !Number.isSafeInteger(source) ||
      source < options.clip.sourceIn ||
      source >= options.clip.sourceOut ||
      source < previousSource
    ) {
      throw new ServiceError('The shared retiming map is not a monotonic, in-range discrete source-frame map.', 422);
    }
    previousSource = source;
    while (options.clip.sourceIn + decoded <= source) {
      await reader.requireFrame(frame); // NOSONAR -- serial reads are the one-frame memory contract.
      decoded++;
      check();
    }
    await writeRawFrame(encoder, frame); // NOSONAR -- serial writes enforce backpressure before reusing the frame buffer.
    written++;
    if (written === 1 || written % progressStep === 0 || written === retiming.duration)
      options.onProgress?.(written, retiming.duration);
  }
  encoder.end();
  // Consume discarded frames at the exclusive OUT too; never hide decode errors.
  while (decoded < options.clip.sourceOut - options.clip.sourceIn) {
    check();
    await reader.requireFrame(frame); // NOSONAR -- discard incrementally, never buffer the remaining excerpt.
    decoded++;
  }
  if (await reader.readInto(frame))
    throw new ServiceError('Original decoder emitted frames outside the selected source range.', 422);
  return { decoded, written };
}

/**
 * Native decoder -> exact shared sourceAt map -> native FFV1 encoder.
 * No whole-file/whole-excerpt buffers, no setpts speed approximation, no optical flow.
 * Both children are reaped before this resolves/rejects, including start/pipe errors.
 */
export async function retimeRawVideo(request: RawRetimingOptions): Promise<RawRetimingReport> {
  const options = { ...request, clip: clipSchema.parse(request.clip) };
  if (options.signal.aborted) throw new ServiceError('Job cancelled.', 499);
  if (!Number.isSafeInteger(options.frameBytes) || options.frameBytes < 1)
    throw new Error('Raw frame size must be a positive safe integer.');
  if (options.frameBuffer && options.frameBuffer.length !== options.frameBytes)
    throw new Error('The reusable raw frame buffer has the wrong size.');
  Object.freeze(options.clip.speed);
  Object.freeze(options.clip);
  if (options.signal.aborted) throw new ServiceError('Job cancelled.', 499);
  const retiming = captureRetiming(options.clip, options.retiming);
  let counts = { decoded: 0, written: 0 };
  const report = await runRawVideoPass(options, async (pass) => {
    const reader = pass.reader(options.decodeArgs, 'Original decoder');
    const encoder = pass.encoder(options.encodeArgs, 'lossless retiming encoder');
    counts = await pumpMappedFrames(options, retiming, reader, encoder, pass.check);
  });
  return {
    decodedFrames: counts.decoded,
    outputFrames: counts.written,
    frameBytes: options.frameBytes,
    rawFrameBuffers: 1,
    largestReadChunkBytes: report.largestReadChunkBytes,
  };
}
