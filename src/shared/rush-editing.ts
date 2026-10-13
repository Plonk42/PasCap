import type { EditCommand } from './commands.js';
import type { ProjectDocument } from './model.js';
import { trimOnTimeline } from './source-range.js';
import { calculateLayout, type PlacedClip } from './timeline.js';

/** Transient project-frame range selected on the time ruler; OUT is exclusive. */
export interface TimelineRange {
  inFrame: number;
  outFrame: number;
}

function selectedClip(project: ProjectDocument, clipId: string): PlacedClip {
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clipId);
  if (!placed) throw new Error('The selected clip no longer exists.');
  return placed;
}

/** The part of the range overlapping the selected clip is removed; its OUT is an
 * exclusive project endpoint, not an inclusive source-frame index.
 */
export function sourceRangeForCut(
  project: ProjectDocument,
  clipId: string,
  range: TimelineRange,
): { sourceIn: number; sourceOut: number } {
  const placed = selectedClip(project, clipId);
  if (!Number.isSafeInteger(range.inFrame) || !Number.isSafeInteger(range.outFrame))
    throw new Error('The selected range must use integer project frames.');
  if (range.outFrame <= range.inFrame) throw new Error('The selected range must end after it starts.');
  const inFrame = Math.max(range.inFrame, placed.start);
  const outFrame = Math.min(range.outFrame, placed.end);
  if (outFrame <= inFrame) throw new Error('The selected range is outside the selected clip.');
  const sourceIn = placed.retiming.sourceAt(inFrame - placed.start);
  const sourceOut = outFrame === placed.end ? placed.clip.sourceOut : placed.retiming.sourceAt(outFrame - placed.start);
  if (sourceOut <= sourceIn)
    throw new Error('The selected range contains no original source frame at this speed. Widen it.');
  return { sourceIn, sourceOut };
}

export function removeSelectedRange(
  project: ProjectDocument,
  clipId: string,
  range: TimelineRange,
  newClipId: string,
): EditCommand {
  return { type: 'remove-source-range', clipId, ...sourceRangeForCut(project, clipId, range), newClipId };
}

/** Keep the displayed original frame: BEFORE retains it as IN; AFTER retains
 * it via source-frame + 1 as exclusive OUT. The playhead must be inside [start,
 * end); it is never clamped from another clip or from the exclusive end.
 */
export function trimAtPlayhead(
  project: ProjectDocument,
  clipId: string,
  frame: number,
  edge: 'in' | 'out',
): EditCommand {
  const placed = selectedClip(project, clipId);
  if (edge !== 'in' && edge !== 'out') throw new Error('Quick trim edge must be IN or OUT.');
  if (!Number.isSafeInteger(frame)) throw new Error('Quick trim needs an integer project frame.');
  if (frame < placed.start || frame >= placed.end)
    throw new Error('Place the playhead inside the selected clip to trim it; its OUT boundary is exclusive.');
  const sourceFrame = placed.retiming.sourceAt(frame - placed.start);
  const delta = edge === 'in' ? sourceFrame - placed.clip.sourceIn : sourceFrame + 1 - placed.clip.sourceOut;
  // Repeated endpoint samples yield delta 0 and history discards the no-op.
  // sourceOut is only a shrinking ceiling here, not a claimed asset frame count.
  return trimOnTimeline(project, clipId, edge, delta, placed.clip.sourceOut, 'source');
}
