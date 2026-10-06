import type { ReactNode } from 'react';
import { COLOUR_CONTROLS, NEUTRAL_COLOUR } from '../shared/colour.js';
import { KEYFRAME_SETTINGS, type KeyframeSetting } from '../shared/keyframes.js';
import { Icon } from './icons.js';
import { NumberField, type NumberFieldProps } from './NumberField.js';

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
  resetTitle?: string;
  exact?: Pick<NumberFieldProps, 'resetKey' | 'validate'>;
}

/** The same setting-specific slider, units and colour reset in either edit context. */
export function RangeSettingControl({ setting, id, value, disabled, onCommit, label, hint, scope, actions, resetTitle, exact }: Readonly<RangeSettingProps>) {
  const definition = KEYFRAME_SETTINGS.find((item) => item.key === setting)!;
  const colour = COLOUR_CONTROLS.find((item) => item.key === setting);
  const name = label ?? definition.label;
  const neutral = colour ? NEUTRAL_COLOUR[colour.key] : null;
  return <>
    <span><label htmlFor={id} title={hint}>{definition.label}{scope}</label><span className="colour-control-actions">
      <output>{colour ? <>{value > 0 && neutral === 0 ? '+' : ''}{value.toFixed(colour.key === 'hue' ? 0 : 2)}<small>{colour.unit}</small></> : `${Math.round(value * 100)}%`}</output>
      {actions}
      {neutral !== null && <button type="button" className="icon-button" aria-label={`Reset ${name}`} title={resetTitle ?? hint} disabled={disabled || value === neutral} onClick={() => onCommit(neutral)}><Icon name="reset" size={13} /></button>}
    </span></span>
    <input id={id} type="range" aria-label={name} aria-describedby={`${id}-hint`} min={definition.min} max={definition.max} step={definition.step} value={value} disabled={disabled} title={hint} onChange={(event) => onCommit(Number(event.target.value))} />
    <span id={`${id}-hint`} className="declutter-sr-only">{hint}</span>
    {exact && <NumberField aria-label={name} aria-describedby={`${id}-hint`} min={definition.min} max={definition.max} step={definition.step} value={value} disabled={disabled} {...exact} onCommit={onCommit} />}
  </>;
}

/** A row Speed participant is a rate, never a clip mode or source-time curve. */
export function SpeedRateField(props: Readonly<Omit<NumberFieldProps, 'min' | 'max' | 'step'>>) {
  return <label className="speed-field" htmlFor={props.id}>Layer rate ×<NumberField {...props} min={0.1} max={8} step={0.05} /></label>;
}
