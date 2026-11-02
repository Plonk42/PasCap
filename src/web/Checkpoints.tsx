import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { OperationOutput } from '../shared/operations/index.js';
import { Icon } from './icons.js';
import { Modal } from './Modal.js';
import { callOperation } from './operations.js';
import './checkpoints.css';

type Checkpoint = OperationOutput<'session_status'>['checkpoints'][number];

const REASONS: Record<Checkpoint['reason'], string> = {
  'session-start': 'Before an assistant session',
  manual: 'Checkpoint',
  'before-restore': 'Before a restore',
};

interface Props {
  projectId: string;
  /** Why restoring is unavailable now, or null. */
  restoreBlocked: string | null;
  busy: boolean;
  error: string;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onTake: (label: string | null) => Promise<boolean>;
  onRestore: (checkpointId: string) => Promise<boolean>;
  /** Opens the checkpoint as a new project; the suffix names it in the new title. */
  onOpenCopy: (checkpointId: string, suffix: string) => Promise<boolean>;
  onClose: () => void;
}

function describe(checkpoint: Checkpoint): { when: string; name: string } {
  const when = new Date(checkpoint.createdAt).toLocaleString();
  return { when, name: checkpoint.label ?? REASONS[checkpoint.reason] };
}

/** Copies of the project the user can come back to, newest first. */
export function CheckpointsDialog({
  projectId,
  restoreBlocked,
  busy,
  error,
  restoreFocusTo,
  onTake,
  onRestore,
  onOpenCopy,
  onClose,
}: Readonly<Props>) {
  const id = useId();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const submitting = busy || pending;

  const load = useCallback(async (): Promise<void> => {
    try {
      setCheckpoints((await callOperation('session_status', { projectId, checkpoints: true })).checkpoints);
      setLoadError('');
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'The checkpoints could not be read.');
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one action at a time; the list is read again unless the action left this project. */
  const run = async (action: () => Promise<boolean>, leaves = false): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setPending(true);
    try {
      const ok = await action();
      if (ok && leaves) onClose();
      else await load();
      return ok;
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  const take = async (): Promise<void> => {
    if (await run(() => onTake(label.trim() || null))) setLabel('');
  };

  return (
    <Modal
      className="checkpoints-dialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-intro`}
      busy={submitting}
      error={error || loadError}
      onClose={onClose}
      restoreFocusTo={restoreFocusTo}
      footer={
        <button className="secondary-button" disabled={submitting} onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={`${id}-title`}>Checkpoints</h2>
      </div>
      <p id={`${id}-intro`} className="checkpoints-intro">
        A checkpoint keeps the project as it is saved now. Restoring one replaces the project, after checkpointing its
        current state so you can come back to it. Only the most recent checkpoints are kept.
      </p>
      <form
        className="checkpoints-new"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitting) void take();
        }}
      >
        <label htmlFor={`${id}-label`}>Name (optional)</label>
        <input
          id={`${id}-label`}
          type="text"
          maxLength={200}
          value={label}
          placeholder="Before reordering the intro"
          disabled={submitting}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button className="primary-button" type="submit" disabled={submitting}>
          <Icon name="disk" size={15} />
          Checkpoint
        </button>
      </form>
      <section aria-labelledby={`${id}-list`}>
        <h3 id={`${id}-list`}>Saved checkpoints</h3>
        {checkpoints === null && !loadError && (
          <output className="activity-hint">
            <span className="spinner" aria-hidden="true" />
            <span>Reading checkpoints…</span>
          </output>
        )}
        {checkpoints?.length === 0 && <p className="checkpoints-empty">No checkpoint yet.</p>}
        {checkpoints && checkpoints.length > 0 && (
          <ul className="checkpoints-list" aria-label="Checkpoints">
            {checkpoints.map((checkpoint) => {
              const { when, name } = describe(checkpoint);
              return (
                <li key={checkpoint.id}>
                  <div className="checkpoint-text">
                    <strong title={name}>{name}</strong>
                    <small>
                      {when} · revision {checkpoint.revision}
                    </small>
                  </div>
                  <button
                    className="secondary-button small"
                    aria-label={`Open the checkpoint of ${when} as a new project`}
                    disabled={submitting}
                    title="Open this checkpoint as a new project, leaving this one unchanged"
                    onClick={() => {
                      void run(() => onOpenCopy(checkpoint.id, checkpoint.label ?? `checkpoint ${when}`), true);
                    }}
                  >
                    <Icon name="folder" size={15} />
                    Open as new project
                  </button>
                  <button
                    className="secondary-button small"
                    aria-label={`Restore the checkpoint of ${when}`}
                    aria-disabled={restoreBlocked !== null}
                    disabled={submitting}
                    title={restoreBlocked ?? 'Replace the project with this checkpoint'}
                    onClick={() => {
                      if (restoreBlocked === null) void run(() => onRestore(checkpoint.id));
                    }}
                  >
                    <Icon name="undo" size={15} />
                    Restore
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Modal>
  );
}
