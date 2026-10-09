import { z } from 'zod';
import { interpolationSchema, keyInterval, orderedKeys } from './keyframes.js';

// Zod numbers already reject NaN and infinities; no coercion or persisted defaults.
const cropFraction = z.number().min(0).lt(1);

/**
 * Crop removes source coverage; it never refits or moves the original-centre pivot.
 * Opposite edges summing to 1 or more simply cover nothing, so no pairwise refinement.
 */
export const spatialPoseSchema = z
  .object({
    cropLeft: cropFraction,
    cropRight: cropFraction,
    cropTop: cropFraction,
    cropBottom: cropFraction,
    scale: z.number().min(0.1).max(8),
    translateX: z.number().min(-2).max(2),
    translateY: z.number().min(-2).max(2),
    rotation: z.number().min(-180).max(180),
  })
  .strict();

export type SpatialPose = z.infer<typeof spatialPoseSchema>;
export type SpatialChannel = keyof SpatialPose;

/** Ordered control catalogue; every channel animates independently. */
export const SPATIAL_CHANNELS = Object.freeze(Object.keys(spatialPoseSchema.shape) as SpatialChannel[]);

const poseShape = spatialPoseSchema.shape;

/** Each channel is a number (enabled at this key) or null (not keyed here). */
export const spatialKeyValuesSchema = z
  .object({
    cropLeft: poseShape.cropLeft.nullable(),
    cropRight: poseShape.cropRight.nullable(),
    cropTop: poseShape.cropTop.nullable(),
    cropBottom: poseShape.cropBottom.nullable(),
    scale: poseShape.scale.nullable(),
    translateX: poseShape.translateX.nullable(),
    translateY: poseShape.translateY.nullable(),
    rotation: poseShape.rotation.nullable(),
  })
  .strict()
  .refine((values) => Object.values(values).some((value) => value !== null), {
    message: 'A Transform keyframe must enable at least one setting.',
  });

export type SpatialKeyValues = z.infer<typeof spatialKeyValuesSchema>;

export const spatialKeyframeSchema = z
  .object({
    frame: z.number().int().nonnegative().max(2_147_483_647),
    interpolation: interpolationSchema,
    values: spatialKeyValuesSchema,
  })
  .strict();

export type SpatialKeyframe = z.infer<typeof spatialKeyframeSchema>;

export const spatialSettingsSchema = z
  .object({
    base: spatialPoseSchema,
    keyframes: z
      .array(spatialKeyframeSchema)
      .max(256)
      .refine(orderedKeys, { message: 'Spatial keyframes must have unique ascending original-source frames.' }),
  })
  .strict();

export type SpatialSettings = z.infer<typeof spatialSettingsSchema>;

export const NEUTRAL_SPATIAL_POSE: Readonly<SpatialPose> = Object.freeze({
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  scale: 1,
  translateX: 0,
  translateY: 0,
  rotation: 0,
});

/** Creation values only: persisted settings must supply every required field. */
export function createSpatialSettings(): SpatialSettings {
  return { base: { ...NEUTRAL_SPATIAL_POSE }, keyframes: [] };
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function evaluateChannel(
  keys: readonly SpatialKeyframe[],
  channel: SpatialChannel,
  sourcePosition: number,
  base: number,
): number {
  // Each channel interpolates between its own enabled keys, using the left key's easing.
  const interval = keyInterval(
    keys.filter((key) => key.values[channel] !== null),
    sourcePosition,
  );
  if (!interval) return base;
  const { left, right, progress } = interval;
  const from = left.values[channel]!;
  // Exact endpoints also preserve values at Hold boundaries and avoid round-off there.
  if (left === right || progress === 0) return from;
  const to = right.values[channel]!;
  if (progress === 1) return to;
  // Numeric interpolation deliberately travels through zero from +170 to -170.
  return from * (1 - progress) + to * progress;
}

/** Continuous original-source position, not a rounded frame or trim-relative time. */
export function evaluateSpatial(settings: SpatialSettings, sourcePosition: number): SpatialPose {
  requireFinite(sourcePosition, 'Spatial source position');
  const validated = spatialSettingsSchema.parse(settings);
  const pose = { ...validated.base };
  if (!validated.keyframes.length) return pose;
  for (const channel of SPATIAL_CHANNELS)
    pose[channel] = evaluateChannel(validated.keyframes, channel, sourcePosition, validated.base[channel]);
  return pose;
}

/** True when this channel has at least one stored key, so its base is overridden. */
export function hasSpatialChannelKeys(settings: SpatialSettings, channel: SpatialChannel): boolean {
  return settings.keyframes.some((key) => key.values[channel] !== null);
}

/** Channels enabled at one stored key, in control order. */
export function spatialKeyChannels(key: SpatialKeyframe): SpatialChannel[] {
  return SPATIAL_CHANNELS.filter((channel) => key.values[channel] !== null);
}

/** Exact identity only; tiny edits must not enter the legacy opaque-letterbox path. */
export function isNeutralSpatial(pose: Readonly<SpatialPose>): boolean {
  return (
    pose.cropLeft === 0 &&
    pose.cropRight === 0 &&
    pose.cropTop === 0 &&
    pose.cropBottom === 0 &&
    pose.scale === 1 &&
    pose.translateX === 0 &&
    pose.translateY === 0 &&
    pose.rotation === 0
  );
}

/** Even all-neutral keys exclude the static fast path; evaluation can still be identity. */
export function hasSpatialEdits(settings: SpatialSettings): boolean {
  return !isNeutralSpatial(settings.base) || settings.keyframes.length > 0;
}

export type SpatialAffine = readonly [number, number, number, number, number, number];

export interface SpatialMapping {
  /**
   * Top-left, positive-Y-down normalized output (X,Y) to original source (u,v):
   * u = a*X + b*Y + c; v = d*X + e*Y + f. GPU uniforms can use two vec3 rows.
   * Pixel centres use X = (column + 0.5)/targetWidth, likewise Y; no implicit half pixel.
   */
  readonly affine: SpatialAffine;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly fittedWidth: number;
  readonly fittedHeight: number;
  readonly cropLeft: number;
  readonly cropRight: number;
  readonly cropTop: number;
  readonly cropBottom: number;
  /** Rendering hint only. Neither mapping nor coverage makes letterbox pixels opaque. */
  readonly neutral: boolean;
}

function requireDimension(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Spatial dimensions must be positive and finite.');
}

/**
 * Bounded inverse geometry, with no image storage. Fit the authoritative original
 * aspect without rounding, then scale/rotate clockwise about its centre and translate
 * by fractions of the full output. Invert translation, rotation and uniform scale.
 * Crop is tested separately in original UV space, not stretched to fill the output.
 */
export function compileSpatialMapping(
  pose: Readonly<SpatialPose>,
  originalWidth: number,
  originalHeight: number,
  targetWidth: number,
  targetHeight: number,
): SpatialMapping {
  const validated = spatialPoseSchema.parse(pose);
  requireDimension(originalWidth);
  requireDimension(originalHeight);
  requireDimension(targetWidth);
  requireDimension(targetHeight);
  const fit = Math.min(targetWidth / originalWidth, targetHeight / originalHeight);
  const fittedWidth = fit * originalWidth;
  const fittedHeight = fit * originalHeight;
  requireDimension(fit);
  requireDimension(fittedWidth);
  requireDimension(fittedHeight);
  const radians = (validated.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians) / validated.scale;
  const sine = Math.sin(radians) / validated.scale;
  const a = cosine * (targetWidth / fittedWidth);
  const b = sine * (targetHeight / fittedWidth);
  const d = -sine * (targetWidth / fittedHeight);
  const e = cosine * (targetHeight / fittedHeight);
  const centreX = 0.5 + validated.translateX;
  const centreY = 0.5 + validated.translateY;
  const c = 0.5 - a * centreX - b * centreY;
  const f = 0.5 - d * centreX - e * centreY;
  const affine: SpatialAffine = Object.freeze([a, b, c, d, e, f]);
  if (!affine.every(Number.isFinite)) throw new Error('Spatial inverse geometry is not finite.');
  return Object.freeze({
    affine,
    targetWidth,
    targetHeight,
    fittedWidth,
    fittedHeight,
    cropLeft: validated.cropLeft,
    cropRight: validated.cropRight,
    cropTop: validated.cropTop,
    cropBottom: validated.cropBottom,
    neutral: isNeutralSpatial(validated),
  });
}

/** Write original UV into caller-owned storage; x/y are output pixel-centre coordinates. */
export function mapSpatialPoint(mapping: SpatialMapping, x: number, y: number, out: Float64Array): Float64Array {
  requireFinite(x, 'Spatial output X');
  requireFinite(y, 'Spatial output Y');
  if (!(out instanceof Float64Array) || out.length !== 2)
    throw new Error('Spatial point output must be a two-element Float64Array.');
  const affine = mapping.affine;
  const normalizedX = x / mapping.targetWidth;
  const normalizedY = y / mapping.targetHeight;
  const u = affine[0] * normalizedX + affine[1] * normalizedY + affine[2];
  const v = affine[3] * normalizedX + affine[4] * normalizedY + affine[5];
  requireFinite(u, 'Mapped spatial U');
  requireFinite(v, 'Mapped spatial V');
  out[0] = u;
  out[1] = v;
  return out;
}

/** Binary available source coverage, inclusive IN and exclusive OUT, even for neutral mappings. */
export function spatialCoverage(mapping: SpatialMapping, u: number, v: number): 0 | 1 {
  requireFinite(u, 'Spatial source U');
  requireFinite(v, 'Spatial source V');
  return u >= mapping.cropLeft && u < 1 - mapping.cropRight && v >= mapping.cropTop && v < 1 - mapping.cropBottom
    ? 1
    : 0;
}
