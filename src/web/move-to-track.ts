import type { EditCommand } from '../shared/commands.js';
import { createLayer, MAX_VIDEO_LAYERS, type ProjectDocument } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';

export function nextLayerName(project: ProjectDocument): string {
  let number = 2;
  while (project.layers.some((layer) => layer.name === `Video track ${number}`)) number++;
  return `Video track ${number}`;
}

/** Colour belongs to the track, so a different look means a new track; the clip keeps its start and order. */
export function moveToNewTrack(
  project: ProjectDocument,
  clipId: string,
): { commands: EditCommand[] } | { reason: string } {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  const clip = project.clips[index];
  if (!clip) return { reason: 'Select a clip first.' };
  if (project.layers.length >= MAX_VIDEO_LAYERS)
    return { reason: `A project can have at most ${MAX_VIDEO_LAYERS} video tracks.` };
  if (project.clips.filter((item) => item.layerId === clip.layerId).length < 2)
    return { reason: 'This clip is already alone on its track.' };
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clipId)!;
  const layerId = crypto.randomUUID();
  return {
    commands: [
      { type: 'layer-add', layer: createLayer(layerId, nextLayerName(project)) },
      { type: 'place', clipId, layerId, start: placed.start, index },
    ],
  };
}
