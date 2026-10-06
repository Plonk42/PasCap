import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { colourSchema, gradePixel, type ColourSettings } from '../shared/colour.js';
import { LAYERED_EXPORT_RESOURCES } from '../shared/export.js';
import { ServiceError } from './errors.js';

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
  async get(settings: ColourSettings, signal: AbortSignal): Promise<Float32Array> {
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
        new Float32Array(SIZE ** 3 * 3);
      if (!this.#buffers.includes(buffer)) this.#buffers.push(buffer);
    }
    this.#building = true;
    const started = performance.now();
    try {
      let offset = 0;
      for (let blue = 0; blue < SIZE; blue++) {
        for (let green = 0; green < SIZE; green++) {
          for (let red = 0; red < SIZE; red++) {
            const rgb = gradePixel([red / (SIZE - 1), green / (SIZE - 1), blue / (SIZE - 1)], value);
            buffer[offset++] = rgb[0];
            buffer[offset++] = rgb[1];
            buffer[offset++] = rgb[2];
          }
          // Cancellation remains responsive while building a changing grade.
          if (green % 16 === 0) {
            await yieldToEvents(); // NOSONAR -- cooperative CPU work, not waiting for a child.
            checkLayeredCancellation(signal);
          }
        }
      }
      this.#entries.set(key, buffer);
      this.#generated++;
      return buffer;
    } finally {
      this.#generationMs += performance.now() - started;
      this.#building = false;
    }
  }
}

/** Four vertices in the enclosing tetrahedron; destination is a tiny reusable triple. */
export function sampleColourLut(
  lut: Float32Array,
  red: number,
  green: number,
  blue: number,
  destination: Float64Array,
): void {
  const r = FRACTION[red]!;
  const g = FRACTION[green]!;
  const b = FRACTION[blue]!;
  const first = LOW[red]! * RED_STEP + LOW[green]! * GREEN_STEP + LOW[blue]! * BLUE_STEP;
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
