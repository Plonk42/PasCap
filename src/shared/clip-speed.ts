import { sourceRateAt, speedCurveSchema, type RetimedClip, type SpeedCurve, type SpeedCurveKeyframe } from './speed.js';

/** Original preset shapes, not copied application assets or proprietary presets. */
export const CLIP_SPEED_PRESETS = Object.freeze([
  { id: 'flat', label: 'Flat', rates: [1, 1, 1, 1, 1] },
  { id: 'accelerate', label: 'Accelerate', rates: [0.5, 0.5, 1, 2, 2] },
  { id: 'decelerate', label: 'Decelerate', rates: [2, 2, 1, 0.5, 0.5] },
  { id: 'slow-centre', label: 'Slow centre', rates: [2, 1, 0.25, 1, 2] },
  { id: 'fast-centre', label: 'Fast centre', rates: [0.5, 1, 4, 1, 0.5] },
] as const);
export type ClipSpeedPreset = (typeof CLIP_SPEED_PRESETS)[number]['id'];

export function clipSpeedPreset(clip: Pick<RetimedClip, 'sourceIn' | 'sourceOut'>, preset: ClipSpeedPreset): SpeedCurve {
  const definition = CLIP_SPEED_PRESETS.find((item) => item.id === preset);
  if (!definition) throw new Error('Unknown clip speed preset.');
  const keys = new Map<number, SpeedCurveKeyframe>();
  definition.rates.forEach((rate, index) => {
    const frame = clip.sourceIn + Math.round((clip.sourceOut - clip.sourceIn) * index / 4);
    keys.set(frame, { frame, rate, interpolation: 'smooth' });
  });
  return speedCurveSchema.parse({ mode: 'curve', keyframes: [...keys.values()] });
}

/** A deliberate mode switch, not a persisted compatibility default or migration. */
export function editableClipSpeed(clip: RetimedClip): SpeedCurve {
  if (clip.speed.mode === 'curve') return speedCurveSchema.parse(clip.speed);
  if (clip.speed.mode === 'ramp') return speedCurveSchema.parse({ mode: 'curve', keyframes: [
    { frame: clip.speed.anchorIn, rate: clip.speed.startRate, interpolation: clip.speed.curve },
    { frame: clip.speed.anchorOut, rate: clip.speed.endRate, interpolation: 'hold' },
  ] });
  const speed = clipSpeedPreset(clip, 'flat');
  return { ...speed, keyframes: speed.keyframes.map((key) => ({ ...key, rate: sourceRateAt(clip.speed, key.frame) })) };
}

export function updateClipSpeedKey(speed: SpeedCurve, frame: number, changes: Partial<SpeedCurveKeyframe>): SpeedCurve {
  if (!speed.keyframes.some((key) => key.frame === frame)) throw new Error('The clip speed key no longer exists.');
  const keyframes = speed.keyframes.map((key) => key.frame === frame ? { ...key, ...changes } : { ...key }).sort((left, right) => left.frame - right.frame);
  return speedCurveSchema.parse({ mode: 'curve', keyframes });
}

export function addClipSpeedKey(speed: SpeedCurve, frame: number): SpeedCurve {
  if (speed.keyframes.some((key) => key.frame === frame)) throw new Error('A clip speed key already exists at this source frame.');
  const key = { frame, rate: sourceRateAt(speed, frame), interpolation: 'smooth' as const };
  return speedCurveSchema.parse({ mode: 'curve', keyframes: [...speed.keyframes, key].sort((left, right) => left.frame - right.frame) });
}

export function removeClipSpeedKey(speed: SpeedCurve, frame: number): SpeedCurve {
  if (!speed.keyframes.some((key) => key.frame === frame)) throw new Error('The clip speed key no longer exists.');
  return speedCurveSchema.parse({ mode: 'curve', keyframes: speed.keyframes.filter((key) => key.frame !== frame) });
}