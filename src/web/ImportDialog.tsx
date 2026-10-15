import { useEffect, useId, useRef, useState } from 'react';
import { isAudioFilename, isVideoFilename, MAX_FOOTAGE_FILES, type FootageRoot } from '../shared/footage.js';
import { forEachSerial } from '../shared/serial.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { PreviewLoader, previewKey, type PreviewState } from './import-previews.js';
import './media-import.css';
import { Modal } from './Modal.js';
import { readPreference, writePreference } from './preferences.js';

export type ImportKind = 'all' | 'video' | 'audio';

export interface ImportResult {
  ok: boolean;
  added: number;
  existing: number;
  queued: number;
  rejected: string[];
  /** Paths of the rejected recordings, which stay selected for another attempt. */
  rejectedPaths: string[];
  queueErrors: string[];
}

export interface ImportActions {
  /** Root-scoped video files chosen in the browser. */
  registerVideos: (paths: readonly string[]) => Promise<ImportResult>;
  /** Root-scoped music file chosen in the browser. */
  registerMusic: (path: string) => Promise<boolean>;
  /** Typed path: a folder (videos, recursively), a video file or a music file, anywhere on this machine. */
  importFolder: (directory: string) => Promise<ImportResult>;
  importVideoPath: (path: string) => Promise<ImportResult>;
  importMusicPath: (path: string) => Promise<boolean>;
}

interface Props {
  initialKind: ImportKind;
  busy: boolean;
  error: string;
  actions: ImportActions;
  /** Pick one moved copy of a registered recording instead of importing. */
  relink?: { target: RelinkTarget; onRelink: (path: string) => Promise<boolean> };
  onClose: (imported: boolean) => void;
}

export interface RelinkTarget {
  kind: 'video' | 'audio';
  id: string;
  name: string;
  sourcePath: string;
}

interface Entry {
  name: string;
  path: string;
  kind: 'directory' | 'video' | 'audio';
  size: number | null;
}
type FileEntry = Entry & { kind: 'video' | 'audio' };
interface Listing {
  directory: string;
  parent: string | null;
  entries: Entry[];
  truncated: boolean;
  warnings: string[];
}
interface Report {
  videos: number;
  music: number;
  queued: number;
  problems: string[];
}

const LOCATION_PREFERENCE = 'pascap-import-location';
const KIND_LABEL = { video: 'Video', audio: 'Music', directory: 'Folder' } as const;
const naturalNames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function message(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Cannot read this folder. Check its mount and permissions, then retry.';
}

function compareEntries(left: Entry, right: Entry): number {
  if ((left.kind === 'directory') !== (right.kind === 'directory')) return left.kind === 'directory' ? -1 : 1;
  return naturalNames.compare(left.name, right.name);
}

/** One folder view holding both videos and music, from the two metadata-only listings. */
async function readFolder(rootId: string, directory: string | undefined, signal: AbortSignal): Promise<Listing> {
  const [videos, music] = await Promise.all([
    api.browseFootage(rootId, directory, { signal }),
    api.browseAudio(rootId, directory, { signal }),
  ]);
  return {
    directory: videos.directory,
    parent: videos.parent,
    entries: [...videos.entries, ...music.entries.filter((entry) => entry.kind === 'audio')].sort(compareEntries),
    truncated: videos.truncated || music.truncated,
    warnings: [...new Set([...videos.warnings, ...music.warnings])],
  };
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  return `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function mediaSummary(videos: number, music: number): string {
  return [
    videos && count(videos, 'video recording', 'video recordings'),
    music && count(music, 'music recording', 'music recordings'),
  ]
    .filter(Boolean)
    .join(' and ');
}

function dialogText(relink: RelinkTarget | undefined, chosen: readonly FileEntry[], summary: string) {
  if (!relink)
    return {
      title: 'Import media',
      selection: summary ? `${summary} selected` : 'Select recordings, or double-click one to import it',
      action: chosen.length ? `Import ${chosen.length}` : 'Import',
      actionBusy: 'Importing…',
      actionName: 'Import selected recordings',
      pathLabel: 'File or folder path',
      placeholder: '/media/footage/Flight',
      pathAction: 'Import path',
      pathHint:
        'A video or music recording, or a folder: a folder imports every video recording in it and its subfolders.',
    };
  const kind = relink.kind === 'video' ? 'video' : 'music';
  return {
    title: `Relink ${relink.name}`,
    selection: chosen[0]
      ? `New location: ${chosen[0].path}`
      : `Choose the moved copy of ${relink.name}, or double-click it`,
    action: 'Relink',
    actionBusy: 'Relinking…',
    actionName: 'Relink to the selected recording',
    pathLabel: 'File path',
    placeholder: `/media/footage/${relink.name}`,
    pathAction: 'Relink path',
    pathHint: `The moved ${kind} recording, anywhere on this machine.`,
  };
}

/** Crumbs from the location root down to the open folder. */
function crumbs(root: FootageRoot, directory: string): { name: string; path: string | undefined }[] {
  const base = root.path.endsWith('/') ? root.path : `${root.path}/`;
  const parts = directory.startsWith(base) ? directory.slice(base.length).split('/').filter(Boolean) : [];
  return [
    { name: root.name, path: undefined },
    ...parts.map((name, index) => ({ name, path: base + parts.slice(0, index + 1).join('/') })),
  ];
}

function savedLocation(): { root: string; directory: string | undefined } | null {
  try {
    const stored: unknown = JSON.parse(readPreference(LOCATION_PREFERENCE) ?? 'null');
    if (typeof stored !== 'object' || stored === null || !('root' in stored) || typeof stored.root !== 'string')
      return null;
    const directory = 'directory' in stored && typeof stored.directory === 'string' ? stored.directory : undefined;
    return { root: stored.root, directory };
  } catch {
    return null;
  }
}

/** A video row's picture, read on the service once the row scrolls into view. */
function RecordingPreview({ loader, entry }: Readonly<{ loader: PreviewLoader; entry: FileEntry }>) {
  const element = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<PreviewState>({ status: 'waiting' });
  const key = previewKey(entry);
  useEffect(() => loader.watch(element.current!, key, entry.path, setState), [loader, key, entry.path]);
  return (
    <span
      ref={element}
      className="import-preview"
      data-state={state.status}
      {...(state.status === 'failed'
        ? { role: 'img', 'aria-label': `No preview for ${entry.name}`, title: state.reason }
        : {})}
    >
      {state.status === 'ready' ? (
        <img src={state.url} alt="" draggable={false} />
      ) : (
        <Icon name={state.status === 'failed' ? 'eye-off' : 'video'} size={16} />
      )}
    </span>
  );
}

function ImportReport({ report }: Readonly<{ report: Report }>) {
  const imported = mediaSummary(report.videos, report.music);
  return (
    <section className="import-report" aria-label="Import results" aria-live="polite">
      <strong>{imported ? `Imported ${imported}` : 'Nothing was imported'}</strong>
      {report.queued > 0 && (
        <p className="control-hint">
          Preparing {count(report.queued, 'editing proxy', 'editing proxies')}: follow progress in Activity.
        </p>
      )}
      {report.problems.length > 0 && (
        <ul>
          {report.problems.map((problem, index) => (
            <li key={`${index}:${problem}`}>{problem}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ImportDialog({ initialKind, busy, error, actions, relink, onClose }: Readonly<Props>) {
  const titleId = useId();
  const [roots, setRoots] = useState<FootageRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const [directory, setDirectory] = useState<string | undefined>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [kind, setKind] = useState<ImportKind>(initialKind);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Map<string, FileEntry>>(new Map());
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [loadingFolder, setLoadingFolder] = useState(false);
  const [readError, setReadError] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [previews] = useState(() => new PreviewLoader(api.footagePreview));
  const pending = useRef(false);
  const mounted = useRef(false);
  const anchor = useRef<string | null>(null);
  const shiftHeld = useRef(false);
  const restored = useRef(false);
  const root = roots.find((item) => item.id === rootId);
  const blocked = busy || importing;
  const loading = loadingRoots || loadingFolder;

  useEffect(() => {
    mounted.current = true;
    // A click on a row's label reaches its checkbox as a synthetic click without Shift.
    const track = (event: KeyboardEvent): void => {
      shiftHeld.current = event.shiftKey;
    };
    const release = (): void => {
      shiftHeld.current = false;
    };
    globalThis.addEventListener('keydown', track);
    globalThis.addEventListener('keyup', track);
    globalThis.addEventListener('blur', release);
    return () => {
      mounted.current = false;
      globalThis.removeEventListener('keydown', track);
      globalThis.removeEventListener('keyup', track);
      globalThis.removeEventListener('blur', release);
    };
  }, []);
  useEffect(() => () => previews.dispose(), [previews]);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingRoots(true);
    setReadError('');
    void api
      .footageRoots({ signal: controller.signal })
      .then(({ roots: next }) => {
        if (controller.signal.aborted) return;
        setRoots(next);
        setRootId((previous) => {
          if (next.some((item) => item.id === previous && item.available)) return previous;
          const saved = savedLocation();
          const match = next.find((item) => item.available && item.path === saved?.root);
          if (match) {
            restored.current = saved?.directory !== undefined;
            setDirectory(saved?.directory);
            return match.id;
          }
          return next.find((item) => item.available)?.id ?? '';
        });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setReadError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRoots(false);
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    setListing(null);
    if (!root?.available) return;
    const controller = new AbortController();
    setLoadingFolder(true);
    setReadError('');
    void readFolder(root.id, directory, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        restored.current = false;
        setListing(next);
        writePreference(LOCATION_PREFERENCE, JSON.stringify({ root: root.path, directory }));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        // A remembered folder may have moved since; fall back to its location root.
        if (restored.current) {
          restored.current = false;
          setDirectory(undefined);
        } else setReadError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingFolder(false);
      });
    return () => controller.abort();
  }, [root, directory, refresh]);

  const navigate = (next: string | undefined): void => {
    setDirectory(next);
    anchor.current = null;
    setQuery('');
    setReadError('');
  };
  const chooseRoot = (id: string): void => {
    if (id === rootId) {
      navigate(undefined);
      return;
    }
    setRootId(id);
    setSelected(new Map());
    navigate(undefined);
  };
  const visible = (listing?.entries ?? []).filter(
    (entry) =>
      (kind === 'all' || entry.kind === 'directory' || entry.kind === kind) &&
      entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const files = visible.filter((entry): entry is FileEntry => entry.kind !== 'directory');
  const allSelected = files.length > 0 && files.every((file) => selected.has(file.path));
  const chosen = [...selected.values()];
  const select = (entries: readonly FileEntry[], add: boolean): void => {
    const next = new Map(selected);
    entries.forEach((entry) => {
      if (add) next.set(entry.path, entry);
      else next.delete(entry.path);
    });
    if ([...next.values()].filter((entry) => entry.kind === 'video').length > MAX_FOOTAGE_FILES) {
      setSelectionError(`Select at most ${MAX_FOOTAGE_FILES} videos per import.`);
      return;
    }
    setSelectionError('');
    setSelected(next);
  };
  const toggleFile = (file: FileEntry, shift: boolean): void => {
    const from = shift && anchor.current ? files.findIndex((item) => item.path === anchor.current) : -1;
    const to = files.findIndex((item) => item.path === file.path);
    anchor.current = file.path;
    const add = !selected.has(file.path);
    select(from < 0 ? [file] : files.slice(Math.min(from, to), Math.max(from, to) + 1), add);
  };
  const pick = (file: FileEntry): void => {
    setSelected(selected.has(file.path) ? new Map() : new Map([[file.path, file]]));
  };

  const whileBusy = async (task: () => Promise<void>): Promise<void> => {
    if (blocked || pending.current) return;
    pending.current = true;
    setImporting(true);
    try {
      await task();
    } finally {
      pending.current = false;
      if (mounted.current) setImporting(false);
    }
  };
  const run = (task: (report: Report) => Promise<string[]>): Promise<void> =>
    whileBusy(async () => {
      setReport(null);
      const result: Report = { videos: 0, music: 0, queued: 0, problems: [] };
      const done = await task(result);
      if (!mounted.current) return;
      const next = new Map(selected);
      done.forEach((path) => next.delete(path));
      setSelected(next);
      if (result.videos + result.music > 0 && !result.problems.length) onClose(true);
      else setReport(result);
    });
  // The dialog closes once the relink is queued; its full check runs in Activity.
  const relinkTo = (path: string): Promise<void> =>
    whileBusy(async () => {
      await relink?.onRelink(path);
    });
  const addVideos = (report: Report, outcome: ImportResult): boolean => {
    report.videos += outcome.added + outcome.existing;
    report.queued += outcome.queued;
    report.problems.push(...outcome.rejected, ...outcome.queueErrors.map((issue) => `Not queued: ${issue}`));
    return outcome.ok || outcome.added + outcome.existing > 0;
  };
  const importFiles = (items: readonly FileEntry[]): Promise<void> =>
    run(async (report) => {
      const done: string[] = [];
      const videos = items.filter((item) => item.kind === 'video').map((item) => item.path);
      if (videos.length) {
        const outcome = await actions.registerVideos(videos);
        if (addVideos(report, outcome)) done.push(...videos.filter((path) => !outcome.rejectedPaths.includes(path)));
        else
          report.problems.push(`${count(videos.length, 'video recording was', 'video recordings were')} not imported.`);
      }
      // Each music file is probed and registered on its own, one at a time.
      await forEachSerial(
        items.filter((item) => item.kind === 'audio'),
        async (music) => {
          if (!mounted.current) return;
          if (await actions.registerMusic(music.path)) {
            report.music++;
            done.push(music.path);
          } else report.problems.push(`${music.name} was not imported.`);
        },
      );
      return done;
    });
  const importPath = (): Promise<void> =>
    run(async (report) => {
      const path = manualPath.trim();
      if (isAudioFilename(path)) {
        if (await actions.importMusicPath(path)) report.music++;
        else report.problems.push(`${path} was not imported.`);
      } else {
        const outcome = await (isVideoFilename(path) ? actions.importVideoPath(path) : actions.importFolder(path));
        if (!addVideos(report, outcome)) report.problems.push(`${path} was not imported.`);
        else if (outcome.added + outcome.existing === 0) report.problems.push(`No video recordings found in ${path}.`);
      }
      return [];
    });
  const submitFiles = (items: readonly FileEntry[]): Promise<void> =>
    relink ? relinkTo(items[0]!.path) : importFiles(items);
  const submitPath = (): Promise<void> => (relink ? relinkTo(manualPath.trim()) : importPath());

  const chosenVideos = chosen.filter((entry) => entry.kind === 'video').length;
  const text = dialogText(relink?.target, chosen, mediaSummary(chosenVideos, chosen.length - chosenVideos));
  const availableRoots = roots.filter((item) => item.available);
  const chooseFile: (file: FileEntry, shift: boolean) => void = relink ? pick : toggleFile;
  return (
    <Modal
      className="import-media-dialog"
      labelledBy={titleId}
      busy={blocked}
      error={error}
      onClose={() => onClose(false)}
      footer={
        <>
          <span className="activity-hint import-selection" aria-live="polite" title={chosen[0]?.path}>
            {text.selection}
          </span>
          <button type="button" className="secondary-button" disabled={blocked} onClick={() => onClose(false)}>
            {report ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="primary-button"
            aria-label={text.actionName}
            disabled={blocked || !chosen.length}
            onClick={() => {
              void submitFiles(chosen);
            }}
          >
            {importing ? text.actionBusy : text.action}
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={titleId}>{text.title}</h2>
        <span className="privacy-badge" title="PasCap references originals where they are and never copies them">
          Originals stay in place
        </span>
      </div>
      {relink && (
        <p className="import-relink-note">
          Was at <span title={relink.target.sourcePath}>{relink.target.sourcePath}</span>. Choose its moved copy: PasCap
          checks every byte before using it, and keeps the clips, proxy and settings.
        </p>
      )}
      <div className="import-browser" aria-busy={loading || importing}>
        <nav className="import-places" aria-label="Media locations">
          <h3>Locations</h3>
          <ul>
            {roots.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="import-place"
                  aria-current={item.id === rootId ? 'location' : undefined}
                  title={item.available ? item.path : `${item.path}: ${item.error ?? 'unavailable'}`}
                  disabled={blocked || !item.available}
                  onClick={() => chooseRoot(item.id)}
                >
                  <Icon name={item.available ? 'folder' : 'warning'} size={15} />
                  <span>{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {loadingRoots && <output className="control-hint">Reading locations…</output>}
          <details className="import-path" open={!loadingRoots && !availableRoots.length ? true : undefined}>
            <summary>Other location</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitPath();
              }}
            >
              <input
                aria-label={text.pathLabel}
                placeholder={text.placeholder}
                value={manualPath}
                disabled={blocked}
                onChange={(event) => setManualPath(event.target.value)}
              />
              <button type="submit" className="secondary-button small" disabled={blocked || !manualPath.trim()}>
                {text.pathAction}
              </button>
              <p className="control-hint">{text.pathHint}</p>
            </form>
          </details>
        </nav>
        <section className="import-files" aria-label="Folder contents">
          <div className="import-toolbar">
            <button
              type="button"
              className="icon-button"
              aria-label="Up one folder"
              title="Up one folder"
              disabled={blocked || loading || !listing?.parent}
              onClick={() => navigate(listing?.parent ?? undefined)}
            >
              <Icon name="chevron-up" size={16} />
            </button>
            <nav className="import-crumbs" aria-label="Folder path" title={listing?.directory ?? root?.path}>
              {root &&
                crumbs(root, listing?.directory ?? directory ?? root.path).map((crumb, index, all) =>
                  index === all.length - 1 ? (
                    <span key={crumb.path ?? ''} aria-current="location">
                      {crumb.name}
                    </span>
                  ) : (
                    <button
                      key={crumb.path ?? ''}
                      type="button"
                      className="text-button"
                      disabled={blocked || loading}
                      onClick={() => navigate(crumb.path)}
                    >
                      {crumb.name}
                    </button>
                  ),
                )}
            </nav>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh folder"
              title="Refresh"
              disabled={blocked || loading}
              onClick={() => {
                previews.forgetFailures();
                setRefresh((value) => value + 1);
              }}
            >
              <Icon name="reset" size={15} />
            </button>
          </div>
          <div className="import-filters">
            {!relink && (
              <fieldset className="import-kinds">
                <legend className="declutter-sr-only">Show</legend>
                {(
                  [
                    ['all', 'All'],
                    ['video', 'Video'],
                    ['audio', 'Music'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={kind === value}
                    onClick={() => {
                      setKind(value);
                      anchor.current = null;
                    }}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
            )}
            <label className="import-search">
              <Icon name="search" size={14} />
              <input
                type="search"
                aria-label="Filter this folder"
                placeholder="Filter this folder"
                value={query}
                disabled={!listing}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {(readError || selectionError) && (
            <p className="footage-error" role="alert">
              {readError || selectionError}
            </p>
          )}
          <div className="import-table">
            <label className="import-row import-head">
              <input
                type="checkbox"
                aria-label="Select all recordings in this folder"
                checked={allSelected}
                disabled={blocked || !files.length || relink !== undefined}
                onChange={() => select(files, !allSelected)}
              />
              <span>Name</span>
              <span>Type</span>
              <span>Size</span>
            </label>
            <ul className="import-entries" aria-label="Folders and recordings">
              {visible.map((entry) =>
                entry.kind === 'directory' ? (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="import-row import-folder"
                      aria-label={`Open folder ${entry.name}`}
                      disabled={blocked}
                      onClick={() => navigate(entry.path)}
                    >
                      <span aria-hidden="true" />
                      <Icon name="folder" size={16} />
                      <span>{entry.name}</span>
                      <span>Folder</span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </li>
                ) : (
                  <li key={entry.path}>
                    <label
                      className="import-row import-file"
                      data-selected={selected.has(entry.path)}
                      title={entry.path}
                      onDoubleClick={() => {
                        void submitFiles([entry as FileEntry]);
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${entry.name}`}
                        checked={selected.has(entry.path)}
                        disabled={blocked}
                        onChange={(event) =>
                          chooseFile(
                            entry as FileEntry,
                            shiftHeld.current || (event.nativeEvent as MouseEvent).shiftKey === true,
                          )
                        }
                      />
                      {entry.kind === 'video' ? (
                        <RecordingPreview loader={previews} entry={entry as FileEntry} />
                      ) : (
                        <Icon name="music" size={16} />
                      )}
                      <span>{entry.name}</span>
                      <span>{KIND_LABEL[entry.kind]}</span>
                      <small>{fileSize(entry.size ?? 0)}</small>
                    </label>
                  </li>
                ),
              )}
            </ul>
            {loadingFolder && <output className="import-empty">Reading folder…</output>}
            {!loading && root && listing && !visible.length && (
              <p className="import-empty">
                {query || kind !== 'all'
                  ? 'Nothing here matches this filter.'
                  : 'No video (MP4, MOV, M4V) or music recordings in this folder.'}
              </p>
            )}
            {!loadingRoots && !availableRoots.length && (
              <div className="import-empty">
                <strong>No media locations are available</strong>
                <p>
                  Enter a path under Other location, or configure PASCAP_MEDIA_ROOTS for the service.
                  {roots.map((item) => ` ${item.path}: ${item.error}`).join('')}
                </p>
              </div>
            )}
          </div>
          {listing?.truncated && (
            <p className="control-hint">
              This folder has too many entries to list them all. Open a subfolder to see the rest.
            </p>
          )}
          {listing && listing.warnings.length > 0 && (
            <details className="footage-warnings">
              <summary>Some entries could not be read</summary>
              <ul>
                {listing.warnings.map((warning, index) => (
                  <li key={`${index}:${warning}`}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {report && <ImportReport report={report} />}
        </section>
      </div>
    </Modal>
  );
}
