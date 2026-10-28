import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { activeLayerSetting, hasLayerKeys, isKeyframeFrame, type KeyframeSetting } from '../shared/keyframes.js';
import type { VideoLayer } from '../shared/model.js';
import { ChannelKeyframeNavigation } from './AnimationControls.js';
import { isClipOwner, ownerTarget } from './colour-owner.js';
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

/** The diamond's title and description, for a track's shared keyframes or a clip grade's own. */
function toggleWording(layer: VideoLayer, label: string, frame: number, state: { active: boolean; valid: boolean }) {
  const clip = isClipOwner(layer);
  const owner = clip
    ? { scope: 'clip', at: 'source', whole: 'clip' }
    : { scope: 'shared', at: 'timeline', whole: 'track' };
  let title = `Keyframe ${label} at timeline frame ${frame}. Capture the displayed value for the whole video track ${layer.name}.`;
  if (clip)
    title = `Keyframe ${label} at source frame ${frame}. Capture the displayed value for ${layer.name}; the keyframe stays with its footage.`;
  if (state.active)
    title = `Remove ${label} from the ${owner.scope} keyframe at ${owner.at} frame ${frame}. Other settings at this keyframe stay unchanged.`;
  if (!state.valid)
    title =
      clip && frame < 0
        ? 'Move the playhead onto this clip to capture a keyframe.'
        : 'A valid timeline frame and value are required to capture a keyframe for this setting.';
  return {
    title,
    animated: `This setting follows the whole ${owner.whole}’s animation curve. Capture a keyframe at the playhead before editing between keyframes.`,
    still: `Not animated. The diamond captures the displayed value to animate this setting on the whole ${clip ? 'clip' : 'video track'}.`,
  };
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
  const wording = toggleWording(layer, label, frame, { active, valid });
  const toggle = (): void => {
    if (unavailable || !valid) return;
    onEdit({ type: 'layer-key-toggle', ...ownerTarget(layer), frame, setting, value });
  };

  return (
    <span className="keyframe-setting-navigation" data-animated={animated}>
      <button
        type="button"
        className={`keyframe-toggle${active ? ' active' : ''}`}
        aria-label={`Keyframe ${label}`}
        aria-pressed={active}
        aria-describedby={descriptionId}
        title={wording.title}
        disabled={unavailable || !valid}
        onClick={toggle}
      >
        <span aria-hidden="true">{active ? '◆' : '◇'}</span>
        <span id={descriptionId} className="sr-only">
          {animated ? wording.animated : wording.still}
        </span>
      </button>
      <ChannelKeyframeNavigation layer={layer} setting={setting} label={label} frame={frame} disabled={disabled} />
    </span>
  );
}
