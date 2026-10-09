import { useEffect, useId, useRef, useState } from 'react';
import { MAX_FOOTAGE_ENTRIES, type AudioDirectory, type FootageRoot } from '../shared/footage.js';
import { api } from './api.js';
import { Icon } from './icons.js';

interface Props {
  busy: boolean;
  onImport: (path: string) => Promise<void>;
}
interface Location {
  rootId: string;
  directory: string | undefined;
}
interface Selection {
  rootId: string;
  path: string;
  name: string;
}

function message(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Cannot read this music location. Check its mount and permissions, then refresh.';
}

export function MusicBrowser({ busy, onImport }: Readonly<Props>) {
  const radioName = useId();
  const [roots, setRoots] = useState<FootageRoot[]>([]);
  const [location, setLocation] = useState<Location>({ rootId: '', directory: undefined });
  const [listing, setListing] = useState<AudioDirectory | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [rootsError, setRootsError] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const root = roots.find((item) => item.id === location.rootId);
  const rootAvailable = root?.available ?? false;
  const rootPath = root?.path;
  const selection = selected?.rootId === location.rootId ? selected : null;
  const loading = loadingRoots || loadingDirectory;

  useEffect(() => {
    const controller = new AbortController();
    setLoadingRoots(true);
    setRootsError('');
    void api
      .audioRoots({ signal: controller.signal })
      .then(({ roots: next }) => {
        if (controller.signal.aborted) return;
        setRoots(next);
        setLocation((previous) =>
          next.some((item) => item.id === previous.rootId)
            ? previous
            : { rootId: next.find((item) => item.available)?.id ?? next[0]?.id ?? '', directory: undefined },
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
    setListing(null);
    setDirectoryError('');
    if (!rootAvailable) {
      setLoadingDirectory(false);
      return;
    }
    const controller = new AbortController();
    setLoadingDirectory(true);
    void api
      .browseAudio(location.rootId, location.directory, { signal: controller.signal })
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
  }, [location, rootAvailable, rootPath, refresh]);

  const navigate = (directory?: string): void => {
    setLocation((previous) => ({ rootId: previous.rootId, directory }));
    setQuery('');
  };
  const visible =
    listing?.entries.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const canImport =
    !busy && !loading && rootAvailable && listing !== null && !rootsError && !directoryError && selection !== null;
  const register = async (): Promise<void> => {
    if (!canImport || pending.current || !selection) return;
    pending.current = true;
    try {
      await onImport(selection.path);
    } finally {
      pending.current = false;
    }
  };

  return (
    <section
      className="footage-browser music-browser"
      aria-label="Browse original music recordings"
      aria-busy={loading || busy}
    >
      <div className="footage-location-tools">
        <label className="activity-field">
          <span>Music location</span>
          <select
            aria-label="Music location"
            value={location.rootId}
            disabled={busy || loadingRoots}
            onChange={(event) => {
              setLocation({ rootId: event.target.value, directory: undefined });
              setQuery('');
              setSelected(null);
            }}
          >
            {!location.rootId && <option value="">Choose an approved folder</option>}
            {roots.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.name} · {item.path}
                {!item.available && ' (unavailable)'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button small"
          aria-label="Refresh music locations"
          disabled={busy || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <Icon name="reset" size={15} />
          Refresh
        </button>
      </div>
      {loadingRoots && <output className="footage-loading">Reading music locations…</output>}
      {rootsError && (
        <p className="footage-error" role="alert">
          {rootsError}
        </p>
      )}
      {!loadingRoots && !rootsError && !roots.some((item) => item.available) && (
        <div className="footage-empty">
          <strong>No readable music locations</strong>
          <p>
            Configure PASCAP_MEDIA_ROOTS for the service, or Cancel and use the manual Music recording path. Container
            locations must be mounted read-only.
          </p>
        </div>
      )}
      {roots.some((item) => !item.available) && (
        <details className="footage-warnings">
          <summary>Unavailable music locations</summary>
          {roots
            .filter((item) => !item.available)
            .map((item) => (
              <p key={item.id}>
                {item.path}: {item.error}
              </p>
            ))}
        </details>
      )}
      {root && (
        <>
          <div className="footage-navigation">
            <button
              type="button"
              className="secondary-button small"
              aria-label="Up one music folder"
              disabled={busy || loading || !listing?.parent}
              onClick={() => navigate(listing!.parent!)}
            >
              Up
            </button>
            <button
              type="button"
              className="secondary-button small"
              aria-label="Music root folder"
              disabled={busy || loading || !location.directory}
              onClick={() => navigate()}
            >
              Root
            </button>
            <output title={listing?.directory ?? root.path}>{listing?.directory ?? root.path}</output>
          </div>
          <input
            type="search"
            aria-label="Search music recordings"
            placeholder="Filter this folder"
            value={query}
            disabled={busy || loading}
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
              <fieldset className="music-browser-files" disabled={busy}>
                <legend className="declutter-sr-only">Choose one music recording</legend>
                <ul className="footage-entry-list" aria-label="Music recording entries">
                  {visible.map((item) => (
                    <li key={item.path}>
                      {item.kind === 'directory' ? (
                        <button
                          type="button"
                          className="footage-directory"
                          aria-label={`Open music folder ${item.name}`}
                          disabled={busy}
                          onClick={() => navigate(item.path)}
                        >
                          <Icon name="folder" size={17} />
                          <span>{item.name}</span>
                          <span aria-hidden="true">›</span>
                        </button>
                      ) : (
                        <label className="footage-recording">
                          <input
                            type="radio"
                            name={radioName}
                            aria-label={`Select music recording ${item.name}`}
                            checked={selection?.path === item.path}
                            onChange={() => setSelected({ rootId: location.rootId, path: item.path, name: item.name })}
                          />
                          <Icon name="music" size={17} />
                          <span>{item.name}</span>
                          <small>
                            {(item.size / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB
                          </small>
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
              </fieldset>
              {!visible.length && (
                <p className="control-hint">
                  {query ? 'No matching music recordings or folders.' : 'No supported music recordings in this folder.'}
                </p>
              )}
              {listing.truncated && (
                <p className="control-hint">
                  This folder exceeds the {MAX_FOOTAGE_ENTRIES.toLocaleString()}-entry listing limit. Open a smaller
                  subfolder or Cancel and use the manual Music recording path.
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
      <p className="control-hint">
        WAV, MP3, M4A, AAC, FLAC, OGG, OPUS, AIFF, AIF and WMA are discovery candidates; registration checks the actual
        audio streams.
      </p>
      <div className="footage-registration">
        <output title={selection?.path} aria-live="polite">
          {selection ? `Selected: ${selection.name} · original stays in place` : 'No music recording selected'}
        </output>
        <button type="button" className="text-button" disabled={busy || !selection} onClick={() => setSelected(null)}>
          Clear selection
        </button>
        <button
          type="button"
          className="primary-button"
          aria-label="Import selected music"
          disabled={!canImport}
          onClick={() => {
            void register();
          }}
        >
          {busy ? 'Importing…' : 'Import selected music'}
        </button>
      </div>
    </section>
  );
}
