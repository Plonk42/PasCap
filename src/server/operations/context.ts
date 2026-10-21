import type { z } from 'zod';
import type { Operation, OperationName, OperationNamed } from '../../shared/operations/index.js';
import type { AssistantConnection } from '../assistant-connection.js';
import type { AudioLibrary } from '../audio.js';
import type { AssistantImageBudget } from '../config.js';
import type { JobQueue } from '../jobs.js';
import type { MediaLibrary } from '../library.js';
import type { AssistantSessions } from '../sessions.js';
import type { StillRenderer } from '../stills.js';
import type { ProjectStore, ProjectWriter } from '../storage.js';

/** Who calls an operation: the editor through its HTTP route, or an assistant through MCP. */
export type Caller = 'editor' | 'assistant';

/** What operations may use of the service. */
export interface ServiceContext {
  caller: Caller;
  projects: Pick<ProjectStore, 'list' | 'load' | 'save'>;
  sessions: Pick<
    AssistantSessions,
    | 'current'
    | 'expiresAt'
    | 'start'
    | 'end'
    | 'checkpoint'
    | 'checkpoints'
    | 'restore'
    | 'copy'
    | 'recordEdit'
    | 'touch'
  >;
  library: Pick<MediaLibrary, 'get' | 'motion' | 'motionJob'>;
  audio: Pick<AudioLibrary, 'get' | 'analysis' | 'analysisJob'>;
  jobs: Pick<JobQueue, 'list'>;
  stills: Pick<StillRenderer, 'still' | 'timelineSheet' | 'recordingSheet' | 'analysisFrames' | 'lumaFrames'>;
  assistant: Pick<AssistantConnection, 'url' | 'tokenFile' | 'lastClient' | 'seen'>;
  images: AssistantImageBudget;
}

/** The service parts every surface shares; each surface adds its caller. */
export type ServiceResources = Omit<ServiceContext, 'caller'>;

export function writerOf(caller: Caller): ProjectWriter {
  return caller === 'assistant' ? 'assistant' : 'user';
}

export type OperationRunner<S extends Operation> = (
  context: ServiceContext,
  input: z.output<S['input']>,
) => Promise<z.input<S['output']>>;

/** One implementation per operation; a missing one fails type checking. */
export type OperationRunners = { [N in OperationName]: OperationRunner<OperationNamed<N>> };
