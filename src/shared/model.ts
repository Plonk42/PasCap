import { z } from 'zod';
import { colourSchema, NEUTRAL_COLOUR } from './colour.js';
import { layerKeyframeSchema, orderedKeys } from './keyframes.js';
import { createSpatialSettings, spatialSettingsSchema } from './spatial.js';
import { NORMAL_SPEED, speedSchema } from './speed.js';
import { calculateLayout } from './timeline.js';
import { PROJECT_FPS } from './timing.js';

/** Conventional initial identity only; it has no editing or stacking privileges. */
export const BASE_LAYER_ID = 'video-1';
export const MAX_VIDEO_LAYERS = 8;
export const MAX_MUSIC_TRACKS = 8;

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
    colour: colourSchema,
    speed: speedSchema,
    spatial: spatialSettingsSchema,
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
]);
export const layerSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    // Row-wide source coverage when Opacity has no participating points.
    opacity: z.number().min(0).max(1),
    keyframes: z
      .array(layerKeyframeSchema)
      .max(256)
      .refine(orderedKeys, { message: 'Layer points must have unique ascending project frames.' }),
    ripple: z.boolean(),
    transitions: z.array(transitionSchema).max(999),
    openingFade: frameSchema,
    closingFade: frameSchema,
  })
  .strict();
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
export const musicTracksSchema = z
  .array(musicSchema)
  .max(MAX_MUSIC_TRACKS)
  .refine((tracks) => new Set(tracks.map((track) => track.id)).size === tracks.length, {
    message: 'Music instance IDs must be unique.',
  });

const baseProjectSchema = z
  .object({
    schemaVersion: z.literal(9),
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
    revision: frameSchema,
  })
  .strict();

export type ProjectDocument = z.infer<typeof baseProjectSchema>;
export type VideoClip = z.infer<typeof clipSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type MusicTrack = z.infer<typeof musicSchema>;
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
    keyframes: [],
    ripple,
    transitions: [],
    openingFade: 0,
    closingFade: 0,
  });
}

export function createProject(id: string, title: string): ProjectDocument {
  return projectSchema.parse({
    schemaVersion: 9,
    id,
    title,
    media: { videoIds: [], audioIds: [] },
    frameRate: { ...PROJECT_FPS },
    colourProfile: 'bt709-sdr',
    layers: [createLayer(BASE_LAYER_ID, 'Video 1')],
    clips: [],
    music: [],
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
    colour: { ...NEUTRAL_COLOUR },
    speed: { ...NORMAL_SPEED },
    spatial: createSpatialSettings(),
  });
}
