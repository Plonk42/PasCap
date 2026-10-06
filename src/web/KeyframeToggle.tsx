import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import {
  activeLayerSetting,
  hasLayerKeys,
  isKeyframeFrame,
  keyframeNeighbors,
  type KeyframeSetting,
} from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';
import './layer-keyframes.css';
import './keyframe-navigation.css';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, keySeekHint, useKeyframeNavigation } from './keyframe-navigation.js';

export interface KeyframeToggleProps {
  layer: VideoLayer;
  setting: KeyframeSetting;
  label: string;
  frame: number;
  value: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

/** A setting joins/leaves a shared layer point; an inactive diamond is still an action. */
export function KeyframeToggle({
  layer,
  setting,
  label,
  frame,
  value,
  disabled,
  onEdit,
}: Readonly<KeyframeToggleProps>) {
  const descriptionId = useId();
  const navigation = useKeyframeNavigation();
  const unavailable = disabled || navigation.disabled;
  const active = activeLayerSetting(layer, setting, frame);
  const animated = hasLayerKeys(layer, setting);
  const valid = isKeyframeFrame(frame) && Number.isFinite(value);
  const { previous, next } = keyframeNeighbors(
    layer.keyframes,
    keyframeNavigationFrame(navigation.inspection, layer.id, frame),
    setting,
  );
  const title = active
    ? `Remove ${label} from the shared point at timeline frame ${frame}. Other settings at this point stay unchanged.`
    : `Keyframe ${label} at timeline frame ${frame}. Capture the displayed value for the whole video row ${layer.name}.`;
  const toggle = (): void => {
    if (unavailable || !valid) return;
    onEdit({ type: 'layer-key-toggle', layerId: layer.id, frame, setting, value });
  };

  return (
    <span className="keyframe-setting-navigation" data-animated={animated}>
      <button
        type="button"
        className={`keyframe-toggle${active ? ' active' : ''}`}
        aria-label={`Keyframe ${label}`}
        aria-pressed={active}
        aria-describedby={descriptionId}
        title={valid ? title : 'A valid timeline frame and value are required to key this setting.'}
        disabled={unavailable || !valid}
        onClick={toggle}
      >
        <span aria-hidden="true">{active ? '◆' : '◇'}</span>
        <span id={descriptionId} className="declutter-sr-only">
          {animated
            ? 'This setting follows the whole row’s animation curve. Capture a key at the playhead before editing between points.'
            : 'This setting uses its static base. The diamond captures that value for the whole video row.'}
        </span>
      </button>
      <button
        type="button"
        className="icon-button keyframe-setting-step"
        aria-label={`Previous ${label} keyframe`}
        title={
          previous
            ? keySeekHint(previous.frame, navigation.duration)
            : `No previous ${label} keyframe on ${layer.name}.`
        }
        disabled={unavailable || !previous}
        onClick={() => {
          if (!unavailable && previous) navigation.onSeekKeyframe(layer.id, previous.frame);
        }}
      >
        <Icon name="back" size={14} />
      </button>
      <button
        type="button"
        className="icon-button keyframe-setting-step"
        aria-label={`Next ${label} keyframe`}
        title={next ? keySeekHint(next.frame, navigation.duration) : `No next ${label} keyframe on ${layer.name}.`}
        disabled={unavailable || !next}
        onClick={() => {
          if (!unavailable && next) navigation.onSeekKeyframe(layer.id, next.frame);
        }}
      >
        <Icon name="forward" size={14} />
      </button>
    </span>
  );
}
