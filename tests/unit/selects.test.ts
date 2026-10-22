import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createClip, createProject, MAX_SELECTS, projectSchema } from '../../src/shared/model.js';
import { removeProjectMedia } from '../../src/shared/projects.js';
import {
  addKeptRange,
  appliedSelections,
  applySelectRange,
  freeStretchAt,
  freeStretches,
  insertKeptRange,
  keptRangeBounds,
  removeKeptRange,
} from '../../src/shared/selects.js';
import { validateSourceRanges } from '../../src/shared/source-range.js';

function project() {
  const document = createProject('selects', 'Selects');
  document.media.videoIds = ['recording', 'other'];
  document.clips = [createClip('clip', 'recording', 0, 90)];
  return projectSchema.parse(document);
}
const range = (sourceIn: number, sourceOut: number) => ({ sourceIn, sourceOut });

describe('project selects', () => {
  it('start empty and require ascending, separated ranges of recordings in the bin, without defaults', () => {
    const document = project();
    expect(document.selects).toEqual({});
    const parse = (selects: unknown) => projectSchema.safeParse({ ...document, selects }).success;
    expect(parse({ recording: [range(0, 30), range(31, 60)] })).toBe(true);
    for (const selects of [
      { recording: [] },
      { recording: [range(10, 10)] },
      { recording: [range(10, 5)] },
      { recording: [range(0, 30), range(30, 60)] },
      { recording: [range(40, 60), range(0, 30)] },
      { recording: [range(0, 30), range(20, 60)] },
      { recording: [range(-1, 30)] },
      { recording: [{ sourceIn: 0, sourceOut: 30, extra: 1 }] },
      { missing: [range(0, 30)] },
      { recording: [range(0, 1.5)] },
      null,
    ])
      expect(parse(selects)).toBe(false);
    const missing: Record<string, unknown> = { ...document };
    delete missing['selects'];
    expect(projectSchema.safeParse(missing).success).toBe(false);
    const many = Array.from({ length: MAX_SELECTS + 1 }, (_, index) => range(index * 2, index * 2 + 1));
    expect(parse({ recording: many })).toBe(false);
  });

  it('are set, narrowed and cleared in one Undo step each and never touch clips or timing', () => {
    const history = new EditHistory(project());
    const before = history.current;
    history.commit({ type: 'select-set', mediaId: 'recording', ranges: [range(0, 60), range(70, 90)] });
    expect(history.current.selects).toEqual({ recording: [range(0, 60), range(70, 90)] });
    expect(history.current.clips).toEqual(before.clips);
    history.commit({ type: 'select-narrow', mediaId: 'recording', ranges: [range(10, 20), range(70, 80)] });
    expect(history.current.selects['recording']).toEqual([range(10, 20), range(70, 80)]);
    history.commit({ type: 'select-set', mediaId: 'recording', ranges: [] });
    expect(history.current.selects).toEqual({});
    expect(history.undo().selects['recording']).toEqual([range(10, 20), range(70, 80)]);
    expect(history.undo().selects['recording']).toEqual([range(0, 60), range(70, 90)]);
    expect(history.undo()).toEqual(before);
  });

  it('reject invalid ranges, unknown recordings and a narrowing that adds frames, atomically', () => {
    const base = applyCommand(project(), { type: 'select-set', mediaId: 'recording', ranges: [range(10, 40)] });
    const attempt = (command: Parameters<typeof applyCommand>[1]) => () => applyCommand(base, command);
    expect(attempt({ type: 'select-set', mediaId: 'recording', ranges: [range(30, 20)] })).toThrow();
    expect(attempt({ type: 'select-set', mediaId: 'recording', ranges: [range(0, 10), range(10, 20)] })).toThrow(
      'ascending and separated',
    );
    expect(attempt({ type: 'select-set', mediaId: 'nowhere', ranges: [range(0, 10)] })).toThrow(
      'belongs to this project',
    );
    expect(attempt({ type: 'select-narrow', mediaId: 'recording', ranges: [range(5, 20)] })).toThrow('already kept');
    expect(attempt({ type: 'select-narrow', mediaId: 'recording', ranges: [range(10, 20), range(30, 41)] })).toThrow(
      'already kept',
    );
    expect(attempt({ type: 'select-narrow', mediaId: 'recording', ranges: [] })).toThrow('at least one range');
    expect(base.selects).toEqual({ recording: [range(10, 40)] });
    // A recording without selects is wholly available: any narrowing of it is a subset.
    expect(
      applyCommand(base, { type: 'select-narrow', mediaId: 'other', ranges: [range(3, 9)] }).selects['other'],
    ).toEqual([range(3, 9)]);
  });

  it('keep a recording that only clips refer to in the bin', () => {
    const document = project();
    document.media.videoIds = [];
    const next = applyCommand(document, { type: 'select-set', mediaId: 'recording', ranges: [range(0, 9)] });
    expect(next.media.videoIds).toEqual(['recording']);
  });

  it('leave with the recording when it is removed from the project', () => {
    const document = applyCommand(project(), {
      type: 'select-set',
      mediaId: 'other',
      ranges: [range(0, 9)],
    });
    const both = applyCommand(document, { type: 'select-set', mediaId: 'recording', ranges: [range(0, 9)] });
    expect(removeProjectMedia(both, { videoIds: ['other'], audioIds: [] }).selects).toEqual({
      recording: [range(0, 9)],
    });
    expect(removeProjectMedia(both, { videoIds: ['recording'], audioIds: [] }).selects).toEqual({
      other: [range(0, 9)],
    });
  });

  it('must lie within the registered recording', () => {
    const document = applyCommand(project(), { type: 'select-set', mediaId: 'other', ranges: [range(0, 50)] });
    const counts = new Map([
      ['recording', 90],
      ['other', 50],
    ]);
    expect(() => validateSourceRanges(document, counts)).not.toThrow();
    expect(() => validateSourceRanges(document, new Map([...counts, ['other', 49]]))).toThrow('Kept ranges exceed');
    expect(() => validateSourceRanges(document, new Map([['recording', 90]]))).toThrow('Kept ranges exceed');
  });
});

describe('Source preview selects', () => {
  const kept = [range(10, 30), range(60, 80)];

  it('show the active kept range per recording and none for whole recordings', () => {
    expect(appliedSelections({}, {})).toEqual({});
    expect(appliedSelections({ a: kept }, {})).toEqual({ a: { mediaId: 'a', ...kept[0] } });
    expect(appliedSelections({ a: kept }, { a: 1 })).toEqual({ a: { mediaId: 'a', ...kept[1] } });
    expect(appliedSelections({ a: kept }, { a: 7 })).toEqual({ a: { mediaId: 'a', ...kept[1] } });
  });

  it('apply a range to the active kept range, the first creating the entry', () => {
    const apply = (list: typeof kept, chosen: number | undefined, sourceIn: number, sourceOut: number) =>
      applySelectRange(list, chosen, { mediaId: 'a', sourceIn, sourceOut }, 100);
    expect(apply([], undefined, 5, 50)).toEqual({ type: 'select-set', mediaId: 'a', ranges: [range(5, 50)] });
    expect(apply(kept, 1, 62, 90)).toEqual({
      type: 'select-set',
      mediaId: 'a',
      ranges: [range(10, 30), range(62, 90)],
    });
    // The whole recording removes the active range, and the entry when it is the only one.
    expect(apply([range(5, 50)], 0, 0, 100)).toEqual({ type: 'select-set', mediaId: 'a', ranges: [] });
    expect(apply(kept, 0, 0, 100)).toEqual({ type: 'select-set', mediaId: 'a', ranges: [range(60, 80)] });
    expect(apply([], undefined, 0, 100)).toBeNull();
  });

  it('find the free stretches at least one frame from every kept range', () => {
    expect(freeStretches([], 100)).toEqual([{ from: 0, to: 100 }]);
    expect(freeStretches(kept, 100)).toEqual([
      { from: 0, to: 9 },
      { from: 31, to: 59 },
      { from: 81, to: 100 },
    ]);
    expect(freeStretches([range(0, 30), range(32, 100)], 100)).toEqual([]);
    expect(freeStretches([range(0, 30), range(33, 100)], 100)).toEqual([{ from: 31, to: 32 }]);
    expect(freeStretchAt(kept, 31, 100)).toEqual({ from: 31, to: 59 });
    for (const frame of [9, 10, 30, 59, 80]) expect(freeStretchAt(kept, frame, 100)).toBeNull();
  });

  it('add a range from a free displayed frame, else centred in the largest free stretch', () => {
    expect(addKeptRange([], 20, 200)).toEqual({ range: range(20, 80) });
    expect(addKeptRange(kept, 40, 100)).toEqual({ range: range(40, 59) });
    expect(addKeptRange(kept, 2, 100)).toEqual({ range: range(2, 9) });
    expect(addKeptRange(kept, 99, 100)).toEqual({ range: range(99, 100) });
    // On a kept range: the largest stretch, 31–59, takes all of its 28 frames.
    for (const frame of [10, 20, 30, 60, 80]) expect(addKeptRange(kept, frame, 100)).toEqual({ range: range(31, 59) });
    expect(addKeptRange([range(100, 120)], 110, 400)).toEqual({ range: range(230, 290) });
    expect(addKeptRange([range(0, 30), range(32, 100)], 10, 100)).toMatchObject({
      reason: expect.stringContaining('no room'),
    });
    const crowded = Array.from({ length: MAX_SELECTS }, (_, index) => range(index * 3, index * 3 + 1));
    expect(addKeptRange(crowded, 1_000, 2_000)).toMatchObject({ reason: expect.stringContaining('at most') });
  });

  it('insert a range in source order and refuse one that touches another, never merging it', () => {
    expect(insertKeptRange(kept, range(40, 50))).toEqual({ ranges: [kept[0], range(40, 50), kept[1]], index: 1 });
    expect(insertKeptRange(kept, range(0, 9))).toEqual({ ranges: [range(0, 9), ...kept], index: 0 });
    expect(insertKeptRange([], range(5, 6))).toEqual({ ranges: [range(5, 6)], index: 0 });
    for (const touching of [range(0, 10), range(30, 40), range(31, 60), range(20, 25), range(0, 100)])
      expect(insertKeptRange(kept, touching)).toMatchObject({ reason: expect.stringContaining('one frame away') });
  });

  it('remove a range, keeping the edited one or moving to its neighbour', () => {
    const three = [range(0, 10), range(20, 30), range(40, 50)];
    expect(removeKeptRange(three, 1, 1)).toEqual({ ranges: [three[0], three[2]], active: 1 });
    expect(removeKeptRange(three, 2, 2)).toEqual({ ranges: [three[0], three[1]], active: 1 });
    expect(removeKeptRange(three, 0, 2)).toEqual({ ranges: [three[1], three[2]], active: 1 });
    expect(removeKeptRange(three, 2, 0)).toEqual({ ranges: [three[0], three[1]], active: 0 });
    expect(removeKeptRange([range(0, 10)], 0, 0)).toEqual({ ranges: [], active: 0 });
  });

  it('bound the active range one frame from its neighbours', () => {
    expect(keptRangeBounds([], 0, 100)).toEqual({ minIn: 0, maxOut: 100 });
    expect(keptRangeBounds(kept, 0, 100)).toEqual({ minIn: 0, maxOut: 59 });
    expect(keptRangeBounds(kept, 1, 100)).toEqual({ minIn: 31, maxOut: 100 });
  });
});
