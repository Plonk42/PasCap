import { useId } from 'react';
import type { SaveState } from './autosave.js';
import { Modal } from './Modal.js';

interface Props {
  title: string;
  state: SaveState;
  busy: boolean;
  error: string;
  onDownload: () => void;
  onReload: () => Promise<boolean>;
  onClose: () => void;
}

/** Reloading never overwrites the other tab's save or implicitly rebases a draft. */
export function SaveRecovery({ title, state, busy, error, onDownload, onReload, onClose }: Readonly<Props>) {
  const id = useId();
  return (
    <Modal
      className="recovery-dialog"
      labelledBy={id}
      busy={busy}
      error={error}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Keep editing this draft
          </button>
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => {
              void onReload().then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            Discard local changes and reload
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={id}>Recover an unsaved project</h2>
      </div>
      <strong>{title}</strong>
      <p>
        {state.recovery === 'conflict'
          ? 'Another tab or session has changed the saved revision. This editor has kept your local draft; it will not overwrite that save.'
          : 'The save could not be confirmed. The local draft is still in this editor; check the latest saved project before trying again.'}
      </p>
      <p className="activity-hint">
        Download a copy before reloading if you want to retain these changes. Reloading replaces this editor’s local
        draft and undo history, but does not modify the saved project.
      </p>
      <button className="secondary-button recovery-copy" onClick={onDownload}>
        Download unsaved project
      </button>
    </Modal>
  );
}
