import { z } from 'zod';
import { frameSchema, idSchema, type ProjectDocument } from './model.js';

export const projectSummarySchema = z
  .object({
    id: idSchema,
    title: z.string(),
    revision: frameSchema,
    clipCount: z.number().int().nonnegative(),
    duration: frameSchema,
    updatedAt: z.string(),
    compatible: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** Imports and timeline references both belong to the project's library. */
export function projectVideoIds(project: ProjectDocument): Set<string> {
  return new Set([...project.media.videoIds, ...project.clips.map((clip) => clip.mediaId)]);
}

export function projectAudioIds(project: ProjectDocument): Set<string> {
  return new Set([...project.media.audioIds, ...(project.music ? [project.music.mediaId] : [])]);
}
