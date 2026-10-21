import { z } from 'zod';
import { editCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { sectionKinds } from '../music-analysis.js';
import { defineOperation } from './spec.js';
import { durationSchema, timecodeSchema } from './timecode.js';

export const MAX_LISTED_BEATS = 2000;

const projectId = described(idSchema, 'ID of the saved project.');
const musicClipId = described(
  idSchema.optional(),
  'ID of one music clip, from describe_project; every music clip of the project when omitted.',
);
const placedBeat = z
  .object({
    frame: frameSchema,
    timecode: timecodeSchema,
    downbeat: described(z.boolean(), 'The first beat of a bar.'),
    strength: described(z.number(), 'Onset strength, 0–1.'),
  })
  .strict();

export const musicAnalysis = defineOperation({
  name: 'music_analysis',
  description:
    "Read the tempo, meter, beats, downbeats, accents (strong hits worth cutting on) and sections (quiet, build, peak, release) of the project's music clips, at project frames: where each plays on the timeline, repeated across loops. Use a frame window for long music. A clip whose music is not analysed yet says so; ask the user to analyse it in Audio → Music.",
  input: z
    .object({
      projectId,
      musicClipId,
      fromFrame: described(frameSchema.optional(), 'First project frame of the window.'),
      toFrame: described(frameSchema.optional(), 'Project frame after the window (exclusive).'),
    })
    .strict(),
  output: z
    .object({
      clips: z.array(
        z
          .object({
            musicClipId: idSchema,
            trackId: idSchema,
            recording: z.object({ id: idSchema, name: z.string() }).strict(),
            start: frameSchema,
            end: described(frameSchema, 'Exclusive.'),
            analysis: described(
              z.enum(['analysed', 'analysing', 'missing']),
              'Whether its beats are known, being found, or not analysed.',
            ),
            tempo: z.object({ bpm: z.number(), confidence: z.number() }).strict().nullable(),
            meter: z.object({ beatsPerBar: z.number().int(), confidence: z.number() }).strict().nullable(),
            beats: z.array(placedBeat),
            beatsTruncated: described(
              z.boolean(),
              `True when more than ${MAX_LISTED_BEATS} beats fall in the window; ask for a narrower one.`,
            ),
            accents: z.array(z.object({ frame: frameSchema, strength: z.number() }).strict()),
            sections: z.array(
              z
                .object({
                  start: frameSchema,
                  end: described(frameSchema, 'Exclusive.'),
                  kind: z.enum(sectionKinds),
                  loudnessDb: z.number(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});

const offset = described(
  z.object({ frame: frameSchema, offset: z.number().int() }).strict().nullable(),
  'The nearest one and the signed offset in frames (positive: the change comes after it); null without any.',
);

export const checkAlignment = defineOperation({
  name: 'check_alignment',
  description:
    'Measure how the cut follows the music: for every boundary of every video track (or one), the frame the viewer perceives as the change (the cut, the middle of a dissolve, the middle of a black pause), its nearest beat and downbeat and the signed offsets in frames, and a summary. Within one frame of a beat counts as on the beat.',
  input: z
    .object({ projectId, layerId: described(idSchema.optional(), 'One video track only.'), musicClipId })
    .strict(),
  output: z
    .object({
      beats: described(z.number().int().nonnegative(), 'Beats of the analysed music clips considered.'),
      boundaries: z.array(
        z
          .object({
            layerId: idSchema,
            leftId: idSchema,
            rightId: idSchema,
            type: z.string(),
            frame: frameSchema,
            timecode: timecodeSchema,
            beat: offset,
            downbeat: offset,
          })
          .strict(),
      ),
      summary: z
        .object({
          boundaries: z.number().int().nonnegative(),
          onBeat: described(z.number().int().nonnegative(), 'Boundaries within one frame of a beat.'),
          onDownbeat: described(z.number().int().nonnegative(), 'Boundaries within one frame of a downbeat.'),
          meanOffset: described(z.number().nullable(), 'Mean absolute offset from the nearest beat, in frames.'),
        })
        .strict(),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});

export const snapCutsToBeats = defineOperation({
  name: 'snap_cuts_to_beats',
  description:
    "Move the boundaries of one Ripple video track onto the music: left to right, trim each boundary's left clip so the change lands on the nearest beat (or downbeat), shortening it, or lengthening it where its recording has footage inside the kept ranges, else taking the nearest beat on the other side; each clip stays at least minimumSeconds long and transitions keep their durations; later clips follow. Returns the proposed trim commands and each boundary before and after; with apply, saves them as one edit (needs the session and expectedRevision). Do the arithmetic with this rather than by hand.",
  input: z
    .object({
      projectId,
      layerId: described(idSchema, 'ID of a video track with Ripple on.'),
      prefer: described(z.enum(['beat', 'downbeat']).default('beat'), 'Snap to every beat or to downbeats only.'),
      minimumSeconds: described(
        z.number().min(0).max(60).default(1),
        'Shortest a clip may become; a boundary that would need a shorter clip stays where it is.',
      ),
      musicClipId,
      apply: described(z.boolean().default(false), 'True saves the trims as one edit; false only proposes them.'),
      expectedRevision: described(
        frameSchema.optional(),
        'Revision you last read, from describe_project; required with apply.',
      ),
    })
    .strict(),
  output: z
    .object({
      boundaries: z.array(
        z
          .object({
            leftId: idSchema,
            rightId: idSchema,
            before: frameSchema,
            beat: frameSchema.nullable(),
            after: frameSchema,
            skipped: described(z.string().nullable(), 'Why the boundary stays where it is.'),
          })
          .strict(),
      ),
      commands: z.array(editCommandSchema),
      applied: described(
        z.object({ revision: frameSchema, duration: durationSchema }).strict().nullable(),
        'The saved revision with apply; null for a proposal or when nothing moved.',
      ),
    })
    .strict(),
  access: 'write',
  audience: ['editor', 'assistant'],
});
