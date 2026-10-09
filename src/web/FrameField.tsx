import { useId, useState } from 'react';
import { formatTimecode } from '../shared/timing.js';
import { validateNumberDraft, type NumberConstraints, type NumberValidation } from './NumberField.js';
import { NUMBER_FIELD_INSTRUCTIONS_ID } from './SharedInstructions.js';
import './input-controls.css';

/** Source boundaries include exclusive OUT; the stored value is always an integer frame. */
export function validateFrameDraft(draft: string, constraints: Readonly<NumberConstraints>): NumberValidation {
  if (!draft.includes(':')) return validateNumberDraft(draft, { ...constraints, integer: true });
  const match = /^(\d+):(\d{2}):(\d{2}):(\d{2})$/.exec(draft.trim());
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60 || Number(match[4]) >= 30)
    return { valid: false, error: 'Use HH:MM:SS:FF (30 fps NDF), or a whole source frame.' };
  const frame = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 30 + Number(match[4]);
  return validateNumberDraft(String(frame), { ...constraints, integer: true });
}

/** One exact boundary field, displaying timecode and accepting either notation without a second readout. */
export function FrameField({
  value,
  resetKey,
  disabled,
  onCommit,
  id,
  min,
  max,
  validate,
  'aria-label': label,
  'aria-describedby': describedBy,
}: Readonly<
  {
    value: number;
    resetKey: string;
    disabled: boolean;
    onCommit: (frame: number) => void;
    id: string;
    'aria-label': string;
    'aria-describedby': string;
  } & NumberConstraints
>) {
  const errorId = useId();
  const display = formatTimecode(value);
  const [state, setState] = useState({ value, resetKey, disabled, draft: display, attempted: false });
  if (state.value !== value || state.resetKey !== resetKey || state.disabled !== disabled)
    setState({ value, resetKey, disabled, draft: display, attempted: false });
  const constraints = {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(validate === undefined ? {} : { validate }),
  };
  const result = state.attempted ? validateFrameDraft(state.draft, constraints) : null;
  const error = result && !result.valid ? result.error : null;
  const dirty = state.draft !== display;
  const restore = (): void => setState({ value, resetKey, disabled, draft: display, attempted: false });
  const commit = (): void => {
    if (disabled || !dirty) return;
    const next = validateFrameDraft(state.draft, constraints);
    if (!next.valid) {
      setState({ ...state, attempted: true });
      return;
    }
    restore();
    if (next.value !== value) onCommit(next.value);
  };
  return (
    <span className="number-field frame-field" data-dirty={dirty}>
      <input
        id={id}
        className="number-field-input"
        type="text"
        value={state.draft}
        disabled={disabled}
        aria-label={label}
        aria-invalid={error !== null}
        aria-errormessage={error ? errorId : undefined}
        aria-describedby={[describedBy, NUMBER_FIELD_INSTRUCTIONS_ID, error ? errorId : null].filter(Boolean).join(' ')}
        title="Source frame or HH:MM:SS:FF (30 fps NDF). Enter/blur applies; Escape restores."
        onChange={(event) => setState({ ...state, draft: event.currentTarget.value })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Enter') commit();
            else restore();
          }
        }}
      />
      {error ? (
        <span className="number-field-error" id={errorId} role="alert">
          {error} Press Escape to restore {display}.
        </span>
      ) : (
        dirty && (
          <span className="number-field-pending">Not applied · Enter or leave the field to apply; Esc cancels.</span>
        )
      )}
    </span>
  );
}
