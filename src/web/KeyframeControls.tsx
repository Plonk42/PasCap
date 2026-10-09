import { useId, useState } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { KEYFRAME_SETTINGS, keyframeNeighbors, keySettings, type LayerKeyframe } from '../shared/keyframes.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';
import { formatTimecode } from '../shared/timing.js';
import { ChannelKeyframeNavigation } from './AnimationControls.js';
import './declutter.css';
import { EasingSelect } from './EasingSelect.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, keySeekHint, useKeyframeNavigation } from './keyframe-navigation.js';
import './layer-keyframes.css';
import { NumberField } from './NumberField.js';
import { RangeSettingControl, ResetLabel, SpeedRateField } from './SettingValueControl.js';

export interface KeyframeControlsProps {
  project: ProjectDocument;
  layer: VideoLayer;
  frame: number;
  duration: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

interface PointRow {
  frame: number;
  id: number;
}
interface PanelIdentity {
  context: string;
  rows: PointRow[];
  nextId: number;
}

function participatingSettings(key: LayerKeyframe) {
  const settings = keySettings(key);
  return KEYFRAME_SETTINGS.filter((definition) => settings.includes(definition.key));
}

function ParticipantChips({
  point,
  layer,
  frame,
  disabled,
}: Readonly<{ point: LayerKeyframe; layer: VideoLayer; frame: number; disabled: boolean }>) {
  return (
    <div className="layer-keyframe-chips" aria-label="Animated settings">
      {participatingSettings(point).map((setting) => (
        <span className="layer-keyframe-chip" key={setting.key}>
          {setting.label}
          <ChannelKeyframeNavigation
            layer={layer}
            frame={frame}
            setting={setting.key}
            label={setting.label}
            disabled={disabled}
          />
        </span>
      ))}
    </div>
  );
}

function reconcileRows(identity: PanelIdentity, context: string, keys: readonly LayerKeyframe[]) {
  if (identity.context !== context)
    return { rows: keys.map((key, id) => ({ frame: key.frame, id })), nextId: keys.length };
  const previous = new Map(identity.rows.map((row) => [row.frame, row]));
  const frames = new Set(keys.map((key) => key.frame));
  const removed = identity.rows.filter((row) => !frames.has(row.frame));
  const added = keys.filter((key) => !previous.has(key.frame));
  let nextId = identity.nextId;
  // A single time edit and its undo keep DOM identity, including after reordering.
  const rows = keys.map(
    (key) =>
      previous.get(key.frame) ?? {
        frame: key.frame,
        id: removed.length === 1 && added.length === 1 ? removed[0]!.id : nextId++,
      },
  );
  return { rows, nextId };
}

function usePointIdentity(context: string, keys: readonly LayerKeyframe[]) {
  const [state, setState] = useState<PanelIdentity>(() => ({
    context,
    rows: keys.map((key, id) => ({ frame: key.frame, id })),
    nextId: keys.length,
  }));
  let current = state;
  const pointsChanged =
    keys.length !== state.rows.length || keys.some((key, index) => key.frame !== state.rows[index]?.frame);
  if (state.context !== context || pointsChanged) {
    current = { context, ...reconcileRows(state, context, keys) };
    setState(current);
  }
  return current;
}

function playheadLabel(frame: number, duration: number, atHead: boolean): string {
  if (duration === 0) return 'Empty timeline · no preview frame';
  if (!Number.isInteger(frame) || frame < 0 || frame >= duration)
    return `Frame ${frame} is outside the current timeline`;
  return `Timeline frame ${frame}${atHead ? ' · shared keyframe at playhead' : ' · no shared keyframe here'}`;
}

interface PointRowProps {
  project: ProjectDocument;
  point: LayerKeyframe;
  keys: readonly LayerKeyframe[];
  row: PointRow;
  layerId: string;
  context: string;
  listId: string;
  helpId: string;
  duration: number;
  current: boolean;
  initiallyOpen: boolean;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onSeek: (point: LayerKeyframe) => void;
}

function KeyframePointRow({
  project,
  point,
  keys,
  row,
  layerId,
  context,
  listId,
  helpId,
  duration,
  current,
  initiallyOpen,
  disabled,
  onEdit,
  onSeek,
}: Readonly<PointRowProps>) {
  const settings = participatingSettings(point);
  // Short lists start expanded; afterwards the user's toggle owns the disclosure.
  const [open] = useState(initiallyOpen);
  return (
    <li
      className={`keyframe-row${current ? ' current' : ''}`}
      data-keyframe-frame={point.frame}
      aria-current={current ? 'true' : undefined}
    >
      <div className="keyframe-row-header">
        <button
          type="button"
          className="text-button"
          aria-label={`Go to track keyframe ${point.frame}`}
          title={keySeekHint(point.frame, duration)}
          disabled={disabled}
          onClick={() => onSeek(point)}
        >
          {formatTimecode(point.frame)}
        </button>
        {point.frame >= duration && (
          <span
            className="keyframe-row-skipped"
            title="Outside the current timeline; this stored keyframe remains editable."
          >
            Outside duration
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={`Delete track keyframe ${point.frame}`}
          title="Remove this whole shared keyframe and all its animated settings"
          disabled={disabled}
          onClick={() => onEdit({ type: 'layer-key-remove', layerId, frame: point.frame })}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div
        className="layer-keyframe-dependencies"
        title="Moving this keyframe moves all these settings together; they also share its easing."
      >
        <ParticipantChips
          point={point}
          layer={project.layers.find((layer) => layer.id === layerId)!}
          frame={point.frame}
          disabled={disabled}
        />
      </div>
      <details className="layer-keyframe-point-details" open={open}>
        <summary aria-label={`Edit track keyframe ${point.frame}`}>Edit</summary>
        <div className="layer-keyframe-point-fields">
          <label htmlFor={`${listId}-${row.id}-frame`}>
            Timeline frame
            <NumberField
              id={`${listId}-${row.id}-frame`}
              aria-label={`Track keyframe frame ${point.frame}`}
              aria-describedby={helpId}
              min={0}
              max={2_147_483_647}
              integer
              step={1}
              value={point.frame}
              disabled={disabled}
              resetKey={`${context}:${row.id}:frame`}
              validate={(value) =>
                keys.some((other) => other.frame !== point.frame && other.frame === value)
                  ? `Frame ${value} already has a shared keyframe. Choose a different frame.`
                  : null
              }
              onCommit={(nextFrame) => onEdit({ type: 'layer-key-move', layerId, frame: point.frame, nextFrame })}
            />
          </label>
          <label className="keyframe-easing" htmlFor={`${listId}-${row.id}-easing`}>
            Easing
            <EasingSelect
              id={`${listId}-${row.id}-easing`}
              aria-label={`Track keyframe easing ${point.frame}`}
              aria-describedby={helpId}
              title="Shared by these settings, to each setting's next keyframe"
              disabled={disabled}
              value={point.interpolation}
              onChange={(interpolation) =>
                onEdit({
                  type: 'layer-key-easing',
                  layerId,
                  frame: point.frame,
                  interpolation,
                })
              }
            />
          </label>
          <div className="layer-keyframe-point-values">
            {settings.map((setting) => {
              const value = point.values[setting.key];
              if (value === null) return null;
              const id = `${listId}-${row.id}-${setting.key}`;
              const label = `${setting.label} keyframe value ${point.frame}`;
              const hint = `${setting.label} at stored timeline frame ${point.frame} on ${project.layers.find((layer) => layer.id === layerId)?.name}. Edits change only this setting's keyframe value, not the playhead, shared easing or unanimated settings.`;
              const command = (nextValue: number): EditCommand => ({
                type: 'layer-key-value',
                layerId,
                frame: point.frame,
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
              const onCommit = (nextValue: number): void => {
                if (!disabled) onEdit(command(nextValue));
              };
              const resetKey = `${context}:${row.id}:${setting.key}`;
              return (
                <div className="keyframe-value colour-control" key={setting.key}>
                  {setting.key === 'speed' ? (
                    <>
                      <div className="layer-setting-heading">
                        <ResetLabel
                          htmlFor={id}
                          title={hint}
                          onReset={() => {
                            if (!disabled && value !== 1) onCommit(1);
                          }}
                        >
                          Speed
                        </ResetLabel>
                      </div>
                      <SpeedRateField
                        id={id}
                        aria-label={label}
                        value={value}
                        disabled={disabled}
                        resetKey={resetKey}
                        hint={hint}
                        validate={validate}
                        onCommit={onCommit}
                      />
                    </>
                  ) : (
                    <RangeSettingControl
                      setting={setting.key}
                      id={id}
                      label={label}
                      value={value}
                      disabled={disabled}
                      hint={hint}
                      exact={{ resetKey, validate }}
                      onCommit={onCommit}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </details>
    </li>
  );
}

/** One project-time point list for the whole row, never one list per setting or clip. */
export function KeyframeControls({
  project,
  layer,
  frame,
  duration,
  disabled,
  onEdit,
}: Readonly<KeyframeControlsProps>) {
  const projectId = project.id;
  const navigation = useKeyframeNavigation();
  const unavailable = disabled || navigation.disabled;
  const listId = useId();
  const helpId = `${listId}-help`;
  const keys = layer.keyframes;
  const context = `${projectId}:${layer.id}`;
  const current = usePointIdentity(context, keys);

  const pointAtFrame = keys.find((key) => key.frame === frame);
  const previewAvailable = Number.isInteger(frame) && frame >= 0 && frame < duration;
  const atHead = previewAvailable ? pointAtFrame : undefined;
  const inspection =
    navigation.inspection?.projectId === projectId && navigation.inspection.layerId === layer.id
      ? navigation.inspection
      : null;
  const selectedPoint = keys.find((key) => key.frame === inspection?.frame);
  const inspectedPoint = selectedPoint ?? (!previewAvailable ? pointAtFrame : undefined);
  const inspectedAway =
    inspectedPoint && (!previewAvailable || inspectedPoint.frame !== frame) ? inspectedPoint : undefined;
  const navigationFrame = keyframeNavigationFrame(inspection, layer.id, frame);
  const { previous, next } = keyframeNeighbors(keys, navigationFrame);
  const seekPoint = (point: LayerKeyframe): void => {
    if (!unavailable) navigation.onSeekKeyframe(layer.id, point.frame);
  };

  return (
    <fieldset
      className="keyframe-controls declutter-keyframes layer-keyframe-controls"
      aria-label={`Track keyframes ${layer.name}`}
    >
      <legend className="declutter-sr-only">Track keyframes</legend>
      <div className="keyframe-toolbar">
        <strong className="keyframe-panel-title declutter-sr-only">Track keyframes</strong>
        <span className="keyframe-count">
          {keys.length} {keys.length === 1 ? 'keyframe' : 'keyframes'}
        </span>
        <div className="keyframe-navigation">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous track keyframe"
            title={previous ? keySeekHint(previous.frame, duration) : 'No previous shared keyframe'}
            disabled={unavailable || !previous}
            onClick={() => {
              if (previous) seekPoint(previous);
            }}
          >
            <Icon name="back" size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next track keyframe"
            title={next ? keySeekHint(next.frame, duration) : 'No next shared keyframe'}
            disabled={unavailable || !next}
            onClick={() => {
              if (next) seekPoint(next);
            }}
          >
            <Icon name="forward" size={14} />
          </button>
        </div>
        <HelpPopover label="Animation" className="animation-help" guide="opt-in-to-shared-video-track-animation">
          <p id={helpId}>
            Each diamond adds a keyframe for that setting on the whole track, at the playhead. Settings keyed together
            share one keyframe and its easing.
          </p>
          <div className="animation-legend">
            <span>
              <span aria-hidden="true">◇</span>Not animated · click to capture
            </span>
            <span>
              <Icon name="curve" size={14} />
              Track curve · capture before editing
            </span>
            <span>
              <span aria-hidden="true">◆</span>Keyframe at playhead · editable
            </span>
          </div>
          <p className="editor-help-tip">
            Tip: Animate reveals diamonds. Section arrows visit any keyframe; chip arrows visit one setting's keyframes.
          </p>
        </HelpPopover>
      </div>

      <div className="layer-keyframe-current">
        <span className="layer-keyframe-position declutter-sr-only">
          {playheadLabel(frame, duration, atHead !== undefined)}
        </span>
        {atHead && (
          <>
            <span className="layer-keyframe-caption">At playhead:</span>
            <span>
              {participatingSettings(atHead)
                .map((setting) => setting.label)
                .join(' · ')}
            </span>
          </>
        )}
      </div>
      {inspectedAway && (
        <div className="layer-keyframe-inspected">
          <span className="layer-keyframe-position">
            Stored keyframe · timeline frame {inspectedAway.frame}
            {inspectedAway.frame >= duration ? ' · outside current duration' : ''}
          </span>
          <span>
            {participatingSettings(inspectedAway)
              .map((setting) => setting.label)
              .join(' · ')}
          </span>
          <span className="layer-setting-hint">
            {duration === 0
              ? 'No preview frame is available. This keyframe remains editable below.'
              : `Preview is at frame ${frame}, not at this stored keyframe.`}
          </span>
          {inspection && (
            <button type="button" className="text-button" onClick={navigation.onFollowPlayhead}>
              Follow playhead
            </button>
          )}
        </div>
      )}

      {keys.length > 0 && (
        <ol className="keyframe-list keyframe-entries" aria-label="Edit track keyframes">
          {keys.map((key, index) => (
            <KeyframePointRow
              key={current.rows[index]!.id}
              project={project}
              point={key}
              keys={keys}
              row={current.rows[index]!}
              layerId={layer.id}
              context={context}
              listId={listId}
              helpId={helpId}
              duration={duration}
              current={(inspection !== null || previewAvailable) && key.frame === navigationFrame}
              initiallyOpen={keys.length <= 3}
              disabled={unavailable}
              onEdit={onEdit}
              onSeek={seekPoint}
            />
          ))}
        </ol>
      )}
    </fieldset>
  );
}
