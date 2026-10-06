/** An editor-only choice in the unchanged registered source; OUT is exclusive. */
export interface MediaSelection {
  mediaId: string;
  sourceIn: number;
  sourceOut: number;
}

export type MediaSelections = Readonly<Record<string, MediaSelection>>;
export type MediaSelectionEdge = 'in' | 'out';

function validateFrameCount(frameCount: number): void {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 2_147_483_647) {
    throw new Error('Source review needs the complete registered integer frame count.');
  }
}

export function validateMediaSelection(range: Readonly<MediaSelection>, frameCount: number): void {
  validateFrameCount(frameCount);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(range.mediaId)) throw new Error('Invalid registered media ID.');
  if (
    !Number.isSafeInteger(range.sourceIn) ||
    !Number.isSafeInteger(range.sourceOut) ||
    range.sourceIn < 0 ||
    range.sourceIn >= range.sourceOut ||
    range.sourceOut > frameCount
  ) {
    throw new Error(`Use whole source frames: 0 ≤ IN < OUT ≤ ${frameCount}. OUT is exclusive.`);
  }
}

export function fullMediaSelection(mediaId: string, frameCount: number): MediaSelection {
  const range = { mediaId, sourceIn: 0, sourceOut: frameCount };
  validateMediaSelection(range, frameCount);
  return range;
}

/** Missing choices mean the full recording, not a change to the media or project. */
export function resolveMediaSelection(mediaId: string, frameCount: number, ranges: MediaSelections): MediaSelection {
  const range = Object.hasOwn(ranges, mediaId) ? ranges[mediaId] : undefined;
  if (range === undefined) return fullMediaSelection(mediaId, frameCount);
  validateMediaSelection(range, frameCount);
  if (range.mediaId !== mediaId) throw new Error('Source range belongs to a different recording.');
  return { ...range };
}

export function sourcePointerRatio(clientX: number, left: number, width: number): number {
  if (![clientX, left, width].every(Number.isFinite) || width <= 0)
    throw new Error('Invalid source review pointer geometry.');
  return Math.max(0, Math.min(1, (clientX - left) / width));
}

export function sourceFrameAtRatio(ratio: number, frameCount: number): number {
  validateFrameCount(frameCount);
  if (!Number.isFinite(ratio)) throw new Error('Invalid source review position.');
  return Math.round(Math.max(0, Math.min(1, ratio)) * (frameCount - 1));
}

/** Handles stop at the opposite edge, retaining at least one original frame. */
export function moveMediaSelectionEdge(
  range: Readonly<MediaSelection>,
  edge: MediaSelectionEdge,
  frame: number,
  frameCount: number,
): MediaSelection {
  validateMediaSelection(range, frameCount);
  if (!Number.isSafeInteger(frame)) throw new Error('Source range handles need whole source frames.');
  return edge === 'in'
    ? { ...range, sourceIn: Math.max(0, Math.min(range.sourceOut - 1, frame)) }
    : { ...range, sourceOut: Math.max(range.sourceIn + 1, Math.min(frameCount, frame)) };
}

/** Mark the displayed frame exactly; OUT includes it by marking frame + 1. */
export function markMediaSelection(
  range: Readonly<MediaSelection>,
  edge: MediaSelectionEdge,
  head: number,
  frameCount: number,
): MediaSelection {
  validateMediaSelection(range, frameCount);
  if (!Number.isSafeInteger(head) || head < 0 || head >= frameCount)
    throw new Error('Mark a decoded frame inside the registered recording.');
  // If the head is outside the old selection, move the other edge just enough
  // to keep the mark exact and the selection non-empty.
  return edge === 'in'
    ? { ...range, sourceIn: head, sourceOut: Math.max(range.sourceOut, head + 1) }
    : { ...range, sourceIn: Math.min(range.sourceIn, head), sourceOut: head + 1 };
}
