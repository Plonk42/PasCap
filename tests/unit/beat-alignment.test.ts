import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import {
  boundaries,
  mergeBeats,
  musicSampleFrames,
  musicSampleRanges,
  nearestBeat,
  snapCutsToBeats,
} from '../../src/shared/beat-alignment.js';
import {
  createClip,
  createProject,
  projectSchema,
  type MusicTrack,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import type { PlacedBeat } from '../../src/shared/music-analysis.js';

function project(ripple = true): ProjectDocument {
  const base = createProject('beats', 'Beats');
  const layer = { ...base.layers[0]!, ripple };
  return projectSchema.parse({
    ...base,
    media: { videoIds: ['rec'], audioIds: [] },
    clips: ['a', 'b', 'c'].map((id, index) => ({ ...createClip(id, 'rec', 0, 60), start: index * 60 })),
    layers: [
      {
        ...layer,
        transitions: [
          { leftId: 'a', rightId: 'b', type: 'cut', duration: 0 },
          { leftId: 'b', rightId: 'c', type: 'cut', duration: 0 },
        ],
      },
    ],
  });
}

/** A beat every 15 frames from frame 5, a downbeat every fourth. */
const beats: PlacedBeat[] = Array.from({ length: 13 }, (_, index) => ({
  frame: 5 + index * 15,
  downbeat: index % 4 === 0,
  strength: 0.5,
}));

describe('beat alignment', () => {
  it('places music samples at project frames across loops', () => {
    const music: MusicTrack = {
      id: 'song',
      mediaId: 'song',
      sourceIn: 10,
      sourceOut: 40,
      start: 100,
      duration: 75,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: true,
    };
    expect(musicSampleFrames(music, 15 * MUSIC_SAMPLES_PER_FRAME)).toEqual([105, 135, 165]);
    expect(musicSampleFrames(music, 5 * MUSIC_SAMPLES_PER_FRAME)).toEqual([]);
    expect(musicSampleRanges(music, 0, 20 * MUSIC_SAMPLES_PER_FRAME)).toEqual([
      { start: 100, end: 110 },
      { start: 130, end: 140 },
      { start: 160, end: 170 },
    ]);
    expect(
      mergeBeats([
        [{ frame: 10, downbeat: false, strength: 1 }],
        [
          { frame: 10, downbeat: true, strength: 0.2 },
          { frame: 3, downbeat: false, strength: 1 },
        ],
      ]),
    ).toEqual([
      { frame: 3, downbeat: false, strength: 1 },
      { frame: 10, downbeat: true, strength: 0.2 },
    ]);
  });

  it('takes the perceived moment of cuts, dissolves and black pauses', () => {
    const cut = project();
    expect(boundaries(cut).map((item) => item.frame)).toEqual([60, 120]);
    const mixed = applyCommand(
      applyCommand(cut, {
        type: 'transition',
        transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 10 },
      }),
      { type: 'transition', transition: { leftId: 'b', rightId: 'c', type: 'fade-black-pause', fade: 4, pause: 10 } },
    );
    // The dissolve overlaps 50–60; the pause's black slot follows b's OUT at 110 for 10 frames.
    expect(boundaries(mixed).map((item) => [item.type, item.frame])).toEqual([
      ['cross-dissolve', 55],
      ['fade-black-pause', 115],
    ]);
    expect(nearestBeat(beats, 57)).toEqual({ beat: 50, offset: 7 });
    expect(nearestBeat(beats, 63)).toEqual({ beat: 65, offset: -2 });
    expect(nearestBeat([], 10)).toBeNull();
  });

  it('shortens left clips so each boundary lands on the beat at or before it', () => {
    const snapped = snapCutsToBeats(project(), 'video-1', beats, false, 30);
    expect(snapped.boundaries.map((item) => [item.before, item.beat, item.after, item.skipped])).toEqual([
      [60, 50, 50, null],
      // b moved to 50–110, and 110 is a beat.
      [110, 110, 110, null],
    ]);
    expect(snapped.commands).toEqual([{ type: 'trim', clipId: 'a', sourceIn: 0, sourceOut: 50 }]);
    const after = snapped.commands.reduce((document, command) => applyCommand(document, command), project());
    expect(boundaries(after).map((item) => item.frame)).toEqual([50, 110]);
  });

  it('snaps to downbeats only, keeps clips at their minimum length and needs Ripple', () => {
    const downbeats = snapCutsToBeats(project(), 'video-1', beats, true, 1);
    // Downbeats at 5, 65, 125, 185: a shrinks to 5 frames and b, now 5–65, already ends on one.
    expect(downbeats.boundaries.map((item) => [item.beat, item.after, item.skipped])).toEqual([
      [5, 5, null],
      [65, 65, null],
    ]);
    const minimum = snapCutsToBeats(project(), 'video-1', beats, true, 30);
    expect(minimum.commands).toEqual([]);
    expect(minimum.boundaries.map((item) => [item.beat, item.after, item.skipped !== null])).toEqual([
      [5, 60, true],
      [65, 120, true],
    ]);
    expect(() => snapCutsToBeats(project(false), 'video-1', beats, false, 30)).toThrow(/Ripple/);
    expect(() => snapCutsToBeats(project(), 'video-9', beats, false, 30)).toThrow(/video-9/);
  });
});
