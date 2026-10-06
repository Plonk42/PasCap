import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { snapFrame, snapPoints } from '../shared/snap.js';
import { calculateLayout } from '../shared/timeline.js';
import { previewFrameFor } from './keyframe-navigation.js';
import type { DraftPreview } from './Timeline.js';

type MoveKey = Extract<EditCommand, { type: 'layer-key-move' }>;
export interface KeyframeDragPlan {
  frame: number;
  document: ProjectDocument;
  command: MoveKey | null;
  guide: number | null;
  error: string;
}

/** Capture-relative project frames: neither live preview retiming nor scrolling can change the origin. */
export function keyframeFrameAtPointer(
  frame: number,
  startX: number,
  clientX: number,
  startScroll: number,
  scrollLeft: number,
  scale: number,
): number {
  if (![frame, startX, clientX, startScroll, scrollLeft, scale].every(Number.isFinite) || scale <= 0)
    throw new Error('Keyframe movement needs valid timeline geometry.');
  return Math.max(
    0,
    Math.min(2_147_483_647, frame + Math.round((clientX - startX + scrollLeft - startScroll) / scale)),
  );
}

export function planKeyframeDrag(
  project: ProjectDocument,
  layerId: string,
  frame: number,
  nextFrame: number,
  targets: readonly number[],
  tolerance: number,
): KeyframeDragPlan {
  const snapped = snapFrame(nextFrame, targets, tolerance);
  const command: MoveKey = { type: 'layer-key-move', layerId, frame, nextFrame: snapped };
  try {
    const document = applyCommand(project, command);
    return {
      frame: snapped,
      document,
      command: snapped === frame ? null : command,
      guide: snapped === nextFrame ? null : snapped,
      error: '',
    };
  } catch (cause) {
    return {
      frame: snapped,
      document: project,
      command: null,
      guide: null,
      error: cause instanceof Error ? cause.message : 'Cannot move this shared point.',
    };
  }
}

interface Options {
  project: ProjectDocument;
  frame: number;
  scale: number;
  width: number;
  disabled: boolean;
  snapping: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  onPause: () => void;
  onSelectLayer: (id: string) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onEdit: (command: EditCommand) => void;
  onSeekKeyframe: (layerId: string, frame: number) => void;
  onError: (error: string) => void;
}
interface Session {
  pointerId: number;
  element: HTMLButtonElement;
  project: ProjectDocument;
  layerId: string;
  origin: number;
  startX: number;
  startScroll: number;
  scale: number;
  width: number;
  playhead: number;
  moved: boolean;
  pointerX: number;
  alt: boolean;
  targets: number[];
  plan: KeyframeDragPlan;
}
export interface TimelineKeyframeDraft extends KeyframeDragPlan {
  layerId: string;
  origin: number;
  width: number;
}

/** Pointer capture owns one shared-point transaction. Only release can enter history/autosave. */
export function useTimelineKeyframes(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | null>(null);
  const animation = useRef(0);
  const [draft, setDraft] = useState<TimelineKeyframeDraft | null>(null);

  const clear = useCallback((restoreScroll: boolean, restoreFrame?: number): Session | null => {
    const active = session.current;
    if (!active) return null;
    session.current = null;
    cancelAnimationFrame(animation.current);
    animation.current = 0;
    const { viewport, onPreview } = latest.current;
    if (restoreScroll && viewport.current) viewport.current.scrollLeft = active.startScroll;
    setDraft(null);
    onPreview(null, restoreFrame);
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  const cancel = useCallback((): void => {
    clear(true);
  }, [clear]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !session.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      cancelAnimationFrame(animation.current);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
    };
  }, [cancel]);
  useEffect(() => {
    if (session.current && session.current.project !== options.project) cancel();
  }, [options.project, cancel]);

  const update = (): void => {
    const active = session.current;
    const current = latest.current;
    const viewport = current.viewport.current;
    if (!active || !viewport) return;
    const travel = active.pointerX - active.startX + viewport.scrollLeft - active.startScroll;
    if (!active.moved && Math.abs(travel) < 3) return;
    active.moved = true;
    const frame = keyframeFrameAtPointer(
      active.origin,
      active.startX,
      active.pointerX,
      active.startScroll,
      viewport.scrollLeft,
      active.scale,
    );
    const plan = planKeyframeDrag(
      active.project,
      active.layerId,
      active.origin,
      frame,
      current.snapping && !active.alt ? active.targets : [],
      8 / active.scale,
    );
    if (plan.frame === active.plan.frame && plan.error === active.plan.error && plan.guide === active.plan.guide)
      return;
    active.plan = plan;
    setDraft({ ...plan, layerId: active.layerId, origin: active.origin, width: active.width });
    current.onPreview({
      document: plan.document,
      frame: previewFrameFor(plan.frame, calculateLayout(plan.document).duration),
    });
  };
  const latestUpdate = useRef(update);
  latestUpdate.current = update;
  const autoScroll = (): void => {
    const active = session.current;
    const viewport = latest.current.viewport.current;
    if (!active || !viewport) return;
    if (!active.moved) {
      animation.current = requestAnimationFrame(autoScroll);
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    let velocity = 0;
    if (active.pointerX < bounds.left + 28) velocity = -Math.min(14, (bounds.left + 28 - active.pointerX) / 3);
    else if (active.pointerX > bounds.right - 28) velocity = Math.min(14, (active.pointerX - bounds.right + 28) / 3);
    const previous = viewport.scrollLeft;
    viewport.scrollLeft += velocity;
    if (viewport.scrollLeft !== previous) latestUpdate.current();
    animation.current = requestAnimationFrame(autoScroll);
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, layerId: string, frame: number): void => {
    const { viewport, disabled, project, scale, width, onPause, onSelectLayer, onPreview } = latest.current;
    if (disabled || session.current || event.button !== 0 || !viewport.current) return;
    event.preventDefault();
    event.stopPropagation();
    const plan: KeyframeDragPlan = { frame, document: project, command: null, guide: null, error: '' };
    session.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      project,
      layerId,
      origin: frame,
      startX: event.clientX,
      pointerX: event.clientX,
      startScroll: viewport.current.scrollLeft,
      scale,
      width,
      playhead: latest.current.frame,
      moved: false,
      alt: event.altKey,
      targets: [...new Set([...snapPoints(project), latest.current.frame])],
      plan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onPause();
    onSelectLayer(layerId);
    setDraft({ ...plan, layerId, origin: frame, width });
    onPreview({ document: project, frame: latest.current.frame });
    animation.current = requestAnimationFrame(autoScroll);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    active.alt = event.altKey;
    update();
  };
  const focusMarker = (layerId: string, frame: number): void => {
    requestAnimationFrame(() => {
      const viewport = latest.current.viewport.current;
      const selector = `[data-keyframe-layer="${CSS.escape(layerId)}"][data-layer-keyframe="${frame}"]`;
      const marker = viewport?.querySelector<HTMLButtonElement>(selector);
      if (marker) marker.focus({ preventScroll: true });
      else viewport?.closest<HTMLElement>('.timeline-panel')?.focus({ preventScroll: true });
    });
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    active.alt = event.altKey;
    update();
    clear(
      false,
      active.plan.error
        ? undefined
        : previewFrameFor(active.plan.frame, calculateLayout(active.plan.document).duration),
    );
    if (active.plan.error) {
      latest.current.onError(active.plan.error);
      focusMarker(active.layerId, active.origin);
      return;
    }
    if (active.plan.command) latest.current.onEdit(active.plan.command);
    latest.current.onSeekKeyframe(active.layerId, active.plan.frame);
    focusMarker(active.layerId, active.plan.frame);
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, layerId: string, frame: number): void => {
    if (latest.current.disabled || session.current || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1);
    const plan = planKeyframeDrag(
      latest.current.project,
      layerId,
      frame,
      Math.max(0, Math.min(2_147_483_647, frame + delta)),
      [],
      0,
    );
    if (plan.error) {
      latest.current.onError(plan.error);
      return;
    }
    if (plan.command) latest.current.onEdit(plan.command);
    latest.current.onSeekKeyframe(layerId, plan.frame);
    focusMarker(layerId, plan.frame);
  };

  return { draft, active: session.current !== null, begin, move, finish, cancel, keyboard };
}
