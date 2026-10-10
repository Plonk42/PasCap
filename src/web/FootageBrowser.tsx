import { useEffect, useRef, useState } from 'react';
import { MAX_FOOTAGE_FILES, type FootageDirectory, type FootageRoot } from '../shared/footage.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import type { ImportResult } from './MediaLibrary.js';

interface Props {
  busy: boolean;
  onRegister: (paths: readonly string[]) => Promise<ImportResult>;
  onResult: (result: ImportResult) => void;
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Cannot read this recording location. Check its mount and permissions, then refresh.';
}

export function FootageBrowser({ busy, onRegister, onResult }: Readonly<Props>) {
  const [roots, setRoots] = useState<FootageRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const [directory, setDirectory] = useState<string | undefined>();
  const [listing, setListing] = useState<FootageDirectory | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [rootsError, setRootsError] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [registering, setRegistering] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const anchor = useRef<string | null>(null);
  const root = roots.find((item) => item.id === rootId);
  const blocked = busy || registering;
  const loading = loadingRoots || loadingDirectory;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingRoots(true);
    setRootsError('');
    void api
      .footageRoots({ signal: controller.signal })
      .then(({ roots: next }) => {
        if (controller.signal.aborted) return;
        setRoots(next);
        setRootId((previous) =>
          next.some((item) => item.id === previous) ? previous : (next.find((item) => item.available)?.id ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setRootsError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRoots(false);
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!root?.available) {
      setListing(null);
      setLoadingDirectory(false);
      return;
    }
    const controller = new AbortController();
    setListing(null);
    setLoadingDirectory(true);
    setDirectoryError('');
    void api
      .browseFootage(root.id, directory, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setListing(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDirectoryError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDirectory(false);
      });
    return () => controller.abort();
  }, [root, directory, refresh]);

  const navigate = (next: string | undefined): void => {
    setDirectory(next);
    anchor.current = null;
    setQuery('');
    setDirectoryError('');
  };
  const visible =
    listing?.entries.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const videos = visible.filter((item) => item.kind === 'video');
  const allSelected = videos.length > 0 && videos.every((item) => selected.has(item.path));
  const toggle = (paths: readonly string[], remove: boolean): void => {
    const next = new Set(selected);
    paths.forEach((filename) => {
      if (remove) next.delete(filename);
      else next.add(filename);
    });
    if (next.size > MAX_FOOTAGE_FILES) {
      setDirectoryError(`Select at most ${MAX_FOOTAGE_FILES} recordings per import.`);
      return;
    }
    setSelected(next);
  };
  const toggleRecording = (path: string, shift: boolean): void => {
    const from = shift && anchor.current ? videos.findIndex((item) => item.path === anchor.current) : -1;
    const to = videos.findIndex((item) => item.path === path);
    anchor.current = path;
    if (from < 0 || to < 0) {
      toggle([path], selected.has(path));
      return;
    }
    const range = videos.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.path);
    toggle(range, selected.has(path));
  };
  const register = async (): Promise<void> => {
    if (blocked || pending.current || !selected.size) return;
    pending.current = true;
    setRegistering(true);
    try {
      const result = await onRegister([...selected]);
      if (mounted.current) {
        onResult(result);
        if (result.ok) setSelected(new Set());
      }
    } catch (cause) {
      if (mounted.current) setDirectoryError(message(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setRegistering(false);
    }
  };

  return (
    <section className="footage-browser" aria-label="Browse original recordings" aria-busy={loading || registering}>
      <div className="footage-location-tools">
        <label className="activity-field">
          <span>Recording location</span>
          <select
            aria-label="Recording location"
            value={rootId}
            disabled={blocked || loadingRoots}
            onChange={(event) => {
              setRootId(event.target.value);
              navigate(undefined);
              setSelected(new Set());
            }}
          >
            {!rootId && <option value="">Choose an approved folder</option>}
            {roots.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.name} · {item.path}
                {!item.available && ' (unavailable)'}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button small"
          aria-label="Refresh recording locations"
          disabled={blocked || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <Icon name="reset" size={15} />
          Refresh
        </button>
      </div>
      {rootsError && (
        <p className="footage-error" role="alert">
          {rootsError}
        </p>
      )}
      {!loadingRoots && !rootsError && !roots.some((item) => item.available) && (
        <div className="footage-empty">
          <strong>No readable recording locations</strong>
          <p>
            Configure PASCAP_MEDIA_ROOTS for the service, or use the explicit folder-path import below. Container
            locations must be mounted read-only.
          </p>
          {roots.map((item) => (
            <p key={item.id}>
              {item.path}: {item.error}
            </p>
          ))}
        </div>
      )}
      {root && (
        <>
          <div className="footage-navigation">
            <button
              className="secondary-button small"
              aria-label="Up one recording folder"
              disabled={blocked || loading || !listing?.parent}
              onClick={() => navigate(listing!.parent!)}
            >
              Up
            </button>
            <button
              className="secondary-button small"
              aria-label="Recording root folder"
              disabled={blocked || loading || !directory}
              onClick={() => navigate(undefined)}
            >
              Root
            </button>
            <output title={listing?.directory ?? root.path}>{listing?.directory ?? root.path}</output>
          </div>
          <input
            type="search"
            aria-label="Search recordings"
            placeholder="Filter this folder"
            value={query}
            disabled={blocked || loading}
            onChange={(event) => setQuery(event.target.value)}
          />
          {directoryError && (
            <p className="footage-error" role="alert">
              {directoryError}
            </p>
          )}
          {loadingDirectory && <output className="footage-loading">Reading folder…</output>}
          {!loading && listing && (
            <>
              <label className="footage-select-all">
                <input
                  type="checkbox"
                  aria-label="Select visible original recordings"
                  checked={allSelected}
                  disabled={blocked || !videos.length}
                  onChange={() =>
                    toggle(
                      videos.map((item) => item.path),
                      allSelected,
                    )
                  }
                />
                Select visible recordings
              </label>
              <ul className="footage-entry-list" aria-label="Recording entries">
                {visible.map((item) => (
                  <li key={item.path}>
                    {item.kind === 'directory' ? (
                      <button
                        className="footage-directory"
                        aria-label={`Open recording folder ${item.name}`}
                        disabled={blocked}
                        onClick={() => navigate(item.path)}
                      >
                        <Icon name="folder" size={17} />
                        <span>{item.name}</span>
                        <span aria-hidden="true">›</span>
                      </button>
                    ) : (
                      <label className="footage-recording">
                        <input
                          type="checkbox"
                          aria-label={`Select recording ${item.name}`}
                          checked={selected.has(item.path)}
                          disabled={blocked}
                          onChange={(event) =>
                            toggleRecording(item.path, (event.nativeEvent as MouseEvent).shiftKey === true)
                          }
                        />
                        <Icon name="video" size={17} />
                        <span>{item.name}</span>
                        <small>
                          {(item.size / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB
                        </small>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
              {!visible.length && (
                <p className="control-hint">
                  {query ? 'No matching files or folders.' : 'No MP4, MOV or M4V recordings in this folder.'}
                </p>
              )}
              {listing.truncated && (
                <p className="control-hint">
                  This folder exceeds the {listing.entries.length}-entry listing limit. Open a smaller subfolder or use
                  the folder-path import.
                </p>
              )}
              {listing.warnings.length > 0 && (
                <details className="footage-warnings">
                  <summary>Folder access warnings</summary>
                  <ul>
                    {listing.warnings.map((warning, index) => (
                      <li key={`${index}:${warning}`}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}
      <div className="footage-registration">
        <span>
          {selected.size} selected{selected.size > 0 && ' · originals remain in place'}
        </span>
        <button className="text-button" disabled={blocked || !selected.size} onClick={() => setSelected(new Set())}>
          Clear selection
        </button>
        <button
          className="primary-button"
          aria-label="Register selected recordings"
          disabled={blocked || loading || !selected.size}
          onClick={() => {
            void register();
          }}
        >
          {registering ? 'Registering…' : `Register ${selected.size} recordings`}
        </button>
      </div>
    </section>
  );
}
