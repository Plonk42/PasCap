import { joiningEasing, uniformKeyframe, withEasing, type Interpolation } from '../shared/keyframes.js';
import {
  defaultSpatialKeyframe,
  evaluateSpatial,
  hasSpatialChannelKeys,
  NEUTRAL_SPATIAL_POSE,
  SPATIAL_CHANNELS,
  spatialSettingsSchema,
  type SpatialChannel,
  type SpatialKeyframe,
  type SpatialKeyValues,
  type SpatialSettings,
} from '../shared/spatial.js';

export const SPATIAL_CONTROLS: readonly {
  key: SpatialChannel;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: 'cropLeft', label: 'Crop left', min: 0, max: 1, step: 0.001 },
  { key: 'cropRight', label: 'Crop right', min: 0, max: 1, step: 0.001 },
  { key: 'cropTop', label: 'Crop top', min: 0, max: 1, step: 0.001 },
  { key: 'cropBottom', label: 'Crop bottom', min: 0, max: 1, step: 0.001 },
  { key: 'scale', label: 'Scale', min: 0.1, max: 8, step: 0.001 },
  { key: 'translateX', label: 'Translate X', min: -2, max: 2, step: 0.001 },
  { key: 'translateY', label: 'Translate Y', min: -2, max: 2, step: 0.001 },
  { key: 'rotation', label: 'Rotation', min: -180, max: 180, step: 0.1 },
];

/** Keep inline errors readable without losing strict validation. */
function validatedSpatial(value: unknown): SpatialSettings {
  const result = spatialSettingsSchema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0]!.message);
  return result.data;
}

const NO_VALUES: Readonly<SpatialKeyValues> = Object.freeze({
  cropLeft: null,
  cropRight: null,
  cropTop: null,
  cropBottom: null,
  scale: null,
  translateX: null,
  translateY: null,
  rotation: null,
});

/**
 * One channel joins or leaves the key at a timeline frame, capturing its evaluated
 * value there. Other channels at that key and the saved base stay unchanged.
 */
export function toggleSpatialChannel(
  settings: SpatialSettings,
  channel: SpatialChannel,
  frame: number,
): SpatialSettings {
  const key = settings.keyframes.find((item) => item.frame === frame);
  if (key && key.values[channel] !== null) {
    const values = { ...key.values, [channel]: null };
    const empty = Object.values(values).every((value) => value === null);
    return validatedSpatial({
      base: settings.base,
      keyframes: empty
        ? settings.keyframes.filter((item) => item !== key)
        : settings.keyframes.map((item) =>
            item === key ? { ...item, values, easing: { ...item.easing, [channel]: null } } : item,
          ),
    });
  }
  const value = evaluateSpatial(settings, frame)[channel];
  const keyframes = key
    ? settings.keyframes.map((item) =>
        item === key
          ? {
              ...item,
              values: { ...item.values, [channel]: value },
              easing: { ...item.easing, [channel]: joiningEasing(settings.keyframes, item, SPATIAL_CHANNELS) },
            }
          : item,
      )
    : [
        ...settings.keyframes,
        { ...uniformKeyframe(frame, { ...NO_VALUES, [channel]: value }, 'linear'), reset: false },
      ].sort((a, b) => a.frame - b.frame);
  return validatedSpatial({ base: settings.base, keyframes });
}

/** Adds a default keyframe, or removes the one already at this frame; never replaces another keyframe. */
export function toggleDefaultSpatialKey(settings: SpatialSettings, frame: number): SpatialSettings {
  const key = settings.keyframes.find((item) => item.frame === frame);
  if (key && !key.reset)
    throw new Error('A Transform keyframe already exists at this frame. Choose another frame for a default keyframe.');
  return validatedSpatial({
    base: settings.base,
    keyframes: key
      ? settings.keyframes.filter((item) => item !== key)
      : [...settings.keyframes, defaultSpatialKeyframe(frame)].sort((a, b) => a.frame - b.frame),
  });
}

/**
 * Like Colour Reset: once animated, only the settings enabled at this frame's keyframe
 * return to neutral; otherwise the whole base does. Null when nothing would change.
 */
export function resetSpatial(settings: SpatialSettings, frame: number): SpatialSettings | null {
  if (!settings.keyframes.length) {
    if (SPATIAL_CHANNELS.every((channel) => settings.base[channel] === NEUTRAL_SPATIAL_POSE[channel])) return null;
    return validatedSpatial({ base: { ...NEUTRAL_SPATIAL_POSE }, keyframes: [] });
  }
  const key = settings.keyframes.find((item) => item.frame === frame);
  if (!key) return null;
  const values = { ...key.values };
  for (const channel of SPATIAL_CHANNELS) if (values[channel] !== null) values[channel] = NEUTRAL_SPATIAL_POSE[channel];
  if (SPATIAL_CHANNELS.every((channel) => values[channel] === key.values[channel])) return null;
  return replaceSpatialKey(settings, frame, { values });
}

/** Sets one enabled setting's Easing at a key, or every enabled setting's when `channel` is null. */
export function setSpatialEasing(
  settings: SpatialSettings,
  frame: number,
  channel: SpatialChannel | null,
  curve: Interpolation,
): SpatialSettings {
  const key = settings.keyframes.find((item) => item.frame === frame);
  if (!key) throw new Error('This Transform keyframe no longer exists.');
  return replaceSpatialKey(settings, frame, { easing: withEasing(key, channel, curve) });
}

export function replaceSpatialKey(
  settings: SpatialSettings,
  frame: number,
  changes: Partial<SpatialKeyframe>,
): SpatialSettings {
  if (!settings.keyframes.some((key) => key.frame === frame))
    throw new Error('This Transform keyframe no longer exists.');
  if (
    changes.frame !== undefined &&
    settings.keyframes.some((key) => key.frame !== frame && key.frame === changes.frame)
  )
    throw new Error('A Transform keyframe already exists at this timeline frame. Choose another frame.');
  return validatedSpatial({
    base: settings.base,
    keyframes: settings.keyframes
      .map((key) => (key.frame === frame ? { ...key, ...changes } : key))
      .sort((a, b) => a.frame - b.frame),
  });
}

export function removeSpatialKey(settings: SpatialSettings, frame: number): SpatialSettings {
  return validatedSpatial({ base: settings.base, keyframes: settings.keyframes.filter((key) => key.frame !== frame) });
}

/** Edits the base for an unkeyed channel; a keyed channel needs its own key at this frame. */
export function editSpatialPose(
  settings: SpatialSettings,
  frame: number | null,
  channel: SpatialChannel,
  value: number,
): SpatialSettings {
  if (!hasSpatialChannelKeys(settings, channel))
    return validatedSpatial({ ...settings, base: { ...settings.base, [channel]: value } });
  const point = settings.keyframes.find((item) => item.frame === frame && item.values[channel] !== null);
  if (!point) throw new Error('Animated · add a keyframe for this setting at the playhead to edit.');
  return replaceSpatialKey(settings, point.frame, { values: { ...point.values, [channel]: value } });
}
