import { randomUUID } from 'node:crypto';
import { briefSchema, type Brief } from '../../shared/assistant-session.js';
import type { autoEdit, autoEditResult, autoEditStart } from '../../shared/operations/auto-edit.js';
import { autoEditSummary, buildAutoEdit } from '../auto-edit.js';
import { ServiceError } from '../errors.js';
import { assertProjectSources } from '../project-sources.js';
import type { OperationRunner, ServiceContext } from './context.js';
import { runEdit } from './edit.js';

const COPY_SUFFIX = ' · Auto edit';

/** The brief asked for, else the active session's, else an empty one. */
async function briefFor(context: ServiceContext, projectId: string, asked: Brief | undefined): Promise<Brief> {
  if (asked) return asked;
  const session = await context.sessions.current(projectId);
  return session?.endedAt === null ? session.brief : briefSchema.parse({});
}

export const runAutoEdit: OperationRunner<typeof autoEdit> = async (context, input) => {
  const { projectId, apply, expectedRevision, pace, order, transitions, grade, variant } = input;
  if (apply && expectedRevision === undefined)
    throw new ServiceError('Applying the auto edit needs expectedRevision, from describe_project.', 422);
  const project = await context.projects.load(projectId);
  if (apply && project.revision !== expectedRevision)
    throw new ServiceError(
      `Stale edit: the project is at revision ${project.revision}, not ${expectedRevision}. Read it again before editing.`,
      409,
    );
  const brief = await briefFor(context, projectId, input.brief);
  const outcome = await buildAutoEdit(
    context,
    project,
    { brief, choices: { pace, order, transitions, grade, variant } },
    'track',
  );
  const applied = apply
    ? await runEdit(context, { projectId, expectedRevision: expectedRevision!, commands: outcome.commands })
    : null;
  return { revision: project.revision, report: outcome.report, commands: applied ? [] : outcome.commands, applied };
};

export const runAutoEditStart: OperationRunner<typeof autoEditStart> = async (context, input) => {
  const project = await context.projects.load(input.projectId);
  if (project.revision !== input.expectedRevision)
    throw new ServiceError(
      `The project is at revision ${project.revision}, not ${input.expectedRevision}: wait until it is saved and try again.`,
      409,
    );
  const label = `Auto edit of ${project.title}`.slice(0, 200);
  const job = context.jobs.submit('auto-edit', label, async (job) => {
    const outcome = await buildAutoEdit(
      context,
      project,
      { brief: input.brief, choices: input.choices },
      'replace',
      job.update,
      job.signal,
    );
    let projectId = project.id;
    if (input.into === 'copy') {
      const title = `${project.title.slice(0, 200 - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
      const copy = { ...outcome.document, id: randomUUID(), title, revision: 0 };
      await assertProjectSources(copy, context.library, context.audio, context.imageLibrary);
      projectId = (await context.projects.save(copy, 0)).id;
    }
    await context.autoEdits.save({
      id: job.id,
      createdAt: new Date().toISOString(),
      sourceProjectId: project.id,
      sourceRevision: project.revision,
      into: input.into,
      projectId,
      brief: input.brief,
      choices: input.choices,
      report: outcome.report,
      document: input.into === 'project' ? outcome.document : null,
    });
    context.jobs.setOutput(job.id, `/?project=${encodeURIComponent(projectId)}`);
    return autoEditSummary(outcome.report);
  });
  return { job };
};

export const runAutoEditResult: OperationRunner<typeof autoEditResult> = async ({ autoEdits }, { resultId }) => ({
  result: await autoEdits.get(resultId),
});
