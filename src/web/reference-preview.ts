import { useSyncExternalStore } from 'react';

/** The Match reference shown over the preview while its image is held. */
export interface ShownReference {
  url: string;
  label: string;
}

let shown: ShownReference | null = null;
const listeners = new Set<() => void>();

export function showReference(next: ShownReference | null): void {
  if (shown === next) return;
  shown = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShownReference(): ShownReference | null {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => null,
  );
}
