import { z } from 'zod';
import { briefSchema, checkpointSummarySchema, MAX_SESSION_NOTES, sessionSchema } from '../assistant-session.js';
import { editCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { MAX_EDIT_COMMANDS } from './edit.js';
import { defineOperation } from './spec.js';
import { durationSchema } from './timecode.js';

const projectId = described(idSchema, 'ID of the saved project.');
const expectedRevision = described(frameSchema, 'Revision you last read, from describe_project.');

export const sessionViewSchema = sessionSchema
  .extend({
    active: described(z.boolean(), 'True while the session holds the write lease.'),
    expiresAt: described(z.string().nullable(), 'When the lease ends without activity; null once ended.'),
  })
  .strict();

export const sessionStart = defineOperation({
  name: 'session_start',
  description:
    "Take the project's write lease for an assistant session, after checkpointing it, so the editor follows your edits read-only until the user takes over or you call session_end. Required before edit, checkpoint_restore or any write. Pass the user's brief from the conversation. Refused while another session is active, when the revision is stale or while a recording of the project is not prepared. The lease ends after some minutes without any call on the project.",
  input: z
    .object({
      projectId,
      expectedRevision,
      brief: described(
        briefSchema.default(briefSchema.parse({})),
        "The user's brief, from what they asked; every field is optional.",
      ),
    })
    .strict(),
  output: sessionViewSchema,
  access: 'write',
  audience: ['editor', 'assistant'],
});

export const sessionStatus = defineOperation({
  name: 'session_status',
  description:
    "Read the project's latest assistant session (null if none): whether it is active, its brief, its edit log and the notes it ended with, and the project's checkpoints, newest first.",
  input: z.object({ projectId }).strict(),
  output: z.object({ session: sessionViewSchema.nullable(), checkpoints: z.array(checkpointSummarySchema) }).strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});

export const sessionEnd = defineOperation({
  name: 'session_end',
  description:
    'End the active assistant session and give the project back to the user, with notes: what you built, the choices you made and anything the user should look at. From the editor it is the Take over action.',
  input: z
    .object({
      projectId,
      notes: described(z.string().max(MAX_SESSION_NOTES).nullable().default(null), 'Notes for the user.'),
    })
    .strict(),
  output: z.object({ session: sessionViewSchema.nullable() }).strict(),
  access: 'write',
  audience: ['editor', 'assistant'],
});

export const checkpoint = defineOperation({
  name: 'checkpoint',
  description:
    'Keep a copy of the project as it is saved now, to restore later with checkpoint_restore; only the most recent checkpoints of a project are kept.',
  input: z
    .object({ projectId, label: described(z.string().max(200).nullable().default(null), 'Short name for it.') })
    .strict(),
  output: checkpointSummarySchema,
  access: 'write',
  audience: ['editor', 'assistant'],
});

export const checkpointRestore = defineOperation({
  name: 'checkpoint_restore',
  description:
    'Replace the project with one of its checkpoints, as one new revision; the current state is checkpointed first, so it can be restored in turn.',
  input: z
    .object({ projectId, expectedRevision, checkpointId: described(z.string(), 'ID from session_status.') })
    .strict(),
  output: z.object({ revision: frameSchema, duration: durationSchema }).strict(),
  access: 'write',
  audience: ['editor', 'assistant'],
});

export const previewEdits = defineOperation({
  name: 'preview_edits',
  description: `Try up to ${MAX_EDIT_COMMANDS} edit commands against the saved project without saving: the same checks as edit, including the session rules, and the resulting duration and clip count, or the first rejected command's reason.`,
  input: z
    .object({
      projectId,
      commands: z
        .array(editCommandSchema)
        .min(1)
        .max(MAX_EDIT_COMMANDS)
        .meta({ description: 'Commands applied in order.' }),
    })
    .strict(),
  output: z
    .object({
      revision: described(frameSchema, 'The saved revision the commands were tried against.'),
      duration: durationSchema,
      clipCount: z.number().int().nonnegative(),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});
