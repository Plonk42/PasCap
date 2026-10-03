import { z } from 'zod';
import { keyInterval, layerKeyframeSchema, orderedKeys, type Interpolation } from './keyframes.js';
import type { VideoClip, VideoLayer } from './model.js';
import { compileRetiming, speedSchema, type Retiming } from './speed.js';

const MAX_PROJECT_FRAME = 2_147_483_647;
const frameSchema = z.number().int().nonnegative().max(MAX_PROJECT_FRAME);
const pointsSchema = z.array(layerKeyframeSchema).max(256).refine(orderedKeys, { message: 'Layer points must have unique ascending project frames.' });
const cache = new Map<string, Retiming>();

interface RateSegment {
  readonly begin: number;
  readonly end: number;
  readonly sourceBegin: number;
  readonly sourceEnd: number;
  readonly leftRate: number;
  readonly rightRate: number;
  readonly interpolation: Interpolation;
  readonly keyBegin: number;
  readonly keyEnd: number;
}

/** Integral of the easing polynomial over an interval, expressed as its average.
 * Using local u/v avoids subtracting nearly equal, large absolute primitives.
 */
function averageProgress(u: number, v: number, interpolation: Interpolation): number {
  switch (interpolation) {
    case 'hold': return 0;
    case 'linear': return u + v / 2;
    case 'ease-in': return u * u + u * v + v * v / 3;
    case 'ease-out': return 2 * u - u * u + (1 - u) * v - v * v / 3;
    case 'smooth': return 3 * u * u - 2 * u * u * u + (3 * u - 3 * u * u) * v + (1 - 2 * u) * v * v - v * v * v / 2;
  }
}

function integrate(segment: RateSegment, elapsed: number): number {
  if (segment.leftRate === segment.rightRate || segment.interpolation === 'hold') return segment.leftRate * elapsed;
  const width = segment.keyEnd - segment.keyBegin;
  const u = (segment.begin - segment.keyBegin) / width;
  const v = elapsed / width;
  const average = Math.max(0, Math.min(1, averageProgress(u, v, segment.interpolation)));
  return elapsed * (segment.leftRate + (segment.rightRate - segment.leftRate) * average);
}

function inverseSegment(segment: RateSegment, amount: number): number {
  if (segment.leftRate === segment.rightRate || segment.interpolation === 'hold') return amount / segment.leftRate;
  let low = 0; let high = segment.end - segment.begin;
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (low + high) / 2;
    if (integrate(segment, middle) < amount) low = middle;
    else high = middle;
  }
  return high;
}

function requireFinite(value: number): void {
  if (!Number.isFinite(value)) throw new Error('Retiming queries require finite frame positions.');
}

/** Row speed consumes source frames by integrating rate over absolute project
 * frames. Only the final duration is rounded; key times and rates are never
 * rescaled to that rounded duration. Storage is O(key intervals), not duration.
 */
export function compileLayerRetiming(clip: VideoClip, layer: VideoLayer, start: number): Retiming {
  const sourceIn = frameSchema.parse(clip.sourceIn);
  const sourceOut = frameSchema.parse(clip.sourceOut);
  if (sourceOut <= sourceIn) throw new Error('Retiming requires a positive integer source range.');
  start = frameSchema.parse(start);
  const speed = Object.freeze(speedSchema.parse(clip.speed));
  const points = pointsSchema.parse(layer.keyframes).map((point) => Object.freeze({ ...point, values: Object.freeze(point.values) }));
  const keys = Object.freeze(points.filter((point) => point.values.speed !== null).map((point) => Object.freeze({ frame: point.frame, interpolation: point.interpolation, value: point.values.speed! })));
  if (!keys.length) {
    const retiming = compileRetiming({ sourceIn, sourceOut, speed });
    if (start + retiming.duration > MAX_PROJECT_FRAME) throw new RangeError('Layer duration exceeds supported project frames.');
    return retiming;
  }
  const cacheKey = JSON.stringify([sourceIn, sourceOut, start, keys]);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const length = sourceOut - sourceIn;
  const segments: RateSegment[] = [];
  let consumed = 0;
  const add = (begin: number, end: number, leftRate: number, rightRate: number, interpolation: Interpolation, keyBegin: number, keyEnd: number): void => {
    if (end <= begin || consumed >= length) return;
    const segment = { begin, end, sourceBegin: consumed, sourceEnd: consumed, leftRate, rightRate, interpolation, keyBegin, keyEnd };
    consumed += integrate(segment, end - begin);
    segment.sourceEnd = consumed;
    segments.push(Object.freeze(segment));
  };
  const first = keys[0]!;
  add(start, first.frame, first.value, first.value, 'hold', start, first.frame);
  for (let index = 0; index < keys.length - 1 && consumed < length; index++) {
    const left = keys[index]!; const right = keys[index + 1]!;
    add(Math.max(start, left.frame), right.frame, left.value, right.value, left.interpolation, left.frame, right.frame);
  }
  const last = keys.at(-1)!;
  add(Math.max(start, last.frame), MAX_PROJECT_FRAME, last.value, last.value, 'hold', last.frame, MAX_PROJECT_FRAME);
  if (consumed < length) throw new RangeError('Layer duration exceeds supported project frames.');
  Object.freeze(segments);

  const elapsedAt = (amount: number): number => {
    if (amount <= 0) return 0;
    let low = 0; let high = segments.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (segments[middle]!.sourceEnd < amount) low = middle + 1;
      else high = middle;
    }
    const segment = segments[low]!;
    return segment.begin - start + inverseSegment(segment, amount - segment.sourceBegin);
  };
  const duration = Math.max(1, Math.round(elapsedAt(length)));
  if (start + duration > MAX_PROJECT_FRAME) throw new RangeError('Layer duration exceeds supported project frames.');
  const retiming: Retiming = Object.freeze({
    duration,
    sourceAt: (outputFrame: number): number => {
      requireFinite(outputFrame);
      if (outputFrame <= 0) return sourceIn;
      if (outputFrame >= duration) return sourceOut - 1;
      const frame = start + outputFrame;
      let low = 0; let high = segments.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (segments[middle]!.end < frame) low = middle + 1;
        else high = middle;
      }
      const segment = segments[low]!;
      const source = sourceIn + segment.sourceBegin + integrate(segment, frame - segment.begin);
      return Math.max(sourceIn, Math.min(sourceOut - 1, Math.floor(source + 1e-8)));
    },
    outputAt: (sourceFrame: number): number => {
      requireFinite(sourceFrame);
      const elapsed = elapsedAt(Math.max(0, Math.min(length, sourceFrame - sourceIn)));
      return Math.max(0, Math.min(duration - 1, Math.floor(elapsed + 1e-8)));
    },
    rateAt: (outputFrame: number): number => {
      requireFinite(outputFrame);
      const interval = keyInterval(keys, start + outputFrame)!;
      return interval.left.value + (interval.right.value - interval.left.value) * interval.progress;
    },
  });
  cache.set(cacheKey, retiming);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return retiming;
}