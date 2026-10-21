import { z } from 'zod';
import { editCommandSchema } from '../command-schema.js';
import { frameSchema, idSchema } from '../model.js';
import { defineOperation } from './spec.js';
import { durationSchema } from './timecode.js';

export const MAX_EDIT_COMMANDS = 64;

export const edit = defineOperation({
  name: 'edit',
  description: `Apply up to ${MAX_EDIT_COMMANDS} edit commands to a saved project, in order, as one step: either every command applies and the project is saved once with the next revision, or nothing changes and the first rejected command's reason is returned. A stale expectedRevision is rejected; read the project again first.`,
  input: z
    .object({
      projectId: idSchema.meta({ description: 'ID of the saved project.' }),
      expectedRevision: frameSchema.meta({
        description: 'Revision the commands were written against, from describe_project.',
      }),
      commands: z
        .array(editCommandSchema)
        .min(1)
        .max(MAX_EDIT_COMMANDS)
        .meta({ description: 'Commands applied in order; each sees the result of the previous one.' }),
    })
    .strict(),
  output: z
    .object({
      revision: frameSchema.meta({ description: 'The new saved revision.' }),
      duration: durationSchema,
    })
    .strict(),
  access: 'write',
  audience: ['editor', 'assistant'],
});
