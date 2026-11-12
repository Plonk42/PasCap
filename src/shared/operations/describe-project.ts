import { z } from 'zod';
import { described } from '../described.js';
import { frameSchema, idSchema, musicTransitionSchema, selectRangeSchema, transitionSchema } from '../model.js';
import { defineOperation } from './spec.js';
import { detailSummarySchema, gradeSummarySchema } from './grade-summary.js';
import { durationSchema, recordingFpsSchema, timecodeSchema } from './timecode.js';

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

export const projectParts = ['videoTracks', 'adjustments', 'musicTracks', 'recordings', 'bookmarks'] as const;

export const clipDescriptionSchema = z
  .object({
    id: idSchema,
    recording,
    ...span,
    sourceIn: frameSchema,
    sourceOut: frameSchema,
    speed: described(
      z.string().optional(),
      'Constant rate such as "2×", or "curve, N keyframes"; absent at normal speed (1×).',
    ),
    reverse: described(z.literal(true).optional(), 'true when it plays backwards; absent forwards.'),
    grade: described(
      z.string().optional(),
      'Its own grade, applied before any adjustment: "static" or "N keyframes"; absent when neutral (describe_track reads it).',
    ),
    detail: detailSummarySchema,
  })
  .strict();

export const videoTrackDescriptionSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    enabled: described(z.literal(false).optional(), 'false when hidden; absent when shown.'),
    ripple: described(z.literal(false).optional(), 'false when Ripple is off; absent when on.'),
    opacity: described(
      z.number().optional(),
      'Opacity of its Transform base, 0–1; absent when 1 (it may follow Transform keyframes).',
    ),
    transformKeyframes: described(
      z.number().int().optional(),
      'Transform keyframes, Opacity included; absent when none.',
    ),
    openingFade: described(frameSchema.optional(), 'Frames of fade from black; absent when none.'),
    closingFade: described(frameSchema.optional(), 'Frames of fade to black; absent when none.'),
    clips: z.array(clipDescriptionSchema),
    transitions: described(
      z.array(transitionSchema),
      'Transitions other than cuts; every other pair of adjacent clips is joined by a cut.',
    ),
  })
  .strict();

export const adjustmentDescriptionSchema = z
  .object({
    id: idSchema,
    ...span,
    enabled: described(
      z.literal(false).optional(),
      'false when the user turned it off: it grades nothing in stills, sheets and export until the user turns it on; absent when on.',
    ),
    grade: described(gradeSummarySchema, 'Its grade: what it changes from neutral, and its keyframe count.'),
  })
  .strict();

export const musicTrackDescriptionSchema = z
  .object({
    id: idSchema,
    gainDb: described(z.number().optional(), 'Gain in dB; absent when 0.'),
    ripple: described(z.literal(true).optional(), 'true when Ripple is on; absent when off.'),
    openingFade: described(frameSchema.optional(), 'Frames of fade in; absent when none.'),
    closingFade: described(frameSchema.optional(), 'Frames of fade out; absent when none.'),
    clips: z.array(
      z
        .object({
          id: idSchema,
          recording,
          ...span,
          sourceIn: frameSchema,
          sourceOut: frameSchema,
          loop: described(z.literal(true).optional(), 'true when it loops; absent otherwise.'),
        })
        .strict(),
    ),
    transitions: described(
      z.array(musicTransitionSchema),
      'Transitions other than cuts; every other pair of adjacent clips is joined by a cut.',
    ),
  })
  .strict();

export const recordingDescriptionSchema = z
  .object({
    id: idSchema,
    name: z.string().nullable(),
    frameCount: z.number().int().nullable(),
    fps: recordingFpsSchema,
    ready: described(
      z.literal(false).optional(),
      'false when not prepared, so it cannot be placed or previewed; absent when ready.',
    ),
    kept: described(
      z.array(selectRangeSchema).optional(),
      'Source ranges the user kept (OUT exclusive); absent when the whole recording is kept.',
    ),
    selectionDone: described(
      z.literal(true).optional(),
      'true when the user marked their range selection of this recording done; absent: still to review. Only the user sets it.',
    ),
  })
  .strict();

export const projectDescriptionSchema = z
  .object({
    id: idSchema,
    title: z.string(),
    revision: described(frameSchema, 'Saved revision; pass it as expectedRevision to edit.'),
    duration: durationSchema,
    videoTracks: described(
      z.array(videoTrackDescriptionSchema).optional(),
      'Bottom to top; each track lists its clips in timeline order.',
    ),
    adjustments: described(
      z.array(adjustmentDescriptionSchema).optional(),
      'Adjustments in timeline order: each grades every video track within its range, after the clip grades.',
    ),
    musicTracks: z.array(musicTrackDescriptionSchema).optional(),
    recordings: described(z.array(recordingDescriptionSchema).optional(), 'Video recordings of the project.'),
    musicRecordings: z.array(z.object({ id: idSchema, name: z.string().nullable() }).strict()).optional(),
    bookmarks: described(z.array(frameSchema).optional(), 'Bookmarked project frames.'),
  })
  .strict();
export type ProjectDescription = z.infer<typeof projectDescriptionSchema>;

export const describeProject = defineOperation({
  name: 'describe_project',
  title: 'Describe project',
  description:
    'Summarize a saved project: its revision, duration, video tracks with their clips in timeline order (project frames and timecodes, source ranges, speed, direction, grade, non-neutral Detail), transitions, adjustments, music tracks, the recordings with the ranges the user kept and whether their selection is done, and bookmarks. Values left out are at their default (neutral, normal speed, forwards, cuts, no fades). Frames are integers at 30000/1001 fps. Read it before editing; edit returns what each batch changed.',
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project.'),
      include: described(
        z.array(z.enum(projectParts)).min(1).optional(),
        'Parts to return besides the id, title, revision and duration: videoTracks, adjustments, musicTracks, recordings (video and music) and bookmarks; all when omitted. Ask only for what the step needs: videoTracks for the cut, recordings when choosing footage.',
      ),
      layerId: described(idSchema.optional(), 'Only this video track in videoTracks.'),
    })
    .strict(),
  output: projectDescriptionSchema,
  access: 'read',
  audience: ['editor', 'assistant'],
});
