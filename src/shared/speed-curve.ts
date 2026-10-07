import { interpolatedProgress, type Interpolation } from './keyframes.js';
import type { Retiming, SpeedCurve, SpeedCurveKeyframe } from './speed.js';

interface Segment {
  begin: number;
  end: number;
  timeBegin: number;
  timeEnd: number;
  left: Readonly<SpeedCurveKeyframe>;
  right: Readonly<SpeedCurveKeyframe>;
}

function intervalIndex(keys: readonly SpeedCurveKeyframe[], frame: number): number {
  let low = 0;
  let high = keys.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (keys[middle]!.frame <= frame) low = middle;
    else high = middle - 1;
  }
  return low;
}

function between(left: Readonly<SpeedCurveKeyframe>, right: Readonly<SpeedCurveKeyframe>, frame: number): number {
  if (left.frame === right.frame) return left.rate;
  const progress = interpolatedProgress((frame - left.frame) / (right.frame - left.frame), left.interpolation);
  return left.rate + (right.rate - left.rate) * progress;
}

/** Integer source anchors; first/last rates hold outside their keyed interval. */
export function curveRateAt(speed: Readonly<SpeedCurve>, frame: number): number {
  const keys = speed.keyframes;
  if (frame <= keys[0]!.frame) return keys[0]!.rate;
  const index = intervalIndex(keys, frame);
  return between(keys[index]!, keys[Math.min(index + 1, keys.length - 1)]!, frame);
}

// Positive-half nodes/weights of 16-point Gauss-Legendre quadrature.
const QUADRATURE = Object.freeze([
  [0.0950125098376374, 0.189450610455069],
  [0.281603550779259, 0.182603415044924],
  [0.458016777657227, 0.169156519395003],
  [0.617876244402644, 0.149595988816577],
  [0.755404408355003, 0.124628971255534],
  [0.865631202387832, 0.0951585116824928],
  [0.944575023073233, 0.0622535239386479],
  [0.98940093499165, 0.0271524594117541],
] as const);

function quadrature(
  begin: number,
  end: number,
  leftRate: number,
  difference: number,
  interpolation: Interpolation,
): number {
  const centre = (begin + end) / 2;
  const half = (end - begin) / 2;
  let sum = 0;
  for (const [node, weight] of QUADRATURE) {
    const offset = node * half;
    sum +=
      weight *
      (1 / (leftRate + difference * interpolatedProgress(centre - offset, interpolation)) +
        1 / (leftRate + difference * interpolatedProgress(centre + offset, interpolation)));
  }
  return half * sum;
}

/** Fixed depth and dimensionless tolerance, independent of original clip length. */
function integrateEasing(
  begin: number,
  end: number,
  leftRate: number,
  difference: number,
  interpolation: Interpolation,
  depth = 0,
): number {
  const whole = quadrature(begin, end, leftRate, difference, interpolation);
  const middle = (begin + end) / 2;
  const halves =
    quadrature(begin, middle, leftRate, difference, interpolation) +
    quadrature(middle, end, leftRate, difference, interpolation);
  if (depth === 14 || Math.abs(halves - whole) <= 1e-12 * Math.max(end - begin, Math.abs(halves))) return halves;
  return (
    integrateEasing(begin, middle, leftRate, difference, interpolation, depth + 1) +
    integrateEasing(middle, end, leftRate, difference, interpolation, depth + 1)
  );
}

function elapsed(segment: Segment, end: number): number {
  const { left, right, begin } = segment;
  const length = Math.max(0, end - begin);
  if (left.rate === right.rate || left.interpolation === 'hold') return length / left.rate;
  const width = right.frame - left.frame;
  const startRate = between(left, right, begin);
  if (left.interpolation === 'linear') {
    const slope = (right.rate - left.rate) / width;
    return Math.log1p((slope * length) / startRate) / slope;
  }
  return (
    width *
    integrateEasing(
      (begin - left.frame) / width,
      (end - left.frame) / width,
      left.rate,
      right.rate - left.rate,
      left.interpolation,
    )
  );
}

function sourceInSegment(segment: Segment, amount: number): number {
  if (amount <= 0) return segment.begin;
  const { left, right } = segment;
  if (left.rate === right.rate || left.interpolation === 'hold') return segment.begin + amount * left.rate;
  if (left.interpolation === 'linear') {
    const slope = (right.rate - left.rate) / (right.frame - left.frame);
    return segment.begin + (between(left, right, segment.begin) * Math.expm1(slope * amount)) / slope;
  }
  let low = segment.begin;
  let high = segment.end;
  for (let iteration = 0; iteration < 56; iteration++) {
    const middle = (low + high) / 2;
    if (elapsed(segment, middle) < amount) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function segmentAt(segments: readonly Segment[], value: number, end: 'end' | 'timeEnd'): Segment {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (segments[middle]![end] < value) low = middle + 1;
    else high = middle;
  }
  return segments[low]!;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Retiming queries require finite frame positions.');
  return value;
}

/**
 * Integrate dt=ds/rate(s), splitting at EVERY stored key, even one-frame holds.
 * Linear/hold intervals have closed forms; eased intervals use bounded numerical
 * quadrature. Only final duration is rounded, with the existing clip-base clock
 * normalisation. Storage is O(keys), never O(recording duration).
 */
export function compileClipSpeedCurve(sourceIn: number, sourceOut: number, speed: Readonly<SpeedCurve>): Retiming {
  const keys = speed.keyframes;
  const boundaries = [
    sourceIn,
    ...keys.filter((key) => key.frame > sourceIn && key.frame < sourceOut).map((key) => key.frame),
    sourceOut,
  ];
  const segments: Segment[] = [];
  let total = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const begin = boundaries[index]!;
    const end = boundaries[index + 1]!;
    let left: Readonly<SpeedCurveKeyframe>;
    let right: Readonly<SpeedCurveKeyframe>;
    if (begin < keys[0]!.frame) {
      left = keys[0]!;
      right = left;
    } else {
      const keyIndex = intervalIndex(keys, begin);
      left = keys[keyIndex]!;
      right = keys[Math.min(keyIndex + 1, keys.length - 1)]!;
    }
    const segment = { begin, end, timeBegin: total, timeEnd: total, left, right };
    total += elapsed(segment, end);
    segment.timeEnd = total;
    segments.push(Object.freeze(segment));
  }
  Object.freeze(segments);
  const duration = Math.max(1, Math.round(total));
  const sourceAtTime = (time: number): number => {
    const bounded = Math.max(0, Math.min(total, time));
    const segment = segmentAt(segments, bounded, 'timeEnd');
    return Math.max(sourceIn, Math.min(sourceOut, sourceInSegment(segment, bounded - segment.timeBegin)));
  };
  return {
    duration,
    sourcePositionAt: (frame) => {
      finite(frame);
      if (frame <= 0) return sourceIn;
      if (frame >= duration) return sourceOut;
      return sourceAtTime((frame * total) / duration);
    },
    sourceAt: (frame) =>
      Math.max(sourceIn, Math.min(sourceOut - 1, Math.floor(sourceAtTime((finite(frame) * total) / duration) + 1e-8))),
    outputAt: (source) => {
      const bounded = Math.max(sourceIn, Math.min(sourceOut, finite(source)));
      const segment = segmentAt(segments, bounded, 'end');
      const time = segment.timeBegin + elapsed(segment, bounded);
      return Math.max(0, Math.min(duration - 1, Math.floor((time * duration) / total + 1e-8)));
    },
    rateAt: (frame) => (curveRateAt(speed, sourceAtTime((finite(frame) * total) / duration)) * total) / duration,
  };
}
