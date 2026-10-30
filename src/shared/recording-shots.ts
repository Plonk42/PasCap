import type { DamagedRange } from './media.js';
import {
  MOTION_WIDTH,
  motionProfile,
  smoothRanges,
  SMOOTH_MIN_SECONDS,
  STILL_SPEED,
  type MotionAnalysis,
  type MotionProfile,
  type SmoothRange,
  type SteadyLimits,
  type TelemetrySample,
} from './motion-analysis.js';
import type { SelectRange } from './model.js';

/** A component carrying at least this share of the picture's movement names it alone. */
const DOMINANT_SHARE = 0.6;
/** Below this mean movement (% of image width per s) the picture holds still. */
const STATIC_SPEED = STILL_SPEED;

/**
 * What a steady range shows, from its mean picture movement and flight data. An orbit turns the
 * picture (a camera looking down at its subject) or slides it sideways while the drone flies; a
 * reveal climbs or pulls out; an approach only pushes in, as when flying at a target. Content
 * moving down is not a reveal: a forward flight looking down moves it as a tilt up does.
 */
export const SHOT_KINDS = ['orbit', 'reveal', 'move', 'approach', 'static'] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];
/** How much each kind of steady range is worth per second: orbits and reveals first. */
export const SHOT_WEIGHTS: Readonly<Record<ShotKind, number>> = {
  orbit: 1,
  reveal: 1,
  move: 0.7,
  approach: 0.4,
  static: 0.2,
};
/** A shot rarely needs more: beyond it, length no longer raises a steady range's score. */
export const SHOT_SCORE_SECONDS = 10;
/** Horizontal speed (m/s) above which a sideways picture movement is a flight, not a pan. */
const FLYING_SPEED = 1;
/** Vertical speed (m/s) of a climb that reveals the view. */
const CLIMB_SPEED = 1;
/** Rotation carrying this share of the movement: the camera circles what it looks down at. */
const TURN_SHARE = 0.3;
/** Sideways movement carrying this share while flying: an orbit or a sideways flight. */
const SIDEWAYS_SHARE = 0.5;
/** Pulling out with this share of the movement reveals the view. */
const REVEAL_SHARE = 0.4;

export interface FlightMeans {
  height: number | null;
  horizontalSpeed: number | null;
  verticalSpeed: number | null;
  distance: number | null;
}

export interface SteadyShot {
  sourceIn: number;
  sourceOut: number;
  /** Mean and highest movement of the picture, % of image width per second. */
  speed: number;
  peakSpeed: number;
  /** Mean change of that movement, % of image width per s², as the allowed movement measures it. */
  roughness: number;
  /** How the picture moves, named as a camera move would make it. */
  motion: string;
  kind: ShotKind;
  /** 1 for the best steady range of the recording, as Source preview suggests it. */
  rank: number;
  flight: FlightMeans | null;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Mean picture movement over a range, % of image width per second: content right, down, growing, turning. */
function meanMovement(analysis: MotionAnalysis, sourceIn: number, sourceOut: number, fps: number) {
  const perSecond = (100 / MOTION_WIDTH) * fps;
  const average = (values: readonly (number | null)[], scale: number) =>
    mean(values.slice(sourceIn, sourceOut).filter((value): value is number => value !== null)) * scale * perSecond;
  const across = average(analysis.tx, 1);
  const down = average(analysis.ty, 1);
  const zoom = average(analysis.zoom, 100);
  const rotation = average(analysis.rotation, 100);
  const total = Math.abs(across) + Math.abs(down) + Math.abs(zoom) + Math.abs(rotation);
  return {
    across,
    down,
    zoom,
    rotation,
    still: Math.hypot(across, down, zoom, rotation) < STATIC_SPEED,
    share: (value: number) => Math.abs(value) / total,
  };
}

/**
 * The picture's mean movement over a range as a camera move: content moving right is a pan left,
 * content moving down a tilt up, growing content a push in. A sideways flight looks like a pan.
 */
export function cameraMotion(analysis: MotionAnalysis, sourceIn: number, sourceOut: number, fps: number): string {
  const movement = meanMovement(analysis, sourceIn, sourceOut, fps);
  if (movement.still) return 'static';
  const components: [number, string, string][] = [
    [movement.across, 'pan left', 'pan right'],
    [movement.down, 'tilt up', 'tilt down'],
    [movement.zoom, 'push in', 'pull out'],
    [movement.rotation, 'rotate counter-clockwise', 'rotate clockwise'],
  ];
  const named = components
    .map(([value, positive, negative]) => ({ share: movement.share(value), name: value > 0 ? positive : negative }))
    .sort((left, right) => right.share - left.share);
  return named[0]!.share >= DOMINANT_SHARE ? named[0]!.name : `${named[0]!.name} and ${named[1]!.name}`;
}

/** What a steady range shows; without flight data a sideways movement counts as a pan. */
export function shotKind(
  analysis: MotionAnalysis,
  sourceIn: number,
  sourceOut: number,
  fps: number,
  flight = flightMeans(analysis.telemetry, sourceIn, sourceOut, fps),
): ShotKind {
  const movement = meanMovement(analysis, sourceIn, sourceOut, fps);
  if (movement.still) return 'static';
  const { across, zoom, rotation, share } = movement;
  const flying = (flight?.horizontalSpeed ?? 0) >= FLYING_SPEED;
  if (share(rotation) >= TURN_SHARE || (flying && share(across) >= SIDEWAYS_SHARE)) return 'orbit';
  const climbing = (flight?.verticalSpeed ?? 0) >= CLIMB_SPEED;
  if (climbing || (zoom < 0 && share(zoom) >= REVEAL_SHARE)) return 'reveal';
  return zoom > 0 && share(zoom) >= DOMINANT_SHARE ? 'approach' : 'move';
}

/** A steady range's worth: its length up to SHOT_SCORE_SECONDS, weighted by its kind. */
export function shotScore(kind: ShotKind, frames: number, fps: number): number {
  return SHOT_WEIGHTS[kind] * Math.min(frames / fps, SHOT_SCORE_SECONDS);
}

/** Ranges best first: by score, then longer, then earlier. */
export function rankRanges<T extends SelectRange>(
  ranges: readonly T[],
  kindOf: (range: T) => ShotKind,
  fps: number,
): T[] {
  const scored = ranges.map((range) => {
    const frames = range.sourceOut - range.sourceIn;
    return { range, frames, score: shotScore(kindOf(range), frames, fps) };
  });
  scored.sort((a, b) => b.score - a.score || b.frames - a.frames || a.range.sourceIn - b.range.sourceIn);
  return scored.map(({ range }) => range);
}

/** Steady ranges best first, as Source preview suggests them. */
export function rankedSmoothRanges(
  analysis: MotionAnalysis,
  ranges: readonly SmoothRange[],
  fps: number,
): SmoothRange[] {
  return rankRanges(ranges, (range) => shotKind(analysis, range.sourceIn, range.sourceOut, fps), fps);
}

/** The best steady range Source preview's Use best keeps, or null without one. */
export function bestSteadyRange(
  analysis: MotionAnalysis,
  damage: readonly DamagedRange[],
  limits: SteadyLimits,
  fps: number,
): SmoothRange | null {
  const ranges = smoothRanges(motionProfile(analysis, fps), limits, fps, damage);
  return rankedSmoothRanges(analysis, ranges, fps)[0] ?? null;
}

/** Mean flight data over a range; null without telemetry there. */
export function flightMeans(
  telemetry: readonly TelemetrySample[],
  sourceIn: number,
  sourceOut: number,
  fps: number,
): FlightMeans | null {
  const samples = telemetry.filter((sample) => sample.time >= sourceIn / fps && sample.time < sourceOut / fps);
  if (!samples.length) return null;
  const field = (key: keyof FlightMeans) => {
    const values = samples.map((sample) => sample[key]).filter((value): value is number => value !== null);
    return values.length ? rounded(mean(values), 1) : null;
  };
  return {
    height: field('height'),
    horizontalSpeed: field('horizontalSpeed'),
    verticalSpeed: field('verticalSpeed'),
    distance: field('distance'),
  };
}

function intersect(range: SelectRange, kept: readonly SelectRange[] | undefined, minimum: number): SelectRange[] {
  if (!kept) return [range];
  return kept
    .map((item) => ({
      sourceIn: Math.max(item.sourceIn, range.sourceIn),
      sourceOut: Math.min(item.sourceOut, range.sourceOut),
    }))
    .filter((piece) => piece.sourceOut - piece.sourceIn >= minimum);
}

function describeShot(
  analysis: MotionAnalysis,
  profile: MotionProfile,
  range: SelectRange,
  fps: number,
): Omit<SteadyShot, 'rank'> {
  const speed = profile.speed.slice(range.sourceIn, range.sourceOut);
  const flight = flightMeans(analysis.telemetry, range.sourceIn, range.sourceOut, fps);
  return {
    ...range,
    speed: rounded(mean(speed)),
    peakSpeed: rounded(Math.max(...speed)),
    roughness: rounded(mean(profile.roughness.slice(range.sourceIn, range.sourceOut))),
    motion: cameraMotion(analysis, range.sourceIn, range.sourceOut, fps),
    kind: shotKind(analysis, range.sourceIn, range.sourceOut, fps, flight),
    flight,
  };
}

/**
 * The steady ranges of a recording inside its kept ranges (none: the whole recording), in source
 * order with their rank, and the share of its frames where the picture holds still, as when the
 * drone hovers.
 */
export function recordingShots(
  analysis: MotionAnalysis,
  damage: readonly DamagedRange[],
  kept: readonly SelectRange[] | undefined,
  limits: SteadyLimits,
  fps: number,
): { shots: SteadyShot[]; stillShare: number } {
  const profile = motionProfile(analysis, fps);
  const described = smoothRanges(profile, limits, fps, damage)
    .flatMap((range) => intersect(range, kept, SMOOTH_MIN_SECONDS * fps))
    .sort((left, right) => left.sourceIn - right.sourceIn)
    .map((range) => describeShot(analysis, profile, range, fps));
  const ranked = rankRanges(described, (shot) => shot.kind, fps);
  const shots = described.map((shot) => ({ ...shot, rank: ranked.indexOf(shot) + 1 }));
  const still = profile.speed.filter((value) => value < STILL_SPEED).length;
  return { shots, stillShare: rounded(still / profile.speed.length) };
}
