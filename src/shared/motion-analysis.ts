import { z } from 'zod';
import type { DamagedRange } from './media.js';

/** Analysis frames are the proxy scaled to this size; motion is measured in its pixels. */
export const MOTION_WIDTH = 320;
export const MOTION_HEIGHT = 180;
export const MOTION_ANALYSIS_VERSION = 3;

/** Image tolerance (% of image width per s²): lower suggests only steadier footage. */
export const SMOOTH_TOLERANCE = { min: 0.5, max: 6, step: 0.1, initial: 2 } as const;
/** Source preview's Allowed movement: the jolts a steady frame may have, from its low end up to its high end. */
export const MOVEMENT_RANGE = { min: 0, max: SMOOTH_TOLERANCE.max, step: 0.1 } as const;
/** Source preview's Flight speed in m/s, both ends included; the high end at `max` is open. */
export const FLIGHT_SPEED_RANGE = { min: 0, max: 20, step: 0.5 } as const;
const SMOOTH_GAP_SECONDS = 0.5;
export const SMOOTH_MIN_SECONDS = 2;
const SMOOTH_MARGIN_SECONDS = 0.2;
/** Below this camera movement (% of image width per s) a frame is still: ~3 min to pan one width. */
export const STILL_SPEED = 0.5;
/** A steady range with at least this share of still frames is a hover with nothing happening. */
export const STILL_SHARE = 0.995;

const motionValues = z.array(z.number().nullable());

/** Values the drone recorded in its telemetry subtitles; null where a line lacks one. */
const telemetryValue = z.number().nullable();
const telemetrySample = z
  .object({
    time: z.number().nonnegative(),
    horizontalSpeed: telemetryValue,
    verticalSpeed: telemetryValue,
    height: telemetryValue,
    distance: telemetryValue,
    iso: telemetryValue,
    shutter: telemetryValue,
    ev: telemetryValue,
    digitalZoom: telemetryValue,
  })
  .strict();
export type TelemetrySample = z.infer<typeof telemetrySample>;
export type TelemetryField = Exclude<keyof TelemetrySample, 'time'>;

/**
 * Global camera motion of each proxy frame relative to the previous one: translation in
 * analysis pixels, zoom and clockwise rotation per frame about the image center. Frame 0
 * and frames without a reliable measurement are null. `telemetry` holds the drone's
 * telemetry subtitles, about once per second from `time` seconds: speeds in m/s (vertical
 * positive upwards), height and distance from home in m, ISO, shutter as the denominator
 * of its 1/x s exposure, exposure bias in EV and digital zoom; it is empty for recordings
 * without such subtitles.
 */
export const motionAnalysisSchema = z
  .object({
    version: z.literal(MOTION_ANALYSIS_VERSION),
    verifiedAt: z.string().min(1),
    frameCount: z.number().int().positive(),
    tx: motionValues,
    ty: motionValues,
    zoom: motionValues,
    rotation: motionValues,
    telemetry: z.array(telemetrySample).max(100_000),
  })
  .strict()
  .refine(
    (analysis) =>
      [analysis.tx, analysis.ty, analysis.zoom, analysis.rotation].every(
        (values) => values.length === analysis.frameCount,
      ),
    'Motion analysis needs one value per frame.',
  );
export type MotionAnalysis = z.infer<typeof motionAnalysisSchema>;

export interface SmoothRange {
  sourceIn: number;
  sourceOut: number;
}

export type Bounds = readonly [low: number, high: number];

/** What a steady frame may show: jolts within `movement` and, where the drone recorded it, flight speed within `flightSpeed`. */
export interface SteadyLimits {
  movement: Bounds;
  flightSpeed: Bounds;
}

/** Jolts below `allowedMovement`, at any flight speed. */
export function steadyLimits(allowedMovement: number = SMOOTH_TOLERANCE.initial): SteadyLimits {
  return {
    movement: [MOVEMENT_RANGE.min, allowedMovement],
    flightSpeed: [FLIGHT_SPEED_RANGE.min, FLIGHT_SPEED_RANGE.max],
  };
}

function telemetryBetween(
  a: TelemetrySample,
  b: TelemetrySample | undefined,
  field: TelemetryField,
  seconds: number,
): number | null {
  const from = a[field];
  if (from === null) return null;
  const to = b?.[field] ?? null;
  if (b === undefined || to === null) return seconds - a.time <= 1 ? from : null;
  return from + ((to - from) * (seconds - a.time)) / (b.time - a.time);
}

/** A telemetry value at a frame, linear between samples and held for a second after the last; null before the first. */
export function telemetryAt(
  telemetry: readonly TelemetrySample[],
  field: TelemetryField,
  frame: number,
  fps: number,
): number | null {
  const seconds = frame / fps;
  const next = telemetry.findIndex((sample) => sample.time > seconds);
  if (next === 0) return null;
  if (next === -1) {
    const last = telemetry.at(-1);
    return last === undefined ? null : telemetryBetween(last, undefined, field, seconds);
  }
  return telemetryBetween(telemetry[next - 1]!, telemetry[next], field, seconds);
}

/** telemetryAt for every frame, in one pass over the samples. */
function telemetryFrames(
  telemetry: readonly TelemetrySample[],
  field: TelemetryField,
  count: number,
  fps: number,
): (number | null)[] {
  let next = 0;
  return Array.from({ length: count }, (_, frame) => {
    const seconds = frame / fps;
    while (next < telemetry.length && telemetry[next]!.time <= seconds) next++;
    if (next === 0) return null;
    return telemetryBetween(telemetry[next - 1]!, telemetry[next], field, seconds);
  });
}

function gaussian(values: readonly number[], sigma: number): number[] {
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  return values.map((_, t) => {
    let sum = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k++) {
      const value = values[t + k];
      if (value === undefined) continue;
      sum += value * kernel[k + radius]!;
      weight += kernel[k + radius]!;
    }
    return sum / weight;
  });
}

function filled(values: readonly (number | null)[]): number[] {
  // Frame 0 has no predecessor: it must not look like a jolt from standstill.
  let last = values.find((value) => value !== null) ?? 0;
  return values.map((value) => {
    if (value !== null) last = value;
    return last;
  });
}

export interface MotionProfile {
  /** Camera motion per frame, in % of image width per second. */
  speed: number[];
  /** How fast that motion changes, in % of image width per s². */
  roughness: number[];
  /** The drone's recorded horizontal speed in m/s; null where it recorded none. */
  flightSpeed: (number | null)[];
}

/** Zoom and rotation count as the displacement they cause 100 analysis pixels from the center. */
export function motionProfile(analysis: MotionAnalysis, fps: number): MotionProfile {
  const perSecond = (100 / MOTION_WIDTH) * fps;
  const components = [
    filled(analysis.tx),
    filled(analysis.ty),
    filled(analysis.zoom).map((value) => value * 100),
    filled(analysis.rotation).map((value) => value * 100),
  ].map((values) =>
    gaussian(
      values.map((value) => value * perSecond),
      4,
    ),
  );
  const n = analysis.frameCount;
  const span = 5;
  const acceleration = Array.from({ length: n }, (_, t) => {
    const a = Math.max(0, t - span);
    const b = Math.min(n - 1, t + span);
    if (a === b) return 0;
    return Math.hypot(...components.map((values) => values[b]! - values[a]!)) / ((b - a) / fps);
  });
  return {
    speed: Array.from({ length: n }, (_, t) => Math.hypot(...components.map((values) => values[t]!))),
    roughness: gaussian(acceleration, 8),
    flightSpeed: telemetryFrames(analysis.telemetry, 'horizontalSpeed', n, fps),
  };
}

function withinFlightSpeed(speed: number | null, [low, high]: Bounds): boolean {
  // Frames without a recorded speed are not judged by it.
  if (speed === null) return true;
  return speed >= low && (high >= FLIGHT_SPEED_RANGE.max || speed <= high);
}

function steadyMask(profile: MotionProfile, limits: SteadyLimits, gap: number): boolean[] {
  const [low, high] = limits.movement;
  const steady = profile.roughness.map(
    (value, frame) =>
      value >= low && value < high && withinFlightSpeed(profile.flightSpeed[frame] ?? null, limits.flightSpeed),
  );
  // Short jolts between steady stretches do not split a flight.
  let start = 0;
  while (start < steady.length) {
    if (steady[start]) {
      start++;
      continue;
    }
    let end = start;
    while (end < steady.length && !steady[end]) end++;
    if (start > 0 && end < steady.length && end - start < gap) steady.fill(true, start, end);
    start = end;
  }
  return steady;
}

function still(speed: readonly number[], sourceIn: number, sourceOut: number): boolean {
  let frames = 0;
  for (let frame = sourceIn; frame < sourceOut; frame++) if (speed[frame]! < STILL_SPEED) frames++;
  return frames >= STILL_SHARE * (sourceOut - sourceIn);
}

/**
 * Steady stretches of at least two seconds within the limits, longest first, as source IN/exclusive
 * OUT. A stretch where the camera hardly moves at all is left out: the drone is hovering without
 * filming anything. Damaged frames, shown black, are never steady: their black has no motion to measure.
 */
export function smoothRanges(
  profile: MotionProfile,
  limits: SteadyLimits,
  fps: number,
  damage: readonly DamagedRange[] = [],
): SmoothRange[] {
  const steady = steadyMask(profile, limits, Math.round(SMOOTH_GAP_SECONDS * fps));
  for (const range of damage) steady.fill(false, range.start, range.end);
  const margin = Math.round(SMOOTH_MARGIN_SECONDS * fps);
  const minimum = SMOOTH_MIN_SECONDS * fps;
  const ranges: SmoothRange[] = [];
  let start = 0;
  while (start < steady.length) {
    if (!steady[start]) {
      start++;
      continue;
    }
    let end = start;
    while (end < steady.length && steady[end]) end++;
    // Keep clear of the rough edge, except at the recording's own ends.
    const sourceIn = start === 0 ? 0 : start + margin;
    const sourceOut = end === steady.length ? end : end - margin;
    if (sourceOut - sourceIn >= minimum && !still(profile.speed, sourceIn, sourceOut))
      ranges.push({ sourceIn, sourceOut });
    start = end;
  }
  return ranges.sort((a, b) => b.sourceOut - b.sourceIn - (a.sourceOut - a.sourceIn) || a.sourceIn - b.sourceIn);
}
