import { availableParallelism } from 'node:os';

const MIN_THREADS = 2;
const MAX_THREADS = 8;

/** Per-FFmpeg-process codec/filter thread count: half the host cores, bounded 2–8. */
export function nativeThreadCount(cores = availableParallelism()): number {
  return Math.max(MIN_THREADS, Math.min(MAX_THREADS, Math.floor(cores / 2)));
}

export const NATIVE_THREADS = String(nativeThreadCount());
