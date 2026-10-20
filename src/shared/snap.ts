import type { ProjectDocument } from './model.js';
import { musicClips } from './music-lanes.js';
import { calculateLayout } from './timeline.js';

export function snapPoints(project: ProjectDocument): number[] {
  const layout = calculateLayout(project);
  const points = layout.clips.flatMap((clip) => [clip.start, clip.end]);
  for (const clip of musicClips(project.music)) points.push(clip.start, clip.start + clip.duration);
  return [
    ...new Set([
      0,
      ...points,
      ...layout.transitions.flatMap((region) => [region.start, region.boundary, region.end]),
      ...project.bookmarks,
    ]),
  ].sort((a, b) => a - b);
}
export function snapFrame(frame: number, points: readonly number[], tolerance: number): number {
  let nearest = frame;
  let distance = tolerance + 1e-8;
  for (const point of points) {
    const delta = Math.abs(point - frame);
    if (delta < distance) {
      nearest = point;
      distance = delta;
    }
  }
  return nearest;
}
