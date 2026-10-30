import { z } from 'zod';
import { createDetailSettings, detailSchema } from './detail.js';
import { described } from './described.js';
import { adjustmentsSchema, clipGradeSchema, createClipGrade } from './grade.js';
import { createSpatialSettings, spatialSettingsSchema } from './spatial.js';
import { NORMAL_SPEED, speedSchema } from './speed.js';
import { calculateLayout } from './timeline.js';
import { PROJECT_FPS } from './timing.js';

/** Conventional initial identity only; it has no editing or stacking privileges. */
export const BASE_LAYER_ID = 'video-1';
export const MAX_VIDEO_LAYERS = 8;
export const MAX_MUSIC_TRACKS = 8;
/** Clips per music track; with crossfades at most two sound at once on a track. */
export const MAX_MUSIC_CLIPS = 8;
export const MAX_BOOKMARKS = 1_000;
/** Kept ranges per recording. */
export const MAX_SELECTS = 100;
export const MAX_TRACK_KEYFRAMES = 256;

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const frameSchema = z.number().int().nonnegative().max(2_147_483_647);
export const rateSchema = z
  .object({
    numerator: z.number().int().positive().max(1_000_000),
    denominator: z.number().int().positive().max(1_000_000),
  })
  .strict();
const clipFields = z
  .object({
    id: described(idSchema, 'Unique clip ID: letters, digits, "_" and "-", at most 100.'),
    mediaId: described(idSchema, 'The video recording the clip plays.'),
    layerId: described(idSchema, 'The video track holding the clip.'),
    start: described(
      frameSchema,
      'Project frame of its first output frame. On a Ripple track only the first clip sets it; the others follow.',
    ),
    sourceIn: described(frameSchema, 'First source frame played (inclusive).'),
    sourceOut: described(frameSchema.positive(), 'Source frame after the last one played (exclusive), after sourceIn.'),
    speed: described(speedSchema, 'Playback speed; it sets the clip duration with the source range.'),
    reverse: described(z.boolean(), 'True plays the source range backwards; duration is unchanged.'),
    detail: described(detailSchema, 'Static detail filters; all 0 is neutral.'),
    grade: described(
      clipGradeSchema,
      "The clip's own Color, applied before any adjustment; keyframes at source frames follow the footage.",
    ),
  })
  .strict();
const sourceRangeOrder = { message: 'Source OUT must be after IN (exclusive).' };
export const clipSchema = clipFields.refine((clip) => clip.sourceOut > clip.sourceIn, sourceRangeOrder);
/** A clip as inserted: it starts with a neutral grade, set afterwards with the Color commands. */
export const newClipSchema = clipFields
  .omit({ grade: true })
  .refine((clip) => clip.sourceOut > clip.sourceIn, sourceRangeOrder);

const boundary = (clips: string) => ({
  leftId: described(idSchema, `The earlier of the two adjacent ${clips}.`),
  rightId: described(idSchema, `The later of the two adjacent ${clips}.`),
});
const videoBoundary = boundary('clips');
export const transitionSchema = z.discriminatedUnion('type', [
  z.object({ ...videoBoundary, type: z.literal('cut'), duration: described(z.literal(0), 'Always 0.') }).strict(),
  z
    .object({
      ...videoBoundary,
      type: z.literal('fade-through-black'),
      duration: described(frameSchema.min(2), 'Frames from the fade-out start to the fade-in end, half on each clip.'),
    })
    .strict(),
  z
    .object({
      ...videoBoundary,
      type: z.literal('cross-dissolve'),
      duration: described(frameSchema.min(1), 'Frames the two clips overlap while one dissolves into the other.'),
    })
    .strict(),
  // Fade out over `fade` frames, hold black for its own `pause` timeslot between the clips, fade in.
  z
    .object({
      ...videoBoundary,
      type: z.literal('fade-black-pause'),
      fade: described(frameSchema.min(1), 'Frames of fade-out at the end of the left clip and of fade-in after.'),
      pause: described(frameSchema.min(1), 'Frames of black between the clips; the right clip starts after them.'),
    })
    .strict(),
]);
export const layerSchema = z
  .object({
    id: described(idSchema, 'Unique video track ID.'),
    name: described(z.string().trim().min(1).max(100), 'Name shown in the editor.'),
    enabled: described(z.boolean(), 'False hides the track in preview and export; its clips still count for duration.'),
    transform: described(
      spatialSettingsSchema,
      'Crop, scale, position, rotation and Opacity of every clip on the track.',
    ),
    ripple: described(
      z.boolean(),
      'True packs the clips one after another from the first clip; false keeps their starts.',
    ),
    transitions: described(
      z.array(transitionSchema).max(999),
      'One transition per pair of adjacent clips, in timeline order; a new track has none.',
    ),
    openingFade: described(frameSchema, 'Frames of fade from black at the start of the first clip.'),
    closingFade: described(frameSchema, 'Frames of fade to black at the end of the last clip.'),
  })
  .strict();
/** A playable music source: one clip of a music track with that track's gain and the clip's own fades. */
export const musicSchema = z
  .object({
    id: idSchema,
    mediaId: idSchema,
    sourceIn: frameSchema,
    sourceOut: frameSchema.positive(),
    start: frameSchema,
    duration: frameSchema.positive(),
    gainDb: z.number().min(-60).max(12),
    fadeIn: frameSchema,
    fadeOut: frameSchema,
    loop: z.boolean(),
  })
  .strict()
  .refine(
    (music) =>
      music.fadeIn + music.fadeOut <= music.duration &&
      music.sourceOut > music.sourceIn &&
      (music.loop || music.duration <= music.sourceOut - music.sourceIn),
    { message: 'Music source range, fades or non-looping duration are invalid.' },
  )
  .refine((music) => music.start + music.duration <= 2_147_483_647, {
    message: 'Music timeline OUT exceeds the supported integer project-frame range.',
  });
/** The playable sources of every music track's clips, as the preview mixes them. */
export const musicSourcesSchema = z
  .array(musicSchema)
  .max(MAX_MUSIC_TRACKS * MAX_MUSIC_CLIPS)
  .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length, {
    message: 'Music source IDs must be unique.',
  });
/** One placement of a music recording on a music track: its source range, timeline placement and loop. */
export const musicClipSchema = z
  .object({
    id: described(idSchema, 'Unique ID among all music tracks and music clips.'),
    mediaId: described(idSchema, 'The music recording the clip plays.'),
    sourceIn: described(frameSchema, 'First source frame played (inclusive).'),
    sourceOut: described(frameSchema.positive(), 'Source frame after the last one played (exclusive), after sourceIn.'),
    start: described(frameSchema, 'Project frame where the clip starts.'),
    duration: described(frameSchema.positive(), 'Frames the clip plays; without loop at most sourceOut − sourceIn.'),
    loop: described(z.boolean(), 'True repeats the source range until the duration ends.'),
  })
  .strict()
  .refine((clip) => clip.sourceOut > clip.sourceIn && (clip.loop || clip.duration <= clip.sourceOut - clip.sourceIn), {
    message: 'Music source range or non-looping duration is invalid.',
  })
  .refine((clip) => clip.start + clip.duration <= 2_147_483_647, {
    message: 'Music timeline OUT exceeds the supported integer project-frame range.',
  });
/** Joins two consecutive clips of a music track: a cut, an overlapping crossfade, a fade through silence or one with a pause. */
const musicBoundary = boundary('music clips');
export const musicTransitionSchema = z.discriminatedUnion('type', [
  z.object({ ...musicBoundary, type: z.literal('cut'), duration: described(z.literal(0), 'Always 0.') }).strict(),
  z
    .object({
      ...musicBoundary,
      type: z.literal('crossfade'),
      duration: described(frameSchema.min(1), 'Frames the two clips overlap, one fading out as the other fades in.'),
    })
    .strict(),
  z
    .object({
      ...musicBoundary,
      type: z.literal('fade-through-silence'),
      duration: described(frameSchema.min(2), 'Frames from the fade-out start to the fade-in end, half on each clip.'),
    })
    .strict(),
  // Fade out over `fade` frames, stay silent for its own `pause` timeslot between the clips, fade in.
  z
    .object({
      ...musicBoundary,
      type: z.literal('fade-silence-pause'),
      fade: described(frameSchema.min(1), 'Frames of fade-out at the end of the left clip and of fade-in after.'),
      pause: described(frameSchema.min(1), 'Frames of silence between the clips; the right clip starts after them.'),
    })
    .strict(),
]);
/** A music track: like a video track, it owns gain, opening/closing fades, Ripple and its clips' transitions. */
export const musicLaneSchema = z
  .object({
    id: described(idSchema, 'Unique ID among all music tracks and music clips.'),
    gainDb: described(z.number().min(-60).max(12), 'Gain of every clip on the track, in dB; 0 is unchanged.'),
    ripple: described(
      z.boolean(),
      'True plays the clips one after another from the first clip; false keeps their starts.',
    ),
    openingFade: described(frameSchema, 'Frames of fade-in at the start of the first clip.'),
    closingFade: described(frameSchema, 'Frames of fade-out at the end of the last clip.'),
    clips: described(z.array(musicClipSchema).min(1).max(MAX_MUSIC_CLIPS), 'The clips in timeline order, 1–8.'),
    transitions: described(
      z.array(musicTransitionSchema).max(MAX_MUSIC_CLIPS - 1),
      'One transition per pair of adjacent clips, in timeline order.',
    ),
  })
  .strict();
export const musicTracksSchema = z
  .array(musicLaneSchema)
  .max(MAX_MUSIC_TRACKS)
  .refine(
    (lanes) => {
      const ids = lanes.flatMap((lane) => [lane.id, ...lane.clips.map((clip) => clip.id)]);
      return new Set(ids).size === ids.length;
    },
    { message: 'Music track and music clip IDs must be unique.' },
  );
/** Project-time snap points; editing aids only, never rendered or exported. */
export const bookmarksSchema = z
  .array(frameSchema)
  .max(MAX_BOOKMARKS)
  .refine((frames) => frames.every((frame, index) => index === 0 || frame > frames[index - 1]!), {
    message: 'Bookmarks must be unique ascending project frames.',
  });

/** A kept source range of a recording; OUT is exclusive. */
export const selectRangeSchema = z
  .object({
    sourceIn: described(frameSchema, 'First kept source frame (inclusive).'),
    sourceOut: described(frameSchema.positive(), 'Source frame after the last kept one (exclusive), after sourceIn.'),
  })
  .strict()
  .refine((range) => range.sourceOut > range.sourceIn, { message: 'Source OUT must be after IN (exclusive).' });
export type SelectRange = z.infer<typeof selectRangeSchema>;

/** Ascending and separated by at least one frame: touching ranges are one range. */
export function orderedSelectRanges(ranges: readonly SelectRange[]): boolean {
  return ranges.every((range, index) => index === 0 || range.sourceIn > ranges[index - 1]!.sourceOut);
}

/**
 * The ranges the user kept of each recording in the bin. No entry means the whole recording is
 * available; an empty list is invalid. Clips may still use other frames; only assistant sessions are bound.
 */
export const selectsSchema = z.record(
  idSchema,
  z
    .array(selectRangeSchema)
    .min(1)
    .max(MAX_SELECTS)
    .refine(orderedSelectRanges, { message: 'Selects must be ascending and separated by at least one frame.' }),
);

/** The only accepted project schema; bump it for every incompatible change. */
export const PROJECT_SCHEMA_VERSION = 28;

const baseProjectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: idSchema,
    title: z.string().trim().min(1).max(200),
    media: z
      .object({
        videoIds: z
          .array(idSchema)
          .max(10_000)
          .refine((ids) => new Set(ids).size === ids.length, { message: 'Video library IDs must be unique.' }),
        audioIds: z
          .array(idSchema)
          .max(10_000)
          .refine((ids) => new Set(ids).size === ids.length, { message: 'Audio library IDs must be unique.' }),
      })
      .strict(),
    frameRate: rateSchema,
    colorProfile: z.literal('bt709-sdr'),
    layers: z.array(layerSchema).min(1).max(MAX_VIDEO_LAYERS),
    clips: z.array(clipSchema).max(1_000),
    adjustments: adjustmentsSchema,
    music: musicTracksSchema,
    bookmarks: bookmarksSchema,
    selects: selectsSchema,
    revision: frameSchema,
  })
  .strict();

export type ProjectDocument = z.infer<typeof baseProjectSchema>;
export type VideoClip = z.infer<typeof clipSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type MusicTrack = z.infer<typeof musicSchema>;
export type MusicLane = z.infer<typeof musicLaneSchema>;
export type MusicClip = z.infer<typeof musicClipSchema>;
export type MusicTransition = z.infer<typeof musicTransitionSchema>;
export type VideoLayer = ProjectDocument['layers'][number];

export const projectSchema = baseProjectSchema.superRefine((project, context) => {
  const bin = new Set(project.media.videoIds);
  for (const mediaId of Object.keys(project.selects)) {
    if (!bin.has(mediaId))
      context.addIssue({
        code: 'custom',
        message: `Selects refer to ${mediaId}, which is not in the project's recordings.`,
      });
  }
  try {
    calculateLayout(project);
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid timeline.' });
  }
});

export function createLayer(id: string, name: string, ripple = true): VideoLayer {
  return layerSchema.parse({
    id,
    name,
    enabled: true,
    transform: createSpatialSettings(),
    ripple,
    transitions: [],
    openingFade: 0,
    closingFade: 0,
  });
}

export function createProject(id: string, title: string): ProjectDocument {
  return projectSchema.parse({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    title,
    media: { videoIds: [], audioIds: [] },
    frameRate: { ...PROJECT_FPS },
    colorProfile: 'bt709-sdr',
    layers: [createLayer(BASE_LAYER_ID, 'Track 1')],
    clips: [],
    adjustments: [],
    music: [],
    bookmarks: [],
    selects: {},
    revision: 0,
  });
}

export function createClip(
  id: string,
  mediaId: string,
  sourceIn: number,
  sourceOut: number,
  layerId = BASE_LAYER_ID,
): VideoClip {
  return clipSchema.parse({
    id,
    mediaId,
    layerId,
    start: 0,
    sourceIn,
    sourceOut,
    speed: { ...NORMAL_SPEED },
    reverse: false,
    detail: createDetailSettings(),
    grade: createClipGrade(),
  });
}
