import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  resolveMediaSelection,
  sourceFrameAtRatio,
  sourcePointerRatio,
  type MediaSelections,
} from '../shared/media-selection.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import { mediaRemovalUsage } from '../shared/projects.js';
import { durationLabel, MEDIA_DRAG_TYPE, mediaReady, shortName } from './display.js';
import { Icon } from './icons.js';
import './media-review.css';
import './media-import.css';
import './rush-source.css';
import { Modal } from './Modal.js';
import { Popover } from './Popover.js';
import { readPreference, writePreference } from './preferences.js';
import { RemoveMediaDialog } from './RemoveMediaDialog.js';

interface Props {
  assets: MediaAsset[];
  project: ProjectDocument | null;
  ranges: MediaSelections;
  busy: boolean;
  onInsert: (mediaIds: string[]) => void;
  onDragMedia: (mediaIds: string[] | null) => void;
  onPrepare: (mediaIds: string[]) => Promise<void>;
  onRemove: (mediaIds: string[]) => boolean;
  onImport: (directory: string) => Promise<ImportResult>;
  onRegisterPaths: (paths: readonly string[]) => Promise<ImportResult>;
  review: ReviewTarget | null;
  reviewPinned: boolean;
  onReview: (review: ReviewTarget, pin: boolean) => void;
  importRequest: number;
  onImportVisibility: (open: boolean) => void;
  targetLayer: string;
  error: string;
}

export interface ReviewTarget {
  mediaId: string;
  frame: number;
}
export interface ImportResult {
  ok: boolean;
  added: number;
  existing: number;
  queued: number;
  ignored: number;
  rejected: string[];
  queueErrors: string[];
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
  unprepared: 'Needs proxy',
  used: 'In timeline',
};
const FootageBrowser = lazy(() => import('./FootageBrowser.js').then((module) => ({ default: module.FootageBrowser })));

function externalFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files') && !Array.from(transfer.types).includes(MEDIA_DRAG_TYPE);
}

function importSucceeded(result: ImportResult | null): boolean {
  if (!result) return false;
  // A queue problem must not turn successfully registered recordings into a failed import.
  return result.ok || result.added > 0 || result.existing > 0 || result.queued > 0;
}

function ImportReport({ result }: Readonly<{ result: ImportResult }>) {
  return (
    <section className="import-report declutter-import-report" aria-label="Import results" aria-live="polite">
      <strong>
        {result.added} recordings registered · {result.existing} already registered
      </strong>
      <p>{result.queued} editing proxies queued automatically</p>
      <p className="control-hint">
        {result.ignored} unrelated files ignored · {result.rejected.length} files rejected
      </p>
      {result.queueErrors.length > 0 && (
        <>
          <p className="control-hint import-queue-warning">
            Recordings were kept. {result.queueErrors.length} proxies could not be queued; use Prepare to retry.
          </p>
          <details>
            <summary>Proxy queue issues</summary>
            <ul>
              {result.queueErrors.map((issue, index) => (
                <li key={`${index}:${issue}`}>{issue}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      {result.rejected.length > 0 && (
        <details>
          <summary>Rejected files</summary>
          <ul>
            {result.rejected.map((issue, index) => (
              <li key={`${index}:${issue}`}>{issue}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function MediaAction({
  asset,
  hasProject,
  trimmed,
  targetLayer,
  busy,
  onInsert,
  onPrepare,
}: Readonly<{
  asset: MediaAsset;
  hasProject: boolean;
  trimmed: boolean;
  targetLayer: string;
  busy: boolean;
  onInsert: Props['onInsert'];
  onPrepare: Props['onPrepare'];
}>) {
  if (mediaReady(asset))
    return (
      <button
        className="icon-button add-media"
        aria-label={`Add ${asset.name} to timeline`}
        title={`Add ${trimmed ? 'selected range' : 'full recording'} to ${targetLayer}`}
        disabled={!hasProject || busy}
        onClick={() => onInsert([asset.id])}
      >
        <Icon name="plus" size={16} />
      </button>
    );
  if (asset.status === 'queued' || asset.status === 'preparing')
    return <span className="media-action-space" aria-hidden="true" />;
  return (
    <button
      className="icon-button prepare-media"
      aria-label={`Prepare ${asset.name}`}
      title={asset.error ?? 'Prepare editing proxy'}
      disabled={busy}
      onClick={() => {
        void onPrepare([asset.id]);
      }}
    >
      <Icon name={asset.status === 'error' ? 'reset' : 'download'} size={15} />
    </button>
  );
}

export function MediaLibrary({
  assets,
  project,
  ranges,
  busy,
  onInsert,
  onDragMedia,
  onPrepare,
  onRemove,
  onImport,
  onRegisterPaths,
  review,
  reviewPinned,
  onReview,
  importRequest,
  onImportVisibility,
  targetLayer,
  error,
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
  const [showImport, setShowImport] = useState(false);
  const [folder, setFolder] = useState(() => readPreference('pascap-last-import') ?? '');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dropError, setDropError] = useState('');
  const importAccepted = importSucceeded(importResult);
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
    if (importRequest > 0) {
      setImportResult(null);
      setShowImport(true);
    }
  }, [importRequest]);
  useEffect(() => {
    onImportVisibility(showImport);
  }, [showImport, onImportVisibility]);
  useEffect(() => {
    const preventNavigation = (event: globalThis.DragEvent): void => {
      if (!event.dataTransfer || !externalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
      // A refused desktop drop may never dispatch "drop"; explain it during dragover too.
      setDropError(
        'Filesystem drops are disabled. Use Import → Browse footage to reference originals without copying.',
      );
    };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => {
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
    };
  }, []);

  const applyHover = (request: HoverRequest): void => {
    if (request.projectId !== latestLibrary.current.projectId) return;
    const asset = latestLibrary.current.assets.find((item) => item.id === request.mediaId);
    if (!asset || !mediaReady(asset) || !request.element.isConnected) return;
    const bounds = request.element.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = sourcePointerRatio(request.clientX, bounds.left, bounds.width);
    onReview({ mediaId: asset.id, frame: sourceFrameAtRatio(ratio, asset.metadata.frameCount) }, false);
    setHover({ projectId: request.projectId, mediaId: asset.id, ratio });
  };
  const queueHover = (event: PointerEvent<HTMLButtonElement>, asset: MediaAsset): void => {
    if (reviewPinned || !mediaReady(asset) || event.pointerType === 'touch' || event.buttons !== 0) return;
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
    // Keep the final requested frame paused when moving from a row to its controls.
    if (hoverRequest.current?.mediaId === mediaId) applyHover(hoverRequest.current);
    clearHover();
  };
  const activateReview = (asset: MediaAsset): void => {
    if (!mediaReady(asset)) return;
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
    else {
      setSelected(new Set([id]));
      setLastSelected(id);
    }
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
  const openImport = (): void => {
    setImportResult(null);
    setShowImport(true);
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
            aria-label="Import folder"
            title="Browse original recordings or register a folder in place; no footage is copied"
            disabled={busy}
            onClick={openImport}
          >
            <Icon name="folder" size={15} />
            Import
          </button>
          <Popover label="Media options" className="media-options">
            <div className="library-tools">
              <label>
                Filter
                <select aria-label="Filter media" value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="all">All recordings</option>
                  <option value="ready">Ready</option>
                  <option value="unprepared">Not prepared</option>
                  <option value="used">In timeline</option>
                </select>
              </label>
              <label>
                Sort
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
        {selectedAssets.length > 0 && (
          <span className="library-selection-actions">
            {prepareIds.length > 0 && (
              <button
                className="secondary-button small"
                aria-label="Prepare selected"
                title="Prepare editing proxies for the selected recordings"
                disabled={busy || confirmPrepare}
                onClick={prepareSelected}
              >
                <Icon name="download" size={13} />
                Prepare
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Remove selected from project"
              title="Remove the selected recordings from this project; original files are kept"
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
      <div className={`media-items ${view}`} onScroll={clearHover}>
        {visible.map((asset) => {
          const count = asset.metadata.frameCount;
          const range = resolveMediaSelection(asset.id, count, ranges);
          const trimmed = range.sourceIn !== 0 || range.sourceOut !== count;
          const rangeId = `${rangeIdPrefix}-${asset.id}`;
          const excerptCount = usage.get(asset.id) ?? 0;
          const excerptLabel = `${excerptCount} ${excerptCount === 1 ? 'excerpt' : 'excerpts'}`;
          const usageDescription = excerptCount > 0 ? `, ${excerptLabel} in timeline` : '';
          let statusLabel = STATUS_LABEL[asset.status];
          if (asset.status === 'ready') statusLabel = excerptCount > 0 ? `${excerptLabel} in timeline` : 'Ready';
          if (asset.status === 'registered') statusLabel = 'Proxy needed';
          return (
            <article
              key={asset.id}
              className={`media-item ${selected.has(asset.id) ? 'selected' : ''} ${reviewedAsset?.id === asset.id ? 'reviewing' : ''}`}
              data-media-id={asset.id}
              draggable={mediaReady(asset)}
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
                  if (project && !busy && mediaReady(asset)) onInsert([asset.id]);
                }}
                title={
                  excerptCount > 0
                    ? `Choose another excerpt from the original recording · ${asset.sourcePath}`
                    : asset.sourcePath
                }
              >
                <span className="media-thumb" data-source-in={range.sourceIn} data-source-out={range.sourceOut}>
                  {asset.prepared ? (
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
                  </span>
                  {trimmed && (
                    <span className="declutter-sr-only" id={rangeId}>
                      Selected source range: frames {range.sourceIn} to {range.sourceOut} of {count}, OUT exclusive
                    </span>
                  )}
                </span>
                {hover?.projectId === projectId && hover.mediaId === asset.id && (
                  <span className="media-hover-marker" style={{ left: `${hover.ratio * 100}%` }} aria-hidden="true" />
                )}
              </button>
              <span
                className={`media-state ${asset.status}`}
                data-used={usage.has(asset.id)}
                title={asset.error ?? statusLabel}
                aria-label={`${asset.name}: ${STATUS_LABEL[asset.status]}${usageDescription}`}
              >
                <span className="media-state-icon" aria-hidden="true">
                  <Icon name={STATUS_ICON[asset.status]} size={13} />
                </span>
                <small>{statusLabel}</small>
              </span>
              <MediaAction
                asset={asset}
                hasProject={project !== null}
                trimmed={trimmed}
                targetLayer={targetLayer}
                busy={busy}
                onInsert={onInsert}
                onPrepare={onPrepare}
              />
              <button
                className="icon-button media-remove"
                aria-label={`Remove ${asset.name} from project`}
                title="Remove from this project; the original file is kept"
                disabled={!project || busy}
                onClick={() => requestRemove([asset.id])}
              >
                <Icon name="trash" size={14} />
              </button>
            </article>
          );
        })}
        {!visible.length && (
          <div className="empty-library">
            <Icon name="folder" size={30} />
            <strong>{assets.length ? 'No matching recordings' : 'Your media library is empty'}</strong>
            <p>
              {assets.length
                ? 'Try another search or filter.'
                : 'Browse footage or import a folder. Originals stay in place; only editing proxies are generated.'}
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
              <button className="secondary-button small" disabled={busy} onClick={openImport}>
                Import folder
              </button>
            )}
          </div>
        )}
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
      {showImport && (
        <Modal
          className="import-dialog"
          labelledBy="import-title"
          busy={busy}
          error={importAccepted ? '' : error}
          onClose={() => setShowImport(false)}
          footer={
            <button className="secondary-button" disabled={busy} onClick={() => setShowImport(false)}>
              {importAccepted ? 'Done' : 'Cancel'}
            </button>
          }
        >
          <div className="activity-dialog-heading">
            <h2 id="import-title">Import recordings</h2>
            <span className="privacy-badge">No-copy import</span>
          </div>
          <p className="control-hint declutter-import-copy">
            Originals stay local and unchanged. Only selected paths are registered; proxies are queued automatically.
          </p>
          <Suspense fallback={<output>Opening footage browser…</output>}>
            <FootageBrowser
              busy={busy}
              onRegister={onRegisterPaths}
              onResult={(result) => {
                setImportResult(result);
                if (result.added + result.existing > 0) {
                  setSearch('');
                  setFilter('all');
                }
              }}
            />
          </Suspense>
          <details className="import-path-details">
            <summary>Import a whole folder by path</summary>
            <p className="control-hint">
              Register all recordings in this folder and its subfolders without copying originals. In a container, use
              its mounted folder path.
            </p>
            <form
              className="import-form"
              onSubmit={(event) => {
                event.preventDefault();
                setImportResult(null);
                void onImport(folder.trim()).then((result) => {
                  setImportResult(result);
                  if (importSucceeded(result)) writePreference('pascap-last-import', folder.trim());
                });
              }}
            >
              <label htmlFor="source-folder">Absolute folder path on this machine</label>
              <input
                id="source-folder"
                placeholder="/home/you/Videos/Flight"
                value={folder}
                disabled={busy}
                onChange={(event) => setFolder(event.target.value)}
              />
              <button className="primary-button" type="submit" disabled={busy || !folder.trim()}>
                {busy ? 'Checking recordings…' : 'Register recordings'}
              </button>
            </form>
          </details>
          {importResult && <ImportReport result={importResult} />}
        </Modal>
      )}
    </aside>
  );
}
