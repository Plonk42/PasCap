import { z } from 'zod';
import type { MusicTrack } from './model.js';
import { musicAnalysisSchema } from './music-analysis.js';
import { MUSIC_SAMPLES_PER_FRAME } from './music-format.js';

/** `waveform-v1.json` beside the PCM cache; earlier or stale ones are ignored, never deleted. */
export const WAVEFORM_VERSION = 1;
/** One minimum and maximum per 480 samples (10 ms) of the 48 kHz cache: 200 bytes per second of music. */
export const WAVEFORM_BUCKET = 480;
/** At most this many columns are drawn for one music clip, however wide it is. */
export const WAVEFORM_MAX_COLUMNS = 8192;

export interface DetailWaveform {
  bucketSamples: typeof WAVEFORM_BUCKET;
  /** Base64 of signed bytes, a minimum then a maximum per bucket. */
  data: string;
}

/** The cached detail waveform; `data` is base64 of signed bytes, a minimum then a maximum per bucket. */
export const waveformCacheSchema = z
  .object({
    version: z.literal(WAVEFORM_VERSION),
    source: musicAnalysisSchema.shape.source,
    bucketSamples: z.literal(WAVEFORM_BUCKET),
    data: z.string(),
  })
  .strict();

/** Per bucket of samples, the lowest and highest level of either channel, -127…127 for full scale. */
export interface WaveformLevels {
  bucketSamples: number;
  /** Interleaved minimum and maximum. */
  levels: Int8Array;
}

export interface WaveformColumns {
  /** Lowest and highest level per column, -1…1. */
  min: Float32Array;
  max: Float32Array;
}

export function decodeWaveform(data: string, bucketSamples: number): WaveformLevels {
  const binary = atob(data);
  if (binary.length % 2 !== 0) throw new Error('The waveform holds an incomplete minimum and maximum pair.');
  const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0)!);
  return { bucketSamples, levels: new Int8Array(bytes.buffer) };
}

/** The recording's stored peaks as levels, for the moment the detail waveform is not read yet. */
export function coarseWaveform(peaks: readonly number[], totalSamples: number): WaveformLevels | null {
  if (peaks.length === 0) return null;
  const levels = new Int8Array(peaks.length * 2);
  peaks.forEach((peak, index) => {
    const level = Math.ceil(peak * 127);
    levels[index * 2] = -level;
    levels[index * 2 + 1] = level;
  });
  return { bucketSamples: totalSamples / peaks.length, levels };
}

type Clip = Pick<MusicTrack, 'sourceIn' | 'sourceOut' | 'duration' | 'loop'>;

/** The source frames a stretch of the clip plays, as one range or two where a loop wraps. */
function sourceRanges(clip: Clip, from: number, to: number): [number, number][] {
  const length = clip.sourceOut - clip.sourceIn;
  if (!clip.loop) return from >= length ? [] : [[clip.sourceIn + from, clip.sourceIn + Math.min(to, length)]];
  if (to - from >= length) return [[clip.sourceIn, clip.sourceOut]];
  const start = from % length;
  const end = start + (to - from);
  if (end <= length) return [[clip.sourceIn + start, clip.sourceIn + end]];
  return [
    [clip.sourceIn + start, clip.sourceOut],
    [clip.sourceIn, clip.sourceIn + end - length],
  ];
}

/**
 * The lowest and highest level in each of `count` equal columns of a music clip, following its source range and loops.
 * A column covers every bucket it spans, so a short hit stays visible however far the clip is zoomed out.
 */
export function waveformColumns(wave: WaveformLevels, clip: Clip, count: number): WaveformColumns {
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const buckets = wave.levels.length / 2;
  for (let column = 0; column < count; column++) {
    let low = Infinity;
    let high = -Infinity;
    const ranges = sourceRanges(clip, (column * clip.duration) / count, ((column + 1) * clip.duration) / count);
    for (const [from, to] of ranges) {
      const first = Math.floor((from * MUSIC_SAMPLES_PER_FRAME) / wave.bucketSamples);
      const last = Math.max(first, Math.ceil((to * MUSIC_SAMPLES_PER_FRAME) / wave.bucketSamples) - 1);
      for (let bucket = Math.max(0, first); bucket <= Math.min(buckets - 1, last); bucket++) {
        low = Math.min(low, wave.levels[bucket * 2]!);
        high = Math.max(high, wave.levels[bucket * 2 + 1]!);
      }
    }
    min[column] = low === Infinity ? 0 : low / 127;
    max[column] = high === -Infinity ? 0 : high / 127;
  }
  return { min, max };
}

/** How many columns to draw for a clip of this many pixels: no more than the pixels or the buckets it spans. */
export function waveformColumnCount(wave: WaveformLevels, duration: number, pixels: number): number {
  const buckets = Math.ceil((duration * MUSIC_SAMPLES_PER_FRAME) / wave.bucketSamples);
  return Math.max(1, Math.min(WAVEFORM_MAX_COLUMNS, Math.ceil(pixels), buckets));
}
