import { ZodError } from 'zod';
import { applyCommand, type EditCommand } from '../../shared/commands.js';
import type { ProjectDocument } from '../../shared/model.js';
import type { edit } from '../../shared/operations/edit.js';
import { calculateLayout } from '../../shared/timeline.js';
import { formatTimecode } from '../../shared/timing.js';
import { errorMessage, ServiceError } from '../errors.js';
import { assertProjectSources } from '../project-sources.js';
import type { OperationRunner } from './context.js';

function reason(error: unknown): string {
  return error instanceof ZodError
    ? error.issues.map((issue) => `${issue.path.join('.') || 'project'}: ${issue.message}`).join('; ')
    : errorMessage(error);
}

/** Applies commands in order; the first rejected one fails the whole batch with its reason. */
export function applyBatch(
  document: ProjectDocument,
  commands: readonly EditCommand[],
  consequence: string,
): ProjectDocument {
  return commands.reduce((current, command, index) => {
    try {
      return applyCommand(current, command);
    } catch (error) {
      throw new ServiceError(
        `Command ${index + 1} of ${commands.length} (${command.type}) was rejected: ${reason(error)} ${consequence}`,
        422,
      );
    }
  }, document);
}

export const runEdit: OperationRunner<typeof edit> = async (
  { projects, library, audio },
  { projectId, expectedRevision, commands },
) => {
  const current = await projects.load(projectId);
  if (current.revision !== expectedRevision)
    throw new ServiceError(
      `Stale edit: the project is at revision ${current.revision}, not ${expectedRevision}. Read it again before editing.`,
      409,
    );
  const next = applyBatch(current, commands, 'Nothing was saved.');
  await assertProjectSources(next, library, audio);
  const saved = await projects.save(next, expectedRevision);
  const duration = calculateLayout(saved).duration;
  return { revision: saved.revision, duration: { frames: duration, timecode: formatTimecode(duration) } };
};
