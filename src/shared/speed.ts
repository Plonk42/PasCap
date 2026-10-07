import { z } from 'zod';
import { interpolationSchema, orderedKeys } from './keyframes.js';
import { compileClipSpeedCurve, curveRateAt } from './speed-curve.js';

const rate = z.number().min(0.1).max(8);
export const MAX_CLIP_SPEED_KEYS = 256;
export const speedCurveKeyframeSchema = z
  .object({
    frame: z.number().int().nonnegative().max(2_147_483_647),
    rate,
    interpolation: interpolationSchema,
  })
  .strict();
export const speedCurveSchema = z
  .object({
    mode: z.literal('curve'),
    keyframes: z
      .array(speedCurveKeyframeSchema)
      .min(2)
      .max(MAX_CLIP_SPEED_KEYS)
      .refine(orderedKeys, { message: 'Clip speed keys must have unique ascending source frames.' }),
  })
  .strict();
export type SpeedCurveKeyframe = z.infer<typeof speedCurveKeyframeSchema>;
export type SpeedCurve = z.infer<typeof speedCurveSchema>;
export const speedSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('constant'), rate }).strict(),
  z
    .object({
      mode: z.literal('ramp'),
      startRate: rate,
      endRate: rate,
      curve: z.enum(['linear', 'ease-in', 'ease-out', 'smooth']),
      anchorIn: z.number().int().nonnegative().max(2_147_483_647),
      anchorOut: z.number().int().positive().max(2_147_483_647),
    })
    .strict()
    .refine((speed) => speed.anchorOut > speed.anchorIn, {
      message: 'Ramp anchors must enclose a positive source range.',
    }),
  speedCurveSchema,
]);
export type SpeedSettings = z.infer<typeof speedSchema>;
export const NORMAL_SPEED: Readonly<SpeedSettings> = Object.freeze({ mode: 'constant', rate: 1 });
export interface RetimedClip {
  sourceIn: number;
  sourceOut: number;
  speed: SpeedSettings;
}
export interface Retiming {
  duration: number;
  sourceAt: (outputFrame: number) => number;
  /** Continuous original-source coordinate; exclusive OUT at/after duration. */
  sourcePositionAt: (outputFrame: number) => number;
  outputAt: (sourceFrame: number) => number;
  rateAt: (outputFrame: number) => number;
}

export function curveValue(t: number, curve: Extract<SpeedSettings, { mode: 'ramp' }>['curve']): number {
  const u = Math.max(0, Math.min(1, t));
  switch (curve) {
    case 'linear':
      return u;
    case 'ease-in':
      return u * u;
    case 'ease-out':
      return 2 * u - u * u;
    case 'smooth':
      return u * u * (3 - 2 * u);
  }
}
export function sourceRateAt(speed: SpeedSettings, sourceFrame: number): number {
  if (speed.mode === 'constant') return speed.rate;
  if (speed.mode === 'curve') return curveRateAt(speed, sourceFrame);
  const progress = (sourceFrame - speed.anchorIn) / (speed.anchorOut - speed.anchorIn);
  return speed.startRate + (speed.endRate - speed.startRate) * curveValue(progress, speed.curve);
}

function finiteFrame(frame: number): number {
  if (!Number.isFinite(frame)) throw new Error('Retiming queries require finite frame positions.');
  return frame;
}

const cache = new Map<string, Retiming>();
/** Deterministic midpoint integration of dt=ds/rate(s). See SPEED_AND_AUDIO.md. */
export function compileRetiming(clip: RetimedClip): Retiming {
  // Cached closures own the numeric range/settings; later editor mutations must
  // not change an already compiled map or another immutable export snapshot.
  clip = Object.freeze({
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    speed: Object.freeze(speedSchema.parse(clip.speed)),
  });
  if (clip.speed.mode === 'curve') {
    clip.speed.keyframes.forEach(Object.freeze);
    Object.freeze(clip.speed.keyframes);
  }
  const length = clip.sourceOut - clip.sourceIn;
  if (
    !Number.isSafeInteger(clip.sourceIn) ||
    clip.sourceIn < 0 ||
    !Number.isSafeInteger(clip.sourceOut) ||
    clip.sourceOut > 2_147_483_647 ||
    length <= 0
  )
    throw new Error('Retiming requires a positive integer source range within supported frames.');
  const key = JSON.stringify([clip.sourceIn, clip.sourceOut, clip.speed]);
  const cached = cache.get(key);
  if (cached) return cached;
  let result: Retiming;
  if (clip.speed.mode === 'constant') {
    const duration = Math.max(1, Math.round(length / clip.speed.rate));
    const effective = length / duration;
    result = {
      duration,
      sourcePositionAt: (frame) => {
        finiteFrame(frame);
        if (frame <= 0) return clip.sourceIn;
        if (frame >= duration) return clip.sourceOut;
        return clip.sourceIn + frame * effective;
      },
      sourceAt: (frame) =>
        Math.max(
          clip.sourceIn,
          Math.min(clip.sourceOut - 1, clip.sourceIn + Math.floor(finiteFrame(frame) * effective + 1e-8)),
        ),
      outputAt: (source) =>
        Math.max(0, Math.min(duration - 1, Math.floor((finiteFrame(source) - clip.sourceIn) / effective + 1e-8))),
      rateAt: (frame) => {
        finiteFrame(frame);
        return effective;
      },
    };
  } else if (clip.speed.mode === 'curve') {
    result = compileClipSpeedCurve(clip.sourceIn, clip.sourceOut, clip.speed);
  } else {
    const steps = Math.min(4096, Math.max(256, length));
    const step = length / steps;
    const times = new Float64Array(steps + 1);
    for (let i = 0; i < steps; i++)
      times[i + 1] = times[i]! + step / sourceRateAt(clip.speed, clip.sourceIn + (i + 0.5) * step);
    const total = times[steps]!;
    const duration = Math.max(1, Math.round(total));
    const inverse = (time: number): number => {
      let low = 0;
      let high = steps;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2);
        if (times[mid]! <= time) low = mid;
        else high = mid;
      }
      const fraction = (time - times[low]!) / (times[high]! - times[low]!);
      return clip.sourceIn + (low + Math.max(0, Math.min(1, fraction))) * step;
    };
    const forward = (source: number): number => {
      const position = Math.max(0, Math.min(steps - 1e-8, (source - clip.sourceIn) / step));
      const index = Math.floor(position);
      return times[index]! + (times[index + 1]! - times[index]!) * (position - index);
    };
    result = {
      duration,
      sourcePositionAt: (frame) => {
        finiteFrame(frame);
        if (frame <= 0) return clip.sourceIn;
        if (frame >= duration) return clip.sourceOut;
        return inverse((frame * total) / duration);
      },
      sourceAt: (frame) =>
        Math.max(
          clip.sourceIn,
          Math.min(clip.sourceOut - 1, Math.floor(inverse((finiteFrame(frame) * total) / duration) + 1e-8)),
        ),
      outputAt: (source) =>
        Math.max(0, Math.min(duration - 1, Math.floor((forward(finiteFrame(source)) * duration) / total + 1e-8))),
      rateAt: (frame) =>
        (sourceRateAt(clip.speed, inverse((finiteFrame(frame) * total) / duration)) * total) / duration,
    };
  }
  if (result.duration > 2_147_483_647) throw new RangeError('Layer duration exceeds supported project frames.');
  Object.freeze(result);
  cache.set(key, result);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return result;
}

export function clipDuration(clip: RetimedClip): number {
  return compileRetiming(clip).duration;
}
export function sourceFrameAt(clip: RetimedClip, outputFrame: number): number {
  return compileRetiming(clip).sourceAt(outputFrame);
}
export function outputFrameAt(clip: RetimedClip, sourceFrame: number): number {
  return compileRetiming(clip).outputAt(sourceFrame);
}
export function playbackRateAt(clip: RetimedClip, outputFrame: number): number {
  return compileRetiming(clip).rateAt(outputFrame);
}
