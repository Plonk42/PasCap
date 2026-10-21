import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectDocument } from '../shared/model.js';
import type { OperationOutput } from '../shared/operations/index.js';
import { formatTimecode } from '../shared/timing.js';
import { describeEdit } from './edit-summary.js';
import { Icon } from './icons.js';
import { callOperation } from './operations.js';

export type SessionStatus = OperationOutput<'session_status'>;
type Session = NonNullable<SessionStatus['session']>;

const POLL_MS = 1500;

/** The open project's assistant session, polled while the page is visible. */
export function useAssistantSession(projectId: string | null): {
  status: SessionStatus | null;
  refresh: () => Promise<SessionStatus | null>;
} {
  const [polled, setPolled] = useState<{ projectId: string; status: SessionStatus } | null>(null);
  const latest = useRef(projectId);
  latest.current = projectId;
  const refresh = useCallback(async (): Promise<SessionStatus | null> => {
    const id = latest.current;
    if (id === null) return null;
    try {
      const next = await callOperation('session_status', { projectId: id, checkpoints: false });
      if (latest.current === id) setPolled({ projectId: id, status: next });
      return next;
    } catch {
      // A missed poll is retried by the next one; the editor keeps its last known state.
      return null;
    }
  }, []);
  useEffect(() => {
    if (projectId === null) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, refresh]);
  return { status: polled?.projectId === projectId ? polled.status : null, refresh };
}

export interface FollowOptions {
  projectId: string | null;
  /** The editor's saved revision, or null without a project. */
  revision: () => number | null;
  /** True when the editor holds no unsaved change or gesture, so a newer saved project may replace it. */
  idle: () => boolean;
  load: (projectId: string) => Promise<ProjectDocument>;
  /** Replaces the editor's document; frame is where the latest adopted edit shows, or null. */
  adopt: (document: ProjectDocument, frame: number | null) => void;
}

/** The frame of the latest edit between two saved revisions that changed one, or null. */
export function latestEditedFrame(session: Session | null, from: number | null, to: number): number | null {
  const edits = session?.edits.filter(
    (edit) => edit.frame !== null && edit.revision <= to && (from === null || edit.revision > from),
  );
  return edits?.at(-1)?.frame ?? null;
}

/**
 * Follows an assistant session: while it is active, and once after it ends, the editor adopts each
 * newer saved revision unless it holds unsaved changes, which stay for the user to keep or discard.
 */
export function useFollowAssistant({ projectId, revision, idle, load, adopt }: FollowOptions) {
  const { status, refresh } = useAssistantSession(projectId);
  const seen = useRef(new Set<string>());
  // The session the project already had when the editor opened it, which the editor did not follow.
  const before = useRef<{ projectId: string; startedAt: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const session = status?.session ?? null;
  if (status && projectId !== null && before.current?.projectId !== projectId)
    before.current = { projectId, startedAt: session?.active ? null : (session?.startedAt ?? null) };
  // A session that started and ended between two polls is followed too.
  if (session && (session.active || session.startedAt !== before.current?.startedAt))
    seen.current.add(session.startedAt);
  const followed = session !== null && seen.current.has(session.startedAt);
  const target = status?.revision ?? null;
  useEffect(() => {
    if (projectId === null || target === null || !followed || target === revision() || !idle()) return;
    let cancelled = false;
    void load(projectId)
      .then((document) => {
        const from = revision();
        if (!cancelled && document.revision !== from && idle())
          adopt(document, latestEditedFrame(session, from, document.revision));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Each poll rechecks, so a revision skipped during a gesture is adopted once the editor is idle.
  }, [projectId, status, session, target, followed, revision, idle, load, adopt]);
  return {
    session,
    following: session?.active === true,
    ended: followed && session?.active === false && dismissed !== session.startedAt ? session : null,
    dismiss: () => setDismissed(session?.startedAt ?? null),
    refresh,
  };
}

function lastEdit(session: Session): string {
  const edit = session.edits.at(-1);
  return edit ? `last: ${describeEdit(edit.summary)}` : 'no edits yet';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function AssistantEditingBanner({
  session,
  busy,
  onTakeOver,
}: Readonly<{
  session: Session;
  busy: boolean;
  onTakeOver: () => void;
}>) {
  return (
    <output className="assistant-banner editing" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div>
        <strong>An assistant is editing this project</strong>
        <span>
          {plural(session.edits.length, 'edit')} so far · {lastEdit(session)}. Take over to edit it yourself.
        </span>
      </div>
      <button className="primary-button small" disabled={busy} onClick={onTakeOver}>
        Take over
      </button>
    </output>
  );
}

const ENDED: Record<NonNullable<Session['endedBy']>, string> = {
  assistant: 'The assistant finished',
  user: 'You took the project back',
  expiry: 'The assistant session ended after a period without activity',
};

export function AssistantEndedBanner({
  session,
  busy,
  restoreReason,
  onRestore,
  onOpenCopy,
  onSeek,
  onDismiss,
}: Readonly<{
  session: Session;
  busy: boolean;
  /** Why restoring or opening the earlier project is unavailable, or null. */
  restoreReason: string | null;
  onRestore: () => void;
  onOpenCopy: () => void;
  onSeek: (frame: number) => void;
  onDismiss: () => void;
}>) {
  const unavailable = busy || restoreReason !== null;
  return (
    <section className="assistant-banner ended" aria-label="Assistant session summary">
      <div>
        <strong>
          {ENDED[session.endedBy ?? 'assistant']} · {plural(session.edits.length, 'edit')}
        </strong>
        {session.notes && <span className="assistant-notes">{session.notes}</span>}
        {session.edits.length > 0 && (
          <details className="assistant-edits">
            <summary>Edit log</summary>
            <ol>
              {session.edits.map(({ revision, at, summary, frame }) => (
                <li key={revision}>
                  {new Date(at).toLocaleTimeString()} · {describeEdit(summary)}
                  {frame !== null && (
                    <button
                      className="text-button"
                      aria-label={`Go to the edit at ${formatTimecode(frame)}`}
                      onClick={() => onSeek(frame)}
                    >
                      {formatTimecode(frame)}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
      {session.edits.length > 0 && (
        <>
          <button
            className="secondary-button small"
            aria-disabled={unavailable}
            title={restoreReason ?? 'Open the project as it was when the session started, as a new project'}
            onClick={() => {
              if (!unavailable) onOpenCopy();
            }}
          >
            <Icon name="folder" size={15} />
            Open as new project
          </button>
          <button
            className="secondary-button small"
            aria-disabled={unavailable}
            title={restoreReason ?? 'Replace the project with the checkpoint taken when the session started'}
            onClick={() => {
              if (!unavailable) onRestore();
            }}
          >
            <Icon name="undo" size={15} />
            Restore project before session
          </button>
        </>
      )}
      <button className="icon-button" aria-label="Dismiss assistant session summary" onClick={onDismiss}>
        <Icon name="x" size={16} />
      </button>
    </section>
  );
}
