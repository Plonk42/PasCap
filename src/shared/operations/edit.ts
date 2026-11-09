import { z } from 'zod';
import { assistantEditCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import {
  adjustmentDescriptionSchema,
  clipDescriptionSchema,
  musicTrackDescriptionSchema,
  recordingDescriptionSchema,
  videoTrackDescriptionSchema,
} from './describe-project.js';
import { defineOperation } from './spec.js';
import { durationSchema } from './timecode.js';

export const MAX_EDIT_COMMANDS = 64;

const removed = (what: string) => described(z.array(idSchema).optional(), `IDs of the ${what} the batch removed.`);

/** What a batch changed, in describe_project's shape; a part left out did not change. */
export const editChangesSchema = z
  .object({
    videoTracks: described(
      z.array(videoTrackDescriptionSchema.omit({ clips: true })).optional(),
      'Video tracks added or whose settings or transitions changed, without their clips.',
    ),
    removedVideoTracks: removed('video tracks'),
    clips: described(
      z.array(clipDescriptionSchema.extend({ layerId: idSchema })).optional(),
      'Clips added or changed in any way, with their track, in timeline order: those a Ripple track moved too.',
    ),
    removedClips: removed('clips'),
    adjustments: described(z.array(adjustmentDescriptionSchema).optional(), 'Adjustments added or changed.'),
    removedAdjustments: removed('adjustments'),
    musicTracks: described(z.array(musicTrackDescriptionSchema).optional(), 'Music tracks added or changed.'),
    removedMusicTracks: removed('music tracks'),
    recordings: described(z.array(recordingDescriptionSchema).optional(), 'Recordings whose kept ranges changed.'),
    bookmarks: described(z.array(frameSchema).optional(), 'Every bookmark, when they changed.'),
  })
  .strict();
export type EditChanges = z.infer<typeof editChangesSchema>;

export const edit = defineOperation({
  name: 'edit',
  title: 'Edit project',
  description: `Apply up to ${MAX_EDIT_COMMANDS} edit commands to a saved project, in order, as one step: either every command applies and the project is saved once with the next revision, or nothing changes and the first rejected command's reason is returned. A stale expectedRevision is rejected; read the project again first. Returns the new revision, the duration and what changed, as describe_project gives it, so no read is needed to follow the batch.`,
  input: z
    .object({
      projectId: idSchema.meta({ description: 'ID of the saved project.' }),
      expectedRevision: frameSchema.meta({
        description: 'Revision the commands were written against, from describe_project.',
      }),
      commands: z
        .array(assistantEditCommandSchema)
        .min(1)
        .max(MAX_EDIT_COMMANDS)
        .meta({ description: 'Commands applied in order; each sees the result of the previous one.' }),
    })
    .strict(),
  output: z
    .object({
      revision: frameSchema.meta({ description: 'The new saved revision.' }),
      duration: durationSchema,
      changes: editChangesSchema,
    })
    .strict(),
  access: 'write',
  audience: ['editor', 'assistant'],
});
