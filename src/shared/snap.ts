import type { ProjectDocument } from './model.js';
import { musicTargetFrames, type MusicAnalysis, type MusicTarget } from './music-analysis.js';
import { musicClips, musicTracks } from './music-lanes.js';
import { calculateLayout } from './timeline.js';

/**
 * The beats or hits a project's music clips snap to, at project frames, leaving out those of the
 * excluded clips (the ones being moved); none while beat snapping is off.
 */
export type BeatSnap = (project: ProjectDocument, excludedMusicIds?: ReadonlySet<string>) => readonly number[];
export const NO_BEATS: BeatSnap = () => [];

/** Snaps to the analyzed beats, downbeats or strong hits of every music clip, where they play now. */
export function musicBeatSnap(
  analysisOf: (mediaId: string) => Pick<MusicAnalysis, 'beats' | 'hits'> | null,
  target: MusicTarget,
): BeatSnap {
  return (project, excluded) =>
    musicTracks(project.music).flatMap((music) => {
      const analysis = excluded?.has(music.id) ? null : analysisOf(music.mediaId);
      return analysis ? musicTargetFrames(music, analysis, target) : [];
    });
}

export function snapPoints(project: ProjectDocument, beats: BeatSnap = NO_BEATS): number[] {
  const layout = calculateLayout(project);
  const points = layout.clips.flatMap((clip) => [clip.start, clip.end]);
  for (const clip of musicClips(project.music)) points.push(clip.start, clip.start + clip.duration);
  for (const item of project.adjustments) points.push(item.start, item.start + item.duration);
  return [
    ...new Set([
      0,
      ...points,
      ...layout.transitions.flatMap((region) => [region.start, region.boundary, region.end]),
      ...project.bookmarks,
      ...beats(project),
    ]),
  ].sort((a, b) => a - b);
}
export function snapFrame(frame: number, points: readonly number[], tolerance: number): number {
  let nearest = frame;
  let distance = tolerance + 1e-8;
  for (const point of points) {
    const delta = Math.abs(point - frame);
    if (delta < distance) {
      nearest = point;
      distance = delta;
    }
  }
  return nearest;
}
