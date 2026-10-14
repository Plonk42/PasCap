import { describe, expect, it } from 'vitest';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS, layerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject } from '../../src/shared/model.js';
import { COLOUR_GROUPS, colourGroupResetCommands, colourResetCommands } from '../../src/web/colour-reset.js';

describe('Colour and row Opacity reset', () => {
  it('resets row Colour and sole row Opacity as one transaction without touching another row or clip', () => {
    const project = createProject('reset', 'Reset');
    project.layers.push(createLayer('other', 'Other'));
    project.layers[0]!.opacity = 0.23456789;
    const clip = createClip('clip', 'synthetic', 0, 10);
    project.layers[0]!.colour.contrast = 1.6;
    project.clips = [clip, createClip('other-clip', 'synthetic', 0, 10, 'other')];
    project.layers[1]!.opacity = 0.5;
    const before = structuredClone(project);
    const commands = colourResetCommands(project.layers[0]!, 3);
    expect(commands).toEqual([
      { type: 'colour', layerId: project.layers[0]!.id, colour: { ...NEUTRAL_COLOUR } },
      { type: 'opacity', layerId: project.layers[0]!.id, opacity: 1 },
    ]);
    const next = commands.reduce(applyCommand, project);
    expect(next.layers[0]!.colour).toEqual(NEUTRAL_COLOUR);
    expect(next.clips).toEqual(before.clips);
    expect(next.layers[0]!.opacity).toBe(1);
    expect(next.layers[0]!.keyframes).toEqual([]);
    expect(next.layers[1]).toEqual(before.layers[1]);
    expect(next.clips[1]).toEqual(before.clips[1]);
    const history = new EditHistory(project);
    history.replace(next);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(project).toEqual(before);
  });

  it('resets existing Colour participants only, preserving times, easing and the unkeyed row value', () => {
    const project = createProject('keys', 'Keys');
    const layer = project.layers[0]!;
    layer.opacity = 0.6;
    layer.keyframes = [
      layerKeyframe(10, { ...EMPTY_KEY_VALUES, opacity: 0.2, contrast: 1.5 }, 'ease-out'),
      layerKeyframe(30, { ...EMPTY_KEY_VALUES, opacity: 0.7, hue: 15 }, 'hold'),
    ];
    const before = structuredClone(project);
    const commands = colourResetCommands(layer, 10);
    expect(commands).toHaveLength(1);
    const next = applyCommand(project, commands[0]!);
    expect(next.layers[0]!.keyframes).toEqual([
      {
        ...before.layers[0]!.keyframes[0]!,
        values: { ...before.layers[0]!.keyframes[0]!.values, opacity: 1, contrast: 1 },
      },
      before.layers[0]!.keyframes[1],
    ]);
    expect(next.layers[0]!.opacity).toBe(0.6);
    expect(colourResetCommands(next.layers[0]!, 10)).toEqual([]);
    expect(colourResetCommands(layer, 20)).toEqual([]);
    expect(project).toEqual(before);
  });

  it('resets unanimated Opacity on an empty row and does nothing at the neutral defaults', () => {
    const layer = createLayer('empty', 'Empty');
    expect(colourResetCommands(layer, 0)).toEqual([]);
    layer.opacity = 0;
    expect(colourResetCommands(layer, 0)).toEqual([{ type: 'opacity', layerId: layer.id, opacity: 1 }]);
  });
});

describe('Colour group reset', () => {
  it('groups every Opacity and scalar Colour setting exactly once', () => {
    expect(COLOUR_GROUPS.map((group) => group.name)).toEqual(['Opacity', 'Colour', 'Light', 'Effects']);
    expect(new Set(COLOUR_GROUPS.flatMap((group) => group.settings))).toEqual(
      new Set(KEYFRAME_SETTINGS.map((setting) => setting.key)),
    );
    expect(COLOUR_GROUPS.flatMap((group) => group.settings)).toHaveLength(KEYFRAME_SETTINGS.length);
  });

  it('resets only the group’s editable settings in one transaction, leaving locked and other settings', () => {
    const project = createProject('group', 'Group');
    const layer = project.layers[0]!;
    layer.opacity = 0.4;
    Object.assign(layer.colour, { exposure: 1, contrast: 1.5, shadows: 0.3, hue: 20 });
    layer.colour.hsl.red.hue = 10;
    layer.keyframes = [
      layerKeyframe(10, { ...EMPTY_KEY_VALUES, brightness: 0.2, highlights: -0.4 }, 'ease-out'),
      layerKeyframe(30, { ...EMPTY_KEY_VALUES, brightness: 0.1, highlights: 0.5 }, 'linear'),
    ];
    const light = COLOUR_GROUPS.find((group) => group.name === 'Light')!.settings;
    const before = structuredClone(project);
    const next = colourGroupResetCommands(layer, 10, light).reduce(applyCommand, project);
    const reset = next.layers[0]!;
    expect(reset.colour).toEqual({ ...before.layers[0]!.colour, exposure: 0, contrast: 1, shadows: 0 });
    expect(reset.keyframes[0]!.values).toEqual({
      ...before.layers[0]!.keyframes[0]!.values,
      brightness: 0,
      highlights: 0,
    });
    expect(reset.keyframes[0]!.easing).toEqual(before.layers[0]!.keyframes[0]!.easing);
    expect(reset.keyframes[1]).toEqual(before.layers[0]!.keyframes[1]);
    expect(reset.opacity).toBe(0.4);
    // Between keyframes the keyed settings are locked; only the unkeyed ones reset.
    expect(colourGroupResetCommands(layer, 20, light)).toEqual([
      { type: 'colour', layerId: layer.id, colour: { ...layer.colour, exposure: 0, contrast: 1, shadows: 0 } },
    ]);
    expect(colourGroupResetCommands(reset, 10, light)).toEqual([]);
    expect(colourGroupResetCommands(layer, 0, ['opacity'])).toEqual([
      { type: 'opacity', layerId: layer.id, opacity: 1 },
    ]);
    expect(colourGroupResetCommands(layer, -1, light)).toEqual([]);
    expect(project).toEqual(before);
  });
});
