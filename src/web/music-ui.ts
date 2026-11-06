import { z } from 'zod';
import type { AudioAsset } from '../shared/audio.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { MAX_MUSIC_CLIPS, type MusicClip, type MusicLane, type ProjectDocument } from '../shared/model.js';
import {
  insertMusicClip,
  laneOfClip,
  moveMusicClip,
  musicClipEnd,
  musicClips,
  musicTracks,
  sequenceMusicLane,
} from '../shared/music-lanes.js';
import { calculateLayout } from '../shared/timeline.js';

export type MusicEdit = Extract<EditCommand, { type: 'music' }>;
export type MusicGestureKind = 'move' | 'in' | 'out';

/** Why a music edit was refused: a schema error's first reason rather than its whole report. */
export function musicEditError(cause: unknown, fallback: string): string {
  if (cause instanceof z.ZodError) return cause.issues[0]?.message ?? fallback;
  return cause instanceof Error ? cause.message : fallback;
}

/** Video-only OUT for the explicit fit action and new-track defaults, never a music duration limit. */
export function videoTimelineDuration(project: ProjectDocument): number {
  return calculateLayout(project).clips.reduce((duration, clip) => Math.max(duration, clip.end), 0);
}

/** A clip playing the whole recording from `start`, or `duration` frames of it (looped beyond its end). */
export function createMusicClip(id: string, asset: AudioAsset, start: number, duration?: number): MusicClip {
  const length = duration ?? asset.metadata.frameCount;
  return {
    id,
    mediaId: asset.id,
    sourceIn: 0,
    sourceOut: asset.metadata.frameCount,
    start,
    duration: length,
    loop: length > asset.metadata.frameCount,
  };
}

/** A music track with one clip, neutral gain, no fades and Ripple off; initially as long as the video. */
export function createMusicLane(id: string, clipId: string, asset: AudioAsset, videoDuration: number): MusicLane {
  const duration = Math.min(asset.metadata.frameCount, videoDuration || asset.metadata.frameCount);
  return {
    id,
    gainDb: 0,
    ripple: false,
    openingFade: 0,
    closingFade: 0,
    clips: [createMusicClip(clipId, asset, 0, duration)],
    transitions: [],
  };
}

/** Replace only the addressed music track; every other track keeps its exact settings and order. */
export function musicLaneEdit(
  project: ProjectDocument,
  laneId: string,
  update: (lane: MusicLane) => MusicLane,
): MusicEdit {
  if (!project.music.some((lane) => lane.id === laneId)) throw new Error('The selected music track is unavailable.');
  return { type: 'music', music: project.music.map((lane) => (lane.id === laneId ? update(lane) : lane)) };
}

/** Where Source preview adds a music range: after the selected clip's track, else the first; a new track without one. */
export interface MusicAddTarget {
  laneId: string | null;
  /** Names the track for the button's tooltip. */
  name: string;
  /** Why nothing can be added there, or ''. */
  reason: string;
}

export function musicAddTarget(project: ProjectDocument, selectedMusicId: string | null): MusicAddTarget {
  const lane = (selectedMusicId === null ? undefined : laneOfClip(project.music, selectedMusicId)) ?? project.music[0];
  if (!lane) return { laneId: null, name: 'a new music track', reason: '' };
  const index = project.music.indexOf(lane) + 1;
  const reason =
    lane.clips.length >= MAX_MUSIC_CLIPS
      ? `Music track ${index} holds at most ${MAX_MUSIC_CLIPS} clips. Select a clip on another music track first.`
      : '';
  return { laneId: lane.id, name: `music track ${index}`, reason };
}

/** A new clip of `range` after the last clip of the target track, or alone on a new track at frame 0. */
export function addMusicRangeEdit(
  project: ProjectDocument,
  laneId: string | null,
  range: Pick<MusicClip, 'mediaId' | 'sourceIn' | 'sourceOut'>,
  ids: { lane: string; clip: string },
): MusicEdit {
  const clip: MusicClip = { id: ids.clip, ...range, start: 0, duration: range.sourceOut - range.sourceIn, loop: false };
  if (laneId === null)
    return {
      type: 'music',
      music: [
        ...project.music,
        { id: ids.lane, gainDb: 0, ripple: false, openingFade: 0, closingFade: 0, clips: [clip], transitions: [] },
      ],
    };
  return musicLaneEdit(project, laneId, (lane) =>
    insertMusicClip(lane, { ...clip, start: musicClipEnd(lane.clips.at(-1)!) }),
  );
}

/** Changes one clip; a Ripple track plays its clips one after another again, a start can reorder clips. */
export function musicClipEdit(
  project: ProjectDocument,
  clipId: string,
  settings: Partial<Omit<MusicClip, 'id'>>,
): MusicEdit {
  const lane = laneOfClip(project.music, clipId);
  if (!lane) throw new Error('The selected music clip is unavailable.');
  return musicLaneEdit(project, lane.id, (current) => {
    const original = current.clips.find((clip) => clip.id === clipId)!;
    const clips = current.clips.map((clip) =>
      clip.id === clipId ? { ...clip, ...settings, id: clip.id, start: original.start } : clip,
    );
    const updated = { ...current, clips };
    return settings.start === undefined || settings.start === original.start
      ? sequenceMusicLane(updated)
      : moveMusicClip(updated, clipId, settings.start);
  });
}

/**
 * The music clip selected after an edit: a newly added clip, else the selected one, else (when it was
 * removed) its neighbor on the same track, else the first clip.
 */
export function nextMusicSelection(
  previous: ProjectDocument | null,
  next: ProjectDocument,
  selected: string | null,
): string | null {
  const clips = musicClips(next.music);
  if (previous) {
    const before = new Set(musicClips(previous.music).map((clip) => clip.id));
    const added = clips.find((clip) => !before.has(clip.id));
    if (added) return added.id;
  }
  if (clips.some((clip) => clip.id === selected)) return selected;
  const lane = selected === null ? undefined : laneOfClip(previous?.music ?? [], selected);
  const survivor = lane && next.music.find((item) => item.id === lane.id);
  if (lane && survivor) {
    const position = lane.clips.findIndex((clip) => clip.id === selected);
    return survivor.clips[Math.min(position, survivor.clips.length - 1)]!.id;
  }
  return clips[0]?.id ?? null;
}

function gestureLane(lane: MusicLane, original: MusicClip, kind: MusicGestureKind, delta: number): MusicLane {
  if (kind === 'move')
    return moveMusicClip(lane, original.id, Math.max(0, Math.min(2_147_483_647, original.start + delta)));
  let clip = { ...original };
  if (kind === 'in') {
    // A Ripple track keeps its sequence start; elsewhere the clip's OUT stays put, its start not before 0.
    const restorable = lane.ripple ? original.sourceIn : Math.min(original.sourceIn, original.start);
    const travel = Math.max(
      -restorable,
      Math.min(original.duration - 1, original.sourceOut - original.sourceIn - 1, delta),
    );
    clip = {
      ...original,
      sourceIn: original.sourceIn + travel,
      start: lane.ripple ? original.start : original.start + travel,
      duration: original.duration - travel,
    };
  }
  if (kind === 'out')
    clip.duration = Math.max(
      1,
      Math.min(original.loop ? 2_147_483_647 : original.sourceOut - original.sourceIn, original.duration + delta),
    );
  return sequenceMusicLane({ ...lane, clips: lane.clips.map((item) => (item.id === original.id ? clip : item)) });
}

/** Source limits constrain handles, but conflicting fades or transitions are rejected, never shortened. */
export function planMusicGesture(project: ProjectDocument, clipId: string, kind: MusicGestureKind, delta: number) {
  const lane = laneOfClip(project.music, clipId);
  const original = lane?.clips.find((clip) => clip.id === clipId);
  if (!lane || !original) throw new Error('The selected music clip is unavailable.');
  const next = gestureLane(lane, original, kind, delta);
  const command: MusicEdit = { type: 'music', music: project.music.map((item) => (item.id === lane.id ? next : item)) };
  const track = musicTracks([next]).find((item) => item.id === clipId)!;
  const changed = JSON.stringify(next) !== JSON.stringify(lane);
  try {
    return { track, document: applyCommand(project, command), command: changed ? command : null, error: '' };
  } catch (cause) {
    return {
      track,
      document: project,
      command: null,
      error: musicEditError(cause, 'Invalid music range.'),
    };
  }
}
