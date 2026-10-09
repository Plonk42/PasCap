import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import type { DraftPreview } from './Timeline.js';
import { editorShortcut } from './shortcuts.js';

/** One stored keyframe: its owner (track or clip) and its stored frame in the rendered document. */
export interface KeyframeSlideTarget {
  scope: string;
  origin: number;
}
export interface KeyframeMove {
  frame: number;
  document: ProjectDocument;
  command: EditCommand | null;
  error: string;
}
export interface KeyframeSlidePlan extends KeyframeMove {
  /** Timeline frame where the dragged marker is drawn, valid or not. */
  at: number;
  /** Snapped timeline frame, if any. */
  guide: number | null;
}
export interface KeyframeSlideDraft<T extends KeyframeSlideTarget> extends KeyframeSlidePlan {
  target: T;
  width: number;
}

/** What differs between keyframe types; everything else is shared by `useKeyframeSlide`. */
export interface KeyframeSlideKind<T extends KeyframeSlideTarget> {
  /** Pointer travel is in timeline frames, relative to the captured marker; `scale` is pixels per frame. */
  plan(
    project: ProjectDocument,
    target: T,
    travel: number,
    gesture: { playhead: number; alt: boolean; scale: number },
  ): KeyframeSlidePlan;
  /** Arrow keys move the stored frame by `delta`. */
  step(project: ProjectDocument, target: T, delta: number): KeyframeMove;
  /** Timeline frame previewing the key stored at `frame`, or null when it has none. */
  seekFrame(document: ProjectDocument, target: T, frame: number): number | null;
  select(target: T): void;
  /** Seeks to the key stored at `frame`; `open` also opens its Inspector section. */
  reveal(document: ProjectDocument, target: T, frame: number, open: boolean): void;
  selector(target: T, frame: number): string;
}

interface Options<T extends KeyframeSlideTarget> {
  kind: KeyframeSlideKind<T>;
  project: ProjectDocument;
  frame: number;
  scale: number;
  width: number;
  disabled: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  onPause: () => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onEdit: (command: EditCommand) => void;
  onError: (error: string) => void;
}
interface Session<T extends KeyframeSlideTarget> {
  pointerId: number;
  element: HTMLButtonElement;
  project: ProjectDocument;
  target: T;
  startX: number;
  startScroll: number;
  scale: number;
  width: number;
  playhead: number;
  moved: boolean;
  pointerX: number;
  alt: boolean;
  plan: KeyframeSlidePlan;
}

export interface KeyframeMarkerState {
  /** React key: the dragged marker keeps its origin's, so its element and pointer capture survive. */
  key: string;
  moving: boolean;
  invalid: boolean;
  /** Displayed stored frame. */
  frame: number;
  /** Stored frame when the gesture started. */
  origin: number;
  /** Drawn timeline frame while moving, else null. */
  at: number | null;
}

/** Capture-relative timeline frames: neither live preview retiming nor scrolling can change the origin. */
export function slideTravel(
  startX: number,
  clientX: number,
  startScroll: number,
  scrollLeft: number,
  scale: number,
): number {
  if (![startX, clientX, startScroll, scrollLeft, scale].every(Number.isFinite) || scale <= 0)
    throw new Error('Keyframe movement needs valid timeline geometry.');
  return Math.round((clientX - startX + scrollLeft - startScroll) / scale);
}

/** Pointer capture owns one keyframe-slide transaction. Only a valid release enters history/autosave. */
export function useKeyframeSlide<T extends KeyframeSlideTarget>(options: Options<T>) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session<T> | null>(null);
  const animation = useRef(0);
  const [draft, setDraft] = useState<KeyframeSlideDraft<T> | null>(null);

  const clear = useCallback((restoreScroll: boolean, restoreFrame?: number): Session<T> | null => {
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

  const focusMarker = (target: T, frame: number): void => {
    requestAnimationFrame(() => {
      const viewport = latest.current.viewport.current;
      const marker = viewport?.querySelector<HTMLButtonElement>(latest.current.kind.selector(target, frame));
      if (marker) marker.focus({ preventScroll: true });
      else viewport?.closest<HTMLElement>('.timeline-panel')?.focus({ preventScroll: true });
    });
  };
  const update = (): void => {
    const active = session.current;
    const { viewport, kind, onPreview } = latest.current;
    if (!active || !viewport.current) return;
    const scrollLeft = viewport.current.scrollLeft;
    if (!active.moved && Math.abs(active.pointerX - active.startX + scrollLeft - active.startScroll) < 3) return;
    active.moved = true;
    const travel = slideTravel(active.startX, active.pointerX, active.startScroll, scrollLeft, active.scale);
    const plan = kind.plan(active.project, active.target, travel, {
      playhead: active.playhead,
      alt: active.alt,
      scale: active.scale,
    });
    if (plan.frame === active.plan.frame && plan.error === active.plan.error && plan.guide === active.plan.guide)
      return;
    active.plan = plan;
    setDraft({ ...plan, target: active.target, width: active.width });
    onPreview({
      document: plan.document,
      frame: kind.seekFrame(plan.document, active.target, plan.frame) ?? active.playhead,
    });
  };
  const latestUpdate = useRef(update);
  latestUpdate.current = update;
  const autoScroll = (): void => {
    const active = session.current;
    const viewport = latest.current.viewport.current;
    if (!active || !viewport) return;
    if (active.moved) {
      const bounds = viewport.getBoundingClientRect();
      let velocity = 0;
      if (active.pointerX < bounds.left + 28) velocity = -Math.min(14, (bounds.left + 28 - active.pointerX) / 3);
      else if (active.pointerX > bounds.right - 28) velocity = Math.min(14, (active.pointerX - bounds.right + 28) / 3);
      const previous = viewport.scrollLeft;
      viewport.scrollLeft += velocity;
      if (viewport.scrollLeft !== previous) latestUpdate.current();
    }
    animation.current = requestAnimationFrame(autoScroll);
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, target: T): void => {
    const { viewport, disabled, project, scale, width, frame, kind, onPause, onPreview } = latest.current;
    if (disabled || session.current || event.button !== 0 || !viewport.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const plan: KeyframeSlidePlan = {
      frame: target.origin,
      at: kind.seekFrame(project, target, target.origin) ?? frame,
      document: project,
      command: null,
      guide: null,
      error: '',
    };
    session.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      project,
      target,
      startX: event.clientX,
      pointerX: event.clientX,
      startScroll: viewport.current.scrollLeft,
      scale,
      width,
      playhead: frame,
      moved: false,
      alt: event.altKey,
      plan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onPause();
    kind.select(target);
    setDraft({ ...plan, target, width });
    onPreview({ document: project, frame });
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
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    active.alt = event.altKey;
    update();
    const { kind, onEdit, onError } = latest.current;
    const { plan, target } = active;
    clear(false, plan.error ? undefined : (kind.seekFrame(plan.document, target, plan.frame) ?? undefined));
    if (plan.error) {
      onError(plan.error);
      focusMarker(target, target.origin);
      return;
    }
    if (plan.command) onEdit(plan.command);
    kind.reveal(plan.document, target, plan.frame, true);
    focusMarker(target, plan.frame);
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, target: T): void => {
    // Undo/Redo still apply; every other key stays with the marker.
    const shortcut = editorShortcut(event)?.type;
    if (shortcut !== 'undo' && shortcut !== 'redo') event.stopPropagation();
    const { disabled, project, kind, onEdit, onError } = latest.current;
    if (disabled || session.current || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const plan = kind.step(project, target, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1));
    if (plan.error) {
      onError(plan.error);
      return;
    }
    if (plan.command) onEdit(plan.command);
    kind.reveal(plan.document, target, plan.frame, false);
    focusMarker(target, plan.frame);
  };
  /** Enter/Space: a pointer click was already handled by its slide session. */
  const activate = (event: MouseEvent<HTMLButtonElement>, target: T): void => {
    event.stopPropagation();
    const { disabled, project, kind } = latest.current;
    if (event.detail !== 0 || disabled || session.current) return;
    kind.select(target);
    kind.reveal(project, target, target.origin, true);
  };
  const marker = (target: T): KeyframeMarkerState => {
    const moving =
      draft !== null &&
      draft.target.scope === target.scope &&
      target.origin === (draft.error ? draft.target.origin : draft.frame);
    const origin = moving ? draft.target.origin : target.origin;
    return {
      key: `${target.scope}:${origin}`,
      moving,
      invalid: moving && draft.error !== '',
      frame: moving ? draft.frame : target.origin,
      origin,
      at: moving ? draft.at : null,
    };
  };

  return { draft, active: session.current !== null, begin, move, finish, cancel, keyboard, activate, marker };
}

export type KeyframeSlide<T extends KeyframeSlideTarget> = ReturnType<typeof useKeyframeSlide<T>>;

const swallow = (event: { preventDefault: () => void; stopPropagation: () => void }): void => {
  event.preventDefault();
  event.stopPropagation();
};
const contain = (event: { stopPropagation: () => void }): void => event.stopPropagation();

/** Keeps marker mouse/keyboard events out of the clip's native drag and the timeline's handlers. */
export const keyframeMarkerGuards = {
  onMouseDown: swallow,
  onMouseMove: contain,
  onMouseUp: contain,
  onDoubleClick: swallow,
  onDragStart: swallow,
  onKeyUp: contain,
};

type MarkerView = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'disabled' | 'draggable' | `on${string}` | 'children'
> &
  Partial<Record<`data-${string}`, string | number>> & { children: ReactNode };

/** Every sliding keyframe marker: one element per stored key, identical pointer/keyboard behaviour. */
export function KeyframeMarkers<T extends KeyframeSlideTarget>(
  props: Readonly<{
    slide: KeyframeSlide<T>;
    targets: readonly T[];
    blocked: () => boolean;
    view: (target: T, state: KeyframeMarkerState) => MarkerView;
  }>,
) {
  const { slide, blocked } = props;
  // Committed order: reordering would detach the dragged element and drop its pointer capture.
  const entries = props.targets
    .map((target) => ({ target, state: slide.marker(target) }))
    .sort((left, right) => left.state.origin - right.state.origin);
  return entries.map(({ target, state }) => {
    const { className, ...view } = props.view(target, state);
    return (
      <button
        {...view}
        type="button"
        key={state.key}
        className={`${className ?? ''}${state.moving ? ' moving' : ''}${state.invalid ? ' invalid' : ''}`}
        data-keyframe-origin={state.origin}
        draggable={false}
        disabled={blocked() && !state.moving}
        {...keyframeMarkerGuards}
        onPointerDown={(event) => slide.begin(event, target)}
        onPointerMove={slide.move}
        onPointerUp={slide.finish}
        onPointerCancel={slide.cancel}
        onLostPointerCapture={slide.cancel}
        onKeyDown={(event) => slide.keyboard(event, target)}
        onClick={(event) => {
          if (!blocked()) slide.activate(event, target);
          else event.stopPropagation();
        }}
      />
    );
  });
}
