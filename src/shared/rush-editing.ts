import type { EditCommand } from './commands.js';
import type { ProjectDocument } from './model.js';
import { trimOnTimeline } from './source-range.js';
import { calculateLayout, type PlacedClip } from './timeline.js';

/** Transient project-frame marks on one selected clip; OUT is exclusive. */
export interface ClipCutRange {
  clipId: string;
  inFrame: number | null;
  outFrame: number | null;
}

function selectedClip(project: ProjectDocument, clipId: string): PlacedClip {
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clipId);
  if (!placed) throw new Error('The selected clip no longer exists.');
  return placed;
}

/** UI marks may include either placed boundary. Marking OUT at playhead + 1
 * selects an exclusive project endpoint, not an inclusive source-frame index.
 */
export function sourceRangeForCut(
  project: ProjectDocument,
  range: ClipCutRange,
): { sourceIn: number; sourceOut: number } {
  const placed = selectedClip(project, range.clipId);
  const { inFrame, outFrame } = range;
  if (inFrame === null || outFrame === null) throw new Error('Set both IN and OUT marks before removing a range.');
  if (!Number.isSafeInteger(inFrame) || !Number.isSafeInteger(outFrame))
    throw new Error('Cut marks must be integer project frames.');
  if (inFrame < placed.start || inFrame > placed.end)
    throw new Error('The IN mark must be within the selected clip, including its start/end boundaries.');
  if (outFrame < placed.start || outFrame > placed.end)
    throw new Error('The OUT mark must be within the selected clip, including its start/end boundaries.');
  if (outFrame <= inFrame) throw new Error('Cut OUT must be after IN (exclusive).');
  const sourceIn = placed.retiming.sourceAt(inFrame - placed.start);
  const sourceOut = outFrame === placed.end ? placed.clip.sourceOut : placed.retiming.sourceAt(outFrame - placed.start);
  if (sourceOut <= sourceIn)
    throw new Error('The marked range contains no original source frame at this speed. Widen the marks.');
  if (sourceIn < placed.clip.sourceIn || sourceOut > placed.clip.sourceOut)
    throw new Error('The marked source range exceeds the selected clip.');
  return { sourceIn, sourceOut };
}

export function removeMarkedRange(project: ProjectDocument, range: ClipCutRange, newClipId: string): EditCommand {
  return { type: 'remove-source-range', clipId: range.clipId, ...sourceRangeForCut(project, range), newClipId };
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
