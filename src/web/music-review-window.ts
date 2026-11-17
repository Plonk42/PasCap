import type { MusicTrack } from '../shared/model.js';
import { musicBeatFrames, musicHitFrames, musicSpans, type MusicAnalysis } from '../shared/music-analysis.js';
import { secondsToFrames } from '../shared/timing.js';

/** How many seconds the zoomed view of Source preview's music shows, from closest to widest. */
export const DETAIL_SECONDS = [5, 10, 20, 40, 80] as const;
export const DEFAULT_DETAIL_SECONDS = 20;
/** A new page starts this share of its length before the frame it shows. */
const PAGE_LEAD = 0.1;

/** The stretch of the recording the zoomed view shows, in frames. */
export interface DetailWindow {
  start: number;
  length: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * The window showing `frame` among `count` frames: kept while it shows it, turned to a page
 * starting just before it when the frame leaves it, and centered on it when its length changes.
 */
export function followWindow(
  current: DetailWindow | null,
  frame: number,
  seconds: number,
  count: number,
): DetailWindow {
  const length = Math.min(count, Math.max(1, secondsToFrames(seconds)));
  if (current?.length === length) {
    if (frame >= current.start && frame < current.start + length) return current;
    return { start: clamp(frame - Math.round(length * PAGE_LEAD), 0, count - length), length };
  }
  return { start: clamp(frame - Math.floor(length / 2), 0, count - length), length };
}

/** A music track playing `[start, start + length)` of the recording at the same frames. */
export function windowTrack(mediaId: string, window: DetailWindow): MusicTrack {
  const sourceOut = window.start + window.length;
  return {
    id: 'music-review-detail',
    mediaId,
    sourceIn: window.start,
    sourceOut,
    start: window.start,
    duration: window.length,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  };
}

export const musicMarkKinds = ['section', 'downbeat', 'hit'] as const;
export type MusicMarkKind = (typeof musicMarkKinds)[number];

/** Where a music clip's section starts, downbeats and strong hits play, ascending: what Previous and Next visit. */
export function musicMarks(whole: MusicTrack, analysis: MusicAnalysis): Record<MusicMarkKind, number[]> {
  return {
    section: analysis.sections
      .flatMap((section) => musicSpans(whole, section.fromSample, section.toSample).map((span) => span.start))
      .sort((left, right) => left - right),
    downbeat: musicBeatFrames(whole, analysis.beats).flatMap((beat) => (beat.downbeat ? [beat.frame] : [])),
    hit: musicHitFrames(whole, analysis.hits).flatMap((hit) => (hit.strong ? [hit.frame] : [])),
  };
}

/** The nearest of ascending `frames` strictly before (−1) or after (1) `frame`. */
export function adjacentMark(frames: readonly number[], frame: number, direction: -1 | 1): number | undefined {
  if (direction > 0) return frames.find((mark) => mark > frame);
  let found: number | undefined;
  for (const mark of frames) {
    if (mark >= frame) break;
    found = mark;
  }
  return found;
}
