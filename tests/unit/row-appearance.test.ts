import { describe, expect, it } from 'vitest';
import { ColourLutCache, sampleColourLut } from '../../src/server/layered-colour.js';
import { createColourSettings, generateCube, gradePixel, NEUTRAL_COLOUR, type RGB } from '../../src/shared/colour.js';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { adjustmentColour } from '../../src/shared/composition.js';
import { needsLayeredExport, planExport } from '../../src/shared/export.js';
import { adjustmentColourAt, createAdjustment, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe, uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE, SPATIAL_CHANNELS, type SpatialChannel } from '../../src/shared/spatial.js';
import { sampleTimeline } from '../../src/shared/timeline.js';
import { adjustmentColourOwner } from '../../src/web/colour-owner.js';
import { colourResetCommands } from '../../src/web/colour-reset.js';
import { EARLIER_SCHEMA_VERSIONS } from './project-fixtures.js';

const NO_SETTINGS = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as Record<
  SpatialChannel,
  null
>;

/** Two shots on one track under an adjustment from project frame 0, so its keyframe frames are project frames. */
function fixture(): ProjectDocument {
  const project = createProject('appearance', 'Appearance');
  project.clips = [createClip('a', 'source', 0, 20), { ...createClip('b', 'source', 20, 40), start: 20 }];
  project.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
  project.adjustments = [createAdjustment('look', 0, 1_000)];
  return projectSchema.parse(project);
}

describe('adjustment, clip grade and track Transform ownership', () => {
  it('applies an adjustment to both shots without changing their clip data', () => {
    const original = fixture();
    const history = new EditHistory(original);
    const next = history.commit({
      type: 'colour',
      adjustmentId: 'look',
      colour: { ...NEUTRAL_COLOUR, exposure: 0.5 },
    });
    expect(next.clips).toEqual(original.clips);
    expect(next.layers).toEqual(original.layers);
    for (const frame of [0, 20]) {
      const sample = sampleTimeline(next, frame)[0]!;
      expect(sample.colour.exposure).toBe(0.5);
      expect(sample.grade).toEqual(NEUTRAL_COLOUR);
      expect(sample).not.toHaveProperty('correction');
    }
    expect(history.undo()).toEqual(original);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(next);
  });

  it('captures the adjustment value, skips unrelated settings, holds endpoints and reveals unchanged bases after removal', () => {
    let project = fixture();
    project.adjustments[0]!.colour = { ...NEUTRAL_COLOUR, exposure: 0.5, contrast: 1.2 };
    const item = structuredClone(project.adjustments[0]!);
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 10,
      setting: 'exposure',
      value: adjustmentColourAt(item, 10).exposure,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 20,
      setting: 'contrast',
      value: 0,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 30,
      setting: 'exposure',
      value: 1.5,
    });
    expect(adjustmentColour(project, 0).exposure).toBe(0.5);
    expect(adjustmentColour(project, 20).exposure).toBe(1);
    expect(adjustmentColour(project, 40).exposure).toBe(1.5);
    const clips = structuredClone(project.clips);
    for (const frame of [10, 30])
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        adjustmentId: 'look',
        frame,
        setting: 'exposure',
        value: 0,
      });
    expect(adjustmentColour(project, 20)).toEqual({ ...item.colour, contrast: 0 });
    expect(project.adjustments[0]!.colour).toEqual(item.colour);
    expect(project.clips).toEqual(clips);
  });

  it('interpolates Temperature independently of Tint and restores each unchanged adjustment base after final removal', () => {
    const original = fixture();
    const item = original.adjustments[0]!;
    item.colour.temperature = 0.3;
    item.colour.tint = -0.4;
    item.keyframes = [
      layerKeyframe(10, { ...EMPTY_KEY_VALUES, temperature: -0.5, tint: 0.6 }, 'linear'),
      layerKeyframe(20, { ...EMPTY_KEY_VALUES, exposure: 0.2 }, 'smooth'),
      layerKeyframe(30, { ...EMPTY_KEY_VALUES, temperature: 0.5 }, 'hold'),
    ].map(layerKeyAsGradeKey);
    for (const [frame, temperature] of [
      [0, -0.5],
      [20, 0],
      [40, 0.5],
    ] as const)
      expect(adjustmentColourAt(item, frame)).toEqual({ ...item.colour, temperature, tint: 0.6, exposure: 0.2 });

    const history = new EditHistory(original);
    const changed = history.commit({
      type: 'layer-key-value',
      adjustmentId: 'look',
      frame: 10,
      setting: 'temperature',
      value: 0.123456789,
    });
    expect(changed.adjustments[0]!.keyframes[0]).toEqual({
      ...item.keyframes[0]!,
      values: { ...item.keyframes[0]!.values, temperature: 0.123456789 },
    });
    expect(changed.adjustments[0]!.colour).toEqual(item.colour);
    expect(changed.clips).toEqual(original.clips);
    expect(history.undo()).toEqual(original);
    expect(history.canUndo).toBe(false);

    const reset = colourResetCommands(adjustmentColourOwner(item, 'Look'), 30).reduce(
      (project, command) => applyCommand(project, command),
      original,
    );
    expect(reset.adjustments[0]!.keyframes).toEqual([
      item.keyframes[0],
      item.keyframes[1],
      { ...item.keyframes[2]!, values: { ...item.keyframes[2]!.values, temperature: 0 } },
    ]);
    expect(reset.adjustments[0]!.colour).toEqual(item.colour);
    expect(reset.clips).toEqual(original.clips);

    let project = original;
    for (const frame of [10, 30])
      project = applyCommand(project, {
        type: 'layer-key-toggle',
        adjustmentId: 'look',
        frame,
        setting: 'temperature',
        value: 0,
      });
    expect(project.adjustments[0]!.keyframes).toEqual([
      {
        ...item.keyframes[0]!,
        values: { ...item.keyframes[0]!.values, temperature: null },
        easing: { ...item.keyframes[0]!.easing, temperature: null },
      },
      item.keyframes[1],
    ]);
    expect(adjustmentColour(project, 20)).toEqual({ ...item.colour, tint: 0.6, exposure: 0.2 });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      adjustmentId: 'look',
      frame: 10,
      setting: 'tint',
      value: 0,
    });
    expect(project.adjustments[0]!.keyframes).toEqual([item.keyframes[1]]);
    expect(adjustmentColour(project, 20)).toEqual({ ...item.colour, exposure: 0.2 });
    expect(project.adjustments[0]!.colour).toEqual(item.colour);
    expect(project.clips).toEqual(original.clips);
  });

  it('makes new/moved clips adopt the destination track’s Transform and Opacity, keeping their own grade', () => {
    let project = fixture();
    project.clips[0]!.grade.colour.hue = 40;
    const destination = createLayer('destination', 'Destination');
    destination.transform.base.opacity = 0.6;
    destination.transform.keyframes = [{ ...uniformKeyframe(0, { ...NO_SETTINGS, scale: 0.5 }, 'hold'), reset: false }];
    project = applyCommand(project, { type: 'layer-add', layer: destination });
    const layers = structuredClone(project.layers);
    project = applyCommand(project, { type: 'place', clipId: 'a', layerId: destination.id, start: 0, index: 0 });
    const moved = sampleTimeline(project, 0).find((sample) => sample.clipId === 'a')!;
    expect(moved.opacity).toBe(0.6);
    expect(moved.spatial).toEqual({ ...NEUTRAL_SPATIAL_POSE, scale: 0.5, opacity: 0.6 });
    expect(moved.grade.hue).toBe(40);
    expect(project.layers.map((layer) => layer.transform)).toEqual(layers.map((layer) => layer.transform));
    const newClip = createClip('new', 'source', 0, 10, destination.id);
    project = applyCommand(project, { type: 'insert', clip: newClip, index: project.clips.length });
    expect(project.clips.find((clip) => clip.id === 'new')!).not.toHaveProperty('colour');
    expect(sampleTimeline(project, 20).find((sample) => sample.clipId === 'new')).toMatchObject({
      opacity: 0.6,
      spatial: { scale: 0.5 },
      grade: { hue: 0 },
    });
  });

  it.each<EditCommand>([
    { type: 'split', clipId: 'a', sourceFrame: 10, newClipId: 'copy' },
    { type: 'duplicate', clipId: 'a', newClipId: 'copy' },
    { type: 'remove-source-range', clipId: 'a', sourceIn: 8, sourceOut: 12, newClipId: 'copy' },
  ])('preserves the track Transform, adjustments and source settings in $type, copying the clip grade', (command) => {
    const project = fixture();
    project.layers[0]!.transform.base.opacity = 0.8;
    project.layers[0]!.transform.keyframes = [
      { ...uniformKeyframe(100, { ...NO_SETTINGS, rotation: 20 }, 'hold'), reset: false },
    ];
    project.adjustments[0]!.colour.brightness = 0.1;
    project.adjustments[0]!.keyframes = [
      layerKeyAsGradeKey(layerKeyframe(100, { ...EMPTY_KEY_VALUES, hue: 20 }, 'hold')),
    ];
    project.clips[0]!.grade.colour.contrast = 1.3;
    const next = applyCommand(project, command);
    const a = next.clips.find((clip) => clip.id === 'a')!;
    const copy = next.clips.find((clip) => clip.id === 'copy')!;
    for (const clip of [a, copy]) {
      expect(clip).not.toHaveProperty('colour');
      expect(clip).not.toHaveProperty('correction');
      expect(clip.grade).toEqual(project.clips[0]!.grade);
      expect(clip.speed).toEqual(project.clips[0]!.speed);
      expect(clip).not.toHaveProperty('spatial');
      expect(clip.mediaId).toBe(project.clips[0]!.mediaId);
    }
    expect(a.grade).not.toBe(copy.grade);
    expect(next.layers[0]!.transform).toEqual(project.layers[0]!.transform);
    expect(next.adjustments).toEqual(project.adjustments);
  });

  it('resets only the adjustment and rejects invalid adjustment colour atomically', () => {
    const project = fixture();
    project.adjustments[0]!.colour.exposure = 0.5;
    const history = new EditHistory(project);
    const reset = history.replace(
      colourResetCommands(adjustmentColourOwner(project.adjustments[0]!, 'Look'), 0).reduce(
        (document, command) => applyCommand(document, command),
        project,
      ),
    );
    expect(reset.adjustments[0]!.colour).toEqual(NEUTRAL_COLOUR);
    expect(reset.clips).toEqual(project.clips);
    expect(reset.layers).toEqual(project.layers);
    expect(history.undo()).toEqual(project);
    expect(() =>
      history.commit({ type: 'colour', adjustmentId: 'look', colour: { ...NEUTRAL_COLOUR, saturation: 3 } }),
    ).toThrow();
    expect(history.current).toEqual(project);
    expect(history.canUndo).toBe(false);
  });

  it('rejects track Colour, saved clip colour fields, incomplete grade colour and every older schema', () => {
    const project = fixture();
    for (const schemaVersion of EARLIER_SCHEMA_VERSIONS)
      expect(projectSchema.safeParse({ ...project, schemaVersion }).success).toBe(false);
    for (const invalid of [
      { ...project, layers: [{ ...project.layers[0], colour: createColourSettings() }] },
      { ...project, clips: [{ ...project.clips[0], correction: NEUTRAL_COLOUR }, project.clips[1]] },
      { ...project, clips: [{ ...project.clips[0], colour: NEUTRAL_COLOUR }, project.clips[1]] },
      {
        ...project,
        clips: [{ ...project.clips[0], grade: { colour: { exposure: 0 }, keyframes: [] } }, project.clips[1]],
      },
      { ...project, adjustments: [{ ...project.adjustments[0], colour: { exposure: 0 } }] },
    ])
      expect(projectSchema.safeParse(invalid).success).toBe(false);
    expect(projectSchema.parse(project)).toEqual(project);
    expect(createLayer('neutral', 'Neutral')).not.toHaveProperty('colour');
    expect(createLayer('neutral', 'Neutral').transform.base.opacity).toBe(1);
    expect(createClip('new', 'source', 0, 10)).not.toHaveProperty('correction');
    expect(createClip('new', 'source', 0, 10).grade).toEqual({ colour: NEUTRAL_COLOUR, keyframes: [] });
  });

  it('keeps a static nonneutral clip grade on the cheap path', () => {
    const project = { ...fixture(), adjustments: [] };
    project.clips[0]!.grade.colour.contrast = 1.2;
    expect(needsLayeredExport(project)).toBe(false);
    expect(planExport(project).clips).toHaveLength(2);
  });
});

describe('single SDR grade and bounded LUT', () => {
  it('short-circuits exact neutral and generates one grade in cube coordinates', () => {
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

  it('keys evaluated settings, approximates one grade and retains only two reusable arrays', async () => {
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
