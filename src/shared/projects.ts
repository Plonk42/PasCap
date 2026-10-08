import { z } from 'zod';
import { applyCommand } from './commands.js';
import { frameSchema, idSchema, projectSchema, type ProjectDocument } from './model.js';

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
  return new Set([...project.media.audioIds, ...project.music.map((track) => track.mediaId)]);
}

export interface MediaRemoval {
  videoIds: readonly string[];
  audioIds: readonly string[];
}

/** Timeline excerpts and music instances that leave the project with these recordings. */
export function mediaRemovalUsage(project: ProjectDocument, removal: MediaRemoval): { clips: number; music: number } {
  return {
    clips: project.clips.filter((clip) => removal.videoIds.includes(clip.mediaId)).length,
    music: project.music.filter((track) => removal.audioIds.includes(track.mediaId)).length,
  };
}

/**
 * Remove recordings from the project's bin together with every excerpt and music
 * instance using them. Originals, registry entries and caches are not involved.
 */
export function removeProjectMedia(project: ProjectDocument, removal: MediaRemoval): ProjectDocument {
  const bin = { video: projectVideoIds(project), audio: projectAudioIds(project) };
  const missing = [
    ...removal.videoIds.filter((id) => !bin.video.has(id)),
    ...removal.audioIds.filter((id) => !bin.audio.has(id)),
  ];
  if (missing.length || removal.videoIds.length + removal.audioIds.length === 0)
    throw new Error('Choose recordings that belong to this project before removing them.');
  let next = project;
  for (const clip of project.clips.filter((item) => removal.videoIds.includes(item.mediaId)))
    next = applyCommand(next, { type: 'delete', clipId: clip.id });
  if (project.music.some((track) => removal.audioIds.includes(track.mediaId)))
    next = applyCommand(next, {
      type: 'music',
      music: next.music.filter((track) => !removal.audioIds.includes(track.mediaId)),
    });
  return projectSchema.parse({
    ...next,
    media: {
      videoIds: next.media.videoIds.filter((id) => !removal.videoIds.includes(id)),
      audioIds: next.media.audioIds.filter((id) => !removal.audioIds.includes(id)),
    },
  });
}
