import { ZodError } from 'zod';
import { sessionViolation } from '../../shared/assistant-session.js';
import { applyCommand, type EditCommand } from '../../shared/commands.js';
import { editedFrame } from '../../shared/edited-frame.js';
import type { ProjectDocument } from '../../shared/model.js';
import type { ProjectDescription } from '../../shared/operations/describe-project.js';
import type { edit, EditChanges } from '../../shared/operations/edit.js';
import { durationOf } from '../../shared/operations/timecode.js';
import { calculateLayout } from '../../shared/timeline.js';
import { errorMessage, ServiceError } from '../errors.js';
import { assertProjectSources } from '../project-sources.js';
import type { OperationRunner, ServiceContext } from './context.js';
import { writerOf } from './context.js';
import { describeDocument } from './describe-project.js';

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

export const runEdit: OperationRunner<typeof edit> = async (context, { projectId, expectedRevision, commands }) => {
  const current = await context.projects.load(projectId);
  if (current.revision !== expectedRevision)
    throw new ServiceError(
      `Stale edit: the project is at revision ${current.revision}, not ${expectedRevision}. Read it again before editing.`,
      409,
    );
  const next = await prepareBatch(context, current, commands, 'Nothing was saved.');
  const saved = await context.projects.save(next, expectedRevision, writerOf(context.caller));
  if (context.caller === 'assistant')
    await context.sessions.recordEdit(
      projectId,
      saved.revision,
      commands.map((command) => command.type),
      editedFrame(current, saved),
    );
  return {
    revision: saved.revision,
    duration: durationOf(calculateLayout(saved).duration),
    changes: editChanges(describeDocument(current, context), describeDocument(saved, context)),
  };
};

/** The items added or changed (compared as described) and the IDs of those removed. */
function byId<T extends { id: string }>(before: readonly T[], after: readonly T[]) {
  const previous = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
  const kept = new Set(after.map((item) => item.id));
  return {
    changed: after.filter((item) => previous.get(item.id) !== JSON.stringify(item)),
    removed: before.filter((item) => !kept.has(item.id)).map((item) => item.id),
  };
}

const unlessEmpty = <K extends string, T>(key: K, list: readonly T[]) =>
  (list.length ? { [key]: list } : {}) as Partial<Record<K, T[]>>;

export function editChanges(before: ProjectDescription, after: ProjectDescription): EditChanges {
  const tracks = (description: ProjectDescription) =>
    (description.videoTracks ?? []).map(({ clips: _clips, ...track }) => track);
  const clips = (description: ProjectDescription) =>
    (description.videoTracks ?? []).flatMap((track) => track.clips.map((clip) => ({ ...clip, layerId: track.id })));
  const videoTracks = byId(tracks(before), tracks(after));
  const placed = byId(clips(before), clips(after));
  const adjustments = byId(before.adjustments ?? [], after.adjustments ?? []);
  const musicTracks = byId(before.musicTracks ?? [], after.musicTracks ?? []);
  return {
    ...unlessEmpty('videoTracks', videoTracks.changed),
    ...unlessEmpty('removedVideoTracks', videoTracks.removed),
    ...unlessEmpty('clips', placed.changed),
    ...unlessEmpty('removedClips', placed.removed),
    ...unlessEmpty('adjustments', adjustments.changed),
    ...unlessEmpty('removedAdjustments', adjustments.removed),
    ...unlessEmpty('musicTracks', musicTracks.changed),
    ...unlessEmpty('removedMusicTracks', musicTracks.removed),
    ...unlessEmpty('recordings', byId(before.recordings ?? [], after.recordings ?? []).changed),
    ...(JSON.stringify(before.bookmarks) !== JSON.stringify(after.bookmarks) && { bookmarks: after.bookmarks }),
  };
}

/** The batch applied in memory with every check of a save, plus the session rules for an assistant. */
export async function prepareBatch(
  { caller, library, audio }: ServiceContext,
  current: ProjectDocument,
  commands: readonly EditCommand[],
  consequence: string,
): Promise<ProjectDocument> {
  const next = applyBatch(current, commands, consequence);
  if (caller === 'assistant') {
    const name = (mediaId: string) => {
      try {
        return library.get(mediaId).name;
      } catch {
        return mediaId;
      }
    };
    const violation = sessionViolation(current, next, name);
    if (violation) throw new ServiceError(`${violation} ${consequence}`, 422);
  }
  await assertProjectSources(next, library, audio);
  return next;
}
