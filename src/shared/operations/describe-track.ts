import { z } from 'zod';
import { described } from '../described.js';
import { interpolationSchema } from '../keyframes.js';
import { colourSchema } from '../colour.js';
import { gradeSettingSchema } from '../grade.js';
import { frameSchema, idSchema, layerSchema } from '../model.js';
import { SPATIAL_CHANNELS, spatialPoseSchema, type SpatialChannel } from '../spatial.js';
import { defineOperation } from './spec.js';
import { timecodeSchema } from './timecode.js';

export const MAX_DESCRIBED_FRAMES = 32;

const spatialChannelSchema = z.enum(SPATIAL_CHANNELS as [SpatialChannel, ...SpatialChannel[]]);

export const trackParts = ['track', 'keyframes', 'grades', 'at'] as const;

/** A keyframe with only its enabled settings. */
function compactKeyframe<K extends string>(settings: z.ZodEnum<Record<K, K>>) {
  return z
    .object({
      frame: frameSchema,
      timecode: timecodeSchema,
      values: described(z.partialRecord(settings, z.number()), 'The settings keyed here and their values.'),
      easing: described(
        z.partialRecord(settings, interpolationSchema),
        'The Easing of each keyed setting toward its next keyframe.',
      ),
      reset: described(z.boolean(), 'A default keyframe, whose values never reach back to earlier frames.'),
    })
    .strict();
}

export const trackDescriptionSchema = z
  .object({
    revision: described(frameSchema, 'Saved revision of the project; pass it as expectedRevision to edit.'),
    track: described(
      layerSchema.optional(),
      'The complete video track as saved: its Transform (with Opacity) and keyframes, Ripple, transitions and fades.',
    ),
    keyframes: described(
      z
        .object({ transform: z.array(compactKeyframe(spatialChannelSchema)) })
        .strict()
        .optional(),
      'The Transform keyframes (Opacity included), each with only its keyed settings.',
    ),
    grades: described(
      z
        .array(
          z
            .object({
              clipId: idSchema,
              colour: described(colourSchema, "The clip's own Colour, applied before any adjustment."),
              keyframes: described(
                z.array(compactKeyframe(gradeSettingSchema)),
                'Its keyframes, at source frames of its recording (timecode too).',
              ),
            })
            .strict(),
        )
        .optional(),
      'The clip grades of the clips on this track that grade or have keyframes, in timeline order; the others are neutral.',
    ),
    keyed: described(
      z
        .object({
          transform: described(
            z.array(spatialChannelSchema),
            'Transform settings with keyframes: their keyframes apply and their base value is ignored.',
          ),
        })
        .strict(),
      'Settings animated by keyframes; edit their keyframes, not their base values.',
    ),
    at: described(
      z
        .array(
          z
            .object({
              frame: frameSchema,
              timecode: timecodeSchema,
              adjustment: described(
                z
                  .object({
                    adjustmentId: idSchema,
                    values: z.partialRecord(gradeSettingSchema, z.number()),
                  })
                  .strict()
                  .optional(),
                'The adjustment grading every track at this frame, if any, and its scalar Colour settings (or those asked for), applied after the clip grades.',
              ),
              transform: described(
                spatialPoseSchema.partial(),
                'The Transform pose with Opacity (or the settings asked for) at this frame.',
              ),
              clipGrades: described(
                z
                  .array(
                    z
                      .object({
                        clipId: idSchema,
                        sourceFrame: frameSchema,
                        values: z.partialRecord(gradeSettingSchema, z.number()),
                      })
                      .strict(),
                  )
                  .optional(),
                'The grade of each clip shown at this frame that has one, at the source frame it shows; values apply before the adjustment.',
              ),
            })
            .strict(),
        )
        .optional(),
      'The values that apply at each requested frame, after keyframes; HSL ranges and curves are static.',
    ),
  })
  .strict();
export type TrackDescription = z.infer<typeof trackDescriptionSchema>;

export const describeTrack = defineOperation({
  name: 'describe_track',
  description:
    'Read every appearance value of one video track: its Transform (with Opacity) and keyframes, which settings follow keyframes, the grades of its clips (scalar settings, HSL ranges, curves and keyframes) and the values that apply at the requested project frames, including the adjustment grading every track there. Settings interact (Contrast with Shadows, Highlights, Whites and Blacks shape one tone curve), so read the grades before changing them; afterwards, include keyframes or at with the settings you changed reads far less.',
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project.'),
      layerId: described(idSchema, 'ID of the video track.'),
      frames: described(
        z.array(frameSchema).max(MAX_DESCRIBED_FRAMES).optional(),
        `Up to ${MAX_DESCRIBED_FRAMES} project frames at which to report the values that apply; none when omitted.`,
      ),
      include: described(
        z.array(z.enum(trackParts)).min(1).default(['track', 'grades', 'at']),
        'Parts to return besides revision and keyed: track (the whole saved track, the largest part), keyframes (each keyframe with only its keyed settings), grades (its clips’ own grades) and at (the values at frames).',
      ),
      settings: described(
        z
          .array(z.union([gradeSettingSchema, spatialChannelSchema]))
          .min(1)
          .optional(),
        'Report only these Colour and Transform (Opacity included) settings in at; all when omitted.',
      ),
    })
    .strict(),
  output: trackDescriptionSchema,
  access: 'read',
  audience: ['editor', 'assistant'],
});
