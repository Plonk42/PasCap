import type { ColourSettings, RGB } from './colour.js';
import { gradePixel } from './colour.js';
import { evaluateLayerSetting } from './keyframes.js';
import type { VideoClip, VideoLayer } from './model.js';
import type { PreviewLayer } from './timeline.js';

export function colourAt(clip: VideoClip, layer: VideoLayer, projectFrame: number): ColourSettings {
  const colour = { ...clip.colour };
  for (const setting of Object.keys(colour) as (keyof ColourSettings)[])
    colour[setting] = evaluateLayerSetting(layer, setting, projectFrame, clip.colour[setting]);
  return colour;
}
export function opacityAt(clip: VideoClip, layer: VideoLayer, projectFrame: number): number {
  return evaluateLayerSetting(layer, 'clipOpacity', projectFrame, clip.opacity);
}
export function layerOpacityAt(layer: VideoLayer, projectFrame: number): number {
  return layer.enabled ? evaluateLayerSetting(layer, 'layerOpacity', projectFrame, layer.opacity) : 0;
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
    const opacity = group[0]!.layerOpacity;
    for (let channel = 0; channel < 3; channel++)
      result[channel] = colour[channel]! * opacity + result[channel]! * (1 - alpha * opacity);
  }
  return result;
}
