import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import {
  createClip,
  createProject,
  MAX_MUSIC_CLIPS,
  MAX_MUSIC_TRACKS,
  musicClipSchema,
  musicSchema,
  musicTracksSchema,
  PROJECT_SCHEMA_VERSION,
  projectSchema,
  type MusicLane,
  type MusicTrack,
} from '../../src/shared/model.js';
import { projectAudioIds } from '../../src/shared/projects.js';
import { snapPoints } from '../../src/shared/snap.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { singleClipLane } from '../music-lanes.js';

function track(id: string, changes: Partial<MusicTrack> = {}): MusicTrack {
  return musicSchema.parse({
    id,
    mediaId: 'shared-song',
    sourceIn: 10,
    sourceOut: 110,
    start: 0,
    duration: 100,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    ...changes,
  });
}

/** A music track with one clip playing like `track(id, changes)`. */
function lane(id: string, changes: Partial<MusicTrack> = {}): MusicLane {
  return singleClipLane(track(id, changes));
}

describe('strict current-schema independent music tracks', () => {
  it('requires an identified array, allows repeated recordings and accepts exactly eight tracks', () => {
    const document = createProject('multiple-music', 'Multiple music');
    expect(document.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(document.music).toEqual([]);
    expect(MAX_MUSIC_TRACKS).toBe(8);
    const music = Array.from({ length: 8 }, (_, index) => lane(`instance-${index}`, { start: index * 10 }));
    expect(projectSchema.parse({ ...document, music }).music).toEqual(music);
    expect(musicTracksSchema.parse(music)).toEqual(music);
    expect(projectSchema.safeParse({ ...document, music: [...music, lane('ninth')] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...document, music: [music[0], music[0]] }).success).toBe(false);
  });
  it('holds one to eight clips per track with IDs unique across tracks and clips', () => {
    const document = createProject('clips', 'Music clips');
    const clips = Array.from({ length: MAX_MUSIC_CLIPS }, (_, index) => ({
      ...lane('base').clips[0]!,
      id: `clip-${index}`,
      start: index * 100,
    }));
    const transitions = clips.slice(1).map((right, index) => ({
      leftId: clips[index]!.id,
      rightId: right.id,
      type: 'cut' as const,
      duration: 0 as const,
    }));
    const full = { ...lane('full'), clips, transitions };
    expect(projectSchema.parse({ ...document, music: [full] }).music[0]!.clips).toHaveLength(8);
    const ninth = { ...clips[0]!, id: 'clip-8', start: 800 };
    for (const music of [
      [
        {
          ...full,
          clips: [...clips, ninth],
          transitions: [...transitions, { ...transitions[0]!, leftId: 'clip-7', rightId: 'clip-8' }],
        },
      ],
      [{ ...lane('empty'), clips: [], transitions: [] }],
      [lane('same-id', {}), { ...lane('other'), clips: [{ ...lane('other').clips[0]!, id: 'same-id' }] }],
      [lane('one'), { ...lane('two'), clips: [{ ...lane('two').clips[0]!, id: 'one-track' }] }],
    ])
      expect(projectSchema.safeParse({ ...document, music }).success).toBe(false);
  });
  it('rejects missing/null/object/legacy input and missing or unsafe IDs without repairing it', () => {
    const document = createProject('strict-music', 'Strict music');
    const { music: _music, ...missing } = document;
    const { id: _id, ...unidentified } = lane('one');
    for (const candidate of [
      missing,
      { ...document, schemaVersion: 7 },
      ...[null, undefined, lane('one'), [unidentified], [track('one')]].map((music) => ({ ...document, music })),
      { ...document, music: [{ ...lane('one'), id: '../unsafe' }] },
      { ...document, music: [{ ...lane('one'), extra: true }] },
      { ...document, music: [{ ...lane('one'), clips: [{ ...lane('one').clips[0]!, gainDb: 0 }] }] },
    ]) {
      const before = JSON.stringify(candidate);
      expect(projectSchema.safeParse(candidate).success).toBe(false);
      expect(JSON.stringify(candidate)).toBe(before);
    }
  });
  it('keeps source, gain, fade and non-looping validation independent for every participant', () => {
    const document = createProject('bounds', 'Bounds');
    for (const invalid of [
      { sourceOut: 10 },
      { sourceIn: -1 },
      { duration: 101 },
      { gainDb: 12.01 },
      { start: 0.5 },
      { fadeIn: 60, fadeOut: 41 },
      { loop: undefined },
    ])
      expect(
        projectSchema.safeParse({
          ...document,
          music: [lane('valid'), singleClipLane({ ...track('invalid'), ...invalid } as MusicTrack)],
        }).success,
      ).toBe(false);
    expect(
      projectSchema.parse({ ...document, music: [lane('loop', { loop: true, duration: 200 })] }).music[0]!.clips[0]!
        .duration,
    ).toBe(200);
  });
  it('uses the maximum video/music OUT, not array order or a sum, and keeps music-only tails black', () => {
    const document = createProject('duration', 'Overall project duration');
    document.clips = [createClip('clip', 'video', 0, 30)];
    document.layers[0]!.closingFade = 3;
    document.media.audioIds = ['unused', 'shared-song'];
    document.music = [
      lane('two', { mediaId: 'other-song', start: 500, loop: true, duration: 1000 }),
      lane('one', { start: 5 }),
    ];
    const before = structuredClone(document);
    const layout = calculateLayout(document);
    expect(layout.duration).toBe(1500);
    expect(layout.clips[0]!.end).toBe(30);
    expect(sampleTimeline(document, 27, layout)[0]!.brightness).toBe(1);
    expect(sampleTimeline(document, 28, layout)[0]!.brightness).toBe(0.5);
    expect(sampleTimeline(document, 29, layout)[0]!.brightness).toBe(0);
    for (const frame of [30, 105, 500, 1499]) expect(sampleTimeline(document, frame, layout)).toEqual([]);
    expect(calculateLayout({ ...document, clips: [] }).duration).toBe(1500);
    expect(calculateLayout({ ...document, music: [] }).duration).toBe(30);
    expect(calculateLayout({ ...document, clips: [], music: [] }).duration).toBe(0);
    expect(snapPoints(document)).toEqual([0, 5, 30, 105, 500, 1500]);
    expect([...projectAudioIds(document)]).toEqual(['unused', 'shared-song', 'other-song']);
    expect(document).toEqual(before);
  });
  it('accepts the maximum integer OUT and rejects overflowing music/video sums without clamping or rewriting', () => {
    const maximum = 2_147_483_647;
    const document = createProject('maximum-duration', 'Maximum duration');
    document.music = [lane('maximum', { start: maximum - 100 })];
    expect(projectSchema.parse(document)).toEqual(document);
    expect(calculateLayout(document).duration).toBe(maximum);
    const invalidMusic = { ...document.music[0]!.clips[0]!, start: maximum - 99 };
    expect(musicClipSchema.safeParse(invalidMusic).success).toBe(false);
    const invalid = { ...document, music: [{ ...document.music[0]!, clips: [invalidMusic] }] };
    const before = structuredClone(invalid);
    expect(projectSchema.safeParse(invalid).success).toBe(false);
    expect(() => calculateLayout(invalid)).toThrow('integer project-frame range');
    expect(invalid).toEqual(before);
    document.clips = [{ ...createClip('too-long', 'video', 0, maximum), start: 1 }];
    expect(projectSchema.safeParse(document).success).toBe(false);
    expect(() => calculateLayout(document)).toThrow('Track duration exceeds supported project frames.');
  });
});

describe('atomic whole-array music editing', () => {
  it('changes/removes one ID without losing another track and each replacement is one Undo', () => {
    const document = createProject('history', 'Music history');
    document.music = [lane('first'), lane('second', { start: 30, gainDb: -6 })];
    const history = new EditHistory(document);
    const music = document.music.map((item) =>
      item.id === 'second-track'
        ? { ...item, gainDb: -12, clips: [{ ...item.clips[0]!, sourceIn: 20, duration: 90 }] }
        : item,
    );
    const edited = history.commit({ type: 'music', music });
    expect(calculateLayout(edited).duration).toBe(120);
    expect(edited.music[0]).toEqual(document.music[0]);
    expect(edited.music[1]).toMatchObject({ id: 'second-track', gainDb: -12 });
    expect(edited.music[1]!.clips[0]).toMatchObject({ id: 'second', sourceIn: 20, duration: 90 });
    music[1]!.gainDb = 12;
    expect(edited.music[1]!.gainDb).toBe(-12);
    expect(history.undo()).toEqual(document);
    expect(calculateLayout(history.current).duration).toBe(130);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(edited);
    const removed = history.commit({ type: 'music', music: edited.music.filter((item) => item.id !== 'first-track') });
    expect(removed.music).toEqual([edited.music[1]]);
    expect(history.undo()).toEqual(edited);
    expect(document.music[1]!.gainDb).toBe(-6);
  });
  it('preserves redo/current state on no-op or rejected replacement, never partially applying another track', () => {
    const document = createProject('atomic', 'Atomic');
    document.music = [lane('first'), lane('second')];
    const history = new EditHistory(document);
    history.commit({ type: 'music', music: [lane('first', { gainDb: -6 }), lane('second')] });
    history.undo();
    expect(history.commit({ type: 'music', music: structuredClone(document.music) })).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    for (const music of [
      null,
      lane('first'),
      [lane('first'), lane('first')],
      [{ ...lane('first'), gainDb: 13 }, lane('second')],
      [lane('first'), { ...lane('second'), clips: [{ ...lane('second').clips[0]!, start: 2_147_483_647 }] }],
    ]) {
      expect(() => history.commit({ type: 'music', music } as unknown as EditCommand)).toThrow();
      expect(history.current).toEqual(document);
      expect(history.canRedo).toBe(true);
    }
    expect(applyCommand(document, { type: 'music', music: [] }).music).toEqual([]);
    expect(history.redo().music[0]!.gainDb).toBe(-6);
  });
});
