import {
  COLOR_CONTROLS,
  createColorSettings,
  isNeutralColor,
  NEUTRAL_COLOR,
  type ScalarColorSetting,
} from '../shared/color.js';
import type { EditCommand } from '../shared/commands.js';
import { hasLayerKeys, isKeyframeFrame } from '../shared/keyframes.js';
import { colorTarget, ownerTarget, type ColorOwner } from './color-owner.js';

/** Visible grouping of the Color section; storage and keyframe channel order stay unchanged. */
export const COLOR_GROUPS: readonly { name: string; settings: readonly ScalarColorSetting[] }[] = [
  { name: 'Color', settings: ['temperature', 'tint', 'hue', 'saturation', 'vibrance'] },
  { name: 'Light', settings: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { name: 'Effects', settings: ['hdr', 'localContrast'] },
];

/**
 * Reset each editable setting of a group, as its own Reset icon would, in one transaction: an unkeyed
 * setting's base value, or a keyed setting's keyframe at the playhead. Locked settings stay unchanged.
 */
export function colorGroupResetCommands(
  layer: ColorOwner,
  frame: number,
  settings: readonly ScalarColorSetting[],
): EditCommand[] {
  if (!isKeyframeFrame(frame)) return [];
  const point = layer.keyframes.find((key) => key.frame === frame);
  const commands: EditCommand[] = [];
  const color: Partial<Record<ScalarColorSetting, number>> = {};
  for (const setting of settings) {
    const neutral = NEUTRAL_COLOR[setting];
    if (hasLayerKeys(layer, setting)) {
      const value = point?.values[setting];
      if (value !== undefined && value !== null && value !== neutral)
        commands.push({ type: 'layer-key-value', ...ownerTarget(layer), frame, setting, value: neutral });
    } else if (layer.color[setting] !== neutral) color[setting] = neutral;
  }
  if (Object.keys(color).length > 0)
    commands.unshift({ type: 'color', ...colorTarget(layer), color: { ...layer.color, ...color } });
  return commands;
}

function resetPointCommands(layer: ColorOwner, frame: number): EditCommand[] {
  const point = layer.keyframes.find((key) => key.frame === frame);
  if (!point) return [];
  const values: Partial<Record<ScalarColorSetting, number>> = {};
  for (const control of COLOR_CONTROLS)
    if (point.values[control.key] !== null) values[control.key] = NEUTRAL_COLOR[control.key];
  if (COLOR_CONTROLS.every((control) => (values[control.key] ?? null) === point.values[control.key])) return [];
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
export function colorResetCommands(layer: ColorOwner, frame: number): EditCommand[] {
  if (COLOR_CONTROLS.some((control) => hasLayerKeys(layer, control.key))) return resetPointCommands(layer, frame);
  return isNeutralColor(layer.color) ? [] : [{ type: 'color', ...colorTarget(layer), color: createColorSettings() }];
}
