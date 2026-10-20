import type { EditCommand } from '../shared/commands.js';

/** Transient, never committed: show `commands` applied to the current project until replaced or null. */
export type LivePreview = (commands: EditCommand | readonly EditCommand[] | null) => void;

let sink: LivePreview | null = null;

/** The one editor registers its preview; the returned function unregisters it. */
export function registerLivePreview(next: LivePreview): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function livePreview(commands: EditCommand | readonly EditCommand[] | null): void {
  sink?.(commands);
}

export function previewCommands(commands: EditCommand | readonly EditCommand[] | null): readonly EditCommand[] {
  if (commands === null) return [];
  return 'type' in commands ? [commands] : commands;
}
