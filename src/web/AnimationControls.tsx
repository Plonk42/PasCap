import type { ReactNode } from 'react';
import { keyframeNeighbors, type KeyframeSetting } from '../shared/keyframes.js';
import type { ColourOwner } from './colour-owner.js';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, keySeekHint, useKeyframeNavigation } from './keyframe-navigation.js';
import './animation-controls.css';

/** Previous/Next over the keyframes a section header counts. */
export function KeyframeSteps({
  label,
  disabled,
  previous,
  next,
  previousTitle,
  nextTitle,
  onPrevious,
  onNext,
}: Readonly<{
  label: string;
  disabled: boolean;
  previous: boolean;
  next: boolean;
  previousTitle?: string;
  nextTitle?: string;
  onPrevious: () => void;
  onNext: () => void;
}>) {
  return (
    <span className="section-keyframe-steps">
      <button
        type="button"
        className="icon-button"
        aria-label={`Previous ${label} keyframe`}
        title={previousTitle}
        disabled={disabled || !previous}
        onClick={onPrevious}
      >
        <Icon name="back" size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Next ${label} keyframe`}
        title={nextTitle}
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
  layer: ColourOwner;
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
      previousTitle={
        previous
          ? keySeekHint(previous.frame, navigation.duration, navigation.frameNoun)
          : `No previous ${label} keyframe`
      }
      nextTitle={
        next ? keySeekHint(next.frame, navigation.duration, navigation.frameNoun) : `No next ${label} keyframe`
      }
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

/** One setting's Previous/Next keyframe arrows: beside main capture buttons and on stored setting chips. */
export function ChannelSteps({
  label,
  previous,
  next,
  duration,
  frameNoun,
  disabled,
  onSeek,
}: Readonly<{
  label: string;
  previous: number | undefined;
  next: number | undefined;
  duration: number;
  frameNoun?: string | undefined;
  disabled: boolean;
  onSeek: (frame: number) => void;
}>) {
  return (
    <span className="channel-keyframe-navigation">
      <button
        type="button"
        className="icon-button"
        aria-label={`Previous ${label} keyframe`}
        title={previous === undefined ? `No previous ${label} keyframe` : keySeekHint(previous, duration, frameNoun)}
        aria-disabled={disabled || previous === undefined}
        tabIndex={disabled || previous === undefined ? -1 : 0}
        onClick={() => {
          if (previous !== undefined && !disabled) onSeek(previous);
        }}
      >
        <Icon name="back" size={12} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Next ${label} keyframe`}
        title={next === undefined ? `No next ${label} keyframe` : keySeekHint(next, duration, frameNoun)}
        aria-disabled={disabled || next === undefined}
        tabIndex={disabled || next === undefined ? -1 : 0}
        onClick={() => {
          if (next !== undefined && !disabled) onSeek(next);
        }}
      >
        <Icon name="forward" size={12} />
      </button>
    </span>
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
  layer: ColourOwner;
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
    <ChannelSteps
      label={label}
      previous={previous?.frame}
      next={next?.frame}
      duration={navigation.duration}
      frameNoun={navigation.frameNoun}
      disabled={disabled || navigation.disabled}
      onSeek={(target) => navigation.onSeekKeyframe(layer.id, target)}
    />
  );
}
