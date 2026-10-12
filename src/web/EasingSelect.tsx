import { useId, type SelectHTMLAttributes } from 'react';
import { interpolatedProgress, type Interpolation } from '../shared/keyframes.js';
import './easing-select.css';

const SHAPES = [
  { value: 'hold', label: 'Hold', description: 'Keep the starting value, then jump at the next keyframe.' },
  { value: 'linear', label: 'Linear', description: 'Change at a steady rate.' },
  { value: 'ease-in', label: 'Ease in', description: 'Start slowly, then change faster.' },
  { value: 'ease-out', label: 'Ease out', description: 'Start quickly, then change more slowly.' },
  { value: 'smooth', label: 'Smooth', description: 'Start and finish slowly, with a faster middle.' },
] as const;

/** Samples the authoritative progress function; Hold jumps exactly at the next point. */
export function easingGraphPoints(curve: Interpolation): string {
  const points = Array.from({ length: 33 }, (_, index) => {
    const progress = index / 32;
    return `${6 + progress * 84},${50 - interpolatedProgress(progress, curve) * 44}`;
  });
  if (curve === 'hold') points.push('90,6');
  return points.join(' ');
}

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children' | 'multiple'> {
  /** Null shows Mixed: the settings it applies to use different easings. */
  value: Interpolation | null;
  onChange: (value: Interpolation) => void;
  compact?: boolean;
}

const MIXED = 'Mixed: these settings use different easings. Choosing one applies it to all of them.';

/** A native selector with supplementary feedback, not a custom option menu. */
export function EasingSelect({ value, onChange, compact = false, ...props }: Readonly<Props>) {
  const descriptionId = useId();
  const shape = SHAPES.find((item) => item.value === value);
  const description = shape
    ? `${shape.label}: ${shape.description} Graph: time runs left to right; value progress runs bottom to top.`
    : MIXED;
  return (
    <span className={compact ? 'easing-choice compact' : 'easing-choice'} data-easing={value ?? 'mixed'}>
      <select
        {...props}
        value={value ?? ''}
        aria-describedby={[props['aria-describedby'], descriptionId].filter(Boolean).join(' ')}
        onChange={(event) => onChange(event.currentTarget.value as Interpolation)}
      >
        {value === null && (
          <option value="" disabled hidden>
            Mixed
          </option>
        )}
        {SHAPES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      {value !== null && (
        <svg className="easing-graph" viewBox="0 0 96 56" aria-hidden="true" focusable="false">
          <title>{description}</title>
          <path className="easing-graph-axes" d="M6 6V50H90" />
          <polyline points={easingGraphPoints(value)} />
        </svg>
      )}
      <span id={descriptionId} className="easing-description">
        {description}
      </span>
    </span>
  );
}
