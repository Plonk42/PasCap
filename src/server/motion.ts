import { spawn } from 'node:child_process';
import {
  MOTION_ANALYSIS_VERSION,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  type FlightSpeedSample,
  type MotionAnalysis,
} from '../shared/motion-analysis.js';
import { whileSerial } from '../shared/serial.js';
import { ServiceError } from './errors.js';
import { runProcess } from './process.js';
import { RawFrameReader } from './raw-process.js';

const N = 64;
const LOG2N = 6;
const FRAME_BYTES = MOTION_WIDTH * MOTION_HEIGHT;
/** Block centres covering the frame; each block measures a local shift. */
const BLOCKS = [40, 90, 140].flatMap((cy) => [40, 120, 200, 280].map((cx) => ({ cx, cy })));
const MIN_TEXTURE = 3;
const MIN_PEAK = 8;

const bitReverse = Uint16Array.from({ length: N }, (_, i) => {
  let reversed = 0;
  for (let bit = 0; bit < LOG2N; bit++) reversed |= ((i >> bit) & 1) << (LOG2N - 1 - bit);
  return reversed;
});
const cosines = Float64Array.from({ length: N / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / N));
const sines = Float64Array.from({ length: N / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / N));
const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N));
// Low frequencies only: a smooth correlation peak whose subpixel position can be fitted.
const lowPass = Float64Array.from({ length: N * N }, (_, i) => {
  const fx = Math.min(i % N, N - (i % N));
  const fy = Math.min(Math.trunc(i / N), N - Math.trunc(i / N));
  return Math.exp(-(fx * fx + fy * fy) / (2 * 7 * 7));
});

const rowRe = new Float64Array(N);
const rowIm = new Float64Array(N);
function fft1(re: Float64Array, im: Float64Array, offset: number, stride: number, inverse: boolean): void {
  for (let i = 0; i < N; i++) {
    rowRe[bitReverse[i]!] = re[offset + i * stride]!;
    rowIm[bitReverse[i]!] = im[offset + i * stride]!;
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size)
      for (let k = 0; k < half; k++) {
        const wr = cosines[k * step]!;
        const wi = sign * sines[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = rowRe[b]! * wr - rowIm[b]! * wi;
        const xi = rowRe[b]! * wi + rowIm[b]! * wr;
        rowRe[b] = rowRe[a]! - xr;
        rowIm[b] = rowIm[a]! - xi;
        rowRe[a] = rowRe[a]! + xr;
        rowIm[a] = rowIm[a]! + xi;
      }
  }
  for (let i = 0; i < N; i++) {
    re[offset + i * stride] = rowRe[i]!;
    im[offset + i * stride] = rowIm[i]!;
  }
}
function fft2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  for (let y = 0; y < N; y++) fft1(re, im, y * N, 1, inverse);
  for (let x = 0; x < N; x++) fft1(re, im, x, N, inverse);
}

export interface Spectrum {
  re: Float64Array;
  im: Float64Array;
  texture: number;
}

function spectrum(frame: Uint8Array, cx: number, cy: number): Spectrum {
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  const x0 = cx - N / 2;
  const y0 = cy - N / 2;
  let mean = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) mean += frame[(y0 + y) * MOTION_WIDTH + x0 + x]!;
  mean /= N * N;
  let variance = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const value = frame[(y0 + y) * MOTION_WIDTH + x0 + x]! - mean;
      variance += value * value;
      re[y * N + x] = value * hann[x]! * hann[y]!;
    }
  fft2(re, im, false);
  return { re, im, texture: Math.sqrt(variance / (N * N)) };
}

interface Shift {
  dx: number;
  dy: number;
  /** Peak-to-sidelobe ratio: how distinct the match is. */
  peak: number;
}

const corrRe = new Float64Array(N * N);
const corrIm = new Float64Array(N * N);

function subpixel(left: number, centre: number, right: number): number {
  if (left <= 0 || right <= 0) return 0;
  const l = Math.log(left);
  const r = Math.log(right);
  const curvature = l - 2 * Math.log(centre) + r;
  return curvature < 0 ? (0.5 * (l - r)) / curvature : 0;
}

function peakToSidelobe(px: number, py: number, peak: number): number {
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const near = Math.min(Math.abs(x - px), N - Math.abs(x - px)) <= 5;
      if (near && Math.min(Math.abs(y - py), N - Math.abs(y - py)) <= 5) continue;
      const value = corrRe[y * N + x]!;
      sum += value;
      squares += value * value;
      count++;
    }
  const mean = sum / count;
  return (peak - mean) / Math.sqrt(Math.max(1e-12, squares / count - mean * mean));
}

/** Phase correlation with square-root whitening; the peak sits at the displacement of b. */
export function correlate(a: Spectrum, b: Spectrum): Shift {
  for (let i = 0; i < N * N; i++) {
    const re = a.re[i]! * b.re[i]! + a.im[i]! * b.im[i]!;
    const im = a.re[i]! * b.im[i]! - a.im[i]! * b.re[i]!;
    const scale = Math.sqrt(Math.hypot(re, im) + 1e-9) / lowPass[i]!;
    corrRe[i] = re / scale;
    corrIm[i] = im / scale;
  }
  fft2(corrRe, corrIm, true);
  let best = 0;
  for (let i = 1; i < N * N; i++) if (corrRe[i]! > corrRe[best]!) best = i;
  const px = best % N;
  const py = Math.trunc(best / N);
  const at = (x: number, y: number): number => corrRe[((y + N) % N) * N + ((x + N) % N)]!;
  const centre = at(px, py);
  let dx = px + subpixel(at(px - 1, py), centre, at(px + 1, py));
  let dy = py + subpixel(at(px, py - 1), centre, at(px, py + 1));
  if (dx > N / 2) dx -= N;
  if (dy > N / 2) dy -= N;
  return { dx, dy, peak: peakToSidelobe(px, py, centre) };
}

/** A fixed window biases shifts toward zero: re-measure where the content moved. */
function refined(previous: Spectrum, first: Spectrum, frame: Uint8Array, cx: number, cy: number) {
  let shift = correlate(previous, first);
  let texture = first.texture;
  for (let pass = 0; pass < 2; pass++) {
    const ox = Math.max(N / 2 - cx, Math.min(MOTION_WIDTH - N / 2 - cx, Math.round(shift.dx)));
    const oy = Math.max(N / 2 - cy, Math.min(MOTION_HEIGHT - N / 2 - cy, Math.round(shift.dy)));
    if (ox === 0 && oy === 0) break;
    const moved = spectrum(frame, cx + ox, cy + oy);
    const residual = correlate(previous, moved);
    shift = { dx: ox + residual.dx, dy: oy + residual.dy, peak: residual.peak };
    texture = moved.texture;
    if (Math.abs(residual.dx) < 0.5 && Math.abs(residual.dy) < 0.5) break;
  }
  return { ...shift, texture };
}

function eliminate(matrix: number[][], column: number): void {
  for (let row = 0; row < matrix.length; row++) {
    if (row === column) continue;
    const factor = matrix[row]![column]! / matrix[column]![column]!;
    for (let k = column; k <= matrix.length; k++) matrix[row]![k] = matrix[row]![k]! - factor * matrix[column]![k]!;
  }
}

/** Gauss-Jordan elimination with partial pivoting of an augmented n × (n + 1) matrix. */
function solve(matrix: number[][]): number[] | null {
  const n = matrix.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++)
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    if (Math.abs(matrix[pivot]![column]!) < 1e-9) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    eliminate(matrix, column);
  }
  return matrix.map((row, i) => row[n]! / row[i]!);
}

interface BlockShift extends Shift {
  x: number;
  y: number;
}

/** Weighted least squares for d = t + zoom·p + rotation·perp(p), p relative to the centre. */
function fit(shifts: readonly BlockShift[]): number[] | null {
  const normal = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]);
  for (const s of shifts)
    for (const row of [
      [1, 0, s.x, -s.y, s.dx],
      [0, 1, s.y, s.x, s.dy],
    ])
      for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) normal[i]![j]! += s.peak * row[i]! * row[j]!;
  return solve(normal);
}

export interface FrameMotion {
  tx: number;
  ty: number;
  zoom: number;
  rotation: number;
}

/** Global motion between two frames, or null when too few blocks agree. */
export function estimateMotion(previous: readonly Spectrum[], frame: Uint8Array): FrameMotion | null {
  let shifts: BlockShift[] = BLOCKS.flatMap((block, i) => {
    const first = spectrum(frame, block.cx, block.cy);
    const s = refined(previous[i]!, first, frame, block.cx, block.cy);
    return previous[i]!.texture > MIN_TEXTURE && s.texture > MIN_TEXTURE && s.peak > MIN_PEAK
      ? [{ ...s, x: block.cx - MOTION_WIDTH / 2, y: block.cy - MOTION_HEIGHT / 2 }]
      : [];
  });
  let parameters: number[] | null = null;
  for (let pass = 0; pass < 3 && shifts.length >= 4; pass++) {
    parameters = fit(shifts);
    if (!parameters) return null;
    const [tx, ty, zoom, rotation] = parameters as [number, number, number, number];
    const residuals = shifts.map((s) =>
      Math.hypot(s.dx - (tx + zoom * s.x - rotation * s.y), s.dy - (ty + zoom * s.y + rotation * s.x)),
    );
    const median = [...residuals].sort((a, b) => a - b)[residuals.length >> 1]!;
    // Moving water, trees or other aircraft disagree with the camera motion: drop them.
    const kept = shifts.filter((_, i) => residuals[i]! <= Math.max(0.75, 2.5 * median));
    if (kept.length === shifts.length) break;
    shifts = kept;
  }
  if (!parameters || shifts.length < 4) return null;
  const [tx, ty, zoom, rotation] = parameters as [number, number, number, number];
  return { tx, ty, zoom, rotation };
}

export function blockSpectra(frame: Uint8Array): Spectrum[] {
  return BLOCKS.map((block) => spectrum(frame, block.cx, block.cy));
}

/** DJI telemetry subtitles: one block per second, e.g. "… H 26.80m, H.S 10.24m/s, V.S -0.00m/s". */
export function parseFlightSpeed(srt: string): FlightSpeedSample[] {
  const samples: FlightSpeedSample[] = [];
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const time = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3}) -->/m.exec(block);
    const speed = /\bH\.S (-?\d+(?:\.\d+)?)m\/s/.exec(block);
    if (!time || !speed) continue;
    const [hours, minutes, seconds, milliseconds] = time.slice(1).map(Number) as [number, number, number, number];
    samples.push({
      time: hours * 3600 + minutes * 60 + seconds + milliseconds / 1000,
      value: Math.abs(Number(speed[1])),
    });
  }
  return samples;
}

/** Reads only the original's first subtitle track; recordings without one have no flight speed. */
export async function readFlightSpeed(
  tools: { ffmpeg: string; ffprobe: string },
  source: string,
  signal: AbortSignal,
): Promise<FlightSpeedSample[]> {
  const streams = await runProcess(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'csv=p=0', source],
    { signal },
  );
  if (!streams.toString('utf8').trim()) return [];
  const srt = await runProcess(
    tools.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source, '-map', '0:s:0', '-f', 'srt', 'pipe:1'],
    { signal, maxBytes: 16 * 1024 * 1024 },
  );
  return parseFlightSpeed(srt.toString('utf8'));
}

/** Measures every proxy frame against the previous one; the proxy has one frame per source frame. */
export async function analyseProxy(
  ffmpeg: string,
  proxy: string,
  frameCount: number,
  verifiedAt: string,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<Omit<MotionAnalysis, 'flightSpeed'>> {
  const child = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-i',
      proxy,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `scale=${MOTION_WIDTH}:${MOTION_HEIGHT}:flags=area,format=gray`,
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], signal },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve) => {
    child.on('close', resolve);
    child.on('error', () => resolve(null));
  });
  const cancelled = (): void => {
    if (signal.aborted) throw new ServiceError('Job cancelled.', 499);
  };
  const analysis: Omit<MotionAnalysis, 'flightSpeed'> = {
    version: MOTION_ANALYSIS_VERSION,
    verifiedAt,
    frameCount,
    tx: [],
    ty: [],
    zoom: [],
    rotation: [],
  };
  try {
    const reader = RawFrameReader.create(child.stdout, 'Motion analysis decoder', cancelled);
    const frame = Buffer.alloc(FRAME_BYTES);
    let previous: Spectrum[] | null = null;
    let ended = false;
    await whileSerial(
      () => !ended,
      async () => {
        if (!(await reader.readInto(frame))) {
          ended = true;
          return;
        }
        if (analysis.tx.length >= frameCount)
          throw new ServiceError('The proxy has more frames than its recording. Prepare it again.', 422);
        const pixels = new Uint8Array(frame);
        const motion = previous ? estimateMotion(previous, pixels) : null;
        analysis.tx.push(motion?.tx ?? null);
        analysis.ty.push(motion?.ty ?? null);
        analysis.zoom.push(motion?.zoom ?? null);
        analysis.rotation.push(motion?.rotation ?? null);
        previous = blockSpectra(pixels);
        if (analysis.tx.length % 30 === 0) progress(analysis.tx.length / frameCount);
      },
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const code = await closed;
  cancelled();
  if (code !== 0) throw new ServiceError(`Motion analysis could not decode the proxy. ${stderr.trim()}`, 422);
  if (analysis.tx.length !== frameCount)
    throw new ServiceError(
      `The proxy delivered ${analysis.tx.length} of ${frameCount} frames. Prepare the recording again.`,
      422,
    );
  return analysis;
}
