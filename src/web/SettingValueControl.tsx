import type { ReactNode } from 'react';
import { COLOUR_CONTROLS, NEUTRAL_COLOUR } from '../shared/colour.js';
import { KEYFRAME_SETTINGS, type KeyframeSetting } from '../shared/keyframes.js';
import { Icon } from './icons.js';
import type { NumberFieldProps } from './NumberField.js';
import { ValueControl, type ValueControlProps } from './ValueControl.js';

interface RangeSettingProps {
  setting: KeyframeSetting;
  id: string;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
  label?: string;
  hint: string;
  scope?: ReactNode;
  locked?: ReactNode;
  actions?: ReactNode;
  resetKey?: NumberFieldProps['resetKey'];
  validate?: NumberFieldProps['validate'];
  onDraft?: ValueControlProps['onDraft'];
  exact?: Pick<NumberFieldProps, 'resetKey' | 'validate'>;
}

/** Compact reset beside a setting's name; `blocked` is the reason it cannot apply, else it resets that setting alone. */
export function ResetButton({
  name,
  blocked,
  onReset,
}: Readonly<{ name: string; blocked: string | null; onReset: () => void }>) {
  return (
    <button
      type="button"
      className="setting-reset"
      aria-label={`Reset ${name}`}
      aria-disabled={blocked !== null}
      tabIndex={blocked === null ? 0 : -1}
      title={blocked ?? `Reset ${name}`}
      onClick={() => {
        if (blocked === null) onReset();
      }}
    >
      <Icon name="reset" size={11} />
    </button>
  );
}

/**
 * A setting's visible name with its reset button; double-clicking the name resets it too. The name is
 * not a focusing label: moving focus could scroll the control between the two clicks.
 */
export function ResetLabel({
  htmlFor,
  title,
  name,
  blocked,
  onReset,
  children,
}: Readonly<{
  htmlFor: string;
  title?: string;
  name: string;
  blocked: string | null;
  onReset: () => void;
  children: ReactNode;
}>) {
  return (
    <span className="setting-reset-group">
      <span
        className="setting-name"
        id={`${htmlFor}-name`}
        title={title}
        onDoubleClick={() => {
          if (blocked === null) onReset();
        }}
      >
        {children}
      </span>
      <ResetButton name={name} blocked={blocked} onReset={onReset} />
    </span>
  );
}

/** Why a reset cannot apply, or null when it can. Neutral values add no history entry. */
export function resetBlocked(neutral: boolean, disabled: boolean, animatedLocked = false): string | null {
  if (animatedLocked) return 'Add a keyframe to edit this setting before resetting it.';
  if (disabled) return 'This setting cannot be edited right now.';
  return neutral ? 'Already at its default value.' : null;
}

/** Visible without hover: an animated value without a keyframe here is read-only until its diamond captures one. */
export function LockedCue({ glyph = '◇', className = '' }: Readonly<{ glyph?: string; className?: string }>) {
  return (
    <small className={`setting-locked-cue ${className}`.trim()} aria-hidden="true">
      <Icon name="lock" size={11} />
      Add a keyframe {glyph} to edit
    </small>
  );
}

/** The same setting-specific slider and units in either edit context; double-click the name to reset. */
export function RangeSettingControl({
  setting,
  id,
  value,
  disabled,
  onCommit,
  label,
  hint,
  scope,
  locked,
  actions,
  resetKey,
  validate,
  onDraft,
  exact,
}: Readonly<RangeSettingProps>) {
  const definition = KEYFRAME_SETTINGS.find((item) => item.key === setting)!;
  const colour = COLOUR_CONTROLS.find((item) => item.key === setting);
  const name = label ?? definition.label;
  const neutral = colour ? NEUTRAL_COLOUR[colour.key] : 1;
  const scale = setting === 'opacity' ? 100 : 1;
  const exactHint = setting === 'opacity' ? `${hint} Opacity uses 0–100%.` : hint;
  const fieldContext = exact?.resetKey ?? resetKey ?? `${id}:${hint}`;
  const fieldValidation = exact?.validate ?? validate;
  return (
    <>
      <span>
        <ResetLabel
          htmlFor={id}
          title={hint}
          name={name}
          blocked={resetBlocked(value === neutral, disabled, Boolean(locked))}
          onReset={() => onCommit(neutral)}
        >
          {definition.label}
          {scope}
        </ResetLabel>
        {locked}
        {actions && <span className="colour-control-actions">{actions}</span>}
      </span>
      <ValueControl
        id={id}
        aria-label={name}
        aria-describedby={`${id}-hint`}
        min={definition.min * scale}
        max={definition.max * scale}
        step={definition.step * scale}
        value={value * scale}
        disabled={disabled}
        resetKey={fieldContext}
        {...(fieldValidation === undefined ? {} : { validate: (next: number) => fieldValidation(next / scale) })}
        unit={setting === 'opacity' ? '%' : (colour?.unit ?? '')}
        onCommit={(next) => onCommit(next / scale)}
        {...(onDraft === undefined ? {} : { onDraft: (next) => onDraft(next === null ? null : next / scale) })}
      />
      <span id={`${id}-hint`} className="declutter-sr-only">
        {exactHint}
      </span>
    </>
  );
}

/** All speed rates share the same bounded slider and unrestricted decimal precision. */
export function RateValueControl(props: Readonly<Omit<ValueControlProps, 'min' | 'max' | 'step' | 'unit'>>) {
  return <ValueControl {...props} min={0.1} max={8} step={0.05} unit="×" />;
}
