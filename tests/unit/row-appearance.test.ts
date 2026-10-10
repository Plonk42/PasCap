import { describe, expect, it } from 'vitest';
import { ColourLutCache, sampleColourLut } from '../../src/server/layered-colour.js';
import { generateCube, gradePixel, NEUTRAL_COLOUR, type RGB } from '../../src/shared/colour.js';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { colourAt } from '../../src/shared/composition.js';
import { needsLayeredExport, planExport } from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema } from '../../src/shared/model.js';
import { sampleTimeline } from '../../src/shared/timeline.js';
import { colourResetCommands } from '../../src/web/colour-reset.js';

function fixture() {
  const project = createProject('appearance', 'Row appearance');
  project.clips = [createClip('a', 'source', 0, 20), { ...createClip('b', 'source', 20, 40), start: 20 }];
  project.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
  return projectSchema.parse(project);
}

describe('strict row-only Colour and Opacity', () => {
  it('applies a shared row base to both shots without changing their clip data', () => {
    const original = fixture();
    const history = new EditHistory(original);
    const next = history.commit({
      type: 'colour',
      layerId: original.layers[0]!.id,
      colour: { ...NEUTRAL_COLOUR, exposure: 0.5 },
    });
    expect(next.clips).toEqual(original.clips);
    for (const frame of [0, 20]) {
      const sample = sampleTimeline(next, frame)[0]!;
      expect(sample.colour.exposure).toBe(0.5);
      expect(sample).not.toHaveProperty('correction');
    }
    expect(history.undo()).toEqual(original);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(next);
  });

  it('captures the row value, skips unrelated channels, holds endpoints and reveals unchanged bases after removal', () => {
    let project = fixture();
    const row = project.layers[0]!;
    row.colour = { ...NEUTRAL_COLOUR, exposure: 0.5, contrast: 1.2 };
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: row.id,
      frame: 10,
      setting: 'exposure',
      value: colourAt(row, 10).exposure,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: row.id,
      frame: 20,
      setting: 'contrast',
      value: 0,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: row.id,
      frame: 30,
      setting: 'exposure',
      value: 1.5,
    });
    expect(colourAt(project.layers[0]!, 0).exposure).toBe(0.5);
    expect(colourAt(project.layers[0]!, 20).exposure).toBe(1);
    expect(colourAt(project.layers[0]!, 40).exposure).toBe(1.5);
    const clips = structuredClone(project.clips);
    for (const frame of [10, 30])
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        layerId: row.id,
        frame,
        setting: 'exposure',
        value: 0,
      });
    expect(colourAt(project.layers[0]!, 20)).toEqual({ ...row.colour, contrast: 0 });
    expect(project.layers[0]!.colour).toEqual(row.colour);
    expect(project.clips).toEqual(clips);
  });

  it('interpolates Temperature independently of Tint and restores each unchanged row base after final removal', () => {
    const original = fixture();
    const row = original.layers[0]!;
    row.colour.temperature = 0.3;
    row.colour.tint = -0.4;
    row.keyframes = [
      { frame: 10, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, temperature: -0.5, tint: 0.6 } },
      { frame: 20, interpolation: 'smooth', values: { ...EMPTY_KEY_VALUES, exposure: 0.2 } },
      { frame: 30, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, temperature: 0.5 } },
    ];
    for (const [frame, temperature] of [
      [0, -0.5],
      [20, 0],
      [40, 0.5],
    ] as const)
      expect(colourAt(row, frame)).toEqual({ ...row.colour, temperature, tint: 0.6, exposure: 0.2 });

    const history = new EditHistory(original);
    const changed = history.commit({
      type: 'layer-key-value',
      layerId: row.id,
      frame: 10,
      setting: 'temperature',
      value: 0.123456789,
    });
    expect(changed.layers[0]!.keyframes[0]).toEqual({
      ...row.keyframes[0]!,
      values: { ...row.keyframes[0]!.values, temperature: 0.123456789 },
    });
    expect(changed.layers[0]!.colour).toEqual(row.colour);
    expect(changed.clips).toEqual(original.clips);
    expect(history.undo()).toEqual(original);
    expect(history.canUndo).toBe(false);

    const reset = colourResetCommands(row, 30).reduce((project, command) => applyCommand(project, command), original);
    expect(reset.layers[0]!.keyframes).toEqual([
      row.keyframes[0],
      row.keyframes[1],
      { ...row.keyframes[2]!, values: { ...row.keyframes[2]!.values, temperature: 0 } },
    ]);
    expect(reset.layers[0]!.colour).toEqual(row.colour);
    expect(reset.clips).toEqual(original.clips);

    let project = original;
    for (const frame of [10, 30])
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        layerId: row.id,
        frame,
        setting: 'temperature',
        value: 0,
      });
    expect(project.layers[0]!.keyframes).toEqual([
      { ...row.keyframes[0]!, values: { ...row.keyframes[0]!.values, temperature: null } },
      row.keyframes[1],
    ]);
    expect(colourAt(project.layers[0]!, 20)).toEqual({ ...row.colour, tint: 0.6, exposure: 0.2 });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: row.id,
      frame: 10,
      setting: 'tint',
      value: 0,
    });
    expect(project.layers[0]!.keyframes).toEqual([row.keyframes[1]]);
    expect(colourAt(project.layers[0]!, 20)).toEqual({ ...row.colour, exposure: 0.2 });
    expect(project.layers[0]!.colour).toEqual(row.colour);
    expect(project.clips).toEqual(original.clips);
  });

  it('keeps empty-row colour editable and makes new/moved clips inherit destination appearance only', () => {
    let project = fixture();
    const destination = createLayer('destination', 'Destination');
    destination.colour.hue = 40;
    destination.keyframes = [{ frame: 0, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, saturation: 0.4 } }];
    project = applyCommand(project, { type: 'layer-add', layer: destination });
    const rows = structuredClone(project.layers);
    project = applyCommand(project, { type: 'place', clipId: 'a', layerId: destination.id, start: 0, index: 0 });
    const moved = sampleTimeline(project, 0).find((sample) => sample.clipId === 'a')!;
    expect(moved.opacity).toBe(destination.opacity);
    expect(moved.colour).toEqual({ ...destination.colour, saturation: 0.4 });
    expect(project.layers.map((row) => ({ colour: row.colour, keyframes: row.keyframes }))).toEqual(
      rows.map((row) => ({ colour: row.colour, keyframes: row.keyframes })),
    );
    const newClip = createClip('new', 'source', 0, 10, destination.id);
    project = applyCommand(project, { type: 'insert', clip: newClip, index: project.clips.length });
    expect(project.clips.find((clip) => clip.id === 'new')!).not.toHaveProperty('colour');
    expect(sampleTimeline(project, 20).find((sample) => sample.clipId === 'new')!.colour.hue).toBe(40);
  });

  it.each<EditCommand>([
    { type: 'split', clipId: 'a', sourceFrame: 10, newClipId: 'copy' },
    { type: 'duplicate', clipId: 'a', newClipId: 'copy' },
    { type: 'remove-source-range', clipId: 'a', sourceIn: 8, sourceOut: 12, newClipId: 'copy' },
  ])('preserves row bases, absolute points and source settings in $type without copying colour', (command) => {
    const project = fixture();
    project.layers[0]!.colour.brightness = 0.1;
    project.layers[0]!.keyframes = [{ frame: 100, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, hue: 20 } }];
    const next = applyCommand(project, command);
    const a = next.clips.find((clip) => clip.id === 'a')!;
    const copy = next.clips.find((clip) => clip.id === 'copy')!;
    for (const clip of [a, copy]) {
      expect(clip).not.toHaveProperty('colour');
      expect(clip).not.toHaveProperty('correction');
      expect(clip.speed).toEqual(project.clips[0]!.speed);
      expect(clip.spatial).toEqual(project.clips[0]!.spatial);
      expect(clip.mediaId).toBe(project.clips[0]!.mediaId);
    }
    expect(next.layers[0]!.opacity).toBe(project.layers[0]!.opacity);
    expect(next.layers[0]!.colour).toEqual(project.layers[0]!.colour);
    expect(next.layers[0]!.keyframes).toEqual(project.layers[0]!.keyframes);
  });

  it('resets only row appearance and rejects invalid row colour atomically', () => {
    const project = fixture();
    project.layers[0]!.colour.exposure = 0.5;
    const history = new EditHistory(project);
    const reset = history.replace(
      colourResetCommands(project.layers[0]!, 0).reduce(
        (document, command) => applyCommand(document, command),
        project,
      ),
    );
    expect(reset.layers[0]!.colour).toEqual(NEUTRAL_COLOUR);
    expect(reset.clips).toEqual(project.clips);
    expect(history.undo()).toEqual(project);
    expect(() =>
      history.commit({ type: 'colour', layerId: project.layers[0]!.id, colour: { ...NEUTRAL_COLOUR, saturation: 3 } }),
    ).toThrow();
    expect(history.current).toEqual(project);
    expect(history.canUndo).toBe(false);
  });

  it('requires complete row colour and rejects both clip fields and every older schema', () => {
    const project = fixture();
    for (let schemaVersion = 1; schemaVersion < 14; schemaVersion++)
      expect(projectSchema.safeParse({ ...project, schemaVersion }).success).toBe(false);
    const { colour: _row, ...missingRow } = project.layers[0]!;
    for (const invalid of [
      { ...project, layers: [missingRow] },
      { ...project, clips: [{ ...project.clips[0], correction: NEUTRAL_COLOUR }, project.clips[1]] },
      { ...project, clips: [{ ...project.clips[0], colour: NEUTRAL_COLOUR }, project.clips[1]] },
      { ...project, layers: [{ ...project.layers[0], colour: { exposure: 0 } }] },
    ])
      expect(projectSchema.safeParse(invalid).success).toBe(false);
    expect(projectSchema.parse(project)).toEqual(project);
    expect(createLayer('neutral', 'Neutral')).toMatchObject({ colour: NEUTRAL_COLOUR, opacity: 1 });
    expect(createClip('new', 'source', 0, 10)).not.toHaveProperty('correction');
  });

  it('keeps static nonneutral row colour on the cheap path', () => {
    const project = fixture();
    project.layers[0]!.colour.contrast = 1.2;
    expect(needsLayeredExport(project)).toBe(false);
    expect(planExport(project).clips).toHaveLength(2);
  });
});

describe('single SDR grade and bounded row LUT', () => {
  it('short-circuits exact neutral and generates one row grade in cube coordinates', () => {
    const rgb: RGB = [0.1, 0.3, 0.7];
    const row = { ...NEUTRAL_COLOUR, exposure: -2, brightness: 0.05, saturation: 0.4 };
    expect(gradePixel(rgb, NEUTRAL_COLOUR)).toBe(rgb);
    const entries = generateCube(row, 3).trim().split('\n').slice(4);
    expect(entries).toHaveLength(27);
    expect(entries[5]).toBe(
      gradePixel([1, 0.5, 0], row)
        .map((value) => value.toFixed(9))
        .join(' '),
    );
  });

  it('keys evaluated row settings, approximates one grade and retains only two reusable arrays', async () => {
    const cache = new ColourLutCache();
    const signal = new AbortController().signal;
    const row = { ...NEUTRAL_COLOUR, contrast: 1.15, brightness: 0.03, shadows: 0.1 };
    const first = await cache.get(row, signal);
    expect(await cache.get({ ...row }, signal)).toBe(first);
    const output = new Float64Array(3);
    let error = 0;
    for (let n = 0; n < 4096; n++) {
      const bytes = [(n * 73) % 256, (n * 157) % 256, Math.floor(n / 256) * 17];
      sampleColourLut(first, bytes[0]!, bytes[1]!, bytes[2]!, output);
      const exact = gradePixel([bytes[0]! / 255, bytes[1]! / 255, bytes[2]! / 255], row);
      for (let c = 0; c < 3; c++) error += Math.abs(output[c]! - exact[c]!) * 255;
    }
    expect(error / (4096 * 3)).toBeLessThan(4);
    await cache.get({ ...row, exposure: 0.2 }, signal);
    await cache.get({ ...row, hue: -10 }, signal);
    expect(cache.report).toMatchObject({ generated: 3, peakEntries: 2, bytes: 6_591_000 });
  });
});
