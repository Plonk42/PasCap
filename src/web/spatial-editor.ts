import type { ProjectDocument } from '../shared/model.js';
import {
  evaluateSpatial,
  spatialSettingsSchema,
  type SpatialKeyframe,
  type SpatialPose,
  type SpatialSettings,
} from '../shared/spatial.js';
import { calculateLayout } from '../shared/timeline.js';

export const SPATIAL_CONTROLS: readonly {
  key: keyof SpatialPose;
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

/** Keep inline errors readable without losing strict full-pose validation. */
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

export function captureSpatialKey(settings: SpatialSettings, frame: number, position: number): SpatialSettings {
  if (settings.keyframes.some((key) => key.frame === frame))
    throw new Error('A Transform key already exists at this source frame.');
  return validatedSpatial({
    base: settings.base,
    keyframes: [
      ...settings.keyframes,
      { frame, interpolation: 'linear', values: evaluateSpatial(settings, position) },
    ].sort((a, b) => a.frame - b.frame),
  });
}

export function replaceSpatialKey(
  settings: SpatialSettings,
  frame: number,
  changes: Partial<SpatialKeyframe>,
): SpatialSettings {
  if (!settings.keyframes.some((key) => key.frame === frame)) throw new Error('This Transform key no longer exists.');
  if (
    changes.frame !== undefined &&
    settings.keyframes.some((key) => key.frame !== frame && key.frame === changes.frame)
  )
    throw new Error('A Transform key already exists at this source frame. Choose another frame.');
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

/** Single full-pose replacement; value edits never create animation. */
export function editSpatialPose(
  settings: SpatialSettings,
  frame: number | null,
  key: keyof SpatialPose,
  value: number,
): SpatialSettings {
  if (!settings.keyframes.length) return validatedSpatial({ ...settings, base: { ...settings.base, [key]: value } });
  const point = settings.keyframes.find((item) => item.frame === frame);
  if (!point) throw new Error('Animated · add a Transform keyframe at the displayed source frame to edit.');
  return replaceSpatialKey(settings, point.frame, { values: { ...point.values, [key]: value } });
}
