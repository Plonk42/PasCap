import type { EditCommand } from './commands.js';
import type { MediaSelection, MediaSelections } from './media-selection.js';
import { MAX_SELECTS, type ProjectDocument, type SelectRange } from './model.js';

/** Length of the range **Add range** keeps, when its free stretch leaves room: two seconds. */
export const NEW_SELECT_FRAMES = 60;

/** The kept range Source preview edits: the editor's choice, else the first. */
export function activeSelectIndex(kept: readonly SelectRange[], chosen: number | undefined): number {
  return Math.max(0, Math.min(kept.length - 1, chosen ?? 0));
}

/** The range Source preview shows per recording; no entry means the whole recording and no key here. */
export function appliedSelections(
  selects: ProjectDocument['selects'],
  chosen: Readonly<Record<string, number>>,
): MediaSelections {
  return Object.fromEntries(
    Object.entries(selects).map(([mediaId, kept]) => [
      mediaId,
      { mediaId, ...kept[activeSelectIndex(kept, chosen[mediaId])]! },
    ]),
  );
}

/**
 * The edit that applies a Source preview range to a recording's active kept range: the first one creates
 * the entry, and the whole recording removes the active range (the entry, with only one), which means
 * everything is available again. Null when nothing changes.
 */
export function applySelectRange(
  kept: readonly SelectRange[],
  chosen: number | undefined,
  range: MediaSelection,
  frameCount: number,
): EditCommand | null {
  const { mediaId, sourceIn, sourceOut } = range;
  const index = activeSelectIndex(kept, chosen);
  if (sourceIn === 0 && sourceOut === frameCount)
    return kept.length
      ? { type: 'select-set', mediaId, ranges: kept.filter((_, position) => position !== index) }
      : null;
  const ranges = kept.length
    ? kept.map((item, position) => (position === index ? { sourceIn, sourceOut } : item))
    : [{ sourceIn, sourceOut }];
  return { type: 'select-set', mediaId, ranges };
}

/** A stretch of source frames `[from, to)` a new kept range may use: at least one frame from every kept range. */
export interface FreeStretch {
  from: number;
  to: number;
}

/** The free stretches between kept ranges, in source order; the whole recording when nothing is kept. */
export function freeStretches(kept: readonly SelectRange[], frameCount: number): FreeStretch[] {
  const stretches: FreeStretch[] = [];
  let from = 0;
  for (const range of kept) {
    if (range.sourceIn - 1 > from) stretches.push({ from, to: range.sourceIn - 1 });
    from = range.sourceOut + 1;
  }
  if (frameCount > from) stretches.push({ from, to: frameCount });
  return stretches;
}

/** The free stretch holding a frame, if any. */
export function freeStretchAt(kept: readonly SelectRange[], frame: number, frameCount: number): FreeStretch | null {
  return freeStretches(kept, frameCount).find((stretch) => frame >= stretch.from && frame < stretch.to) ?? null;
}

/**
 * Where **Add range** keeps a new range: from the displayed frame when it is free, else centred in the
 * largest free stretch; NEW_SELECT_FRAMES long, or the whole stretch when shorter.
 */
export function addKeptRange(
  kept: readonly SelectRange[],
  frame: number,
  frameCount: number,
): { range: SelectRange } | { reason: string } {
  if (kept.length >= MAX_SELECTS) return { reason: `A recording keeps at most ${MAX_SELECTS} ranges.` };
  const here = freeStretchAt(kept, frame, frameCount);
  if (here) return { range: { sourceIn: frame, sourceOut: Math.min(here.to, frame + NEW_SELECT_FRAMES) } };
  const largest = freeStretches(kept, frameCount).reduce<FreeStretch | null>(
    (best, stretch) => (best && best.to - best.from >= stretch.to - stretch.from ? best : stretch),
    null,
  );
  if (!largest) return { reason: 'There is no room for another range: kept ranges are one frame apart at least.' };
  const length = Math.min(NEW_SELECT_FRAMES, largest.to - largest.from);
  const sourceIn = largest.from + Math.floor((largest.to - largest.from - length) / 2);
  return { range: { sourceIn, sourceOut: sourceIn + length } };
}

/** The kept ranges with one more, and its position; or why it cannot be kept, never merged or clamped. */
export function insertKeptRange(
  kept: readonly SelectRange[],
  range: SelectRange,
): { ranges: SelectRange[]; index: number } | { reason: string } {
  if (kept.length >= MAX_SELECTS) return { reason: `A recording keeps at most ${MAX_SELECTS} ranges.` };
  if (kept.some((other) => range.sourceIn <= other.sourceOut && range.sourceOut >= other.sourceIn))
    return { reason: 'A kept range must be at least one frame away from the others.' };
  const index = kept.filter((other) => other.sourceIn < range.sourceIn).length;
  return { ranges: [...kept.slice(0, index), { ...range }, ...kept.slice(index)], index };
}

/** The kept ranges without one, and the range to edit next: the same one, or its neighbour. */
export function removeKeptRange(
  kept: readonly SelectRange[],
  index: number,
  active: number,
): { ranges: SelectRange[]; active: number } {
  const ranges = kept.filter((_, position) => position !== index);
  return { ranges, active: Math.max(0, Math.min(ranges.length - 1, index < active ? active - 1 : active)) };
}

/** How far the active kept range's IN and OUT may move: up to one frame from its neighbours. */
export function keptRangeBounds(
  kept: readonly SelectRange[],
  active: number,
  frameCount: number,
): { minIn: number; maxOut: number } {
  const previous = kept[active - 1];
  const next = kept[active + 1];
  return { minIn: previous ? previous.sourceOut + 1 : 0, maxOut: next ? next.sourceIn - 1 : frameCount };
}
