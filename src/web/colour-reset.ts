import { COLOUR_CONTROLS, createColourSettings, isNeutralColour, NEUTRAL_COLOUR } from '../shared/colour.js';
import type { EditCommand } from '../shared/commands.js';
import { hasLayerKeys } from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';

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
      type: 'layer-update',
      layer: {
        ...layer,
        keyframes: layer.keyframes.map((key) => (key.frame === point.frame ? { ...key, values } : key)),
      },
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
    commands.push({ type: 'colour', layerId: layer.id, colour: createColourSettings() });
  if (layer.opacity !== 1) commands.push({ type: 'opacity', layerId: layer.id, opacity: 1 });
  return commands;
}
