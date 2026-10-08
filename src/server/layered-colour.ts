import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { colourSchema, compileGradeInto, type ColourSettings, type PixelGrade } from '../shared/colour.js';
import { LAYERED_EXPORT_RESOURCES } from '../shared/export.js';
import { forEachSerial } from '../shared/serial.js';
import { ServiceError } from './errors.js';
import type { CompositorPool } from './layered-pool.js';

const SIZE = LAYERED_EXPORT_RESOURCES.lutSize;
const RED_STEP = 3;
const GREEN_STEP = SIZE * RED_STEP;
const BLUE_STEP = SIZE * GREEN_STEP;
const LOW = new Uint8Array(256);
const FRACTION = new Float64Array(256);
for (let value = 0; value < 256; value++) {
  const position = (value * (SIZE - 1)) / 255;
  LOW[value] = Math.min(SIZE - 2, Math.floor(position));
  FRACTION[value] = position - LOW[value]!;
}

export function checkLayeredCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new ServiceError('Job cancelled.', 499);
}

function* blueSlices(count: number): Generator<number> {
  for (let index = 0; index < count; index++) yield index;
}

/** Fill whole blue slices [blueStart, blueEnd); red is the fastest-moving coordinate. */
export function fillColourLut(buffer: Float32Array, grade: PixelGrade, blueStart: number, blueEnd: number): void {
  const rgb = new Float64Array(3);
  let offset = blueStart * BLUE_STEP;
  for (let blue = blueStart; blue < blueEnd; blue++) {
    for (let green = 0; green < SIZE; green++) {
      for (let red = 0; red < SIZE; red++) {
        rgb[0] = red / (SIZE - 1);
        rgb[1] = green / (SIZE - 1);
        rgb[2] = blue / (SIZE - 1);
        grade.encoded(rgb);
        buffer[offset++] = rgb[0];
        buffer[offset++] = rgb[1];
        buffer[offset++] = rgb[2];
      }
    }
  }
}

/**
 * Two reusable 65³ Float32 arrays, generated from gradePixel at the SAMPLED
 * parameter values. Tetrahedral approximation, not bitwise CPU/shader parity.
 * No endpoint-grade blending, FFmpeg eq approximation, or per-frame .cube files.
 */
export class ColourLutCache {
  readonly #entries = new Map<string, Float32Array>();
  readonly #buffers: Float32Array[] = [];
  #building = false;
  #generated = 0;
  #generationMs = 0;
  constructor(readonly capacity: 1 | 2 = 2) {}
  get report(): { peakEntries: number; bytes: number; generated: number; generationMs: number } {
    return {
      peakEntries: this.#buffers.length,
      bytes: this.#buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0),
      generated: this.#generated,
      generationMs: this.#generationMs,
    };
  }
  async get(settings: ColourSettings, signal: AbortSignal, pool: CompositorPool | null = null): Promise<Float32Array> {
    checkLayeredCancellation(signal);
    if (this.#building)
      throw new Error('LUT generation is sequential; concurrent requests would invalidate borrowed LUTs.');
    const value = colourSchema.parse(settings);
    const key = JSON.stringify(value);
    const cached = this.#entries.get(key);
    if (cached) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached;
    }
    let buffer: Float32Array;
    if (this.#entries.size === this.capacity) {
      const oldest = this.#entries.keys().next().value!;
      buffer = this.#entries.get(oldest)!;
      this.#entries.delete(oldest);
    } else {
      buffer =
        this.#buffers.find((candidate) => ![...this.#entries.values()].includes(candidate)) ??
        new Float32Array(new SharedArrayBuffer(SIZE ** 3 * 3 * Float32Array.BYTES_PER_ELEMENT));
      if (!this.#buffers.includes(buffer)) this.#buffers.push(buffer);
    }
    this.#building = true;
    const started = performance.now();
    try {
      if (pool) await pool.fillLut(buffer, value, SIZE);
      else {
        const grade = compileGradeInto(value);
        // Cancellation remains responsive while building a changing grade.
        await forEachSerial(blueSlices(SIZE), async (blue) => {
          fillColourLut(buffer, grade, blue, blue + 1);
          await yieldToEvents();
          checkLayeredCancellation(signal);
        });
      }
      checkLayeredCancellation(signal);
      this.#entries.set(key, buffer);
      this.#generated++;
      return buffer;
    } finally {
      this.#generationMs += performance.now() - started;
      this.#building = false;
    }
  }
}

function lutLow(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 255)
    throw new Error('LUT samples require finite RGB values in [0, 255].');
  return Number.isInteger(value) ? LOW[value]! : Math.min(SIZE - 2, Math.floor((value * (SIZE - 1)) / 255));
}

function lutFraction(value: number, low: number): number {
  return Number.isInteger(value) ? FRACTION[value]! : (value * (SIZE - 1)) / 255 - low;
}

/** Four vertices in the enclosing tetrahedron; destination is a tiny reusable triple. */
export function sampleColourLut(
  lut: Float32Array,
  red: number,
  green: number,
  blue: number,
  destination: Float64Array,
): void {
  // Keep the exact byte lookup path; spatial bilinear samples retain their fractions.
  const redLow = lutLow(red);
  const greenLow = lutLow(green);
  const blueLow = lutLow(blue);
  const r = lutFraction(red, redLow);
  const g = lutFraction(green, greenLow);
  const b = lutFraction(blue, blueLow);
  const first = redLow * RED_STEP + greenLow * GREEN_STEP + blueLow * BLUE_STEP;
  let second: number;
  let third: number;
  let high: number;
  let middle: number;
  let low: number;
  if (r >= g) {
    if (g >= b) {
      second = RED_STEP;
      third = RED_STEP + GREEN_STEP;
      high = r;
      middle = g;
      low = b;
    } else if (r >= b) {
      second = RED_STEP;
      third = RED_STEP + BLUE_STEP;
      high = r;
      middle = b;
      low = g;
    } else {
      second = BLUE_STEP;
      third = BLUE_STEP + RED_STEP;
      high = b;
      middle = r;
      low = g;
    }
  } else if (r >= b) {
    second = GREEN_STEP;
    third = GREEN_STEP + RED_STEP;
    high = g;
    middle = r;
    low = b;
  } else if (g >= b) {
    second = GREEN_STEP;
    third = GREEN_STEP + BLUE_STEP;
    high = g;
    middle = b;
    low = r;
  } else {
    second = BLUE_STEP;
    third = BLUE_STEP + GREEN_STEP;
    high = b;
    middle = g;
    low = r;
  }
  const last = RED_STEP + GREEN_STEP + BLUE_STEP;
  for (let channel = 0; channel < 3; channel++) {
    destination[channel] =
      (1 - high) * lut[first + channel]! +
      (high - middle) * lut[first + second + channel]! +
      (middle - low) * lut[first + third + channel]! +
      low * lut[first + last + channel]!;
  }
}
