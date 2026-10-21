import type { EditCommand } from './commands.js';
import type { MediaSelection, MediaSelections } from './media-selection.js';
import { MAX_SELECTS, type ProjectDocument, type SelectRange } from './model.js';

/** Length of the range **Keep this range too** starts at the displayed frame, when the next one leaves room. */
export const NEW_SELECT_FRAMES = 30;

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

/** A further kept range of NEW_SELECT_FRAMES at the displayed frame, or why there is no room for one. */
export function keepAnotherRange(
  kept: readonly SelectRange[],
  frame: number,
  frameCount: number,
): { ranges: SelectRange[]; index: number } | { reason: string } {
  if (kept.length >= MAX_SELECTS) return { reason: `A recording keeps at most ${MAX_SELECTS} ranges.` };
  if (kept.some((range) => frame >= range.sourceIn && frame <= range.sourceOut))
    return { reason: 'Move the source preview to a frame outside the kept ranges, at least one frame from each.' };
  const next = kept.find((range) => range.sourceIn > frame);
  const sourceOut = Math.min(frame + NEW_SELECT_FRAMES, next ? next.sourceIn - 1 : frameCount);
  if (sourceOut <= frame) return { reason: 'There is no room for a range before the next kept one.' };
  const index = kept.filter((range) => range.sourceIn < frame).length;
  return {
    ranges: [...kept.slice(0, index), { sourceIn: frame, sourceOut }, ...kept.slice(index)],
    index,
  };
}
