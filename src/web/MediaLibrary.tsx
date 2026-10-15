import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import {
  resolveMediaSelection,
  sourceFrameAtRatio,
  sourcePointerRatio,
  type MediaSelections,
} from '../shared/media-selection.js';
import type { MediaAsset } from '../shared/media.js';
import { MAX_VIDEO_LAYERS, type ProjectDocument } from '../shared/model.js';
import { mediaRemovalUsage } from '../shared/projects.js';
import { durationLabel, MEDIA_DRAG_TYPE, mediaReady, shortName } from './display.js';
import { Icon } from './icons.js';
import type { RelinkTarget } from './ImportDialog.js';
import './media-review.css';
import './media-import.css';
import { MediaMusicList, musicMatchesFilter } from './MediaMusicList.js';
import './rush-source.css';
import { Popover } from './Popover.js';
import { readPreference, writePreference } from './preferences.js';
import { RemoveMediaDialog } from './RemoveMediaDialog.js';

interface Props {
  assets: MediaAsset[];
  music: AudioAsset[];
  project: ProjectDocument | null;
  ranges: MediaSelections;
  busy: boolean;
  onInsert: (mediaIds: string[]) => void;
  onInsertOnNewTrack: (mediaIds: string[]) => void;
  onDragMedia: (mediaIds: string[] | null) => void;
  onPrepare: (mediaIds: string[]) => Promise<void>;
  onPrepareMusic: (id: string) => Promise<void>;
  /** Recordings and music whose original is not at its registered path. */
  missing: ReadonlySet<string>;
  onRelink: (target: RelinkTarget | null) => void;
  onRemove: (mediaIds: string[]) => boolean;
  onRemoveMusic: (ids: string[]) => boolean;
  onImport: () => void;
  /** Changes after a successful import, so new media is not hidden by a search or filter. */
  importRevision: number;
  review: ReviewTarget | null;
  /** `choose` remembers the recording to return to once hovering ends. */
  onReview: (review: ReviewTarget, choose: boolean) => void;
  onReviewHoverEnd: () => void;
  targetLayer: string;
}

export interface ReviewTarget {
  mediaId: string;
  frame: number;
}
interface HoverRequest {
  projectId: string | null;
  mediaId: string;
  element: HTMLButtonElement;
  clientX: number;
}
interface HoverMarker {
  projectId: string | null;
  mediaId: string;
  ratio: number;
}

const STATUS_LABEL: Record<MediaAsset['status'], string> = {
  ready: 'Ready',
  registered: 'Not prepared',
  queued: 'Queued',
  preparing: 'Preparing',
  error: 'Preparation failed',
};
const STATUS_ICON = {
  ready: 'check',
  registered: 'activity',
  queued: 'activity',
  preparing: 'activity',
  error: 'warning',
} as const;
const FILTER_LABEL: Record<string, string> = {
  all: '',
  ready: 'Ready',
  unprepared: 'Not prepared',
  used: 'In timeline',
};

function externalFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files') && !Array.from(transfer.types).includes(MEDIA_DRAG_TYPE);
}

function MissingOriginals({ count, busy, onRelink }: Readonly<{ count: number; busy: boolean; onRelink: () => void }>) {
  if (!count) return null;
  return (
    <div className="media-missing-bar">
      <Icon name="warning" size={14} />
      <span>
        {count} {count === 1 ? 'original is' : 'originals are'} missing
      </span>
      <button
        type="button"
        className="secondary-button small"
        title="Search the folder your recordings were moved to and relink every one found"
        disabled={busy}
        onClick={onRelink}
      >
        <Icon name="link" size={14} />
        Relink folder…
      </button>
    </div>
  );
}

function cardStatus(asset: MediaAsset, lost: boolean, readyLabel: string) {
  if (lost)
    return {
      state: 'missing',
      label: 'Original missing',
      spoken: 'Original missing',
      icon: 'warning',
      title: `Not found at ${asset.sourcePath}`,
    } as const;
  const label = asset.status === 'ready' ? readyLabel : STATUS_LABEL[asset.status];
  return {
    state: asset.status,
    label,
    spoken: STATUS_LABEL[asset.status],
    icon: STATUS_ICON[asset.status],
    title: asset.error ?? label,
  };
}

function MediaAction({
  asset,
  hasProject,
  trimmed,
  targetLayer,
  trackLimit,
  busy,
  missing,
  onInsert,
  onInsertOnNewTrack,
  onPrepare,
  onRelink,
}: Readonly<{
  asset: MediaAsset;
  hasProject: boolean;
  trimmed: boolean;
  targetLayer: string;
  trackLimit: boolean;
  busy: boolean;
  missing: boolean;
  onInsert: Props['onInsert'];
  onInsertOnNewTrack: Props['onInsertOnNewTrack'];
  onPrepare: Props['onPrepare'];
  onRelink: Props['onRelink'];
}>) {
  const rangeLabel = trimmed ? 'selected range' : 'full recording';
  if (missing)
    return (
      <>
        <button
          className="icon-button relink-media"
          aria-label={`Relink ${asset.name}`}
          title={`Original missing at ${asset.sourcePath}. Relink it to its moved copy`}
          disabled={busy}
          onClick={() => onRelink({ kind: 'video', id: asset.id, name: asset.name, sourcePath: asset.sourcePath })}
        >
          <Icon name="link" size={15} />
        </button>
        <span className="media-action-space" aria-hidden="true" />
      </>
    );
  if (mediaReady(asset))
    return (
      <>
        <button
          className="icon-button add-media"
          aria-label={`Add ${asset.name} to timeline`}
          title={`Add ${rangeLabel} to ${targetLayer}`}
          disabled={!hasProject || busy}
          onClick={() => onInsert([asset.id])}
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          className="icon-button add-media-new-track"
          aria-label={`Add ${asset.name} to a new track`}
          title={
            trackLimit
              ? `A project can have at most ${MAX_VIDEO_LAYERS} video tracks`
              : `Add ${rangeLabel} to a new track`
          }
          disabled={!hasProject || busy || trackLimit}
          onClick={() => onInsertOnNewTrack([asset.id])}
        >
          <Icon name="layers" size={15} />
        </button>
      </>
    );
  if (asset.status === 'queued' || asset.status === 'preparing')
    return (
      <>
        <span className="media-action-space" aria-hidden="true" />
        <span className="media-action-space" aria-hidden="true" />
      </>
    );
  return (
    <>
      <button
        className="icon-button prepare-media"
        aria-label={`Prepare ${asset.name}`}
        title={asset.error ?? 'Prepare'}
        disabled={busy}
        onClick={() => {
          void onPrepare([asset.id]);
        }}
      >
        <Icon name={asset.status === 'error' ? 'reset' : 'wand'} size={15} />
      </button>
      <span className="media-action-space" aria-hidden="true" />
    </>
  );
}

export function MediaLibrary({
  assets,
  music,
  project,
  ranges,
  busy,
  onInsert,
  onInsertOnNewTrack,
  onDragMedia,
  onPrepare,
  onPrepareMusic,
  missing,
  onRelink,
  onRemove,
  onRemoveMusic,
  onImport,
  importRevision,
  review,
  onReview,
  onReviewHoverEnd,
  targetLayer,
}: Readonly<Props>) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('name');
  const [view, setView] = useState<'list' | 'grid'>(() =>
    readPreference('pascap-media-view') === 'grid' ? 'grid' : 'list',
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rangeIdPrefix = useId();
  const selectAll = useRef<HTMLInputElement>(null);
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [dropError, setDropError] = useState('');
  const [confirmPrepare, setConfirmPrepare] = useState(false);
  const [removing, setRemoving] = useState<readonly string[] | null>(null);
  const [hover, setHover] = useState<HoverMarker | null>(null);
  const hoverRequest = useRef<HoverRequest | null>(null);
  const hoverAnimation = useRef<number | null>(null);
  const projectId = project?.id ?? null;
  const latestLibrary = useRef({ assets, projectId });
  latestLibrary.current = { assets, projectId };

  const clearHover = useCallback((): void => {
    if (hoverAnimation.current !== null) cancelAnimationFrame(hoverAnimation.current);
    hoverAnimation.current = null;
    hoverRequest.current = null;
    setHover(null);
  }, []);
  useEffect(() => {
    clearHover();
    setSelected(new Set());
    setLastSelected(null);
    setConfirmPrepare(false);
    setRemoving(null);
    return () => {
      if (hoverAnimation.current !== null) cancelAnimationFrame(hoverAnimation.current);
      hoverAnimation.current = null;
      hoverRequest.current = null;
    };
  }, [clearHover, projectId]);
  useEffect(() => {
    if (importRevision === 0) return;
    setSearch('');
    setFilter('all');
  }, [importRevision]);
  useEffect(() => {
    const preventNavigation = (event: globalThis.DragEvent): void => {
      if (!event.dataTransfer || !externalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
      // A refused desktop drop may never dispatch "drop"; explain it during dragover too.
      setDropError('Dropping files is not supported. Use Import to add recordings; originals stay in place.');
    };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => {
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
    };
  }, []);

  const applyHover = (request: HoverRequest, choose = false): boolean => {
    if (request.projectId !== latestLibrary.current.projectId) return false;
    const asset = latestLibrary.current.assets.find((item) => item.id === request.mediaId);
    if (!asset || !mediaReady(asset) || !request.element.isConnected) return false;
    const bounds = request.element.getBoundingClientRect();
    if (bounds.width <= 0) return false;
    const ratio = sourcePointerRatio(request.clientX, bounds.left, bounds.width);
    onReview({ mediaId: asset.id, frame: sourceFrameAtRatio(ratio, asset.metadata.frameCount) }, choose);
    setHover({ projectId: request.projectId, mediaId: asset.id, ratio });
    return true;
  };
  const queueHover = (event: PointerEvent<HTMLButtonElement>, asset: MediaAsset): void => {
    if (!mediaReady(asset) || event.pointerType === 'touch' || event.buttons !== 0) return;
    hoverRequest.current = { projectId, mediaId: asset.id, element: event.currentTarget, clientX: event.clientX };
    if (hoverAnimation.current !== null) return;
    hoverAnimation.current = requestAnimationFrame(() => {
      hoverAnimation.current = null;
      const request = hoverRequest.current;
      hoverRequest.current = null;
      if (request) applyHover(request);
    });
  };
  const leaveHover = (mediaId: string): void => {
    // Without a chosen recording, the final hovered frame stays paused.
    if (hoverRequest.current?.mediaId === mediaId) applyHover(hoverRequest.current);
    clearHover();
    onReviewHoverEnd();
  };
  const activateReview = (asset: MediaAsset): void => {
    if (!mediaReady(asset)) return;
    // A click before the next animation frame chooses the frame under the pointer.
    const pending = hoverRequest.current;
    if (pending?.mediaId === asset.id) {
      hoverRequest.current = null;
      if (applyHover(pending, true)) return;
    }
    const range = resolveMediaSelection(asset.id, asset.metadata.frameCount, ranges);
    onReview(review?.mediaId === asset.id ? review : { mediaId: asset.id, frame: range.sourceIn }, true);
  };
  const reviewedAsset = assets.find((asset) => asset.id === review?.mediaId && mediaReady(asset));

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    project?.clips.forEach((clip) => counts.set(clip.mediaId, (counts.get(clip.mediaId) ?? 0) + 1));
    return counts;
  }, [project]);
  const visible = useMemo(
    () =>
      assets
        .filter((asset) => {
          if (!asset.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return false;
          if (filter === 'ready') return mediaReady(asset);
          if (filter === 'unprepared') return !mediaReady(asset);
          if (filter === 'used') return usage.has(asset.id);
          return true;
        })
        .sort((left, right) => {
          if (sort === 'duration')
            return (
              right.metadata.frameCount - left.metadata.frameCount ||
              left.name.localeCompare(right.name, undefined, { numeric: true })
            );
          if (sort === 'recent') return right.fingerprint.mtimeMs - left.fingerprint.mtimeMs;
          return left.name.localeCompare(right.name, undefined, { numeric: true });
        }),
    [assets, filter, search, sort, usage],
  );
  const selectedAssets = assets.filter((asset) => selected.has(asset.id));
  const visibleMusic = music.filter((asset) => musicMatchesFilter(asset, project, search, filter));
  const prepareIds = selectedAssets
    .filter((asset) => !mediaReady(asset) && !['queued', 'preparing'].includes(asset.status))
    .map((asset) => asset.id);
  const allVisibleSelected = visible.length > 0 && visible.every((asset) => selected.has(asset.id));
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = !allVisibleSelected && visible.some((asset) => selected.has(asset.id));
  }, [allVisibleSelected, selected, visible]);

  const toggle = (id: string): void => {
    setConfirmPrepare(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastSelected(id);
  };
  const choose = (event: MouseEvent, id: string): void => {
    setConfirmPrepare(false);
    if (event.shiftKey && lastSelected !== null) {
      const from = visible.findIndex((asset) => asset.id === lastSelected);
      const to = visible.findIndex((asset) => asset.id === id);
      if (from >= 0 && to >= 0) {
        setSelected(
          (previous) =>
            new Set([
              ...previous,
              ...visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((asset) => asset.id),
            ]),
        );
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) toggle(id);
    else setLastSelected(id);
  };
  const prepareSelected = (): void => {
    if (prepareIds.length > 1) setConfirmPrepare(true);
    else void onPrepare(prepareIds);
  };
  const setLibraryView = (next: 'list' | 'grid'): void => {
    setView(next);
    writePreference('pascap-media-view', next);
  };
  const clearSelected = (): void => {
    setSelected(new Set());
    setLastSelected(null);
    setConfirmPrepare(false);
  };
  const remove = (ids: readonly string[]): void => {
    const first = visible.findIndex((asset) => ids.includes(asset.id));
    const remaining = (asset: MediaAsset): boolean => !ids.includes(asset.id);
    const neighbour =
      visible.slice(first + 1).find(remaining) ?? visible.slice(0, Math.max(0, first)).reverse().find(remaining);
    setRemoving(null);
    if (!onRemove([...ids])) return;
    setSelected((previous) => new Set([...previous].filter((id) => !ids.includes(id))));
    setConfirmPrepare(false);
    // The removed card took focus with it; keep keyboard users in the list without opening a review.
    requestAnimationFrame(() => {
      const target = neighbour
        ? document.querySelector<HTMLElement>(
            `.media-item[data-media-id="${CSS.escape(neighbour.id)}"] .media-checkbox`,
          )
        : document.querySelector<HTMLElement>('[aria-label="Search media"]');
      target?.focus();
    });
  };
  const requestRemove = (ids: readonly string[]): void => {
    if (!project || busy || !ids.length) return;
    if (mediaRemovalUsage(project, { videoIds: ids, audioIds: [] }).clips > 0) setRemoving(ids);
    else remove(ids);
  };
  const removingUsage = removing && project ? mediaRemovalUsage(project, { videoIds: removing, audioIds: [] }) : null;

  return (
    <aside className="media-panel panel declutter-media" aria-label="Media library">
      <div className="panel-heading">
        <h2>
          Media <span className="count">{assets.length}</span>
        </h2>
        <div className="library-heading-actions">
          <button
            className="secondary-button small"
            aria-label="Import media"
            title="Import video and music recordings; originals stay in place"
            disabled={busy}
            onClick={onImport}
          >
            <Icon name="plus" size={15} />
            Import
          </button>
          <Popover label="Media options" className="media-options">
            <div className="library-tools">
              <label>
                <span>Filter</span>
                <select aria-label="Filter media" value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="all">All recordings</option>
                  <option value="ready">Ready</option>
                  <option value="unprepared">Not prepared</option>
                  <option value="used">In timeline</option>
                </select>
              </label>
              <label>
                <span>Sort</span>
                <select aria-label="Sort media" value={sort} onChange={(event) => setSort(event.target.value)}>
                  <option value="name">Name</option>
                  <option value="duration">Duration</option>
                  <option value="recent">Newest</option>
                </select>
              </label>
              <fieldset className="library-view-field">
                <legend>View</legend>
                <div className="library-view-controls">
                  <button
                    className={`secondary-button small ${view === 'list' ? 'active' : ''}`}
                    aria-label="List view"
                    title="Compact recording list"
                    aria-pressed={view === 'list'}
                    onClick={() => setLibraryView('list')}
                  >
                    <Icon name="list" size={15} />
                    List
                  </button>
                  <button
                    className={`secondary-button small ${view === 'grid' ? 'active' : ''}`}
                    aria-label="Grid view"
                    title="Thumbnail grid"
                    aria-pressed={view === 'grid'}
                    onClick={() => setLibraryView('grid')}
                  >
                    <Icon name="grid" size={15} />
                    Grid
                  </button>
                </div>
              </fieldset>
            </div>
          </Popover>
        </div>
      </div>
      <div className="library-search">
        <Icon name="search" size={15} />
        <input
          aria-label="Search media"
          placeholder="Search recordings"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search && (
          <button
            className="icon-button library-clear-search"
            aria-label="Clear media search"
            title="Clear search"
            onClick={() => setSearch('')}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <div className="library-summary" data-selected={selectedAssets.length}>
        <label>
          <input
            ref={selectAll}
            type="checkbox"
            aria-label="Select visible recordings"
            disabled={!visible.length}
            checked={allVisibleSelected}
            onChange={() => {
              setConfirmPrepare(false);
              setSelected((previous) => {
                const next = new Set(previous);
                visible.forEach((asset) => {
                  if (allVisibleSelected) next.delete(asset.id);
                  else next.add(asset.id);
                });
                return next;
              });
            }}
          />
          <span>{selectedAssets.length ? `${selectedAssets.length} selected` : 'Select all'}</span>
        </label>
        {visible.length !== assets.length && (
          <span className="library-visible-count" title="Matching recordings">
            {visible.length} / {assets.length}
          </span>
        )}
        {filter !== 'all' && (
          <button
            className="library-filter-chip"
            aria-label="Clear media filter"
            title="Show all recordings"
            onClick={() => setFilter('all')}
          >
            {FILTER_LABEL[filter]}
            <Icon name="x" size={12} />
          </button>
        )}
        {selectedAssets.length > 1 && (
          <span className="library-selection-actions">
            {prepareIds.length > 0 && (
              <button
                className="secondary-button small"
                aria-label="Prepare selected"
                title="Prepare editing proxies for the selected recordings"
                disabled={busy || confirmPrepare}
                onClick={prepareSelected}
              >
                <Icon name="wand" size={13} />
                Prepare
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Remove selected from project"
              title="Remove the selected recordings from this project; original recordings are kept"
              disabled={!project || busy}
              onClick={() => requestRemove(selectedAssets.map((asset) => asset.id))}
            >
              <Icon name="trash" size={14} />
            </button>
            <button className="icon-button" aria-label="Clear selected" title="Clear selection" onClick={clearSelected}>
              <Icon name="x" size={14} />
            </button>
          </span>
        )}
      </div>
      {confirmPrepare && prepareIds.length > 1 && (
        <fieldset className="prepare-confirm">
          <legend>Prepare {prepareIds.length} editing proxies?</legend>
          <div>
            <button
              className="primary-button small"
              disabled={busy}
              onClick={() => {
                setConfirmPrepare(false);
                void onPrepare(prepareIds);
              }}
            >
              Prepare {prepareIds.length}
            </button>
            <button className="secondary-button small" onClick={() => setConfirmPrepare(false)}>
              Cancel
            </button>
          </div>
        </fieldset>
      )}
      {dropError && (
        <div className="media-file-error" role="alert">
          <span>{dropError}</span>
          <button className="icon-button" aria-label="Dismiss file import error" onClick={() => setDropError('')}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <MissingOriginals
        count={[...assets, ...music].filter((asset) => missing.has(asset.id)).length}
        busy={busy}
        onRelink={() => onRelink(null)}
      />
      <div className={`media-items ${view}`} onScroll={clearHover}>
        {visible.map((asset) => {
          const count = asset.metadata.frameCount;
          const range = resolveMediaSelection(asset.id, count, ranges);
          const trimmed = range.sourceIn !== 0 || range.sourceOut !== count;
          const rangeId = `${rangeIdPrefix}-${asset.id}`;
          const excerptCount = usage.get(asset.id) ?? 0;
          const excerptLabel = `${excerptCount} ${excerptCount === 1 ? 'clip' : 'clips'}`;
          const usageDescription = excerptCount > 0 ? `, ${excerptLabel} in timeline` : '';
          const lost = missing.has(asset.id);
          const status = cardStatus(asset, lost, excerptCount > 0 ? `${excerptLabel} in timeline` : 'Ready');
          const usable = mediaReady(asset) && !lost;
          return (
            <article
              key={asset.id}
              className={`media-item ${selected.has(asset.id) ? 'selected' : ''} ${reviewedAsset?.id === asset.id ? 'reviewing' : ''}`}
              data-media-id={asset.id}
              draggable={usable}
              onDragStart={(event) => {
                clearHover();
                const ids = selected.has(asset.id)
                  ? selectedAssets.filter(mediaReady).map((item) => item.id)
                  : [asset.id];
                event.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify(ids));
                event.dataTransfer.effectAllowed = 'copy';
                onDragMedia(ids);
              }}
              onDragEnd={() => onDragMedia(null)}
            >
              <input
                className="media-checkbox"
                type="checkbox"
                aria-label={`Select ${asset.name}`}
                checked={selected.has(asset.id)}
                onChange={() => toggle(asset.id)}
              />
              <button
                className="media-item-main"
                aria-label={`Review ${asset.name}`}
                aria-describedby={trimmed ? rangeId : undefined}
                onClick={(event) => {
                  choose(event, asset.id);
                  activateReview(asset);
                }}
                onFocus={() => activateReview(asset)}
                onPointerEnter={(event) => queueHover(event, asset)}
                onPointerMove={(event) => queueHover(event, asset)}
                onPointerLeave={() => leaveHover(asset.id)}
                onDoubleClick={() => {
                  if (project && !busy && usable) onInsert([asset.id]);
                }}
                title={
                  excerptCount > 0
                    ? `Choose another range from the original recording · ${asset.sourcePath}`
                    : asset.sourcePath
                }
              >
                <span className="media-thumb" data-source-in={range.sourceIn} data-source-out={range.sourceOut}>
                  {asset.prepared && !lost ? (
                    <img
                      loading="lazy"
                      draggable={false}
                      src={`/api/media/${asset.id}/thumbnail/${asset.prepared.thumbnailFrames[0]}`}
                      alt={`Thumbnail of ${asset.name}`}
                    />
                  ) : (
                    <Icon name="video" size={23} />
                  )}
                  {range.sourceIn > 0 && (
                    <span
                      className="media-thumb-omitted before"
                      style={{ width: `${(range.sourceIn / count) * 100}%` }}
                      aria-hidden="true"
                    />
                  )}
                  {range.sourceOut < count && (
                    <span
                      className="media-thumb-omitted after"
                      style={{ width: `${((count - range.sourceOut) / count) * 100}%` }}
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="media-item-info">
                  <strong>{shortName(asset.name)}</strong>
                  <span className="media-recording-meta">
                    <span
                      className="media-recording-duration"
                      title={`${durationLabel(asset.metadata.durationSeconds)} · ${asset.metadata.frameCount} original source frames`}
                    >
                      {durationLabel(asset.metadata.durationSeconds)}{' '}
                      <span className="media-resolution">
                        · {asset.metadata.width} × {asset.metadata.height}
                      </span>
                    </span>
                    {excerptCount > 0 && (
                      <span className="media-usage-badge" title={`${excerptLabel} from this recording in this project`}>
                        {excerptLabel}
                      </span>
                    )}
                    {status.state !== 'ready' && <span className="media-status-text">{status.label}</span>}
                  </span>
                  {trimmed && (
                    <span className="declutter-sr-only" id={rangeId}>
                      Selected range: frames {range.sourceIn} to {range.sourceOut} of {count}, OUT exclusive
                    </span>
                  )}
                </span>
                {hover?.projectId === projectId && hover.mediaId === asset.id && (
                  <span className="media-hover-marker" style={{ left: `${hover.ratio * 100}%` }} aria-hidden="true" />
                )}
              </button>
              <span
                className={`media-state ${status.state}`}
                data-used={usage.has(asset.id)}
                title={status.title}
                aria-label={`${asset.name}: ${status.spoken}${usageDescription}`}
              >
                <span className="media-state-icon" aria-hidden="true">
                  <Icon name={status.icon} size={13} />
                </span>
                <small>{status.label}</small>
              </span>
              <MediaAction
                asset={asset}
                hasProject={project !== null}
                trimmed={trimmed}
                targetLayer={targetLayer}
                trackLimit={(project?.layers.length ?? 0) >= MAX_VIDEO_LAYERS}
                busy={busy}
                missing={lost}
                onInsert={onInsert}
                onInsertOnNewTrack={onInsertOnNewTrack}
                onPrepare={onPrepare}
                onRelink={onRelink}
              />
              <button
                className="icon-button media-remove"
                aria-label={`Remove ${asset.name} from project`}
                title="Remove from this project; the original recording is kept"
                disabled={!project || busy}
                onClick={() => requestRemove([asset.id])}
              >
                <Icon name="trash" size={14} />
              </button>
            </article>
          );
        })}
        {!visible.length && !visibleMusic.length && (
          <div className="empty-library">
            <Icon name="folder" size={30} />
            <strong>{assets.length || music.length ? 'No matching media' : 'Your media library is empty'}</strong>
            <p>
              {assets.length || music.length
                ? 'Try another search or filter.'
                : 'Import video and music recordings. Originals stay in place; PasCap prepares light editing copies.'}
            </p>
            {assets.length ? (
              <button
                className="secondary-button small"
                onClick={() => {
                  setSearch('');
                  setFilter('all');
                }}
              >
                Clear media filters
              </button>
            ) : (
              <button className="primary-button small" disabled={busy} onClick={onImport}>
                <Icon name="plus" size={14} />
                Import media
              </button>
            )}
          </div>
        )}
        <MediaMusicList
          music={visibleMusic}
          project={project}
          busy={busy}
          missing={missing}
          onPrepare={onPrepareMusic}
          onRelink={onRelink}
          onRemove={onRemoveMusic}
        />
      </div>
      {removing && removingUsage && (
        <RemoveMediaDialog
          names={removing.map((id) => assets.find((asset) => asset.id === id)?.name ?? id)}
          clips={removingUsage.clips}
          music={removingUsage.music}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </aside>
  );
}
