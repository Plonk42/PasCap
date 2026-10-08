import { useId, type ReactNode } from 'react';
import { COLOUR_CONTROLS, NEUTRAL_COLOUR } from '../shared/colour.js';
import { KEYFRAME_SETTINGS, type KeyframeSetting } from '../shared/keyframes.js';
import type { NumberFieldProps } from './NumberField.js';
import { ValueControl, type ValueControlProps } from './ValueControl.js';

type RangeSetting = Exclude<KeyframeSetting, 'speed'>;

interface RangeSettingProps {
  setting: RangeSetting;
  id: string;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
  label?: string;
  hint: string;
  scope?: ReactNode;
  actions?: ReactNode;
  resetKey?: NumberFieldProps['resetKey'];
  validate?: NumberFieldProps['validate'];
  exact?: Pick<NumberFieldProps, 'resetKey' | 'validate'>;
}

/**
 * A setting's visible name; double-clicking it resets that control. It is not a focusing label:
 * moving focus could scroll the control between the two clicks. The inputs carry their own names.
 */
export function ResetLabel({
  htmlFor,
  title,
  onReset,
  children,
}: Readonly<{ htmlFor: string; title?: string; onReset: () => void; children: ReactNode }>) {
  return (
    <span className="setting-name" id={`${htmlFor}-name`} title={title} onDoubleClick={onReset}>
      {children}
    </span>
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
  actions,
  resetKey,
  validate,
  exact,
}: Readonly<RangeSettingProps>) {
  const definition = KEYFRAME_SETTINGS.find((item) => item.key === setting)!;
  const colour = COLOUR_CONTROLS.find((item) => item.key === setting);
  const name = label ?? definition.label;
  const neutral = colour ? NEUTRAL_COLOUR[colour.key] : 1;
  const exactHint = setting === 'opacity' ? `${hint} Exact Opacity uses 0–1; 1 is 100%.` : hint;
  const fieldContext = exact?.resetKey ?? resetKey ?? `${id}:${hint}`;
  const fieldValidation = exact?.validate ?? validate;
  return (
    <>
      <span>
        <ResetLabel
          htmlFor={id}
          title={hint}
          onReset={() => {
            if (!disabled && value !== neutral) onCommit(neutral);
          }}
        >
          {definition.label}
          {scope}
        </ResetLabel>
        {actions && <span className="colour-control-actions">{actions}</span>}
      </span>
      <ValueControl
        id={id}
        aria-label={name}
        aria-describedby={`${id}-hint`}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={value}
        disabled={disabled}
        resetKey={fieldContext}
        {...(fieldValidation === undefined ? {} : { validate: fieldValidation })}
        unit={setting === 'opacity' ? '0–1' : (colour?.unit ?? '')}
        onCommit={onCommit}
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

/** A row Speed participant is a rate, never a clip mode or source-time curve. */
export function SpeedRateField(props: Readonly<Omit<NumberFieldProps, 'min' | 'max' | 'step'>>) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="speed-field">
      <label htmlFor={id}>Layer rate ×</label>
      <RateValueControl {...props} id={id} />
    </div>
  );
}
