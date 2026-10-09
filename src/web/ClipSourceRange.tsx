import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import type { TrimEdge } from '../shared/source-range.js';
import { formatTimecode } from '../shared/timing.js';
import { clipSourceBoundary, planClipSourceRange, type ClipSourceRangePlan } from './clip-source-range.js';
import { FrameField } from './FrameField.js';
import { Icon } from './icons.js';
import type { DraftPreview } from './Timeline.js';
import './clip-source-range.css';

interface Props {
  project: ProjectDocument;
  clip: VideoClip;
  count: number;
  frame: number;
  disabled: boolean;
  resetKey: string;
  id: string;
  onEdit: (command: EditCommand) => void;
  onPause: () => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
}
interface Drag {
  pointer: number;
  element: HTMLButtonElement;
  project: ProjectDocument;
  clip: VideoClip;
  edge: TrimEdge;
  count: number;
  x: number;
  width: number;
  restoreFrame: number;
  plan: ClipSourceRangePlan;
}

export function ClipSourceRange(props: Readonly<Props>) {
  const latest = useRef(props);
  latest.current = props;
  const bar = useRef<HTMLDivElement>(null);
  const session = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<ClipSourceRangePlan | null>(null);
  const [error, setError] = useState('');
  const clear = useCallback((): Drag | null => {
    const active = session.current;
    if (!active) return null;
    session.current = null;
    setDraft(null);
    latest.current.onPreview(null, active.restoreFrame);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    return active;
  }, []);
  const cancel = useCallback(() => {
    clear();
    setError('');
  }, [clear]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !session.current || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    globalThis.addEventListener('keydown', escape, true);
    globalThis.addEventListener('blur', cancel);
    return () => {
      clear();
      globalThis.removeEventListener('keydown', escape, true);
      globalThis.removeEventListener('blur', cancel);
    };
  }, [clear, cancel]);
  const begin = (event: PointerEvent<HTMLButtonElement>, edge: TrimEdge): void => {
    const current = latest.current;
    const width = bar.current?.getBoundingClientRect().width;
    if (current.disabled || session.current || event.button !== 0 || !event.isPrimary || !width) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const boundary = edge === 'in' ? current.clip.sourceIn : current.clip.sourceOut;
    const plan = planClipSourceRange(current.project, current.clip, edge, boundary, current.count, current.frame);
    session.current = {
      pointer: event.pointerId,
      element: event.currentTarget,
      project: current.project,
      clip: current.clip,
      edge,
      count: current.count,
      x: event.clientX,
      width,
      restoreFrame: current.frame,
      plan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    current.onPause();
    setError('');
    setDraft(plan);
    current.onPreview({ document: plan.document, frame: plan.frame });
  };
  const update = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (active?.pointer !== event.pointerId) return;
    const boundary = clipSourceBoundary(active.clip, active.edge, active.count, event.clientX - active.x, active.width);
    active.plan = planClipSourceRange(
      active.project,
      active.clip,
      active.edge,
      boundary,
      active.count,
      active.restoreFrame,
    );
    setDraft(active.plan);
    latest.current.onPreview({ document: active.plan.document, frame: active.plan.frame });
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    if (session.current?.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    update(event);
    const active = clear()!;
    if (active.plan.error) {
      setError(active.plan.error);
      return;
    }
    const { command } = active.plan;
    if (command.sourceIn !== active.clip.sourceIn || command.sourceOut !== active.clip.sourceOut)
      latest.current.onEdit(command);
  };
  const commit = (edge: TrimEdge, boundary: number): void => {
    if (props.disabled || session.current) return;
    const plan = planClipSourceRange(props.project, props.clip, edge, boundary, props.count, props.frame);
    setError(plan.error);
    if (
      !plan.error &&
      (plan.command.sourceIn !== props.clip.sourceIn || plan.command.sourceOut !== props.clip.sourceOut)
    ) {
      props.onPause();
      props.onEdit(plan.command);
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, edge: TrimEdge): void => {
    if (props.disabled || session.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const boundary = edge === 'in' ? props.clip.sourceIn : props.clip.sourceOut;
    const step = event.shiftKey ? 10 : 1;
    const positions: Record<string, number> = {
      ArrowLeft: boundary - step,
      ArrowRight: boundary + step,
      Home: edge === 'in' ? 0 : props.clip.sourceIn + 1,
      End: edge === 'out' ? props.count : props.clip.sourceOut - 1,
    };
    const next = positions[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    commit(edge, next);
  };
  const selected = draft?.command ?? props.clip;
  const status = draft?.error || error;
  const errorId = `${props.id}-source-error`;
  return (
    <section className="source-range clip-source-range" aria-label="Range" data-dirty={draft !== null}>
      <div
        ref={bar}
        className="clip-source-bar"
        data-source-in={selected.sourceIn}
        data-source-out={selected.sourceOut}
        data-range-draft={draft !== null}
        data-invalid={Boolean(status)}
      >
        <span
          className="clip-source-omitted before"
          style={{ width: `${(selected.sourceIn / props.count) * 100}%` }}
          aria-hidden="true"
        />
        <span
          className="clip-source-omitted after"
          style={{ left: `${(selected.sourceOut / props.count) * 100}%` }}
          aria-hidden="true"
        />
        <span
          className="clip-source-selected"
          style={{
            left: `${(selected.sourceIn / props.count) * 100}%`,
            width: `${((selected.sourceOut - selected.sourceIn) / props.count) * 100}%`,
          }}
          aria-hidden="true"
        />
        {(['in', 'out'] as const).map((edge) => {
          const value = edge === 'in' ? selected.sourceIn : selected.sourceOut;
          return (
            <button
              key={edge}
              type="button"
              role="slider"
              className={`clip-source-handle ${edge}`}
              aria-label={`Trim clip source ${edge === 'in' ? 'start' : 'end'}`}
              disabled={props.disabled && draft === null}
              aria-valuemin={edge === 'in' ? 0 : selected.sourceIn + 1}
              aria-valuemax={edge === 'in' ? selected.sourceOut - 1 : props.count}
              aria-valuenow={value}
              aria-valuetext={`${formatTimecode(value)}${edge === 'out' ? ', OUT exclusive' : ''}`}
              aria-describedby={`${props.id}-source-help`}
              aria-invalid={Boolean(status)}
              title="Drag to trim or restore. Arrows: one source frame; Shift: ten; Home/End: source limits."
              style={{ left: `${(value / props.count) * 100}%` }}
              onPointerDown={(event) => begin(event, edge)}
              onPointerMove={update}
              onPointerUp={finish}
              onPointerCancel={cancel}
              onLostPointerCapture={() => {
                if (session.current) cancel();
              }}
              onKeyDown={(event) => keyboard(event, edge)}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <span />
            </button>
          );
        })}
      </div>
      <div className="range-fields clip-source-fields">
        {(['in', 'out'] as const).map((edge) => (
          <label key={edge} htmlFor={`${props.id}-${edge}`}>
            {edge.toUpperCase()}
            <FrameField
              id={`${props.id}-${edge}`}
              aria-label={`Source ${edge.toUpperCase()} frame`}
              aria-describedby={`${props.id}-source-help`}
              min={edge === 'in' ? 0 : props.clip.sourceIn + 1}
              max={edge === 'in' ? props.clip.sourceOut - 1 : props.count}
              value={edge === 'in' ? selected.sourceIn : selected.sourceOut}
              disabled={props.disabled || draft !== null}
              resetKey={props.resetKey}
              validate={(boundary) =>
                planClipSourceRange(props.project, props.clip, edge, boundary, props.count, props.frame).error || null
              }
              onCommit={(boundary) => commit(edge, boundary)}
            />
          </label>
        ))}
      </div>
      {status && (
        <p id={errorId} className="number-field-error" role="alert">
          {status}
        </p>
      )}
      <button
        className="text-button restore-range"
        disabled={props.disabled || (props.clip.sourceIn === 0 && props.clip.sourceOut === props.count)}
        onClick={() => {
          setError('');
          props.onEdit({ type: 'trim', clipId: props.clip.id, sourceIn: 0, sourceOut: props.count });
        }}
      >
        <Icon name="reset" size={13} /> Restore full recording
      </button>
    </section>
  );
}
