import { z } from 'zod';
import { described } from '../described.js';
import { keyframeSettingSchema } from '../keyframes.js';
import { frameSchema, idSchema, layerSchema } from '../model.js';
import { SPATIAL_CHANNELS, spatialPoseSchema, type SpatialChannel } from '../spatial.js';
import { defineOperation } from './spec.js';
import { timecodeSchema } from './timecode.js';

export const MAX_DESCRIBED_FRAMES = 32;

const spatialChannelSchema = z.enum(SPATIAL_CHANNELS as [SpatialChannel, ...SpatialChannel[]]);

export const trackDescriptionSchema = z
  .object({
    revision: described(frameSchema, 'Saved revision of the project; pass it as expectedRevision to edit.'),
    track: described(
      layerSchema,
      'The complete video track as saved; send it back changed with layer-update, or its colour or transform with the colour and transform commands.',
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
      z.array(
        z
          .object({
            frame: frameSchema,
            timecode: timecodeSchema,
            values: described(
              z.record(keyframeSettingSchema, z.number()),
              'Opacity and every scalar Colour setting as they apply at this frame.',
            ),
            transform: described(spatialPoseSchema, 'The Transform pose at this frame.'),
          })
          .strict(),
      ),
      'The values that apply at each requested frame, after keyframes; HSL ranges and curves are static.',
    ),
  })
  .strict();
export type TrackDescription = z.infer<typeof trackDescriptionSchema>;

export const describeTrack = defineOperation({
  name: 'describe_track',
  description:
    'Read every appearance value of one video track: its saved Colour (scalar settings, HSL ranges, curves), Opacity, Transform and keyframes, which settings follow keyframes, and the values that apply at the requested project frames. Settings interact (Contrast with Shadows, Highlights, Whites and Blacks shape one tone curve), so read the whole track before grading it.',
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project.'),
      layerId: described(idSchema, 'ID of the video track.'),
      frames: described(
        z.array(frameSchema).max(MAX_DESCRIBED_FRAMES).optional(),
        `Up to ${MAX_DESCRIBED_FRAMES} project frames at which to report the values that apply; none when omitted.`,
      ),
    })
    .strict(),
  output: trackDescriptionSchema,
  access: 'read',
  audience: ['editor', 'assistant'],
});
