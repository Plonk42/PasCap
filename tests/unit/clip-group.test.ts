import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { addTrackClips, groupNudge, groupWithin, toggleClip } from '../../src/web/clip-selection.js';
import { planTimelineDrop } from '../../src/web/timeline-placement.js';

/** Track 1 (Ripple) holds a, b, c, d of 30, 40, 50 and 60 frames; Track 2 (Ripple off) holds e and f. */
function project(): ProjectDocument {
  const document = createProject('group', 'Group moves');
  document.media.videoIds = ['recording'];
  document.layers.push(createLayer('free', 'Track 2', false));
  document.clips = [
    createClip('a', 'recording', 0, 30),
    { ...createClip('b', 'recording', 0, 40), start: 30 },
    { ...createClip('c', 'recording', 0, 50), start: 70 },
    { ...createClip('d', 'recording', 0, 60), start: 120 },
    { ...createClip('e', 'recording', 0, 20, 'free'), start: 10 },
    { ...createClip('f', 'recording', 0, 20, 'free'), start: 100 },
  ];
  document.layers[0]!.transitions = ['a', 'b', 'c'].map((leftId, index) => ({
    leftId,
    rightId: ['b', 'c', 'd'][index]!,
    type: 'cut' as const,
    duration: 0 as const,
  }));
  document.layers[1]!.transitions = [{ leftId: 'e', rightId: 'f', type: 'cut', duration: 0 }];
  return projectSchema.parse(document);
}

function move(clipIds: string[], delta: number, layerId: string | null = null): EditCommand {
  return { type: 'move-clips', clipIds, delta, layerId };
}

function placements(document: ProjectDocument): Record<string, [string, number]> {
  return Object.fromEntries(
    calculateLayout(document).clips.map((placed) => [placed.clip.id, [placed.clip.layerId, placed.start]]),
  );
}

describe('moving several selected clips together', () => {
  it('shifts clips on several Ripple-off tracks by the same delta, each on its own track', () => {
    const document = project();
    document.layers[0]!.ripple = false;
    const next = applyCommand(document, move(['d', 'e'], 15));
    expect(placements(next)).toMatchObject({
      a: ['video-1', 0],
      d: ['video-1', 135],
      e: ['free', 25],
      f: ['free', 100],
    });
  });

  it('moves clips from one track to the destination track, keeping their offsets on a Ripple-off track', () => {
    const next = applyCommand(project(), move(['b', 'c'], 170, 'free'));
    expect(placements(next)).toMatchObject({
      a: ['video-1', 0],
      d: ['video-1', 30],
      b: ['free', 200],
      c: ['free', 240],
      e: ['free', 10],
      f: ['free', 100],
    });
    expect(next.layers[0]!.transitions).toEqual([{ leftId: 'a', rightId: 'd', type: 'cut', duration: 0 }]);
    expect(next.layers[1]!.transitions.map((item) => [item.leftId, item.rightId])).toEqual([
      ['e', 'f'],
      ['f', 'b'],
      ['b', 'c'],
    ]);
  });

  it('leaves a Ripple track unchanged for a zero delta, even with separated selected clips', () => {
    const document = project();
    expect(applyCommand(document, move(['b', 'd'], 0))).toEqual(document);
    expect(applyCommand(document, move(['b', 'c'], 0))).toEqual(document);
  });

  it('reorders a Ripple track by moving consecutive selected clips as one block to the nearest slot', () => {
    const next = applyCommand(project(), move(['b', 'c'], 60));
    expect(layerOrder(next, 'video-1')).toEqual(['a', 'd', 'b', 'c']);
    expect(placements(next)).toMatchObject({ a: ['video-1', 0], d: ['video-1', 30], b: ['video-1', 90] });
    // The pair that stays adjacent keeps its transition; new pairs are cuts.
    expect(next.layers[0]!.transitions.map((item) => [item.leftId, item.rightId])).toEqual([
      ['a', 'd'],
      ['d', 'b'],
      ['b', 'c'],
    ]);
  });

  it('inserts clips from another track as one block in a Ripple destination', () => {
    const next = applyCommand(project(), move(['e', 'f'], 65, 'video-1'));
    expect(layerOrder(next, 'video-1')).toEqual(['a', 'b', 'e', 'f', 'c', 'd']);
    expect(next.clips.filter((clip) => clip.layerId === 'free')).toEqual([]);
  });

  it('moves a Ripple anchor only when the track’s first clip moves and stays first', () => {
    const anchored = applyCommand(project(), move(['a', 'e'], 12));
    expect(placements(anchored)).toMatchObject({ a: ['video-1', 12], b: ['video-1', 42], e: ['free', 22] });
    const later = applyCommand(project(), move(['c', 'e'], 1));
    expect(placements(later)).toMatchObject({ a: ['video-1', 0], c: ['video-1', 70], e: ['free', 11] });
  });

  it('rejects the whole move instead of clamping, merging or partially applying it', () => {
    const document = project();
    document.layers[0]!.ripple = false;
    expect(() => applyCommand(document, move(['a', 'e'], -11))).toThrow('cannot start before timeline frame 0');
    expect(() => applyCommand(document, move(['e'], 80))).toThrow(/overlap/);
    expect(() => applyCommand(document, move(['a', 'e'], 5, 'free'))).toThrow('move in time only');
    expect(() => applyCommand(document, move(['a', 'a'], 5))).toThrow('each clip once');
    expect(() => applyCommand(document, move(['a', 'missing'], 5))).toThrow('no longer exists');
  });

  it('is one Undo step', () => {
    const document = project();
    const history = new EditHistory(document);
    history.commit(move(['b', 'c'], 60));
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
  });
});

function layerOrder(document: ProjectDocument, layerId: string): string[] {
  return calculateLayout(document)
    .clips.filter((placed) => placed.clip.layerId === layerId)
    .map((placed) => placed.clip.id);
}

describe('selecting several clips', () => {
  it('Ctrl/Cmd-click adds a clip as the primary one, or removes a selected one', () => {
    expect(toggleClip({ primary: null, group: [] }, 'a')).toEqual({ primary: 'a', group: [] });
    const two = toggleClip({ primary: 'a', group: [] }, 'e');
    expect(two).toEqual({ primary: 'e', group: ['a', 'e'] });
    expect(toggleClip(two, 'b')).toEqual({ primary: 'b', group: ['a', 'e', 'b'] });
    expect(toggleClip(two, 'a')).toEqual({ primary: 'e', group: [] });
    expect(toggleClip(two, 'e')).toEqual({ primary: 'a', group: [] });
    // The last selected clip stays selected.
    expect(toggleClip({ primary: 'a', group: [] }, 'a')).toEqual({ primary: 'a', group: [] });
  });

  it('Select all clips adds a track’s clips to the selection, keeping the primary clip', () => {
    const document = project();
    expect(addTrackClips({ primary: 'e', group: [] }, document, 'video-1')).toEqual({
      primary: 'e',
      group: ['e', 'a', 'b', 'c', 'd'],
    });
    expect(addTrackClips({ primary: null, group: [] }, document, 'free')).toEqual({ primary: 'e', group: ['e', 'f'] });
    expect(groupWithin(['a', 'gone', 'e'], document)).toEqual(['a', 'e']);
    expect(groupWithin(['a', 'gone'], document)).toEqual([]);
  });

  it('Alt+arrow nudges the whole group, explaining a group that Ripple keeps in place', () => {
    const document = project();
    expect(groupNudge(document, ['e', 'f'], 1)).toEqual(move(['e', 'f'], 1));
    expect(groupNudge(document, ['b', 'c'], 1)).toContain('Ripple');
    expect(groupNudge(document, ['e', 'f'], -11)).toContain('cannot start before timeline frame 0');
  });
});

describe('dragging selected clips', () => {
  const group = (clipIds: string[], clipId: string) => ({ kind: 'group' as const, clipIds, clipId, grabFrame: 0 });

  it('moves clips from one track to the track under the pointer, with a ghost for each', () => {
    const plan = planTimelineDrop(project(), group(['b', 'c'], 'b'), 'free', 200, false, 8, 0);
    expect(plan).toMatchObject({
      layerId: 'free',
      start: 200,
      duration: 40,
      error: '',
      command: move(['b', 'c'], 170, 'free'),
    });
    expect(plan.ghosts).toEqual([
      { clipId: 'b', layerId: 'free', start: 200, duration: 40 },
      { clipId: 'c', layerId: 'free', start: 240, duration: 50 },
    ]);
  });

  it('keeps clips from several tracks on their own tracks', () => {
    const plan = planTimelineDrop(project(), group(['d', 'e'], 'e'), 'video-1', 25, false, 8, 0);
    expect(plan.command).toEqual(move(['d', 'e'], 15));
    expect(plan.ghosts).toEqual([
      { clipId: 'd', layerId: 'video-1', start: 120, duration: 60 },
      { clipId: 'e', layerId: 'free', start: 25, duration: 20 },
    ]);
  });

  it('snaps any moved edge on a Ripple-off destination, never to the moved clips themselves', () => {
    const plan = planTimelineDrop(project(), group(['e', 'f'], 'e'), 'free', 25, true, 5, 500);
    expect(plan).toMatchObject({ start: 30, guide: 30, command: move(['e', 'f'], 20, 'free') });
  });

  it('shows a red ghost and commits nothing for an invalid move', () => {
    const plan = planTimelineDrop(project(), group(['e', 'f'], 'e'), 'free', -5, false, 8, 0);
    expect(plan.command).toBeNull();
    expect(plan.error).toContain('cannot start before timeline frame 0');
    expect(plan.ghosts?.map((ghost) => ghost.start)).toEqual([-5, 85]);
  });
});
