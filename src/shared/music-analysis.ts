import { z } from 'zod';
import { MAX_BOOKMARKS, type MusicTrack } from './model.js';
import { MUSIC_SAMPLE_RATE, MUSIC_SAMPLES_PER_FRAME } from './music-format.js';

export const MUSIC_ANALYSIS_VERSION = 1;
/** Feature rate: one onset-envelope value every 10 ms. */
export const MUSIC_ANALYSIS_HOP = 480;

const sample = z.number().int().nonnegative();
const unit = z.number().min(0).max(1);
const bpm = z.number().positive();

export const sectionKinds = ['quiet', 'build', 'peak', 'release'] as const;

/** `music-v1.json` beside the PCM cache; positions are samples of that 48 kHz cache. */
export const musicAnalysisSchema = z
  .object({
    version: z.literal(MUSIC_ANALYSIS_VERSION),
    /** The PCM cache it describes: a re-prepared cache or a changed original makes it stale. */
    source: z
      .object({
        content: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().positive(),
        mtimeMs: z.number().nonnegative(),
      })
      .strict(),
    sampleRate: z.literal(MUSIC_SAMPLE_RATE),
    hop: z.literal(MUSIC_ANALYSIS_HOP),
    samples: sample,
    tempo: z
      .object({
        bpm,
        confidence: unit,
        curve: z.array(z.object({ fromSample: sample, bpm }).strict()).min(1),
      })
      .strict()
      .nullable(),
    meter: z
      .object({ beatsPerBar: z.union([z.literal(3), z.literal(4)]), confidence: unit })
      .strict()
      .nullable(),
    beats: z.array(z.object({ sample, strength: unit, downbeat: z.boolean() }).strict()),
    accents: z.array(z.object({ sample, strength: unit }).strict()),
    /** dBFS of the mono mix per 100 ms. */
    loudness: z.array(z.number().min(-120).max(0)),
    sections: z.array(
      z.object({ fromSample: sample, toSample: sample, kind: z.enum(sectionKinds), loudnessDb: z.number() }).strict(),
    ),
  })
  .strict();
export type MusicAnalysis = z.infer<typeof musicAnalysisSchema>;
/** What the analysis measures; the service adds the cache identity. */
export type MusicMeasurement = Omit<MusicAnalysis, 'version' | 'source'>;

export interface PlacedBeat {
  frame: number;
  downbeat: boolean;
  strength: number;
}

/**
 * Beats of a music track at project frames, repeated across loops. A beat at a fractional
 * source frame lands on the nearest project frame of the placement.
 */
export function musicBeatFrames(music: MusicTrack, beats: MusicAnalysis['beats']): PlacedBeat[] {
  const length = music.sourceOut - music.sourceIn;
  const end = music.start + music.duration;
  const inRange = beats.flatMap((beat) => {
    const offset = beat.sample / MUSIC_SAMPLES_PER_FRAME - music.sourceIn;
    return offset >= 0 && offset < length ? [{ offset, beat }] : [];
  });
  const repeats = music.loop ? Math.ceil(music.duration / length) : 1;
  const placed: PlacedBeat[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const { offset, beat } of inRange) {
      const frame = music.start + repeat * length + Math.round(offset);
      if (frame >= end) break;
      if (placed.at(-1)?.frame === frame) continue;
      placed.push({ frame, downbeat: beat.downbeat, strength: beat.strength });
    }
  }
  return placed;
}

export type BeatChoice = 'beats' | 'downbeats';

/**
 * The bookmarks Beats → bookmarks would add for a music track: its beats (or downbeats) at
 * project frames that are not bookmarks yet, or why none can be added. Never a partial add.
 */
export function beatBookmarks(
  bookmarks: readonly number[],
  music: MusicTrack,
  beats: MusicAnalysis['beats'],
  choice: BeatChoice,
): { frames: number[]; reason: string } {
  const existing = new Set(bookmarks);
  const placed = musicBeatFrames(music, beats).filter((beat) => choice === 'beats' || beat.downbeat);
  const frames = placed.map((beat) => beat.frame).filter((frame) => !existing.has(frame));
  const noun = choice === 'beats' ? 'beat' : 'downbeat';
  if (!placed.length) return { frames, reason: `No ${noun}s fall within this music track's placement.` };
  if (!frames.length) return { frames, reason: `Every ${noun} of this music track is already a bookmark.` };
  if (bookmarks.length + frames.length > MAX_BOOKMARKS)
    return {
      frames,
      reason: `${frames.length.toLocaleString('en')} ${noun}s would exceed ${MAX_BOOKMARKS.toLocaleString('en')} bookmarks (${bookmarks.length.toLocaleString('en')} already set).${choice === 'beats' ? ' Add downbeats only instead.' : ''}`,
    };
  return { frames, reason: '' };
}
