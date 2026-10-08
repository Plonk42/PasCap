import { useEffect, useId, useRef, useState } from 'react';
import type { MediaJob } from '../shared/media.js';
import './activity.css';
import { Icon } from './icons.js';

export interface JobsProps {
  jobs: readonly MediaJob[];
  onCancel: (id: string) => Promise<boolean>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  busy: boolean;
  error: string;
  onRefresh: () => Promise<boolean>;
}

const KIND_LABELS: Readonly<Record<MediaJob['kind'], string>> = {
  prepare: 'Video preparation',
  audio: 'Audio preparation',
  reference: 'Reference render',
  export: 'Export',
};
const STATE_LABELS: Readonly<Record<MediaJob['state'], string>> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function isActiveJob(job: MediaJob): boolean {
  return job.state === 'running' || job.state === 'queued';
}

function timestamp(value: string | null): number {
  const time = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function activityRank(job: MediaJob): number {
  if (job.state === 'running') return 0;
  if (job.state === 'queued') return 1;
  return 2;
}

/** Running first, then the FIFO queue, then history by actual completion time. */
export function orderActivityJobs(jobs: readonly MediaJob[]): MediaJob[] {
  return [...jobs].sort((left, right) => {
    const rank = activityRank(left) - activityRank(right);
    if (rank) return rank;
    if (isActiveJob(left))
      return timestamp(left.createdAt) - timestamp(right.createdAt) || left.id.localeCompare(right.id);
    return (
      timestamp(right.finishedAt ?? right.createdAt) - timestamp(left.finishedAt ?? left.createdAt) ||
      timestamp(right.createdAt) - timestamp(left.createdAt) ||
      left.id.localeCompare(right.id)
    );
  });
}

export function activitySummary(jobs: readonly MediaJob[]): string {
  if (!jobs.length) return 'No activity yet';
  const counts: Record<MediaJob['state'], number> = { running: 0, queued: 0, failed: 0, cancelled: 0, completed: 0 };
  for (const job of jobs) counts[job.state]++;
  return (Object.keys(counts) as MediaJob['state'][])
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`)
    .join(' · ');
}

/** Only settled jobs are announced; progress polling never changes this text. */
export function activityResultSummary(job: MediaJob | null): string {
  if (!job || isActiveJob(job)) return '';
  const detail = (job.state === 'failed' || job.state === 'cancelled') && job.message ? `. ${job.message}` : '';
  return `${KIND_LABELS[job.kind]} ${job.state}: ${job.label}${detail}`;
}

function JobTime({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <span>
      {label}{' '}
      {Number.isFinite(Date.parse(value)) ? (
        <time dateTime={value}>
          {new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      ) : (
        'time unavailable'
      )}
    </span>
  );
}

export function Jobs({ jobs, onCancel, open, onOpen, onClose, busy, error, onRefresh }: Readonly<JobsProps>) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancellationRequests = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const [cancelErrors, setCancelErrors] = useState<Readonly<Record<string, string>>>({});
  const ordered = orderActivityJobs(jobs);
  const active = ordered.filter(isActiveJob);
  const history = ordered.filter((job) => !isActiveJob(job));
  const settled = history[0] ?? null;
  const summary = activitySummary(jobs);
  const resultSummary = activityResultSummary(settled);
  const footerError = error || Object.values(cancelErrors)[0] || '';

  useEffect(() => {
    if (open && !document.querySelector('dialog[open]')) closeButton.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    const element = drawer.current;
    if (!open || !element) return;
    // A local listener keeps this a nonmodal region, not a native dialog that
    // would make the shell's dialog[open] shortcut guard block the editor.
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || !element.contains(element.ownerDocument.activeElement))
        return;
      event.preventDefault();
      event.stopPropagation();
      trigger.current?.focus({ preventScroll: true });
      onClose();
    };
    element.addEventListener('keydown', closeOnEscape);
    return () => {
      element.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, onClose]);

  useEffect(() => {
    const activeIds = new Set(jobs.filter(isActiveJob).map((job) => job.id));
    let changed = false;
    for (const jobId of cancellationRequests.current) {
      if (!activeIds.has(jobId)) {
        cancellationRequests.current.delete(jobId);
        changed = true;
      }
    }
    if (changed) setCancelling(new Set(cancellationRequests.current));
    setCancelErrors((previous) => {
      const retained = Object.entries(previous).filter(([jobId]) => activeIds.has(jobId));
      return retained.length === Object.keys(previous).length ? previous : Object.fromEntries(retained);
    });
  }, [jobs]);

  const closeActivity = (): void => {
    if (drawer.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    onClose();
  };

  const cancelJob = async (job: MediaJob): Promise<void> => {
    if (busy || !isActiveJob(job) || cancellationRequests.current.has(job.id)) return;
    cancellationRequests.current.add(job.id);
    setCancelling(new Set(cancellationRequests.current));
    setCancelErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([jobId]) => jobId !== job.id)));
    try {
      if (await onCancel(job.id)) return; // Accepted is not yet cancelled: wait for the actual job state.
      setCancelErrors((previous) => ({ ...previous, [job.id]: 'Cancellation was not accepted. Try again.' }));
    } catch (cause) {
      setCancelErrors((previous) => ({
        ...previous,
        [job.id]: cause instanceof Error ? cause.message : 'Cannot cancel this job.',
      }));
    }
    cancellationRequests.current.delete(job.id);
    setCancelling(new Set(cancellationRequests.current));
  };

  const jobRow = (job: MediaJob) => (
    <li key={job.id} className="activity-job" data-state={job.state}>
      <div className="activity-job-heading">
        <strong>{job.label}</strong>
        <span className={`activity-badge ${job.state}`}>{STATE_LABELS[job.state]}</span>
      </div>
      <p className="activity-job-kind">{KIND_LABELS[job.kind]}</p>
      {job.message && <p className="activity-job-message">{job.message}</p>}
      {isActiveJob(job) && (
        <div className="activity-job-progress">
          <progress max={1} value={job.progress} aria-label={`Progress for ${job.label}`} />
          <span>{Math.round(job.progress * 100)}%</span>
        </div>
      )}
      <div className="activity-job-times">
        <JobTime label="Created" value={job.createdAt} />
        {job.finishedAt && <JobTime label={STATE_LABELS[job.state]} value={job.finishedAt} />}
      </div>
      <div className="activity-job-actions">
        {isActiveJob(job) && (
          <button
            className="secondary-button"
            aria-label={`Cancel ${job.label}`}
            disabled={busy || cancelling.has(job.id)}
            onClick={() => {
              void cancelJob(job);
            }}
          >
            {cancelling.has(job.id) ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {job.state === 'completed' && job.outputUrl && (
          <>
            <a href={job.outputUrl} target="_blank" rel="noreferrer" title={`Open ${job.label}`}>
              Open
            </a>
            <a href={job.outputUrl} download aria-label={`Download ${job.label}`}>
              Download
            </a>
          </>
        )}
        {job.state === 'completed' && job.receiptUrl && (
          <a href={job.receiptUrl} target="_blank" rel="noreferrer" aria-label={`Receipt for ${job.label}`}>
            Receipt
          </a>
        )}
        {isActiveJob(job) && cancelling.has(job.id) && (
          <span className="activity-hint">Waiting for cancellation confirmation.</span>
        )}
      </div>
      {cancelErrors[job.id] && !error && (
        <p className="activity-dialog-error" role="alert">
          {cancelErrors[job.id]}
        </p>
      )}
    </li>
  );

  return (
    <>
      <footer className="activity-footer" aria-label="Media activity">
        <button
          ref={trigger}
          className="secondary-button activity-toggle"
          aria-label="Open activity"
          aria-expanded={open}
          aria-controls={`${id}-drawer`}
          onClick={onOpen}
        >
          <Icon name="activity" size={15} />
          Activity
        </button>
        <span className="activity-footer-summary" title={summary}>
          {summary}
        </span>
        <output
          className="activity-footer-result"
          data-state={settled?.state}
          aria-live="polite"
          aria-atomic="true"
          title={resultSummary}
        >
          {resultSummary}
        </output>
        {!open && footerError && (
          <span className="activity-footer-error" role="alert" title={footerError}>
            {footerError}
          </span>
        )}
      </footer>
      {open && (
        <section
          ref={drawer}
          id={`${id}-drawer`}
          className="activity-drawer"
          aria-labelledby={`${id}-title`}
          tabIndex={-1}
        >
          <div className="activity-drawer-heading">
            <h2 id={`${id}-title`}>Activity</h2>
            <button
              className="secondary-button"
              disabled={busy}
              aria-label="Refresh activity"
              onClick={() => {
                void onRefresh();
              }}
            >
              <Icon name="reset" size={14} />
              Refresh
            </button>
            <button ref={closeButton} className="secondary-button" aria-label="Close activity" onClick={closeActivity}>
              <Icon name="x" size={14} />
              Close
            </button>
          </div>
          <p className="activity-hint">{summary}</p>
          {error && (
            <p className="activity-dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="activity-drawer-body">
            {!jobs.length ? (
              <div className="activity-empty">
                <strong>No jobs yet</strong>
                <p>Video and audio preparation, reference renders and exports appear here.</p>
              </div>
            ) : (
              <>
                <section className="activity-group" aria-label="Active jobs">
                  <h3>Queued and running ({active.length})</h3>
                  {active.length ? (
                    <ul className="activity-job-list">{active.map(jobRow)}</ul>
                  ) : (
                    <p className="activity-hint">No queued or running jobs.</p>
                  )}
                </section>
                <section className="activity-group" aria-label="Job history">
                  <h3>History ({history.length})</h3>
                  {history.length ? (
                    <ul className="activity-job-list">{history.map(jobRow)}</ul>
                  ) : (
                    <p className="activity-hint">Finished jobs will appear here.</p>
                  )}
                </section>
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
}
