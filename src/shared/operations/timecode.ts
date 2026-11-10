import { z } from 'zod';
import { described } from '../described.js';
import { frameSchema } from '../model.js';
import { formatTimecode, framesToSeconds, PROJECT_FPS, sameRate, type FrameRate } from '../timing.js';

export const timecodeSchema = described(
  z.string(),
  "MM:SS:FF: minutes, seconds and frames at 30 nominal frames per second, so 00:12:26 is 12 seconds and 26 frames; a recording's source frames count at its own fps when it has one.",
);

export const durationSchema = z
  .object({
    frames: frameSchema,
    seconds: described(
      z.number().nonnegative(),
      "Length in seconds at 30000/1001 fps (a recording's own fps for its source frames), rounded to hundredths.",
    ),
    timecode: timecodeSchema,
  })
  .strict();

export function durationOf(frames: number, rate: Readonly<FrameRate> = PROJECT_FPS): z.infer<typeof durationSchema> {
  return {
    frames,
    seconds: Math.round(framesToSeconds(frames, rate) * 100) / 100,
    timecode: formatTimecode(frames, rate),
  };
}

export const recordingFpsSchema = described(
  z.number().positive().optional(),
  'Frames per second of a recording not made at 29.97 (30000/1001), such as 30, 59.94 or 25: its source frames count at this rate, and at normal speed a clip plays fps / 29.97 of them per project frame. Absent at 29.97.',
);

export function recordingFps(rate: Readonly<FrameRate>): number | undefined {
  return sameRate(rate, PROJECT_FPS) ? undefined : Math.round((rate.numerator / rate.denominator) * 1000) / 1000;
}
