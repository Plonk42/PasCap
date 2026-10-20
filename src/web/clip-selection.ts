import { useCallback, useRef, useState, type RefObject } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { applyCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';

/** The selected clips: `primary` drives Clip properties; `group` lists every selected clip once two or more are. */
export interface ClipSelection {
  primary: string | null;
  group: readonly string[];
}

/** Editor-only group state, with a ref for event handlers. */
export function useClipGroup(): {
  group: readonly string[];
  latest: RefObject<readonly string[]>;
  set: (group: readonly string[]) => void;
} {
  const [group, setGroup] = useState<readonly string[]>([]);
  const latest = useRef<readonly string[]>([]);
  const set = useCallback((next: readonly string[]): void => {
    latest.current = next;
    setGroup(next);
  }, []);
  return { group, latest, set };
}

/** The clips an action on the selection applies to. */
export function selectedClipIds(group: readonly string[], primary: string): readonly string[] {
  return group.length ? group : [primary];
}

function selectedIds({ primary, group }: ClipSelection): readonly string[] {
  if (group.length) return group;
  return primary === null ? [] : [primary];
}

function withGroup(primary: string | null, ids: readonly string[]): ClipSelection {
  return { primary, group: ids.length > 1 ? ids : [] };
}

/** Ctrl/Cmd-click adds a clip to the selection and makes it primary, or removes a selected one. */
export function toggleClip(selection: ClipSelection, id: string): ClipSelection {
  const ids = selectedIds(selection);
  if (!ids.includes(id)) return withGroup(id, [...ids, id]);
  const rest = ids.filter((item) => item !== id);
  // The last selected clip stays selected.
  if (!rest.length) return selection;
  return withGroup(selection.primary === id ? rest.at(-1)! : selection.primary, rest);
}

/** Adds every clip of a track to the selection; the primary clip stays, else the track's first becomes it. */
export function addTrackClips(selection: ClipSelection, project: ProjectDocument, layerId: string): ClipSelection {
  const ids = selectedIds(selection);
  const added = calculateLayout(project)
    .clips.filter((placed) => placed.clip.layerId === layerId && !ids.includes(placed.clip.id))
    .map((placed) => placed.clip.id);
  return withGroup(selection.primary ?? added[0] ?? null, [...ids, ...added]);
}

/** Removed clips leave the group; one remaining clip is a single selection again. */
export function groupWithin(group: readonly string[], project: ProjectDocument): readonly string[] {
  const kept = group.filter((id) => project.clips.some((clip) => clip.id === id));
  return kept.length > 1 ? kept : [];
}

/** Applies a new selection: a new primary goes through `select`, which clears the group, then the group is set. */
export function applyClipSelection(
  next: ClipSelection,
  primary: string | null,
  select: (id: string) => void,
  setGroup: (group: readonly string[]) => void,
): void {
  if (next.primary !== null && next.primary !== primary) select(next.primary);
  setGroup(next.group);
}

/** Alt+←/→ moves the whole group in time; Ripple tracks keep their sequence, so a move may change nothing. */
export function groupNudge(project: ProjectDocument, group: readonly string[], delta: number): EditCommand | string {
  const command: EditCommand = { type: 'move-clips', clipIds: [...group], delta, layerId: null };
  try {
    const next = applyCommand(project, command);
    if (JSON.stringify(next.clips) === JSON.stringify(project.clips))
      return 'These clips keep their place in a Ripple sequence. Turn Ripple off to nudge them, or drag them.';
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'These clips cannot move there.';
  }
  return command;
}
