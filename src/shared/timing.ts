export interface FrameRate {
  numerator: number;
  denominator: number;
}

export const PROJECT_FPS: Readonly<FrameRate> = Object.freeze({ numerator: 30_000, denominator: 1_001 });

export function sameRate(a: FrameRate, b: FrameRate): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/** Constant recording rates PasCap accepts, at most 60 fps; source frame n is presented at n / rate. */
export const SOURCE_FRAME_RATES: readonly Readonly<FrameRate>[] = Object.freeze(
  [
    [24_000, 1_001],
    [24, 1],
    [25, 1],
    [30_000, 1_001],
    [30, 1],
    [48_000, 1_001],
    [48, 1],
    [50, 1],
    [60_000, 1_001],
    [60, 1],
  ].map(([numerator, denominator]) => Object.freeze({ numerator: numerator!, denominator: denominator! })),
);

/** The accepted recording rate equal to `rate`, in its stored form, or undefined. */
export function sourceFrameRate(rate: FrameRate): Readonly<FrameRate> | undefined {
  return SOURCE_FRAME_RATES.find((accepted) => sameRate(accepted, rate));
}

export function rateText(rate: FrameRate): string {
  return `${rate.numerator}/${rate.denominator}`;
}

/** A rate in frames per second for people: 29.97, 30, 59.94. */
export function rateLabel(rate: FrameRate): string {
  return String(Math.round((rate.numerator / rate.denominator) * 100) / 100);
}

/** Recording frames that pass during one project frame at normal speed; exactly 1 at the project rate. */
export function sourceFramesPerProjectFrame(rate: FrameRate): number {
  return (rate.numerator * PROJECT_FPS.denominator) / (rate.denominator * PROJECT_FPS.numerator);
}

/** Frame rate of a project's recording: its own entry, else the project rate. */
export function videoRate(
  project: { videoRates: Readonly<Record<string, FrameRate>> },
  mediaId: string,
): Readonly<FrameRate> {
  return Object.hasOwn(project.videoRates, mediaId) ? project.videoRates[mediaId]! : PROJECT_FPS;
}

export function framesToSeconds(frames: number, rate: FrameRate = PROJECT_FPS): number {
  return (frames * rate.denominator) / rate.numerator;
}

export function secondsToFrames(
  seconds: number,
  rate: FrameRate = PROJECT_FPS,
  rounding: 'nearest' | 'floor' = 'nearest',
): number {
  const value = (seconds * rate.numerator) / rate.denominator;
  return rounding === 'floor' ? Math.floor(value + 1e-7) : Math.round(value);
}

export function parseRate(text: string): FrameRate {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  const numerator = Number(match?.[1]);
  const denominator = Number(match?.[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error(`Invalid frame rate: ${text}`);
  }
  return { numerator, denominator };
}

/** Non-drop-frame MM:SS:FF timecode; minutes keep counting past an hour. Integer frames, not wall-clock time. */
export function formatTimecode(frame: number, rate: FrameRate = PROJECT_FPS): string {
  const nominal = Math.ceil(rate.numerator / rate.denominator);
  const totalSeconds = Math.floor(frame / nominal);
  return [Math.floor(totalSeconds / 60), totalSeconds % 60, frame % nominal]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/** The frame of an MM:SS:FF timecode at 30 nominal frames per second, or null when malformed. */
export function parseTimecodeFrames(text: string): number | null {
  const match = /^(\d{1,7}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 30) return null;
  return (Number(match[1]) * 60 + Number(match[2])) * 30 + Number(match[3]);
}
