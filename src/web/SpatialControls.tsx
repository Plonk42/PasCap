import { useId, useState, type ReactNode } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { continuingSettings, isKeyframeFrame } from '../shared/keyframes.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';
import {
  evaluateSpatial,
  hasSpatialChannelKeys,
  hasSpatialEdits,
  NEUTRAL_SPATIAL_POSE,
  SPATIAL_CHANNELS,
  spatialKeyChannels,
  type SpatialChannel,
  type SpatialKeyframe,
  type SpatialSettings,
} from '../shared/spatial.js';
import { ChannelSteps, KeyframeSteps, keyframeCount } from './AnimationControls.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { useKeyframeNavigation } from './keyframe-navigation.js';
import './keyframe-navigation.css';
import './layer-keyframes.css';
import { livePreview } from './live-preview.js';
import './spatial-editor.css';
import {
  editSpatialPose,
  removeSpatialKey,
  replaceSpatialKey,
  resetSpatial,
  setSpatialEasing,
  SPATIAL_CONTROLS,
  toggleDefaultSpatialKey,
  toggleSpatialChannel,
} from './spatial-editor.js';
import {
  inspectSpatialKeyframe,
  reconcileSpatialInspection,
  trackTransformKeyframes,
  type SpatialInspection,
} from './spatial-navigation.js';
import { LockedCue, ResetLabel, resetBlocked } from './SettingValueControl.js';
import { StoredKeyframeList, type StoredKeyframeKind } from './StoredKeyframeList.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  layer: VideoLayer;
  /** The real playhead: main values and capture always use it. */
  frame: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onSeek: (frame: number) => void;
  selectedFrame?: number | null;
  /** The stored keyframe Transform's own cursor inspects, if any. */
  inspectedFrame?: number | null;
  onSelectStored?: (frame: number) => void;
  onFollowPlayhead?: () => void;
  steps?: ReactNode;
}

interface ChannelKeys {
  keyed: boolean;
  active: boolean;
  previous: SpatialKeyframe | undefined;
  next: SpatialKeyframe | undefined;
  captureDisabled: boolean;
  onToggle: () => void;
  onSeek: (key: SpatialKeyframe) => void;
}

/** One channel's capture triangle and Previous/Next, matching the Colour setting controls. */
function SpatialChannelKeys({
  label,
  frame,
  duration,
  keys,
  disabled,
}: Readonly<{ label: string; frame: number; duration: number; keys: ChannelKeys; disabled: boolean }>) {
  const { keyed, active, previous, next } = keys;
  return (
    <span className="keyframe-setting-navigation" data-animated={keyed}>
      <button
        type="button"
        className={`keyframe-toggle transform-keyframe-toggle${active ? ' active' : ''}`}
        aria-label={`Keyframe ${label}`}
        aria-pressed={active}
        title={
          active
            ? `Remove ${label} from the Transform keyframe at timeline frame ${frame}. Other settings at this keyframe stay unchanged.`
            : `Keyframe ${label} at timeline frame ${frame}. Capture the displayed value for the whole video track.`
        }
        disabled={disabled || keys.captureDisabled}
        onClick={keys.onToggle}
      >
        <span aria-hidden="true">{active ? '▼' : '▽'}</span>
      </button>
      <ChannelSteps
        label={label}
        previous={previous?.frame}
        next={next?.frame}
        duration={duration}
        disabled={disabled}
        onSeek={(target) => {
          const key = previous?.frame === target ? previous : next;
          if (key) keys.onSeek(key);
        }}
      />
    </span>
  );
}

/** Eight settings with the Colour pattern: a capture button and arrows each, read-only until captured. */
function PoseFields({
  values,
  label,
  resetName = (setting) => setting,
  context,
  disabled,
  readOnly,
  channels,
  keysFor,
  frame,
  duration,
  validate,
  onCommit,
  onDraft,
  onReset,
}: Readonly<{
  values: Readonly<Record<SpatialChannel, number>>;
  label: (setting: string) => string;
  resetName?: (setting: string) => string;
  context: string;
  disabled: boolean;
  /** Channels that cannot be edited here (animated without a key at this frame). */
  readOnly?: (channel: SpatialChannel) => boolean;
  channels?: readonly SpatialChannel[];
  keysFor?: ((channel: SpatialChannel) => ChannelKeys) | undefined;
  frame: number;
  duration: number;
  validate: (key: SpatialChannel, value: number) => string | null;
  onCommit: (key: SpatialChannel, value: number) => void;
  onDraft: (key: SpatialChannel, value: number | null) => void;
  onReset?: (key: SpatialChannel) => void;
}>) {
  const id = useId();
  return (
    <div className="spatial-pose-fields">
      {SPATIAL_CONTROLS.filter((control) => !channels || channels.includes(control.key)).map((control) => {
        const fieldId = `${id}-${control.key}`;
        const keys = keysFor?.(control.key);
        const locked = disabled || (readOnly?.(control.key) ?? false);
        const unit = control.key === 'rotation' ? ' °' : '';
        const scale = control.display?.scale ?? 1;
        return (
          <div
            className="colour-control layer-keyed-control spatial-pose-field"
            key={control.key}
            data-animated={keys?.keyed ?? false}
            data-key-at-playhead={keys?.active ?? false}
          >
            <span>
              <ResetLabel
                htmlFor={fieldId}
                title={`Double-click to reset ${control.label}`}
                name={resetName(control.label)}
                blocked={resetBlocked(
                  values[control.key] === NEUTRAL_SPATIAL_POSE[control.key],
                  locked || !onReset,
                  readOnly?.(control.key) ?? false,
                )}
                onReset={() => onReset?.(control.key)}
              >
                {control.label}
                {unit}
              </ResetLabel>
              {readOnly?.(control.key) && <LockedCue glyph="▽" className="transform" />}
              {keys && (
                <span className="colour-control-actions">
                  <SpatialChannelKeys
                    label={control.label}
                    frame={frame}
                    duration={duration}
                    keys={keys}
                    disabled={disabled}
                  />
                </span>
              )}
            </span>
            <ValueControl
              id={fieldId}
              aria-label={label(control.label)}
              value={values[control.key] * scale}
              min={control.min * scale}
              max={control.max * scale}
              step={control.step * scale}
              {...(control.display ? { unit: control.display.unit } : {})}
              {...(control.key === 'opacity' ? { tone: 'opacity' as const } : {})}
              disabled={locked}
              resetKey={`${context}:${control.key}`}
              validate={(value) => validate(control.key, value / scale)}
              onCommit={(value) => onCommit(control.key, value / scale)}
              onDraft={(value) => onDraft(control.key, value === null ? null : value / scale)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function TransformHelp() {
  return (
    <HelpPopover label="Transform animation" guide="crop-scale-translate-and-rotate-a-track">
      <p>
        Crop, scale, move, rotate and fade every clip on this track. A setting animates once you add a keyframe for it
        (▽).
      </p>
      <p className="editor-help-tip">Tip: to frame one clip differently, put it on its own track.</p>
    </HelpPopover>
  );
}

export function SpatialControls({
  project,
  layer,
  frame,
  disabled,
  onEdit,
  selectedFrame,
  inspectedFrame,
  onSelectStored,
  onFollowPlayhead,
  steps,
}: Readonly<Omit<Props, 'onSeek'>>) {
  const navigation = useKeyframeNavigation();
  const unavailable = disabled || navigation.disabled;
  const duration = navigation.duration;
  const context = `${project.id}:${layer.id}`;
  const settings = layer.transform;
  const valid = isKeyframeFrame(frame);
  const atFrame = settings.keyframes.find((key) => key.frame === frame);
  const evaluated = evaluateSpatial(settings, valid ? frame : 0);
  const pose = Object.fromEntries(
    SPATIAL_CONTROLS.map(({ key }) => [key, atFrame?.values[key] ?? evaluated[key]]),
  ) as Record<SpatialChannel, number>;
  const channelActive = (channel: SpatialChannel): boolean => atFrame?.values[channel] != null;
  const readOnly = (channel: SpatialChannel): boolean =>
    hasSpatialChannelKeys(settings, channel) && !channelActive(channel);
  const [error, setError] = useState('');
  const command = (transform: SpatialSettings): EditCommand => ({ type: 'transform', layerId: layer.id, transform });
  const validate = (produce: () => SpatialSettings): string | null => {
    try {
      applyCommand(project, command(produce()));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'This Transform is invalid.';
    }
  };
  const change = (produce: () => SpatialSettings): void => {
    if (unavailable) return;
    try {
      const next = command(produce());
      applyCommand(project, next);
      onEdit(next);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This Transform is invalid.');
    }
  };
  const draft = (produce: () => SpatialSettings, value: number | null): void => {
    if (value === null) {
      livePreview(null);
      return;
    }
    try {
      livePreview(command(produce()));
    } catch {
      livePreview(null);
    }
  };
  const seek = (key: SpatialKeyframe): void => {
    if (!unavailable) onSelectStored?.(key.frame);
  };
  // Per-channel arrows step from the inspected stored frame, else the playhead.
  const cursor = selectedFrame ?? frame;
  const keysFor = (channel: SpatialChannel): ChannelKeys => {
    const keyed = settings.keyframes.filter((key) => key.values[channel] !== null);
    return {
      keyed: keyed.length > 0,
      active: channelActive(channel),
      previous: [...keyed].reverse().find((key) => key.frame < cursor),
      next: keyed.find((key) => key.frame > cursor),
      captureDisabled: unavailable || !valid || (!atFrame && settings.keyframes.length >= 256),
      onToggle: () => {
        if (valid) change(() => toggleSpatialChannel(settings, channel, frame));
      },
      onSeek: seek,
    };
  };
  const reset = valid ? resetSpatial(settings, frame) : null;
  const occupied = atFrame !== undefined && !atFrame.reset;
  let defaultTitle =
    'Add a default Transform keyframe here: every Transform setting returns to its default and holds until its next keyframe. Earlier frames keep their values.';
  if (atFrame?.reset) defaultTitle = 'Remove the default Transform keyframe at the playhead';
  else if (atFrame)
    defaultTitle = 'A Transform keyframe already exists at the playhead; move to another frame for a default keyframe';
  const poseAt = (key: SpatialChannel, value: number) => () =>
    editSpatialPose(settings, valid ? frame : null, key, value);
  const storedAt = (stored: SpatialKeyframe, key: SpatialChannel, value: number) => () =>
    replaceSpatialKey(settings, stored.frame, { values: { ...stored.values, [key]: value } });
  const kind: StoredKeyframeKind<SpatialChannel, SpatialKeyframe> = {
    noun: 'Transform',
    title: 'Transform keyframes',
    tone: 'transform-keyframes',
    settings: SPATIAL_CONTROLS,
    enabled: spatialKeyChannels,
    continuing: (key) => continuingSettings(settings.keyframes, key, SPATIAL_CHANNELS),
    neighbours: (key, channel) => {
      const from = inspectedFrame ?? key.frame;
      const keyed = settings.keyframes.filter((other) => other.values[channel] !== null);
      return {
        previous: [...keyed].reverse().find((other) => other.frame < from)?.frame,
        next: keyed.find((other) => other.frame > from)?.frame,
      };
    },
    seek: (target) => {
      if (!unavailable) onSelectStored?.(target);
    },
    validateFrame: (key, value) => validate(() => replaceSpatialKey(settings, key.frame, { frame: value })),
    moveFrame: (key, value) => change(() => replaceSpatialKey(settings, key.frame, { frame: value })),
    setEasing: (key, channel, interpolation) =>
      change(() => setSpatialEasing(settings, key.frame, channel, interpolation)),
    remove: (key) => change(() => removeSpatialKey(settings, key.frame)),
    removeTitle: 'Remove this whole Transform keyframe and all its settings',
    renderValues: (key, row) => (
      <PoseFields
        values={key.values as Record<SpatialChannel, number>}
        channels={spatialKeyChannels(key)}
        label={(setting) => `${setting} keyframe value ${key.frame}`}
        resetName={(setting) => `${setting} keyframe value ${key.frame}`}
        context={`${context}:stored:${row}`}
        disabled={unavailable}
        frame={frame}
        duration={duration}
        validate={(channel, value) => validate(storedAt(key, channel, value))}
        onCommit={(channel, value) => change(storedAt(key, channel, value))}
        onDraft={(channel, value) => draft(storedAt(key, channel, value ?? 0), value)}
        onReset={(channel) => change(storedAt(key, channel, NEUTRAL_SPATIAL_POSE[channel]))}
      />
    ),
  };
  return (
    <section className="spatial-editor" aria-label="Track Transform editor">
      <div className="spatial-tools section-keyframe-line">
        <span className="section-keyframe-count">{keyframeCount(settings.keyframes.length)}</span>
        {steps}
        <button
          type="button"
          className="text-button"
          aria-label="Reset transform"
          title={
            settings.keyframes.length
              ? 'Reset only the enabled Transform settings at this keyframe. Other settings and keyframes stay unchanged.'
              : 'Reset this track’s Transform.'
          }
          disabled={unavailable || reset === null}
          onClick={() => {
            if (reset) change(() => reset);
          }}
        >
          <Icon name="reset" size={13} />
          Reset
        </button>
        <button
          type="button"
          className="icon-button default-keyframe-button transform-default-keyframe-button"
          disabled={unavailable || !valid}
          aria-disabled={occupied || undefined}
          aria-pressed={atFrame?.reset === true}
          aria-label={atFrame?.reset ? 'Remove default Transform keyframe' : 'Add default Transform keyframe'}
          title={defaultTitle}
          onClick={() => {
            if (!occupied) change(() => toggleDefaultSpatialKey(settings, frame));
          }}
        >
          <Icon name="default-key" size={16} />
        </button>
      </div>
      <PoseFields
        values={pose}
        label={(setting) => `Transform ${setting}`}
        context={`${context}:main:${settings.keyframes.length ? frame : 'base'}`}
        disabled={unavailable}
        readOnly={readOnly}
        keysFor={keysFor}
        frame={frame}
        duration={duration}
        validate={(key, value) => validate(poseAt(key, value))}
        onCommit={(key, value) => change(poseAt(key, value))}
        onDraft={(key, value) => draft(poseAt(key, value ?? 0), value)}
        onReset={(key) => change(poseAt(key, NEUTRAL_SPATIAL_POSE[key]))}
      />
      <StoredKeyframeList
        kind={kind}
        trackName={layer.name}
        keys={settings.keyframes}
        context={context}
        frame={frame}
        duration={duration}
        inspected={settings.keyframes.find((key) => key.frame === inspectedFrame)}
        current={selectedFrame ?? null}
        disabled={unavailable}
        {...(onFollowPlayhead && inspectedFrame !== null && inspectedFrame !== undefined ? { onFollowPlayhead } : {})}
      />
      {error && (
        <p className="control-hint" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function TransformSection(
  props: Readonly<Omit<Props, 'selectedFrame' | 'inspectedFrame' | 'onSelectStored' | 'onFollowPlayhead' | 'steps'>>,
) {
  const navigation = useKeyframeNavigation();
  const [selection, setSelection] = useState<SpatialInspection | null>(null);
  const context = `${props.project.id}:${props.layer.id}:${navigation.sourceEpoch ?? 0}:transform`;
  const keys = props.layer.transform.keyframes;
  const stored = trackTransformKeyframes(props.layer, navigation.duration);
  const inspection = reconcileSpatialInspection(
    selection,
    context,
    stored,
    props.frame,
    (navigation.playing ?? false) || navigation.inspection !== null,
  );
  if (inspection !== selection) setSelection(inspection);
  const inspected = inspection?.frame ?? null;
  const at = inspected ?? props.frame;
  const previous = [...keys].reverse().find((key) => key.frame < at);
  const next = keys.find((key) => key.frame > at);
  const unavailable = props.disabled || navigation.disabled;
  const seek = (frame: number): void => {
    if (unavailable) return;
    const selected = inspectSpatialKeyframe(context, stored, frame, props.frame);
    if (!selected) return;
    navigation.onFollowPlayhead();
    setSelection(selected);
    (navigation.onSeekSourceKeyframe ?? props.onSeek)(selected.expectedFrame);
  };
  // Landing on a keyframe (timeline marker, seek) selects it in the stored editor.
  const playheadKey = keys.some((key) => key.frame === props.frame) ? props.frame : null;
  return (
    <InspectorSection
      id="transform"
      title="Transform"
      icon="layers"
      modified={hasSpatialEdits(props.layer.transform)}
      help={<TransformHelp />}
    >
      <SpatialControls
        {...props}
        selectedFrame={inspected ?? playheadKey}
        inspectedFrame={inspected}
        onFollowPlayhead={() => setSelection(null)}
        steps={
          <KeyframeSteps
            label="Transform"
            disabled={unavailable}
            previous={!!previous}
            next={!!next}
            onPrevious={() => {
              if (previous) seek(previous.frame);
            }}
            onNext={() => {
              if (next) seek(next.frame);
            }}
          />
        }
        onSelectStored={seek}
        key={`${props.project.id}:${props.layer.id}`}
      />
    </InspectorSection>
  );
}
