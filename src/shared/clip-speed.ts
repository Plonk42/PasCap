import {
  sourceRateAt,
  speedCurveSchema,
  type RetimedClip,
  type SpeedCurve,
  type SpeedCurveKeyframe,
  type SpeedSettings,
} from './speed.js';

/** Original preset shapes, not copied application assets or proprietary presets. */
export const CLIP_SPEED_PRESETS = Object.freeze([
  { id: 'flat', label: 'Flat', rates: [1, 1, 1, 1, 1] },
  { id: 'ramp-up', label: 'Ramp up', rates: [0.5, 2] },
  { id: 'ramp-down', label: 'Ramp down', rates: [2, 0.5] },
  { id: 'accelerate', label: 'Accelerate', rates: [0.5, 0.5, 1, 2, 2] },
  { id: 'decelerate', label: 'Decelerate', rates: [2, 2, 1, 0.5, 0.5] },
  { id: 'slow-centre', label: 'Slow centre', rates: [2, 1, 0.25, 1, 2] },
  { id: 'fast-centre', label: 'Fast centre', rates: [0.5, 1, 4, 1, 0.5] },
] as const);
export type ClipSpeedPreset = (typeof CLIP_SPEED_PRESETS)[number]['id'];

export function clipSpeedPreset(
  clip: Pick<RetimedClip, 'sourceIn' | 'sourceOut'>,
  preset: ClipSpeedPreset,
): SpeedCurve {
  const definition = CLIP_SPEED_PRESETS.find((item) => item.id === preset);
  if (!definition) throw new Error('Unknown clip speed preset.');
  const keys = new Map<number, SpeedCurveKeyframe>();
  const last = definition.rates.length - 1;
  definition.rates.forEach((rate, index) => {
    const frame = clip.sourceIn + Math.round(((clip.sourceOut - clip.sourceIn) * index) / last);
    keys.set(frame, { frame, rate, interpolation: 'smooth' });
  });
  return speedCurveSchema.parse({ mode: 'curve', keyframes: [...keys.values()] });
}

/** A deliberate mode switch, not a persisted compatibility default or migration. */
export function editableClipSpeed(clip: RetimedClip): SpeedCurve {
  if (clip.speed.mode === 'curve') return speedCurveSchema.parse(clip.speed);
  const speed = clipSpeedPreset(clip, 'flat');
  return { ...speed, keyframes: speed.keyframes.map((key) => ({ ...key, rate: sourceRateAt(clip.speed, key.frame) })) };
}

export function updateClipSpeedKey(speed: SpeedCurve, frame: number, changes: Partial<SpeedCurveKeyframe>): SpeedCurve {
  if (!speed.keyframes.some((key) => key.frame === frame)) throw new Error('The clip speed keyframe no longer exists.');
  const keyframes = speed.keyframes
    .map((key) => (key.frame === frame ? { ...key, ...changes } : { ...key }))
    .sort((left, right) => left.frame - right.frame);
  return speedCurveSchema.parse({ mode: 'curve', keyframes });
}

/** Captures the displayed rate at `frame`; a constant clip becomes a one-keyframe curve. */
export function addClipSpeedKey(speed: SpeedSettings, frame: number): SpeedCurve {
  const keyframes = speed.mode === 'curve' ? speed.keyframes : [];
  if (keyframes.some((key) => key.frame === frame))
    throw new Error('A clip speed keyframe already exists at this source frame.');
  const key = { frame, rate: sourceRateAt(speed, frame), interpolation: 'linear' as const };
  return speedCurveSchema.parse({
    mode: 'curve',
    keyframes: [...keyframes, key].sort((left, right) => left.frame - right.frame),
  });
}

/** Removing the last keyframe keeps its rate as the clip's constant speed. */
export function removeClipSpeedKey(speed: SpeedCurve, frame: number): SpeedSettings {
  const removed = speed.keyframes.find((key) => key.frame === frame);
  if (!removed) throw new Error('The clip speed keyframe no longer exists.');
  if (speed.keyframes.length === 1) return { mode: 'constant', rate: removed.rate };
  return speedCurveSchema.parse({ mode: 'curve', keyframes: speed.keyframes.filter((key) => key !== removed) });
}

/** The main rate edits a constant clip, or its keyframe at the displayed source frame. */
export function editClipSpeedRate(speed: SpeedSettings, frame: number | null, rate: number): SpeedSettings {
  if (speed.mode === 'constant') return { mode: 'constant', rate };
  if (frame === null || !speed.keyframes.some((key) => key.frame === frame))
    throw new Error('Add a speed keyframe at this source frame before changing its rate.');
  return updateClipSpeedKey(speed, frame, { rate });
}
