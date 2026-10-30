import { z } from 'zod';
import { steadyLimitShape } from '../assistant-session.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { SHOT_KINDS, SHOT_SCORE_SECONDS, SHOT_WEIGHTS } from '../recording-shots.js';
import { imageSchema } from './pictures.js';
import { defineOperation, revisionReadSchema } from './spec.js';
import { durationSchema, timecodeSchema } from './timecode.js';

const sourceRange = z.object({ sourceIn: frameSchema, sourceOut: frameSchema }).strict();
const speed = '% of the image width per second';
const meters = (text: string) => described(z.number().nullable(), `${text}; null where the drone did not record it.`);

export const describeRecording = defineOperation({
  name: 'describe_recording',
  description: `Map where a video recording is usable and how its camera moves, measured from its camera motion analysis and the drone's flight data, inside the ranges the user kept: its steady ranges in source order with their length, picture movement (${speed}), jolts, a camera move name (static, pan, tilt, push in, pull out, rotate; a sideways flight looks like a pan), what they show (orbit, reveal, move, approach, static), their rank (1 = the best, as Source preview suggests it) and mean flight data, plus damaged frames and how much of it hovers still. It never says what the footage shows: with sheet true, it also returns a contact sheet with the middle frame of each steady range (the best-ranked ones when they do not all fit), for you to judge. To compare several recordings, compare_recordings shows them in one picture; recording_sheet shows any other frames.`,
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project, whose kept ranges and session brief apply.'),
      mediaId: described(idSchema, 'ID of a video recording in the project, from describe_project.'),
      ...steadyLimitShape(
        (field) => field.optional(),
        (initial) => `defaults to the session brief's, else ${initial}`,
      ),
      sheet: described(
        z.boolean().default(false),
        'True adds a contact sheet of the middle frames of the steady ranges.',
      ),
    })
    .strict(),
  output: z
    .object({
      revision: revisionReadSchema,
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
      limits: described(
        z.object(steadyLimitShape((field) => field)).strict(),
        'The steady-range limits applied: the request, else the session brief, else the defaults.',
      ),
      motionAnalyzed: described(
        z.boolean(),
        'False when the camera motion has not been analyzed yet: there are then no steady ranges to report; ask the user to analyze it.',
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
            jolts: described(
              z.number(),
              'Mean jolts: how fast that movement changes, % of the image width per s²; maxJolts bounds every frame.',
            ),
            motion: described(
              z.string(),
              'The mean movement named as a camera move, such as "pan right" or "tilt down and push in"; "static" when the picture holds still.',
            ),
            kind: described(
              z.enum(SHOT_KINDS),
              'What the range shows, from its movement and flight data: orbit (the picture turns, or slides sideways while the drone flies), reveal (a climb or a pull out), move (any other camera move), approach (only pushing in, as when flying at a target) or static.',
            ),
            rank: described(
              z.number().int().positive(),
              `1 for the best steady range, as Source preview suggests it: each scores its length up to ${SHOT_SCORE_SECONDS} s, weighted by kind (orbit and reveal ${SHOT_WEIGHTS.orbit}, move ${SHOT_WEIGHTS.move}, approach ${SHOT_WEIGHTS.approach}, static ${SHOT_WEIGHTS.static}); ties go to the longer.`,
            ),
            flight: described(
              z
                .object({
                  height: meters('Mean height above the take-off point in meters'),
                  horizontalSpeed: meters('Mean horizontal speed in m/s'),
                  verticalSpeed: meters('Mean vertical speed in m/s, positive upwards'),
                  distance: meters('Mean distance from home in meters'),
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
