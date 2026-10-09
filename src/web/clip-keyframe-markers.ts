import type { VideoLayer } from '../shared/model.js';
import type { PlacedClip } from '../shared/timeline.js';

export interface ClipKeyframeMarker {
  type: 'transform' | 'speed';
  sourceFrame: number;
  outputFrame: number;
  timelineFrame: number;
  seekFrame: number;
  speedOverridden: boolean;
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

/** Clip-owned keys only; retained off-trim anchors stay exclusively in inspectors.
 * outputAt is a FLOOR inverse, not a continuous coordinate. OUT alone denotes
 * the right boundary, while its preview must stay on the final available output.
 * Work/storage is bounded by the two existing 256-key lists, never clip duration.
 */
export function clipKeyframeMarkers(placed: PlacedClip, layer: VideoLayer): ClipKeyframeMarker[] {
  const speedOverridden = layer.keyframes.some((point) => point.values.speed !== null);
  const markers = (type: ClipKeyframeMarker['type'], keys: readonly { frame: number }[]): ClipKeyframeMarker[] =>
    keys
      .filter((point) => point.frame >= placed.clip.sourceIn && point.frame <= placed.clip.sourceOut)
      .map((point) => {
        const outputFrame =
          point.frame === placed.clip.sourceOut ? placed.duration : placed.retiming.outputAt(point.frame);
        return {
          type,
          sourceFrame: point.frame,
          outputFrame,
          timelineFrame: placed.start + outputFrame,
          seekFrame: markerSeekFrame(placed, point.frame),
          speedOverridden: type === 'speed' && speedOverridden,
        };
      });
  return [
    ...markers('transform', placed.clip.spatial.keyframes),
    ...markers('speed', placed.clip.speed.mode === 'curve' ? placed.clip.speed.keyframes : []),
  ];
}
