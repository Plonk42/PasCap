import { useId, useState } from 'react';
import './input-controls.css';

export interface NumberConstraints {
  integer?: boolean;
  min?: number;
  max?: number;
  validate?: (value: number) => string | null;
}

export type NumberValidation = { valid: true; value: number } | { valid: false; error: string };

/** Decimal input only: no coercion of empty text to zero, clamping or rounding. */
export function validateNumberDraft(
  draft: string,
  { integer = false, min, max, validate }: Readonly<NumberConstraints> = {},
): NumberValidation {
  const text = draft.trim();
  if (!text) return { valid: false, error: 'Enter a number; this field cannot be empty.' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { valid: false, error: 'Enter a finite number (for example, 1.5).' };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))
    return { valid: false, error: 'Use a decimal number (for example, 1.5).' };
  if (integer && !Number.isInteger(value)) return { valid: false, error: 'Enter a whole number (no decimals).' };
  if (min !== undefined && value < min) return { valid: false, error: `Enter ${min} or greater.` };
  if (max !== undefined && value > max) return { valid: false, error: `Enter ${max} or less.` };
  if (integer && !Number.isSafeInteger(value))
    return { valid: false, error: 'Enter a whole number within the safe integer range.' };
  const error = validate?.(value);
  return error ? { valid: false, error } : { valid: true, value };
}

export interface NumberFieldProps extends NumberConstraints {
  value: number;
  onCommit: (value: number) => void;
  'aria-label': string;
  'aria-describedby'?: string;
  id?: string;
  step?: number;
  disabled?: boolean;
  hint?: string;
  /** Change when switching the edited entity/playhead key, even if its value is identical. */
  resetKey?: string | number;
}

/** A local text draft; only Enter or blur can send a numeric edit to the parent. */
export function NumberField({
  value,
  onCommit,
  integer = false,
  min,
  max,
  validate,
  step,
  disabled = false,
  hint,
  resetKey,
  id,
  'aria-label': label,
  'aria-describedby': describedBy,
}: Readonly<NumberFieldProps>) {
  const fieldId = useId();
  const instructionsId = `${fieldId}-instructions`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const [state, setState] = useState(() => ({ value, resetKey, disabled, draft: String(value), attempted: false }));

  // Adjust during render, not in a delayed effect that could overwrite the next keystroke.
  // The input is never remounted, blurred or focused when undo/drag/selection updates arrive.
  if (!Object.is(state.value, value) || state.resetKey !== resetKey || state.disabled !== disabled) {
    setState({ value, resetKey, disabled, draft: String(value), attempted: false });
  }

  const constraints: NumberConstraints = {
    integer,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(validate === undefined ? {} : { validate }),
  };
  const validation = state.attempted ? validateNumberDraft(state.draft, constraints) : null;
  const error = validation && !validation.valid ? validation.error : null;
  const dirty = state.draft !== String(value);
  const restore = (): void => setState({ value, resetKey, disabled, draft: String(value), attempted: false });
  const commit = (): void => {
    if (disabled || !dirty) return;
    const result = validateNumberDraft(state.draft, constraints);
    if (!result.valid) {
      setState({ ...state, attempted: true });
      return;
    }
    // Settle before calling out: a later blur must not submit the Enter edit twice.
    // onCommit is void; only the parent's next value confirms acceptance, not this draft.
    restore();
    if (result.value !== value) onCommit(result.value);
  };

  return (
    <span className="number-field" data-dirty={dirty}>
      <input
        className="number-field-input"
        id={id ?? fieldId}
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        aria-label={label}
        min={min}
        max={max}
        step={step ?? (integer ? 1 : 'any')}
        value={state.draft}
        disabled={disabled}
        aria-invalid={error !== null}
        aria-errormessage={error ? errorId : undefined}
        aria-describedby={[describedBy, instructionsId, hint ? hintId : null, error ? errorId : null]
          .filter(Boolean)
          .join(' ')}
        title={`Enter or leave the field to apply. Escape restores ${value}.`}
        onChange={(event) => setState({ ...state, draft: event.currentTarget.value })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            restore();
          }
        }}
      />
      <span className="number-field-instructions" id={instructionsId}>
        Enter or leave the field to apply. Escape restores the current value.
      </span>
      {hint && (
        <span className="number-field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {error ? (
        <span className="number-field-error" id={errorId} role="alert">
          {error} Press Escape to restore {value}.
        </span>
      ) : (
        dirty && (
          <span className="number-field-pending">Not applied · Enter or leave the field to apply; Esc cancels.</span>
        )
      )}
    </span>
  );
}
