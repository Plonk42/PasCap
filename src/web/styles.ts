import { useEffect, useSyncExternalStore } from 'react';
import { referenceDirectorySchema } from '../shared/footage.js';
import { styleSummarySchema, type StyleSummary } from '../shared/styles.js';
import { z } from 'zod';
import { request } from './api.js';
import { callOperation } from './operations.js';
import { readPreference, writePreference } from './preferences.js';

/** The styles registered on the service (#314), loaded once per page and after each change. */
let styles: readonly StyleSummary[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: readonly StyleSummary[]): void {
  styles = next;
  for (const listener of listeners) listener();
}

/** Reads the registry again; an unreachable registry leaves the last list. */
export function reloadStyles(): Promise<void> {
  loaded = callOperation('list_styles', {}).then(
    (result) => publish(result.styles),
    () => undefined,
  );
  return loaded;
}

/** The registered styles, loaded the first time a component needs them (`active`). */
export function useStyles(active = true): readonly StyleSummary[] {
  useEffect(() => {
    if (active && loaded === null) void reloadStyles();
  }, [active]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => styles,
  );
}

/** Registers a style from reference files read in place; measuring them can take a while. */
export async function registerStyle(name: string, paths: readonly string[]): Promise<StyleSummary> {
  const { style } = await request(
    '/api/styles',
    z.object({ style: styleSummarySchema }).strict(),
    'POST',
    { name, paths },
    { timeoutMs: 600_000 },
  );
  await reloadStyles();
  return style;
}

export async function deleteStyle(id: string): Promise<void> {
  await request(`/api/styles/${id}`, z.object({ deleted: z.literal(true) }).strict(), 'DELETE');
  await reloadStyles();
}

export function browseReferences(rootId: string, directory?: string) {
  const query = new URLSearchParams({ rootId });
  if (directory !== undefined) query.set('directory', directory);
  return request(`/api/styles/browse?${query}`, referenceDirectorySchema);
}

/** The look Auto aims at: a style's id, or null for its generic balance. Remembered across sessions. */
export const AUTO_LOOK_PREFERENCE = 'pascap-auto-look';

export function rememberedLook(available: readonly StyleSummary[]): StyleSummary | null {
  const id = readPreference(AUTO_LOOK_PREFERENCE);
  return available.find((style) => style.id === id) ?? null;
}

export function rememberLook(style: StyleSummary | null): void {
  writePreference(AUTO_LOOK_PREFERENCE, style?.id ?? '');
}

/** "2 videos, 1 still". */
export function referencesLabel(style: Pick<StyleSummary, 'references'>): string {
  const count = (kind: 'video' | 'still'): number => style.references.filter((item) => item.kind === kind).length;
  const part = (amount: number, noun: string): string => {
    if (!amount) return '';
    return `${amount} ${noun}${amount === 1 ? '' : 's'}`;
  };
  return [part(count('video'), 'video'), part(count('still'), 'still')].filter(Boolean).join(', ');
}
