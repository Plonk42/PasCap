import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { trimByFrames, validateSourceRanges } from '../../src/shared/source-range.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { assignDecoders } from '../../src/preview/assignment.js';

describe('non-destructive excerpts', () => {
  it('restores both trimmed ends of a full 20-second recording', () => {
    let project = applyCommand(createProject('flight', 'Flight'), { type: 'insert', clip: createClip('excerpt', 'recording', 0, 600), index: 0 });
    project = applyCommand(project, trimByFrames(project.clips[0]!, 'in', 150, 600));
    project = applyCommand(project, trimByFrames(project.clips[0]!, 'out', -90, 600));
    expect(project.clips[0]).toMatchObject({ mediaId: 'recording', sourceIn: 150, sourceOut: 510 });
    expect(calculateLayout(project).duration).toBe(360);
    project = applyCommand(project, trimByFrames(project.clips[0]!, 'in', -150, 600));
    project = applyCommand(project, trimByFrames(project.clips[0]!, 'out', 90, 600));
    expect(project.clips[0]).toMatchObject({ sourceIn: 0, sourceOut: 600 });
  });
  it('trims one instance independently and ripples subsequent excerpts', () => {
    let project = applyCommand(createProject('flight', 'Flight'), { type: 'insert', clip: createClip('first', 'recording', 0, 600), index: 0 });
    project = applyCommand(project, { type: 'insert', clip: createClip('second', 'recording', 0, 600), index: 1 });
    project = applyCommand(project, trimByFrames(project.clips[0]!, 'out', -90, 600));
    expect(project.clips[1]).toMatchObject({ sourceIn: 0, sourceOut: 600 });
    expect(calculateLayout(project).clips[1]?.start).toBe(510);
  });
  it('stops handles at real source limits, with at least one selected frame', () => {
    const clip = createClip('excerpt', 'recording', 150, 510);
    expect(trimByFrames(clip, 'in', -999, 600).sourceIn).toBe(0);
    expect(trimByFrames(clip, 'out', 999, 600).sourceOut).toBe(600);
    expect(trimByFrames(clip, 'in', 999, 600).sourceIn).toBe(509);
    expect(trimByFrames(clip, 'out', -999, 600).sourceOut).toBe(151);
    expect(() => trimByFrames(clip, 'in', 0.5, 600)).toThrow();
  });
  it('rejects transition-invalid trims without changing a committed document', () => {
    let project = applyCommand(createProject('flight', 'Flight'), { type: 'insert', clip: createClip('first', 'a', 0, 100), index: 0 });
    project = applyCommand(project, { type: 'insert', clip: createClip('second', 'b', 0, 100), index: 1 });
    project = applyCommand(project, { type: 'transition', transition: { leftId: 'first', rightId: 'second', type: 'cross-dissolve', duration: 30 } });
    expect(() => applyCommand(project, trimByFrames(project.clips[0]!, 'out', -90, 100))).toThrow();
    expect(project.clips[0]?.sourceOut).toBe(100);
  });
  it('validates bounds and commits a batch or gesture as one undo step', () => {
    const history = new EditHistory(createProject('flight', 'Flight'));
    let next = applyCommand(history.current, { type: 'insert', clip: createClip('first', 'a', 0, 600), index: 0 });
    next = applyCommand(next, { type: 'insert', clip: createClip('second', 'a', 150, 510), index: 1 });
    validateSourceRanges(next, new Map([['a', 600]]));
    expect(() => validateSourceRanges(next, new Map([['a', 100]]))).toThrow();
    history.replace(next);
    expect(history.undo().clips).toHaveLength(0);
    expect(history.redo().clips).toHaveLength(2);
    expect(history.canRedo).toBe(false);
  });
});

describe('two-decoder assignment for long timelines', () => {
  it('keeps the active decoder when entering and leaving a dissolve', () => {
    expect(assignDecoders(['first', 'next'], ['first', 'next'])).toEqual(['first', 'next']);
    expect(assignDecoders(['first', 'next'], ['next'])).toEqual(['first', 'next']);
    expect(assignDecoders(['first', 'next'], ['next', 'third'])).toEqual(['third', 'next']);
  });
  it('seeks directly to distant excerpts without allocating more decoders', () => {
    expect(assignDecoders(['first', 'second'], ['tenth'])).toEqual(['tenth', 'second']);
    expect(assignDecoders(['first', 'second'], ['fifteenth', 'sixteenth'])).toEqual(['fifteenth', 'sixteenth']);
    expect(() => assignDecoders([null, null], ['a', 'b', 'c'])).toThrow();
    expect(() => assignDecoders([null, null], ['a', 'a'])).toThrow();
  });
});