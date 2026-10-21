import { z } from 'zod';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { defineOperation } from './spec.js';
import { durationSchema } from './timecode.js';

export const listProjects = defineOperation({
  name: 'list_projects',
  description:
    'List the saved projects, most recently saved first, with their title, revision, number of clips and duration. Use it to find the ID of the project the user means; ask when several could match. A project that cannot be opened carries the reason.',
  input: z.object({}).strict(),
  output: z
    .object({
      projects: z.array(
        z
          .object({
            id: idSchema,
            title: z.string(),
            revision: frameSchema,
            clipCount: z.number().int().nonnegative(),
            duration: durationSchema,
            updatedAt: described(z.string(), 'When the project was last saved (ISO 8601).'),
            error: described(z.string().nullable(), 'Why the project cannot be opened; null when it can.'),
          })
          .strict(),
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});
