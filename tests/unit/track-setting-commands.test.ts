import { describe, expect, it } from 'vitest';
import { applyCommand, type EditCommand } from '../../src/shared/commands.js';
import { createProject, type ProjectDocument } from '../../src/shared/model.js';

/** A track with every kind of appearance away from neutral, and Exposure and Scale keyed. */
function graded(): ProjectDocument {
  const project = createProject('settings', 'Settings');
  const layer = project.layers[0]!;
  layer.colour = {
    ...layer.colour,
    contrast: 1.2,
    shadows: 0.3,
    hsl: { ...layer.colour.hsl, blue: { hue: -10, saturation: 0.2, lightness: 0 } },
    curves: {
      ...layer.colour.curves,
      red: [
        { x: 0, y: 0.1 },
        { x: 1, y: 1 },
      ],
    },
  };
  layer.transform.base = { ...layer.transform.base, rotation: 5 };
  let next = project;
  for (const command of [
    { type: 'layer-key-toggle', layerId: layer.id, frame: 10, setting: 'exposure', value: 0.5 },
    {
      type: 'transform',
      layerId: layer.id,
      transform: {
        ...layer.transform,
        keyframes: [
          {
            frame: 0,
            values: { ...nulls(), scale: 1.5 },
            easing: { ...nulls(), scale: 'linear' },
            reset: false,
          },
        ],
      },
    },
  ] as EditCommand[])
    next = applyCommand(next, command);
  return next;
}

function nulls() {
  return {
    cropLeft: null,
    cropRight: null,
    cropTop: null,
    cropBottom: null,
    scale: null,
    translateX: null,
    translateY: null,
    rotation: null,
  };
}

/** The project with only `change` applied to its first track, by hand. */
function expected(project: ProjectDocument, change: (layer: ProjectDocument['layers'][number]) => void) {
  const copy = structuredClone(project);
  change(copy.layers[0]!);
  return copy;
}

describe('partial track appearance commands', () => {
  const project = graded();
  const layerId = project.layers[0]!.id;

  it('change one setting and keep every other saved value', () => {
    expect(applyCommand(project, { type: 'colour-setting', layerId, setting: 'contrast', value: 1.4 })).toEqual(
      expected(project, (layer) => {
        layer.colour.contrast = 1.4;
      }),
    );
    const band = { hue: 4, saturation: -0.5, lightness: 0.1 };
    expect(applyCommand(project, { type: 'hsl-band', layerId, band: 'green', values: band })).toEqual(
      expected(project, (layer) => {
        layer.colour.hsl.green = band;
      }),
    );
    const points = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.5 },
      { x: 1, y: 1 },
    ];
    expect(applyCommand(project, { type: 'colour-curve', layerId, channel: 'master', points })).toEqual(
      expected(project, (layer) => {
        layer.colour.curves.master = points;
      }),
    );
    expect(applyCommand(project, { type: 'transform-setting', layerId, setting: 'translateX', value: 0.25 })).toEqual(
      expected(project, (layer) => {
        layer.transform.base.translateX = 0.25;
      }),
    );
  });

  it('refuse a setting that follows keyframes, naming them', () => {
    expect(() => applyCommand(project, { type: 'colour-setting', layerId, setting: 'exposure', value: 1 })).toThrow(
      'exposure follows 1 track keyframe on Track 1, so its base value is not used; change that keyframe instead.',
    );
    expect(() => applyCommand(project, { type: 'transform-setting', layerId, setting: 'scale', value: 2 })).toThrow(
      /scale follows 1 Transform keyframe/,
    );
  });

  it('refuse out-of-bounds values, invalid curves and unknown tracks without changing anything', () => {
    expect(() => applyCommand(project, { type: 'colour-setting', layerId, setting: 'tint', value: 3 })).toThrow();
    expect(() =>
      applyCommand(project, {
        type: 'colour-curve',
        layerId,
        channel: 'blue',
        points: [
          { x: 0.2, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    ).toThrow(/ascend from 0 to 1/);
    expect(() =>
      applyCommand(project, { type: 'transform-setting', layerId: 'video-9', setting: 'rotation', value: 0 }),
    ).toThrow('Track no longer exists.');
    expect(project).toEqual(graded());
  });
});
