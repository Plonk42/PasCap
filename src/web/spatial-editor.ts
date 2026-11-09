import type { EditCommand } from '../shared/commands.js';
import type { Interpolation } from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';
import {
  evaluateSpatial,
  hasSpatialChannelKeys,
  NEUTRAL_SPATIAL_POSE,
  SPATIAL_CHANNELS,
  type SpatialChannel,
} from '../shared/spatial.js';

export const SPATIAL_CONTROLS: readonly {
  key: SpatialChannel;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Shown multiplied by this, in `unit`: Opacity reads 0–100%, stored 0–1. */
  display?: { scale: number; unit: string };
}[] = [
  { key: 'cropLeft', label: 'Crop left', min: 0, max: 1, step: 0.001 },
  { key: 'cropRight', label: 'Crop right', min: 0, max: 1, step: 0.001 },
  { key: 'cropTop', label: 'Crop top', min: 0, max: 1, step: 0.001 },
  { key: 'cropBottom', label: 'Crop bottom', min: 0, max: 1, step: 0.001 },
  { key: 'scale', label: 'Scale', min: 0.1, max: 8, step: 0.001 },
  { key: 'translateX', label: 'Translate X', min: -2, max: 2, step: 0.001 },
  { key: 'translateY', label: 'Translate Y', min: -2, max: 2, step: 0.001 },
  { key: 'rotation', label: 'Rotation', min: -180, max: 180, step: 0.1 },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, display: { scale: 100, unit: '%' } },
];

/** The Transform keyframe edits of the Track → Transform controls and markers, as the shared keyframe commands. */
const keyCommand = (layer: VideoLayer, frame: number) => ({ type: 'layer-key-set' as const, layerId: layer.id, frame });

function existingKey(layer: VideoLayer, frame: number) {
  const key = layer.transform.keyframes.find((item) => item.frame === frame);
  if (!key) throw new Error('This Transform keyframe no longer exists.');
  return key;
}

/**
 * One channel joins or leaves the key at a timeline frame, capturing its evaluated
 * value there. Other channels at that key and the saved base stay unchanged.
 */
export function toggleSpatialChannel(layer: VideoLayer, channel: SpatialChannel, frame: number): EditCommand {
  const key = layer.transform.keyframes.find((item) => item.frame === frame);
  const value = key?.values[channel] != null ? null : evaluateSpatial(layer.transform, frame)[channel];
  return { ...keyCommand(layer, frame), values: { [channel]: value } };
}

/** Adds a default keyframe, or removes the one already at this frame; never replaces another keyframe. */
export function toggleDefaultSpatialKey(layer: VideoLayer, frame: number): EditCommand {
  const key = layer.transform.keyframes.find((item) => item.frame === frame);
  if (key && !key.reset)
    throw new Error('A Transform keyframe already exists at this frame. Choose another frame for a default keyframe.');
  return key ? removeSpatialKey(layer, frame) : { ...keyCommand(layer, frame), reset: true };
}

/**
 * Like Color Reset: once animated, only the settings enabled at this frame's keyframe
 * return to neutral; otherwise the whole base does. Null when nothing would change.
 */
export function resetSpatial(layer: VideoLayer, frame: number): EditCommand | null {
  const { base, keyframes } = layer.transform;
  if (!keyframes.length) {
    const changed = SPATIAL_CHANNELS.filter((channel) => base[channel] !== NEUTRAL_SPATIAL_POSE[channel]);
    if (!changed.length) return null;
    return { type: 'transform-patch', layerId: layer.id, settings: Object.fromEntries(changed.map((c) => [c, null])) };
  }
  const key = keyframes.find((item) => item.frame === frame);
  const changed = SPATIAL_CHANNELS.filter(
    (channel) => key?.values[channel] != null && key.values[channel] !== NEUTRAL_SPATIAL_POSE[channel],
  );
  if (!changed.length) return null;
  return {
    ...keyCommand(layer, frame),
    values: Object.fromEntries(changed.map((channel) => [channel, NEUTRAL_SPATIAL_POSE[channel]])),
  };
}

/**
 * The commands showing one setting neutral at every frame, its keyframes of that setting disabled (dropping keyframes
 * left without settings), for a hold-to-compare preview; null when it is neutral already.
 */
export function withoutSpatialChannel(layer: VideoLayer, channel: SpatialChannel): EditCommand[] | null {
  const { base, keyframes } = layer.transform;
  if (!hasSpatialChannelKeys(layer.transform, channel) && base[channel] === NEUTRAL_SPATIAL_POSE[channel]) return null;
  return [
    ...keyframes
      .filter((key) => key.values[channel] !== null)
      .map((key): EditCommand => ({ ...keyCommand(layer, key.frame), values: { [channel]: null } })),
    ...(base[channel] === NEUTRAL_SPATIAL_POSE[channel]
      ? []
      : [{ type: 'transform-patch' as const, layerId: layer.id, settings: { [channel]: null } }]),
  ];
}

/** Sets one enabled setting's Easing at a key, or every enabled setting's when `channel` is null. */
export function setSpatialEasing(
  layer: VideoLayer,
  frame: number,
  channel: SpatialChannel | null,
  curve: Interpolation,
): EditCommand {
  existingKey(layer, frame);
  return { ...keyCommand(layer, frame), easing: channel === null ? curve : { [channel]: curve } };
}

/** Changes one enabled setting's value at a stored keyframe. */
export function setSpatialKeyValue(
  layer: VideoLayer,
  frame: number,
  channel: SpatialChannel,
  value: number,
): EditCommand {
  existingKey(layer, frame);
  return { ...keyCommand(layer, frame), values: { [channel]: value } };
}

export function moveSpatialKey(layer: VideoLayer, frame: number, nextFrame: number): EditCommand {
  existingKey(layer, frame);
  if (layer.transform.keyframes.some((key) => key.frame !== frame && key.frame === nextFrame))
    throw new Error('A Transform keyframe already exists at this timeline frame. Choose another frame.');
  return { type: 'layer-key-move', layerId: layer.id, frame, nextFrame };
}

export function removeSpatialKey(layer: VideoLayer, frame: number): EditCommand {
  return { type: 'layer-key-remove', layerId: layer.id, frame };
}

/** Edits the base for an unkeyed channel; a keyed channel needs its own key at this frame. */
export function editSpatialPose(
  layer: VideoLayer,
  frame: number | null,
  channel: SpatialChannel,
  value: number,
): EditCommand {
  if (!hasSpatialChannelKeys(layer.transform, channel))
    return { type: 'transform-patch', layerId: layer.id, settings: { [channel]: value } };
  const point = layer.transform.keyframes.find((item) => item.frame === frame && item.values[channel] !== null);
  if (!point) throw new Error('Animated · add a keyframe for this setting at the playhead to edit.');
  return { ...keyCommand(layer, point.frame), values: { [channel]: value } };
}
