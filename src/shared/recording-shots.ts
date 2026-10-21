import type { DamagedRange } from './media.js';
import {
  MOTION_WIDTH,
  motionProfile,
  smoothRanges,
  SMOOTH_MIN_SECONDS,
  STILL_SPEED,
  type MotionAnalysis,
  type MotionProfile,
  type TelemetrySample,
} from './motion-analysis.js';
import type { SelectRange } from './model.js';

/** A component carrying at least this share of the picture's movement names it alone. */
const DOMINANT_SHARE = 0.6;
/** Below this mean movement (% of image width per s) the picture holds still. */
const STATIC_SPEED = STILL_SPEED;

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
  flight: FlightMeans | null;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * The picture's mean movement over a range as a camera move: content moving right is a pan left,
 * content moving down a tilt up, growing content a push in. A sideways flight looks like a pan.
 */
export function cameraMotion(analysis: MotionAnalysis, sourceIn: number, sourceOut: number, fps: number): string {
  const perSecond = (100 / MOTION_WIDTH) * fps;
  const average = (values: readonly (number | null)[], scale: number) =>
    mean(values.slice(sourceIn, sourceOut).filter((value): value is number => value !== null)) * scale * perSecond;
  const components: [number, string, string][] = [
    [average(analysis.tx, 1), 'pan left', 'pan right'],
    [average(analysis.ty, 1), 'tilt up', 'tilt down'],
    [average(analysis.zoom, 100), 'push in', 'pull out'],
    [average(analysis.rotation, 100), 'rotate counter-clockwise', 'rotate clockwise'],
  ];
  if (Math.hypot(...components.map(([value]) => value)) < STATIC_SPEED) return 'static';
  const total = components.reduce((sum, [value]) => sum + Math.abs(value), 0);
  const named = components
    .map(([value, positive, negative]) => ({ share: Math.abs(value) / total, name: value > 0 ? positive : negative }))
    .sort((left, right) => right.share - left.share);
  return named[0]!.share >= DOMINANT_SHARE ? named[0]!.name : `${named[0]!.name} and ${named[1]!.name}`;
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

function describeShot(analysis: MotionAnalysis, profile: MotionProfile, range: SelectRange, fps: number): SteadyShot {
  const speed = profile.speed.slice(range.sourceIn, range.sourceOut);
  return {
    ...range,
    speed: rounded(mean(speed)),
    peakSpeed: rounded(Math.max(...speed)),
    roughness: rounded(mean(profile.roughness.slice(range.sourceIn, range.sourceOut))),
    motion: cameraMotion(analysis, range.sourceIn, range.sourceOut, fps),
    flight: flightMeans(analysis.telemetry, range.sourceIn, range.sourceOut, fps),
  };
}

/**
 * The steady ranges of a recording inside its kept ranges (none: the whole recording), in source
 * order, and the share of its frames where the picture holds still, as when the drone hovers.
 */
export function recordingShots(
  analysis: MotionAnalysis,
  damage: readonly DamagedRange[],
  kept: readonly SelectRange[] | undefined,
  allowedMovement: number,
  fps: number,
): { shots: SteadyShot[]; stillShare: number } {
  const profile = motionProfile(analysis, fps);
  const shots = smoothRanges(profile, allowedMovement, fps, damage)
    .flatMap((range) => intersect(range, kept, SMOOTH_MIN_SECONDS * fps))
    .sort((left, right) => left.sourceIn - right.sourceIn)
    .map((range) => describeShot(analysis, profile, range, fps));
  const still = profile.speed.filter((value) => value < STILL_SPEED).length;
  return { shots, stillShare: rounded(still / profile.speed.length) };
}
