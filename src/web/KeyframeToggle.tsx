import { useId } from 'react';
import type { EditCommand } from '../shared/commands.js';
import type { ScalarColourSetting } from '../shared/colour.js';
import { activeLayerSetting, hasLayerKeys, isKeyframeFrame } from '../shared/keyframes.js';
import { ChannelKeyframeNavigation } from './AnimationControls.js';
import { isClipOwner, ownerTarget, type ColourOwner } from './colour-owner.js';
import './layer-keyframes.css';
import './keyframe-navigation.css';
import { useKeyframeNavigation } from './keyframe-navigation.js';

export interface KeyframeToggleProps {
  layer: ColourOwner;
  setting: ScalarColourSetting;
  label: string;
  frame: number;
  value: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

/** The diamond's title and description, for a clip grade's keyframes or an adjustment's. */
function toggleWording(layer: ColourOwner, label: string, frame: number, state: { active: boolean; valid: boolean }) {
  const clip = isClipOwner(layer);
  const owner = clip
    ? { scope: 'clip', at: 'source frame', whole: 'clip' }
    : { scope: 'adjustment', at: 'frame', whole: 'adjustment' };
  let title = `Keyframe ${label} at frame ${frame} of ${layer.name}. Capture the displayed value; the keyframe moves with the adjustment.`;
  if (clip)
    title = `Keyframe ${label} at source frame ${frame}. Capture the displayed value for ${layer.name}; the keyframe stays with its footage.`;
  if (state.active)
    title = `Remove ${label} from the ${owner.scope} keyframe at ${owner.at} ${frame}. Other settings at this keyframe stay unchanged.`;
  if (!state.valid)
    title =
      clip && frame < 0
        ? 'Move the playhead onto this clip to capture a keyframe.'
        : 'Move the playhead onto this adjustment to capture a keyframe.';
  return {
    title,
    animated: `This setting follows the whole ${owner.whole}’s animation curve. Capture a keyframe at the playhead before editing between keyframes.`,
    still: `Not animated. The diamond captures the displayed value to animate this setting on the whole ${owner.whole}.`,
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
