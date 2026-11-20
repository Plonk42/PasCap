import { frameLayout } from '../look-match.js';
import { measureDetail, type LumaFrame } from '../detail-estimate.js';
import type { DamagedRange } from '../media.js';
import type { SelectRange } from '../model.js';
import { motionProfile, type MotionAnalysis, type SteadyLimits } from '../motion-analysis.js';
import { recordingShots, SHOT_WEIGHTS, type FlightMeans, type ShotKind } from '../recording-shots.js';
import { NORMAL_SPEED, clipDuration } from '../speed.js';
import type { FrameRate } from '../timing.js';
import type { AnalysisFrame } from '../white-balance.js';
import { AUTO_EDIT } from './constants.js';

/** A prepared, analyzed recording of the bin, as auto edit reads it. */
export interface AutoEditRecording {
  mediaId: string;
  name: string;
  frameCount: number;
  rate: Readonly<FrameRate>;
  analysis: MotionAnalysis;
  damage: readonly DamagedRange[];
  /** Kept ranges; undefined keeps the whole recording. */
  kept: readonly SelectRange[] | undefined;
}

/** What a candidate's pictures show. */
export interface PictureFeatures {
  /** Share of pixels with a clipped channel, and of crushed shadows, over the frames. */
  clipped: number;
  crushed: number;
  /** Spread of encoded luma, p95 − p5, median over the frames. */
  contrast: number;
  /** Hasler–Süsstrunk colorfulness / 100, median over the frames. */
  colorfulness: number;
  /** Detail estimate softness, 0 crisp to 1 very soft; null on uniform frames. */
  blur: number | null;
  /** Coarse log-luma layouts of the frames, for scene likeness. */
  layouts: (number[] | null)[];
}

/** A steady range inside the kept ranges, one shot auto edit may use. */
export interface Candidate {
  id: string;
  mediaId: string;
  name: string;
  /** Recording position in flight order (natural order of names). */
  recording: number;
  sourceIn: number;
  sourceOut: number;
  rate: Readonly<FrameRate>;
  /** Project frames it lasts at normal speed. */
  frames: number;
  seconds: number;
  kind: ShotKind;
  motion: string;
  rank: number;
  speed: number;
  jolts: number;
  flight: FlightMeans | null;
  iso: number | null;
  /** Where the movement runs, its start and end ramps left out. */
  active: { sourceIn: number; sourceOut: number };
  /** 0, 0.5 or 1: neither, one or both ends of the movement lie inside the range. */
  completeness: number;
  pictures: PictureFeatures | null;
  /** Set by scoreCandidates. */
  energy: number;
  establishing: boolean;
  quality: number;
}

/** A steady range auto edit leaves out, and why. */
export interface LeftOut {
  mediaId: string;
  name: string;
  sourceIn: number;
  sourceOut: number;
  reason: string;
}

const median = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Recordings in the order they were filmed: natural order of their names, as cameras number them. */
export function flightOrder<T extends { name: string; mediaId: string }>(recordings: readonly T[]): T[] {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...recordings].sort(
    (left, right) => collator.compare(left.name, right.name) || left.mediaId.localeCompare(right.mediaId),
  );
}

/** The movement's span without its ramps, and whether it starts and ends inside the range. */
function movementShape(speed: readonly number[], sourceIn: number, sourceOut: number) {
  const values = speed.slice(sourceIn, sourceOut);
  const threshold = AUTO_EDIT.rampShare * median(values);
  let first = 0;
  while (first < values.length - 1 && values[first]! < threshold) first++;
  let last = values.length;
  while (last > first + 1 && values[last - 1]! < threshold) last--;
  const whole = last - first < 0.3 * values.length;
  const tenth = Math.max(5, Math.floor(values.length / 10));
  const peak = [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.9)] ?? 0;
  const calm = (part: readonly number[]) => peak > 0 && mean(part) < AUTO_EDIT.completeShare * peak;
  return {
    active: whole ? { sourceIn, sourceOut } : { sourceIn: sourceIn + first, sourceOut: sourceIn + last },
    completeness: (calm(values.slice(0, tenth)) ? 0.5 : 0) + (calm(values.slice(-tenth)) ? 0.5 : 0),
  };
}

function meanIso(analysis: MotionAnalysis, sourceIn: number, sourceOut: number, fps: number): number | null {
  const values = analysis.telemetry
    .filter((sample) => sample.time >= sourceIn / fps && sample.time < sourceOut / fps && sample.iso !== null)
    .map((sample) => sample.iso!);
  return values.length ? mean(values) : null;
}

function recordingCandidates(recording: AutoEditRecording, index: number, limits: SteadyLimits): Candidate[] {
  const { analysis, rate } = recording;
  const fps = rate.numerator / rate.denominator;
  const { speed } = motionProfile(analysis, fps);
  return recordingShots(analysis, recording.damage, recording.kept, limits, fps).shots.map((shot) => {
    const frames = clipDuration(
      { sourceIn: shot.sourceIn, sourceOut: shot.sourceOut, speed: NORMAL_SPEED, reverse: false },
      rate,
    );
    return {
      id: `${recording.mediaId}:${shot.sourceIn}`,
      mediaId: recording.mediaId,
      name: recording.name,
      recording: index,
      sourceIn: shot.sourceIn,
      sourceOut: shot.sourceOut,
      rate,
      frames,
      seconds: (shot.sourceOut - shot.sourceIn) / fps,
      kind: shot.kind,
      motion: shot.motion,
      rank: shot.rank,
      speed: shot.speed,
      jolts: shot.jolts,
      flight: shot.flight,
      iso: meanIso(analysis, shot.sourceIn, shot.sourceOut, fps),
      ...movementShape(speed, shot.sourceIn, shot.sourceOut),
      pictures: null,
      energy: 0,
      establishing: false,
      quality: 0,
    };
  });
}

/**
 * Every steady range of the recordings inside their kept ranges, in flight order: the best of each recording,
 * then the best overall, within the limits of what is measured with pictures.
 */
export function findCandidates(
  recordings: readonly AutoEditRecording[],
  limits: SteadyLimits,
  minimumFrames: number,
): { candidates: Candidate[]; leftOut: LeftOut[] } {
  const leftOut: LeftOut[] = [];
  const left = (candidate: Candidate, reason: string) =>
    leftOut.push({ mediaId: candidate.mediaId, name: candidate.name, ...range(candidate), reason });
  const kept: Candidate[] = [];
  flightOrder(recordings).forEach((recording, index) => {
    for (const candidate of recordingCandidates(recording, index, limits)) {
      if (candidate.frames < minimumFrames) left(candidate, 'Shorter than the shortest clip.');
      else if (candidate.rank > AUTO_EDIT.candidatesPerRecording)
        left(
          candidate,
          `Ranked ${candidate.rank} in its recording; the best ${AUTO_EDIT.candidatesPerRecording} are used.`,
        );
      else kept.push(candidate);
    }
  });
  const byScore = [...kept].sort(
    (a, b) => SHOT_WEIGHTS[b.kind] * Math.min(b.seconds, 10) - SHOT_WEIGHTS[a.kind] * Math.min(a.seconds, 10),
  );
  const chosen = new Set(byScore.slice(0, AUTO_EDIT.maximumCandidates));
  for (const candidate of byScore.slice(AUTO_EDIT.maximumCandidates))
    left(candidate, `More than ${AUTO_EDIT.maximumCandidates} steady ranges: the weaker ones are left out.`);
  return { candidates: kept.filter((candidate) => chosen.has(candidate)), leftOut };
}

function range(candidate: Pick<Candidate, 'sourceIn' | 'sourceOut'>): { sourceIn: number; sourceOut: number } {
  return { sourceIn: candidate.sourceIn, sourceOut: candidate.sourceOut };
}

/** Source frames whose pictures describe a candidate: AUTO_EDIT.pictureShares of its range; the middle one second. */
export function pictureFrames(candidate: Pick<Candidate, 'sourceIn' | 'sourceOut'>): number[] {
  const length = candidate.sourceOut - candidate.sourceIn;
  return AUTO_EDIT.pictureShares.map((share) =>
    Math.min(candidate.sourceOut - 1, candidate.sourceIn + Math.floor(length * share)),
  );
}

/** Exposure, spread and colorfulness of one analysis frame. */
function frameStatistics({ data }: AnalysisFrame) {
  const histogram = new Float64Array(256);
  let clipped = 0;
  let crushed = 0;
  let sumRg = 0;
  let sumYb = 0;
  let squaresRg = 0;
  let squaresYb = 0;
  const pixels = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index]!;
    const green = data[index + 1]!;
    const blue = data[index + 2]!;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    histogram[Math.round(luma)]!++;
    if (Math.max(red, green, blue) >= AUTO_EDIT.clippedCode) clipped++;
    if (luma <= AUTO_EDIT.crushedCode) crushed++;
    const rg = red - green;
    const yb = 0.5 * (red + green) - blue;
    sumRg += rg;
    sumYb += yb;
    squaresRg += rg * rg;
    squaresYb += yb * yb;
  }
  const at = (q: number) => {
    let count = 0;
    for (let code = 0; code < 256; code++) {
      count += histogram[code]!;
      if (count > q * pixels) return code / 255;
    }
    return 1;
  };
  const meanRg = sumRg / pixels;
  const meanYb = sumYb / pixels;
  const spread = Math.sqrt(
    Math.max(0, squaresRg / pixels - meanRg ** 2) + Math.max(0, squaresYb / pixels - meanYb ** 2),
  );
  return {
    clipped: clipped / pixels,
    crushed: crushed / pixels,
    contrast: at(0.95) - at(0.05),
    colorfulness: (spread + 0.3 * Math.hypot(meanRg, meanYb)) / 100,
  };
}

/** What a candidate's analysis frames and its middle luma frame show. */
export function measurePictures(frames: readonly AnalysisFrame[], luma: readonly LumaFrame[]): PictureFeatures {
  const statistics = frames.map(frameStatistics);
  return {
    clipped: mean(statistics.map((item) => item.clipped)),
    crushed: mean(statistics.map((item) => item.crushed)),
    contrast: median(statistics.map((item) => item.contrast)),
    colorfulness: median(statistics.map((item) => item.colorfulness)),
    blur: luma.length ? measureDetail(luma).blur : null,
    layouts: frames.map(frameLayout),
  };
}

/** Each value's percentile among the values, 0 for the least to 1 for the most; ties share theirs. */
export function percentiles(values: readonly number[]): number[] {
  if (values.length < 2) return values.map(() => 0.5);
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((value) => {
    const below = sorted.filter((item) => item < value).length;
    const through = sorted.filter((item) => item <= value).length - 1;
    return (below + through) / 2 / (values.length - 1);
  });
}

/** Risks 0–1 that lower a candidate's quality: exposure (with high ISO), softness and flat or hazy light. */
export function pictureRisks(candidate: Pick<Candidate, 'pictures' | 'iso'>): {
  exposure: number;
  blur: number;
  flat: number;
} {
  const isoRisk =
    candidate.iso === null ? 0 : 0.5 * clamp01((candidate.iso - AUTO_EDIT.iso.from) / AUTO_EDIT.iso.range);
  const pictures = candidate.pictures;
  if (!pictures) return { exposure: isoRisk, blur: 0, flat: 0 };
  const exposed = clamp01(
    (pictures.clipped + pictures.crushed - AUTO_EDIT.exposureAllowance) / AUTO_EDIT.exposureRange,
  );
  const flat =
    0.5 * clamp01((AUTO_EDIT.flat.contrast - pictures.contrast) / AUTO_EDIT.flat.contrast) +
    0.5 * clamp01((AUTO_EDIT.flat.colorfulness - pictures.colorfulness) / AUTO_EDIT.flat.colorfulness);
  return {
    exposure: clamp01(exposed + isoRisk),
    blur: pictures.blur === null ? 0 : clamp01((pictures.blur - AUTO_EDIT.blur.from) / AUTO_EDIT.blur.range),
    flat,
  };
}

/** A candidate's worth: its kind's weight and length, lowered by jolts and picture risks, raised by a whole movement. */
export function candidateQuality(candidate: Candidate, maxJolts: number): number {
  const { quality } = AUTO_EDIT;
  const risks = pictureRisks(candidate);
  const steadiness = 1 - 0.7 * clamp01(candidate.jolts / maxJolts);
  return (
    SHOT_WEIGHTS[candidate.kind] *
    (Math.min(candidate.seconds, quality.lengthCap) / quality.lengthCap) *
    steadiness ** quality.steadiness *
    (1 - risks.exposure) ** quality.exposure *
    (1 - risks.blur) ** quality.blur *
    (1 - risks.flat) ** quality.flat *
    (1 + quality.completeness * candidate.completeness)
  );
}

/** Energy, establishing and quality of every candidate, relative to the others. */
export function scoreCandidates(candidates: readonly Candidate[], maxJolts: number): Candidate[] {
  const speed = percentiles(candidates.map((candidate) => candidate.speed));
  const flightSpeed = percentiles(candidates.map((candidate) => candidate.flight?.horizontalSpeed ?? candidate.speed));
  const height = percentiles(candidates.map((candidate) => candidate.flight?.height ?? 0));
  const distance = percentiles(candidates.map((candidate) => candidate.flight?.distance ?? 0));
  const { establishing } = AUTO_EDIT;
  return candidates.map((candidate, index) => {
    const flown = candidate.flight?.height !== null && candidate.flight?.height !== undefined;
    return {
      ...candidate,
      energy: 0.5 * speed[index]! + 0.3 * flightSpeed[index]! + 0.2 * AUTO_EDIT.energy.kinds[candidate.kind],
      establishing:
        candidate.kind === 'reveal' ||
        (flown &&
          height[index]! >= establishing.height &&
          distance[index]! >= establishing.distance &&
          speed[index]! <= establishing.speed),
      quality: candidateQuality(candidate, maxJolts),
    };
  });
}
