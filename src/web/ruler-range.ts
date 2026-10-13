import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { ProjectDocument } from '../shared/model.js';
import type { TimelineRange } from '../shared/rush-editing.js';
import { snapFrame, snapPoints } from '../shared/snap.js';

const DRAG_THRESHOLD = 3;
const EDGE = 28;

export interface RulerRangeDraft {
  range: TimelineRange | null;
  guide: number | null;
}

interface Gesture {
  pointerId: number;
  startX: number;
  anchor: number;
  playhead: number;
  base: ProjectDocument;
  duration: number;
  leading: number;
  scale: number;
  clientX: number;
  alt: boolean;
  moved: boolean;
}

interface Options {
  project: ProjectDocument;
  duration: number;
  frame: number;
  leading: number;
  scale: number;
  snapping: boolean;
  disabled: boolean;
  surface: RefObject<HTMLDivElement | null>;
  viewport: RefObject<HTMLDivElement | null>;
  onPause: () => void;
  onSeek: (frame: number) => void;
  onScrub: ((active: boolean) => void) | undefined;
  onRange: (range: TimelineRange | null) => void;
}

/** Ruler pointer gesture: a click seeks and clears the range; a drag selects a project-frame range. */
export function useRulerRange(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const autoScroll = useRef(0);
  const [draft, setDraft] = useState<RulerRangeDraft | null>(null);

  const boundaryAt = (
    active: Gesture,
    clientX: number,
    alt: boolean,
    playhead = true,
  ): { frame: number; guide: number | null } => {
    const left = latest.current.surface.current?.getBoundingClientRect().left ?? 0;
    const raw = Math.round((clientX - left - active.leading) / active.scale);
    const targets = playhead ? [...snapPoints(active.base), active.playhead] : snapPoints(active.base);
    const snapped = latest.current.snapping && !alt ? snapFrame(raw, targets, 8 / active.scale) : raw;
    const frame = Math.max(0, Math.min(active.duration, snapped));
    return { frame, guide: snapped === raw ? null : frame };
  };
  const update = (): void => {
    const active = gesture.current;
    if (!active?.moved) return;
    const { frame, guide } = boundaryAt(active, active.clientX, active.alt);
    const range =
      frame === active.anchor
        ? null
        : { inFrame: Math.min(active.anchor, frame), outFrame: Math.max(active.anchor, frame) };
    setDraft({ range, guide });
    // Preview the frame the moving edge removes first (IN) or last (OUT − 1).
    latest.current.onSeek(Math.min(active.duration - 1, frame > active.anchor ? frame - 1 : frame));
  };
  const stopScroll = (): void => {
    cancelAnimationFrame(autoScroll.current);
    autoScroll.current = 0;
  };
  const startScroll = (): void => {
    const advance = (): void => {
      const active = gesture.current;
      const element = latest.current.viewport.current;
      if (!active || !element) return;
      const bounds = element.getBoundingClientRect();
      let velocity = 0;
      if (active.clientX < bounds.left + EDGE) velocity = -Math.min(14, (bounds.left + EDGE - active.clientX) / 3);
      if (active.clientX > bounds.right - EDGE) velocity = Math.min(14, (active.clientX - bounds.right + EDGE) / 3);
      if (velocity) {
        const previous = element.scrollLeft;
        element.scrollLeft += velocity;
        if (element.scrollLeft !== previous) update();
      }
      autoScroll.current = requestAnimationFrame(advance);
    };
    autoScroll.current = requestAnimationFrame(advance);
  };
  const end = (): Gesture | null => {
    const active = gesture.current;
    gesture.current = null;
    stopScroll();
    setDraft(null);
    if (active?.moved) latest.current.onScrub?.(false);
    return active;
  };
  const cancel = (): void => {
    const active = end();
    if (active?.moved) latest.current.onSeek(active.playhead);
  };
  const latestCancel = useRef(cancel);
  latestCancel.current = cancel;

  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !gesture.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latestCancel.current();
    };
    const blur = (): void => latestCancel.current();
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
      cancelAnimationFrame(autoScroll.current);
    };
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    const { duration, disabled, project, frame, leading, scale } = latest.current;
    if (!duration || disabled || event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const active: Gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      anchor: 0,
      playhead: frame,
      base: project,
      duration,
      leading,
      scale,
      clientX: event.clientX,
      alt: event.altKey,
      moved: false,
    };
    active.anchor = boundaryAt(active, event.clientX, event.altKey).frame;
    gesture.current = active;
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const active = gesture.current;
    if (event.pointerId !== active?.pointerId) return;
    active.clientX = event.clientX;
    active.alt = event.altKey;
    if (!active.moved && Math.abs(event.clientX - active.startX) < DRAG_THRESHOLD) return;
    if (!active.moved) {
      active.moved = true;
      latest.current.onPause();
      latest.current.onScrub?.(true);
      startScroll();
    }
    update();
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const active = gesture.current;
    if (event.pointerId !== active?.pointerId) return;
    active.clientX = event.clientX;
    active.alt = event.altKey;
    if (!active.moved) {
      end();
      latest.current.onRange(null);
      latest.current.onSeek(Math.min(active.duration - 1, boundaryAt(active, active.startX, active.alt, false).frame));
      return;
    }
    const { frame } = boundaryAt(active, event.clientX, event.altKey);
    end();
    latest.current.onRange(
      frame === active.anchor
        ? null
        : { inFrame: Math.min(active.anchor, frame), outFrame: Math.max(active.anchor, frame) },
    );
  };
  const onLostPointerCapture = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerId === gesture.current?.pointerId) cancel();
  };

  return {
    draft,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onLostPointerCapture,
      onLostPointerCapture,
    },
  };
}
