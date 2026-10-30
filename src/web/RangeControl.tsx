import { useId, type CSSProperties, type KeyboardEvent } from 'react';
import type { Bounds } from '../shared/motion-analysis.js';
import { NumberField } from './NumberField.js';
import { SLIDER_INSTRUCTIONS_ID } from './SharedInstructions.js';
import { useValueGesture, type ValueControlProps } from './ValueControl.js';
import './value-control.css';

export interface RangeControlProps {
  /** The setting's name; its ends are named "<name> minimum" and "<name> maximum". */
  'aria-label': string;
  id?: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  value: Bounds;
  disabled?: boolean;
  title?: string;
  resetKey?: string | number;
  onCommit: (value: [number, number]) => void;
  /** The valid range being dragged, or null when no pointer gesture is previewing. Never a commit. */
  onDraft?: (value: [number, number] | null) => void;
}

const fraction = (value: number, min: number, max: number): number => (value - min) / (max - min);

/**
 * Two native sliders on one track, each with its exact field: the low end must stay below the high
 * end. Each end drafts, commits and cancels exactly like a ValueControl.
 */
export function RangeControl(props: Readonly<RangeControlProps>) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const [low, high] = props.value;
  const end = (which: 'minimum' | 'maximum'): ValueControlProps => {
    const isHigh = which === 'maximum';
    const pair = (value: number): [number, number] => (isHigh ? [low, value] : [value, high]);
    return {
      'aria-label': `${props['aria-label']} ${which}`,
      min: props.min,
      max: props.max,
      step: props.step,
      value: isHigh ? high : low,
      ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
      ...(props.resetKey === undefined ? {} : { resetKey: props.resetKey }),
      validate: (value) => {
        if (isHigh) return value > low ? null : `Enter more than the minimum, ${low}.`;
        return value < high ? null : `Enter less than the maximum, ${high}.`;
      },
      onCommit: (value) => props.onCommit(pair(value)),
      onDraft: (value) => props.onDraft?.(value === null ? null : pair(value)),
    };
  };
  const lowProps = end('minimum');
  const highProps = end('maximum');
  const lowEnd = useValueGesture(lowProps);
  const highEnd = useValueGesture(highProps);
  const lowDraft = lowEnd.state.draft;
  const highDraft = highEnd.state.draft;
  const errorId = `${id}-range-error`;
  const error = lowEnd.error ?? highEnd.error;
  const slider = (
    endProps: ValueControlProps,
    gesture: ReturnType<typeof useValueGesture>,
    sliderId: string,
    className: string,
  ) => (
    <input
      id={sliderId}
      className={className}
      type="range"
      aria-label={endProps['aria-label']}
      aria-describedby={[SLIDER_INSTRUCTIONS_ID, gesture.error ? errorId : null].filter(Boolean).join(' ')}
      aria-invalid={gesture.error !== null}
      aria-errormessage={gesture.error ? errorId : undefined}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      title={props.title}
      {...gesture.slider}
    />
  );
  return (
    <div
      className="range-control"
      data-pointer-draft={[lowEnd, highEnd].some(({ state }) => state.pointer !== null && !state.pointer.canceled)}
      // The end nearer the middle stays reachable where the thumbs overlap.
      data-low-on-top={lowDraft > (props.min + props.max) / 2 || undefined}
      style={
        {
          '--range-low': fraction(Math.min(lowDraft, highDraft), props.min, props.max),
          '--range-high': fraction(Math.max(lowDraft, highDraft), props.min, props.max),
        } as CSSProperties
      }
      onKeyDownCapture={(event: KeyboardEvent) => {
        lowEnd.restoreInvalid(event);
        highEnd.restoreInvalid(event);
      }}
    >
      <div className="range-control-track">
        {slider(lowProps, lowEnd, id, 'low')}
        {slider(highProps, highEnd, `${id}-high`, 'high')}
      </div>
      <NumberField {...lowProps} id={`${id}-exact`} {...lowEnd.exact} />
      <span className="range-control-dash" aria-hidden="true">
        –
      </span>
      <NumberField {...highProps} id={`${id}-high-exact`} {...highEnd.exact} />
      {props.unit && <small className="range-control-unit">{props.unit}</small>}
      {error && (
        <span id={errorId} className="number-field-error" role="alert">
          {error} Press Escape on the slider to restore {low} – {high}.
        </span>
      )}
    </div>
  );
}
