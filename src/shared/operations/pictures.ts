import { z } from 'zod';
import { editCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { MAX_EDIT_COMMANDS } from './edit.js';
import { defineOperation } from './spec.js';
import { timecodeSchema } from './timecode.js';

/** Hard limits; the service's image budget sets the actual ones, at most these. */
export const MAX_STILL_WIDTH = 1280;
export const MAX_SHEET_FRAMES = 24;

const imageSchema = described(
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
  z.array(editCommandSchema).min(1).max(MAX_EDIT_COMMANDS).optional(),
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
    "Render one project frame as the export composes it (every enabled track with its Colour, Detail, Transform, Opacity and transitions), from the 720p editing proxies, as a JPEG. Use crop for a 1:1 detail of the 1280 × 720 composition, for example to judge Sharpen or Denoise. Width and crop size are limited by the service's image budget.",
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
