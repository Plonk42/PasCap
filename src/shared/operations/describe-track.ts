import { z } from 'zod';
import { described } from '../described.js';
import { interpolationSchema, keyframeSettingSchema } from '../keyframes.js';
import { frameSchema, idSchema, layerSchema } from '../model.js';
import { SPATIAL_CHANNELS, spatialPoseSchema, type SpatialChannel } from '../spatial.js';
import { defineOperation } from './spec.js';
import { timecodeSchema } from './timecode.js';

export const MAX_DESCRIBED_FRAMES = 32;

const spatialChannelSchema = z.enum(SPATIAL_CHANNELS as [SpatialChannel, ...SpatialChannel[]]);

export const trackParts = ['track', 'keyframes', 'at'] as const;

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
      'The complete video track as saved: its base Colour (with HSL ranges and curves), Opacity, Transform and keyframes.',
    ),
    keyframes: described(
      z
        .object({
          colour: z.array(compactKeyframe(keyframeSettingSchema)),
          transform: z.array(compactKeyframe(spatialChannelSchema)),
        })
        .strict()
        .optional(),
      'The Colour and Opacity keyframes and the Transform keyframes, each with only its keyed settings.',
    ),
    keyed: described(
      z
        .object({
          colour: described(
            z.array(keyframeSettingSchema),
            'Opacity and Colour settings with keyframes: their keyframes apply and their base value is ignored.',
          ),
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
              values: described(
                z.partialRecord(keyframeSettingSchema, z.number()),
                'Opacity and every scalar Colour setting (or those asked for) as they apply at this frame.',
              ),
              transform: described(
                spatialPoseSchema.partial(),
                'The Transform pose (or the settings asked for) at this frame.',
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
    'Read every appearance value of one video track: its saved Colour (scalar settings, HSL ranges, curves), Opacity, Transform and keyframes, which settings follow keyframes, and the values that apply at the requested project frames. Settings interact (Contrast with Shadows, Highlights, Whites and Blacks shape one tone curve), so read the whole track before grading it; afterwards, include keyframes or at with the settings you changed reads far less.',
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project.'),
      layerId: described(idSchema, 'ID of the video track.'),
      frames: described(
        z.array(frameSchema).max(MAX_DESCRIBED_FRAMES).optional(),
        `Up to ${MAX_DESCRIBED_FRAMES} project frames at which to report the values that apply; none when omitted.`,
      ),
      include: described(
        z.array(z.enum(trackParts)).min(1).default(['track', 'at']),
        'Parts to return besides revision and keyed: track (the whole saved track, the largest part), keyframes (each keyframe with only its keyed settings) and at (the values at frames).',
      ),
      settings: described(
        z
          .array(z.union([keyframeSettingSchema, spatialChannelSchema]))
          .min(1)
          .optional(),
        'Report only these Opacity, Colour and Transform settings in at; all when omitted.',
      ),
    })
    .strict(),
  output: trackDescriptionSchema,
  access: 'read',
  audience: ['editor', 'assistant'],
});
