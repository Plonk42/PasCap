import { describe, expect, it } from 'vitest';
import { COLOR_CONTROLS, createColorSettings, NEUTRAL_COLOR } from '../../src/shared/color.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createAdjustment, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject } from '../../src/shared/model.js';
import { adjustmentColorOwner, clipColorOwner } from '../../src/web/color-owner.js';
import { COLOR_GROUPS, colorGroupResetCommands, colorResetCommands } from '../../src/web/color-reset.js';

describe('Color reset', () => {
  it('resets a clip grade as one transaction without touching another clip, an adjustment or a track', () => {
    const project = createProject('reset', 'Reset');
    project.layers.push(createLayer('other', 'Other'));
    project.layers[0]!.transform.base.opacity = 0.23456789;
    const clip = createClip('clip', 'synthetic', 0, 10);
    clip.grade.color.contrast = 1.6;
    const other = createClip('other-clip', 'synthetic', 0, 10, 'other');
    other.grade.color.contrast = 1.2;
    project.clips = [clip, other];
    project.adjustments = [{ ...createAdjustment('look', 0, 10), color: { ...createColorSettings(), exposure: 0.5 } }];
    const before = structuredClone(project);
    const commands = colorResetCommands(clipColorOwner(clip, 'Clip'), 3);
    expect(commands).toEqual([{ type: 'color', clipIds: ['clip'], color: { ...NEUTRAL_COLOR } }]);
    const next = commands.reduce(applyCommand, project);
    expect(next.clips[0]!.grade).toEqual({ color: NEUTRAL_COLOR, keyframes: [] });
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
        color: { ...createColorSettings(), saturation: 1.4 },
        keyframes: [
          layerKeyframe(10, { ...EMPTY_KEY_VALUES, exposure: 0.2, contrast: 1.5 }, 'ease-out'),
          layerKeyframe(30, { ...EMPTY_KEY_VALUES, exposure: 0.7, hue: 15 }, 'hold'),
        ].map(layerKeyAsGradeKey),
      },
    ];
    const before = structuredClone(project);
    const owner = adjustmentColorOwner(project.adjustments[0]!, 'Look');
    const commands = colorResetCommands(owner, 10);
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
    expect(next.adjustments[0]!.color).toEqual(before.adjustments[0]!.color);
    expect(colorResetCommands(adjustmentColorOwner(next.adjustments[0]!, 'Look'), 10)).toEqual([]);
    expect(colorResetCommands(owner, 20)).toEqual([]);
    expect(project).toEqual(before);
  });

  it('resets an unanimated adjustment completely and does nothing at the neutral defaults', () => {
    expect(colorResetCommands(clipColorOwner(createClip('clip', 'synthetic', 0, 10), 'Clip'), 0)).toEqual([]);
    const item = createAdjustment('look', 0, 10);
    expect(colorResetCommands(adjustmentColorOwner(item, 'Look'), 0)).toEqual([]);
    item.color.hsl.red.hue = 10;
    expect(colorResetCommands(adjustmentColorOwner(item, 'Look'), 0)).toEqual([
      { type: 'color', adjustmentId: 'look', color: { ...NEUTRAL_COLOR } },
    ]);
  });
});

describe('Color group reset', () => {
  it('groups every scalar Color setting exactly once', () => {
    expect(COLOR_GROUPS.map((group) => group.name)).toEqual(['Color', 'Light', 'Effects']);
    expect(new Set(COLOR_GROUPS.flatMap((group) => group.settings))).toEqual(
      new Set(COLOR_CONTROLS.map((setting) => setting.key)),
    );
    expect(COLOR_GROUPS.flatMap((group) => group.settings)).toHaveLength(COLOR_CONTROLS.length);
  });

  it('resets only the group’s editable settings in one transaction, leaving locked and other settings', () => {
    const project = createProject('group', 'Group');
    const clip = createClip('clip', 'synthetic', 0, 40);
    Object.assign(clip.grade.color, { exposure: 1, contrast: 1.5, shadows: 0.3, hue: 20 });
    clip.grade.color.hsl.red.hue = 10;
    clip.grade.keyframes = [
      layerKeyframe(10, { ...EMPTY_KEY_VALUES, brightness: 0.2, highlights: -0.4 }, 'ease-out'),
      layerKeyframe(30, { ...EMPTY_KEY_VALUES, brightness: 0.1, highlights: 0.5 }, 'linear'),
    ].map(layerKeyAsGradeKey);
    project.clips = [clip];
    const owner = clipColorOwner(clip, 'Clip');
    const light = COLOR_GROUPS.find((group) => group.name === 'Light')!.settings;
    const before = structuredClone(project);
    const next = colorGroupResetCommands(owner, 10, light).reduce(applyCommand, project);
    const reset = next.clips[0]!.grade;
    expect(reset.color).toEqual({ ...before.clips[0]!.grade.color, exposure: 0, contrast: 1, shadows: 0 });
    expect(reset.keyframes[0]!.values).toEqual({
      ...before.clips[0]!.grade.keyframes[0]!.values,
      brightness: 0,
      highlights: 0,
    });
    expect(reset.keyframes[0]!.easing).toEqual(before.clips[0]!.grade.keyframes[0]!.easing);
    expect(reset.keyframes[1]).toEqual(before.clips[0]!.grade.keyframes[1]);
    expect(next.layers).toEqual(before.layers);
    // Between keyframes the keyed settings are locked; only the unkeyed ones reset.
    expect(colorGroupResetCommands(owner, 20, light)).toEqual([
      { type: 'color', clipIds: ['clip'], color: { ...owner.color, exposure: 0, contrast: 1, shadows: 0 } },
    ]);
    expect(colorGroupResetCommands(clipColorOwner(next.clips[0]!, 'Clip'), 10, light)).toEqual([]);
    expect(colorGroupResetCommands(owner, -1, light)).toEqual([]);
    expect(project).toEqual(before);
  });
});
