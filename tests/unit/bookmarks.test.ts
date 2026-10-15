import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createClip, createProject, MAX_BOOKMARKS, projectSchema } from '../../src/shared/model.js';
import { snapFrame, snapPoints } from '../../src/shared/snap.js';
import { editorShortcut } from '../../src/web/shortcuts.js';
import { adjacentBookmark, bookmarkKind, bookmarkTargets, planBookmarkMove } from '../../src/web/timeline-bookmarks.js';
import { placementSnapPoints } from '../../src/web/timeline-placement.js';

function project() {
  const document = createProject('bookmarks', 'Bookmarks');
  document.media.videoIds = ['recording'];
  document.clips = [createClip('clip', 'recording', 0, 90)];
  return projectSchema.parse(document);
}

describe('strict current-schema project bookmarks', () => {
  it('starts empty and requires unique ascending integer frames, without defaults', () => {
    const document = project();
    expect(document.bookmarks).toEqual([]);
    expect(projectSchema.safeParse({ ...document, bookmarks: [5, 40, 2_147_483_647] }).success).toBe(true);
    for (const bookmarks of [[40, 5], [5, 5], [-1], [1.5], [2_147_483_648], null, undefined])
      expect(projectSchema.safeParse({ ...document, bookmarks }).success).toBe(false);
    const missing: Record<string, unknown> = { ...document };
    delete missing['bookmarks'];
    expect(projectSchema.safeParse(missing).success).toBe(false);
    expect(projectSchema.safeParse({ ...document, schemaVersion: 16 }).success).toBe(false);
    const full = Array.from({ length: MAX_BOOKMARKS + 1 }, (_, index) => index);
    expect(projectSchema.safeParse({ ...document, bookmarks: full }).success).toBe(false);
  });

  it('adds, moves and removes one bookmark per Undo step and rejects occupied frames atomically', () => {
    const history = new EditHistory(project());
    history.commit({ type: 'bookmark-add', frame: 60 });
    history.commit({ type: 'bookmark-add', frame: 10 });
    expect(history.current.bookmarks).toEqual([10, 60]);
    const before = history.current;
    expect(() => applyCommand(before, { type: 'bookmark-add', frame: 10 })).toThrow('already exists at this frame');
    expect(() => applyCommand(before, { type: 'bookmark-move', frame: 10, nextFrame: 60 })).toThrow(
      'already exists at the destination',
    );
    expect(() => applyCommand(before, { type: 'bookmark-move', frame: 11, nextFrame: 20 })).toThrow('no longer exists');
    expect(() => applyCommand(before, { type: 'bookmark-add', frame: -1 })).toThrow();
    expect(() => applyCommand(before, { type: 'bookmark-move', frame: 10, nextFrame: 0.5 })).toThrow();
    expect(before.bookmarks).toEqual([10, 60]);
    history.commit({ type: 'bookmark-move', frame: 10, nextFrame: 75 });
    expect(history.current.bookmarks).toEqual([60, 75]);
    history.commit({ type: 'bookmark-remove', frame: 60 });
    expect(history.current.bookmarks).toEqual([75]);
    expect(history.undo().bookmarks).toEqual([60, 75]);
    expect(history.undo().bookmarks).toEqual([10, 60]);
    // Editing aids only: clips, music and timing stay untouched, even beyond duration.
    const far = applyCommand(before, { type: 'bookmark-move', frame: 60, nextFrame: 5_000 });
    expect(far.clips).toEqual(before.clips);
    expect(far.bookmarks).toEqual([10, 5_000]);
  });

  it('refuses a bookmark beyond the limit', () => {
    const document = projectSchema.parse({
      ...project(),
      bookmarks: Array.from({ length: MAX_BOOKMARKS }, (_, index) => index),
    });
    expect(() => applyCommand(document, { type: 'bookmark-add', frame: MAX_BOOKMARKS })).toThrow('at most 1,000');
  });
});

describe('bookmark snapping', () => {
  it('adds bookmarks to the shared snap points and placement magnets', () => {
    const document = { ...project(), bookmarks: [37, 200] };
    expect(snapPoints(document)).toEqual([0, 37, 90, 200]);
    expect(snapFrame(41, snapPoints(document), 8)).toBe(37);
    expect(snapFrame(46, snapPoints(document), 8)).toBe(46);
    expect(placementSnapPoints(document, 'clip', 120)).toEqual([0, 37, 120, 200]);
  });

  it('never snaps a dragged bookmark to itself, and moves through the shared slide plan', () => {
    const document = { ...project(), bookmarks: [37, 200] };
    const kind = bookmarkKind(() => {});
    const [first] = bookmarkTargets(document);
    expect(first).toEqual({ scope: 'bookmarks', origin: 37 });
    expect(kind.snapTargets!(document, first!)).toEqual([0, 90, 200]);
    expect(kind.at(first!, -50)).toBe(0);
    expect(kind.planAt(document, first!, 37).command).toBeNull();
    const moved = kind.step(document, first!, 10);
    expect(moved.error).toBe('');
    expect(moved.command).toEqual({ type: 'bookmark-move', frame: 37, nextFrame: 47 });
    expect(moved.document.bookmarks).toEqual([47, 200]);
    const blocked = planBookmarkMove(document, 37, 200);
    expect(blocked.error).toContain('already exists');
    expect(blocked.document).toBe(document);
    expect(kind.remove!(first!)).toEqual({ type: 'bookmark-remove', frame: 37 });
    expect(kind.seekFrame(document, first!, 500)).toBe(89);
  });

  it('maps M to adding a bookmark, leaving modified keys alone', () => {
    const key = { code: 'KeyM', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false };
    expect(editorShortcut({ ...key, key: 'm' })).toEqual({ type: 'bookmark' });
    expect(editorShortcut({ ...key, key: 'M', shiftKey: true })).toEqual({ type: 'bookmark' });
    expect(editorShortcut({ ...key, key: 'm', altKey: true })).toBeNull();
    expect(editorShortcut({ ...key, key: 'm', ctrlKey: true })).toBeNull();
  });

  it('navigates to the nearest bookmark strictly before or after the playhead, reaching the last frame', () => {
    const bookmarks = [10, 40, 40_000];
    expect(adjacentBookmark(bookmarks, 25, 90, -1)).toBe(10);
    expect(adjacentBookmark(bookmarks, 25, 90, 1)).toBe(40);
    expect(adjacentBookmark(bookmarks, 40, 90, -1)).toBe(10);
    expect(adjacentBookmark(bookmarks, 10, 90, -1)).toBeNull();
    expect(adjacentBookmark(bookmarks, 40, 90, 1)).toBe(89);
    expect(adjacentBookmark(bookmarks, 89, 90, 1)).toBeNull();
    expect(adjacentBookmark(bookmarks, 89, 90, -1)).toBe(40);
    expect(adjacentBookmark([], 5, 90, 1)).toBeNull();
    expect(adjacentBookmark(bookmarks, 0, 0, 1)).toBeNull();
    const arrow = { code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, repeat: false };
    expect(editorShortcut({ ...arrow, key: 'ArrowUp' })).toEqual({ type: 'bookmark-previous' });
    expect(editorShortcut({ ...arrow, key: 'ArrowDown' })).toEqual({ type: 'bookmark-next' });
    expect(editorShortcut({ ...arrow, key: 'ArrowDown', shiftKey: false })).toBeNull();
    expect(editorShortcut({ ...arrow, key: 'ArrowUp', altKey: true })).toBeNull();
  });
});
