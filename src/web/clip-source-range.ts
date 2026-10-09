import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import type { TrimEdge } from '../shared/source-range.js';
import { calculateLayout } from '../shared/timeline.js';

export interface ClipSourceRangePlan {
  command: Extract<EditCommand, { type: 'trim' }>;
  document: ProjectDocument;
  frame: number;
  error: string;
}

/** Source-bar edits share numeric trim semantics, not timeline left-edge retained-OUT placement. */
export function planClipSourceRange(
  project: ProjectDocument,
  clip: VideoClip,
  edge: TrimEdge,
  boundary: number,
  count: number,
  frame: number,
): ClipSourceRangePlan {
  const command: ClipSourceRangePlan['command'] = {
    type: 'trim',
    clipId: clip.id,
    sourceIn: edge === 'in' ? boundary : clip.sourceIn,
    sourceOut: edge === 'out' ? boundary : clip.sourceOut,
  };
  try {
    if (!Number.isSafeInteger(boundary) || command.sourceIn < 0 || command.sourceOut > count)
      throw new Error('Choose a whole frame inside the original recording.');
    if (command.sourceOut <= command.sourceIn) throw new Error('Source OUT must be after IN.');
    const document = applyCommand(project, command);
    const placed = calculateLayout(document).clips.find((item) => item.clip.id === clip.id)!;
    return { command, document, frame: edge === 'in' ? placed.start : placed.end - 1, error: '' };
  } catch (cause) {
    return {
      command,
      document: project,
      frame,
      error: `${cause instanceof Error ? cause.message : 'This range is invalid.'} Adjust this range or the conflicting fades and clips.`,
    };
  }
}

/** Captured full-original geometry; round travel once and stop only at source limits. */
export function clipSourceBoundary(
  clip: VideoClip,
  edge: TrimEdge,
  count: number,
  deltaX: number,
  width: number,
): number {
  const origin = edge === 'in' ? clip.sourceIn : clip.sourceOut;
  const boundary = origin + Math.round((deltaX * count) / width);
  return edge === 'in'
    ? Math.max(0, Math.min(clip.sourceOut - 1, boundary))
    : Math.max(clip.sourceIn + 1, Math.min(count, boundary));
}
