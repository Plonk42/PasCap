import { z } from 'zod';
import type { ScalarColourSetting } from './colour.js';
import { COLOUR_CONTROLS, colourSchema } from './colour.js';

export const interpolationSchema = z.enum(['hold', 'linear', 'ease-in', 'ease-out', 'smooth']);
export type Interpolation = z.infer<typeof interpolationSchema>;
export type KeyframeSetting = 'opacity' | 'speed' | ScalarColourSetting;

/** One ordered control catalogue for the nine independently participating row channels. */
export const KEYFRAME_SETTINGS = Object.freeze(
  (
    [
      { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
      { key: 'speed', label: 'Speed', min: 0.1, max: 8, step: 0.05 },
      ...COLOUR_CONTROLS.map(({ key, label, min, max, step }) => ({ key, label, min, max, step })),
    ] as const
  ).map((setting) => Object.freeze(setting)),
) satisfies readonly { key: KeyframeSetting; label: string; min: number; max: number; step: number }[];

const layerKeyValuesSchema = z
  .object({
    opacity: z.number().min(0).max(1).nullable(),
    speed: z.number().min(0.1).max(8).nullable(),
    exposure: colourSchema.shape.exposure.nullable(),
    brightness: colourSchema.shape.brightness.nullable(),
    contrast: colourSchema.shape.contrast.nullable(),
    hue: colourSchema.shape.hue.nullable(),
    saturation: colourSchema.shape.saturation.nullable(),
    highlights: colourSchema.shape.highlights.nullable(),
    shadows: colourSchema.shape.shadows.nullable(),
  })
  .strict();
export type LayerKeyValues = z.infer<typeof layerKeyValuesSchema>;
export const EMPTY_KEY_VALUES: Readonly<LayerKeyValues> = Object.freeze({
  opacity: null,
  speed: null,
  exposure: null,
  brightness: null,
  contrast: null,
  hue: null,
  saturation: null,
  highlights: null,
  shadows: null,
});

const frame = z.number().int().nonnegative().max(2_147_483_647);
export const layerKeyframeSchema = z
  .object({ frame, interpolation: interpolationSchema, values: layerKeyValuesSchema })
  .strict()
  .refine((key) => Object.values(key.values).some((value) => value !== null), {
    message: 'A shared layer point must have at least one participating setting.',
  });
export type LayerKeyframe = z.infer<typeof layerKeyframeSchema>;

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
export function keyInterval<T extends { frame: number; interpolation: Interpolation }>(
  keys: readonly T[],
  frame: number,
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
    progress: interpolatedProgress((frame - left.frame) / (right.frame - left.frame), left.interpolation),
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
  const interval = keyInterval(
    layer.keyframes.filter((key) => key.values[setting] !== null),
    projectFrame,
  );
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
