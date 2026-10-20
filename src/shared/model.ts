import { z } from 'zod';
import { colourSchema, createColourSettings } from './colour.js';
import { createDetailSettings, detailSchema } from './detail.js';
import { layerKeyframeSchema, orderedKeys } from './keyframes.js';
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
export const MAX_TRACK_KEYFRAMES = 256;

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const frameSchema = z.number().int().nonnegative().max(2_147_483_647);
export const rateSchema = z
  .object({
    numerator: z.number().int().positive().max(1_000_000),
    denominator: z.number().int().positive().max(1_000_000),
  })
  .strict();
export const clipSchema = z
  .object({
    id: idSchema,
    mediaId: idSchema,
    layerId: idSchema,
    start: frameSchema,
    sourceIn: frameSchema,
    sourceOut: frameSchema.positive(),
    speed: speedSchema,
    reverse: z.boolean(),
    detail: detailSchema,
  })
  .strict()
  .refine((clip) => clip.sourceOut > clip.sourceIn, { message: 'Source OUT must be after IN (exclusive).' });

export const transitionSchema = z.discriminatedUnion('type', [
  z.object({ leftId: idSchema, rightId: idSchema, type: z.literal('cut'), duration: z.literal(0) }).strict(),
  z
    .object({
      leftId: idSchema,
      rightId: idSchema,
      type: z.literal('fade-through-black'),
      duration: frameSchema.min(2),
    })
    .strict(),
  z
    .object({ leftId: idSchema, rightId: idSchema, type: z.literal('cross-dissolve'), duration: frameSchema.min(1) })
    .strict(),
  // Fade out over `fade` frames, hold black for its own `pause` timeslot between the clips, fade in.
  z
    .object({
      leftId: idSchema,
      rightId: idSchema,
      type: z.literal('fade-black-pause'),
      fade: frameSchema.min(1),
      pause: frameSchema.min(1),
    })
    .strict(),
]);
export const layerSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    // Row-wide source coverage when Opacity has no participating points.
    opacity: z.number().min(0).max(1),
    colour: colourSchema,
    keyframes: z
      .array(layerKeyframeSchema)
      .max(MAX_TRACK_KEYFRAMES)
      .refine(orderedKeys, { message: 'Track keyframes must have unique ascending project frames.' }),
    transform: spatialSettingsSchema,
    ripple: z.boolean(),
    transitions: z.array(transitionSchema).max(999),
    openingFade: frameSchema,
    closingFade: frameSchema,
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
    id: idSchema,
    mediaId: idSchema,
    sourceIn: frameSchema,
    sourceOut: frameSchema.positive(),
    start: frameSchema,
    duration: frameSchema.positive(),
    loop: z.boolean(),
  })
  .strict()
  .refine((clip) => clip.sourceOut > clip.sourceIn && (clip.loop || clip.duration <= clip.sourceOut - clip.sourceIn), {
    message: 'Music source range or non-looping duration is invalid.',
  })
  .refine((clip) => clip.start + clip.duration <= 2_147_483_647, {
    message: 'Music timeline OUT exceeds the supported integer project-frame range.',
  });
/** Joins two consecutive clips of a music track: a cut, an overlapping crossfade or a fade through silence. */
export const musicTransitionSchema = z.discriminatedUnion('type', [
  z.object({ leftId: idSchema, rightId: idSchema, type: z.literal('cut'), duration: z.literal(0) }).strict(),
  z
    .object({ leftId: idSchema, rightId: idSchema, type: z.literal('crossfade'), duration: frameSchema.min(1) })
    .strict(),
  z
    .object({
      leftId: idSchema,
      rightId: idSchema,
      type: z.literal('fade-through-silence'),
      duration: frameSchema.min(2),
    })
    .strict(),
]);
/** A music track: like a video track, it owns gain, opening/closing fades, Ripple and its clips' transitions. */
export const musicLaneSchema = z
  .object({
    id: idSchema,
    gainDb: z.number().min(-60).max(12),
    ripple: z.boolean(),
    openingFade: frameSchema,
    closingFade: frameSchema,
    clips: z.array(musicClipSchema).min(1).max(MAX_MUSIC_CLIPS),
    transitions: z.array(musicTransitionSchema).max(MAX_MUSIC_CLIPS - 1),
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

/** The only accepted project schema; bump it for every incompatible change. */
export const PROJECT_SCHEMA_VERSION = 24;

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
    colourProfile: z.literal('bt709-sdr'),
    layers: z.array(layerSchema).min(1).max(MAX_VIDEO_LAYERS),
    clips: z.array(clipSchema).max(1_000),
    music: musicTracksSchema,
    bookmarks: bookmarksSchema,
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
    opacity: 1,
    colour: createColourSettings(),
    keyframes: [],
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
    colourProfile: 'bt709-sdr',
    layers: [createLayer(BASE_LAYER_ID, 'Track 1')],
    clips: [],
    music: [],
    bookmarks: [],
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
  });
}
