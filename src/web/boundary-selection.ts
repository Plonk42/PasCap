import type { ProjectDocument } from '../shared/model.js';

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
