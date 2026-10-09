import type { ProjectDocument } from '../shared/model.js';
import {
  evaluateSpatial,
  hasSpatialChannelKeys,
  spatialSettingsSchema,
  type SpatialChannel,
  type SpatialKeyframe,
  type SpatialKeyValues,
  type SpatialSettings,
} from '../shared/spatial.js';
import { calculateLayout } from '../shared/timeline.js';

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

/** Real displayed integer source identity and continuous appearance sampling stay distinct. */
export function spatialPlayhead(project: ProjectDocument, clipId: string, frame: number) {
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clipId);
  if (!placed || frame < placed.start || frame >= placed.end) return null;
  const local = frame - placed.start;
  return { frame: placed.retiming.sourceAt(local), position: placed.retiming.sourcePositionAt(local) };
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
 * One channel joins or leaves the key at a source frame, capturing its continuously
 * evaluated value. Other channels at that key and the saved base stay unchanged.
 */
export function toggleSpatialChannel(
  settings: SpatialSettings,
  channel: SpatialChannel,
  frame: number,
  position: number,
): SpatialSettings {
  const key = settings.keyframes.find((item) => item.frame === frame);
  if (key && key.values[channel] !== null) {
    const values = { ...key.values, [channel]: null };
    const empty = Object.values(values).every((value) => value === null);
    return validatedSpatial({
      base: settings.base,
      keyframes: empty
        ? settings.keyframes.filter((item) => item !== key)
        : settings.keyframes.map((item) => (item === key ? { ...item, values } : item)),
    });
  }
  const value = evaluateSpatial(settings, position)[channel];
  const keyframes = key
    ? settings.keyframes.map((item) =>
        item === key ? { ...item, values: { ...item.values, [channel]: value } } : item,
      )
    : [...settings.keyframes, { frame, interpolation: 'linear', values: { ...NO_VALUES, [channel]: value } }].sort(
        (a, b) => a.frame - b.frame,
      );
  return validatedSpatial({ base: settings.base, keyframes });
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
    throw new Error('A Transform keyframe already exists at this source frame. Choose another frame.');
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
  if (!point) throw new Error('Animated · add a keyframe for this setting at the displayed source frame to edit.');
  return replaceSpatialKey(settings, point.frame, { values: { ...point.values, [channel]: value } });
}
