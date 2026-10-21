import { z } from 'zod';
import { described } from './described.js';
import { interpolationSchema, orderedKeys } from './keyframes.js';
import { compileClipSpeedCurve, curveRateAt } from './speed-curve.js';

const rate = described(z.number().min(0.1).max(8), 'Playback rate, 0.1–8; 1 is normal speed.');
export const MAX_CLIP_SPEED_KEYS = 256;
export const speedCurveKeyframeSchema = z
  .object({
    frame: described(
      z.number().int().nonnegative().max(2_147_483_647),
      'Original source frame of the keyframe; it may lie outside the clip range.',
    ),
    rate,
    interpolation: described(interpolationSchema, 'Easing of the rate toward the next keyframe.'),
  })
  .strict();
export const speedCurveSchema = z
  .object({
    mode: z.literal('curve'),
    keyframes: described(
      z
        .array(speedCurveKeyframeSchema)
        .min(1)
        .max(MAX_CLIP_SPEED_KEYS)
        .refine(orderedKeys, { message: 'Clip speed keyframes must have unique ascending source frames.' }),
      '1–256 keyframes at unique ascending source frames; the first and last rates hold beyond them.',
    ),
  })
  .strict();
export type SpeedCurveKeyframe = z.infer<typeof speedCurveKeyframeSchema>;
export type SpeedCurve = z.infer<typeof speedCurveSchema>;
export const speedSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('constant'), rate }).strict(),
  speedCurveSchema,
]);
export type SpeedSettings = z.infer<typeof speedSchema>;
export const NORMAL_SPEED: Readonly<SpeedSettings> = Object.freeze({ mode: 'constant', rate: 1 });
export interface RetimedClip {
  sourceIn: number;
  sourceOut: number;
  speed: SpeedSettings;
  /** Plays the selected range from OUT − 1 back to IN; duration is unchanged. */
  reverse: boolean;
}
export interface Retiming {
  duration: number;
  sourceAt: (outputFrame: number) => number;
  /** Continuous original-source coordinate; exclusive OUT at/after duration (at/before 0 when reversed). */
  sourcePositionAt: (outputFrame: number) => number;
  outputAt: (sourceFrame: number) => number;
}

export function sourceRateAt(speed: SpeedSettings, sourceFrame: number): number {
  return speed.mode === 'constant' ? speed.rate : curveRateAt(speed, sourceFrame);
}

function finiteFrame(frame: number): number {
  if (!Number.isFinite(frame)) throw new Error('Retiming queries require finite frame positions.');
  return frame;
}

/**
 * Mirror a forward map in output time, so speed keys stay on the same footage.
 * Moving backwards, a continuous position x shows the frame whose interval
 * [k, k + 1) it is leaving: ceil(x) − 1. Constant rates equal the source mirror.
 */
function reversed(forward: Retiming, sourceIn: number, sourceOut: number): Retiming {
  const { duration } = forward;
  return {
    duration,
    sourcePositionAt: (frame) => forward.sourcePositionAt(duration - finiteFrame(frame)),
    sourceAt: (frame) =>
      Math.max(
        sourceIn,
        Math.min(sourceOut - 1, Math.ceil(forward.sourcePositionAt(duration - finiteFrame(frame)) - 1e-8) - 1),
      ),
    outputAt: (source) => duration - 1 - forward.outputAt(source),
  };
}

const cache = new Map<string, Retiming>();
/** Constant rates have a closed form; curves integrate dt=ds/rate(s). See SPEED_AND_AUDIO.md. */
export function compileRetiming(clip: RetimedClip): Retiming {
  // Cached closures own the numeric range/settings; later editor mutations must
  // not change an already compiled map or another immutable export snapshot.
  clip = Object.freeze({
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    speed: Object.freeze(speedSchema.parse(clip.speed)),
    reverse: clip.reverse,
  });
  if (typeof clip.reverse !== 'boolean') throw new Error('Retiming requires an explicit playback direction.');
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
  const key = JSON.stringify([clip.sourceIn, clip.sourceOut, clip.speed, clip.reverse]);
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
    };
  } else {
    result = compileClipSpeedCurve(clip.sourceIn, clip.sourceOut, clip.speed);
  }
  if (result.duration > 2_147_483_647) throw new RangeError('Track duration exceeds supported project frames.');
  if (clip.reverse) result = reversed(result, clip.sourceIn, clip.sourceOut);
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
