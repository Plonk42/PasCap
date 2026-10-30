import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { EditCommand } from '../shared/commands.js';
import { MAX_VIDEO_LAYERS, type ProjectDocument, type VideoLayer } from '../shared/model.js';
import './adjustment-lane.css';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { layerActionRestrictions } from './layer-actions.js';
import { Popover } from './Popover.js';
import { LANE_HEIGHT, LANE_OFFSET, timelineRows } from './timeline-rows.js';

function layerNameError(draft: string): string | null {
  const name = draft.trim();
  if (!name) return 'Enter a track name (1–100 characters).';
  return name.length > 100 ? 'Use at most 100 characters.' : null;
}

function LayerName({
  projectId,
  layer,
  disabled,
  onEdit,
  onCancel,
}: Readonly<{
  projectId: string;
  layer: VideoLayer;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onCancel: () => void;
}>) {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const instructionsId = `${fieldId}-instructions`;
  const context = `${projectId}:${layer.id}`;
  const cancelBlur = useRef(false);
  const [state, setState] = useState(() => ({
    context,
    name: layer.name,
    disabled,
    draft: layer.name,
    attempted: false,
  }));
  if (state.context !== context || state.name !== layer.name || state.disabled !== disabled) {
    setState({ context, name: layer.name, disabled, draft: layer.name, attempted: false });
  }
  const error = state.attempted ? layerNameError(state.draft) : null;
  const dirty = state.draft !== layer.name;
  const restore = (): void => setState({ context, name: layer.name, disabled, draft: layer.name, attempted: false });
  const commit = (): void => {
    if (disabled || !dirty) return;
    if (layerNameError(state.draft)) {
      setState({ ...state, attempted: true });
      return;
    }
    const name = state.draft.trim();
    restore();
    if (name !== layer.name) onEdit({ type: 'layer-update', layer: { ...layer, name } });
  };
  return (
    <div className="layer-name-field" data-dirty={dirty}>
      <label htmlFor={fieldId}>
        Track name{' '}
        <input
          id={fieldId}
          aria-label={`Rename track ${layer.name}`}
          value={state.draft}
          maxLength={100}
          disabled={disabled}
          aria-invalid={error !== null}
          aria-errormessage={error ? errorId : undefined}
          aria-describedby={[instructionsId, error ? errorId : null].filter(Boolean).join(' ')}
          title="Enter or leave the field to apply. Escape restores the name."
          onFocus={() => {
            cancelBlur.current = false;
          }}
          onChange={(event) => setState({ ...state, draft: event.currentTarget.value, attempted: false })}
          onBlur={() => {
            if (cancelBlur.current) {
              cancelBlur.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              commit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              // Returning focus closes the popover and blurs synchronously; do not submit the canceled draft.
              cancelBlur.current = true;
              restore();
              onCancel();
            }
          }}
        />
      </label>
      <span className="sr-only" id={instructionsId}>
        1–100 characters. Enter or leave the field to apply. Escape restores the current name.
      </span>
      {error ? (
        <span className="layer-name-error" id={errorId} role="alert">
          {error} Press Escape to restore {layer.name}.
        </span>
      ) : (
        dirty && <span className="layer-name-pending">Not applied · Enter or leave the field to apply.</span>
      )}
    </div>
  );
}

export function Layers({
  project,
  selectedId,
  scrollTop,
  surfaceHeight,
  viewportHeight,
  disabled,
  onScroll,
  onSelect,
  onSelectClips,
  onEdit,
  onAdd,
  addAdjustment,
  onAddAdjustment,
}: Readonly<{
  project: ProjectDocument;
  selectedId: string;
  scrollTop: number;
  surfaceHeight: number;
  viewportHeight: number | null;
  disabled: boolean;
  onScroll: (top: number) => void;
  onSelect: (id: string) => void;
  /** Adds every clip of the track to the clip selection. */
  onSelectClips: (id: string) => void;
  onEdit: (command: EditCommand) => void;
  onAdd: () => void;
  /** What Add adjustment covers, or why it is unavailable. */
  addAdjustment: { available: boolean; title: string };
  onAddAdjustment: () => void;
}>) {
  const viewport = useRef<HTMLElement>(null);
  const synchronizedScroll = useRef<number | null>(null);
  const reasonId = useId();
  useLayoutEffect(() => {
    if (viewport.current && viewport.current.scrollTop !== scrollTop) {
      viewport.current.scrollTop = scrollTop;
      synchronizedScroll.current = viewport.current.scrollTop;
    }
  }, [scrollTop, surfaceHeight, viewportHeight]);
  const move = (index: number, delta: number): void => {
    const ids = project.layers.map((layer) => layer.id);
    [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
    onEdit({ type: 'layer-order', layerIds: ids });
  };
  const full = project.layers.length >= MAX_VIDEO_LAYERS;
  return (
    <aside
      ref={viewport}
      className="layer-sidebar editor-layers"
      aria-label="Video tracks"
      style={{ height: viewportHeight ?? undefined }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        // A queued synchronization event must not overwrite a newer native timeline focus scroll.
        if (top === synchronizedScroll.current) return;
        synchronizedScroll.current = null;
        onScroll(top);
      }}
    >
      <div className="layer-sidebar-surface" style={{ height: surfaceHeight }}>
        <div className="layer-sidebar-heading">
          <span
            className="layer-sidebar-title"
            title="Track 1 renders below track 2, then track 3 above track 2. Every track has independent Ripple, transitions and fades."
          >
            Video tracks · {project.layers.length} / {MAX_VIDEO_LAYERS}
          </span>
          <button
            className="text-button layer-add"
            aria-label="Add video track"
            title={
              full
                ? `A project can contain at most ${MAX_VIDEO_LAYERS} video tracks. Delete a track before adding another.`
                : 'Add a video track with Ripple on, independent transitions and fades'
            }
            disabled={disabled || full}
            onClick={onAdd}
          >
            <Icon name="plus" size={14} />
            <span className="layer-add-label">Track</span>
          </button>
        </div>
        <div
          className="layer-sidebar-adjustments"
          title="Adjustments grade every video track over their range, after each clip's own grade"
        >
          <Icon name="color" size={14} />
          <span className="layer-sidebar-title">Adjustments · {project.adjustments.length}</span>
          <button
            className="text-button layer-add"
            aria-label="Add adjustment"
            aria-disabled={!addAdjustment.available || undefined}
            title={addAdjustment.title}
            disabled={disabled}
            onClick={() => {
              if (addAdjustment.available) onAddAdjustment();
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {timelineRows(project.layers).map(({ layer, index, top }) => {
          const restrictions = layerActionRestrictions(index, project.layers.length, disabled);
          const description = `${reasonId}-${layer.id}`;
          return (
            <div
              key={layer.id}
              className={`layer-control ${layer.id === selectedId ? 'selected' : ''}`}
              data-layer-id={layer.id}
              style={{ top: top - LANE_OFFSET, height: LANE_HEIGHT }}
            >
              <div className="layer-control-main">
                <button
                  className="icon-button"
                  aria-label={`${layer.enabled ? 'Hide' : 'Show'} track ${layer.name}`}
                  title={layer.enabled ? 'Hide track in preview and export' : 'Show track in preview and export'}
                  disabled={disabled}
                  onClick={() => onEdit({ type: 'layer-update', layer: { ...layer, enabled: !layer.enabled } })}
                >
                  <Icon name={layer.enabled ? 'eye' : 'eye-off'} size={15} />
                </button>
                <button
                  className="text-button layer-select"
                  aria-label={`Select track ${layer.name}`}
                  aria-pressed={layer.id === selectedId}
                  disabled={disabled}
                  title="Select this track"
                  onClick={() => onSelect(layer.id)}
                >
                  {layer.name}
                </button>
                <button
                  className={`icon-button layer-ripple-toggle ${layer.ripple ? 'active' : ''}`}
                  aria-label={`Toggle Ripple on ${layer.name}`}
                  aria-pressed={layer.ripple}
                  title={
                    layer.ripple
                      ? 'Ripple on: later clips follow the first one. Click to keep independent starts.'
                      : 'Ripple off: clips keep independent starts. Click to pack the track from its first clip.'
                  }
                  disabled={disabled}
                  onClick={() => onEdit({ type: 'layer-update', layer: { ...layer, ripple: !layer.ripple } })}
                >
                  <Icon name="ripple" size={15} />
                </button>
                <button
                  className="icon-button layer-select-clips"
                  aria-label={`Select all clips on ${layer.name}`}
                  title={
                    project.clips.some((clip) => clip.layerId === layer.id)
                      ? 'Add every clip of this track to the selection; drag one to move them together'
                      : 'This track has no clips to select'
                  }
                  disabled={disabled || !project.clips.some((clip) => clip.layerId === layer.id)}
                  onClick={() => onSelectClips(layer.id)}
                >
                  <Icon name="select-all" size={15} />
                </button>
                <Popover label={`Track options ${layer.name}`} className="layer-options">
                  {(close) => (
                    <>
                      <LayerName
                        projectId={project.id}
                        layer={layer}
                        disabled={disabled}
                        onEdit={onEdit}
                        onCancel={close}
                      />
                      <div className="layer-ripple-control">
                        <label title="Enabling Ripple packs this track in one Undo step, preserving its first clip’s current start and existing dissolves. Turning it off preserves current placements.">
                          <input
                            type="checkbox"
                            aria-label={`Ripple on track ${layer.name}`}
                            aria-describedby={`${description}-ripple`}
                            checked={layer.ripple}
                            disabled={disabled}
                            onChange={(event) =>
                              onEdit({ type: 'layer-update', layer: { ...layer, ripple: event.currentTarget.checked } })
                            }
                          />{' '}
                          Ripple
                        </label>
                        <HelpPopover label={`Ripple on ${layer.name}`} guide="assemble-trim-and-cut">
                          <p id={`${description}-ripple`}>
                            On: clips stay packed; trimming or deleting closes gaps. Off: clips keep their positions.
                          </p>
                          <p className="editor-help-tip">Tip: other tracks and music never move with this switch.</p>
                        </HelpPopover>
                      </div>
                      <div className="layer-options-actions">
                        <button
                          className="secondary-button small"
                          aria-label={`Raise track ${layer.name}`}
                          aria-describedby={restrictions.raise ? `${description}-raise` : undefined}
                          title={restrictions.raise ?? 'Composite this track above the next track'}
                          disabled={restrictions.raise !== null}
                          onClick={() => move(index, 1)}
                        >
                          <Icon name="chevron-up" size={14} />
                          Raise
                        </button>
                        <button
                          className="secondary-button small"
                          aria-label={`Lower track ${layer.name}`}
                          aria-describedby={restrictions.lower ? `${description}-lower` : undefined}
                          title={restrictions.lower ?? 'Composite this track below the previous track'}
                          disabled={restrictions.lower !== null}
                          onClick={() => move(index, -1)}
                        >
                          <Icon name="chevron-down" size={14} />
                          Lower
                        </button>
                        <button
                          className="secondary-button small layer-delete"
                          aria-label={`Delete track ${layer.name}`}
                          aria-describedby={restrictions.remove ? `${description}-remove` : undefined}
                          title={restrictions.remove ?? 'Remove this track and its clips · Undo restores them'}
                          disabled={restrictions.remove !== null}
                          onClick={() => {
                            close();
                            onEdit({ type: 'layer-remove', layerId: layer.id });
                          }}
                        >
                          <Icon name="trash" size={14} />
                          Delete track
                        </button>
                      </div>
                      {restrictions.raise && (
                        <span className="sr-only" id={`${description}-raise`}>
                          {restrictions.raise}
                        </span>
                      )}
                      {restrictions.lower && (
                        <span className="sr-only" id={`${description}-lower`}>
                          {restrictions.lower}
                        </span>
                      )}
                      {restrictions.remove && (
                        <span className="sr-only" id={`${description}-remove`}>
                          {restrictions.remove}
                        </span>
                      )}
                    </>
                  )}
                </Popover>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
