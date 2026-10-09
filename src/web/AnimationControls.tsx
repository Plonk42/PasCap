import { useState } from 'react';
import { keyframeNeighbors, type KeyframeSetting } from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, keySeekHint, useKeyframeNavigation } from './keyframe-navigation.js';
import { readPreference, writePreference } from './preferences.js';
import './animation-controls.css';

export type AnimationSection = 'colour' | 'speed' | 'transform';

/** Presentation only: hiding animation tools never changes bases or stored keys. */
export function useAnimationTools(section: AnimationSection, context: string, animated: boolean) {
  const initial = () => {
    const saved = readPreference(`pascap-animate-${section}`);
    return saved === null ? animated : saved === 'on';
  };
  const [state, setState] = useState(() => ({ context, enabled: initial(), warning: false }));
  let current = state;
  if (state.context !== context) {
    current = { context, enabled: initial(), warning: false };
    setState(current);
  }
  return {
    ...current,
    toggle: () => {
      const enabled = !current.enabled;
      const warning = !writePreference(`pascap-animate-${section}`, enabled ? 'on' : 'off');
      setState({ context, enabled, warning });
    },
  };
}

export function AnimationControls({
  label,
  enabled,
  disabled,
  onToggle,
  previous,
  next,
  onPrevious,
  onNext,
}: Readonly<{
  label: string;
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
  previous: boolean;
  next: boolean;
  onPrevious: () => void;
  onNext: () => void;
}>) {
  return (
    <div className="section-animation-controls">
      <button
        type="button"
        className="text-button section-animate"
        aria-label={`Animate ${label}`}
        aria-pressed={enabled}
        disabled={disabled}
        onClick={onToggle}
        title="Show or hide animation tools; existing keyframes keep applying"
      >
        <Icon name="curve" size={13} />
        Animate
      </button>
      {enabled && (
        <>
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
        </>
      )}
    </div>
  );
}

export function TrackAnimationControls({
  label,
  layer,
  frame,
  settings,
  tools,
  disabled,
}: Readonly<{
  label: string;
  layer: VideoLayer;
  frame: number;
  settings: readonly KeyframeSetting[];
  tools: ReturnType<typeof useAnimationTools>;
  disabled: boolean;
}>) {
  const navigation = useKeyframeNavigation();
  const keys = layer.keyframes.filter((key) => settings.some((setting) => key.values[setting] !== null));
  const { previous, next } = keyframeNeighbors(keys, keyframeNavigationFrame(navigation.inspection, layer.id, frame));
  return (
    <AnimationControls
      label={label}
      enabled={tools.enabled}
      disabled={disabled || navigation.disabled}
      onToggle={tools.toggle}
      previous={!!previous}
      next={!!next}
      onPrevious={() => {
        if (previous) navigation.onSeekKeyframe(layer.id, previous.frame);
      }}
      onNext={() => {
        if (next) navigation.onSeekKeyframe(layer.id, next.frame);
      }}
    />
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
