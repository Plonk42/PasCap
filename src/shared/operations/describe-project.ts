import { z } from 'zod';
import { described } from '../described.js';
import { frameSchema, idSchema, musicTransitionSchema, selectRangeSchema, transitionSchema } from '../model.js';
import { defineOperation } from './spec.js';
import { durationSchema, timecodeSchema } from './timecode.js';

const span = {
  start: described(frameSchema, 'First project frame.'),
  end: described(frameSchema, 'Project frame after the last one (exclusive).'),
  startTimecode: timecodeSchema,
  endTimecode: timecodeSchema,
  seconds: described(z.number().nonnegative(), 'Length in seconds, rounded to hundredths.'),
};
const recording = z
  .object({ id: idSchema, name: described(z.string().nullable(), 'File name; null when no longer registered.') })
  .strict();

export const projectParts = ['videoTracks', 'musicTracks', 'recordings', 'bookmarks'] as const;

export const projectDescriptionSchema = z
  .object({
    id: idSchema,
    title: z.string(),
    revision: described(frameSchema, 'Saved revision; pass it as expectedRevision to edit.'),
    duration: durationSchema,
    videoTracks: described(
      z
        .array(
          z
            .object({
              id: idSchema,
              name: z.string(),
              enabled: z.boolean(),
              ripple: z.boolean(),
              opacity: z.number(),
              colourKeyframes: described(z.number().int(), 'Track keyframes of Colour and Opacity.'),
              transformKeyframes: z.number().int(),
              openingFade: frameSchema,
              closingFade: frameSchema,
              clips: z.array(
                z
                  .object({
                    id: idSchema,
                    recording,
                    ...span,
                    sourceIn: frameSchema,
                    sourceOut: frameSchema,
                    speed: described(z.string(), 'Constant rate such as "1×", or "curve, N keyframes".'),
                    reverse: z.boolean(),
                    grade: described(
                      z.string(),
                      'Its own grade, applied before the track Colour: "none", "static" or "N keyframes" (describe_track reads it).',
                    ),
                  })
                  .strict(),
              ),
              transitions: z.array(transitionSchema),
            })
            .strict(),
        )
        .optional(),
      'Bottom to top; each track lists its clips in timeline order.',
    ),
    musicTracks: z
      .array(
        z
          .object({
            id: idSchema,
            gainDb: z.number(),
            ripple: z.boolean(),
            openingFade: frameSchema,
            closingFade: frameSchema,
            clips: z.array(
              z
                .object({
                  id: idSchema,
                  recording,
                  ...span,
                  sourceIn: frameSchema,
                  sourceOut: frameSchema,
                  loop: z.boolean(),
                })
                .strict(),
            ),
            transitions: z.array(musicTransitionSchema),
          })
          .strict(),
      )
      .optional(),
    recordings: described(
      z
        .array(
          z
            .object({
              id: idSchema,
              name: z.string().nullable(),
              frameCount: z.number().int().nullable(),
              ready: described(z.boolean(), 'Prepared, so it can be placed and previewed.'),
              kept: described(
                z.array(selectRangeSchema).nullable(),
                'Source ranges the user kept (OUT exclusive); null keeps the whole recording.',
              ),
            })
            .strict(),
        )
        .optional(),
      'Video recordings of the project.',
    ),
    musicRecordings: z.array(z.object({ id: idSchema, name: z.string().nullable() }).strict()).optional(),
    bookmarks: described(z.array(frameSchema).optional(), 'Bookmarked project frames.'),
  })
  .strict();
export type ProjectDescription = z.infer<typeof projectDescriptionSchema>;

export const describeProject = defineOperation({
  name: 'describe_project',
  description:
    'Summarise a saved project: its revision, duration, video tracks with their clips in timeline order (project frames and timecodes, source ranges, speed, direction), transitions, music tracks, the recordings with the ranges the user kept, and bookmarks. Frames are integers at 30000/1001 fps. Read it before editing and after each edit batch.',
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project.'),
      include: described(
        z.array(z.enum(projectParts)).min(1).optional(),
        'Parts to return besides the id, title, revision and duration: videoTracks, musicTracks, recordings (video and music) and bookmarks; all when omitted. Ask only for what the step needs: videoTracks after an edit, recordings when choosing footage.',
      ),
      layerId: described(idSchema.optional(), 'Only this video track in videoTracks.'),
    })
    .strict(),
  output: projectDescriptionSchema,
  access: 'read',
  audience: ['editor', 'assistant'],
});
