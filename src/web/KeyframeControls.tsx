import { useId, useState } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { KEYFRAME_SETTINGS, keyframeNeighbors, keySettings, type Interpolation, type LayerKeyframe } from '../shared/keyframes.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';
import { formatTimecode } from '../shared/timing.js';
import './declutter.css';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, keySeekHint, useKeyframeNavigation } from './keyframe-navigation.js';
import './layer-keyframes.css';
import { NumberField } from './NumberField.js';
import { RangeSettingControl, SpeedRateField } from './SettingValueControl.js';

export interface KeyframeControlsProps {
  project: ProjectDocument;
  layer: VideoLayer;
  frame: number;
  duration: number;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
}

interface PointRow { frame: number; id: number }
interface PanelIdentity {
  context: string;
  rows: PointRow[];
  nextId: number;
}

function participatingSettings(key: LayerKeyframe) {
  const settings = keySettings(key);
  return KEYFRAME_SETTINGS.filter((definition) => settings.includes(definition.key));
}

function ParticipantChips({ point }: Readonly<{ point: LayerKeyframe }>) {
  return <div className="layer-keyframe-chips" aria-label="Participating settings">{participatingSettings(point).map((setting) =>
    <span className="layer-keyframe-chip" key={setting.key}>{setting.label}</span>)}</div>;
}

function reconcileRows(identity: PanelIdentity, context: string, keys: readonly LayerKeyframe[]) {
  if (identity.context !== context) return { rows: keys.map((key, id) => ({ frame: key.frame, id })), nextId: keys.length };
  const previous = new Map(identity.rows.map((row) => [row.frame, row]));
  const frames = new Set(keys.map((key) => key.frame));
  const removed = identity.rows.filter((row) => !frames.has(row.frame));
  const added = keys.filter((key) => !previous.has(key.frame));
  let nextId = identity.nextId;
  // A single time edit and its undo keep DOM identity, including after reordering.
  const rows = keys.map((key) => previous.get(key.frame) ?? {
    frame: key.frame,
    id: removed.length === 1 && added.length === 1 ? removed[0]!.id : nextId++,
  });
  return { rows, nextId };
}

function usePointIdentity(context: string, keys: readonly LayerKeyframe[]) {
  const [state, setState] = useState<PanelIdentity>(() => ({
    context, rows: keys.map((key, id) => ({ frame: key.frame, id })), nextId: keys.length,
  }));
  let current = state;
  const pointsChanged = keys.length !== state.rows.length || keys.some((key, index) => key.frame !== state.rows[index]?.frame);
  if (state.context !== context || pointsChanged) {
    current = { context, ...reconcileRows(state, context, keys) };
    setState(current);
  }
  return current;
}

function playheadLabel(frame: number, duration: number, atHead: boolean): string {
  if (duration === 0) return 'Empty timeline · no preview frame';
  if (!Number.isInteger(frame) || frame < 0 || frame >= duration) return `Frame ${frame} is outside the current timeline`;
  return `Timeline frame ${frame}${atHead ? ' · shared point at playhead' : ' · no shared point here'}`;
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
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onSeek: (point: LayerKeyframe) => void;
}

function KeyframePointRow({ project, point, keys, row, layerId, context, listId, helpId, duration, current, disabled, onEdit, onSeek }: Readonly<PointRowProps>) {
  const settings = participatingSettings(point);
  return <li className={`keyframe-row${current ? ' current' : ''}`} data-keyframe-frame={point.frame} aria-current={current ? 'true' : undefined}>
    <div className="keyframe-row-header">
      <button type="button" className="text-button" aria-label={`Go to layer keyframe ${point.frame}`} title={keySeekHint(point.frame, duration)} disabled={disabled} onClick={() => onSeek(point)}>{formatTimecode(point.frame)}</button>
      {point.frame >= duration && <span className="keyframe-row-skipped" title="Outside the current timeline; this stored point remains editable.">Outside duration</span>}
      <button type="button" className="icon-button" aria-label={`Delete layer keyframe ${point.frame}`} title="Remove this whole shared point and all its participating settings" disabled={disabled} onClick={() => onEdit({ type: 'layer-key-remove', layerId, frame: point.frame })}>×</button>
    </div>
    <p className="layer-keyframe-dependencies" title="Moving this point moves all these settings together; they also share its easing.">{settings.map((setting) => setting.label).join(' · ')}</p>
    <details className="layer-keyframe-point-details"><summary aria-label={`Edit layer keyframe ${point.frame}`}>Time, easing & values</summary>
      <div className="layer-keyframe-point-fields">
        <label htmlFor={`${listId}-${row.id}-frame`}>Timeline frame<NumberField id={`${listId}-${row.id}-frame`} aria-label={`Layer keyframe frame ${point.frame}`} aria-describedby={helpId} min={0} max={2_147_483_647} integer step={1} value={point.frame} disabled={disabled} resetKey={`${context}:${row.id}:frame`}
          validate={(value) => keys.some((other) => other.frame !== point.frame && other.frame === value) ? `Frame ${value} already has a shared point. Choose a different frame.` : null}
          onCommit={(nextFrame) => onEdit({ type: 'layer-key-move', layerId, frame: point.frame, nextFrame })} /></label>
        <label className="keyframe-easing" htmlFor={`${listId}-${row.id}-easing`}>Shared easing<select id={`${listId}-${row.id}-easing`} aria-label={`Layer keyframe interpolation ${point.frame}`} aria-describedby={helpId} title="Shared by these settings, to each setting's next participating point" disabled={disabled} value={point.interpolation} onChange={(event) => onEdit({ type: 'layer-key-easing', layerId, frame: point.frame, interpolation: event.target.value as Interpolation })}><option value="hold">Hold</option><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="smooth">Smooth</option></select></label>
        <div className="layer-keyframe-point-values">{settings.map((setting) => {
          const value = point.values[setting.key];
          if (value === null) return null;
          const id = `${listId}-${row.id}-${setting.key}`;
          const label = `${setting.label} keyframe value ${point.frame}`;
          const hint = `${setting.label} at stored timeline frame ${point.frame} on ${project.layers.find((layer) => layer.id === layerId)?.name}. Edits change only this participant, not the playhead, shared easing or static bases.`;
          const command = (nextValue: number): EditCommand => ({ type: 'layer-key-value', layerId, frame: point.frame, setting: setting.key, value: nextValue });
          const validate = (nextValue: number): string | null => {
            try { applyCommand(project, command(nextValue)); return null; }
            catch (cause) { return cause instanceof Error ? cause.message : 'This value conflicts with the track timing.'; }
          };
          const onCommit = (nextValue: number): void => { if (!disabled) onEdit(command(nextValue)); };
          const resetKey = `${context}:${row.id}:${setting.key}`;
          return <div className="keyframe-value colour-control" key={setting.key}>
            {setting.key === 'speed' ? <>
              <div className="layer-setting-heading"><span>Speed</span><button type="button" className="text-button" aria-label={`Reset ${label} to 1×`} title={hint} disabled={disabled || value === 1} onClick={() => onCommit(1)}><Icon name="reset" size={12} />Reset</button></div>
              <SpeedRateField id={id} aria-label={label} value={value} disabled={disabled} resetKey={resetKey} hint={hint} validate={validate} onCommit={onCommit} />
            </> : <RangeSettingControl setting={setting.key} id={id} label={label} value={value} disabled={disabled} hint={hint} resetTitle={hint} exact={{ resetKey, validate }} onCommit={onCommit} />}
          </div>;
        })}</div>
      </div>
    </details>
  </li>;
}

/** One project-time point list for the whole row, never one list per setting or clip. */
export function KeyframeControls({ project, layer, frame, duration, disabled, onEdit }: Readonly<KeyframeControlsProps>) {
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
  const inspection = navigation.inspection?.projectId === projectId && navigation.inspection.layerId === layer.id ? navigation.inspection : null;
  const selectedPoint = keys.find((key) => key.frame === inspection?.frame);
  const inspectedPoint = selectedPoint ?? (!previewAvailable ? pointAtFrame : undefined);
  const inspectedAway = inspectedPoint && (!previewAvailable || inspectedPoint.frame !== frame) ? inspectedPoint : undefined;
  const navigationFrame = keyframeNavigationFrame(inspection, layer.id, frame);
  const { previous, next } = keyframeNeighbors(keys, navigationFrame);
  const seekPoint = (point: LayerKeyframe): void => {
    if (!unavailable) navigation.onSeekKeyframe(layer.id, point.frame);
  };

  return <fieldset className="keyframe-controls declutter-keyframes layer-keyframe-controls" aria-label={`Layer keyframes ${layer.name}`}>
    <legend className="declutter-sr-only">Layer keyframes</legend>
    <div className="keyframe-toolbar">
      <strong className="keyframe-panel-title">Layer keyframes</strong>
      <span className="keyframe-count" title={`${keys.length} shared ${keys.length === 1 ? 'point' : 'points'} on ${layer.name}`}>{keys.length}<span className="declutter-sr-only"> {keys.length === 1 ? 'point' : 'points'}</span></span>
      <div className="keyframe-navigation">
        <button type="button" className="icon-button" aria-label="Previous layer keyframe" title={previous ? keySeekHint(previous.frame, duration) : 'No previous shared point'} disabled={unavailable || !previous} onClick={() => { if (previous) seekPoint(previous); }}><Icon name="back" size={14} /></button>
        <button type="button" className="icon-button" aria-label="Next layer keyframe" title={next ? keySeekHint(next.frame, duration) : 'No next shared point'} disabled={unavailable || !next} onClick={() => { if (next) seekPoint(next); }}><Icon name="forward" size={14} /></button>
      </div>
      {atHead && <button type="button" className="icon-button" disabled={unavailable} aria-label="Remove layer keyframe at playhead" title="Remove this whole shared point and all its participating settings" onClick={() => onEdit({ type: 'layer-key-remove', layerId: layer.id, frame: atHead.frame })}><Icon name="x" size={14} /></button>}
      <HelpPopover label="Animation" className="animation-help">
        <p>Each setting's diamond animates this whole video row, not just the selected clip. All participating settings share one point and its easing.</p>
        <div className="animation-legend"><span><span aria-hidden="true">◇</span>Static base · click to capture</span><span><Icon name="curve" size={14} />Row curve · capture before editing</span><span><span aria-hidden="true">◆</span>Key at playhead · editable</span></div>
        <p>Use the arrows beside a diamond to visit that setting's keys. Drag a timeline point to move all its participants; Escape cancels.</p>
        <p id={helpId}>Absolute project timeline frames, independent of clip trims. Moving a point moves every participating setting. Its easing runs to each setting's next participating point; the first and last channel values hold. An unkeyed setting uses each clip's base, or the layer base for layer opacity. Points outside the current duration stay editable; navigation previews the nearest available frame without moving them.</p>
      </HelpPopover>
    </div>

    <div className="layer-keyframe-current">
      <span className="layer-keyframe-position declutter-sr-only">{playheadLabel(frame, duration, atHead !== undefined)}</span>
      {atHead && <ParticipantChips point={atHead} />}
    </div>
    {inspectedAway && <div className="layer-keyframe-inspected">
      <span className="layer-keyframe-position">Stored point · timeline frame {inspectedAway.frame}{inspectedAway.frame >= duration ? ' · outside current duration' : ''}</span>
      <ParticipantChips point={inspectedAway} />
      <span className="layer-setting-hint">{duration === 0 ? 'No preview frame is available. This point remains editable below.' : `Preview is at frame ${frame}, not at this stored point.`}</span>
      {inspection && <button type="button" className="text-button" onClick={navigation.onFollowPlayhead}>Follow playhead</button>}
    </div>}

    {keys.length > 0 && <ol className="keyframe-list keyframe-entries" aria-label="Edit layer keys">{keys.map((key, index) => <KeyframePointRow key={current.rows[index]!.id} project={project} point={key} keys={keys} row={current.rows[index]!} layerId={layer.id} context={context} listId={listId} helpId={helpId} duration={duration} current={(inspection !== null || previewAvailable) && key.frame === navigationFrame} disabled={unavailable} onEdit={onEdit} onSeek={seekPoint} />)}</ol>}
  </fieldset>;
}
