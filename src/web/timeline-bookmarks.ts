import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import type { TimelineRange } from '../shared/rush-editing.js';
import { snapPoints } from '../shared/snap.js';
import { calculateLayout } from '../shared/timeline.js';
import { previewFrameFor } from './keyframe-navigation.js';
import type { KeyframeMove, KeyframeSlideKind, KeyframeSlideTarget } from './keyframe-slide.js';
import { trackKeyframeFrame } from './timeline-keyframes.js';

export const BOOKMARK_SCOPE = 'bookmarks';

export function bookmarkTargets(project: ProjectDocument): KeyframeSlideTarget[] {
  return project.bookmarks.map((origin) => ({ scope: BOOKMARK_SCOPE, origin }));
}

/** Bookmarks at the selected range's IN and OUT edges (the band's edges, OUT exclusive), skipping those already present. */
export function rangeBookmarkCommands(bookmarks: readonly number[], range: TimelineRange): EditCommand[] {
  return [range.inFrame, range.outFrame]
    .filter((frame) => !bookmarks.includes(frame))
    .map((frame) => ({ type: 'bookmark-add', frame }));
}

/** Frame to seek for the nearest bookmark strictly before (-1) or after (1) the playhead; bookmarks past the end preview the last frame. */
export function adjacentBookmark(
  bookmarks: readonly number[],
  frame: number,
  duration: number,
  direction: -1 | 1,
): number | null {
  if (!duration) return null;
  let target: number | null = null;
  for (const bookmark of bookmarks) {
    const reachable = Math.min(bookmark, duration - 1);
    if (direction < 0 && reachable < frame) target = reachable;
    if (direction > 0 && reachable > frame) return reachable;
  }
  return target;
}

export function planBookmarkMove(project: ProjectDocument, frame: number, nextFrame: number): KeyframeMove {
  const command: EditCommand = { type: 'bookmark-move', frame, nextFrame };
  try {
    const document = applyCommand(project, command);
    return { frame: nextFrame, document, command: nextFrame === frame ? null : command, error: '' };
  } catch (cause) {
    return {
      frame: nextFrame,
      document: project,
      command: null,
      error: cause instanceof Error ? cause.message : 'Cannot move this bookmark.',
    };
  }
}

/** Bookmarks are project-time snap points; they move like shared track keyframes, without an Inspector section. */
export function bookmarkKind(onSeek: (frame: number) => void): KeyframeSlideKind<KeyframeSlideTarget> {
  return {
    at: ({ origin }, travel) => trackKeyframeFrame(origin, travel),
    planAt: (project, { origin }, at) => planBookmarkMove(project, origin, at),
    step: (project, { origin }, delta) => planBookmarkMove(project, origin, trackKeyframeFrame(origin, delta)),
    seekFrame: (document, _target, frame) => previewFrameFor(frame, calculateLayout(document).duration),
    select: () => {},
    reveal: (document, _target, frame) => {
      if (calculateLayout(document).duration) onSeek(frame);
    },
    selector: (_target, frame) => `[data-bookmark="${frame}"]`,
    // A dragged bookmark never snaps back to its own origin.
    snapTargets: (project, { origin }) =>
      snapPoints({ ...project, bookmarks: project.bookmarks.filter((frame) => frame !== origin) }),
    remove: (_project, { origin }) => ({ type: 'bookmark-remove', frame: origin }),
  };
}
