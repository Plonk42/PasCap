import { useId, useState } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import {
  createSpatialSettings,
  evaluateSpatial,
  hasSpatialEdits,
  type SpatialPose,
  type SpatialSettings,
} from '../shared/spatial.js';
import { previewClipSource } from './clip-speed-geometry.js';
import { AnimationControls, useAnimationTools } from './AnimationControls.js';
import { EasingSelect } from './EasingSelect.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { InspectorSection } from './InspectorSection.js';
import { useKeyframeNavigation } from './keyframe-navigation.js';
import { NumberField } from './NumberField.js';
import './spatial-editor.css';
import {
  captureSpatialKey,
  editSpatialPose,
  removeSpatialKey,
  replaceSpatialKey,
  SPATIAL_CONTROLS,
  spatialPlayhead,
} from './spatial-editor.js';
import { inspectSpatialKeyframe, reconcileSpatialInspection, type SpatialInspection } from './spatial-navigation.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  clip: VideoClip;
  sourceFrameCount: number;
  frame: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onSeek: (frame: number) => void;
  animate?: boolean;
  selectedFrame?: number | null;
  onSelectStored?: (frame: number) => void;
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

function PoseFields({
  pose,
  prefix,
  context,
  disabled,
  validate,
  onCommit,
}: Readonly<{
  pose: SpatialPose;
  prefix: string;
  context: string;
  disabled: boolean;
  validate: (key: keyof SpatialPose, value: number) => string | null;
  onCommit: (key: keyof SpatialPose, value: number) => void;
}>) {
  const id = useId();
  return (
    <div className="spatial-pose-fields">
      {SPATIAL_CONTROLS.map((control) => (
        <div className="spatial-pose-field" key={control.key}>
          <label htmlFor={`${id}-${control.key}`}>
            {control.label}
            {control.key === 'rotation' ? ' °' : ''}
          </label>
          <ValueControl
            id={`${id}-${control.key}`}
            aria-label={`${prefix} ${control.label}`}
            value={pose[control.key]}
            min={control.min}
            max={control.max}
            step={control.step}
            disabled={disabled}
            resetKey={`${context}:${control.key}`}
            validate={(value) => validate(control.key, value)}
            onCommit={(value) => onCommit(control.key, value)}
          />
        </div>
      ))}
    </div>
  );
}

export function TransformHelp() {
  return (
    <HelpPopover label="Transform animation" guide="crop-scale-translate-and-rotate-a-clip">
      <p>Crop, scale, move and rotate this clip. Values animate only if you add a keyframe first (◇).</p>
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
  animate = true,
  selectedFrame,
  onSelectStored,
}: Readonly<Props>) {
  const navigation = useKeyframeNavigation();
  const unavailable = disabled || navigation.disabled;
  const context = `${project.id}:${clip.id}`;
  const settings = clip.spatial;
  const playhead = spatialPlayhead(project, clip.id, frame);
  const active = settings.keyframes.find((key) => key.frame === playhead?.frame);
  const pose = active?.values ?? evaluateSpatial(settings, playhead?.position ?? clip.sourceIn);
  const editable = !settings.keyframes.length || active !== undefined;
  const scope = active ? 'Keyframe at displayed source frame' : 'Animated · add a Transform keyframe to edit';
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
  return (
    <section className="spatial-editor" aria-label="Clip Transform editor">
      <div className="spatial-tools">
        {animate && (
          <button
            type="button"
            className="keyframe-toggle icon-button"
            aria-label="Transform keyframe at displayed source frame"
            aria-pressed={active !== undefined}
            title={
              active
                ? `Remove the full Transform keyframe at source frame ${active.frame}`
                : 'Capture the full evaluated pose at the displayed source frame'
            }
            disabled={unavailable || playhead === null || (!active && settings.keyframes.length >= 256)}
            onClick={() => {
              if (!playhead) return;
              change(() =>
                active
                  ? removeSpatialKey(settings, active.frame)
                  : captureSpatialKey(settings, playhead.frame, playhead.position),
              );
            }}
          >
            <span aria-hidden="true">{active ? '◆' : '◇'}</span>
          </button>
        )}
        <span>{settings.keyframes.length} Transform keyframes</span>
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
      {settings.keyframes.length > 0 && (
        <p className="control-hint">
          {playhead ? `Source frame ${playhead.frame}` : 'Playhead outside clip'} · {scope}
        </p>
      )}
      <PoseFields
        pose={pose}
        prefix="Transform"
        context={`${context}:main:${settings.keyframes.length ? playhead?.frame : 'base'}`}
        disabled={unavailable || !editable}
        validate={(key, value) => validate(() => editSpatialPose(settings, playhead?.frame ?? null, key, value))}
        onCommit={(key, value) => change(() => editSpatialPose(settings, playhead?.frame ?? null, key, value))}
      />
      {selected && (
        <section hidden={!animate} className="spatial-stored" aria-label="Stored Transform keyframe">
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
              disabled={unavailable || index === settings.keyframes.length - 1}
              onChange={(interpolation) => change(() => replaceSpatialKey(settings, selected.frame, { interpolation }))}
            />
          </label>
          <PoseFields
            pose={selected.values}
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
  const tools = useAnimationTools(
    'transform',
    `${props.project.id}:${props.clip?.id}`,
    !!props.clip?.spatial.keyframes.length,
  );
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
      actions={
        <AnimationControls
          label="Transform"
          enabled={tools.enabled}
          disabled={props.disabled || navigation.disabled || !props.clip}
          onToggle={tools.toggle}
          previous={!!previous}
          next={!!next}
          onPrevious={() => seek(previous)}
          onNext={() => seek(next)}
        />
      }
    >
      {tools.warning && (
        <p className="control-hint">
          Animation tools cannot be saved in this browser; the choice remains available for this session.
        </p>
      )}
      {props.clip ? (
        <SpatialControls
          {...props}
          animate={tools.enabled}
          selectedFrame={inspected}
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
