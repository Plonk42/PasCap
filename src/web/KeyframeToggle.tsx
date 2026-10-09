import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { activeLayerSetting, hasLayerKeys, isKeyframeFrame, type KeyframeSetting } from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';
import { ChannelKeyframeNavigation } from './AnimationControls.js';
import './layer-keyframes.css';
import './keyframe-navigation.css';
import { useKeyframeNavigation } from './keyframe-navigation.js';

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
  const title = active
    ? `Remove ${label} from the shared keyframe at timeline frame ${frame}. Other settings at this keyframe stay unchanged.`
    : `Keyframe ${label} at timeline frame ${frame}. Capture the displayed value for the whole video track ${layer.name}.`;
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
        title={valid ? title : 'A valid timeline frame and value are required to capture a keyframe for this setting.'}
        disabled={unavailable || !valid}
        onClick={toggle}
      >
        <span aria-hidden="true">{active ? '◆' : '◇'}</span>
        <span id={descriptionId} className="declutter-sr-only">
          {animated
            ? 'This setting follows the whole track’s animation curve. Capture a keyframe at the playhead before editing between keyframes.'
            : 'Not animated. The diamond captures the displayed value to animate this setting on the whole video track.'}
        </span>
      </button>
      <ChannelKeyframeNavigation layer={layer} setting={setting} label={label} frame={frame} disabled={disabled} />
    </span>
  );
}
