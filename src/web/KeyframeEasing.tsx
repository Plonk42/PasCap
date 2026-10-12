import { useId, useState } from 'react';
import { agreedEasing, type Interpolation } from '../shared/keyframes.js';
import { EasingSelect } from './EasingSelect.js';

interface Props<K extends string> {
  /** Accessible name of the select applying to every setting. */
  label: string;
  settingLabel: (setting: string) => string;
  /** Enabled settings in control order. */
  settings: readonly { key: K; label: string }[];
  /** Enabled settings keyed again later; when none, every enabled setting is listed. */
  continuing: readonly K[];
  easing: Readonly<Record<K, Interpolation | null>>;
  disabled: boolean;
  title?: string;
  describedBy?: string;
  onChange: (setting: K | null, value: Interpolation) => void;
}

/** One Easing for the whole keyframe, with per-setting choices revealed only when useful. */
export function KeyframeEasing<K extends string>({
  label,
  settingLabel,
  settings,
  continuing,
  easing,
  disabled,
  title,
  describedBy,
  onChange,
}: Readonly<Props<K>>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const shown = continuing.length ? settings.filter((setting) => continuing.includes(setting.key)) : settings;
  const agreed = agreedEasing(
    easing,
    shown.map((setting) => setting.key),
  );
  const perSetting = shown.length > 1;
  const expanded = perSetting && (open || agreed === null);
  return (
    <>
      <div className="keyframe-easing">
        <span className="keyframe-easing-heading">
          <label htmlFor={`${id}-all`}>Easing</label>
          {perSetting && agreed !== null && (
            <button
              type="button"
              className="text-button"
              aria-expanded={expanded}
              aria-controls={`${id}-settings`}
              aria-label={`Easing per setting · ${label}`}
              title="Choose a different Easing for each setting"
              disabled={disabled}
              onClick={() => setOpen(!open)}
            >
              Per setting
            </button>
          )}
        </span>
        <EasingSelect
          id={`${id}-all`}
          aria-label={label}
          aria-describedby={describedBy}
          title={title}
          disabled={disabled}
          value={agreed}
          onChange={(value) => onChange(null, value)}
        />
      </div>
      {expanded && (
        <ul id={`${id}-settings`} className="keyframe-easing-settings" aria-label={`Easing per setting · ${label}`}>
          {shown.map((setting) => (
            <li key={setting.key}>
              <label htmlFor={`${id}-${setting.key}`}>{setting.label}</label>
              <EasingSelect
                compact
                id={`${id}-${setting.key}`}
                aria-label={settingLabel(setting.label)}
                aria-describedby={describedBy}
                disabled={disabled}
                value={easing[setting.key] ?? 'linear'}
                onChange={(value) => onChange(setting.key, value)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
