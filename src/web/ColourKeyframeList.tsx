import { isClipOwner, ownerNoun, ownerTarget } from './colour-owner.js';
import { useId } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import {
  continuingSettings,
  KEYFRAME_SETTINGS,
  keyframeNeighbors,
  keySettings,
  type KeyframeSetting,
  type LayerKeyframe,
} from '../shared/keyframes.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, useKeyframeNavigation } from './keyframe-navigation.js';
import { livePreview } from './live-preview.js';
import { RangeSettingControl } from './SettingValueControl.js';
import { StoredKeyframeList, type StoredKeyframeKind } from './StoredKeyframeList.js';

const SETTING_KEYS = KEYFRAME_SETTINGS.map((setting) => setting.key);

interface Props {
  project: ProjectDocument;
  layer: VideoLayer;
  frame: number;
  duration: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

function AnimationHelp({ id, clip }: Readonly<{ id: string; clip: boolean }>) {
  return (
    <HelpPopover label="Animation" className="animation-help" guide="opt-in-to-shared-video-track-animation">
      <p id={id}>
        Each diamond adds a keyframe for that setting on the whole {clip ? 'clip, on the footage shown' : 'track'}, at
        the playhead. Settings keyed together share one keyframe; each can have its own easing.
      </p>
      <div className="animation-legend">
        <span>
          <span aria-hidden="true">◇</span>Not animated · click to capture
        </span>
        <span>
          <span aria-hidden="true" className="animation-legend-animated">
            ◇
          </span>{' '}
          Animated (dashed) · capture before editing
        </span>
        <span>
          <span aria-hidden="true">◆</span>Keyframe at playhead · editable
        </span>
        <span>
          <Icon name="default-key" size={14} />
          Default keyframe · settings return to their defaults
        </span>
      </div>
      <p className="editor-help-tip">Tip: drag a timeline keyframe to move all its settings.</p>
    </HelpPopover>
  );
}

/** Colour's stored keyframes (track or clip grade), through the shared central inspection cursor. */
export function ColourKeyframeList({ project, layer, frame, duration, disabled, onEdit }: Readonly<Props>) {
  const navigation = useKeyframeNavigation();
  const unavailable = disabled || navigation.disabled;
  const valueId = useId();
  const helpId = `${valueId}-help`;
  const keys = layer.keyframes;
  const inspection =
    navigation.inspection?.projectId === project.id && navigation.inspection.layerId === layer.id
      ? navigation.inspection
      : null;
  const previewAvailable = Number.isInteger(frame) && frame >= 0 && frame < duration;
  const pointAtFrame = keys.find((key) => key.frame === frame);
  const inspected =
    keys.find((key) => key.frame === inspection?.frame) ?? (previewAvailable ? undefined : pointAtFrame);
  const navigationFrame = keyframeNavigationFrame(inspection, layer.id, frame);
  const current = inspection !== null || previewAvailable ? navigationFrame : null;
  const context = `${project.id}:${layer.id}`;
  const kind: StoredKeyframeKind<KeyframeSetting, LayerKeyframe> = {
    noun: ownerNoun(layer),
    title: isClipOwner(layer) ? 'Clip keyframes' : 'Track keyframes',
    frameNoun: isClipOwner(layer) ? 'source' : 'timeline',
    settings: KEYFRAME_SETTINGS,
    enabled: keySettings,
    continuing: (key) => continuingSettings(keys, key, SETTING_KEYS),
    neighbours: (key, setting) => {
      const { previous, next } = keyframeNeighbors(
        keys,
        keyframeNavigationFrame(navigation.inspection, layer.id, key.frame),
        setting,
      );
      return { previous: previous?.frame, next: next?.frame };
    },
    seek: (target) => {
      if (!unavailable) navigation.onSeekKeyframe(layer.id, target);
    },
    validateFrame: (key, value) =>
      keys.some((other) => other.frame !== key.frame && other.frame === value)
        ? `Frame ${value} already has a shared keyframe. Choose a different frame.`
        : null,
    moveFrame: (key, nextFrame) =>
      onEdit({ type: 'layer-key-move', ...ownerTarget(layer), frame: key.frame, nextFrame }),
    setEasing: (key, setting, interpolation) =>
      onEdit({ type: 'layer-key-easing', ...ownerTarget(layer), frame: key.frame, setting, interpolation }),
    remove: (key) => onEdit({ type: 'layer-key-remove', ...ownerTarget(layer), frame: key.frame }),
    removeTitle: 'Remove this whole shared keyframe and all its animated settings',
    renderValues: (key, row) =>
      KEYFRAME_SETTINGS.map((setting) => {
        const value = key.values[setting.key];
        if (value === null) return null;
        const command = (nextValue: number): EditCommand => ({
          type: 'layer-key-value',
          ...ownerTarget(layer),
          frame: key.frame,
          setting: setting.key,
          value: nextValue,
        });
        const validate = (nextValue: number): string | null => {
          try {
            applyCommand(project, command(nextValue));
            return null;
          } catch (cause) {
            return cause instanceof Error ? cause.message : 'This value conflicts with the track timing.';
          }
        };
        return (
          <div className="keyframe-value colour-control" key={setting.key}>
            <RangeSettingControl
              setting={setting.key}
              id={`${valueId}-${row}-${setting.key}`}
              label={`${setting.label} keyframe value ${key.frame}`}
              value={value}
              disabled={unavailable}
              hint={`${setting.label} at stored ${isClipOwner(layer) ? 'source' : 'timeline'} frame ${key.frame} on ${layer.name}. Edits change only this setting's keyframe value, not the playhead, Easing or unanimated settings.`}
              exact={{ resetKey: `${context}:${row}:${setting.key}`, validate }}
              onCommit={(nextValue) => {
                if (!unavailable) onEdit(command(nextValue));
              }}
              onDraft={(next) => livePreview(next === null ? null : command(next))}
            />
          </div>
        );
      }),
  };
  return (
    <StoredKeyframeList
      kind={kind}
      trackName={layer.name}
      keys={keys}
      context={context}
      frame={frame}
      duration={duration}
      inspected={inspected}
      current={current}
      disabled={unavailable}
      help={<AnimationHelp id={helpId} clip={isClipOwner(layer)} />}
      describedBy={helpId}
      {...(inspection ? { onFollowPlayhead: navigation.onFollowPlayhead } : {})}
    />
  );
}
