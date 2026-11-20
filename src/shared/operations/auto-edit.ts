import { z } from 'zod';
import { briefSchema } from '../assistant-session.js';
import { autoEditChoicesSchema } from '../auto-edit/options.js';
import { autoEditReportSchema } from '../auto-edit/report.js';
import { AUTO_EDIT_TARGETS, autoEditResultSchema } from '../auto-edit/result.js';
import { editCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { jobSchema } from '../media.js';
import { frameSchema, idSchema } from '../model.js';
import { editChangesSchema } from './edit.js';
import { defineOperation, revisionReadSchema } from './spec.js';
import { durationSchema } from './timecode.js';

const projectId = described(idSchema, 'ID of the saved project.');
const choiceFields = autoEditChoicesSchema.shape;

export const autoEdit = defineOperation({
  name: 'auto_edit',
  title: 'Auto edit',
  description:
    "Build a whole first cut without pictures of your own, in a minute or two: every steady range inside the kept ranges (camera motion analyzed), alike takes of one subject grouped so one is kept, shots ordered like the flight with an establishing shot first, cut on downbeats and strong hits with lengths following the music's sections, dissolves in quiet sections and fades, then Auto per clip and a match to the brief's style or the most representative clip. The cut goes on a new Ripple track named Auto edit above the others, which it hides, with the adjustments turned off; music named by the brief but not on the timeline is placed, and music longer than the cut ends with it. Returns a report: each clip with its recording, range, section and reasons, alike takes left out, alignment and notes. With apply (inside your session, expectedRevision) it saves the cut as one edit; without, it returns the commands, often more than edit takes at once. Then judge it with one timeline_sheet and replace the shots you disagree with; variant 1, 2… gives the next-best alternatives.",
  input: z
    .object({
      projectId,
      brief: described(
        briefSchema.optional(),
        "The brief: music, target length, steady-range limits, most clips and style; omitted uses your session's brief.",
      ),
      ...choiceFields,
      apply: described(z.boolean().default(false), 'True saves the cut as one edit; false only proposes it.'),
      expectedRevision: described(
        frameSchema.optional(),
        'Revision you last read, from describe_project; required with apply.',
      ),
    })
    .strict(),
  output: z
    .object({
      revision: described(revisionReadSchema, 'Saved revision the cut was built on, before any apply.'),
      report: autoEditReportSchema,
      commands: described(z.array(editCommandSchema), 'The commands building the cut, in order; empty once applied.'),
      applied: described(
        z.object({ revision: frameSchema, duration: durationSchema, changes: editChangesSchema }).strict().nullable(),
        'With apply: the saved revision and what changed; null for a proposal.',
      ),
    })
    .strict(),
  access: 'write',
  audience: ['assistant'],
});

export const autoEditStart = defineOperation({
  name: 'auto_edit_start',
  title: 'Start auto edit',
  description:
    'Start an auto edit job of a project: into copy saves the cut as a new project and leaves this one unchanged; into project keeps the result for the editor to apply to the project as one Undo step. Activity shows its progress; auto_edit_result reads it once done.',
  input: z
    .object({
      projectId,
      expectedRevision: described(frameSchema, 'The saved revision the editor shows.'),
      into: described(
        z.enum(AUTO_EDIT_TARGETS),
        'copy: a new project holding the cut; project: the cut kept for the editor to apply to this project.',
      ),
      brief: described(briefSchema, "The user's brief: music, target length, steady-range limits, most clips, style."),
      choices: described(autoEditChoicesSchema, 'Pace, order, transitions, grade and variant.'),
    })
    .strict(),
  output: z.object({ job: jobSchema }).strict(),
  access: 'read',
  audience: ['editor'],
});

export const autoEditResult = defineOperation({
  name: 'auto_edit_result',
  title: 'Read auto edit result',
  description:
    'The result of a finished auto edit job: the project holding the cut, its report and, into project, the cut.',
  input: z.object({ resultId: described(idSchema, 'The auto edit job ID.') }).strict(),
  output: z.object({ result: autoEditResultSchema }).strict(),
  access: 'read',
  audience: ['editor'],
});
