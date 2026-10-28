import { ownerTarget, colourTarget } from './colour-owner.js';
import {
  COLOUR_CONTROLS,
  createColourSettings,
  isNeutralColour,
  NEUTRAL_COLOUR,
  type ScalarColourSetting,
} from '../shared/colour.js';
import type { EditCommand } from '../shared/commands.js';
import { hasLayerKeys, isKeyframeFrame, type KeyframeSetting } from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';

/** Visible grouping of the Colour section; storage and keyframe channel order stay unchanged. */
export const COLOUR_GROUPS: readonly { name: string; settings: readonly KeyframeSetting[] }[] = [
  { name: 'Opacity', settings: ['opacity'] },
  { name: 'Colour', settings: ['temperature', 'tint', 'hue', 'saturation', 'vibrance'] },
  { name: 'Light', settings: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { name: 'Effects', settings: ['hdr', 'localContrast'] },
];

const neutralValue = (setting: KeyframeSetting): number => (setting === 'opacity' ? 1 : NEUTRAL_COLOUR[setting]);

/**
 * Reset each editable setting of a group, as its own Reset icon would, in one transaction: an unkeyed
 * setting's track value, or a keyed setting's keyframe at the playhead. Locked settings stay unchanged.
 */
export function colourGroupResetCommands(
  layer: VideoLayer,
  frame: number,
  settings: readonly KeyframeSetting[],
): EditCommand[] {
  if (!isKeyframeFrame(frame)) return [];
  const point = layer.keyframes.find((key) => key.frame === frame);
  const commands: EditCommand[] = [];
  const colour: Partial<Record<ScalarColourSetting, number>> = {};
  for (const setting of settings) {
    const neutral = neutralValue(setting);
    if (hasLayerKeys(layer, setting)) {
      const value = point?.values[setting];
      if (value !== undefined && value !== null && value !== neutral)
        commands.push({ type: 'layer-key-value', ...ownerTarget(layer), frame, setting, value: neutral });
    } else if (setting === 'opacity') {
      if (layer.opacity !== neutral) commands.push({ type: 'opacity', layerId: layer.id, opacity: neutral });
    } else if (layer.colour[setting] !== neutral) colour[setting] = neutral;
  }
  if (Object.keys(colour).length > 0)
    commands.unshift({ type: 'colour', ...colourTarget(layer), colour: { ...layer.colour, ...colour } });
  return commands;
}

function resetPointCommands(layer: VideoLayer, frame: number): EditCommand[] {
  const point = layer.keyframes.find((key) => key.frame === frame);
  if (!point) return [];
  const values = { ...point.values };
  if (values.opacity !== null) values.opacity = 1;
  for (const control of COLOUR_CONTROLS)
    if (values[control.key] !== null) values[control.key] = NEUTRAL_COLOUR[control.key];
  if (
    values.opacity === point.values.opacity &&
    COLOUR_CONTROLS.every((control) => values[control.key] === point.values[control.key])
  )
    return [];
  return [
    {
      type: 'layer-key-set',
      ...ownerTarget(layer),
      frame: point.frame,
      values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
    },
  ];
}

/** Apply the complete reset as one editor transaction; never join an absent channel. */
export function colourResetCommands(layer: VideoLayer, frame: number): EditCommand[] {
  const animated =
    hasLayerKeys(layer, 'opacity') || COLOUR_CONTROLS.some((control) => hasLayerKeys(layer, control.key));
  if (animated) return resetPointCommands(layer, frame);
  const commands: EditCommand[] = [];
  if (!isNeutralColour(layer.colour))
    commands.push({ type: 'colour', ...colourTarget(layer), colour: createColourSettings() });
  if (layer.opacity !== 1) commands.push({ type: 'opacity', layerId: layer.id, opacity: 1 });
  return commands;
}
