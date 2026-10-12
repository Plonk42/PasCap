import { z } from 'zod';
import type { ScalarColourSetting } from './colour.js';
import { COLOUR_CONTROLS, colourSchema, NEUTRAL_COLOUR } from './colour.js';

export const interpolationSchema = z.enum(['hold', 'linear', 'ease-in', 'ease-out', 'smooth']);
export type Interpolation = z.infer<typeof interpolationSchema>;
export type KeyframeSetting = 'opacity' | ScalarColourSetting;

/** One ordered control catalogue for the eleven independently participating track channels. */
export const KEYFRAME_SETTINGS = Object.freeze(
  (
    [
      { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
      ...COLOUR_CONTROLS.map(({ key, label, min, max, step }) => ({ key, label, min, max, step })),
    ] as const
  ).map((setting) => Object.freeze(setting)),
) satisfies readonly { key: KeyframeSetting; label: string; min: number; max: number; step: number }[];

const layerKeyValuesSchema = z
  .object({
    opacity: z.number().min(0).max(1).nullable(),
    temperature: colourSchema.shape.temperature.nullable(),
    tint: colourSchema.shape.tint.nullable(),
    exposure: colourSchema.shape.exposure.nullable(),
    brightness: colourSchema.shape.brightness.nullable(),
    contrast: colourSchema.shape.contrast.nullable(),
    hue: colourSchema.shape.hue.nullable(),
    saturation: colourSchema.shape.saturation.nullable(),
    highlights: colourSchema.shape.highlights.nullable(),
    shadows: colourSchema.shape.shadows.nullable(),
    hdr: colourSchema.shape.hdr.nullable(),
  })
  .strict();
export type LayerKeyValues = z.infer<typeof layerKeyValuesSchema>;
export const EMPTY_KEY_VALUES: Readonly<LayerKeyValues> = Object.freeze({
  opacity: null,
  temperature: null,
  tint: null,
  exposure: null,
  brightness: null,
  contrast: null,
  hue: null,
  saturation: null,
  highlights: null,
  shadows: null,
  hdr: null,
});

/** One nullable Easing per setting, in the same strict shape as that keyframe's values. */
export function easingSchema<K extends string>(settings: readonly K[]) {
  return z
    .object(
      Object.fromEntries(settings.map((key) => [key, interpolationSchema.nullable()])) as Record<
        K,
        z.ZodNullable<typeof interpolationSchema>
      >,
    )
    .strict();
}
type KeyEasing<V> = { [K in keyof V]: Interpolation | null };
type ChannelValues = Readonly<Record<string, number | null>>;
type EasedKey<V extends ChannelValues = ChannelValues> = { frame: number; values: V; easing: KeyEasing<V> };

/** True when exactly the enabled settings carry an Easing. */
export function easingMatchesValues(key: { values: ChannelValues; easing: Readonly<Record<string, unknown>> }) {
  return Object.keys(key.values).every((setting) => (key.values[setting] === null) === (key.easing[setting] === null));
}
export const EASING_MISMATCH = 'Each enabled setting needs its own Easing, and a disabled setting has none.';

const frame = z.number().int().nonnegative().max(2_147_483_647);
export const layerKeyframeSchema = z
  .object({
    frame,
    values: layerKeyValuesSchema,
    easing: easingSchema(Object.keys(EMPTY_KEY_VALUES) as KeyframeSetting[]),
    /** A default keyframe never extends its values to frames before it. */
    reset: z.boolean(),
  })
  .strict()
  .refine((key) => Object.values(key.values).some((value) => value !== null), {
    message: 'A shared track keyframe must have at least one enabled setting.',
  })
  .refine(easingMatchesValues, { message: EASING_MISMATCH });
export type LayerKeyframe = z.infer<typeof layerKeyframeSchema>;

/** A keyframe whose enabled settings all use one Easing. */
export function uniformKeyframe<V extends ChannelValues>(frame: number, values: V, curve: Interpolation): EasedKey<V> {
  const easing = Object.fromEntries(
    Object.entries(values).map(([setting, value]) => [setting, value === null ? null : curve]),
  ) as KeyEasing<V>;
  return { frame, values, easing };
}

/** An ordinary track keyframe whose enabled settings all use one Easing. */
export function layerKeyframe(frame: number, values: LayerKeyValues, curve: Interpolation): LayerKeyframe {
  return { ...uniformKeyframe(frame, values, curve), reset: false };
}

/** Every setting at its neutral creation value, holding until its next keyframe. */
export function defaultKeyframe(frame: number): LayerKeyframe {
  const values = {
    ...EMPTY_KEY_VALUES,
    opacity: 1,
    ...Object.fromEntries(COLOUR_CONTROLS.map(({ key }) => [key, NEUTRAL_COLOUR[key]])),
  };
  return { ...uniformKeyframe(frame, values, 'hold'), reset: true };
}

/** Enabled settings of `key` that are keyed again later: only their Easing has an effect. */
export function continuingSettings<K extends string>(
  keys: readonly { frame: number; values: Readonly<Record<K, number | null>> }[],
  key: { frame: number; values: Readonly<Record<K, number | null>> },
  order: readonly K[],
): K[] {
  return order.filter(
    (setting) =>
      key.values[setting] !== null && keys.some((other) => other.frame > key.frame && other.values[setting] !== null),
  );
}

/** The Easing every listed setting shares, or null when they differ or none is listed. */
export function agreedEasing<K extends string>(
  easing: Readonly<Record<K, Interpolation | null>>,
  settings: readonly K[],
): Interpolation | null {
  const curves = new Set(settings.map((setting) => easing[setting]));
  const [only] = curves;
  return curves.size === 1 && only ? only : null;
}

/** A setting joining `key` adopts the Easing its settings agree on, otherwise Linear. */
export function joiningEasing<K extends string>(
  keys: readonly { frame: number; values: Readonly<Record<K, number | null>> }[],
  key: { frame: number; values: Readonly<Record<K, number | null>>; easing: Readonly<Record<K, Interpolation | null>> },
  order: readonly K[],
): Interpolation {
  const continuing = continuingSettings(keys, key, order);
  const enabled = order.filter((setting) => key.values[setting] !== null);
  return agreedEasing(key.easing, continuing.length ? continuing : enabled) ?? 'linear';
}

/** Sets one enabled setting's Easing, or every enabled setting's when `setting` is null. */
export function withEasing<K extends string>(
  key: { values: Readonly<Record<K, number | null>>; easing: Readonly<Record<K, Interpolation | null>> },
  setting: K | null,
  curve: Interpolation,
): Record<K, Interpolation | null> {
  interpolationSchema.parse(curve);
  if (setting !== null && key.values[setting] === null) throw new Error('The setting is not enabled at this keyframe.');
  const easing: Record<K, Interpolation | null> = { ...key.easing };
  for (const name of Object.keys(easing) as K[])
    if (key.values[name] !== null && (setting === null || name === setting)) easing[name] = curve;
  return easing;
}

export function isKeyframeFrame(frame: number): boolean {
  return Number.isSafeInteger(frame) && frame >= 0 && frame <= 2_147_483_647;
}

/** Strict neighbours in an already ordered row; zero is a participating value. */
export function keyframeNeighbors(
  keys: readonly LayerKeyframe[],
  frame: number,
  setting?: KeyframeSetting,
): { previous: LayerKeyframe | null; next: LayerKeyframe | null } {
  let previous: LayerKeyframe | null = null;
  if (!isKeyframeFrame(frame)) return { previous, next: null };
  for (const key of keys) {
    if (!isKeyframeFrame(key.frame) || (setting !== undefined && key.values[setting] === null)) continue;
    if (key.frame < frame) previous = key;
    else if (key.frame > frame) return { previous, next: key };
  }
  return { previous, next: null };
}

export function orderedKeys(keys: readonly { frame: number }[]): boolean {
  return keys.every((key, index) => index === 0 || key.frame > keys[index - 1]!.frame);
}
export function interpolatedProgress(progress: number, curve: Interpolation): number {
  const u = Math.max(0, Math.min(1, progress));
  switch (curve) {
    case 'hold':
      return 0;
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
export function keyInterval<T extends { frame: number }>(
  keys: readonly T[],
  frame: number,
  curve: (left: T) => Interpolation,
): { left: T; right: T; progress: number } | null {
  if (!keys.length) return null;
  if (frame <= keys[0]!.frame) return { left: keys[0]!, right: keys[0]!, progress: 0 };
  const index = keys.findIndex((key) => key.frame > frame);
  if (index < 0) return { left: keys.at(-1)!, right: keys.at(-1)!, progress: 0 };
  const left = keys[index - 1]!;
  const right = keys[index]!;
  return {
    left,
    right,
    progress: interpolatedProgress((frame - left.frame) / (right.frame - left.frame), curve(left)),
  };
}

export function hasLayerKeys(layer: { keyframes: readonly LayerKeyframe[] }, setting: KeyframeSetting): boolean {
  return layer.keyframes.some((key) => key.values[setting] !== null);
}
export function keySettings(key: LayerKeyframe): KeyframeSetting[] {
  return KEYFRAME_SETTINGS.filter((setting) => key.values[setting.key] !== null).map((setting) => setting.key);
}
export function evaluateLayerSetting(
  layer: { keyframes: readonly LayerKeyframe[] },
  setting: KeyframeSetting,
  projectFrame: number,
  base: number,
): number {
  const keys = layer.keyframes.filter((key) => key.values[setting] !== null);
  // Before a leading default keyframe the setting keeps its unkeyed value.
  if (keys[0]?.reset && projectFrame < keys[0].frame) return base;
  const interval = keyInterval(keys, projectFrame, (left) => left.easing[setting]!);
  if (!interval) return base;
  const left = interval.left.values[setting]!;
  return left + (interval.right.values[setting]! - left) * interval.progress;
}
export function activeLayerSetting(
  layer: { keyframes: readonly LayerKeyframe[] },
  setting: KeyframeSetting,
  frame: number,
): boolean {
  return layer.keyframes.some((key) => key.frame === frame && key.values[setting] !== null);
}
export function upsertKey<T extends { frame: number }>(keys: readonly T[], key: T): T[] {
  return [...keys.filter((item) => item.frame !== key.frame), key].sort((left, right) => left.frame - right.frame);
}
