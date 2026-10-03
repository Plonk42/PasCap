import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/shared/model.js';
import { applyCommand } from '../../src/shared/commands.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { insertionIndex, reorderAt } from '../../src/web/timeline-geometry.js';

describe('timeline drop geometry', () => {
  it('inserts at the nearest clip boundary including before and after the sequence', () => {
    let project = createProject('flight', 'Flight');
    for (const [index, id] of ['a', 'b', 'c'].entries()) project = applyCommand(project, { type: 'insert', clip: createClip(id, id, 0, 100), index });
    const layout = calculateLayout(project);
    expect([-20, 30, 70, 130, 160, 290, 1000].map((frame) => insertionIndex(layout, frame))).toEqual([0, 0, 1, 1, 2, 3, 3]);
  });
  it('moves a clip without duplication or off-by-one after removal', () => {
    expect(reorderAt(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
    expect(reorderAt(['a', 'b', 'c'], 'b', 0)).toEqual(['b', 'a', 'c']);
    expect(reorderAt(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c']);
    expect(() => reorderAt(['a'], 'missing', 0)).toThrow();
  });
});