import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import {
  colorCurveSchema,
  colorCurveSlopes,
  createColorCurves,
  createHslSettings,
  CURVE_CHANNELS,
  evaluateColorCurve,
  HSL_BANDS,
  HSL_CENTERS,
  isIdentityCurve,
  isNeutralHsl,
  type ColorCurvePoint,
  type CurveChannel,
  type HslBand,
} from '../shared/advanced-color.js';
import { colorSchema, type ColorSettings } from '../shared/color.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import './advanced-color.css';
import { colorTarget, ownerNoun, type ColorOwner } from './color-owner.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { livePreview } from './live-preview.js';
import { NumberField } from './NumberField.js';
import { ResetLabel, resetBlocked } from './SettingValueControl.js';
import type { DraftPreview } from './Timeline.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  layer: ColorOwner;
  frame: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onPause: () => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
}
const HSL_CONTROLS = [
  { key: 'hue', label: 'Hue °', min: -30, max: 30, step: 0.1 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01 },
  { key: 'lightness', label: 'Lightness', min: -0.5, max: 0.5, step: 0.005 },
] as const;

/** Each HSL slider's track shows its axis in the selected range's own color. */
function hslTrack(band: HslBand, key: (typeof HSL_CONTROLS)[number]['key']): string {
  const center = HSL_CENTERS[HSL_BANDS.indexOf(band)]!;
  if (key === 'hue')
    return `linear-gradient(90deg, hsl(${center - 30} 75% 52%), hsl(${center} 75% 52%), hsl(${center + 30} 75% 52%))`;
  if (key === 'saturation') return `linear-gradient(90deg, #6e6e6e, hsl(${center} 45% 50%), hsl(${center} 90% 50%))`;
  return `linear-gradient(90deg, hsl(${center} 70% 12%), hsl(${center} 70% 50%), hsl(${center} 70% 88%))`;
}

const bandColor = (band: HslBand): string => `hsl(${HSL_CENTERS[HSL_BANDS.indexOf(band)]!} 75% 52%)`;
const CURVE_COLORS: Readonly<Record<CurveChannel, string>> = {
  master: '#dfe5e1',
  red: '#ef5d5d',
  green: '#55c46d',
  blue: '#5b8ff2',
};
const capitalize = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
const SWATCH_STEPS: Readonly<Record<string, (at: number, last: number) => number>> = {
  ArrowLeft: (at) => at - 1,
  ArrowUp: (at) => at - 1,
  ArrowRight: (at) => at + 1,
  ArrowDown: (at) => at + 1,
  Home: () => 0,
  End: (_, last) => last,
};

/** A single-choice row of colored square buttons with radio-group keyboard behavior. */
function SwatchGroup<T extends string>({
  label,
  noun,
  options,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  noun: string;
  options: readonly { value: T; color: string }[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}>) {
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const step = SWATCH_STEPS[event.key];
    if (!step || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const next = (step(at, options.length - 1) + options.length) % options.length;
    onChange(options[next]!.value);
    const target = event.currentTarget.parentElement?.children[next];
    if (target instanceof HTMLElement) target.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="color-swatches">
      {options.map((option, at) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="color-swatch"
          aria-label={option.value}
          aria-checked={option.value === value}
          title={`${capitalize(option.value)} ${noun}`}
          tabIndex={option.value === value ? 0 : -1}
          disabled={disabled}
          style={{ '--swatch': option.color } as CSSProperties}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => keyboard(event, at)}
        />
      ))}
    </div>
  );
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Open interval between neighbors, kept a small margin away so a drag never merges nodes. */
function dragSpan(left: number, right: number): [number, number] {
  const margin = Math.min(0.001, (right - left) / 4);
  return [left + margin, right - margin];
}

function isHistoryShortcut(event: KeyboardEvent<HTMLButtonElement>): boolean {
  return (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
}

/** Each Hermite segment is exactly one cubic Bézier; an invalid draft falls back to straight lines. */
function curvePath(points: readonly ColorCurvePoint[]): string {
  const at = (x: number, y: number): string => `${x * 100} ${(1 - y) * 100}`;
  const start = `M${at(points[0]!.x, points[0]!.y)}`;
  if (!colorCurveSchema.safeParse(points).success)
    return `${start}${points
      .slice(1)
      .map((point) => `L${at(point.x, point.y)}`)
      .join('')}`;
  const slopes = colorCurveSlopes(points);
  return `${start}${points
    .slice(1)
    .map((right, index) => {
      const left = points[index]!;
      const third = (right.x - left.x) / 3;
      return `C${at(left.x + third, left.y + third * slopes[index]!)} ${at(right.x - third, right.y - third * slopes[index + 1]!)} ${at(right.x, right.y)}`;
    })
    .join('')}`;
}

/** Preserve local point identity through a single input move and Undo; never save IDs. */
function useCurveSelection(points: readonly ColorCurvePoint[]) {
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
  color: ColorSettings;
  frame: number;
  index: number;
  origin: ColorCurvePoint;
  x: number;
  y: number;
  width: number;
  height: number;
  points: ColorCurvePoint[];
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
  const points = layer.color.curves[channel];
  const selection = useCurveSelection(points);
  const index = points.findIndex((point) => point.x === selection.selected);
  const selected = points[index]!;
  const endpoint = index === 0 || index === points.length - 1;
  const capture = useRef<Capture | null>(null);
  const [draft, setDraft] = useState<ColorCurvePoint[] | null>(null);
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
  const validate = (next: ColorCurvePoint[]): string | null => {
    const result = colorCurveSchema.safeParse(next);
    return result.success
      ? null
      : 'Curve inputs must be unique and ascending from 0 to 1, with 2–16 control nodes and outputs in 0–1.';
  };
  const replace = (at: number, changes: Partial<ColorCurvePoint>): ColorCurvePoint[] =>
    points.map((point, position) => (position === at ? { ...point, ...changes } : point));
  const change = (next: ColorCurvePoint[]): void => {
    if (unavailable) return;
    const message = validate(next);
    if (message) {
      setError(message);
      return;
    }
    onEdit({
      type: 'color',
      ...colorTarget(layer),
      color: { ...layer.color, curves: { ...layer.color.curves, [channel]: next } },
    });
    setError('');
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, at: number): void => {
    if (unavailable || capture.current || event.button !== 0 || !event.isPrimary) return;
    const box = event.currentTarget.closest('.color-curve-plot')?.getBoundingClientRect();
    if (!box?.width || !box.height) return;
    event.preventDefault();
    event.stopPropagation();
    selection.select(points[at]!.x);
    event.currentTarget.focus({ preventScroll: true });
    capture.current = {
      pointer: event.pointerId,
      element: event.currentTarget,
      project,
      color: layer.color,
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
    const original = active.color.curves[channel];
    const left = original[active.index - 1];
    const right = original[active.index + 1];
    // Interior nodes stay strictly between their neighbors; endpoint inputs are fixed.
    const x =
      left && right ? clamp(active.origin.x + dx / active.width, ...dragSpan(left.x, right.x)) : active.origin.x;
    const y = clamp(active.origin.y - dy / active.height, 0, 1);
    active.points = original.map((point, position) => (position === active.index ? { x, y } : point));
    active.error = validate(active.points);
    setDraft(active.points);
    setError(active.error ?? '');
    const command: EditCommand = {
      type: 'color',
      ...colorTarget(layer),
      color: { ...active.color, curves: { ...active.color.curves, [channel]: active.points } },
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
        type: 'color',
        ...colorTarget(latest.current.layer),
        color: { ...active.color, curves: { ...active.color.curves, [channel]: active.points } },
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
    let next: ColorCurvePoint[] | null = null;
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
    change([...points.slice(0, largest + 1), { x, y: evaluateColorCurve(points, x) }, ...points.slice(largest + 1)]);
  };
  return (
    <section className="color-curve-editor" aria-label={`${channel} color curve editor`} data-dirty={draft !== null}>
      <div
        className={`color-curve-plot${draft && error ? ' invalid' : ''}`}
        style={{ '--curve': CURVE_COLORS[channel] } as CSSProperties}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Encoded color curves, ${channel} editable`}
        >
          <path d="M0 100L100 0M25 0V100M50 0V100M75 0V100M0 25H100M0 50H100M0 75H100" className="color-curve-grid" />
          {CURVE_CHANNELS.filter((other) => other !== channel).map((other) => (
            <path
              key={other}
              d={curvePath(layer.color.curves[other])}
              className="color-curve-other"
              stroke={CURVE_COLORS[other]}
              data-channel={other}
            />
          ))}
          <path d={curvePath(shown)} className="color-curve-selected" data-channel={channel} />
        </svg>
        {shown.map((point, at) => (
          <button
            key={selection.ids[at]}
            type="button"
            className="color-curve-point"
            style={{ left: `${point.x * 100}%`, top: `${(1 - point.y) * 100}%` }}
            aria-label={`Color curve control node ${at + 1}`}
            aria-pressed={index === at}
            aria-disabled={disabled && !capture.current}
            title={`Input ${point.x}, output ${point.y}. Arrows edit; Shift moves 0.1; Enter selects.`}
            onClick={() => {
              if (!unavailable) selection.select(points[at]!.x);
            }}
            onFocus={() => {
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
      <div className="color-curve-fields">
        <label>
          Input 0–1
          <NumberField
            aria-label="Color curve input"
            value={selected.x}
            min={0}
            max={1}
            resetKey={context}
            disabled={unavailable || endpoint}
            validate={(x) => validate(replace(index, { x }))}
            onCommit={(x) => change(replace(index, { x }))}
          />
        </label>
        <label>
          Output 0–1
          <NumberField
            aria-label="Color curve output"
            value={selected.y}
            min={0}
            max={1}
            resetKey={context}
            disabled={unavailable}
            onCommit={(y) => change(replace(index, { y }))}
          />
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label="Add color curve control node"
          disabled={unavailable || points.length >= 16}
          onClick={add}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete color curve control node"
          disabled={unavailable || endpoint}
          onClick={() => change(points.filter((_, at) => at !== index))}
        >
          <Icon name="trash" size={14} />
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

function colorCommit({ layer, disabled, onEdit }: Readonly<Props>) {
  return (color: ColorSettings): void => {
    if (!disabled) onEdit({ type: 'color', ...colorTarget(layer), color: colorSchema.parse(color) });
  };
}

export function HslRangesSection(props: Readonly<Props>) {
  const { layer, project, disabled } = props;
  const [band, setBand] = useState<HslBand>('red');
  const commit = colorCommit(props);
  const context = `${project.id}:${layer.id}:${band}`;
  return (
    <InspectorSection
      id="hsl"
      title="HSL ranges"
      icon="sliders"
      modified={!isNeutralHsl(layer.color.hsl)}
      help={
        <HelpPopover label="HSL ranges" guide="color-speed-and-keyframes">
          <p>
            Shift the hue, saturation or lightness of one color range, such as the blues, on this {ownerNoun(layer)}.
            Neighboring ranges blend smoothly and grays stay untouched.
          </p>
          <p className="editor-help-tip">Tip: Reset all returns every range to neutral.</p>
        </HelpPopover>
      }
    >
      <div className="advanced-color">
        <SwatchGroup
          label="HSL range"
          noun="range"
          options={HSL_BANDS.map((name) => ({ value: name, color: bandColor(name) }))}
          value={band}
          disabled={disabled}
          onChange={setBand}
        />
        {HSL_CONTROLS.map((control) => {
          const withValue = (value: number): ColorSettings => ({
            ...layer.color,
            hsl: { ...layer.color.hsl, [band]: { ...layer.color.hsl[band], [control.key]: value } },
          });
          return (
            <div className="advanced-hsl-control" key={control.key}>
              <ResetLabel
                htmlFor={`${context}-${control.key}`}
                name={`HSL ${control.key}`}
                blocked={resetBlocked(layer.color.hsl[band][control.key] === 0, disabled)}
                onReset={() => commit(withValue(0))}
              >
                {control.label}
              </ResetLabel>
              <ValueControl
                id={`${context}-${control.key}`}
                aria-label={`HSL ${control.key}`}
                value={layer.color.hsl[band][control.key]}
                min={control.min}
                max={control.max}
                step={control.step}
                track={hslTrack(band, control.key)}
                resetKey={context}
                disabled={disabled}
                onCommit={(value) => commit(withValue(value))}
                onDraft={(value) =>
                  livePreview(value === null ? null : { type: 'color', ...colorTarget(layer), color: withValue(value) })
                }
              />
            </div>
          );
        })}
        <div className="advanced-color-tools">
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label={`Reset ${band} HSL range`}
            onClick={() =>
              commit({ ...layer.color, hsl: { ...layer.color.hsl, [band]: { hue: 0, saturation: 0, lightness: 0 } } })
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
            onClick={() => commit({ ...layer.color, hsl: createHslSettings() })}
          >
            Reset all
          </button>
        </div>
      </div>
    </InspectorSection>
  );
}

export function ColorCurvesSection(props: Readonly<Props>) {
  const { layer, project, disabled } = props;
  const [channel, setChannel] = useState<CurveChannel>('master');
  const commit = colorCommit(props);
  return (
    <InspectorSection
      id="curves"
      title="Color curves"
      icon="tone-curve"
      modified={!Object.values(layer.color.curves).every(isIdentityCurve)}
      help={
        <HelpPopover label="Color curves" guide="color-speed-and-keyframes">
          <p>
            Drag control nodes to reshape brightness or color: Master changes everything, Red, Green and Blue one
            channel each. Add a node to bend another part of the curve.
          </p>
          <p className="editor-help-tip">
            Tip: select a node and use the arrow keys for fine steps; Escape cancels a drag.
          </p>
        </HelpPopover>
      }
    >
      <div className="advanced-color">
        <SwatchGroup
          label="Color curve channel"
          noun="curve"
          options={CURVE_CHANNELS.map((name) => ({ value: name, color: CURVE_COLORS[name] }))}
          value={channel}
          disabled={disabled}
          onChange={setChannel}
        />
        <CurveEditor key={`${project.id}:${layer.id}:${channel}`} {...props} channel={channel} />
        <div className="advanced-color-tools">
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label={`Reset ${channel} curve`}
            onClick={() =>
              commit({ ...layer.color, curves: { ...layer.color.curves, [channel]: createColorCurves()[channel] } })
            }
          >
            <Icon name="reset" size={13} />
            Reset {channel}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label="Reset all color curves"
            onClick={() => commit({ ...layer.color, curves: createColorCurves() })}
          >
            Reset all
          </button>
        </div>
      </div>
    </InspectorSection>
  );
}
