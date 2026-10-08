import type { ColourSettings, RGB } from './colour.js';
import { gradePixel } from './colour.js';
import { evaluateLayerSetting } from './keyframes.js';
import type { VideoLayer } from './model.js';
import type { PreviewLayer } from './timeline.js';

export function colourAt(layer: VideoLayer, projectFrame: number): ColourSettings {
  const colour = { ...layer.colour };
  for (const setting of Object.keys(colour) as (keyof ColourSettings)[])
    colour[setting] = evaluateLayerSetting(layer, setting, projectFrame, layer.colour[setting]);
  return colour;
}
/** One evaluated source coverage for every clip in the row; visibility is separate. */
export function opacityAt(layer: VideoLayer, projectFrame: number): number {
  return evaluateLayerSetting(layer, 'opacity', projectFrame, layer.opacity);
}

/** Encoded BT.709, premultiplied within a dissolve, source-over across layers. */
export function compositePixel(layers: readonly PreviewLayer[], sampleSource: (layer: PreviewLayer) => RGB): RGB {
  const result: [number, number, number] = [0, 0, 0];
  const ids = [...new Set(layers.map((layer) => layer.layerId))];
  for (const id of ids) {
    const group = layers.filter((layer) => layer.layerId === id);
    const colour: [number, number, number] = [0, 0, 0];
    let alpha = 0;
    for (const layer of group) {
      const graded = gradePixel(sampleSource(layer), layer.colour);
      const coverage = layer.opacity * layer.blendWeight;
      alpha += coverage;
      for (let channel = 0; channel < 3; channel++) colour[channel]! += graded[channel]! * coverage * layer.brightness;
    }
    for (let channel = 0; channel < 3; channel++) result[channel] = colour[channel]! + result[channel]! * (1 - alpha);
  }
  return result;
}
