import type { ProjectDocument } from '../../shared/model.js';
import type {
  checkpoint,
  checkpointRestore,
  previewEdits,
  sessionEnd,
  sessionStart,
  sessionStatus,
} from '../../shared/operations/sessions.js';
import { durationOf } from '../../shared/operations/timecode.js';
import { calculateLayout } from '../../shared/timeline.js';
import type { AssistantSession } from '../../shared/assistant-session.js';
import { assertProjectSources } from '../project-sources.js';
import { writerOf, type OperationRunner, type ServiceContext } from './context.js';
import { prepareBatch } from './edit.js';

function view(sessions: ServiceContext['sessions'], session: AssistantSession) {
  return { ...session, active: session.endedAt === null, expiresAt: sessions.expiresAt(session) };
}

/** A session needs every recording of the project prepared, so its clips can be previewed and checked. */
function unreadyReason(library: ServiceContext['library'], document: ProjectDocument): string | null {
  const unready = document.media.videoIds.filter((id) => {
    try {
      return library.get(id).status !== 'ready';
    } catch {
      return true;
    }
  });
  return unready.length
    ? `${unready.length} recording(s) of the project are not prepared; prepare them in the editor first.`
    : null;
}

export const runSessionStart: OperationRunner<typeof sessionStart> = async (
  { caller, sessions, library },
  { projectId, expectedRevision, brief },
) => {
  const session = await sessions.start(
    projectId,
    expectedRevision,
    brief,
    caller === 'assistant' ? 'assistant' : 'user',
    (document) => unreadyReason(library, document),
  );
  return view(sessions, session);
};

export const runSessionStatus: OperationRunner<typeof sessionStatus> = async ({ sessions }, { projectId }) => {
  const session = await sessions.current(projectId);
  return { session: session && view(sessions, session), checkpoints: await sessions.checkpoints(projectId) };
};

export const runSessionEnd: OperationRunner<typeof sessionEnd> = async ({ caller, sessions }, { projectId, notes }) => {
  const session = await sessions.end(projectId, caller === 'assistant' ? 'assistant' : 'user', notes);
  return { session: session && view(sessions, session) };
};

export const runCheckpoint: OperationRunner<typeof checkpoint> = async ({ sessions }, { projectId, label }) =>
  sessions.checkpoint(projectId, label);

export const runCheckpointRestore: OperationRunner<typeof checkpointRestore> = async (
  { caller, sessions, library, audio },
  { projectId, checkpointId, expectedRevision },
) => {
  const restored = await sessions.restore(projectId, checkpointId, expectedRevision, writerOf(caller), (document) =>
    assertProjectSources(document, library, audio),
  );
  return { revision: restored.revision, duration: durationOf(calculateLayout(restored).duration) };
};

export const runPreviewEdits: OperationRunner<typeof previewEdits> = async (context, { projectId, commands }) => {
  const current = await context.projects.load(projectId);
  const next = await prepareBatch(context, current, commands, 'Nothing would be saved.');
  return {
    revision: current.revision,
    duration: durationOf(calculateLayout(next).duration),
    clipCount: next.clips.length,
  };
};
