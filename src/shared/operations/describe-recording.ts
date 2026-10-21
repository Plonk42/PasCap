import { z } from 'zod';
import { described } from '../described.js';
import { SMOOTH_TOLERANCE } from '../motion-analysis.js';
import { frameSchema, idSchema } from '../model.js';
import { imageSchema } from './pictures.js';
import { defineOperation } from './spec.js';
import { durationSchema, timecodeSchema } from './timecode.js';

const sourceRange = z.object({ sourceIn: frameSchema, sourceOut: frameSchema }).strict();
const speed = '% of the image width per second';
const metres = (text: string) => described(z.number().nullable(), `${text}; null where the drone did not record it.`);

export const describeRecording = defineOperation({
  name: 'describe_recording',
  description: `Map where a video recording is usable and how its camera moves, measured from its camera motion analysis and the drone's flight data, inside the ranges the user kept: its steady ranges with their length, picture movement (${speed}), roughness, a camera move name (static, pan, tilt, push in, pull out, rotate; a sideways flight looks like a pan) and mean flight data, plus damaged frames and how much of it hovers still. It never says what the footage shows: with sheet true, it also returns a contact sheet with the middle frame of each steady range (the longest ones when they do not all fit), for you to judge. To compare several recordings, compare_recordings shows them in one picture; recording_sheet shows any other frames.`,
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project, whose kept ranges and session brief apply.'),
      mediaId: described(idSchema, 'ID of a video recording in the project, from describe_project.'),
      allowedMovement: described(
        z.number().min(SMOOTH_TOLERANCE.min).max(SMOOTH_TOLERANCE.max).optional(),
        `How much the movement may change in a steady range (${SMOOTH_TOLERANCE.min}–${SMOOTH_TOLERANCE.max}, lower is steadier), as in Source preview; defaults to the session brief's, else ${SMOOTH_TOLERANCE.initial}.`,
      ),
      sheet: described(
        z.boolean().default(false),
        'True adds a contact sheet of the middle frames of the steady ranges.',
      ),
    })
    .strict(),
  output: z
    .object({
      recording: z
        .object({
          id: idSchema,
          name: z.string(),
          duration: durationSchema,
          damaged: described(z.array(sourceRange), 'Source ranges shown black because the original is damaged there.'),
          stillShare: described(
            z.number().nullable(),
            'Share of frames where the picture holds still (the drone hovers); null without analysis.',
          ),
          flightData: described(z.boolean(), 'Whether the recording carries the drone flight data.'),
        })
        .strict(),
      keptRanges: described(
        z.array(sourceRange).nullable(),
        'The source ranges the user kept; null when the whole recording is available.',
      ),
      allowedMovement: z.number(),
      motionAnalysed: described(
        z.boolean(),
        'False when the camera motion has not been analysed yet: there are then no steady ranges to report; ask the user to analyse it.',
      ),
      steadyRanges: z.array(
        z
          .object({
            sourceIn: frameSchema,
            sourceOut: described(frameSchema, 'Exclusive.'),
            inTimecode: timecodeSchema,
            outTimecode: timecodeSchema,
            seconds: z.number(),
            speed: described(z.number(), `Mean picture movement, ${speed}.`),
            peakSpeed: described(z.number(), `Highest picture movement, ${speed}.`),
            roughness: described(
              z.number(),
              'Mean change of that movement, % of the image width per s²; the allowed movement bounds it.',
            ),
            motion: described(
              z.string(),
              'The mean movement named as a camera move, such as "pan right" or "tilt down and push in"; "static" when the picture holds still.',
            ),
            flight: described(
              z
                .object({
                  height: metres('Mean height above the take-off point in metres'),
                  horizontalSpeed: metres('Mean horizontal speed in m/s'),
                  verticalSpeed: metres('Mean vertical speed in m/s, positive upwards'),
                  distance: metres('Mean distance from home in metres'),
                })
                .strict()
                .nullable(),
              'Mean flight data over the range; null without flight data there.',
            ),
            cell: described(
              z.number().int().nonnegative().nullable(),
              'Cell of the contact sheet showing its middle frame, row by row from 0; null when not shown.',
            ),
          })
          .strict(),
      ),
      image: imageSchema.optional(),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});
