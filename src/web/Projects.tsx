import { useId, useRef, useState, type RefObject } from 'react';
import type { ProjectSummary } from '../shared/projects.js';
import { framesToSeconds } from '../shared/timing.js';
import { durationLabel } from './display.js';
import { Modal } from './Modal.js';

export interface ProjectsProps {
  projects: readonly ProjectSummary[];
  currentId: string | null;
  busy: boolean;
  error: string;
  onOpen: (id: string) => Promise<boolean>;
  onCreate: (title: string) => Promise<boolean>;
  onDelete: (project: ProjectSummary) => Promise<boolean>;
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

export type ProjectFilter = 'all' | 'compatible' | 'unsupported';

function updatedTime(project: ProjectSummary): number {
  const time = Date.parse(project.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

/** Display-only filtering: incompatible documents are never decoded or changed. */
export function filterProjects(
  projects: readonly ProjectSummary[],
  query: string,
  filter: ProjectFilter = 'all',
): ProjectSummary[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return projects
    .filter((project) => {
      if (filter === 'compatible' && !project.compatible) return false;
      if (filter === 'unsupported' && project.compatible) return false;
      const text = `${project.title} ${project.id}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .sort(
      (left, right) =>
        updatedTime(right) - updatedTime(left) ||
        left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }) ||
        left.id.localeCompare(right.id),
    );
}

type PendingProject = { kind: 'create' } | { kind: 'open' | 'delete'; id: string; title: string };

export function Projects({
  projects,
  currentId,
  busy,
  error,
  onOpen,
  onCreate,
  onDelete,
  onClose,
  restoreFocusTo,
}: Readonly<ProjectsProps>) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [pending, setPending] = useState<PendingProject | null>(null);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const pendingAction = useRef(false);
  const [localError, setLocalError] = useState('');
  const submitting = busy || pending !== null;
  const visible = filterProjects(projects, query, filter);
  const compatibleCount = projects.filter((project) => project.compatible).length;
  let pendingLabel = 'Loading projects…';
  if (pending?.kind === 'open') pendingLabel = `Opening ${pending.title}…`;
  else if (pending?.kind === 'delete') pendingLabel = `Deleting ${pending.title}…`;
  else if (pending?.kind === 'create') pendingLabel = 'Creating project…';

  const openProject = async (project: ProjectSummary): Promise<void> => {
    if (busy || pendingAction.current || !project.compatible) return;
    pendingAction.current = true;
    setPending({ kind: 'open', id: project.id, title: project.title });
    setLocalError('');
    try {
      if (await onOpen(project.id)) onClose();
      else setLocalError('The project could not be opened. Try again or choose another project.');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'The project could not be opened.');
    } finally {
      pendingAction.current = false;
      setPending(null);
    }
  };

  const createProject = async (): Promise<void> => {
    const name = title.trim();
    if (busy || pendingAction.current || !name) return;
    pendingAction.current = true;
    setPending({ kind: 'create' });
    setLocalError('');
    try {
      if (await onCreate(name)) {
        setTitle('');
        onClose();
      } else setLocalError('The project could not be created. Your title is kept so you can try again.');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'The project could not be created.');
    } finally {
      pendingAction.current = false;
      setPending(null);
    }
  };

  const deleteProject = async (): Promise<void> => {
    if (!deleting || busy || pendingAction.current) return;
    pendingAction.current = true;
    setPending({ kind: 'delete', id: deleting.id, title: deleting.title });
    setLocalError('');
    try {
      if (await onDelete(deleting)) {
        setDeleting(null);
        requestAnimationFrame(() => document.getElementById(`${id}-search`)?.focus());
      } else setLocalError('The project could not be deleted. It is kept in the list; check the reported error.');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'The project could not be deleted.');
    } finally {
      pendingAction.current = false;
      setPending(null);
    }
  };

  return (
    <Modal
      className="project-dialog"
      labelledBy={`${id}-title`}
      busy={submitting}
      error={error || localError}
      onClose={onClose}
      {...(restoreFocusTo ? { restoreFocusTo } : {})}
      footer={
        <>
          <span className="activity-hint">
            Projects saved by an older PasCap version cannot be opened. They are kept unchanged.
          </span>
          <button className="secondary-button" onClick={onClose} disabled={submitting}>
            Close
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={`${id}-title`}>Projects</h2>
        <span className="activity-hint">
          {compatibleCount} can open · {projects.length - compatibleCount} cannot open
        </span>
      </div>
      <div className="activity-project-tools">
        <label className="activity-field">
          <span>Search projects</span>
          <input
            id={`${id}-search`}
            type="search"
            value={query}
            placeholder="Title or project ID"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="activity-field">
          <span>Project filter</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as ProjectFilter)}>
            <option value="all">All projects</option>
            <option value="compatible">Can open</option>
            <option value="unsupported">Cannot open (older version)</option>
          </select>
        </label>
      </div>
      {submitting && (
        <output className="activity-pending" aria-live="polite">
          {pendingLabel}
        </output>
      )}
      <ul className="activity-project-list" aria-label="Saved projects">
        {visible.map((project) => (
          <li
            key={project.id}
            className="activity-project-entry"
            data-current={project.id === currentId}
            data-compatible={project.compatible}
          >
            <div className="activity-project-heading">
              <strong>{project.title}</strong>
              {project.id === currentId && <span className="activity-badge current">Current</span>}
              {!project.compatible && <span className="activity-badge failed">Cannot open</span>}
            </div>
            <div className="activity-project-meta">
              {project.compatible && (
                <span>
                  {project.clipCount} {project.clipCount === 1 ? 'clip' : 'clips'} ·{' '}
                  {durationLabel(framesToSeconds(project.duration))}
                </span>
              )}
              <span>
                Updated{' '}
                {Number.isFinite(Date.parse(project.updatedAt)) ? (
                  <time dateTime={project.updatedAt}>
                    {new Date(project.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </time>
                ) : (
                  'date unavailable'
                )}
              </span>
            </div>
            {!project.compatible && (
              <p className="activity-project-reason">
                {project.error || 'Saved by an older PasCap version or invalid. It is kept unchanged.'}
              </p>
            )}
            <div className="activity-project-actions">
              <button
                className="secondary-button"
                aria-label={`Open ${project.title}`}
                disabled={submitting || !project.compatible}
                onClick={() => {
                  void openProject(project);
                }}
              >
                {pending?.kind === 'open' && pending.id === project.id ? 'Opening…' : 'Open'}
              </button>
              <button
                className="secondary-button project-delete"
                aria-label={`Delete ${project.title}`}
                disabled={submitting}
                onClick={(event) => {
                  deleteTrigger.current = event.currentTarget;
                  setLocalError('');
                  setDeleting(project);
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!visible.length && !submitting && (
        <div className="activity-empty">
          <strong>{!projects.length ? 'No projects yet' : 'No matching projects'}</strong>
          <p>
            {!projects.length
              ? 'Create an empty project below, then add prepared recordings from the media library.'
              : 'Try another title or show all projects in the filter.'}
          </p>
          {projects.length > 0 && (
            <button
              className="secondary-button"
              onClick={() => {
                setQuery('');
                setFilter('all');
              }}
            >
              Clear search and filters
            </button>
          )}
        </div>
      )}
      <form
        className="activity-new-project"
        aria-labelledby={`${id}-new`}
        onSubmit={(event) => {
          event.preventDefault();
          void createProject();
        }}
      >
        <h3 id={`${id}-new`}>New project</h3>
        <div className="activity-new-project-fields">
          <label className="activity-field">
            <span>New project title</span>
            <input
              placeholder="Untitled project"
              value={title}
              maxLength={200}
              disabled={submitting}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button type="submit" className="primary-button" disabled={submitting || !title.trim()}>
            Create project
          </button>
        </div>
      </form>
      {deleting && (
        <Modal
          className="project-delete-dialog"
          labelledBy={`${id}-delete`}
          describedBy={`${id}-delete-help`}
          busy={submitting}
          error={error || localError}
          restoreFocusTo={deleteTrigger}
          onClose={() => {
            setDeleting(null);
            setLocalError('');
          }}
          footer={
            <>
              <button
                className="secondary-button"
                disabled={submitting}
                onClick={() => {
                  setDeleting(null);
                  setLocalError('');
                }}
              >
                Cancel
              </button>
              <button
                className="primary-button project-delete"
                disabled={submitting}
                onClick={() => {
                  void deleteProject();
                }}
              >
                {pending?.kind === 'delete' ? 'Deleting…' : 'Delete project'}
              </button>
            </>
          }
        >
          <h2 id={`${id}-delete`}>Delete project?</h2>
          <p id={`${id}-delete-help`}>
            Permanently delete <strong>{deleting.title}</strong> and its saved edit? This cannot be undone. Original
            recordings, prepared media and exported videos are kept.
            {deleting.id === currentId && ' The current project will close.'}
          </p>
        </Modal>
      )}
    </Modal>
  );
}
