import type { PlacedClip } from '../shared/timeline.js';

export interface ClipKeyframeMarker {
  type: 'speed';
  sourceFrame: number;
  outputFrame: number;
  timelineFrame: number;
  seekFrame: number;
}

/** Match inspector source preview without recompiling the placed map for every key. */
function markerSeekFrame(placed: PlacedClip, sourceFrame: number): number {
  if (sourceFrame === placed.clip.sourceIn) return placed.start;
  if (sourceFrame === placed.clip.sourceOut) return placed.end - 1;
  const before = placed.retiming.outputAt(sourceFrame);
  const after = Math.min(placed.duration - 1, before + 1);
  const beforeDistance = Math.abs(placed.retiming.sourceAt(before) - sourceFrame);
  const afterDistance = Math.abs(placed.retiming.sourceAt(after) - sourceFrame);
  return placed.start + (afterDistance < beforeDistance ? after : before);
}

/** Clip-owned speed keys only; retained off-trim anchors stay exclusively in the inspector.
 * outputAt is a FLOOR inverse, not a continuous coordinate. OUT alone denotes
 * the right boundary, while its preview must stay on the final available output.
 * Work/storage is bounded by the 256-key list, never clip duration.
 */
export function clipKeyframeMarkers(placed: PlacedClip): ClipKeyframeMarker[] {
  const keys = placed.clip.speed.mode === 'curve' ? placed.clip.speed.keyframes : [];
  return keys
    .filter((point) => point.frame >= placed.clip.sourceIn && point.frame <= placed.clip.sourceOut)
    .map((point) => {
      const outputFrame =
        point.frame === placed.clip.sourceOut ? placed.duration : placed.retiming.outputAt(point.frame);
      return {
        type: 'speed',
        sourceFrame: point.frame,
        outputFrame,
        timelineFrame: placed.start + outputFrame,
        seekFrame: markerSeekFrame(placed, point.frame),
      };
    });
}
