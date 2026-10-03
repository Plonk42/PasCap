import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createClip, createProject, projectSchema } from '../../src/shared/model.js';
import { blackFadeParts, calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { formatTimecode, framesToSeconds, parseRate, PROJECT_FPS, sameRate, secondsToFrames } from '../../src/shared/timing.js';

function sequence() {
  let document = createProject('test', 'Test flight');
  document = applyCommand(document, { type: 'insert', clip: createClip('a', 'media-a', 10, 110), index: 0 });
  return applyCommand(document, { type: 'insert', clip: createClip('b', 'media-b', 20, 100), index: 1 });
}

describe('rational frame contract', () => {
  it('round-trips frames without accumulated floating time', () => {
    for (const frame of [0, 1, 29, 30, 1001, 100_000, 2_000_000]) expect(secondsToFrames(framesToSeconds(frame))).toBe(frame);
    expect(framesToSeconds(30_000)).toBe(1001);
    expect(secondsToFrames(framesToSeconds(10) - 0.001, PROJECT_FPS, 'floor')).toBe(9);
  });
  it('validates rational rates and labels NDF timecode', () => {
    expect(sameRate(parseRate('60000/2002'), PROJECT_FPS)).toBe(true);
    expect(() => parseRate('0/0')).toThrow();
    expect(() => parseRate('29.97')).toThrow();
    expect(formatTimecode(109_829)).toBe('01:01:00:29');
  });
});

describe('layout and sampling', () => {
  it('keeps cuts contiguous and source OUT exclusive', () => {
    const project = sequence();
    expect(calculateLayout(project).duration).toBe(180);
    expect(sampleTimeline(project, 99)[0]?.sourceFrame).toBe(109);
    expect(sampleTimeline(project, 100)[0]?.sourceFrame).toBe(20);
    expect(sampleTimeline(project, 180)).toEqual([]);
  });
  it('subtracts only dissolve overlap and grades each layer separately', () => {
    const project = applyCommand(sequence(), { type: 'transition', transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 20 } });
    const layout = calculateLayout(project);
    expect(layout.clips[1]?.start).toBe(80);
    expect(layout.duration).toBe(160);
    expect(sampleTimeline(project, 90).map((layer) => [layer.sourceFrame, layer.weight])).toEqual([[100, 0.5], [30, 0.5]]);
    expect(sampleTimeline(project, 80)).toHaveLength(2);
    expect(sampleTimeline(project, 100)).toHaveLength(1);
  });
  it('splits odd black fades deterministically with true black endpoints', () => {
    expect(blackFadeParts(5)).toEqual({ out: 3, in: 2 });
    const project = applyCommand(sequence(), { type: 'transition', transition: { leftId: 'a', rightId: 'b', type: 'fade-through-black', duration: 5 } });
    expect(calculateLayout(project).duration).toBe(180);
    expect([97, 98, 99, 100, 101].map((frame) => sampleTimeline(project, frame)[0]?.weight)).toEqual([1, 0.5, 0, 0, 1]);
  });
  it('places opening/closing fades inside the clips', () => {
    const project = applyCommand(sequence(), { type: 'fades', opening: 3, closing: 3 });
    expect([0, 1, 2, 177, 178, 179].map((frame) => sampleTimeline(project, frame)[0]?.weight)).toEqual([0, 0.5, 1, 1, 0.5, 0]);
    expect(calculateLayout(project).duration).toBe(180);
  });
  it('rejects overlapping transition regions without changing committed data', () => {
    const original = sequence();
    expect(() => applyCommand(original, { type: 'transition', transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 81 } })).toThrow();
    expect(original.transitions[0]?.type).toBe('cut');
    const transition = applyCommand(original, { type: 'transition', transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 60 } });
    expect(() => applyCommand(transition, { type: 'fades', opening: 41, closing: 0 })).toThrow();
  });
  it('rejects wrong adjacency, duplicate IDs and unknown document fields', () => {
    const project = sequence();
    expect(() => projectSchema.parse({ ...project, legacy: true })).toThrow();
    expect(() => projectSchema.parse({ ...project, clips: [project.clips[0], project.clips[0]] })).toThrow();
    expect(() => projectSchema.parse({ ...project, transitions: [{ leftId: 'b', rightId: 'a', type: 'cut', duration: 0 }] })).toThrow();
  });
});

describe('editing commands and history', () => {
  it('trims with downstream ripple and rejects invalid source ranges', () => {
    const project = applyCommand(sequence(), { type: 'trim', clipId: 'a', sourceIn: 20, sourceOut: 60 });
    expect(calculateLayout(project).clips[1]?.start).toBe(40);
    expect(() => applyCommand(project, { type: 'trim', clipId: 'a', sourceIn: 60, sourceOut: 20 })).toThrow();
  });
  it('splits preserve colours and external boundaries', () => {
    let project = applyCommand(sequence(), { type: 'colour', clipId: 'a', colour: { ...sequence().clips[0]!.colour, exposure: 0.7 } });
    project = applyCommand(project, { type: 'transition', transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 10 } });
    project = applyCommand(project, { type: 'split', clipId: 'a', sourceFrame: 60, newClipId: 'a2' });
    expect(project.clips[1]?.colour.exposure).toBe(0.7);
    expect(project.transitions.map((t) => [t.leftId, t.rightId, t.type])).toEqual([['a', 'a2', 'cut'], ['a2', 'b', 'cross-dissolve']]);
    expect(calculateLayout(project).duration).toBe(170);
  });
  it('reordering preserves only unchanged adjacent pairs', () => {
    let project = applyCommand(sequence(), { type: 'insert', clip: createClip('c', 'media-c', 0, 100), index: 2 });
    project = applyCommand(project, { type: 'transition', transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 10 } });
    expect(applyCommand(project, { type: 'reorder', clipIds: ['c', 'a', 'b'] }).transitions.map((t) => t.type)).toEqual(['cut', 'cross-dissolve']);
    expect(applyCommand(project, { type: 'reorder', clipIds: ['b', 'a', 'c'] }).transitions.every((t) => t.type === 'cut')).toBe(true);
  });
  it('deleting closes the gap and resets fades on an empty track', () => {
    let project = applyCommand(sequence(), { type: 'delete', clipId: 'a' });
    expect(calculateLayout(project).duration).toBe(80);
    project = applyCommand(project, { type: 'fades', opening: 10, closing: 10 });
    expect(applyCommand(project, { type: 'delete', clipId: 'b' }).openingFade).toBe(0);
  });
  it('undo/redo are atomic and invalid edits do not enter history', () => {
    const history = new EditHistory(sequence());
    history.commit({ type: 'trim', clipId: 'a', sourceIn: 20, sourceOut: 60 });
    expect(history.undo().clips[0]?.sourceIn).toBe(10);
    expect(history.redo().clips[0]?.sourceIn).toBe(20);
    expect(() => history.commit({ type: 'trim', clipId: 'a', sourceIn: 70, sourceOut: 60 })).toThrow();
    expect(history.current.clips[0]?.sourceIn).toBe(20);
    history.undo(); history.commit({ type: 'delete', clipId: 'a' });
    expect(history.canRedo).toBe(false);
  });
});