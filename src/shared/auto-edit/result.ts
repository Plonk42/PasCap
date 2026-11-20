import { z } from 'zod';
import { briefSchema } from '../assistant-session.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { autoEditChoicesSchema } from './options.js';
import { autoEditReportSchema } from './report.js';

/** What an editor auto edit makes: a copy of the project, or a new version of the project for the editor to take. */
export const AUTO_EDIT_TARGETS = ['copy', 'project'] as const;

/** A finished editor auto edit, kept by the service for the editor to open and show. */
export const autoEditResultSchema = z
  .object({
    id: described(idSchema, 'The job that made it.'),
    createdAt: z.string(),
    sourceProjectId: idSchema,
    sourceRevision: frameSchema,
    into: z.enum(AUTO_EDIT_TARGETS),
    projectId: described(idSchema, 'The project holding the cut: the new copy, or the project itself.'),
    brief: briefSchema,
    choices: autoEditChoicesSchema,
    report: autoEditReportSchema,
    document: described(
      z.unknown().nullable(),
      'With into project: the project with the cut, which the editor applies as one Undo step; null for a copy.',
    ),
  })
  .strict();
export type AutoEditResult = z.infer<typeof autoEditResultSchema>;
