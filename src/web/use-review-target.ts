import { useState, type RefObject } from 'react';
import type { ReviewTarget } from './MediaLibrary.js';
import type { SourcePlayback } from './SourceReview.js';

export interface ReviewControls {
  /** The latest requested or displayed frame, without waiting for a render. */
  current: () => ReviewTarget | null;
  source: (next: ReviewTarget, choose: boolean) => void;
  endHover: () => void;
  /** A frame the source preview displayed or seeked to itself. */
  displayed: (next: ReviewTarget) => void;
  chooseShown: () => void;
  close: () => void;
  /** Forget removed recordings; true when the open review was one of them. */
  remove: (videoIds: readonly string[]) => boolean;
}

export function reviewControls(
  playback: RefObject<SourcePlayback | null>,
  setReview: (next: ReviewTarget | null) => void,
): ReviewControls {
  // The recording last requested from React, which may not be rendered yet.
  let requested: string | null = null;
  let shown: ReviewTarget | null = null;
  // The last clicked/focused recording; hovering another one only previews it temporarily.
  let chosen: ReviewTarget | null = null;
  let hovering = false;
  const open = (next: ReviewTarget | null): void => {
    shown = next;
    requested = next?.mediaId ?? null;
    setReview(next);
  };
  const move = (next: ReviewTarget): void => {
    if (requested === next.mediaId && playback.current?.show(next.mediaId, next.frame)) shown = next;
    else open(next);
  };
  return {
    current: () => shown,
    source(next, choose) {
      if (choose) chosen = next;
      hovering = !choose;
      move(next);
    },
    endHover() {
      if (!hovering) return;
      hovering = false;
      if (chosen) move(chosen);
    },
    displayed(next) {
      shown = next;
      if (!hovering && chosen?.mediaId === next.mediaId) chosen = next;
    },
    chooseShown() {
      chosen = shown;
      hovering = false;
    },
    close() {
      chosen = null;
      hovering = false;
      open(null);
    },
    remove(videoIds) {
      if (chosen && videoIds.includes(chosen.mediaId)) chosen = null;
      if (requested === null || !videoIds.includes(requested)) return false;
      hovering = false;
      open(null);
      return true;
    },
  };
}

/**
 * The reviewed recording and stable controls. Frame moves within the open recording go
 * straight to the source preview, so hover scrubbing never re-renders the editor:
 * `review` changes only when another recording opens or the review closes.
 */
export function useReviewTarget(
  playback: RefObject<SourcePlayback | null>,
): [review: ReviewTarget | null, controls: ReviewControls] {
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [controls] = useState(() => reviewControls(playback, setReview));
  return [review, controls];
}
