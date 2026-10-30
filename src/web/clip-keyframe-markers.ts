import type { PlacedClip } from '../shared/timeline.js';

export interface ClipKeyframeMarker {
  type: 'speed' | 'grade';
  sourceFrame: number;
  outputFrame: number;
  timelineFrame: number;
  seekFrame: number;
}

/** Match inspector source preview without recompiling the placed map for every key. */
function markerSeekFrame(placed: PlacedClip, sourceFrame: number): number {
  const { clip } = placed;
  if (sourceFrame === clip.sourceIn) return clip.reverse ? placed.end - 1 : placed.start;
  if (sourceFrame === clip.sourceOut) return clip.reverse ? placed.start : placed.end - 1;
  return placed.start + nearestOutput(placed, sourceFrame);
}

/**
 * The output frame closest to a source frame's image. outputAt is where the continuous
 * position crosses it (forward: first frame showing it; reversed: last), kept on ties;
 * a neighbor on either side wins only when strictly closer.
 */
export function nearestOutput(placed: PlacedClip, sourceFrame: number): number {
  const inverse = placed.retiming.outputAt(sourceFrame);
  let best = inverse;
  let bestDistance = Math.abs(placed.retiming.sourceAt(inverse) - sourceFrame);
  for (const candidate of [inverse + 1, inverse - 1]) {
    if (candidate < 0 || candidate >= placed.duration) continue;
    const distance = Math.abs(placed.retiming.sourceAt(candidate) - sourceFrame);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Clip-owned speed keys only; retained off-trim anchors stay exclusively in the inspector.
 * A key sits on the output frame its click previews (the closest image of its source frame), so it lines
 * up with the playhead there; the floor inverse can be a frame earlier, still showing the previous image.
 * OUT alone denotes a boundary (the right one, the left one when reversed), while its preview must stay on
 * the nearest available output.
 * Work/storage is bounded by the 256-key list, never clip duration.
 */
export function clipKeyframeMarkers(placed: PlacedClip): ClipKeyframeMarker[] {
  const keys = placed.clip.speed.mode === 'curve' ? placed.clip.speed.keyframes : [];
  const boundary = placed.clip.reverse ? 0 : placed.duration;
  return keys
    .filter((point) => point.frame >= placed.clip.sourceIn && point.frame <= placed.clip.sourceOut)
    .map((point) => {
      const seekFrame = markerSeekFrame(placed, point.frame);
      const outputFrame = point.frame === placed.clip.sourceOut ? boundary : seekFrame - placed.start;
      return {
        type: 'speed',
        sourceFrame: point.frame,
        outputFrame,
        timelineFrame: placed.start + outputFrame,
        seekFrame,
      };
    });
}

/** Clip grade keys on the footage the clip shows; keys on trimmed-off footage stay in the Color tab only. */
export function gradeKeyframeMarkers(placed: PlacedClip): ClipKeyframeMarker[] {
  const { sourceIn, sourceOut } = placed.clip;
  return placed.clip.grade.keyframes
    .filter((point) => point.frame >= sourceIn && point.frame < sourceOut)
    .map((point) => {
      const outputFrame = nearestOutput(placed, point.frame);
      return {
        type: 'grade',
        sourceFrame: point.frame,
        outputFrame,
        timelineFrame: placed.start + outputFrame,
        seekFrame: placed.start + outputFrame,
      };
    });
}

export function clipMarkersOf(placed: PlacedClip, type: ClipKeyframeMarker['type']): ClipKeyframeMarker[] {
  return type === 'grade' ? gradeKeyframeMarkers(placed) : clipKeyframeMarkers(placed);
}
