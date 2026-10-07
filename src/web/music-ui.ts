import type { AudioAsset } from '../shared/audio.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { MusicTrack, ProjectDocument } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';

export type MusicEdit = Extract<EditCommand, { type: 'music' }>;
export type MusicGestureKind = 'move' | 'in' | 'out';

/** Video-only OUT for the explicit fit action and new-instance defaults, never a music duration limit. */
export function videoTimelineDuration(project: ProjectDocument): number {
  return calculateLayout(project).clips.reduce((duration, clip) => Math.max(duration, clip.end), 0);
}

/** Initial range only; later music edits can extend the complete project beyond video OUT. */
export function createMusicInstance(id: string, asset: AudioAsset, videoDuration: number): MusicTrack {
  return {
    id,
    mediaId: asset.id,
    sourceIn: 0,
    sourceOut: asset.metadata.frameCount,
    start: 0,
    duration: Math.min(asset.metadata.frameCount, videoDuration || asset.metadata.frameCount),
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  };
}

/** Replace only the addressed instance; every other instance keeps its exact settings and order. */
export function musicInstanceEdit(
  project: ProjectDocument,
  id: string,
  settings: Partial<Omit<MusicTrack, 'id'>>,
): MusicEdit {
  if (!project.music.some((track) => track.id === id)) throw new Error('The selected music track is unavailable.');
  return {
    type: 'music',
    music: project.music.map((track) => (track.id === id ? { ...track, ...settings, id: track.id } : track)),
  };
}

/** Source limits constrain handles, but conflicting fades are rejected, never shortened. */
export function planMusicGesture(project: ProjectDocument, id: string, kind: MusicGestureKind, delta: number) {
  const original = project.music.find((track) => track.id === id);
  if (!original) throw new Error('The selected music track is unavailable.');
  let track = { ...original };
  if (kind === 'move') track.start = Math.max(0, Math.min(2_147_483_647, original.start + delta));
  if (kind === 'in') {
    const travel = Math.max(
      -Math.min(original.sourceIn, original.start),
      Math.min(original.duration - 1, original.sourceOut - original.sourceIn - 1, delta),
    );
    track = {
      ...original,
      sourceIn: original.sourceIn + travel,
      start: original.start + travel,
      duration: original.duration - travel,
    };
  }
  if (kind === 'out')
    track.duration = Math.max(
      1,
      Math.min(original.loop ? 2_147_483_647 : original.sourceOut - original.sourceIn, original.duration + delta),
    );
  const command = musicInstanceEdit(project, id, track);
  const changed =
    track.start !== original.start || track.sourceIn !== original.sourceIn || track.duration !== original.duration;
  try {
    return { track, document: applyCommand(project, command), command: changed ? command : null, error: '' };
  } catch (cause) {
    return {
      track,
      document: project,
      command: null,
      error: cause instanceof Error ? cause.message : 'Invalid music range.',
    };
  }
}
