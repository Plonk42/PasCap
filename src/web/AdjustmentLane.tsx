import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { EditCommand } from '../shared/commands.js';
import { GRADE_SETTINGS, type Adjustment } from '../shared/grade.js';
import { KEYFRAME_SETTINGS } from '../shared/keyframes.js';
import type { ProjectDocument } from '../shared/model.js';
import { snapFrame, type BeatSnap } from '../shared/snap.js';
import { formatTimecode } from '../shared/timing.js';
import {
  adjustmentKeyframeTargets,
  adjustmentLabel,
  planAdjustmentCreation,
  planAdjustmentGesture,
  type AdjustmentGestureKind,
  type AdjustmentKeyframeTarget,
} from './adjustment-ui.js';
import './adjustment-lane.css';
import { Icon } from './icons.js';
import { KeyframeMarkers, type KeyframeSlide } from './keyframe-slide.js';
import { editorShortcut } from './shortcuts.js';
import { placementSnapPoints, snapPlacement } from './timeline-placement.js';
import type { DraftPreview } from './Timeline.js';

export interface AdjustmentGesture {
  id: string;
  /** Drawing a new adjustment rather than moving or trimming one. */
  creating: boolean;
  document: ProjectDocument;
  /** The range drawn, valid or not. */
  range: Pick<Adjustment, 'start' | 'duration'>;
  leading: number;
  width: number;
  guide: number | null;
  error: string;
}

interface Props {
  project: ProjectDocument;
  /** The document drawn: another gesture's draft, else the project. */
  display: ProjectDocument;
  leading: number;
  scale: number;
  width: number;
  viewport: RefObject<HTMLDivElement | null>;
  frame: number;
  /** Playable duration: a click on the empty track seeks within it. */
  duration: number;
  snapping: boolean;
  beats: BeatSnap;
  disabled: boolean;
  selectedId: string | null;
  /** The adjustment grading the selected clip at the playhead. */
  gradingId: string | null;
  keyframes: KeyframeSlide<AdjustmentKeyframeTarget>;
  keyframesBlocked: () => boolean;
  onSelect: (id: string) => void;
  onSeek: (frame: number) => void;
  onPause: () => void;
  onEdit: (command: EditCommand) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onGesture: (gesture: AdjustmentGesture | null) => void;
  onError: (message: string) => void;
}

interface LanePlan {
  range: Pick<Adjustment, 'start' | 'duration'>;
  document: ProjectDocument;
  command: EditCommand | null;
  error: string;
}

interface Drag {
  pointerId: number;
  element: HTMLElement;
  base: ProjectDocument;
  /** For a drawing, the new adjustment's ID and the frame where it was pressed. */
  item: Pick<Adjustment, 'id' | 'start' | 'duration'>;
  kind: AdjustmentGestureKind | 'draw';
  x: number;
  pointerX: number;
  scroll: number;
  scale: number;
  leading: number;
  width: number;
  frame: number;
  alt: boolean;
  moved: boolean;
  targets: number[];
  plan: LanePlan;
  guide: number | null;
}

interface Candidate {
  id: string;
  creating: boolean;
  plan: LanePlan;
  guide: number | null;
}

const KEY_STEP = { ArrowLeft: -1, ArrowRight: 1 } as const;

/** The draft after `delta` frames of pointer travel, snapping the edges that move. */
function planDrag(active: Drag, delta: number, snap: boolean): { plan: LanePlan; guide: number | null } {
  const tolerance = 8 / active.scale;
  const { item, kind, targets, base } = active;
  if (kind === 'draw') {
    const end = snap ? snapFrame(item.start + delta, targets, tolerance) : item.start + delta;
    const guide = end === item.start + delta ? null : end;
    return { plan: planAdjustmentCreation(base, item.id, item.start, end), guide };
  }
  if (!snap) return { plan: planAdjustmentGesture(base, item.id, kind, delta), guide: null };
  if (kind === 'move') {
    const snapped = snapPlacement(item.start + delta, item.duration, targets, tolerance);
    return { plan: planAdjustmentGesture(base, item.id, kind, snapped.start - item.start), guide: snapped.guide };
  }
  const edge = kind === 'out' ? item.start + item.duration : item.start;
  const snapped = snapFrame(edge + delta, targets, tolerance);
  return {
    plan: planAdjustmentGesture(base, item.id, kind, snapped - edge),
    guide: snapped === edge + delta ? null : snapped,
  };
}

function keyframeView(item: Adjustment, origin: number, frame: number, at: number | null, scale: number) {
  const point = item.keyframes.find((key) => key.frame === origin);
  const settings = point
    ? GRADE_SETTINGS.filter((setting) => point.values[setting] !== null)
        .map((setting) => KEYFRAME_SETTINGS.find((definition) => definition.key === setting)!.label)
        .join(' · ')
    : '';
  const projectFrame = at ?? item.start + frame;
  return {
    className: `timeline-adjustment-key${point?.reset ? ' reset' : ''}`,
    'data-adjustment-keyframe': frame,
    'aria-label': `Adjustment keyframe at ${formatTimecode(projectFrame)}, adjustment ${adjustmentLabel(item)}${point?.reset ? ' (default)' : ''}`,
    title: `Adjustment keyframe · ${formatTimecode(projectFrame)} · ${point?.reset ? 'Default keyframe: settings return to their defaults here' : settings} · Drag to move; Arrow keys: 1 frame, Shift: 10; Delete removes. Alt bypasses snapping.`,
    style: { left: Math.max(0, (projectFrame - item.start) * scale - 8) },
    children: point?.reset ? (
      <Icon name="default-key" size={13} />
    ) : (
      <span aria-hidden="true" className="keyframe-glyph diamond">
        ◆
      </span>
    ),
  };
}

/** The project's adjustment track, pinned under the ruler: each item is drawn and announced by its range. */
export function AdjustmentLane(props: Readonly<Props>) {
  const { project, display, leading, scale, disabled } = props;
  const latest = useRef(props);
  latest.current = props;
  const drag = useRef<Drag | null>(null);
  const animation = useRef(0);
  const [candidate, setCandidate] = useState<Candidate | null>(null);

  const clear = useCallback((restoreScroll: boolean): Drag | null => {
    const active = drag.current;
    if (!active) return null;
    drag.current = null;
    cancelAnimationFrame(animation.current);
    animation.current = 0;
    const { viewport, onGesture, onPreview } = latest.current;
    if (restoreScroll && viewport.current) viewport.current.scrollLeft = active.scroll;
    setCandidate(null);
    onGesture(null);
    if (active.moved) onPreview(null, active.frame);
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  const cancel = useCallback((): void => {
    clear(true);
  }, [clear]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      clear(true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
    };
  }, [cancel, clear]);
  useEffect(() => {
    if (drag.current && drag.current.base !== project) cancel();
  }, [project, cancel]);

  const update = (): void => {
    const active = drag.current;
    const viewport = latest.current.viewport.current;
    if (!active || !viewport) return;
    const travel = active.pointerX - active.x + viewport.scrollLeft - active.scroll;
    if (!active.moved && Math.abs(travel) < 3) return;
    active.moved = true;
    const delta = Math.round(travel / active.scale);
    const { plan, guide } = planDrag(active, delta, latest.current.snapping && !active.alt);
    active.plan = plan;
    active.guide = plan.error ? null : guide;
    const creating = active.kind === 'draw';
    setCandidate({ id: active.item.id, creating, plan, guide: active.guide });
    latest.current.onGesture({
      id: active.item.id,
      creating,
      document: plan.document,
      range: plan.range,
      leading: active.leading,
      width: active.width,
      guide: active.guide,
      error: plan.error,
    });
    latest.current.onPreview({ document: plan.document, frame: active.frame });
  };
  const latestUpdate = useRef(update);
  latestUpdate.current = update;
  const autoScroll = (): void => {
    const active = drag.current;
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
  const begin = (event: PointerEvent<HTMLElement>, item: Drag['item'], kind: Drag['kind'], targets: number[]): void => {
    const { viewport, frame, width, onPause } = latest.current;
    onPause();
    drag.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      base: project,
      item,
      kind,
      x: event.clientX,
      pointerX: event.clientX,
      scroll: viewport.current!.scrollLeft,
      scale,
      leading,
      width,
      frame,
      alt: event.altKey,
      moved: false,
      targets,
      plan: { range: item, document: project, command: null, error: '' },
      guide: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    animation.current = requestAnimationFrame(autoScroll);
  };
  const start = (event: PointerEvent<HTMLButtonElement>, item: Adjustment, kind: AdjustmentGestureKind): void => {
    const { viewport, frame, beats } = latest.current;
    if (event.button !== 0 || disabled || drag.current || !viewport.current) return;
    // Ctrl/Cmd-click is a selection, never a drag.
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    begin(event, item, kind, placementSnapPoints(project, item.id, frame, beats));
  };
  /** Pressing the empty track draws a new adjustment from that frame. */
  const draw = (event: PointerEvent<HTMLDivElement>): void => {
    const { viewport, frame, beats, snapping } = latest.current;
    if (event.target !== event.currentTarget || event.button !== 0 || disabled || drag.current || !viewport.current)
      return;
    event.preventDefault();
    const targets = placementSnapPoints(project, null, frame, beats);
    const pressed = Math.max(
      0,
      Math.round((event.clientX - event.currentTarget.getBoundingClientRect().left - leading) / scale),
    );
    const anchor = snapping && !event.altKey ? snapFrame(pressed, targets, 8 / scale) : pressed;
    begin(event, { id: crypto.randomUUID(), start: anchor, duration: 0 }, 'draw', targets);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const active = drag.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    active.alt = event.altKey;
    update();
  };
  const finish = (event: PointerEvent<HTMLElement>): void => {
    const active = drag.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    active.alt = event.altKey;
    update();
    clear(false);
    const { onSelect, onSeek, onEdit, onError, duration } = latest.current;
    if (!active.moved && active.kind === 'draw') {
      // A click on the empty track only moves the playhead.
      if (duration) onSeek(Math.min(active.item.start, duration - 1));
      return;
    }
    if (!active.moved) {
      // A click selects the adjustment and puts the playhead where it was clicked.
      onSelect(active.item.id);
      const bounds = active.element.closest('.adjustment-item')!.getBoundingClientRect();
      const offset = Math.floor((event.clientX - bounds.left) / active.scale);
      onSeek(active.item.start + Math.max(0, Math.min(active.item.duration - 1, offset)));
      return;
    }
    if (active.plan.error) {
      onError(active.plan.error);
      return;
    }
    if (active.plan.command) onEdit(active.plan.command);
    onSelect(active.item.id);
  };
  const handlers = { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, item: Adjustment, kind: AdjustmentGestureKind): void => {
    // Undo/Redo still apply; every other key stays with the adjustment.
    const shortcut = editorShortcut(event)?.type;
    if (shortcut !== 'undo' && shortcut !== 'redo') event.stopPropagation();
    const { onSelect, onEdit, onError } = latest.current;
    if (disabled || drag.current || event.nativeEvent.isComposing) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onEdit({ type: 'adjustment-remove', adjustmentId: item.id });
      latest.current.viewport.current?.closest<HTMLElement>('.timeline-panel')?.focus({ preventScroll: true });
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onSelect(item.id);
    const plan = planAdjustmentGesture(project, item.id, kind, KEY_STEP[event.key] * (event.shiftKey ? 10 : 1));
    if (plan.error) onError(plan.error);
    else if (plan.command) onEdit(plan.command);
  };
  /** Enter/Space on the body: the pointer case was handled by its gesture. */
  const activate = (event: MouseEvent<HTMLButtonElement>, item: Adjustment): void => {
    if (event.detail !== 0 || disabled) return;
    latest.current.onSelect(item.id);
    const { frame } = latest.current;
    if (frame < item.start || frame >= item.start + item.duration) latest.current.onSeek(item.start);
  };

  // The dragged adjustment follows the pointer, even where it cannot go.
  const items = display.adjustments.map((item) =>
    candidate?.id === item.id ? { ...item, ...candidate.plan.range } : item,
  );
  const drawn = candidate?.creating ? candidate : null;
  const guide = candidate?.guide ?? null;
  return (
    <div
      className={`adjustment-lane${drawn ? ' drawing' : ''}`}
      data-adjustment-lane=""
      style={{ width: props.width }}
      title="Adjustment track · drag across an empty stretch to draw a new adjustment; Alt bypasses snapping"
      onPointerDown={draw}
      {...handlers}
    >
      {drawn && (
        <div
          className={`adjustment-item drawing${drawn.plan.error ? ' invalid' : ''}`}
          data-adjustment-draft=""
          data-adjustment-start={drawn.plan.range.start}
          data-adjustment-duration={drawn.plan.range.duration}
          data-adjustment-valid={!drawn.plan.error}
          style={{ left: leading + drawn.plan.range.start * scale, width: drawn.plan.range.duration * scale }}
        >
          <span className="adjustment-label">{adjustmentLabel(drawn.plan.range)}</span>
        </div>
      )}
      {items.map((item) => {
        const label = adjustmentLabel(item);
        const selected = item.id === props.selectedId;
        const grading = !selected && item.id === props.gradingId;
        const invalid = candidate?.id === item.id && candidate.plan.error !== '';
        const classes = ['adjustment-item'];
        if (selected) classes.push('selected');
        if (grading) classes.push('grading');
        if (invalid) classes.push('invalid');
        if (candidate?.id === item.id) classes.push('moving');
        const dragging = drag.current?.item.id === item.id;
        return (
          <div
            key={item.id}
            className={classes.join(' ')}
            data-adjustment-id={item.id}
            data-adjustment-start={item.start}
            data-adjustment-duration={item.duration}
            data-adjustment-valid={!invalid}
            title={invalid ? candidate.plan.error : undefined}
            style={{ left: (drag.current?.leading ?? leading) + item.start * scale, width: item.duration * scale }}
          >
            <button
              type="button"
              className="adjustment-body"
              aria-label={`Adjustment ${label}${grading ? ' (grades the selected clip)' : ''}`}
              aria-pressed={selected}
              disabled={disabled && !dragging}
              title={`Adjustment ${label} · grades every track here${grading ? ', including the selected clip' : ''} · Click to edit its Colour; drag to move it with its keyframes; Arrow keys: 1 frame, Shift: 10; Delete removes. Alt bypasses snapping.`}
              onPointerDown={(event) => start(event, item, 'move')}
              onClick={(event) => activate(event, item)}
              onKeyDown={(event) => keyboard(event, item, 'move')}
              {...handlers}
            >
              <span className="adjustment-label">{label}</span>
            </button>
            <div className="adjustment-keyframes">
              <KeyframeMarkers
                slide={props.keyframes}
                targets={candidate?.id === item.id ? [] : adjustmentKeyframeTargets(item)}
                blocked={props.keyframesBlocked}
                view={({ origin }, state) => keyframeView(item, origin, state.frame, state.at, scale)}
              />
            </div>
            {(['in', 'out'] as const).map((edge) => (
              <button
                key={edge}
                type="button"
                className={`trim-handle ${edge}`}
                aria-label={`Trim ${edge === 'in' ? 'start' : 'end'} of adjustment ${label}`}
                title={`Trim the adjustment's ${edge === 'in' ? 'start' : 'end'}; its keyframes keep their frames. Arrow keys: one frame; Shift: ten.`}
                disabled={disabled && !dragging}
                onPointerDown={(event) => start(event, item, edge)}
                onKeyDown={(event) => keyboard(event, item, edge)}
                onClick={(event) => event.stopPropagation()}
                {...handlers}
              >
                <span />
              </button>
            ))}
          </div>
        );
      })}
      {guide !== null && <div className="adjustment-guide" style={{ left: leading + guide * scale }} />}
      <div className="adjustment-playhead" style={{ left: leading + props.frame * scale }} />
    </div>
  );
}
