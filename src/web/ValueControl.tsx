import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { NumberField, validateNumberDraft, type NumberFieldProps, type NumberValidation } from './NumberField.js';
import './value-control.css';

export interface ValueControlProps extends Omit<NumberFieldProps, 'min' | 'max' | 'step'> {
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export interface ValueControlContext {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  integer: boolean;
  resetKey?: string | number;
}

export interface ValueControlState {
  context: Readonly<ValueControlContext>;
  draft: number;
  submitted: number;
  pointer: Readonly<{ id: number; cancelled: boolean }> | null;
  error: string | null;
}

export type ValueControlAction =
  | { type: 'begin'; pointerId: number }
  | { type: 'change'; value: number }
  | { type: 'exact'; value: number }
  | { type: 'finish'; pointerId: number }
  | { type: 'cancel' }
  | { type: 'restore' };

export function createValueControlState(context: Readonly<ValueControlContext>): ValueControlState {
  return { context, draft: context.value, submitted: context.value, pointer: null, error: null };
}

/** A context replacement cancels the captured edit, including identical-valued selections. */
export function syncValueControlState(
  state: ValueControlState,
  context: Readonly<ValueControlContext>,
): ValueControlState {
  if (
    Object.is(state.context.value, context.value) &&
    state.context.resetKey === context.resetKey &&
    state.context.disabled === context.disabled &&
    state.context.min === context.min &&
    state.context.max === context.max &&
    state.context.step === context.step &&
    state.context.integer === context.integer
  )
    return state;
  return {
    ...createValueControlState(context),
    // Suppress the rest of an interrupted native gesture until its physical release.
    pointer: state.pointer ? { id: state.pointer.id, cancelled: true } : null,
  };
}

export function validateValueControlValue(
  value: number,
  constraints: Pick<NumberFieldProps, 'min' | 'max' | 'integer' | 'validate'>,
): NumberValidation {
  try {
    return validateNumberDraft(String(value), constraints);
  } catch (cause) {
    return { valid: false, error: cause instanceof Error ? cause.message : 'This value cannot be applied.' };
  }
}

function settleValueControl(
  state: ValueControlState,
  draft: number,
  validate: NumberFieldProps['validate'],
): { state: ValueControlState; commit: number | null } {
  const result = validateValueControlValue(draft, {
    ...state.context,
    ...(validate === undefined ? {} : { validate }),
  });
  if (!result.valid) return { state: { ...state, draft, pointer: null, error: result.error }, commit: null };
  return {
    state: { ...state, draft: state.context.value, submitted: result.value, pointer: null, error: null },
    // A native change following pointerup must not duplicate that release.
    commit: result.value === state.submitted ? null : result.value,
  };
}

function settleExactValueControl(
  state: ValueControlState,
  value: number,
  validate: NumberFieldProps['validate'],
): { state: ValueControlState; commit: number | null } {
  if (state.context.disabled || state.pointer?.cancelled === false) return { state, commit: null };
  const result = settleValueControl(state, value, validate);
  // Exact entry remains available after blur/capture loss even if the OS never delivers pointerup.
  // Keep suppressing that obsolete native range gesture until its physical end.
  return { ...result, state: { ...result.state, pointer: state.pointer } };
}

/** Pure native-input lifecycle: only a valid final release or non-pointer change emits an edit. */
export function transitionValueControl(
  state: ValueControlState,
  action: ValueControlAction,
  validate?: NumberFieldProps['validate'],
): { state: ValueControlState; commit: number | null } {
  const unchanged = { state, commit: null };
  const restore = (): ValueControlState => ({
    ...createValueControlState(state.context),
    pointer: state.pointer ? { id: state.pointer.id, cancelled: true } : null,
  });
  switch (action.type) {
    case 'begin':
      if (state.context.disabled || state.pointer?.cancelled === false) return unchanged;
      return {
        state: { ...state, submitted: state.context.value, pointer: { id: action.pointerId, cancelled: false } },
        commit: null,
      };
    case 'change': {
      if (state.context.disabled || state.pointer?.cancelled) return unchanged;
      if (!state.pointer) return settleValueControl(state, action.value, validate);
      const result = validateValueControlValue(action.value, {
        ...state.context,
        ...(validate === undefined ? {} : { validate }),
      });
      return { state: { ...state, draft: action.value, error: result.valid ? null : result.error }, commit: null };
    }
    case 'exact':
      return settleExactValueControl(state, action.value, validate);
    case 'finish':
      if (state.pointer?.id !== action.pointerId) return unchanged;
      if (state.pointer.cancelled || state.context.disabled)
        return { state: createValueControlState(state.context), commit: null };
      return settleValueControl(state, state.draft, validate);
    case 'cancel':
    case 'restore':
      return { state: restore(), commit: null };
  }
}

/** Native range gestures draft locally; NumberField keeps its mounted precise text editor. */
export function ValueControl(props: Readonly<ValueControlProps>) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const errorId = `${id}-slider-error`;
  const instructionsId = `${id}-slider-instructions`;
  const context: ValueControlContext = {
    value: props.value,
    min: props.min,
    max: props.max,
    step: props.step,
    disabled: props.disabled ?? false,
    integer: props.integer ?? false,
    ...(props.resetKey === undefined ? {} : { resetKey: props.resetKey }),
  };
  const [stored, setStored] = useState(() => createValueControlState(context));
  const state = syncValueControlState(stored, context);
  if (state !== stored) setStored(state);
  const current = useRef(state);
  current.current = state;
  const latest = useRef({ props, context });
  latest.current = { props, context };
  const capture = useRef<{
    id: number;
    element: HTMLInputElement;
    dispose: () => void;
    cancelListeners: () => void;
  } | null>(null);

  const dispatch = (action: ValueControlAction): void => {
    const { props: activeProps, context: activeContext } = latest.current;
    const result = transitionValueControl(
      syncValueControlState(current.current, activeContext),
      action,
      activeProps.validate,
    );
    current.current = result.state;
    setStored(result.state);
    if (result.commit !== null) activeProps.onCommit(result.commit);
  };
  const releaseCapture = (): void => {
    const active = capture.current;
    if (active?.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
  };
  const cancel = (): void => {
    dispatch({ type: 'cancel' });
    // Keep only the physical end guard; a cancelled gesture must not consume later Escape presses.
    capture.current?.cancelListeners();
    releaseCapture();
  };
  const finish = (pointerId: number, cancelled = false): void => {
    const active = capture.current;
    if (active?.id !== pointerId) return;
    capture.current = null;
    active.dispose();
    if (cancelled) dispatch({ type: 'cancel' });
    dispatch({ type: 'finish', pointerId });
    if (active.element.hasPointerCapture(pointerId)) active.element.releasePointerCapture(pointerId);
  };
  const begin = (event: PointerEvent<HTMLInputElement>): void => {
    if (latest.current.context.disabled || !event.isPrimary || event.button !== 0) return;
    if (capture.current && current.current.pointer?.cancelled) {
      capture.current.dispose();
      capture.current = null;
    }
    if (capture.current) return;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    dispatch({ type: 'begin', pointerId });
    const up = (next: globalThis.PointerEvent): void => finish(next.pointerId);
    const pointerCancel = (next: globalThis.PointerEvent): void => finish(next.pointerId, true);
    const blur = (): void => cancel();
    const escape = (next: globalThis.KeyboardEvent): void => {
      if (next.key !== 'Escape' || next.isComposing) return;
      next.preventDefault();
      next.stopPropagation();
      cancel();
    };
    const cancelListeners = (): void => {
      globalThis.removeEventListener('blur', blur);
      globalThis.removeEventListener('keydown', escape, true);
    };
    const dispose = (): void => {
      globalThis.removeEventListener('pointerup', up);
      globalThis.removeEventListener('pointercancel', pointerCancel);
      cancelListeners();
    };
    capture.current = { id: pointerId, element, dispose, cancelListeners };
    globalThis.addEventListener('pointerup', up);
    globalThis.addEventListener('pointercancel', pointerCancel);
    globalThis.addEventListener('blur', blur);
    globalThis.addEventListener('keydown', escape, true);
    // Never preventDefault: the browser still owns thumb movement and track clicks.
    element.focus({ preventScroll: true });
    element.setPointerCapture(pointerId);
  };

  useEffect(() => {
    if (current.current.pointer?.cancelled) {
      const active = capture.current;
      active?.cancelListeners();
      if (active?.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    }
  }, [props.value, props.resetKey, props.disabled, props.min, props.max, props.step, props.integer]);
  useEffect(
    () => () => {
      const active = capture.current;
      capture.current = null;
      active?.dispose();
      if (active?.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    },
    [],
  );

  const error = state.error;
  return (
    <div
      className="value-control"
      data-dirty={state.pointer?.cancelled === false || state.draft !== props.value}
      data-pointer-draft={state.pointer !== null && !state.pointer.cancelled}
      data-unit={Boolean(props.unit)}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && state.error) dispatch({ type: 'restore' });
      }}
    >
      <input
        id={id}
        type="range"
        aria-label={props['aria-label']}
        aria-describedby={[props['aria-describedby'], instructionsId, error ? errorId : null].filter(Boolean).join(' ')}
        aria-invalid={error !== null}
        aria-errormessage={error ? errorId : undefined}
        min={props.min}
        max={props.max}
        step={props.step}
        value={state.draft}
        disabled={props.disabled}
        title={props.hint}
        onChange={(event) => dispatch({ type: 'change', value: Number(event.currentTarget.value) })}
        onPointerDown={begin}
        onPointerUp={(event) => finish(event.pointerId)}
        onPointerCancel={(event) => finish(event.pointerId, true)}
        onLostPointerCapture={(event) => {
          if (capture.current?.id === event.pointerId) cancel();
        }}
        onKeyDown={(event) => {
          const pointer = current.current.pointer;
          if (pointer?.cancelled) finish(pointer.id);
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            dispatch({ type: 'restore' });
          }
        }}
      />
      <NumberField
        {...props}
        id={`${id}-exact`}
        aria-describedby={[props['aria-describedby'], error ? errorId : null].filter(Boolean).join(' ')}
        value={state.draft}
        disabled={Boolean(props.disabled || state.pointer?.cancelled === false)}
        validate={(value) => {
          const result = validateValueControlValue(value, latest.current.props);
          return result.valid ? null : result.error;
        }}
        onCommit={(value) => dispatch({ type: 'exact', value })}
      />
      {props.unit && <small className="value-control-unit">{props.unit}</small>}
      <span id={instructionsId} className="number-field-instructions">
        Drag to choose a value; release to apply once. Escape cancels the drag. Exact values apply on Enter or blur.
      </span>
      {error && (
        <span id={errorId} className="number-field-error" role="alert">
          {error} Press Escape on the slider to restore {props.value}.
        </span>
      )}
    </div>
  );
}
