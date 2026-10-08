import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoLayer } from '../shared/model.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { layerActionRestrictions } from './layer-actions.js';
import { Popover } from './Popover.js';
import { timelineRows } from './timeline-rows.js';

function layerNameError(draft: string): string | null {
  const name = draft.trim();
  if (!name) return 'Enter a layer name (1–100 characters).';
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
        Layer name
        <input
          id={fieldId}
          aria-label={`Rename layer ${layer.name}`}
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
              // Returning focus closes the popover and blurs synchronously; do not submit the cancelled draft.
              cancelBlur.current = true;
              restore();
              onCancel();
            }
          }}
        />
      </label>
      <span className="declutter-sr-only" id={instructionsId}>
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
  onEdit,
}: Readonly<{
  project: ProjectDocument;
  selectedId: string;
  scrollTop: number;
  surfaceHeight: number;
  viewportHeight: number | null;
  disabled: boolean;
  onScroll: (top: number) => void;
  onSelect: (id: string) => void;
  onEdit: (command: EditCommand) => void;
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
  return (
    <aside
      ref={viewport}
      className="layer-sidebar declutter-layers"
      aria-label="Video layers"
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
        <div
          className="layer-sidebar-heading"
          title="Row 1 renders below row 2, then row 3 above row 2. Every track has independent Ripple, transitions and fades."
        >
          Video layers · {project.layers.length} / 8
        </div>
        {timelineRows(project.layers).map(({ layer, index, top }) => {
          const restrictions = layerActionRestrictions(index, project.layers.length, disabled);
          const description = `${reasonId}-${layer.id}`;
          return (
            <div
              key={layer.id}
              className={`layer-control ${layer.id === selectedId ? 'selected' : ''}`}
              data-layer-id={layer.id}
              style={{ top }}
            >
              <div className="layer-control-main">
                <button
                  className="icon-button"
                  aria-label={`${layer.enabled ? 'Hide' : 'Show'} layer ${layer.name}`}
                  title={layer.enabled ? 'Hide layer in preview and export' : 'Show layer in preview and export'}
                  disabled={disabled}
                  onClick={() => onEdit({ type: 'layer-update', layer: { ...layer, enabled: !layer.enabled } })}
                >
                  <Icon name={layer.enabled ? 'eye' : 'eye-off'} size={15} />
                </button>
                <button
                  className="text-button layer-select"
                  aria-label={`Select layer ${layer.name}`}
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
                <Popover label={`Layer options ${layer.name}`} className="layer-options">
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
                            aria-label={`Ripple on layer ${layer.name}`}
                            aria-describedby={`${description}-ripple`}
                            checked={layer.ripple}
                            disabled={disabled}
                            onChange={(event) =>
                              onEdit({ type: 'layer-update', layer: { ...layer, ripple: event.currentTarget.checked } })
                            }
                          />
                          Ripple
                        </label>
                        <HelpPopover label={`Ripple on ${layer.name}`}>
                          <p id={`${description}-ripple`}>
                            On: clips pack continuously from the first clip’s current project-frame start, retaining
                            existing dissolves. Enabling closes gaps in one Undo step; it does not move the first
                            anchor. Off: current placements are kept and each start is independent. Other tracks, music
                            and row points never move with this switch. New tracks start with Ripple on.
                          </p>
                        </HelpPopover>
                      </div>
                      <div className="layer-options-actions">
                        <button
                          className="secondary-button small"
                          aria-label={`Raise layer ${layer.name}`}
                          aria-describedby={restrictions.raise ? `${description}-raise` : undefined}
                          title={restrictions.raise ?? 'Composite this track above the next layer'}
                          disabled={restrictions.raise !== null}
                          onClick={() => move(index, 1)}
                        >
                          <Icon name="chevron-up" size={14} />
                          Raise
                        </button>
                        <button
                          className="secondary-button small"
                          aria-label={`Lower layer ${layer.name}`}
                          aria-describedby={restrictions.lower ? `${description}-lower` : undefined}
                          title={restrictions.lower ?? 'Composite this track below the previous layer'}
                          disabled={restrictions.lower !== null}
                          onClick={() => move(index, -1)}
                        >
                          <Icon name="chevron-down" size={14} />
                          Lower
                        </button>
                        <button
                          className="secondary-button small layer-delete"
                          aria-label={`Delete layer ${layer.name}`}
                          aria-describedby={restrictions.remove ? `${description}-remove` : undefined}
                          title={restrictions.remove ?? 'Remove this track and its clips · Undo restores them'}
                          disabled={restrictions.remove !== null}
                          onClick={() => {
                            close();
                            onEdit({ type: 'layer-remove', layerId: layer.id });
                          }}
                        >
                          <Icon name="trash" size={14} />
                          Delete layer
                        </button>
                      </div>
                      {restrictions.raise && (
                        <span className="declutter-sr-only" id={`${description}-raise`}>
                          {restrictions.raise}
                        </span>
                      )}
                      {restrictions.lower && (
                        <span className="declutter-sr-only" id={`${description}-lower`}>
                          {restrictions.lower}
                        </span>
                      )}
                      {restrictions.remove && (
                        <span className="declutter-sr-only" id={`${description}-remove`}>
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
