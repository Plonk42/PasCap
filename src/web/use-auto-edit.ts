import { useCallback, useEffect, useRef, useState } from 'react';
import type { Brief } from '../shared/assistant-session.js';
import type { AutoEditChoices } from '../shared/auto-edit/options.js';
import type { AutoEditResult } from '../shared/auto-edit/result.js';
import type { MediaJob } from '../shared/media.js';
import { projectSchema, type ProjectDocument } from '../shared/model.js';
import { autoEditResultOf, rememberAutoEditResult } from './auto-edit.js';
import { callOperation } from './operations.js';

type Outcome<T> = { ok: true; value: T } | { ok: false };

/** What the auto edit flow needs of the editor; read afresh on every call. */
export interface AutoEditEditor {
  project: ProjectDocument | null;
  jobs: readonly MediaJob[];
  /** The project open now, even before the next render. */
  openProjectId: () => string | null;
  /** The saved revision, after saving pending changes; throws when they cannot be saved. */
  saved: () => Promise<number>;
  act: <T>(action: () => Promise<T>) => Promise<Outcome<T>>;
  receiveJob: (job: MediaJob) => void;
  refreshJobs: () => void;
  /** Opens a saved project, saving the current one first. */
  open: (projectId: string) => Promise<void>;
  /**
   * Replaces the open project's content as one Undo step, keeping its ID and title; false when the editor refuses
   * edits.
   */
  replace: (document: ProjectDocument) => boolean;
}

export interface AutoEditFlow {
  /** The auto edit the Hand off dialog started, as Activity last saw it. */
  job: MediaJob | null;
  start: (brief: Brief, choices: AutoEditChoices) => Promise<boolean>;
  /** Opens a finished auto edit: its copy, or its cut applied to the project; then shows its report. */
  open: (jobId: string) => Promise<void>;
  /** The report shown, or null. */
  result: AutoEditResult | null;
  /** The open project has a report to show. */
  hasReport: boolean;
  showReport: () => Promise<void>;
  closeReport: () => void;
  /** The Try again job, as Activity last saw it. */
  retryJob: MediaJob | null;
  tryAgain: () => Promise<void>;
}

/** Auto edit in the editor: the job from Hand off, opening its result, the report and Try again. */
export function useAutoEdit(editor: AutoEditEditor): AutoEditFlow {
  const latest = useRef(editor);
  latest.current = editor;
  const [jobId, setJobId] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [result, setResult] = useState<AutoEditResult | null>(null);
  const [pointer, setPointer] = useState<string | null>(null);
  const projectId = editor.project?.id ?? null;
  useEffect(() => {
    setPointer(projectId === null ? null : autoEditResultOf(projectId));
  }, [projectId]);
  const job = editor.jobs.find((item) => item.id === jobId) ?? null;
  const retryJob = editor.jobs.find((item) => item.id === retryId) ?? null;

  const start = useCallback(async (brief: Brief, choices: AutoEditChoices): Promise<boolean> => {
    const { project, act, receiveJob, refreshJobs, saved } = latest.current;
    if (!project) return false;
    const outcome = await act(async () => {
      const expectedRevision = await saved();
      return callOperation('auto_edit_start', {
        projectId: project.id,
        expectedRevision,
        into: 'copy',
        brief,
        choices,
      });
    });
    if (!outcome.ok) return false;
    receiveJob(outcome.value.job);
    setJobId(outcome.value.job.id);
    refreshJobs();
    return true;
  }, []);

  /** Shows a result's report, applying a cut kept for the open project first. */
  const adopt = useCallback(async (resultId: string, apply: boolean): Promise<void> => {
    const { act } = latest.current;
    await act(async () => {
      const { result: found } = await callOperation('auto_edit_result', { resultId });
      if (latest.current.openProjectId() !== found.projectId) await latest.current.open(found.projectId);
      if (apply && found.document !== null && !latest.current.replace(projectSchema.parse(found.document))) return;
      rememberAutoEditResult(found.projectId, resultId);
      setPointer(resultId);
      setResult(found);
    });
  }, []);

  const open = useCallback((id: string) => adopt(id, true), [adopt]);
  const showReport = useCallback(async () => {
    if (pointer) await adopt(pointer, false);
  }, [adopt, pointer]);

  const tryAgain = useCallback(async (): Promise<void> => {
    const { project, act, receiveJob, refreshJobs, saved } = latest.current;
    if (!project || !result) return;
    const outcome = await act(async () => {
      const expectedRevision = await saved();
      return callOperation('auto_edit_start', {
        projectId: project.id,
        expectedRevision,
        into: 'project',
        brief: result.brief,
        choices: { ...result.choices, variant: Math.min(99, result.choices.variant + 1) },
      });
    });
    if (!outcome.ok) return;
    receiveJob(outcome.value.job);
    setRetryId(outcome.value.job.id);
    refreshJobs();
  }, [result]);

  // A Try again that finishes while its report is open replaces the cut at once.
  const retryState = retryJob?.state;
  useEffect(() => {
    if (retryState !== 'completed' || retryId === null) return;
    setRetryId(null);
    void adopt(retryId, true);
  }, [retryState, retryId, adopt]);

  return {
    job,
    start,
    open,
    result,
    hasReport: pointer !== null,
    showReport,
    closeReport: useCallback(() => setResult(null), []),
    retryJob,
    tryAgain,
  };
}
