import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { PlacedClip } from '../shared/timeline.js';
import { readPreference, writePreference } from './preferences.js';

const frameSchema = z.number().int().nonnegative();
/**
 * What Color → Match aims at: a clip's source frame as its grade shows it, a recording's frame as shot, or a
 * registered style. Remembered per project in this browser, never saved with the project.
 */
export const colorReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clip'), clipId: z.string().min(1), sourceFrame: frameSchema }).strict(),
  z.object({ kind: z.literal('recording'), mediaId: z.string().min(1), sourceFrame: frameSchema }).strict(),
  z.object({ kind: z.literal('style'), styleId: z.string().min(1) }).strict(),
]);
export type ColorReference = z.infer<typeof colorReferenceSchema>;

const preference = (projectId: string): string => `pascap-color-reference-${projectId}`;
const listeners = new Set<() => void>();
const known = new Map<string, ColorReference | null>();

/** The project's color reference, or null; an unreadable preference counts as none. */
export function colorReferenceOf(projectId: string): ColorReference | null {
  if (!known.has(projectId)) {
    let reference: ColorReference | null = null;
    try {
      const parsed = colorReferenceSchema.safeParse(JSON.parse(readPreference(preference(projectId)) ?? 'null'));
      reference = parsed.success ? parsed.data : null;
    } catch {
      reference = null;
    }
    known.set(projectId, reference);
  }
  return known.get(projectId) ?? null;
}

/** Sets or clears the project's color reference; false when the browser could not remember it past this page. */
export function setColorReference(projectId: string, reference: ColorReference | null): boolean {
  known.set(projectId, reference);
  for (const listener of listeners) listener();
  return writePreference(preference(projectId), JSON.stringify(reference));
}

export function sameReference(left: ColorReference | null, right: ColorReference | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A clip's frame as a reference: the one at the playhead when it is over the clip, else its middle frame. */
export function clipReference(clip: PlacedClip, playhead: number): ColorReference {
  const offset = playhead >= clip.start && playhead < clip.end ? playhead - clip.start : (clip.end - clip.start) >> 1;
  return { kind: 'clip', clipId: clip.clip.id, sourceFrame: clip.retiming.sourceAt(offset) };
}

/** The open project's color reference, updated wherever it is set. */
export function useColorReference(projectId: string | null): ColorReference | null {
  const snapshot = (): ColorReference | null => (projectId === null ? null : colorReferenceOf(projectId));
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    snapshot,
  );
}
