import { createColourSettings, type ColourSettings, type RGB } from './colour.js';
import { adjustmentAt, adjustmentColourAt, gradeChainPixel, sourceGrades } from './grade.js';
import type { ProjectDocument, VideoLayer } from './model.js';
import { evaluateSpatial } from './spatial.js';
import type { PreviewLayer } from './timeline.js';

/** The Colour every video track gets at a project frame: its adjustment's, or neutral without one. */
export function adjustmentColour(project: Pick<ProjectDocument, 'adjustments'>, projectFrame: number): ColourSettings {
  const item = adjustmentAt(project.adjustments, projectFrame);
  return item ? adjustmentColourAt(item, projectFrame) : createColourSettings();
}

/** The track's Opacity at a project frame, from its Transform. */
export function opacityAt(layer: VideoLayer, projectFrame: number): number {
  return evaluateSpatial(layer.transform, projectFrame).opacity;
}

/** Encoded BT.709, each source graded by its clip then the adjustment, premultiplied within a dissolve, source-over across layers. */
export function compositePixel(layers: readonly PreviewLayer[], sampleSource: (layer: PreviewLayer) => RGB): RGB {
  const result: [number, number, number] = [0, 0, 0];
  const ids = [...new Set(layers.map((layer) => layer.layerId))];
  for (const id of ids) {
    const group = layers.filter((layer) => layer.layerId === id);
    const colour: [number, number, number] = [0, 0, 0];
    let alpha = 0;
    for (const layer of group) {
      const graded = gradeChainPixel(sampleSource(layer), sourceGrades(layer.grade, layer.colour).stages);
      const coverage = layer.opacity * layer.blendWeight;
      alpha += coverage;
      for (let channel = 0; channel < 3; channel++) colour[channel]! += graded[channel]! * coverage * layer.brightness;
    }
    for (let channel = 0; channel < 3; channel++) result[channel] = colour[channel]! + result[channel]! * (1 - alpha);
  }
  return result;
}
