import { useId, useState, type ReactNode } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import {
  createSpatialSettings,
  evaluateSpatial,
  hasSpatialChannelKeys,
  hasSpatialEdits,
  NEUTRAL_SPATIAL_POSE,
  spatialKeyChannels,
  type SpatialChannel,
  type SpatialKeyframe,
  type SpatialSettings,
} from '../shared/spatial.js';
import { previewClipSource } from './clip-speed-geometry.js';
import { KeyframeSteps, keyframeCount } from './AnimationControls.js';
import { EasingSelect } from './EasingSelect.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { useKeyframeNavigation } from './keyframe-navigation.js';
import './keyframe-navigation.css';
import './layer-keyframes.css';
import { NumberField } from './NumberField.js';
import './spatial-editor.css';
import {
  editSpatialPose,
  removeSpatialKey,
  replaceSpatialKey,
  SPATIAL_CONTROLS,
  spatialPlayhead,
  toggleSpatialChannel,
} from './spatial-editor.js';
import { inspectSpatialKeyframe, reconcileSpatialInspection, type SpatialInspection } from './spatial-navigation.js';
import { LockedCue, ResetLabel } from './SettingValueControl.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  clip: VideoClip;
  sourceFrameCount: number;
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

/** One channel's diamond and Previous/Next, matching the Colour setting controls. */
function SpatialChannelKeys({
  label,
  keys,
  disabled,
}: Readonly<{ label: string; keys: ChannelKeys; disabled: boolean }>) {
  const { keyed, active, previous, next } = keys;
  return (
    <span className="keyframe-setting-navigation" data-animated={keyed}>
      <button
        type="button"
        className={`keyframe-toggle${active ? ' active' : ''}`}
        aria-label={`Keyframe ${label}`}
        aria-pressed={active}
        title={
          active
            ? `Remove ${label} from the Transform keyframe at the displayed source frame. Other settings at this keyframe stay unchanged.`
            : `Keyframe ${label} at the displayed source frame. Capture the displayed value for this clip.`
        }
        disabled={disabled || keys.captureDisabled}
        onClick={keys.onToggle}
      >
        <span aria-hidden="true">{active ? '◆' : '◇'}</span>
      </button>
      <span className="channel-keyframe-navigation">
        <button
          type="button"
          className="icon-button"
          aria-label={`Previous ${label} keyframe`}
          title={previous ? `Go to source frame ${previous.frame}.` : `No previous ${label} keyframe`}
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
          title={next ? `Go to source frame ${next.frame}.` : `No next ${label} keyframe`}
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

/** Eight settings with the Colour pattern: a diamond and arrows each, read-only until captured. */
function PoseFields({
  values,
  prefix,
  context,
  disabled,
  readOnly,
  channels,
  keysFor,
  validate,
  onCommit,
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
  validate: (key: SpatialChannel, value: number) => string | null;
  onCommit: (key: SpatialChannel, value: number) => void;
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
                onReset={() => {
                  if (!locked && onReset && values[control.key] !== NEUTRAL_SPATIAL_POSE[control.key])
                    onReset(control.key);
                }}
              >
                {control.label}
                {unit}
              </ResetLabel>
              {readOnly?.(control.key) && <LockedCue />}
              {keys && (
                <span className="colour-control-actions">
                  <SpatialChannelKeys label={control.label} keys={keys} disabled={disabled} />
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
            />
          </div>
        );
      })}
    </div>
  );
}

export function TransformHelp() {
  return (
    <HelpPopover label="Transform animation" guide="crop-scale-translate-and-rotate-a-clip">
      <p>Crop, scale, move and rotate this clip. A setting animates once you add a keyframe for it (◇).</p>
      <p className="editor-help-tip">Tip: Reset transform restores the original framing.</p>
    </HelpPopover>
  );
}

export function SpatialControls({
  project,
  clip,
  sourceFrameCount,
  frame,
  disabled,
  onEdit,
  onSeek,
  selectedFrame,
  onSelectStored,
  steps,
}: Readonly<Props>) {
  const navigation = useKeyframeNavigation();
  const unavailable = disabled || navigation.disabled;
  const context = `${project.id}:${clip.id}`;
  const settings = clip.spatial;
  const playhead = spatialPlayhead(project, clip.id, frame);
  const atDisplayed = settings.keyframes.find((key) => key.frame === playhead?.frame);
  const evaluated = evaluateSpatial(settings, playhead?.position ?? clip.sourceIn);
  const pose = Object.fromEntries(
    SPATIAL_CONTROLS.map(({ key }) => [key, atDisplayed?.values[key] ?? evaluated[key]]),
  ) as Record<SpatialChannel, number>;
  const channelActive = (channel: SpatialChannel): boolean => atDisplayed?.values[channel] != null;
  const readOnly = (channel: SpatialChannel): boolean =>
    hasSpatialChannelKeys(settings, channel) && !channelActive(channel);
  const anyReadOnly = SPATIAL_CONTROLS.some(({ key }) => readOnly(key));
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
  const laterKeyExists =
    selected !== undefined &&
    spatialKeyChannels(selected).some((channel) =>
      settings.keyframes.some((key) => key.frame > selected.frame && key.values[channel] !== null),
    );
  const [error, setError] = useState('');
  const validate = (produce: () => SpatialSettings): string | null => {
    try {
      applyCommand(project, { type: 'spatial', clipId: clip.id, spatial: produce() });
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'This Transform is invalid.';
    }
  };
  const change = (produce: () => SpatialSettings): void => {
    if (unavailable) return;
    try {
      const spatial = produce();
      applyCommand(project, { type: 'spatial', clipId: clip.id, spatial });
      onEdit({ type: 'spatial', clipId: clip.id, spatial });
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This Transform is invalid.');
    }
  };
  const seek = (next: number): void => {
    const point = settings.keyframes[next];
    if (unavailable || !point) return;
    selection.select(point.frame);
    onSelectStored?.(point.frame);
    (navigation.onSeekSourceKeyframe ?? onSeek)(previewClipSource(project, clip.id, point.frame));
  };
  // Per-channel arrows step from the inspected stored frame, else the displayed source frame.
  const cursor = selectedFrame ?? playhead?.frame ?? clip.sourceIn;
  const keysFor = (channel: SpatialChannel): ChannelKeys => {
    const keyed = settings.keyframes.filter((key) => key.values[channel] !== null);
    return {
      keyed: keyed.length > 0,
      active: channelActive(channel),
      previous: [...keyed].reverse().find((key) => key.frame < cursor),
      next: keyed.find((key) => key.frame > cursor),
      captureDisabled: unavailable || playhead === null || (!atDisplayed && settings.keyframes.length >= 256),
      onToggle: () => {
        if (playhead) change(() => toggleSpatialChannel(settings, channel, playhead.frame, playhead.position));
      },
      onSeek: (key) => seek(settings.keyframes.indexOf(key)),
    };
  };
  return (
    <section className="spatial-editor" aria-label="Clip Transform editor">
      <div className="spatial-tools section-keyframe-line">
        <span className="section-keyframe-count">{keyframeCount(settings.keyframes.length)}</span>
        {steps}
        <button
          type="button"
          className="text-button"
          aria-label="Reset transform"
          disabled={unavailable || !hasSpatialEdits(settings)}
          onClick={() => change(createSpatialSettings)}
        >
          <Icon name="reset" size={13} />
          Reset
        </button>
      </div>
      {anyReadOnly && (
        <p className="control-hint">
          {playhead ? `Source frame ${playhead.frame}` : 'Playhead outside clip'} · Animated · add a keyframe to edit a
          setting here.
        </p>
      )}
      <PoseFields
        values={pose}
        prefix="Transform"
        context={`${context}:main:${settings.keyframes.length ? playhead?.frame : 'base'}`}
        disabled={unavailable}
        readOnly={readOnly}
        keysFor={keysFor}
        validate={(key, value) => validate(() => editSpatialPose(settings, playhead?.frame ?? null, key, value))}
        onCommit={(key, value) => change(() => editSpatialPose(settings, playhead?.frame ?? null, key, value))}
        onReset={(key) =>
          change(() => editSpatialPose(settings, playhead?.frame ?? null, key, NEUTRAL_SPATIAL_POSE[key]))
        }
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
                  Keyframe {at + 1} · source {key.frame}
                  {key.frame < clip.sourceIn || key.frame >= clip.sourceOut ? ' · outside clip' : ''}
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
          <p className="control-hint">
            Stored source frame {selected.frame} ·{' '}
            {playhead ? `actual displayed source frame ${playhead.frame}` : 'no displayed source frame'}
            {selected.frame < clip.sourceIn || selected.frame >= clip.sourceOut
              ? ' · outside clip; preview uses the nearest available image'
              : ''}
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
            Source frame
            <NumberField
              aria-label="Transform keyframe source frame"
              value={selected.frame}
              integer
              min={0}
              max={sourceFrameCount}
              step={1}
              disabled={unavailable}
              resetKey={`${context}:stored:${selection.identity}:frame`}
              validate={(value) => validate(() => replaceSpatialKey(settings, selected.frame, { frame: value }))}
              onCommit={(value) => change(() => replaceSpatialKey(settings, selected.frame, { frame: value }))}
            />
          </label>
          <label className="speed-field">
            Easing
            <EasingSelect
              aria-label="Transform keyframe easing"
              value={selected.interpolation}
              disabled={unavailable || !laterKeyExists}
              onChange={(interpolation) => change(() => replaceSpatialKey(settings, selected.frame, { interpolation }))}
            />
          </label>
          <PoseFields
            values={selected.values as Record<SpatialChannel, number>}
            channels={spatialKeyChannels(selected)}
            prefix="Stored Transform"
            context={`${context}:stored:${selection.identity}`}
            disabled={unavailable}
            validate={(key, value) =>
              validate(() =>
                replaceSpatialKey(settings, selected.frame, { values: { ...selected.values, [key]: value } }),
              )
            }
            onCommit={(key, value) =>
              change(() =>
                replaceSpatialKey(settings, selected.frame, { values: { ...selected.values, [key]: value } }),
              )
            }
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

export function TransformSection(props: Readonly<Omit<Props, 'clip'> & { clip: VideoClip | null }>) {
  const navigation = useKeyframeNavigation();
  const [selection, setSelection] = useState<SpatialInspection | null>(null);
  const context = `${props.project.id}:${props.clip?.id}:${navigation.sourceEpoch ?? 0}`;
  const keys = props.clip?.spatial.keyframes ?? [];
  const playhead = props.clip ? spatialPlayhead(props.project, props.clip.id, props.frame) : null;
  const inspection = reconcileSpatialInspection(
    selection,
    context,
    props.project,
    props.clip,
    props.frame,
    navigation.playing ?? false,
    navigation.inspection,
  );
  if (inspection !== selection) setSelection(inspection);
  const inspected = inspection?.frame ?? null;
  const at = inspected ?? playhead?.frame ?? props.clip?.sourceIn ?? 0;
  const previous = [...keys].reverse().find((key) => key.frame < at);
  const next = keys.find((key) => key.frame > at);
  const selectStored = (frame: number): SpatialInspection | null => {
    if (props.disabled || navigation.disabled) return null;
    const selected = inspectSpatialKeyframe(context, props.project, props.clip, frame, props.frame);
    if (!selected) return null;
    navigation.onFollowPlayhead();
    setSelection(selected);
    return selected;
  };
  const seek = (key: typeof previous) => {
    if (!key) return;
    const selected = selectStored(key.frame);
    if (selected) (navigation.onSeekSourceKeyframe ?? props.onSeek)(selected.expectedFrame);
  };
  return (
    <InspectorSection
      id="transform"
      title="Transform"
      icon="layers"
      modified={props.clip !== null && hasSpatialEdits(props.clip.spatial)}
      help={<TransformHelp />}
    >
      {props.clip ? (
        <SpatialControls
          {...props}
          selectedFrame={inspected}
          steps={
            <KeyframeSteps
              label="Transform"
              disabled={props.disabled || navigation.disabled}
              previous={!!previous}
              next={!!next}
              onPrevious={() => seek(previous)}
              onNext={() => seek(next)}
            />
          }
          onSelectStored={selectStored}
          clip={props.clip}
          key={`${props.project.id}:${props.clip.id}`}
        />
      ) : (
        <p className="control-hint">Select a clip to edit its Transform.</p>
      )}
    </InspectorSection>
  );
}
