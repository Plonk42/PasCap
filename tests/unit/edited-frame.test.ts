import { describe, expect, it } from 'vitest';
import { createColourSettings } from '../../src/shared/colour.js';
import { applyCommand, type EditCommand } from '../../src/shared/commands.js';
import { editedFrame } from '../../src/shared/edited-frame.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';

const base: ProjectDocument = projectSchema.parse({
  ...createProject('edited', 'Edited'),
  media: { videoIds: ['rec'], audioIds: ['song'] },
  clips: ['a', 'b', 'c'].map((id, index) => ({
    ...createClip(id, 'rec', index * 60, index * 60 + 60),
    start: index * 60,
  })),
  layers: [
    {
      ...createProject('edited', 'Edited').layers[0]!,
      transitions: [
        { leftId: 'a', rightId: 'b', type: 'cut', duration: 0 },
        { leftId: 'b', rightId: 'c', type: 'cut', duration: 0 },
      ],
    },
  ],
});
const layerId = base.layers[0]!.id;

function after(...commands: EditCommand[]): number | null {
  return editedFrame(
    base,
    commands.reduce((document, command) => applyCommand(document, command), base),
  );
}

describe('edited frame', () => {
  it('is the earliest clip, transition or fade the batch changed', () => {
    expect(after({ type: 'trim', clipId: 'b', sourceIn: 70, sourceOut: 120 })).toBe(60);
    expect(after({ type: 'delete', clipId: 'c' })).toBe(120);
    expect(after({ type: 'delete', clipId: 'c' }, { type: 'trim', clipId: 'a', sourceIn: 0, sourceOut: 30 })).toBe(0);
    expect(
      after({ type: 'transition', transition: { leftId: 'b', rightId: 'c', type: 'cross-dissolve', duration: 10 } }),
    ).toBe(110);
    expect(after({ type: 'fades', layerId, opening: 0, closing: 15 })).toBe(165);
    expect(after({ type: 'reverse', clipId: 'c', reverse: true })).toBe(120);
  });

  it('is the frame of a changed keyframe, bookmark or music clip', () => {
    expect(after({ type: 'layer-key-toggle', layerId, frame: 90, setting: 'exposure', value: 0.5 })).toBe(90);
    expect(after({ type: 'bookmark-add', frame: 200 })).toBe(200);
    expect(
      after({
        type: 'music',
        music: [
          {
            id: 'track',
            gainDb: 0,
            ripple: false,
            openingFade: 0,
            closingFade: 0,
            clips: [
              { id: 'song-clip', mediaId: 'song', sourceIn: 0, sourceOut: 300, start: 30, duration: 60, loop: false },
            ],
            transitions: [],
          },
        ],
      }),
    ).toBe(30);
  });

  it('is null for whole-track appearance, kept ranges or nothing at all', () => {
    expect(after({ type: 'colour', layerId, colour: { ...createColourSettings(), exposure: 0.5 } })).toBeNull();
    expect(after({ type: 'opacity', layerId, opacity: 0.5 })).toBeNull();
    expect(after({ type: 'select-set', mediaId: 'rec', ranges: [{ sourceIn: 0, sourceOut: 90 }] })).toBeNull();
    expect(editedFrame(base, base)).toBeNull();
  });
});
