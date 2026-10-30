import { describe, expect, it } from 'vitest';
import { applyCommand, type EditCommand } from '../../src/shared/commands.js';
import { createAdjustment, type ClipGrade } from '../../src/shared/grade.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';

/**
 * A track with a clip and an adjustment whose grades have every kind of appearance away from neutral, with Exposure
 * keyed on both, and a rotated Transform with Scale keyed.
 */
function graded(): ProjectDocument {
  const project = createProject('settings', 'Settings');
  const layer = project.layers[0]!;
  project.clips = [createClip('shot', 'rec', 0, 100)];
  project.adjustments = [createAdjustment('look', 0, 100)];
  for (const grade of [project.clips[0]!.grade, project.adjustments[0]!]) {
    grade.color = {
      ...grade.color,
      contrast: 1.2,
      shadows: 0.3,
      hsl: { ...grade.color.hsl, blue: { hue: -10, saturation: 0.2, lightness: 0 } },
      curves: {
        ...grade.color.curves,
        red: [
          { x: 0, y: 0.1 },
          { x: 1, y: 1 },
        ],
      },
    };
  }
  layer.transform.base = { ...layer.transform.base, rotation: 5 };
  let next = project;
  for (const command of [
    { type: 'layer-key-toggle', clipId: 'shot', frame: 10, setting: 'exposure', value: 0.5 },
    { type: 'layer-key-toggle', adjustmentId: 'look', frame: 10, setting: 'exposure', value: 0.5 },
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
    opacity: null,
  };
}

/** The project with only `change` applied to a copy, by hand. */
function expected(project: ProjectDocument, change: (copy: ProjectDocument) => void) {
  const copy = structuredClone(project);
  change(copy);
  return copy;
}

const OWNERS = [
  {
    owner: 'an adjustment',
    target: { adjustmentId: 'look' },
    grade: (project: ProjectDocument): ClipGrade => project.adjustments[0]!,
    keyed: 'exposure follows 1 adjustment keyframe on adjustment look',
  },
  {
    owner: 'a clip grade',
    target: { clipId: 'shot' },
    grade: (project: ProjectDocument): ClipGrade => project.clips[0]!.grade,
    keyed: 'exposure follows 1 clip keyframe on clip shot',
  },
] as const;

describe('partial appearance commands', () => {
  const project = graded();
  const layerId = project.layers[0]!.id;

  it.each(OWNERS)('change one setting of $owner and keep every other saved value', ({ target, grade }) => {
    expect(applyCommand(project, { type: 'color-setting', ...target, setting: 'contrast', value: 1.4 })).toEqual(
      expected(project, (copy) => {
        grade(copy).color.contrast = 1.4;
      }),
    );
    const band = { hue: 4, saturation: -0.5, lightness: 0.1 };
    expect(applyCommand(project, { type: 'hsl-band', ...target, band: 'green', values: band })).toEqual(
      expected(project, (copy) => {
        grade(copy).color.hsl.green = band;
      }),
    );
    const points = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.5 },
      { x: 1, y: 1 },
    ];
    expect(applyCommand(project, { type: 'color-curve', ...target, channel: 'master', points })).toEqual(
      expected(project, (copy) => {
        grade(copy).color.curves.master = points;
      }),
    );
  });

  it('change one Transform setting and keep every other saved value', () => {
    expect(applyCommand(project, { type: 'transform-setting', layerId, setting: 'translateX', value: 0.25 })).toEqual(
      expected(project, (copy) => {
        copy.layers[0]!.transform.base.translateX = 0.25;
      }),
    );
  });

  it.each(OWNERS)('refuse a setting of $owner that follows keyframes, naming them', ({ target, keyed }) => {
    expect(() => applyCommand(project, { type: 'color-setting', ...target, setting: 'exposure', value: 1 })).toThrow(
      `${keyed}, so its base value is not used; change that keyframe instead.`,
    );
    expect(() => applyCommand(project, { type: 'transform-setting', layerId, setting: 'scale', value: 2 })).toThrow(
      /scale follows 1 Transform keyframe/,
    );
  });

  it('refuse out-of-bounds values, invalid curves and unknown owners or tracks without changing anything', () => {
    expect(() =>
      applyCommand(project, { type: 'color-setting', adjustmentId: 'look', setting: 'tint', value: 3 }),
    ).toThrow();
    expect(() => applyCommand(project, { type: 'color-setting', clipId: 'shot', setting: 'tint', value: 3 })).toThrow();
    expect(() =>
      applyCommand(project, {
        type: 'color-curve',
        adjustmentId: 'look',
        channel: 'blue',
        points: [
          { x: 0.2, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    ).toThrow(/ascend from 0 to 1/);
    expect(() =>
      applyCommand(project, { type: 'color-setting', adjustmentId: 'gone', setting: 'tint', value: 0 }),
    ).toThrow('Adjustment no longer exists.');
    expect(() => applyCommand(project, { type: 'color-setting', clipId: 'gone', setting: 'tint', value: 0 })).toThrow(
      'Clip no longer exists.',
    );
    expect(() =>
      applyCommand(project, { type: 'transform-setting', layerId: 'video-9', setting: 'rotation', value: 0 }),
    ).toThrow('Track no longer exists.');
    expect(project).toEqual(graded());
  });

  it('creates a neutral track and changes its options without sending the whole track', () => {
    const project = graded();
    const created = applyCommand(project, { type: 'layer-create', layerId: 'overlay', name: ' Overlay ' });
    expect(created.layers.at(-1)).toEqual(createLayer('overlay', 'Overlay'));
    expect(() => applyCommand(created, { type: 'layer-create', layerId: 'overlay', name: 'Again' })).toThrow();
    const hidden = applyCommand(created, { type: 'layer-options', layerId: 'overlay', enabled: false, name: 'Top' });
    expect(hidden.layers.at(-1)).toEqual({ ...createLayer('overlay', 'Top'), enabled: false });
    const layer = project.layers[0]!;
    const off = applyCommand(project, { type: 'layer-options', layerId: layer.id, ripple: false });
    expect(off.layers[0]).toEqual({ ...layer, ripple: false });
    expect(() => applyCommand(project, { type: 'layer-options', layerId: 'video-9', ripple: true })).toThrow(
      'Track no longer exists.',
    );
  });
});
