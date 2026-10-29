import { describe, expect, it } from 'vitest';
import { COLOUR_CONTROLS, createColourSettings, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createAdjustment, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject } from '../../src/shared/model.js';
import { adjustmentColourOwner, clipColourOwner } from '../../src/web/colour-owner.js';
import { COLOUR_GROUPS, colourGroupResetCommands, colourResetCommands } from '../../src/web/colour-reset.js';

describe('Colour reset', () => {
  it('resets a clip grade as one transaction without touching another clip, an adjustment or a track', () => {
    const project = createProject('reset', 'Reset');
    project.layers.push(createLayer('other', 'Other'));
    project.layers[0]!.transform.base.opacity = 0.23456789;
    const clip = createClip('clip', 'synthetic', 0, 10);
    clip.grade.colour.contrast = 1.6;
    const other = createClip('other-clip', 'synthetic', 0, 10, 'other');
    other.grade.colour.contrast = 1.2;
    project.clips = [clip, other];
    project.adjustments = [
      { ...createAdjustment('look', 0, 10), colour: { ...createColourSettings(), exposure: 0.5 } },
    ];
    const before = structuredClone(project);
    const commands = colourResetCommands(clipColourOwner(clip, 'Clip'), 3);
    expect(commands).toEqual([{ type: 'colour', clipIds: ['clip'], colour: { ...NEUTRAL_COLOUR } }]);
    const next = commands.reduce(applyCommand, project);
    expect(next.clips[0]!.grade).toEqual({ colour: NEUTRAL_COLOUR, keyframes: [] });
    expect(next.clips[1]).toEqual(before.clips[1]);
    expect(next.layers).toEqual(before.layers);
    expect(next.adjustments).toEqual(before.adjustments);
    const history = new EditHistory(project);
    history.replace(next);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(project).toEqual(before);
  });

  it('resets existing keyed settings only, preserving times, easing and the unkeyed values', () => {
    const project = createProject('keys', 'Keys');
    project.adjustments = [
      {
        ...createAdjustment('look', 0, 100),
        colour: { ...createColourSettings(), saturation: 1.4 },
        keyframes: [
          layerKeyframe(10, { ...EMPTY_KEY_VALUES, exposure: 0.2, contrast: 1.5 }, 'ease-out'),
          layerKeyframe(30, { ...EMPTY_KEY_VALUES, exposure: 0.7, hue: 15 }, 'hold'),
        ].map(layerKeyAsGradeKey),
      },
    ];
    const before = structuredClone(project);
    const owner = adjustmentColourOwner(project.adjustments[0]!, 'Look');
    const commands = colourResetCommands(owner, 10);
    expect(commands).toEqual([
      { type: 'layer-key-set', adjustmentId: 'look', frame: 10, values: { exposure: 0, contrast: 1 } },
    ]);
    const next = applyCommand(project, commands[0]!);
    expect(next.adjustments[0]!.keyframes).toEqual([
      {
        ...before.adjustments[0]!.keyframes[0]!,
        values: { ...before.adjustments[0]!.keyframes[0]!.values, exposure: 0, contrast: 1 },
      },
      before.adjustments[0]!.keyframes[1],
    ]);
    expect(next.adjustments[0]!.colour).toEqual(before.adjustments[0]!.colour);
    expect(colourResetCommands(adjustmentColourOwner(next.adjustments[0]!, 'Look'), 10)).toEqual([]);
    expect(colourResetCommands(owner, 20)).toEqual([]);
    expect(project).toEqual(before);
  });

  it('resets an unanimated adjustment completely and does nothing at the neutral defaults', () => {
    expect(colourResetCommands(clipColourOwner(createClip('clip', 'synthetic', 0, 10), 'Clip'), 0)).toEqual([]);
    const item = createAdjustment('look', 0, 10);
    expect(colourResetCommands(adjustmentColourOwner(item, 'Look'), 0)).toEqual([]);
    item.colour.hsl.red.hue = 10;
    expect(colourResetCommands(adjustmentColourOwner(item, 'Look'), 0)).toEqual([
      { type: 'colour', adjustmentId: 'look', colour: { ...NEUTRAL_COLOUR } },
    ]);
  });
});

describe('Colour group reset', () => {
  it('groups every scalar Colour setting exactly once', () => {
    expect(COLOUR_GROUPS.map((group) => group.name)).toEqual(['Colour', 'Light', 'Effects']);
    expect(new Set(COLOUR_GROUPS.flatMap((group) => group.settings))).toEqual(
      new Set(COLOUR_CONTROLS.map((setting) => setting.key)),
    );
    expect(COLOUR_GROUPS.flatMap((group) => group.settings)).toHaveLength(COLOUR_CONTROLS.length);
  });

  it('resets only the group’s editable settings in one transaction, leaving locked and other settings', () => {
    const project = createProject('group', 'Group');
    const clip = createClip('clip', 'synthetic', 0, 40);
    Object.assign(clip.grade.colour, { exposure: 1, contrast: 1.5, shadows: 0.3, hue: 20 });
    clip.grade.colour.hsl.red.hue = 10;
    clip.grade.keyframes = [
      layerKeyframe(10, { ...EMPTY_KEY_VALUES, brightness: 0.2, highlights: -0.4 }, 'ease-out'),
      layerKeyframe(30, { ...EMPTY_KEY_VALUES, brightness: 0.1, highlights: 0.5 }, 'linear'),
    ].map(layerKeyAsGradeKey);
    project.clips = [clip];
    const owner = clipColourOwner(clip, 'Clip');
    const light = COLOUR_GROUPS.find((group) => group.name === 'Light')!.settings;
    const before = structuredClone(project);
    const next = colourGroupResetCommands(owner, 10, light).reduce(applyCommand, project);
    const reset = next.clips[0]!.grade;
    expect(reset.colour).toEqual({ ...before.clips[0]!.grade.colour, exposure: 0, contrast: 1, shadows: 0 });
    expect(reset.keyframes[0]!.values).toEqual({
      ...before.clips[0]!.grade.keyframes[0]!.values,
      brightness: 0,
      highlights: 0,
    });
    expect(reset.keyframes[0]!.easing).toEqual(before.clips[0]!.grade.keyframes[0]!.easing);
    expect(reset.keyframes[1]).toEqual(before.clips[0]!.grade.keyframes[1]);
    expect(next.layers).toEqual(before.layers);
    // Between keyframes the keyed settings are locked; only the unkeyed ones reset.
    expect(colourGroupResetCommands(owner, 20, light)).toEqual([
      { type: 'colour', clipIds: ['clip'], colour: { ...owner.colour, exposure: 0, contrast: 1, shadows: 0 } },
    ]);
    expect(colourGroupResetCommands(clipColourOwner(next.clips[0]!, 'Clip'), 10, light)).toEqual([]);
    expect(colourGroupResetCommands(owner, -1, light)).toEqual([]);
    expect(project).toEqual(before);
  });
});
