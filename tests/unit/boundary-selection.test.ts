import { describe, expect, it } from 'vitest';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { toggleBoundary } from '../../src/web/boundary-selection.js';

/** Track 1 joins a→b→c→d, Track 2 joins e→f. */
function project(): ProjectDocument {
  const document = createProject('boundaries', 'Boundaries');
  document.media.videoIds = ['recording'];
  document.layers.push(createLayer('free', 'Track 2', false));
  document.clips = [
    createClip('a', 'recording', 0, 30),
    { ...createClip('b', 'recording', 0, 30), start: 30 },
    { ...createClip('c', 'recording', 0, 30), start: 60 },
    { ...createClip('d', 'recording', 0, 30), start: 90 },
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

describe('selecting several transitions', () => {
  it('adds a transition of the same track as the new primary, and removes a selected one', () => {
    const document = project();
    expect(toggleBoundary(document, ['a'], 'c')).toEqual(['a', 'c']);
    expect(toggleBoundary(document, ['a', 'c'], 'b')).toEqual(['a', 'c', 'b']);
    expect(toggleBoundary(document, ['a', 'c', 'b'], 'b')).toEqual(['a', 'c']);
    expect(toggleBoundary(document, ['a', 'c'], 'a')).toEqual(['c']);
  });

  it('keeps the last selected transition selected', () => {
    expect(toggleBoundary(project(), ['b'], 'b')).toEqual(['b']);
  });

  it('starts a new selection on another track, or from nothing', () => {
    const document = project();
    expect(toggleBoundary(document, ['a', 'b'], 'e')).toEqual(['e']);
    expect(toggleBoundary(document, [], 'b')).toEqual(['b']);
  });
});
