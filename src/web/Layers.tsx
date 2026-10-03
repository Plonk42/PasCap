import { useId, useRef, useState } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { activeLayerSetting, evaluateLayerSetting, hasLayerKeys } from '../shared/keyframes.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';
import { Icon } from './icons.js';
import { KeyframeToggle } from './KeyframeToggle.js';
import { Popover } from './Popover.js';

function layerNameError(draft: string): string | null {
  const name = draft.trim();
  if (!name) return 'Enter a layer name (1–100 characters).';
  return name.length > 100 ? 'Use at most 100 characters.' : null;
}

function LayerName({ projectId, layer, disabled, onEdit, onCancel }: Readonly<{ projectId: string; layer: VideoLayer; disabled: boolean; onEdit: (command: EditCommand) => void; onCancel: () => void }>) {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const instructionsId = `${fieldId}-instructions`;
  const context = `${projectId}:${layer.id}`;
  const cancelBlur = useRef(false);
  const [state, setState] = useState(() => ({ context, name: layer.name, disabled, draft: layer.name, attempted: false }));
  if (state.context !== context || state.name !== layer.name || state.disabled !== disabled) {
    setState({ context, name: layer.name, disabled, draft: layer.name, attempted: false });
  }
  const error = state.attempted ? layerNameError(state.draft) : null;
  const dirty = state.draft !== layer.name;
  const restore = (): void => setState({ context, name: layer.name, disabled, draft: layer.name, attempted: false });
  const commit = (): void => {
    if (disabled || !dirty) return;
    if (layerNameError(state.draft)) { setState({ ...state, attempted: true }); return; }
    const name = state.draft.trim();
    restore();
    if (name !== layer.name) onEdit({ type: 'layer-update', layer: { ...layer, name } });
  };
  return <div className="layer-name-field" data-dirty={dirty}>
    <label htmlFor={fieldId}>Layer name<input id={fieldId} aria-label={`Rename layer ${layer.name}`} value={state.draft} maxLength={100} disabled={disabled} aria-invalid={error !== null} aria-errormessage={error ? errorId : undefined} aria-describedby={[instructionsId, error ? errorId : null].filter(Boolean).join(' ')} title="Enter or leave the field to apply. Escape restores the name." onFocus={() => { cancelBlur.current = false; }} onChange={(event) => setState({ ...state, draft: event.currentTarget.value, attempted: false })} onBlur={() => {
      if (cancelBlur.current) { cancelBlur.current = false; return; }
      commit();
    }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(); }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        // Returning focus closes the popover and blurs synchronously; do not submit the cancelled draft.
        cancelBlur.current = true; restore(); onCancel();
      }
    }} /></label>
    <span className="declutter-sr-only" id={instructionsId}>1–100 characters. Enter or leave the field to apply. Escape restores the current name.</span>
    {error ? <span className="layer-name-error" id={errorId} role="alert">{error} Press Escape to restore {layer.name}.</span> : dirty && <span className="layer-name-pending">Not applied · Enter or leave the field to apply.</span>}
  </div>;
}

function LayerOpacity({ layer, frame, disabled, onEdit }: Readonly<{ layer: VideoLayer; frame: number; disabled: boolean; onEdit: (command: EditCommand) => void }>) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const keyed = hasLayerKeys(layer, 'layerOpacity');
  const active = activeLayerSetting(layer, 'layerOpacity', frame);
  const value = evaluateLayerSetting(layer, 'layerOpacity', frame, layer.opacity);
  const validFrame = Number.isSafeInteger(frame) && frame >= 0 && frame <= 2_147_483_647;
  const editable = validFrame && (!keyed || active);
  let scope = 'Layer base';
  let hint = 'Static layer opacity, applied after the row clips are combined.';
  if (keyed) {
    scope = active ? 'Layer key' : 'Layer curve';
    hint = active ? `Editing only Layer opacity at timeline frame ${frame}. Other point participants stay unchanged.`
      : 'Layer curve · click the Layer opacity diamond to capture a value and edit this timeline frame.';
  }
  const commit = (opacity: number): void => {
    if (disabled || !editable) return;
    if (keyed) onEdit({ type: 'layer-key-value', layerId: layer.id, frame, setting: 'layerOpacity', value: opacity });
    else onEdit({ type: 'layer-update', layer: { ...layer, opacity } });
  };
  return <div className="layer-opacity-label layer-keyed-opacity">
    <span className="layer-opacity-heading"><label htmlFor={fieldId}>Opacity<small className="layer-setting-kind">{scope}</small></label><span className="layer-setting-actions"><output>{Math.round(value * 100)}%</output><KeyframeToggle layer={layer} setting="layerOpacity" label="Layer opacity" frame={frame} value={value} disabled={disabled} onEdit={onEdit} /></span></span>
    <input id={fieldId} type="range" aria-label={`Opacity of layer ${layer.name}`} aria-describedby={hintId} min={0} max={1} step={0.01} value={value} disabled={disabled || !editable} title={hint} onChange={(event) => commit(Number(event.target.value))} />
    <span id={hintId} className={editable ? 'declutter-sr-only' : 'layer-setting-hint'}>{hint}</span>
  </div>;
}

export function Layers({ project, selectedId, scrollTop, frame, disabled, onSelect, onEdit }: Readonly<{ project: ProjectDocument; selectedId: string; scrollTop: number; frame: number; disabled: boolean; onSelect: (id: string) => void; onEdit: (command: EditCommand) => void }>) {
  const move = (index: number, delta: number): void => {
    const ids = project.layers.map((layer) => layer.id);
    [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
    onEdit({ type: 'layer-order', layerIds: ids });
  };
  return <aside className="layer-sidebar declutter-layers" aria-label="Video layers">
    <div className="layer-sidebar-heading" title="Bottom primary track ripple-edits. Upper layers have independent placement; higher layers cover lower footage.">Video layers · {project.layers.length} / 8</div>
    {[...project.layers].reverse().map((layer, row) => {
      const index = project.layers.length - 1 - row;
      return <div key={layer.id} className={`layer-control ${layer.id === selectedId ? 'selected' : ''}`} data-layer-id={layer.id} style={{ top: 58 + row * 88 - scrollTop }}>
        <div className="layer-control-main">
          <button className="icon-button" aria-label={`${layer.enabled ? 'Hide' : 'Show'} layer ${layer.name}`} title={layer.enabled ? 'Hide layer in preview and export' : 'Show layer in preview and export'} disabled={disabled} onClick={() => onEdit({ type: 'layer-update', layer: { ...layer, enabled: !layer.enabled } })}><Icon name={layer.enabled ? 'eye' : 'eye-off'} size={15} /></button>
          <button className="text-button layer-select" aria-label={`Select layer ${layer.name}`} aria-pressed={layer.id === selectedId} disabled={disabled} title={index === 0 ? 'Primary track: edits ripple subsequent clips' : 'Overlay: clips use independent start positions'} onClick={() => onSelect(layer.id)}>{layer.name}</button>
          <Popover label={`Layer options ${layer.name}`} className="layer-options">{(close) => <>
            <LayerName projectId={project.id} layer={layer} disabled={disabled} onEdit={onEdit} onCancel={close} />
            <LayerOpacity layer={layer} frame={frame} disabled={disabled} onEdit={onEdit} />
            <div className="layer-options-actions">
              <button className="secondary-button small" aria-label={`Raise layer ${layer.name}`} title="Raise overlay above the next layer" disabled={disabled || index === 0 || index === project.layers.length - 1} onClick={() => move(index, 1)}><Icon name="chevron-up" size={14} />Raise</button>
              <button className="secondary-button small" aria-label={`Lower layer ${layer.name}`} title="Lower overlay below the previous layer" disabled={disabled || index <= 1} onClick={() => move(index, -1)}><Icon name="chevron-down" size={14} />Lower</button>
              <button className="secondary-button small layer-delete" aria-label={`Delete layer ${layer.name}`} title="Remove this overlay and its clips · Undo restores them" disabled={disabled || index === 0} onClick={() => { close(); onEdit({ type: 'layer-remove', layerId: layer.id }); }}><Icon name="trash" size={14} />Delete layer</button>
            </div>
          </>}</Popover>
        </div>
        {index === 0 && <span className="layer-kind">Primary · ripple</span>}
      </div>;
    })}
  </aside>;
}