import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  colourCurveSchema,
  createColourCurves,
  createHslSettings,
  CURVE_CHANNELS,
  evaluateColourCurve,
  HSL_BANDS,
  type ColourCurvePoint,
  type CurveChannel,
  type HslBand,
} from '../shared/advanced-colour.js';
import { colourSchema, type ColourSettings } from '../shared/colour.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';
import './advanced-colour.css';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { NumberField } from './NumberField.js';
import type { DraftPreview } from './Timeline.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  layer: VideoLayer;
  frame: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onPause: () => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
}
const HSL_CONTROLS = [
  { key: 'hue', label: 'Hue °', min: -30, max: 30, step: 0.1 },
  { key: 'saturation', label: 'Saturation offset', min: -1, max: 1, step: 0.01 },
  { key: 'lightness', label: 'Lightness offset', min: -0.5, max: 0.5, step: 0.005 },
] as const;

function isHistoryShortcut(event: KeyboardEvent<HTMLButtonElement>): boolean {
  return (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
}

/** Preserve local point identity through a single input move and Undo; never save IDs. */
function useCurveSelection(points: readonly ColourCurvePoint[]) {
  const [stored, setStored] = useState(() => ({
    inputs: points.map((point) => point.x),
    ids: points.map((point) => `point-${point.x}`),
    selected: 0,
    identity: 0,
    next: points.length,
  }));
  const inputs = points.map((point) => point.x);
  let state = stored;
  if (inputs.length !== stored.inputs.length || inputs.some((input, index) => input !== stored.inputs[index])) {
    const removed = stored.inputs.filter((input) => !inputs.includes(input));
    const added = inputs.filter((input) => !stored.inputs.includes(input));
    let selected = stored.selected;
    let identity = stored.identity;
    if (removed.length === 1 && added.length === 1 && selected === removed[0]) selected = added[0]!;
    else if (added.length === 1 && removed.length === 0) {
      selected = added[0]!;
      identity++;
    } else if (!inputs.includes(selected)) {
      selected = inputs[0]!;
      identity++;
    }
    let next = stored.next;
    const ids = inputs.map((input) => {
      const previous = stored.inputs.indexOf(input);
      if (previous >= 0) return stored.ids[previous]!;
      if (removed.length === 1 && added.length === 1) return stored.ids[stored.inputs.indexOf(removed[0]!)]!;
      return `added-${next++}`;
    });
    state = { inputs, ids, selected, identity, next };
    setStored(state);
  }
  return {
    ...state,
    select: (selected: number) =>
      setStored((current) => ({
        ...current,
        selected,
        identity: current.identity + Number(current.selected !== selected),
      })),
  };
}

interface Capture {
  pointer: number;
  element: HTMLButtonElement;
  project: ProjectDocument;
  colour: ColourSettings;
  frame: number;
  index: number;
  origin: ColourCurvePoint;
  x: number;
  y: number;
  width: number;
  height: number;
  points: ColourCurvePoint[];
  error: string | null;
  moved: boolean;
}

function CurveEditor({
  project,
  layer,
  frame,
  disabled,
  onEdit,
  onPause,
  onPreview,
  channel,
}: Readonly<Props & { channel: CurveChannel }>) {
  const points = layer.colour.curves[channel];
  const selection = useCurveSelection(points);
  const index = points.findIndex((point) => point.x === selection.selected);
  const selected = points[index]!;
  const endpoint = index === 0 || index === points.length - 1;
  const capture = useRef<Capture | null>(null);
  const [draft, setDraft] = useState<ColourCurvePoint[] | null>(null);
  const [error, setError] = useState('');
  const latest = useRef({ onPreview, onEdit, layer });
  latest.current = { onPreview, onEdit, layer };
  const clear = (): Capture | null => {
    const active = capture.current;
    if (!active) return null;
    capture.current = null;
    setDraft(null);
    setError('');
    latest.current.onPreview(null, active.frame);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    return active;
  };
  useEffect(() => {
    const cancel = (): void => {
      clear();
      setError('');
    };
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !capture.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      clear();
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
    };
  }, [channel, layer.id, project.id]);
  const unavailable = disabled || draft !== null;
  const context = `${project.id}:${layer.id}:${channel}:${selection.identity}`;
  const validate = (next: ColourCurvePoint[]): string | null => {
    const result = colourCurveSchema.safeParse(next);
    return result.success
      ? null
      : 'Curve inputs must be unique and ascending from 0 to 1, with 2–16 points and outputs in 0–1.';
  };
  const replace = (at: number, changes: Partial<ColourCurvePoint>): ColourCurvePoint[] =>
    points.map((point, position) => (position === at ? { ...point, ...changes } : point));
  const change = (next: ColourCurvePoint[]): void => {
    if (unavailable) return;
    const message = validate(next);
    if (message) {
      setError(message);
      return;
    }
    onEdit({
      type: 'colour',
      layerId: layer.id,
      colour: { ...layer.colour, curves: { ...layer.colour.curves, [channel]: next } },
    });
    setError('');
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, at: number): void => {
    if (unavailable || capture.current || event.button !== 0 || !event.isPrimary) return;
    const box = event.currentTarget.closest('.colour-curve-plot')?.getBoundingClientRect();
    if (!box?.width || !box.height) return;
    event.preventDefault();
    event.stopPropagation();
    selection.select(points[at]!.x);
    event.currentTarget.focus({ preventScroll: true });
    capture.current = {
      pointer: event.pointerId,
      element: event.currentTarget,
      project,
      colour: layer.colour,
      frame,
      index: at,
      origin: points[at]!,
      x: event.clientX,
      y: event.clientY,
      width: box.width,
      height: box.height,
      points,
      error: null,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onPause();
    setError('');
    setDraft(points);
    onPreview({ document: project, frame });
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = capture.current;
    if (active?.pointer !== event.pointerId) return;
    event.stopPropagation();
    const dx = event.clientX - active.x,
      dy = event.clientY - active.y;
    if (!active.moved && Math.hypot(dx, dy) < 3) return;
    active.moved = true;
    const x =
      active.index === 0 || active.index === active.colour.curves[channel].length - 1
        ? active.origin.x
        : active.origin.x + dx / active.width;
    const y = active.origin.y - dy / active.height;
    active.points = active.colour.curves[channel].map((point, position) =>
      position === active.index ? { x, y } : point,
    );
    active.error = validate(active.points);
    setDraft(active.points);
    setError(active.error ?? '');
    const command: EditCommand = {
      type: 'colour',
      layerId: layer.id,
      colour: { ...active.colour, curves: { ...active.colour.curves, [channel]: active.points } },
    };
    onPreview({ document: active.error ? active.project : applyCommand(active.project, command), frame: active.frame });
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    if (capture.current?.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    move(event);
    const active = clear()!;
    if (active.error) {
      setError(active.error);
      return;
    }
    if (active.moved)
      latest.current.onEdit({
        type: 'colour',
        layerId: latest.current.layer.id,
        colour: { ...active.colour, curves: { ...active.colour.curves, [channel]: active.points } },
      });
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    // Session Undo/Redo remains available without leaking ordinary timeline edits.
    if (isHistoryShortcut(event)) return;
    event.stopPropagation();
    if (unavailable || event.ctrlKey || event.metaKey || event.altKey) return;
    const point = points[at]!;
    const delta = event.shiftKey ? 0.1 : 0.01;
    const interior = at > 0 && at < points.length - 1;
    let next: ColourCurvePoint[] | null = null;
    if (event.key === 'ArrowLeft' && interior) next = replace(at, { x: point.x - delta });
    if (event.key === 'ArrowRight' && interior) next = replace(at, { x: point.x + delta });
    if (event.key === 'ArrowUp') next = replace(at, { y: point.y + delta });
    if (event.key === 'ArrowDown') next = replace(at, { y: point.y - delta });
    if ((event.key === 'Delete' || event.key === 'Backspace') && interior)
      next = points.filter((_, position) => position !== at);
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(event.key))
      event.preventDefault();
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selection.select(point.x);
    }
    if (next) change(next);
  };
  const shown = draft ?? points;
  const add = (): void => {
    let largest = 0;
    for (let at = 1; at < points.length - 1; at++)
      if (points[at + 1]!.x - points[at]!.x > points[largest + 1]!.x - points[largest]!.x) largest = at;
    const x = (points[largest]!.x + points[largest + 1]!.x) / 2;
    change([...points.slice(0, largest + 1), { x, y: evaluateColourCurve(points, x) }, ...points.slice(largest + 1)]);
  };
  return (
    <section className="colour-curve-editor" aria-label={`${channel} colour curve editor`} data-dirty={draft !== null}>
      <div className={`colour-curve-plot${draft && error ? ' invalid' : ''}`}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${channel} encoded colour curve`}>
          <path d="M0 100L100 0M25 0V100M50 0V100M75 0V100M0 25H100M0 50H100M0 75H100" className="colour-curve-grid" />
          <polyline points={shown.map((point) => `${point.x * 100},${(1 - point.y) * 100}`).join(' ')} />
        </svg>
        {shown.map((point, at) => (
          <button
            key={selection.ids[at]}
            type="button"
            className="colour-curve-point"
            style={{ left: `${point.x * 100}%`, top: `${(1 - point.y) * 100}%` }}
            aria-label={`Colour curve point ${at + 1}`}
            aria-pressed={index === at}
            aria-disabled={disabled && !capture.current}
            title={`Input ${point.x}, output ${point.y}. Arrows edit; Shift moves 0.1; Enter selects.`}
            onClick={() => {
              if (!unavailable) selection.select(points[at]!.x);
            }}
            onKeyDown={(event) => keyboard(event, at)}
            onPointerDown={(event) => begin(event, at)}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={() => clear()}
            onLostPointerCapture={() => clear()}
          />
        ))}
      </div>
      <div className="advanced-colour-tools">
        <select
          aria-label="Selected colour curve point"
          value={index}
          disabled={unavailable}
          onChange={(event) => selection.select(points[Number(event.currentTarget.value)]!.x)}
        >
          {points.map((point, at) => (
            <option key={selection.ids[at]} value={at}>
              Point {at + 1} · {point.x}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label="Add colour curve point"
          disabled={unavailable || points.length >= 16}
          onClick={add}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete colour curve point"
          disabled={unavailable || endpoint}
          onClick={() => change(points.filter((_, at) => at !== index))}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="colour-curve-fields">
        <label>
          Input 0–1
          <NumberField
            aria-label="Colour curve input"
            value={selected.x}
            min={0}
            max={1}
            resetKey={context}
            disabled={unavailable || endpoint}
            {...(endpoint ? { hint: 'Endpoint input is fixed.' } : {})}
            validate={(x) => validate(replace(index, { x }))}
            onCommit={(x) => change(replace(index, { x }))}
          />
        </label>
        <label>
          Output 0–1
          <NumberField
            aria-label="Colour curve output"
            value={selected.y}
            min={0}
            max={1}
            resetKey={context}
            disabled={unavailable}
            onCommit={(y) => change(replace(index, { y }))}
          />
        </label>
      </div>
      <div className="advanced-colour-tools">
        <button
          type="button"
          className="text-button"
          disabled={unavailable || index === 0}
          aria-label="Previous colour curve point"
          onClick={() => selection.select(points[index - 1]!.x)}
        >
          <Icon name="back" size={14} />
          Previous
        </button>
        <button
          type="button"
          className="text-button"
          disabled={unavailable || index === points.length - 1}
          aria-label="Next colour curve point"
          onClick={() => selection.select(points[index + 1]!.x)}
        >
          Next
          <Icon name="forward" size={14} />
        </button>
      </div>
      {error && (
        <p role="alert" className="number-field-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function AdvancedColour(props: Readonly<Props>) {
  const { layer, project, disabled, onEdit } = props;
  const [band, setBand] = useState<HslBand>('red');
  const [channel, setChannel] = useState<CurveChannel>('master');
  const commit = (colour: ColourSettings): void => {
    if (!disabled) onEdit({ type: 'colour', layerId: layer.id, colour: colourSchema.parse(colour) });
  };
  const context = `${project.id}:${layer.id}:${band}`;
  return (
    <div className="advanced-colour">
      <details>
        <summary>
          HSL ranges <small>Static row</small>
        </summary>
        <div className="advanced-colour-tools">
          <label>
            <span>Range</span>
            <select
              aria-label="HSL range"
              value={band}
              disabled={disabled}
              onChange={(event) => setBand(event.currentTarget.value as HslBand)}
            >
              {HSL_BANDS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <HelpPopover label="HSL ranges">
            <p>
              Static colour for every clip on this row, including when scalar colour is animated. Hue is degrees;
              saturation is a multiplier offset; lightness is an encoded offset. Circular neighbouring ranges blend
              smoothly. Greys are protected. This is SDR, not white balance.
            </p>
          </HelpPopover>
        </div>
        {HSL_CONTROLS.map((control) => (
          <div className="advanced-hsl-control" key={control.key}>
            <span>{control.label}</span>
            <ValueControl
              aria-label={`HSL ${control.key}`}
              value={layer.colour.hsl[band][control.key]}
              min={control.min}
              max={control.max}
              step={control.step}
              resetKey={context}
              disabled={disabled}
              onCommit={(value) =>
                commit({
                  ...layer.colour,
                  hsl: { ...layer.colour.hsl, [band]: { ...layer.colour.hsl[band], [control.key]: value } },
                })
              }
            />
          </div>
        ))}
        <div className="advanced-colour-tools">
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label={`Reset ${band} HSL range`}
            onClick={() =>
              commit({ ...layer.colour, hsl: { ...layer.colour.hsl, [band]: { hue: 0, saturation: 0, lightness: 0 } } })
            }
          >
            <Icon name="reset" size={13} />
            Reset {band}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label="Reset all HSL ranges"
            onClick={() => commit({ ...layer.colour, hsl: createHslSettings() })}
          >
            Reset all
          </button>
        </div>
      </details>
      <details>
        <summary>
          Colour curves <small>Static row</small>
        </summary>
        <div className="advanced-colour-tools">
          <label>
            <span>Channel</span>
            <select
              aria-label="Colour curve channel"
              disabled={disabled}
              value={channel}
              onChange={(event) => setChannel(event.currentTarget.value as CurveChannel)}
            >
              {CURVE_CHANNELS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <HelpPopover label="Colour curves">
            <p>
              Encoded input/output 0–1, after scalar grading and HSL. Master runs before the RGB channels. Endpoints
              lock input only. Up to sixteen points; outputs may rise or fall. Drag edits both coordinates, committing
              only on release; Escape cancels. Arrows edit by 0.01, Shift by 0.1. Exact fields retain precision. Native
              export evaluates advanced colour directly, including sharp knees. Final video encoding still quantises the
              result.
            </p>
          </HelpPopover>
        </div>
        <CurveEditor key={`${project.id}:${layer.id}:${channel}`} {...props} channel={channel} />
        <div className="advanced-colour-tools">
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label={`Reset ${channel} curve`}
            onClick={() =>
              commit({ ...layer.colour, curves: { ...layer.colour.curves, [channel]: createColourCurves()[channel] } })
            }
          >
            <Icon name="reset" size={13} />
            Reset {channel}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label="Reset all colour curves"
            onClick={() => commit({ ...layer.colour, curves: createColourCurves() })}
          >
            Reset all
          </button>
        </div>
      </details>
    </div>
  );
}
