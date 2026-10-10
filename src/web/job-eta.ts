export interface ProgressSample {
  time: number;
  progress: number;
}

/** Recent observations only, so a slower or faster export phase takes over from the previous one. */
export const ETA_WINDOW_MS = 120_000;
/** Below these the observed rate is too noisy to promise anything. */
export const ETA_MIN_SPAN_MS = 15_000;
export const ETA_MIN_PROGRESS = 0.02;

/** Appends an observation; a restart (progress going backwards) discards the old rate. */
export function recordProgress(
  samples: readonly ProgressSample[],
  time: number,
  progress: number,
): readonly ProgressSample[] {
  const last = samples.at(-1);
  if (last && progress < last.progress) return [{ time, progress }];
  // A plateau extends the latest sample instead of piling up identical ones, still lowering the average rate.
  const kept = last?.progress === progress && samples.length > 1 ? samples.slice(0, -1) : samples;
  return [...kept, { time, progress }].filter((sample) => sample.time >= time - ETA_WINDOW_MS);
}

/** Remaining milliseconds at the recent average rate, or null until the rate is meaningful. */
export function estimateRemainingMs(samples: readonly ProgressSample[]): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return null;
  const span = last.time - first.time;
  const gained = last.progress - first.progress;
  if (span < ETA_MIN_SPAN_MS || gained < ETA_MIN_PROGRESS) return null;
  return ((1 - last.progress) * span) / gained;
}

/** Deliberately coarse text: it changes rarely, so the row does not flicker between polls. */
export function formatEta(remainingMs: number | null): string | null {
  if (remainingMs === null) return null;
  const minutes = remainingMs / 60_000;
  if (minutes < 0.75) return 'less than a minute left';
  if (minutes < 60) return `about ${Math.max(1, Math.round(minutes))} min left`;
  const fiveMinutes = Math.round(minutes / 5) * 5;
  const hours = Math.floor(fiveMinutes / 60);
  const rest = fiveMinutes % 60;
  return rest ? `about ${hours} h ${rest} min left` : `about ${hours} h left`;
}
