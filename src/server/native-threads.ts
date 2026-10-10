import { availableParallelism } from 'node:os';

const MIN_THREADS = 2;
const MAX_THREADS = 8;

/** Per-FFmpeg-process codec/filter thread count: half the host cores, bounded 2–8. */
export function nativeThreadCount(cores = availableParallelism()): number {
  return Math.max(MIN_THREADS, Math.min(MAX_THREADS, Math.floor(cores / 2)));
}

export const NATIVE_THREADS = String(nativeThreadCount());

/**
 * FFV1 threads encode whole slices; FFmpeg's default 2×2 grid leaves threads beyond four idle.
 * Two threads keep FFmpeg's choice, which also enlarges the grid where 2×2 slices are too big (UHD RGBA16).
 */
export function ffv1SliceArguments(threads = nativeThreadCount()): string[] {
  return threads > 2 ? ['-slices', '16'] : [];
}

export const FFV1_SLICE_ARGUMENTS = ffv1SliceArguments();
