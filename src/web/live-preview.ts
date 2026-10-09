import type { EditCommand } from '../shared/commands.js';

/** Transient, never committed: show `command` applied to the current project until it is replaced or null. */
export type LivePreview = (command: EditCommand | null) => void;

let sink: LivePreview | null = null;

/** The one editor registers its preview; the returned function unregisters it. */
export function registerLivePreview(next: LivePreview): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function livePreview(command: EditCommand | null): void {
  sink?.(command);
}
