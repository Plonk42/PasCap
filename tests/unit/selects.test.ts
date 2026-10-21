import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createClip, createProject, MAX_SELECTS, projectSchema } from '../../src/shared/model.js';
import { removeProjectMedia } from '../../src/shared/projects.js';
import { appliedSelections, applySelectRange, keepAnotherRange } from '../../src/shared/selects.js';
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

  it('keep another range at the displayed frame, only where the kept ranges leave room', () => {
    expect(keepAnotherRange(kept, 40, 100)).toEqual({ ranges: [kept[0], range(40, 59), kept[1]], index: 1 });
    expect(keepAnotherRange(kept, 85, 100)).toEqual({ ranges: [...kept, range(85, 100)], index: 2 });
    expect(keepAnotherRange(kept, 2, 100)).toEqual({ ranges: [range(2, 9), ...kept], index: 0 });
    expect(keepAnotherRange([range(10, 30)], 40, 200)).toEqual({ ranges: [range(10, 30), range(40, 70)], index: 1 });
    for (const frame of [10, 20, 30, 80, 60])
      expect(keepAnotherRange(kept, frame, 100)).toMatchObject({ reason: expect.stringContaining('outside') });
    expect(keepAnotherRange([range(0, 30), range(33, 50)], 31, 100)).toEqual({
      ranges: [range(0, 30), range(31, 32), range(33, 50)],
      index: 1,
    });
    expect(keepAnotherRange([range(0, 30), range(33, 50)], 32, 100)).toMatchObject({
      reason: expect.stringContaining('no room'),
    });
    expect(keepAnotherRange(kept, 99, 100)).toEqual({ ranges: [...kept, range(99, 100)], index: 2 });
    expect(keepAnotherRange(kept, 100, 100)).toMatchObject({ reason: expect.stringContaining('no room') });
    const crowded = Array.from({ length: MAX_SELECTS }, (_, index) => range(index * 3, index * 3 + 1));
    expect(keepAnotherRange(crowded, 1_000, 2_000)).toMatchObject({ reason: expect.stringContaining('at most') });
  });
});
