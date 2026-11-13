import { z } from 'zod';
import { TONE_QUANTILES } from './auto-adjust.js';
import type { LookProfile } from './look-match.js';
import { idSchema } from './model.js';

/** Registered styles (#314): looks measured on the user's own finished edits, which Color → Match can aim at. */
export const MAX_STYLES = 64;
export const MAX_STYLE_REFERENCES = 8;
export const MAX_STYLE_NAME = 80;
/** Frames measured per reference video, at the centers of equal slices of it; a still is one frame. */
export const STYLE_VIDEO_FRAMES = 8;

export const lookProfileSchema = z
  .object({
    levels: z.array(z.number()).length(TONE_QUANTILES.length),
    middle: z.number(),
    shadow: z.number(),
    cast: z.object({ temperature: z.number(), tint: z.number() }).strict().nullable(),
    muted: z.number(),
    strong: z.number(),
    colorfulness: z.number(),
  })
  .strict() satisfies z.ZodType<LookProfile>;

export const styleNameSchema = z.string().trim().min(1).max(MAX_STYLE_NAME);

export const styleReferenceSchema = z
  .object({
    /** The original, read in place. */
    path: z.string().min(1).max(4096),
    kind: z.enum(['video', 'still']),
    frames: z.number().int().positive(),
  })
  .strict();

export const styleSchema = z
  .object({
    id: idSchema,
    name: styleNameSchema,
    references: z.array(styleReferenceSchema).min(1).max(MAX_STYLE_REFERENCES),
    look: lookProfileSchema,
    createdAt: z.string(),
  })
  .strict();
export type Style = z.infer<typeof styleSchema>;

/** `styles.json`, beside the video and music registries. */
export const stylesFileSchema = z
  .object({
    version: z.literal(1),
    styles: z.array(styleSchema).max(MAX_STYLES),
  })
  .strict();

/** What the editor and the assistant see of a style: its references by file name only, and its look. */
export const styleSummarySchema = z
  .object({
    id: idSchema,
    name: z.string(),
    references: z.array(z.object({ name: z.string(), kind: z.enum(['video', 'still']), frames: z.number() }).strict()),
    look: lookProfileSchema,
    createdAt: z.string(),
  })
  .strict();
export type StyleSummary = z.infer<typeof styleSummarySchema>;

export function styleSummary(style: Style): StyleSummary {
  return {
    id: style.id,
    name: style.name,
    references: style.references.map(({ path, kind, frames }) => ({
      name: path.split(/[\\/]/).at(-1) ?? path,
      kind,
      frames,
    })),
    look: style.look,
    createdAt: style.createdAt,
  };
}
