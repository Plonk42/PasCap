import type { ProjectDocument, Transition, VideoLayer } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';

/** A clip, or the transition after the clip `id`; clips and transitions share one selection. */
export interface SelectionItem {
  kind: 'clip' | 'transition';
  id: string;
}

/** Plain click selects one item, Ctrl/Cmd-click toggles it, Shift-click selects a range on its track. */
export type SelectionClick = 'only' | 'toggle' | 'range';

export function selectionClick(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelectionClick {
  if (event.shiftKey) return 'range';
  return event.ctrlKey || event.metaKey ? 'toggle' : 'only';
}

/**
 * Ctrl/Cmd-click adds a transition (by its left clip) to the selection and makes it primary (last), or removes a
 * selected one. Selections stay on one track: a transition of another track starts a new selection.
 */
export function toggleBoundary(project: ProjectDocument, ids: readonly string[], leftId: string): readonly string[] {
  const transitions = project.layers.find((layer) =>
    layer.transitions.some((item) => item.leftId === leftId),
  )?.transitions;
  const kept = ids.filter((id) => transitions?.some((item) => item.leftId === id));
  if (!kept.length) return [leftId];
  if (!kept.includes(leftId)) return [...kept, leftId];
  const rest = kept.filter((id) => id !== leftId);
  // The last selected transition stays selected.
  return rest.length ? rest : kept;
}

/** A timeline transition button's selection classes: the primary (last) one is solid, the others `grouped`. */
export function boundaryClass(ids: readonly string[], leftId: string): string {
  if (!ids.includes(leftId)) return '';
  return ids.at(-1) === leftId ? 'selected' : 'selected grouped';
}

/** The transition Track → Transitions opens for a clip when no transition is selected: its incoming one, else its outgoing one. */
export function followedBoundary(layer: VideoLayer, clipId: string | null): Transition | undefined {
  return (
    layer.transitions.find((item) => item.rightId === clipId) ??
    layer.transitions.find((item) => item.leftId === clipId)
  );
}

/**
 * Shift-click: every clip and transition from the anchor to the target, in that order, so the items nearest the target
 * come last (primary). Null when either is missing or they are on different tracks.
 */
export function trackRange(
  project: ProjectDocument,
  anchor: SelectionItem | null,
  target: SelectionItem,
): { clipIds: string[]; boundaryIds: string[] } | null {
  // A transition is named by its left clip, so both kinds give their track the same way.
  const layerOf = (item: SelectionItem) => project.clips.find((clip) => clip.id === item.id)?.layerId;
  const layerId = layerOf(target);
  if (!anchor || layerId === undefined || layerOf(anchor) !== layerId) return null;
  const transitions = project.layers.find((layer) => layer.id === layerId)?.transitions ?? [];
  const items = calculateLayout(project)
    .clips.filter((placed) => placed.clip.layerId === layerId)
    .flatMap((placed): SelectionItem[] => {
      const clip: SelectionItem = { kind: 'clip', id: placed.clip.id };
      return transitions.some((item) => item.leftId === placed.clip.id)
        ? [clip, { kind: 'transition', id: placed.clip.id }]
        : [clip];
    });
  const at = (item: SelectionItem) => items.findIndex((other) => other.kind === item.kind && other.id === item.id);
  const from = at(anchor);
  const to = at(target);
  if (from < 0 || to < 0) return null;
  const range = from <= to ? items.slice(from, to + 1) : items.slice(to, from + 1).reverse();
  const ids = (kind: SelectionItem['kind']) => range.filter((item) => item.kind === kind).map((item) => item.id);
  return { clipIds: ids('clip'), boundaryIds: ids('transition') };
}
