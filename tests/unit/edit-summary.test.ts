import { describe, expect, it } from 'vitest';
import { describeEdit } from '../../src/web/edit-summary.js';

describe('edit summaries', () => {
  it('counts repeated commands in plain words, in order', () => {
    expect(describeEdit('layer-key-value, layer-key-value, layer-key-value, layer-key-value')).toBe(
      '4 keyframe values changed',
    );
    expect(describeEdit('insert, insert, transition, bookmark-add')).toBe(
      '2 clips added, transition changed, bookmark added',
    );
    expect(describeEdit('music, music')).toBe('music changed');
    expect(describeEdit('remove-source-range')).toBe('part of a clip cut');
  });

  it('keeps unknown command types as they are', () => {
    expect(describeEdit('future-command, future-command, constructor')).toBe('2 × future-command, constructor');
  });
});
