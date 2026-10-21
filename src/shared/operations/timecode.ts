import { z } from 'zod';
import { described } from '../described.js';
import { frameSchema } from '../model.js';
import { formatTimecode, framesToSeconds } from '../timing.js';

export const timecodeSchema = described(
  z.string(),
  'MM:SS:FF: minutes, seconds and frames at 30 nominal frames per second, so 00:12:26 is 12 seconds and 26 frames.',
);

export const durationSchema = z
  .object({
    frames: frameSchema,
    seconds: described(z.number().nonnegative(), 'Length in seconds at 30000/1001 fps, rounded to hundredths.'),
    timecode: timecodeSchema,
  })
  .strict();

export function durationOf(frames: number): z.infer<typeof durationSchema> {
  return { frames, seconds: Math.round(framesToSeconds(frames) * 100) / 100, timecode: formatTimecode(frames) };
}
