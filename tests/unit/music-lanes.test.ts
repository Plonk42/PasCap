import { describe, expect, it } from 'vitest';
import type { AudioAsset } from '../../src/shared/audio.js';
import {
  createProject,
  musicTracksSchema,
  type MusicClip,
  type MusicLane,
  type ProjectDocument,
} from '../../src/shared/model.js';
import {
  arrangeMusicLane,
  insertMusicClip,
  moveMusicClip,
  musicTracks,
  removeMusicClips,
  setMusicRipple,
  setMusicTransition,
  validateMusicLane,
} from '../../src/shared/music-lanes.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  createMusicClip,
  createMusicLane,
  musicClipEdit,
  musicEditError,
  nextMusicSelection,
  planMusicGesture,
} from '../../src/web/music-ui.js';

function clip(id: string, start: number, duration = 100, changes: Partial<MusicClip> = {}): MusicClip {
  return { id, mediaId: 'song', sourceIn: 0, sourceOut: 1000, start, duration, loop: false, ...changes };
}

/** A music track holding these clips joined by cuts. */
function lane(clips: MusicClip[], changes: Partial<Omit<MusicLane, 'clips' | 'transitions'>> = {}): MusicLane {
  const empty: MusicLane = {
    id: 'lane',
    gainDb: 0,
    ripple: false,
    openingFade: 0,
    closingFade: 0,
    clips: [],
    transitions: [],
    ...changes,
  };
  return arrangeMusicLane(empty, clips);
}

const starts = (music: MusicLane): number[] => music.clips.map((item) => item.start);
const ids = (music: MusicLane): string[] => music.clips.map((item) => item.id);

function project(...lanes: MusicLane[]): ProjectDocument {
  return { ...createProject('music-lanes', 'Music lanes'), music: lanes };
}

describe('music track clips and transitions', () => {
  it('plays each clip with its track gain, the track fades at its ends and transition fades between clips', () => {
    let music = lane([clip('a', 0), clip('b', 100), clip('c', 200)], { gainDb: -6, openingFade: 10, closingFade: 20 });
    music = setMusicTransition(music, 0, 'crossfade', 30);
    music = setMusicTransition(music, 1, 'fade-through-silence', 21);
    expect(starts(music)).toEqual([0, 70, 170]);
    expect(() => validateMusicLane(music)).not.toThrow();
    const base = { mediaId: 'song', sourceIn: 0, sourceOut: 1000, duration: 100, gainDb: -6, loop: false };
    expect(musicTracks([music])).toEqual([
      { ...base, id: 'a', start: 0, fadeIn: 10, fadeOut: 30 },
      { ...base, id: 'b', start: 70, fadeIn: 30, fadeOut: 11 },
      { ...base, id: 'c', start: 170, fadeIn: 10, fadeOut: 20 },
    ]);
  });

  it('rejects misplaced clips, triple overlaps, fades that do not fit and mismatched transitions', () => {
    let joined = lane([clip('a', 0), clip('b', 100), clip('c', 200)]);
    joined = setMusicTransition(setMusicTransition(joined, 0, 'crossfade', 30), 1, 'fade-through-silence', 20);
    const moved = (id: string, start: number): MusicLane => ({
      ...joined,
      clips: joined.clips.map((item) => (item.id === id ? { ...item, start } : item)),
    });
    const ripple = setMusicRipple(lane([clip('a', 0), clip('b', 100)]), true);
    const triple = setMusicTransition(setMusicTransition(joined, 0, 'crossfade', 80), 1, 'crossfade', 80);
    const cases: [MusicLane, string][] = [
      [lane([clip('a', 0), clip('b', 50)]), 'cannot overlap except in a crossfade'],
      [{ ...ripple, clips: [ripple.clips[0]!, { ...ripple.clips[1]!, start: 120 }] }, 'one after another'],
      [moved('b', 60), 'crossfade must overlap its two clips by exactly its duration'],
      [moved('c', 180), 'requires touching music clips'],
      [triple, 'triple overlap'],
      [{ ...joined, openingFade: 80 }, 'Fades and transitions overlap or exceed clip 1 of music track 1'],
      [{ ...joined, transitions: joined.transitions.slice(1) }, 'Exactly one transition is required'],
      [{ ...joined, transitions: [...joined.transitions].reverse() }, 'ordered adjacent clip pairs'],
    ];
    for (const [invalid, message] of cases) {
      const before = structuredClone(invalid);
      expect(() => validateMusicLane(invalid)).toThrow(message);
      expect(() => calculateLayout(project(invalid))).toThrow(message);
      expect(invalid).toEqual(before);
    }
  });

  it('turning Ripple on closes gaps from the first start and keeps overlaps; off keeps every start', () => {
    const packed = setMusicRipple(lane([clip('a', 50), clip('b', 300), clip('c', 600)]), true);
    expect(starts(packed)).toEqual([50, 150, 250]);
    const crossfaded = setMusicTransition(packed, 0, 'crossfade', 30);
    expect(starts(crossfaded)).toEqual([50, 120, 220]);
    expect(starts(setMusicRipple(crossfaded, false))).toEqual([50, 120, 220]);
  });

  it('adds clips in start order without Ripple and at the nearest sequence slot with it', () => {
    const joined = setMusicTransition(lane([clip('a', 0), clip('b', 200)]), 0, 'crossfade', 30);
    const appended = insertMusicClip(joined, clip('z', 500));
    expect(ids(appended)).toEqual(['a', 'b', 'z']);
    expect(appended.transitions).toEqual([
      { leftId: 'a', rightId: 'b', type: 'crossfade', duration: 30 },
      { leftId: 'b', rightId: 'z', type: 'cut', duration: 0 },
    ]);
    const between = insertMusicClip(lane([clip('a', 0), clip('c', 400)]), clip('b', 200));
    expect(ids(between)).toEqual(['a', 'b', 'c']);
    expect(between.transitions.map((transition) => transition.type)).toEqual(['cut', 'cut']);
    const ripple = setMusicRipple(lane([clip('a', 10), clip('b', 110)]), true);
    const front = insertMusicClip(ripple, clip('n', 0, 50));
    expect(ids(front)).toEqual(['n', 'a', 'b']);
    expect(starts(front)).toEqual([10, 60, 160]);
    expect(starts(insertMusicClip(ripple, clip('m', 1000)))).toEqual([10, 110, 210]);
    const full = lane(Array.from({ length: 8 }, (_, index) => clip(`clip-${index}`, index * 100)));
    expect(() => insertMusicClip(full, clip('ninth', 900))).toThrow('at most 8 clips');
  });

  it('removes clips, closing a Ripple gap from the existing first start, and never empties a track', () => {
    const ripple = setMusicRipple(lane([clip('a', 10), clip('b', 110), clip('c', 210)]), true);
    const middle = removeMusicClips(ripple, new Set(['b']))!;
    expect(starts(middle)).toEqual([10, 110]);
    expect(middle.transitions).toEqual([{ leftId: 'a', rightId: 'c', type: 'cut', duration: 0 }]);
    expect(starts(removeMusicClips(ripple, new Set(['a']))!)).toEqual([10, 110]);
    const spaced = lane([clip('a', 0), clip('b', 200), clip('c', 400)]);
    expect(starts(removeMusicClips(spaced, new Set(['a']))!)).toEqual([200, 400]);
    expect(removeMusicClips(spaced, new Set(['a', 'b', 'c']))).toBeNull();
    expect(removeMusicClips(spaced, new Set(['elsewhere']))).toBe(spaced);
  });

  it('moves clips by start without Ripple and by sequence slot with it', () => {
    const spaced = lane([clip('a', 0), clip('b', 200), clip('c', 400)]);
    const last = moveMusicClip(spaced, 'a', 500);
    expect(ids(last)).toEqual(['b', 'c', 'a']);
    expect(starts(last)).toEqual([200, 400, 500]);
    const ripple = setMusicRipple(lane([clip('a', 0), clip('b', 100), clip('c', 200)]), true);
    const reordered = moveMusicClip(ripple, 'b', 220);
    expect(ids(reordered)).toEqual(['a', 'c', 'b']);
    expect(starts(reordered)).toEqual([0, 100, 200]);
    expect(starts(moveMusicClip(ripple, 'a', 40))).toEqual([40, 140, 240]);
    const later = setMusicRipple(lane([clip('a', 100), clip('b', 200), clip('c', 300)]), true);
    const front = moveMusicClip(later, 'c', 0);
    expect(ids(front)).toEqual(['c', 'a', 'b']);
    expect(starts(front)).toEqual([100, 200, 300]);
    expect(() => moveMusicClip(spaced, 'missing', 0)).toThrow('unavailable');
  });

  it('sets a transition moving only its right clip without Ripple, re-sequencing with it', () => {
    const spaced = lane([clip('a', 0), clip('b', 200), clip('c', 400)]);
    const crossfaded = setMusicTransition(spaced, 0, 'crossfade', 30);
    expect(starts(crossfaded)).toEqual([0, 70, 400]);
    expect(starts(setMusicTransition(crossfaded, 0, 'cut', 0))).toEqual([0, 100, 400]);
    const cut = setMusicTransition(spaced, 0, 'cut', 99);
    expect(starts(cut)).toEqual([0, 200, 400]);
    expect(cut.transitions[0]).toEqual({ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 });
    const ripple = setMusicRipple(lane([clip('a', 0), clip('b', 100), clip('c', 200)]), true);
    expect(starts(setMusicTransition(ripple, 0, 'crossfade', 30))).toEqual([0, 70, 170]);
    expect(() => setMusicTransition(spaced, 2, 'crossfade', 30)).toThrow('no following clip');
    expect(() => setMusicTransition(spaced, 0, 'crossfade', 101)).toThrow('cannot be longer than either clip');
  });
});

describe('music editing helpers', () => {
  const asset = { id: 'song', metadata: { frameCount: 300 } } as AudioAsset;

  it('creates a track as long as the video or the recording and clips of the whole recording', () => {
    expect(createMusicLane('track', 'first', asset, 120)).toEqual({
      id: 'track',
      gainDb: 0,
      ripple: false,
      openingFade: 0,
      closingFade: 0,
      clips: [{ id: 'first', mediaId: 'song', sourceIn: 0, sourceOut: 300, start: 0, duration: 120, loop: false }],
      transitions: [],
    });
    expect(createMusicLane('track', 'first', asset, 0).clips[0]!.duration).toBe(300);
    expect(createMusicClip('next', asset, 50)).toMatchObject({ start: 50, duration: 300, loop: false });
    expect(createMusicClip('long', asset, 0, 600)).toMatchObject({ duration: 600, loop: true });
  });

  it('edits one clip, re-sequencing a Ripple track and reordering by a new start', () => {
    const ripple = setMusicRipple(lane([clip('a', 0), clip('b', 100), clip('c', 200)]), true);
    const shorter = musicClipEdit(project(ripple), 'a', { duration: 50 });
    expect(starts(shorter.music[0]!)).toEqual([0, 50, 150]);
    const spaced = lane([clip('a', 0), clip('b', 200)]);
    const moved = musicClipEdit(project(spaced), 'a', { start: 400 });
    expect(ids(moved.music[0]!)).toEqual(['b', 'a']);
    expect(() => musicClipEdit(project(spaced), 'missing', { start: 0 })).toThrow('unavailable');
  });

  it('plans trims and moves within source limits, rejecting conflicts instead of shortening them', () => {
    const ripple = setMusicRipple(lane([clip('a', 0, 100, { sourceIn: 50 }), clip('b', 100)]), true);
    const document = project(ripple);
    const trimmed = planMusicGesture(document, 'a', 'in', 20);
    expect(trimmed.error).toBe('');
    expect(trimmed.track).toMatchObject({ id: 'a', start: 0, sourceIn: 70, duration: 80 });
    expect(starts(trimmed.document.music[0]!)).toEqual([0, 80]);
    expect(planMusicGesture(document, 'a', 'in', -80).track).toMatchObject({ sourceIn: 0, duration: 150 });
    expect(planMusicGesture(document, 'b', 'out', 5000).track.duration).toBe(1000);
    expect(planMusicGesture(document, 'a', 'move', 0).command).toBeNull();
    const fading = setMusicTransition(lane([clip('a', 0), clip('b', 100)]), 0, 'crossfade', 60);
    const conflict = planMusicGesture(project(fading), 'b', 'out', -60);
    expect(conflict.error).toContain('Fades and transitions overlap or exceed clip 2 of music track 1');
    expect(conflict.document).toEqual(project(fading));
    expect(conflict.command).toBeNull();
  });

  it('reports the first schema reason of a refused edit, not the whole report', () => {
    const invalid = musicTracksSchema.safeParse([{ id: 'only' }]);
    expect(invalid.success).toBe(false);
    expect(musicEditError(invalid.error, 'fallback')).toBe(invalid.error!.issues[0]!.message);
    expect(musicEditError(new Error('Readable reason.'), 'fallback')).toBe('Readable reason.');
    expect(musicEditError('thrown text', 'fallback')).toBe('fallback');
  });

  it('selects an added clip, keeps the selection, else its neighbour on the same track', () => {
    const before = project(lane([clip('a', 0), clip('b', 100), clip('c', 200)]), {
      ...lane([clip('x', 0)]),
      id: 'other',
    });
    expect(nextMusicSelection(null, before, null)).toBe('a');
    expect(nextMusicSelection(before, before, 'b')).toBe('b');
    const added = { ...before, music: [insertMusicClip(before.music[0]!, clip('d', 300)), before.music[1]!] };
    expect(nextMusicSelection(before, added, 'b')).toBe('d');
    const removed = { ...before, music: [removeMusicClips(before.music[0]!, new Set(['b']))!, before.music[1]!] };
    expect(nextMusicSelection(before, removed, 'b')).toBe('c');
    const lastRemoved = { ...before, music: [removeMusicClips(before.music[0]!, new Set(['c']))!, before.music[1]!] };
    expect(nextMusicSelection(before, lastRemoved, 'c')).toBe('b');
    expect(nextMusicSelection(before, { ...before, music: [before.music[1]!] }, 'b')).toBe('x');
    expect(nextMusicSelection(before, { ...before, music: [] }, 'x')).toBeNull();
  });
});
