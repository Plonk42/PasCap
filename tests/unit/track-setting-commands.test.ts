import { describe, expect, it } from 'vitest';
import { NEUTRAL_COLOR } from '../../src/shared/color.js';
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
    target: { clipIds: ['shot'] as string[] },
    grade: (project: ProjectDocument): ClipGrade => project.clips[0]!.grade,
    keyed: 'exposure follows 1 clip keyframe on clip shot',
  },
] as const;

describe('partial appearance commands', () => {
  const project = graded();
  const layerId = project.layers[0]!.id;

  it.each(OWNERS)('change settings of $owner, return null ones to neutral and keep the others', ({ target, grade }) => {
    const band = { hue: 4, saturation: -0.5, lightness: 0.1 };
    const points = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.5 },
      { x: 1, y: 1 },
    ];
    const patched = applyCommand(project, {
      type: 'color-patch',
      ...target,
      settings: { contrast: 1.4, shadows: null },
      hsl: { green: band, blue: null },
      curves: { master: points, red: null },
    });
    expect(patched).toEqual(
      expected(project, (copy) => {
        const { color } = grade(copy);
        color.contrast = 1.4;
        color.shadows = 0;
        color.hsl.green = band;
        color.hsl.blue = NEUTRAL_COLOR.hsl.blue;
        color.curves.master = points;
        color.curves.red = NEUTRAL_COLOR.curves.red;
      }),
    );
  });

  it('sets the same settings on several clips in one command', () => {
    const document = structuredClone(project);
    document.clips.push({ ...createClip('other', 'rec', 100, 200), start: 100 });
    document.layers[0]!.transitions = [{ leftId: 'shot', rightId: 'other', type: 'cut', duration: 0 }];
    const patched = applyCommand(document, {
      type: 'color-patch',
      clipIds: ['shot', 'other'],
      settings: { saturation: 1.3, contrast: null },
    });
    expect(patched).toEqual(
      expected(document, (copy) => {
        for (const clip of copy.clips) Object.assign(clip.grade.color, { saturation: 1.3, contrast: 1 });
      }),
    );
    // One keyed target, unknown or repeated clips reject the whole command.
    const patch = (clipIds: string[]) => () =>
      applyCommand(document, { type: 'color-patch', clipIds, settings: { exposure: 0 } });
    expect(patch(['other', 'shot'])).toThrow(/exposure follows 1 clip keyframe on clip shot/);
    expect(patch(['other', 'gone'])).toThrow('Clip gone no longer exists.');
    expect(patch(['other', 'other'])).toThrow('List each clip once.');
  });

  it('change one Transform setting and keep every other saved value', () => {
    expect(applyCommand(project, { type: 'transform-setting', layerId, setting: 'translateX', value: 0.25 })).toEqual(
      expected(project, (copy) => {
        copy.layers[0]!.transform.base.translateX = 0.25;
      }),
    );
  });

  it.each(OWNERS)('refuse a setting of $owner that follows keyframes, naming them', ({ target, keyed }) => {
    expect(() => applyCommand(project, { type: 'color-patch', ...target, settings: { exposure: 1 } })).toThrow(
      `${keyed}, so its base value is not used; change that keyframe instead.`,
    );
    expect(() => applyCommand(project, { type: 'transform-setting', layerId, setting: 'scale', value: 2 })).toThrow(
      /scale follows 1 Transform keyframe/,
    );
  });

  it('refuse out-of-bounds values, invalid curves, empty patches and unknown owners or tracks without changing anything', () => {
    expect(() => applyCommand(project, { type: 'color-patch', adjustmentId: 'look', settings: { tint: 3 } })).toThrow();
    expect(() => applyCommand(project, { type: 'color-patch', clipIds: ['shot'], settings: { tint: 3 } })).toThrow();
    expect(() =>
      applyCommand(project, {
        type: 'color-patch',
        adjustmentId: 'look',
        curves: {
          blue: [
            { x: 0.2, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).toThrow(/ascend from 0 to 1/);
    expect(() => applyCommand(project, { type: 'color-patch', adjustmentId: 'look' })).toThrow(
      'List at least one setting to change.',
    );
    expect(() => applyCommand(project, { type: 'color-patch', settings: { tint: 0 } })).toThrow('Give either');
    expect(() => applyCommand(project, { type: 'color-patch', adjustmentId: 'gone', settings: { tint: 0 } })).toThrow(
      'Adjustment no longer exists.',
    );
    expect(() => applyCommand(project, { type: 'color-patch', clipIds: ['gone'], settings: { tint: 0 } })).toThrow(
      'Clip gone no longer exists.',
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
