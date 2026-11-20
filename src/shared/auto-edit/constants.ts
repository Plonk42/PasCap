import type { ShotKind } from '../recording-shots.js';

type SectionKind = 'quiet' | 'build' | 'peak' | 'release';

/** Auto edit: every constant of the cut it builds; see docs/design/AUTO_EDIT.md. */
export const AUTO_EDIT = Object.freeze({
  /** Shortest and longest clip, in seconds. */
  minimumSeconds: 1.5,
  maximumSeconds: 12,
  /**
   * Seconds per clip at balanced pace by music section, at its start and end (build and peak shorten towards their
   * end); each boundary then falls on the downbeat nearest. Seconds, not beats: aerial shots need time whatever the
   * tempo (the owner's own cut of a 133 bpm song holds clips about 6 s).
   */
  seconds: { quiet: [6, 6], build: [5.5, 4], peak: [4, 3], release: [6, 6] } satisfies Record<
    SectionKind,
    readonly [number, number]
  >,
  /** Seconds per clip without music sections, at balanced pace. */
  beatlessSeconds: 4.5,
  /** How pace scales the seconds per clip. */
  pace: { calm: 1.4, balanced: 1, energetic: 0.65 },
  /** A boundary falls between these shares of the wanted clip length after the previous one. */
  reach: [0.6, 1.6] as const,
  /** The last piece before a section change may be this much longer than wanted instead of split. */
  lastPiece: 1.4,
  /** A cut ends on a section end or downbeat at most this many bars before the target. */
  endBars: 2,
  /** Candidates measured with pictures: the best of each recording, and in all. */
  candidatesPerRecording: 8,
  maximumCandidates: 160,
  /** Picture frames per candidate, as shares of its range; blur is measured at the middle one. */
  pictureShares: [1 / 6, 1 / 2, 5 / 6] as const,
  /** Movement start and end: frames below this share of the median speed are a ramp. */
  rampShare: 0.5,
  /** A range holds a whole movement when its first and last tenths move below this share of its peak. */
  completeShare: 0.6,
  quality: {
    /** Length counts up to this many seconds. */
    lengthCap: 10,
    /** Exponents of steadiness, exposure, blur and flatness, and the bonus for a whole movement. */
    steadiness: 0.5,
    exposure: 1.5,
    blur: 1,
    flat: 0.5,
    completeness: 0.25,
  },
  /** Clipped (any channel at or above) and crushed (luma at or below) 8-bit codes. */
  clippedCode: 250,
  crushedCode: 6,
  /** Clipped plus crushed share allowed before the exposure risk rises, and the share where it is whole. */
  exposureAllowance: 0.03,
  exposureRange: 0.3,
  /** ISO above which noise adds to the exposure risk, and the ISO range to its full half. */
  iso: { from: 400, range: 2400 },
  /** Blur (detail estimate) where softness starts to count, and its range. */
  blur: { from: 0.35, range: 0.5 },
  /** Encoded luma spread (p95 − p5) and colorfulness below which footage looks flat or hazy. */
  flat: { contrast: 0.45, colorfulness: 0.2 },
  energy: {
    kinds: { orbit: 0.8, reveal: 0.7, move: 0.6, approach: 0.5, static: 0 } satisfies Record<ShotKind, number>,
    sections: { quiet: 0.15, release: 0.35, build: 0.6, peak: 0.9 } satisfies Record<SectionKind, number>,
  },
  /** Establishing: a high (percentile), far and calm shot. */
  establishing: { height: 0.7, distance: 0.6, speed: 0.5 },
  score: {
    /** Penalty per unit of energy mismatch, for a repeated kind, bonus for an establishing shot opening a section. */
    energy: 0.35,
    repeatKind: 0.15,
    establishing: 0.3,
    /** Quality share of a take that is not the best of its cluster. */
    duplicate: 0.35,
    /** A range much longer than the slot loses up to this share: the clip shows a fragment of it. */
    fragment: 0.25,
  },
  cluster: {
    /** Best frame similarity of two alike candidates, lower when flight data and order say they are near. */
    similar: 0.82,
    nearSimilar: 0.68,
    near: { height: 15, distance: 60, order: 2 },
    /** Recordings one cluster may span in flight order. */
    span: 6,
  },
  /** Quality share left to a candidate chosen by each earlier variant. */
  variantShare: 0.35,
  /** Candidates below this share of the median quality fill the cut only when the others cannot. */
  weakShare: 0.35,
  dissolve: { beats: 1, minimum: 8, maximum: 15 },
  /** Fade through black, in beats and frames. */
  fadeThroughBlack: { beats: 2, minimum: 12, maximum: 30 },
  /** Opening fade: up to the first beat, within these frames; closing fade: one bar within these seconds. */
  openingFade: { minimum: 8, maximumSeconds: 2 },
  closingFade: { minimumSeconds: 0.5, maximumSeconds: 3 },
  /** Hero of a matched grade: clips at least this share as alike as the most alike one. */
  heroShare: 0.8,
  /**
   * Pace multipliers tried, in order: the strong candidates near the pace asked, then every candidate from the pace
   * asked to slower and faster ones, until the footage fills the cut.
   */
  strongPaces: [1, 0.8, 1.25, 1.5],
  paceFallbacks: [1, 0.8, 1.25, 0.65, 1.5],
  /** Entries listed per report section. */
  reportItems: 40,
});
