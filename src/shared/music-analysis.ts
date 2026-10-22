import { z } from 'zod';
import type { MusicTrack } from './model.js';
import { MUSIC_SAMPLE_RATE, MUSIC_SAMPLES_PER_FRAME } from './music-format.js';

/** Version 4 (#261) replaces accents with hits (band, strong); earlier caches are ignored, never deleted. */
export const MUSIC_ANALYSIS_VERSION = 4;
/** Feature rate: one onset-envelope value every 10 ms. */
export const MUSIC_ANALYSIS_HOP = 480;

const sample = z.number().int().nonnegative();
const unit = z.number().min(0).max(1);
const bpm = z.number().positive();

export const sectionKinds = ['quiet', 'build', 'peak', 'release'] as const;
export const swellKinds = ['crescendo', 'decrescendo'] as const;
export const pitchNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
/** The band that rose most at a hit: below 250 Hz (kick, bass), 250 Hz–4 kHz (snare, most instruments), above. */
export const hitBands = ['low', 'mid', 'high'] as const;
const decibels = z.number().min(-120).max(0);

/** `music-v4.json` beside the PCM cache; positions are samples of that 48 kHz cache. */
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
    hits: z.array(z.object({ sample, strength: unit, band: z.enum(hitBands), strong: z.boolean() }).strict()),
    /** dBFS of the mono mix per 100 ms. */
    loudness: z.array(decibels),
    /** Per second: dBFS of the low (below 250 Hz), mid and high (from 4 kHz) frequencies. */
    tone: z.array(z.tuple([decibels, decibels, decibels])),
    key: z
      .object({ tonic: z.enum(pitchNames), mode: z.enum(['major', 'minor']), confidence: unit })
      .strict()
      .nullable(),
    silences: z.array(z.object({ fromSample: sample, toSample: sample }).strict()),
    swells: z.array(
      z
        .object({
          fromSample: sample,
          toSample: sample,
          kind: z.enum(swellKinds),
          changeDb: z.number(),
          sudden: z.boolean(),
        })
        .strict(),
    ),
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

export interface PlacedHit {
  frame: number;
  band: (typeof hitBands)[number];
  strong: boolean;
  strength: number;
}

/**
 * Items at source samples of a music clip at project frames, repeated across loops. An item at a
 * fractional source frame lands on the nearest project frame of the placement; the first item on a
 * frame wins it.
 */
function placeSamples<T extends { sample: number }>(
  music: MusicTrack,
  items: readonly T[],
): { frame: number; item: T }[] {
  const length = music.sourceOut - music.sourceIn;
  const end = music.start + music.duration;
  const inRange = items.flatMap((item) => {
    const offset = item.sample / MUSIC_SAMPLES_PER_FRAME - music.sourceIn;
    return offset >= 0 && offset < length ? [{ offset, item }] : [];
  });
  const repeats = music.loop ? Math.ceil(music.duration / length) : 1;
  const placed: { frame: number; item: T }[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const { offset, item } of inRange) {
      const frame = music.start + repeat * length + Math.round(offset);
      if (frame >= end) break;
      if (placed.at(-1)?.frame === frame) continue;
      placed.push({ frame, item });
    }
  }
  return placed;
}

/** Beats of a music clip at project frames, repeated across loops. */
export function musicBeatFrames(music: MusicTrack, beats: MusicAnalysis['beats']): PlacedBeat[] {
  return placeSamples(music, beats).map(({ frame, item }) => ({
    frame,
    downbeat: item.downbeat,
    strength: item.strength,
  }));
}

/** Hits of a music clip at project frames, repeated across loops. */
export function musicHitFrames(music: MusicTrack, hits: MusicAnalysis['hits']): PlacedHit[] {
  return placeSamples(music, hits).map(({ frame, item }) => ({
    frame,
    band: item.band,
    strong: item.strong,
    strength: item.strength,
  }));
}

/** What snapping and cut alignment follow: beats, downbeats only, strong hits, or beats and strong hits. */
export const musicTargets = ['beats', 'downbeats', 'hits', 'beats-hits'] as const;
export type MusicTarget = (typeof musicTargets)[number];

/** The project frames of a music clip that `target` snaps to, ascending and unique. */
export function musicTargetFrames(
  music: MusicTrack,
  analysis: Pick<MusicAnalysis, 'beats' | 'hits'>,
  target: MusicTarget,
): number[] {
  const frames: number[] = [];
  if (target !== 'hits')
    for (const beat of musicBeatFrames(music, analysis.beats))
      if (target !== 'downbeats' || beat.downbeat) frames.push(beat.frame);
  if (target === 'hits' || target === 'beats-hits')
    for (const hit of musicHitFrames(music, analysis.hits)) if (hit.strong) frames.push(hit.frame);
  return [...new Set(frames)].sort((a, b) => a - b);
}

/** A stretch of a music clip at project frames, OUT exclusive. */
export interface PlacedSpan {
  start: number;
  end: number;
}

/**
 * Where a stretch of the recording `[fromSample, toSample)` plays in a music clip, at project
 * frames: clipped to the clip's source range and placement, once per loop.
 */
export function musicSpans(music: MusicTrack, fromSample: number, toSample: number): PlacedSpan[] {
  const length = music.sourceOut - music.sourceIn;
  const end = music.start + music.duration;
  const from = Math.max(fromSample / MUSIC_SAMPLES_PER_FRAME, music.sourceIn) - music.sourceIn;
  const to = Math.min(toSample / MUSIC_SAMPLES_PER_FRAME, music.sourceOut) - music.sourceIn;
  if (to <= from) return [];
  const repeats = music.loop ? Math.ceil(music.duration / length) : 1;
  const spans: PlacedSpan[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const start = music.start + repeat * length + Math.round(from);
    const stop = Math.min(end, music.start + repeat * length + Math.round(to));
    if (start >= end) break;
    if (stop > start) spans.push({ start, end: stop });
  }
  return spans;
}

/** "C♯ minor". */
export function keyName(key: NonNullable<MusicAnalysis['key']>): string {
  return `${key.tonic.replace('#', '♯')} ${key.mode}`;
}
