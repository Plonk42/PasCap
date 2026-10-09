import type { ReactNode } from 'react';
import { keyframeNeighbors, type KeyframeSetting } from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, keySeekHint, useKeyframeNavigation } from './keyframe-navigation.js';
import './animation-controls.css';

/** Previous/Next over the keyframes a section header counts. */
export function KeyframeSteps({
  label,
  disabled,
  previous,
  next,
  onPrevious,
  onNext,
}: Readonly<{
  label: string;
  disabled: boolean;
  previous: boolean;
  next: boolean;
  onPrevious: () => void;
  onNext: () => void;
}>) {
  return (
    <span className="section-keyframe-steps">
      <button
        type="button"
        className="icon-button"
        aria-label={`Previous ${label} keyframe`}
        disabled={disabled || !previous}
        onClick={onPrevious}
      >
        <Icon name="back" size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Next ${label} keyframe`}
        disabled={disabled || !next}
        onClick={onNext}
      >
        <Icon name="forward" size={14} />
      </button>
    </span>
  );
}

export function keyframeCount(count: number): string {
  return `${count} ${count === 1 ? 'keyframe' : 'keyframes'}`;
}

/** The expanded section's keyframe line: count, Previous/Next and the section's keyframe reset. */
export function KeyframeLine({
  count,
  children,
  ...steps
}: Readonly<Parameters<typeof KeyframeSteps>[0] & { count: number; children?: ReactNode }>) {
  return (
    <div className="section-keyframe-line">
      <span className="section-keyframe-count">{keyframeCount(count)}</span>
      <KeyframeSteps {...steps} />
      {children}
    </div>
  );
}

export function TrackAnimationControls({
  label,
  layer,
  frame,
  settings,
  disabled,
  children,
}: Readonly<{
  label: string;
  layer: VideoLayer;
  frame: number;
  settings: readonly KeyframeSetting[];
  disabled: boolean;
  children?: ReactNode;
}>) {
  const navigation = useKeyframeNavigation();
  const keys = layer.keyframes.filter((key) => settings.some((setting) => key.values[setting] !== null));
  const { previous, next } = keyframeNeighbors(keys, keyframeNavigationFrame(navigation.inspection, layer.id, frame));
  return (
    <KeyframeLine
      label={label}
      count={keys.length}
      disabled={disabled || navigation.disabled}
      previous={!!previous}
      next={!!next}
      onPrevious={() => {
        if (previous) navigation.onSeekKeyframe(layer.id, previous.frame);
      }}
      onNext={() => {
        if (next) navigation.onSeekKeyframe(layer.id, next.frame);
      }}
    >
      {children}
    </KeyframeLine>
  );
}

/** Main diamonds and stored enabled-setting chips share channel-only navigation. */
export function ChannelKeyframeNavigation({
  layer,
  frame,
  setting,
  label,
  disabled,
}: Readonly<{
  layer: VideoLayer;
  frame: number;
  setting: KeyframeSetting;
  label: string;
  disabled: boolean;
}>) {
  const navigation = useKeyframeNavigation();
  const { previous, next } = keyframeNeighbors(
    layer.keyframes,
    keyframeNavigationFrame(navigation.inspection, layer.id, frame),
    setting,
  );
  return (
    <span className="channel-keyframe-navigation">
      <button
        type="button"
        className="icon-button"
        aria-label={`Previous ${label} keyframe`}
        title={previous ? keySeekHint(previous.frame, navigation.duration) : `No previous ${label} keyframe`}
        aria-disabled={disabled || navigation.disabled || !previous}
        tabIndex={disabled || navigation.disabled || !previous ? -1 : 0}
        onClick={() => {
          if (previous && !disabled && !navigation.disabled) navigation.onSeekKeyframe(layer.id, previous.frame);
        }}
      >
        <Icon name="back" size={12} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Next ${label} keyframe`}
        title={next ? keySeekHint(next.frame, navigation.duration) : `No next ${label} keyframe`}
        aria-disabled={disabled || navigation.disabled || !next}
        tabIndex={disabled || navigation.disabled || !next ? -1 : 0}
        onClick={() => {
          if (next && !disabled && !navigation.disabled) navigation.onSeekKeyframe(layer.id, next.frame);
        }}
      >
        <Icon name="forward" size={12} />
      </button>
    </span>
  );
}
