import type { z } from 'zod';
import type { Operation, OperationName, OperationNamed } from '../../shared/operations/index.js';
import type { AudioLibrary } from '../audio.js';
import type { MediaLibrary } from '../library.js';
import type { ProjectStore } from '../storage.js';

/** What operations may use of the service. */
export interface ServiceContext {
  projects: Pick<ProjectStore, 'load' | 'save'>;
  library: Pick<MediaLibrary, 'get'>;
  audio: Pick<AudioLibrary, 'get'>;
}

export type OperationRunner<S extends Operation> = (
  context: ServiceContext,
  input: z.output<S['input']>,
) => Promise<z.input<S['output']>>;

/** One implementation per operation; a missing one fails type checking. */
export type OperationRunners = { [N in OperationName]: OperationRunner<OperationNamed<N>> };
