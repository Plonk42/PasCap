import { z } from 'zod';
import { fingerprintSchema } from './media.js';
import { frameSchema, idSchema } from './model.js';
import type { MusicTrack } from './model.js';

export const audioAssetSchema = z.object({
  id: idSchema, name: z.string(), sourcePath: z.string(), fingerprint: fingerprintSchema,
  metadata: z.object({ codec: z.string(), sampleRate: z.number().int().positive(), channels: z.number().int().positive(), durationSeconds: z.number().positive(), frameCount: frameSchema.positive() }).strict(),
  status: z.enum(['registered', 'queued', 'preparing', 'ready', 'error']), error: z.string().nullable(),
  waveform: z.array(z.number().min(0).max(1)).max(2048),
}).strict();
export type AudioAsset = z.infer<typeof audioAssetSchema>;

export function musicGainAt(music: MusicTrack, frame: number): number {
  const offset = frame - music.start;
  if (offset < 0 || offset >= music.duration) return 0;
  const fadeIn = music.fadeIn ? Math.min(1, offset / music.fadeIn) : 1;
  const fadeOut = music.fadeOut ? Math.min(1, (music.duration - offset) / music.fadeOut) : 1;
  return 10 ** (music.gainDb / 20) * fadeIn * fadeOut;
}
export function musicSourceFrame(music: MusicTrack, frame: number): number | null {
  const offset = frame - music.start;
  if (offset < 0 || offset >= music.duration) return null;
  const length = music.sourceOut - music.sourceIn;
  if (!music.loop && offset >= length) return null;
  return music.sourceIn + (music.loop ? offset % length : offset);
}