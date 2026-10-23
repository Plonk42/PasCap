import { z } from 'zod';
import { referencedEditCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { MAX_EDIT_COMMANDS } from './edit.js';
import { defineOperation, revisionReadSchema } from './spec.js';
import { timecodeSchema } from './timecode.js';

/** Hard limits; the service's image budget sets the actual ones, at most these. */
export const MAX_STILL_WIDTH = 1280;
export const MAX_SHEET_FRAMES = 24;

export const imageSchema = described(
  z
    .object({
      mimeType: z.literal('image/jpeg'),
      data: described(z.string(), 'The JPEG, base64-encoded.'),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict(),
  'The picture.',
);
const projectId = described(idSchema, 'ID of the saved project.');
const commands = described(
  z.array(referencedEditCommandSchema).min(1).max(MAX_EDIT_COMMANDS).optional(),
  'Edit commands applied in memory to the saved project before rendering, to compare a candidate change without saving it.',
);
const timelineLegend = described(
  z.array(
    z
      .object({
        cell: described(z.number().int().nonnegative(), 'Position in the sheet, row by row from the top left, from 0.'),
        frame: frameSchema,
        timecode: timecodeSchema,
        clipIds: described(z.array(idSchema), 'Clips visible at that frame, bottom track first.'),
        shows: described(
          z.enum(['saved', 'original', 'candidate']).optional(),
          'In a comparison: the frame as saved, without any Colour and Detail (original), or with the commands (candidate).',
        ),
      })
      .strict(),
  ),
  'What each cell shows; no text is drawn on the picture.',
);
const projectPicture = z
  .object({
    revision: described(frameSchema, 'Saved revision rendered, before any in-memory commands.'),
    image: imageSchema,
    legend: timelineLegend,
  })
  .strict();

export const still = defineOperation({
  name: 'still',
  description:
    "Render one project frame as the export composes it (every enabled track with its Colour, Detail, Transform, Opacity and transitions), from the 720p editing proxies, as a JPEG. Use crop for a 1:1 detail of the 1280 × 720 composition, for example to judge Sharpen or Denoise, and compare to judge a candidate grade beside the saved or original image in one picture. Width and crop size are limited by the service's image budget.",
  input: z
    .object({
      projectId,
      frame: described(frameSchema, 'Project frame to render.'),
      width: described(
        z.number().int().min(96).max(MAX_STILL_WIDTH).optional(),
        "Picture width in pixels; defaults to, and may not exceed, the service's still width.",
      ),
      crop: described(
        z
          .object({
            x: described(frameSchema, 'Left edge in the 1280 × 720 composition.'),
            y: described(frameSchema, 'Top edge in the 1280 × 720 composition.'),
            width: described(z.number().int().positive(), 'Crop width, at most the still width.'),
            height: described(z.number().int().positive(), 'Crop height, at most the still width.'),
          })
          .strict()
          .optional(),
        'Render this region at 1:1 instead of the scaled whole frame.',
      ),
      commands,
      compare: described(
        z.enum(['saved', 'original']).optional(),
        "Show the frame twice side by side in one picture: on the left as saved (saved, which needs commands) or without any Colour and Detail (original, the editor's Original preview), on the right with the commands, or as saved without them. Each half has the width asked for.",
      ),
    })
    .strict(),
  output: projectPicture,
  access: 'read',
  audience: ['editor', 'assistant'],
});

export const timelineSheet = defineOperation({
  name: 'timeline_sheet',
  description:
    "Render several project frames as one contact sheet, row by row, with a legend naming each cell's frame, timecode and clips. Cheaper than several stills for checking pacing, shot order or a grade across the cut. The number of frames and the cell width are limited by the service's image budget.",
  input: z
    .object({
      projectId,
      frames: described(z.array(frameSchema).min(1).max(MAX_SHEET_FRAMES), 'Project frames in the order to show them.'),
      commands,
    })
    .strict(),
  output: projectPicture,
  access: 'read',
  audience: ['editor', 'assistant'],
});

export const recordingSheet = defineOperation({
  name: 'recording_sheet',
  description:
    "Render source frames of one video recording's editing proxy as a contact sheet, without any track Colour or Transform, to choose footage before placing it. A single frame renders at the still width.",
  input: z
    .object({
      mediaId: described(idSchema, 'ID of a prepared video recording.'),
      frames: described(
        z.array(frameSchema).min(1).max(MAX_SHEET_FRAMES),
        'Source frames of the recording in the order to show them.',
      ),
    })
    .strict(),
  output: z
    .object({
      image: imageSchema,
      legend: described(
        z.array(
          z.object({ cell: z.number().int().nonnegative(), frame: frameSchema, timecode: timecodeSchema }).strict(),
        ),
        'The source frame and its timecode in the recording, per cell.',
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});

/** Pictures per candidate in compare_recordings. */
export const MAX_COMPARE_FRAMES = 4;

const candidateSchema = z
  .object({
    mediaId: described(idSchema, 'ID of a prepared video recording of the project.'),
    sourceIn: described(
      frameSchema.optional(),
      'First source frame of the candidate range; give both ends or neither.',
    ),
    sourceOut: described(frameSchema.optional(), 'Source frame after the candidate range (exclusive).'),
  })
  .strict()
  .refine((candidate) => (candidate.sourceIn === undefined) === (candidate.sourceOut === undefined), {
    message: 'Give both sourceIn and sourceOut, or neither.',
  });

export const compareRecordings = defineOperation({
  name: 'compare_recordings',
  description:
    "Show candidate shots from several video recordings in one contact sheet, without track Colour or Transform, to pick the best of similar takes before placing it. Each candidate takes `frames` cells in a row, spread across its range (frames 1 lays the candidates out row by row). A candidate without a range shows its recording's best steady range (rank 1) inside the kept ranges at the session's allowed movement, as describe_recording lists them, else its first kept range or the whole recording. The number of cells is limited by the service's image budget.",
  input: z
    .object({
      projectId,
      candidates: described(
        z.array(candidateSchema).min(1).max(MAX_SHEET_FRAMES),
        'Candidates in the order to show them; a recording may appear more than once with different ranges.',
      ),
      frames: described(
        z.number().int().min(1).max(MAX_COMPARE_FRAMES).optional(),
        'Cells per candidate, the centres of equal parts of its range; defaults to 1, its middle. 3 shows how its movement starts, develops and ends.',
      ),
    })
    .strict(),
  output: z
    .object({
      revision: revisionReadSchema,
      image: imageSchema,
      candidates: described(
        z.array(
          z
            .object({
              cells: described(
                z.array(z.number().int().nonnegative()),
                'Its cells, row by row from the top left, from 0.',
              ),
              mediaId: idSchema,
              name: described(z.string(), 'Recording file name.'),
              sourceIn: frameSchema,
              sourceOut: frameSchema,
              seconds: described(z.number(), 'Length of the range.'),
              frames: described(z.array(frameSchema), 'Source frame shown in each of its cells.'),
            })
            .strict(),
        ),
        'What each candidate shows; no text is drawn on the picture.',
      ),
    })
    .strict(),
  access: 'read',
  audience: ['assistant'],
});
