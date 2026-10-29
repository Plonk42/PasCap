import {
  COLOUR_CONTROLS,
  createColourSettings,
  isNeutralColour,
  NEUTRAL_COLOUR,
  type ScalarColourSetting,
} from '../shared/colour.js';
import type { EditCommand } from '../shared/commands.js';
import { hasLayerKeys, isKeyframeFrame } from '../shared/keyframes.js';
import { colourTarget, ownerTarget, type ColourOwner } from './colour-owner.js';

/** Visible grouping of the Colour section; storage and keyframe channel order stay unchanged. */
export const COLOUR_GROUPS: readonly { name: string; settings: readonly ScalarColourSetting[] }[] = [
  { name: 'Colour', settings: ['temperature', 'tint', 'hue', 'saturation', 'vibrance'] },
  { name: 'Light', settings: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { name: 'Effects', settings: ['hdr', 'localContrast'] },
];

/**
 * Reset each editable setting of a group, as its own Reset icon would, in one transaction: an unkeyed
 * setting's base value, or a keyed setting's keyframe at the playhead. Locked settings stay unchanged.
 */
export function colourGroupResetCommands(
  layer: ColourOwner,
  frame: number,
  settings: readonly ScalarColourSetting[],
): EditCommand[] {
  if (!isKeyframeFrame(frame)) return [];
  const point = layer.keyframes.find((key) => key.frame === frame);
  const commands: EditCommand[] = [];
  const colour: Partial<Record<ScalarColourSetting, number>> = {};
  for (const setting of settings) {
    const neutral = NEUTRAL_COLOUR[setting];
    if (hasLayerKeys(layer, setting)) {
      const value = point?.values[setting];
      if (value !== undefined && value !== null && value !== neutral)
        commands.push({ type: 'layer-key-value', ...ownerTarget(layer), frame, setting, value: neutral });
    } else if (layer.colour[setting] !== neutral) colour[setting] = neutral;
  }
  if (Object.keys(colour).length > 0)
    commands.unshift({ type: 'colour', ...colourTarget(layer), colour: { ...layer.colour, ...colour } });
  return commands;
}

function resetPointCommands(layer: ColourOwner, frame: number): EditCommand[] {
  const point = layer.keyframes.find((key) => key.frame === frame);
  if (!point) return [];
  const values: Partial<Record<ScalarColourSetting, number>> = {};
  for (const control of COLOUR_CONTROLS)
    if (point.values[control.key] !== null) values[control.key] = NEUTRAL_COLOUR[control.key];
  if (COLOUR_CONTROLS.every((control) => (values[control.key] ?? null) === point.values[control.key])) return [];
  return [
    {
      type: 'layer-key-set',
      ...ownerTarget(layer),
      frame: point.frame,
      values,
    },
  ];
}

/** Apply the complete reset as one editor transaction; never join an absent channel. */
export function colourResetCommands(layer: ColourOwner, frame: number): EditCommand[] {
  if (COLOUR_CONTROLS.some((control) => hasLayerKeys(layer, control.key))) return resetPointCommands(layer, frame);
  return isNeutralColour(layer.colour)
    ? []
    : [{ type: 'colour', ...colourTarget(layer), colour: createColourSettings() }];
}
