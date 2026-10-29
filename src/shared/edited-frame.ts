import type { ProjectDocument } from './model.js';
import { musicTracks } from './music-lanes.js';
import { calculateLayout, type PlacedTransition } from './timeline.js';

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Frames of keyframes added, changed or removed. */
function changedKeyframes(before: readonly { frame: number }[], after: readonly { frame: number }[]): number[] {
  const previous = new Map(before.map((key) => [key.frame, key]));
  const next = new Set(after.map((key) => key.frame));
  return [
    ...after.filter((key) => !same(previous.get(key.frame), key)).map((key) => key.frame),
    ...before.filter((key) => !next.has(key.frame)).map((key) => key.frame),
  ];
}

function changedBookmarks(before: readonly number[], after: readonly number[]): number[] {
  return [...after.filter((frame) => !before.includes(frame)), ...before.filter((frame) => !after.includes(frame))];
}

function changedClips(before: ProjectDocument, after: ProjectDocument): number[] {
  const previous = calculateLayout(before);
  const next = calculateLayout(after);
  const old = new Map(previous.clips.map((placed) => [placed.clip.id, placed]));
  const kept = new Set(next.clips.map((placed) => placed.clip.id));
  const frames = next.clips
    .filter((placed) => {
      const earlier = old.get(placed.clip.id);
      return earlier?.start !== placed.start || earlier.end !== placed.end || !same(earlier.clip, placed.clip);
    })
    .map((placed) => placed.start);
  frames.push(...previous.clips.filter((placed) => !kept.has(placed.clip.id)).map((placed) => placed.start));
  const key = (item: PlacedTransition) => `${item.layerId}:${item.transition.leftId}:${item.transition.rightId}`;
  const transitions = new Map(previous.transitions.map((item) => [key(item), item]));
  frames.push(
    ...next.transitions
      .filter((item) => !same(transitions.get(key(item))?.transition, item.transition))
      .map((item) => item.start),
  );
  for (const layer of after.layers) {
    const earlier = before.layers.find((item) => item.id === layer.id);
    const placed = next.clips.filter((item) => item.clip.layerId === layer.id);
    if (!earlier || !placed.length) continue;
    if (earlier.openingFade !== layer.openingFade) frames.push(placed[0]!.start);
    if (earlier.closingFade !== layer.closingFade)
      frames.push(placed.at(-1)!.end - Math.max(earlier.closingFade, layer.closingFade, 1));
  }
  return frames;
}

/** An added, removed, moved or resized adjustment from its start; a changed keyframe at its project frame. */
function changedAdjustments(before: ProjectDocument, after: ProjectDocument): number[] {
  const previous = new Map(before.adjustments.map((item) => [item.id, item]));
  const kept = new Set(after.adjustments.map((item) => item.id));
  const frames: number[] = [];
  for (const item of after.adjustments) {
    const earlier = previous.get(item.id);
    if (!earlier || earlier.start !== item.start || earlier.duration !== item.duration) frames.push(item.start);
    else
      frames.push(
        ...changedKeyframes(
          earlier.keyframes.map((key) => ({ ...key, frame: earlier.start + key.frame })),
          item.keyframes.map((key) => ({ ...key, frame: item.start + key.frame })),
        ),
      );
  }
  frames.push(...before.adjustments.filter((item) => !kept.has(item.id)).map((item) => item.start));
  return frames;
}

function changedMusic(before: ProjectDocument, after: ProjectDocument): number[] {
  const previous = new Map(musicTracks(before.music).map((source) => [source.id, source]));
  const next = musicTracks(after.music);
  const kept = new Set(next.map((source) => source.id));
  return [
    ...next.filter((source) => !same(previous.get(source.id), source)).map((source) => source.start),
    ...[...previous.values()].filter((source) => !kept.has(source.id)).map((source) => source.start),
  ];
}

/**
 * The earliest project frame where an edit changed what the timeline shows: clips and their placement,
 * transitions, fades, keyframes, adjustments, bookmarks or music. Null when it changed nothing at a particular frame,
 * such as a whole track's Transform, an adjustment's whole Colour, kept ranges or the title.
 */
export function editedFrame(before: ProjectDocument, after: ProjectDocument): number | null {
  const frames = [...changedClips(before, after), ...changedMusic(before, after)];
  frames.push(...changedBookmarks(before.bookmarks, after.bookmarks));
  for (const layer of after.layers) {
    const earlier = before.layers.find((item) => item.id === layer.id);
    frames.push(...changedKeyframes(earlier?.transform.keyframes ?? [], layer.transform.keyframes));
  }
  frames.push(...changedAdjustments(before, after));
  return frames.length ? Math.max(0, Math.min(...frames)) : null;
}
