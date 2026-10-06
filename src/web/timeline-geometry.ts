import type { TimelineLayout } from '../shared/timeline.js';

export function insertionIndex(layout: TimelineLayout, frame: number): number {
  const index = layout.clips.findIndex((placed) => frame < placed.start + placed.duration / 2);
  return index < 0 ? layout.clips.length : index;
}

export function reorderAt(clipIds: readonly string[], clipId: string, insertion: number): string[] {
  const oldIndex = clipIds.indexOf(clipId);
  if (oldIndex < 0) throw new Error('Dragged clip no longer exists.');
  const next = clipIds.filter((id) => id !== clipId);
  const destination = Math.max(0, Math.min(next.length, insertion > oldIndex ? insertion - 1 : insertion));
  next.splice(destination, 0, clipId);
  return next;
}
