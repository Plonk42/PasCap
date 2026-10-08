import { describe, expect, it } from 'vitest';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { colourAt, compositePixel, opacityAt } from '../../src/shared/composition.js';
import {
  EMPTY_KEY_VALUES,
  evaluateLayerSetting,
  keySettings,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { compileLayerRetiming } from '../../src/shared/layer-retiming.js';
import { createClip, createLayer, createProject, projectSchema } from '../../src/shared/model.js';
import { validateSourceRanges } from '../../src/shared/source-range.js';
import { compileRetiming } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function layered() {
  let project = applyCommand(createProject('flight', 'Flight'), {
    type: 'insert',
    clip: createClip('bottom', 'red', 0, 100),
    index: 0,
  });
  project = applyCommand(project, {
    type: 'layer-add',
    layer: { ...createLayer('upper', 'Video 2', false), opacity: 0.5 },
  });
  return applyCommand(project, {
    type: 'insert',
    clip: { ...createClip('top', 'blue', 0, 100), layerId: 'upper', start: 20 },
    index: 1,
  });
}
describe('layer layout, compositing and edit commands', () => {
  it('defaults every row to full opacity and edits an empty row in one Undo without creating keys', () => {
    const document = createProject('empty-opacity', 'Empty opacity');
    document.layers.push(createLayer('other', 'Other'));
    expect(document.layers.map((layer) => layer.opacity)).toEqual([1, 1]);
    const history = new EditHistory(document);
    history.commit({ type: 'opacity', layerId: 'video-1', opacity: 0.23456789 });
    expect(history.current.layers[0]).toEqual({ ...document.layers[0]!, opacity: 0.23456789 });
    expect(history.current.layers[1]).toEqual(document.layers[1]);
    expect(history.current.clips).toEqual([]);
    expect(history.current.layers[0]!.keyframes).toEqual([]);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.redo().layers[0]!.opacity).toBe(0.23456789);
  });
  it('edits every clip on one row uniformly and keeps the other row, timing and clip settings independent', () => {
    const document = layered();
    const history = new EditHistory(document);
    const beforeLayout = calculateLayout(document);
    history.commit({ type: 'duplicate', clipId: 'top', newClipId: 'later' });
    const populated = history.current;
    history.commit({ type: 'opacity', layerId: 'upper', opacity: 0.3 });
    expect(history.current.clips).toEqual(populated.clips);
    expect(history.current.layers[0]).toEqual(populated.layers[0]);
    expect(history.current.layers[1]!.keyframes).toEqual([]);
    for (const frame of [50, 150])
      expect(sampleTimeline(history.current, frame).find((sample) => sample.layerId === 'upper')!.opacity).toBe(0.3);
    expect(sampleTimeline(history.current, 50)[0]!.opacity).toBe(1);
    expect(calculateLayout(history.current).clips.map(({ start, end }) => [start, end])).toEqual(
      calculateLayout(populated).clips.map(({ start, end }) => [start, end]),
    );
    expect(beforeLayout.duration).toBe(120);
    expect(history.undo()).toEqual(populated);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
  });
  it.each([-1, 1.1, NaN, Infinity])('rejects row opacity %s atomically without discarding redo', (opacity) => {
    const document = layered();
    const history = new EditHistory(document);
    const changed = history.commit({ type: 'opacity', layerId: 'upper', opacity: 0.3 });
    history.undo();
    expect(() => history.commit({ type: 'opacity', layerId: 'upper', opacity })).toThrow();
    expect(history.current).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(() => history.commit({ type: 'opacity', layerId: 'missing', opacity: 0.5 })).toThrow(
      'Layer no longer exists',
    );
    expect(history.current).toEqual(document);
    expect(history.redo()).toEqual(changed);
  });
  it('preserves primary ripple and positions overlays independently with gaps/tails', () => {
    const project = layered();
    const layout = calculateLayout(project);
    expect(layout.clips.find((clip) => clip.clip.id === 'bottom')!.end).toBe(100);
    expect(layout.duration).toBe(120);
    expect(sampleTimeline(project, 10)).toHaveLength(1);
    expect(sampleTimeline(project, 50)).toHaveLength(2);
    expect(sampleTimeline(project, 110).map((layer) => layer.clipId)).toEqual(['top']);
  });
  it('composites source-over in layer order and supports hidden rows and half-opacity rows', () => {
    const project = layered();
    const pixel = compositePixel(sampleTimeline(project, 50), (layer) =>
      layer.mediaId === 'red' ? [1, 0, 0] : [0, 0, 1],
    );
    expect(pixel[0]).toBeCloseTo(0.5);
    expect(pixel[1]).toBeCloseTo(0);
    expect(pixel[2]).toBeCloseTo(0.5);
    project.layers[1]!.enabled = false;
    expect(calculateLayout(project).duration).toBe(120);
    expect(sampleTimeline(project, 110)).toEqual([]);
  });
  it('rejects same-lane overlap but permits overlap across different layers', () => {
    const project = layered();
    expect(() =>
      applyCommand(project, {
        type: 'insert',
        clip: { ...createClip('conflict', 'blue', 0, 30), layerId: 'upper', start: 40 },
        index: 2,
      }),
    ).toThrow('cannot overlap');
    expect(() =>
      projectSchema.parse({ ...project, layers: [{ ...project.layers[0]!, id: 'wrong' }, project.layers[1]] }),
    ).toThrow();
    const removed = applyCommand(project, { type: 'layer-remove', layerId: 'video-1' });
    expect(removed.layers.map((layer) => layer.id)).toEqual(['upper']);
    expect(removed.clips).toEqual([project.clips[1]]);
    expect(() => applyCommand(removed, { type: 'layer-remove', layerId: 'upper' })).toThrow('last video track');
  });
  it('layer deletion is one undoable operation restoring its clips/grades/keys', () => {
    const project = layered();
    project.layers[1]!.colour = { ...NEUTRAL_COLOUR, exposure: 0.7, saturation: 0.4 };
    project.layers[1]!.keyframes = [point(20, { opacity: 0.3, hue: 45 }, 'smooth'), point(100, { opacity: 0.8 })];
    const history = new EditHistory(project);
    history.commit({ type: 'layer-remove', layerId: 'upper' });
    expect(history.current.clips).toHaveLength(1);
    expect(history.undo().clips).toHaveLength(2);
    expect(history.current.clips[1]).not.toHaveProperty('opacity');
    expect(history.current.layers[1]!.opacity).toBe(0.5);
    expect(history.current).toEqual(project);
    expect(history.redo().layers.map((layer) => layer.id)).toEqual(['video-1']);
  });
  it('duplicates independent static clip settings while retaining one shared row curve as one undo step', () => {
    const project = layered();
    project.layers[1]!.keyframes = [point(20, { exposure: 0.4, opacity: 0.75 }, 'smooth')];
    const history = new EditHistory(project);
    const original = history.current.clips[1]!;
    history.commit({ type: 'duplicate', clipId: original.id, newClipId: 'copy' });
    const copy = history.current.clips.find((clip) => clip.id === 'copy')!;
    expect(copy).toEqual({ ...original, id: 'copy', start: 120 });
    expect(copy).not.toHaveProperty('animation');
    expect(history.current.layers[1]!.keyframes).toEqual(project.layers[1]!.keyframes);
    expect(sampleTimeline(history.current, 150)[0]).toMatchObject({
      clipId: 'copy',
      colour: { exposure: 0.4 },
      opacity: 0.75,
    });
    expect(copy).not.toHaveProperty('colour');
    expect(copy).not.toHaveProperty('correction');
    expect(history.current.layers[1]!.colour).toEqual(project.layers[1]!.colour);
    history.undo();
    expect(history.current).toEqual(project);
  });
  it('primary duplicate inserts directly after its source and repairs transition adjacency', () => {
    const document = layered();
    const copy = applyCommand(document, { type: 'duplicate', clipId: 'bottom', newClipId: 'copy' });
    expect(copy.clips.map((clip) => clip.id)).toEqual(['bottom', 'copy', 'top']);
    expect(copy.layers[0]!.transitions).toEqual([{ leftId: 'bottom', rightId: 'copy', type: 'cut', duration: 0 }]);
    expect(() => applyCommand(copy, { type: 'duplicate', clipId: 'bottom', newClipId: 'copy' })).toThrow();
  });
  it('moving a primary clip into an overlay repairs boundaries and rejects bad placements atomically', () => {
    let project = layered();
    project.layers[1]!.keyframes = [point(0, { opacity: 0, hue: -90 }), point(100, { opacity: 1, hue: 90 })];
    const keys = structuredClone(project.layers[1]!.keyframes);
    project = applyCommand(project, { type: 'place', clipId: 'bottom', layerId: 'video-1', start: 0, index: 0 });
    expect(() =>
      applyCommand(project, { type: 'place', clipId: 'bottom', layerId: 'upper', start: 0, index: 0 }),
    ).toThrow();
    expect(project.clips[0]?.layerId).toBe('video-1');
    project = applyCommand(project, { type: 'place', clipId: 'top', layerId: 'upper', start: 150, index: 1 });
    expect(calculateLayout(project).duration).toBe(250);
    expect(project.layers[1]!.keyframes).toEqual(keys);
    expect(sampleTimeline(project, 150)[0]).toMatchObject({
      clipId: 'top',
      sourceFrame: 0,
      opacity: 1,
      colour: { hue: 90 },
    });
  });
  it.each([-1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid placement index %s without mutating the committed clips',
    (index) => {
      const project = layered();
      const before = JSON.stringify(project);
      expect(() =>
        applyCommand(project, { type: 'place', clipId: 'top', layerId: 'video-1', start: 0, index }),
      ).toThrow('Invalid placement index');
      expect(JSON.stringify(project)).toBe(before);
    },
  );
  it('rejects deleting an unknown layer without touching existing layers or clips', () => {
    const project = layered();
    const before = JSON.stringify(project);
    expect(() => applyCommand(project, { type: 'layer-remove', layerId: 'missing' })).toThrow('Layer no longer exists');
    expect(JSON.stringify(project)).toBe(before);
  });
});
describe('project-frame shared row settings', () => {
  it('evaluates hold/easing with deterministic endpoints', () => {
    for (const interpolation of ['hold', 'linear', 'ease-in', 'ease-out', 'smooth'] as const) {
      const layer = {
        keyframes: [
          point(0, { opacity: 0 }, interpolation),
          point(25, { hue: 90 }, 'hold'),
          point(100, { opacity: 1 }, interpolation),
        ],
      };
      expect(evaluateLayerSetting(layer, 'opacity', -10, 1)).toBe(0);
      expect(evaluateLayerSetting(layer, 'opacity', 100, 0)).toBe(1);
      expect(evaluateLayerSetting(layer, 'opacity', 150, 0)).toBe(1);
      expect(evaluateLayerSetting(layer, 'opacity', 50, 1)).toBeCloseTo(
        { hold: 0, linear: 0.5, 'ease-in': 0.25, 'ease-out': 0.75, smooth: 0.5 }[interpolation],
      );
    }
  });
  it('interpolates grading parameters, not independently graded endpoint pixels', () => {
    const layer = {
      ...createProject('p', 'P').layers[0]!,
      keyframes: [point(0, { exposure: -1, saturation: 0.5 }), point(80, { exposure: 1, saturation: 1.5 })],
    };
    expect(colourAt(layer, 40)).toEqual(NEUTRAL_COLOUR);
  });
  it('keeps all nine static grade controls and unkeyed channels independent of participating parameters', () => {
    const clip = createClip('one', 'source', 300, 400);
    clip.speed = { mode: 'constant', rate: 0.5 };
    const layer = { ...createProject('p', 'P').layers[0]!, opacity: 0.7 };
    layer.colour = {
      ...NEUTRAL_COLOUR,
      temperature: 0.2,
      tint: -0.3,
      exposure: 0.7,
      brightness: 0.09,
      contrast: 0.8,
      hue: 30,
      saturation: 0.65,
      highlights: 0.25,
      shadows: -0.2,
    };
    for (const frame of [-10, 0, 50, 500]) {
      expect(colourAt(layer, frame)).toEqual(layer.colour);
      expect(opacityAt(layer, frame)).toBe(0.7);
    }
    layer.keyframes = [
      point(0, { exposure: -1, opacity: 0 }),
      point(25, { hue: 90 }, 'hold'),
      point(100, { exposure: 1, opacity: 1 }),
    ];
    expect(colourAt(layer, 50)).toEqual({ ...layer.colour, exposure: 0, hue: 90 });
    expect(opacityAt(layer, 50)).toBe(0.5);
    expect(layer.opacity).toBe(0.7);
    expect(compileLayerRetiming(clip, layer, 50)).toBe(compileRetiming(clip));
    expect(layer.colour.exposure).toBe(0.7);
    expect(layer.colour.hue).toBe(30);
  });
  it('opacity/speed/colour points survive trim/restoration/split at their absolute project frames', () => {
    let project = applyCommand(createProject('p', 'P'), {
      type: 'insert',
      clip: createClip('a', 'source', 0, 100),
      index: 0,
    });
    project = applyCommand(project, {
      type: 'colour',
      layerId: 'video-1',
      colour: { ...NEUTRAL_COLOUR, brightness: 0.1 },
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: 'video-1',
      frame: 10,
      setting: 'opacity',
      value: 0,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: 'video-1',
      frame: 80,
      setting: 'opacity',
      value: 1,
    });
    project = applyCommand(project, {
      type: 'layer-key-easing',
      layerId: 'video-1',
      frame: 80,
      interpolation: 'smooth',
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: 'video-1',
      frame: 0,
      setting: 'speed',
      value: 1,
    });
    project = applyCommand(project, { type: 'layer-key-easing', layerId: 'video-1', frame: 0, interpolation: 'hold' });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: 'video-1',
      frame: 80,
      setting: 'speed',
      value: 2,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: 'video-1',
      frame: 10,
      setting: 'exposure',
      value: -0.5,
    });
    project = applyCommand(project, {
      type: 'layer-key-toggle',
      layerId: 'video-1',
      frame: 80,
      setting: 'exposure',
      value: 0.5,
    });
    const original = project;
    const keys = structuredClone(project.layers[0]!.keyframes);
    project = applyCommand(project, { type: 'trim', clipId: 'a', sourceIn: 30, sourceOut: 90 });
    expect(project.layers[0]!.keyframes).toEqual(keys);
    expect(calculateLayout(project).duration).toBe(60);
    project = applyCommand(project, { type: 'trim', clipId: 'a', sourceIn: 0, sourceOut: 100 });
    expect(project).toEqual(original);
    project = applyCommand(project, { type: 'split', clipId: 'a', sourceFrame: 50, newClipId: 'b' });
    expect(project.layers[0]!.keyframes).toEqual(keys);
    expect(project.layers[0]!.colour).toEqual(original.layers[0]!.colour);
    expect(project.clips[1]!.speed).toEqual(project.clips[0]!.speed);
    expect(project.clips.every((clip) => !('animation' in clip))).toBe(true);
    const layout = calculateLayout(project);
    expect(layout.clips.map(({ start, duration, end }) => ({ start, duration, end }))).toEqual([
      { start: 0, duration: 50, end: 50 },
      { start: 50, duration: 40, end: 90 },
    ]);
    expect(layout.clips[1]!.retiming.sourceAt(0)).toBe(50);
    expect(layout.clips[1]!.duration).toBeGreaterThan(0);
    expect(sampleTimeline(project, 75)[0]).toEqual({ ...sampleTimeline(original, 75)[0]!, clipId: 'b' });
  });
  it('keeps row points in project time, rejects point collisions and validates source ranges separately', () => {
    const project = layered();
    project.layers[1]!.keyframes = [
      point(0, { opacity: 0 }),
      point(100, { opacity: 1 }),
      point(150, { exposure: 0.7 }),
    ];
    expect(sampleTimeline(project, 50)[1]?.opacity).toBe(0.5);
    const before = JSON.stringify(project);
    expect(() =>
      applyCommand(project, {
        type: 'layer-update',
        layer: { ...project.layers[1]!, keyframes: [point(10, { opacity: 0 }), point(10, { hue: 90 })] },
      }),
    ).toThrow();
    expect(JSON.stringify(project)).toBe(before);
    expect(projectSchema.parse(project).layers[1]!.keyframes.at(-1)!.frame).toBe(150);
    expect(() =>
      validateSourceRanges(
        project,
        new Map([
          ['red', 100],
          ['blue', 100],
        ]),
      ),
    ).not.toThrow();
    project.clips[1]!.sourceOut = 101;
    expect(() =>
      validateSourceRanges(
        project,
        new Map([
          ['red', 100],
          ['blue', 100],
        ]),
      ),
    ).toThrow('Source range');
  });
  it('moves, eases, edits and removes an entire shared point atomically without merging other settings', () => {
    const project = layered();
    project.layers[1]!.keyframes = [
      point(10, { opacity: 0.4, exposure: 1, saturation: 0.6 }, 'smooth'),
      point(20, { hue: 45 }, 'hold'),
    ];
    const history = new EditHistory(project);
    expect(() => history.commit({ type: 'layer-key-move', layerId: 'upper', frame: 10, nextFrame: 20 })).toThrow(
      'destination frame',
    );
    expect(history.current).toEqual(project);
    expect(history.canUndo).toBe(false);
    history.commit({ type: 'layer-key-move', layerId: 'upper', frame: 10, nextFrame: 30 });
    expect(history.current.layers[1]!.keyframes).toEqual([
      project.layers[1]!.keyframes[1],
      { ...project.layers[1]!.keyframes[0]!, frame: 30 },
    ]);
    history.commit({ type: 'layer-key-easing', layerId: 'upper', frame: 30, interpolation: 'ease-out' });
    history.commit({ type: 'layer-key-value', layerId: 'upper', frame: 30, setting: 'exposure', value: -1 });
    expect(history.current.layers[1]!.keyframes[1]).toEqual(
      point(30, { opacity: 0.4, exposure: -1, saturation: 0.6 }, 'ease-out'),
    );
    expect(keySettings(history.current.layers[1]!.keyframes[1]!)).toEqual(['opacity', 'exposure', 'saturation']);
    history.commit({ type: 'layer-key-remove', layerId: 'upper', frame: 30 });
    expect(history.current.layers[1]!.keyframes).toEqual([project.layers[1]!.keyframes[1]]);
    expect(history.undo().layers[1]!.keyframes[1]).toEqual(
      point(30, { opacity: 0.4, exposure: -1, saturation: 0.6 }, 'ease-out'),
    );
    expect(project.layers[1]!.keyframes[0]).toEqual(
      point(10, { opacity: 0.4, exposure: 1, saturation: 0.6 }, 'smooth'),
    );
  });
});
