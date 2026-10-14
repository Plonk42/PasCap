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
import { formatTimecode } from '../shared/timing.js';
import { KeyframeSteps, keyframeCount } from './AnimationControls.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { KeyframeEasing } from './KeyframeEasing.js';
import { keySeekHint, useKeyframeNavigation } from './keyframe-navigation.js';
import './keyframe-navigation.css';
import './layer-keyframes.css';
import { livePreview } from './live-preview.js';
import { NumberField } from './NumberField.js';
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
  onSelectStored?: (frame: number) => void;
  steps?: ReactNode;
}

/** Reconcile one moved key (and Undo) without remounting its exact fields. */
function useSpatialSelection(settings: SpatialSettings) {
  const [stored, setStored] = useState(() => ({
    frames: settings.keyframes.map((key) => key.frame),
    selected: settings.keyframes[0]?.frame ?? null,
    identity: 0,
  }));
  const frames = settings.keyframes.map((key) => key.frame);
  let state = stored;
  if (frames.length !== stored.frames.length || frames.some((frame, index) => frame !== stored.frames[index])) {
    const removed = stored.frames.filter((frame) => !frames.includes(frame));
    const added = frames.filter((frame) => !stored.frames.includes(frame));
    let selected = stored.selected;
    let identity = stored.identity;
    if (removed.length === 1 && added.length === 1 && selected === removed[0]) selected = added[0]!;
    else if (added.length === 1 && removed.length === 0) {
      selected = added[0]!;
      identity++;
    } else if (selected === null || !frames.includes(selected)) {
      selected = frames[0] ?? null;
      identity++;
    }
    state = { frames, selected, identity };
    setStored(state);
  }
  return {
    ...state,
    select: (selected: number) =>
      setStored((current) => ({
        ...current,
        selected,
        identity: current.identity + Number(current.selected !== selected),
      })),
  };
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
      <span className="channel-keyframe-navigation">
        <button
          type="button"
          className="icon-button"
          aria-label={`Previous ${label} keyframe`}
          title={previous ? keySeekHint(previous.frame, duration) : `No previous ${label} keyframe`}
          aria-disabled={disabled || !previous}
          tabIndex={disabled || !previous ? -1 : 0}
          onClick={() => {
            if (previous && !disabled) keys.onSeek(previous);
          }}
        >
          <Icon name="back" size={12} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Next ${label} keyframe`}
          title={next ? keySeekHint(next.frame, duration) : `No next ${label} keyframe`}
          aria-disabled={disabled || !next}
          tabIndex={disabled || !next ? -1 : 0}
          onClick={() => {
            if (next && !disabled) keys.onSeek(next);
          }}
        >
          <Icon name="forward" size={12} />
        </button>
      </span>
    </span>
  );
}

/** Eight settings with the Colour pattern: a capture button and arrows each, read-only until captured. */
function PoseFields({
  values,
  prefix,
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
  prefix: string;
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
                name={control.label}
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
              aria-label={`${prefix} ${control.label}`}
              value={values[control.key]}
              min={control.min}
              max={control.max}
              step={control.step}
              disabled={locked}
              resetKey={`${context}:${control.key}`}
              validate={(value) => validate(control.key, value)}
              onCommit={(value) => onCommit(control.key, value)}
              onDraft={(value) => onDraft(control.key, value)}
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
        Crop, scale, move and rotate every clip on this track. A setting animates once you add a keyframe for it (▽).
      </p>
      <p className="editor-help-tip">Tip: to frame one clip differently, put it on its own track.</p>
    </HelpPopover>
  );
}

function storedLabel(key: SpatialKeyframe, index: number, duration: number): string {
  let label = `Keyframe ${index + 1} · ${formatTimecode(key.frame)}`;
  if (key.reset) label += ' · default';
  if (key.frame >= duration) label += ' · outside duration';
  return label;
}

export function SpatialControls({
  project,
  layer,
  frame,
  disabled,
  onEdit,
  selectedFrame,
  onSelectStored,
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
  const selection = useSpatialSelection(settings);
  const [lastInspected, setLastInspected] = useState(selectedFrame);
  if (lastInspected !== selectedFrame) {
    setLastInspected(selectedFrame);
    if (
      selectedFrame !== undefined &&
      selectedFrame !== null &&
      settings.keyframes.some((key) => key.frame === selectedFrame)
    )
      selection.select(selectedFrame);
  }
  const index = settings.keyframes.findIndex((key) => key.frame === selection.selected);
  const selected = settings.keyframes[index];
  // Easing only matters where an enabled setting continues to a later key.
  const continuing = selected ? continuingSettings(settings.keyframes, selected, SPATIAL_CHANNELS) : [];
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
  const seek = (next: number): void => {
    const point = settings.keyframes[next];
    if (unavailable || !point) return;
    selection.select(point.frame);
    onSelectStored?.(point.frame);
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
      onSeek: (key) => seek(settings.keyframes.indexOf(key)),
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
  const storedAt = (key: SpatialChannel, value: number) => () =>
    replaceSpatialKey(settings, selected!.frame, { values: { ...selected!.values, [key]: value } });
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
        prefix="Transform"
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
      {selected && (
        <section className="spatial-stored" aria-label="Stored Transform keyframe">
          <div className="spatial-selection">
            <select
              aria-label="Selected Transform keyframe"
              disabled={unavailable}
              value={selected.frame}
              onChange={(event) =>
                seek(settings.keyframes.findIndex((key) => key.frame === Number(event.currentTarget.value)))
              }
            >
              {settings.keyframes.map((key, at) => (
                <option key={key.frame} value={key.frame}>
                  {storedLabel(key, at, duration)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button"
              aria-label="Delete selected Transform keyframe"
              disabled={unavailable}
              onClick={() => change(() => removeSpatialKey(settings, selected.frame))}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
          {selected.reset && (
            <span
              className="keyframe-row-default transform-default"
              title="Default keyframe: its settings return to their defaults here and hold until their next keyframes; earlier frames keep their own values."
            >
              <Icon name="default-key" size={14} />
              Default
            </span>
          )}
          <p className="control-hint">
            Stored timeline frame {selected.frame} · playhead frame {frame}
            {selected.frame >= duration ? ' · outside duration; preview uses the nearest available frame' : ''}
          </p>
          <button
            type="button"
            className="text-button"
            aria-label="Preview selected Transform keyframe"
            disabled={unavailable}
            onClick={() => seek(index)}
          >
            Preview stored keyframe
          </button>
          <label className="speed-field">
            Timeline frame
            <NumberField
              aria-label="Transform keyframe timeline frame"
              value={selected.frame}
              integer
              min={0}
              max={2_147_483_647}
              step={1}
              disabled={unavailable}
              resetKey={`${context}:stored:${selection.identity}:frame`}
              validate={(value) => validate(() => replaceSpatialKey(settings, selected.frame, { frame: value }))}
              onCommit={(value) => change(() => replaceSpatialKey(settings, selected.frame, { frame: value }))}
            />
          </label>
          <div className="speed-field spatial-easing" key={`${context}:${selection.identity}`}>
            <KeyframeEasing
              label="Transform keyframe easing"
              settingLabel={(setting) => `Transform keyframe ${setting} easing`}
              settings={SPATIAL_CONTROLS.filter((control) => selected.values[control.key] !== null)}
              continuing={continuing}
              easing={selected.easing}
              disabled={unavailable || !continuing.length}
              onChange={(channel, interpolation) =>
                change(() => setSpatialEasing(settings, selected.frame, channel, interpolation))
              }
            />
          </div>
          <PoseFields
            values={selected.values as Record<SpatialChannel, number>}
            channels={spatialKeyChannels(selected)}
            prefix="Stored Transform"
            context={`${context}:stored:${selection.identity}`}
            disabled={unavailable}
            frame={frame}
            duration={duration}
            validate={(key, value) => validate(storedAt(key, value))}
            onCommit={(key, value) => change(storedAt(key, value))}
            onDraft={(key, value) => draft(storedAt(key, value ?? 0), value)}
          />
        </section>
      )}
      {error && (
        <p className="control-hint" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function TransformSection(props: Readonly<Omit<Props, 'selectedFrame' | 'onSelectStored' | 'steps'>>) {
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
