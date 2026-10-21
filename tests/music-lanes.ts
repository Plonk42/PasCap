import type { MusicLane, MusicTrack } from '../src/shared/model.js';

/**
 * A music track holding one clip that plays exactly like `track`, as the schema-24 upgrade builds it:
 * the clip keeps the ID, recording, range, placement and loop; the track takes the gain and fades.
 */
export function singleClipLane(track: MusicTrack, laneId = `${track.id}-track`): MusicLane {
  const { gainDb, fadeIn, fadeOut, ...clip } = track;
  return {
    id: laneId,
    gainDb,
    ripple: false,
    openingFade: fadeIn,
    closingFade: fadeOut,
    clips: [clip],
    transitions: [],
  };
}

export function singleClipLanes(tracks: readonly MusicTrack[]): MusicLane[] {
  return tracks.map((track) => singleClipLane(track));
}
