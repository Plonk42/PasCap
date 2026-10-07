import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import {
  createClip,
  createProject,
  MAX_MUSIC_TRACKS,
  musicSchema,
  musicTracksSchema,
  projectSchema,
  type MusicTrack,
} from '../../src/shared/model.js';
import { projectAudioIds } from '../../src/shared/projects.js';
import { snapPoints } from '../../src/shared/snap.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

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

describe('strict schema-10 independent music instances', () => {
  it('requires an identified array, allows repeated recordings and accepts exactly eight instances', () => {
    const document = createProject('multiple-music', 'Multiple music');
    expect(document.schemaVersion).toBe(10);
    expect(document.music).toEqual([]);
    expect(MAX_MUSIC_TRACKS).toBe(8);
    const music = Array.from({ length: 8 }, (_, index) => track(`instance-${index}`, { start: index * 10 }));
    expect(projectSchema.parse({ ...document, music }).music).toEqual(music);
    expect(musicTracksSchema.parse(music)).toEqual(music);
    expect(projectSchema.safeParse({ ...document, music: [...music, track('ninth')] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...document, music: [music[0], music[0]] }).success).toBe(false);
  });
  it('rejects missing/null/object/legacy input and missing or unsafe IDs without repairing it', () => {
    const document = createProject('strict-music', 'Strict music');
    const { music: _music, ...missing } = document;
    const { id: _id, ...unidentified } = track('one');
    for (const candidate of [
      missing,
      { ...document, schemaVersion: 7 },
      ...[null, undefined, track('one'), [unidentified]].map((music) => ({ ...document, music })),
      { ...document, music: [{ ...track('one'), id: '../unsafe' }] },
      { ...document, music: [{ ...track('one'), extra: true }] },
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
        projectSchema.safeParse({ ...document, music: [track('valid'), { ...track('invalid'), ...invalid }] }).success,
      ).toBe(false);
    expect(
      projectSchema.parse({ ...document, music: [track('loop', { loop: true, duration: 200 })] }).music[0]!.duration,
    ).toBe(200);
  });
  it('uses the maximum video/music OUT, not array order or a sum, and keeps music-only tails black', () => {
    const document = createProject('duration', 'Overall project duration');
    document.clips = [createClip('clip', 'video', 0, 30)];
    document.layers[0]!.closingFade = 3;
    document.media.audioIds = ['unused', 'shared-song'];
    document.music = [
      track('two', { mediaId: 'other-song', start: 500, loop: true, duration: 1000 }),
      track('one', { start: 5 }),
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
    document.music = [track('maximum', { start: maximum - 100 })];
    expect(projectSchema.parse(document)).toEqual(document);
    expect(calculateLayout(document).duration).toBe(maximum);
    const invalidMusic = { ...document.music[0]!, start: maximum - 99 };
    expect(musicSchema.safeParse(invalidMusic).success).toBe(false);
    const invalid = { ...document, music: [invalidMusic] };
    const before = structuredClone(invalid);
    expect(projectSchema.safeParse(invalid).success).toBe(false);
    expect(() => calculateLayout(invalid)).toThrow('integer project-frame range');
    expect(invalid).toEqual(before);
    document.clips = [{ ...createClip('too-long', 'video', 0, maximum), start: 1 }];
    expect(projectSchema.safeParse(document).success).toBe(false);
    expect(() => calculateLayout(document)).toThrow('Layer duration exceeds supported project frames.');
  });
});

describe('atomic whole-array music editing', () => {
  it('changes/removes one ID without losing another instance and each replacement is one Undo', () => {
    const document = createProject('history', 'Music history');
    document.music = [track('first'), track('second', { start: 30, gainDb: -6 })];
    const history = new EditHistory(document);
    const music = document.music.map((item) =>
      item.id === 'second' ? { ...item, gainDb: -12, sourceIn: 20, duration: 90 } : item,
    );
    const edited = history.commit({ type: 'music', music });
    expect(calculateLayout(edited).duration).toBe(120);
    expect(edited.music[0]).toEqual(document.music[0]);
    expect(edited.music[1]).toMatchObject({ id: 'second', gainDb: -12, sourceIn: 20, duration: 90 });
    music[1]!.gainDb = 12;
    expect(edited.music[1]!.gainDb).toBe(-12);
    expect(history.undo()).toEqual(document);
    expect(calculateLayout(history.current).duration).toBe(130);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(edited);
    const removed = history.commit({ type: 'music', music: edited.music.filter((item) => item.id !== 'first') });
    expect(removed.music).toEqual([edited.music[1]]);
    expect(history.undo()).toEqual(edited);
    expect(document.music[1]!.gainDb).toBe(-6);
  });
  it('preserves redo/current state on no-op or rejected replacement, never partially applying another track', () => {
    const document = createProject('atomic', 'Atomic');
    document.music = [track('first'), track('second')];
    const history = new EditHistory(document);
    history.commit({ type: 'music', music: [track('first', { gainDb: -6 }), track('second')] });
    history.undo();
    expect(history.commit({ type: 'music', music: structuredClone(document.music) })).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    for (const music of [
      null,
      track('first'),
      [track('first'), track('first')],
      [{ ...track('first'), gainDb: 13 }, track('second')],
      [track('first'), { ...track('second'), start: 2_147_483_647 }],
    ]) {
      expect(() => history.commit({ type: 'music', music } as unknown as EditCommand)).toThrow();
      expect(history.current).toEqual(document);
      expect(history.canRedo).toBe(true);
    }
    expect(applyCommand(document, { type: 'music', music: [] }).music).toEqual([]);
    expect(history.redo().music[0]!.gainDb).toBe(-6);
  });
});
