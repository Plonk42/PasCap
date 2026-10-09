import { describe, expect, it } from 'vitest';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject } from '../../src/shared/model.js';
import { colourResetCommands } from '../../src/web/colour-reset.js';

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
      { frame: 10, interpolation: 'ease-out', values: { ...EMPTY_KEY_VALUES, opacity: 0.2, contrast: 1.5 } },
      { frame: 30, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, opacity: 0.7, hue: 15 } },
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
