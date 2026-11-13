import { useEffect, useId, useState } from 'react';
import type { FootageRoot, ReferenceDirectory } from '../shared/footage.js';
import { MAX_STYLE_REFERENCES, MAX_STYLE_NAME } from '../shared/styles.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { Modal } from './Modal.js';
import { browseReferences, deleteStyle, referencesLabel, registerStyle, useStyles } from './styles.js';
import './styles-dialog.css';

const message = (cause: unknown, fallback: string): string => (cause instanceof Error ? cause.message : fallback);

/**
 * Registered styles (#314): looks measured on the user's own finished edits, which Color → Match can aim at. A
 * style's references are videos or stills read where they are, in the approved footage folders.
 */
export function StylesDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const id = useId();
  const styles = useStyles();
  const [roots, setRoots] = useState<FootageRoot[]>([]);
  const [listing, setListing] = useState<ReferenceDirectory | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const browse = (rootId: string, directory?: string): void => {
    setError('');
    browseReferences(rootId, directory).then(setListing, (cause: unknown) =>
      setError(message(cause, 'This folder cannot be listed.')),
    );
  };
  useEffect(() => {
    api.footageRoots().then(
      ({ roots: found }) => {
        setRoots(found);
        const first = found.find((root) => root.available);
        if (first) browse(first.id);
      },
      (cause: unknown) => setError(message(cause, 'The footage folders cannot be listed.')),
    );
  }, []);

  const toggle = (path: string): void =>
    setSelected((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  const register = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await registerStyle(name.trim(), selected);
      setName('');
      setSelected([]);
    } catch (cause) {
      setError(message(cause, 'The style could not be registered.'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (styleId: string): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await deleteStyle(styleId);
    } catch (cause) {
      setError(message(cause, 'The style could not be deleted.'));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };
  const full = selected.length >= MAX_STYLE_REFERENCES;
  const ready = name.trim() !== '' && selected.length > 0 && !busy;

  return (
    <Modal
      className="styles-dialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-intro`}
      busy={busy}
      error={error}
      onClose={onClose}
      footer={
        <>
          {busy && <span className="activity-hint">Measuring the references…</span>}
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Close
          </button>
          <button
            className="primary-button"
            disabled={!ready}
            onClick={() => {
              void register();
            }}
          >
            <Icon name="plus" size={15} />
            Register style
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={`${id}-title`}>Styles</h2>
      </div>
      <p id={`${id}-intro`} className="styles-intro">
        A style is the look of your own finished edits. Color → Match can use it as the reference to match clips to.
        References are read where they are, never copied or changed.
      </p>
      {styles.length ? (
        <ul className="styles-list" aria-label="Registered styles">
          {styles.map((style) => (
            <li key={style.id}>
              <span>
                <strong>{style.name}</strong>
                <small>{referencesLabel(style)}</small>
              </span>
              {confirming === style.id ? (
                <button
                  className="danger-button small"
                  disabled={busy}
                  aria-label={`Confirm deleting style ${style.name}`}
                  onClick={() => {
                    void remove(style.id);
                  }}
                >
                  Delete it
                </button>
              ) : (
                <button
                  className="text-button"
                  disabled={busy}
                  aria-label={`Delete style ${style.name}`}
                  title="Delete this style; its references are not touched"
                  onClick={() => setConfirming(style.id)}
                >
                  <Icon name="trash" size={13} />
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="styles-empty">No style yet.</p>
      )}
      <fieldset className="styles-new" disabled={busy}>
        <legend>New style</legend>
        <div className="styles-field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={MAX_STYLE_NAME}
            placeholder="My summer edits"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="styles-browser">
          <div className="styles-location">
            {roots.length > 1 && (
              <select
                aria-label="Footage folder"
                value={listing?.rootId ?? ''}
                onChange={(event) => browse(event.target.value)}
              >
                {roots.map((root) => (
                  <option key={root.id} value={root.id} disabled={!root.available}>
                    {root.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="icon-button"
              aria-label="Parent folder"
              title="Parent folder"
              disabled={!listing?.parent}
              onClick={() => listing?.parent && browse(listing.rootId, listing.parent)}
            >
              <Icon name="chevron-up" size={14} />
            </button>
            <span className="styles-directory" title={listing?.directory}>
              <bdi>{listing?.directory ?? 'No footage folder'}</bdi>
            </span>
          </div>
          <ul className="styles-entries" aria-label="References">
            {listing?.entries.map((entry) =>
              entry.kind === 'directory' ? (
                <li key={entry.path}>
                  <button className="styles-folder" onClick={() => browse(listing.rootId, entry.path)}>
                    <Icon name="folder" size={14} />
                    {entry.name}
                  </button>
                </li>
              ) : (
                <li key={entry.path}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(entry.path)}
                      disabled={full && !selected.includes(entry.path)}
                      onChange={() => toggle(entry.path)}
                    />
                    <span>{entry.name}</span>
                    <small>{entry.kind === 'still' ? 'Still' : 'Video'}</small>
                  </label>
                </li>
              ),
            )}
            {listing && !listing.entries.length && <li className="styles-empty">No videos or stills here.</li>}
          </ul>
          <p className="styles-count">
            {selected.length} of {MAX_STYLE_REFERENCES} references selected
          </p>
        </div>
      </fieldset>
    </Modal>
  );
}
