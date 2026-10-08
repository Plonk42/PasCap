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
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  clip: VideoClip;
  sourceFrameCount: number;
  frame: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onSeek: (frame: number) => void;
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
    <HelpPopover label="Transform animation">
      <p>
        Transform belongs only to this excerpt. Crop fractions remove original source edges without refitting; opposite
        crops must sum to less than 1. Scale preserves aspect. Rotation uses the original centre pivot, clockwise;
        translation is a fraction of the output width or height. Uncovered pixels reveal lower layers.
      </p>
      <p>
        The single diamond captures the complete evaluated pose at the actually displayed integer source frame. With
        animation, capture a key before editing at a new source frame; sliders never add keys. All eight values share
        the key's easing. Stored keys, including outside the trim and at exclusive OUT, stay editable; navigation
        previews the closest actually mapped image. Trimming, splitting and moving retain original-source anchors. Reset
        transform deliberately restores the neutral base and deletes all Transform keys, in one Undo.
      </p>
    </HelpPopover>
  );
}

export function SpatialControls({ project, clip, sourceFrameCount, frame, disabled, onEdit, onSeek }: Readonly<Props>) {
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
    onSeek(previewClipSource(project, clip.id, point.frame));
  };
  return (
    <section className="spatial-editor" aria-label="Clip Transform editor">
      <div className="spatial-tools">
        <button
          type="button"
          className="keyframe-toggle icon-button"
          aria-label="Transform keyframe at displayed source frame"
          aria-pressed={active !== undefined}
          title={
            active
              ? `Remove the full Transform key at source frame ${active.frame}`
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
        <span>{settings.keyframes.length} Transform keys</span>
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
        <section className="spatial-stored" aria-label="Stored Transform key">
          <div className="spatial-selection">
            <button
              type="button"
              className="icon-button"
              aria-label="Previous Transform keyframe"
              disabled={unavailable || index <= 0}
              onClick={() => seek(index - 1)}
            >
              <Icon name="back" size={14} />
            </button>
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
                  Key {at + 1} · source {key.frame}
                  {key.frame < clip.sourceIn || key.frame >= clip.sourceOut ? ' · outside clip' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button"
              aria-label="Next Transform keyframe"
              disabled={unavailable || index === settings.keyframes.length - 1}
              onClick={() => seek(index + 1)}
            >
              <Icon name="forward" size={14} />
            </button>
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
              ? ' · outside excerpt; preview uses the nearest available image'
              : ''}
          </p>
          <button
            type="button"
            className="text-button"
            aria-label="Preview selected Transform keyframe"
            disabled={unavailable}
            onClick={() => seek(index)}
          >
            Preview stored key
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
            To next point
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
  return (
    <InspectorSection
      id="transform"
      title="Transform"
      icon="layers"
      modified={props.clip !== null && hasSpatialEdits(props.clip.spatial)}
      help={<TransformHelp />}
    >
      {props.clip ? (
        <SpatialControls {...props} clip={props.clip} key={`${props.project.id}:${props.clip.id}`} />
      ) : (
        <p className="control-hint">Select an excerpt to edit its Transform.</p>
      )}
    </InspectorSection>
  );
}
