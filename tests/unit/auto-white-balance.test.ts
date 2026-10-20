import { describe, expect, it } from 'vitest';
import { EditHistory, applyCommand } from '../../src/shared/commands.js';
import { colourAt } from '../../src/shared/composition.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS, layerKeyframe, joiningEasing } from '../../src/shared/keyframes.js';
import {
  createClip,
  createLayer,
  createProject,
  MAX_TRACK_KEYFRAMES,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { clipAtPlayhead, whiteBalanceCommands, whiteBalanceTarget } from '../../src/web/auto-white-balance.js';
import { analysisAsset as asset } from './analysis-asset.js';

/** Clip A (source 100–400, 1×) then B (reversed 2×, source 0–300) after a 10-frame dissolve. */
function project(): ProjectDocument {
  const document = createProject('awb', 'Auto white balance');
  document.layers.push(createLayer('empty', 'Empty track'));
  document.clips = [
    createClip('a', 'one', 100, 400),
    { ...createClip('b', 'two', 0, 300), speed: { mode: 'constant', rate: 2 }, reverse: true },
  ];
  document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 10 }];
  return applyCommand(document, { type: 'fades', layerId: document.layers[0]!.id, opening: 0, closing: 0 });
}

const ASSETS = [asset('one'), asset('two')];

describe('Auto white balance target', () => {
  it('analyses the clip at the playhead through its retiming, reversed clips included', () => {
    const document = project();
    const layout = calculateLayout(document);
    const layer = document.layers[0]!;
    const a = whiteBalanceTarget(layer, layout, ASSETS, 100, null);
    expect(a.reason).toBeNull();
    expect(a.target!.clip.clip.id).toBe('a');
    expect(a.target!.projectFrames).toEqual([70, 74, 77, 81, 85, 89, 92, 96, 100, 104, 109, 113, 117, 121, 126, 130]);
    expect(a.target!.sourceFrames).toEqual([
      170, 174, 177, 181, 185, 189, 192, 196, 200, 204, 209, 213, 217, 221, 226, 230,
    ]);
    const b = whiteBalanceTarget(layer, layout, ASSETS, 400, null).target!;
    expect(b.clip.clip.id).toBe('b');
    const placed = layout.clips[1]!;
    expect(b.sourceFrames).toEqual(b.projectFrames.map((frame) => placed.retiming.sourceAt(frame - placed.start)));
    // Reversed: later project frames show earlier source frames, two apart at 2×.
    expect(b.sourceFrames.every((frame, index) => index === 0 || frame < b.sourceFrames[index - 1]!)).toBe(true);
  });

  it('never crosses a cut and follows the dissolve’s dominant clip unless the selected clip is there', () => {
    const document = project();
    const layout = calculateLayout(document);
    const [a, b] = layout.clips as [(typeof layout.clips)[0], (typeof layout.clips)[0]];
    expect(b.start).toBe(a.end - 10);
    expect(clipAtPlayhead(layout, 'video-1', b.start + 4, null)!.clip.id).toBe('a');
    expect(clipAtPlayhead(layout, 'video-1', b.start + 5, null)!.clip.id).toBe('b');
    expect(clipAtPlayhead(layout, 'video-1', b.start + 1, 'b')!.clip.id).toBe('b');
    expect(clipAtPlayhead(layout, 'video-1', a.start, 'b')!.clip.id).toBe('a');
    const target = whiteBalanceTarget(document.layers[0]!, layout, ASSETS, a.end - 12, null).target!;
    expect(target.projectFrames.every((frame) => frame < a.end)).toBe(true);
  });

  it('explains why it cannot run', () => {
    const document = project();
    const layout = calculateLayout(document);
    const [layer, empty] = document.layers as [ProjectDocument['layers'][0], ProjectDocument['layers'][0]];
    expect(whiteBalanceTarget(empty, layout, ASSETS, 100, null).reason).toMatch(/Move the playhead over a clip/);
    expect(whiteBalanceTarget(layer, layout, ASSETS, layout.duration, null).reason).toMatch(/Move the playhead/);
    expect(whiteBalanceTarget(layer, layout, [asset('one', 'preparing'), asset('two')], 100, null).reason).toMatch(
      /Prepare the recording/,
    );
    expect(whiteBalanceTarget(layer, layout, [ASSETS[1]!], 100, null).reason).toMatch(/Prepare the recording/);
    const full = {
      ...layer,
      keyframes: Array.from({ length: MAX_TRACK_KEYFRAMES }, (_, index) =>
        layerKeyframe(1000 + index, { ...EMPTY_KEY_VALUES, exposure: 0.5 }, 'linear'),
      ),
    };
    expect(whiteBalanceTarget(full, layout, ASSETS, 100, null).reason).toMatch(/already has 256 keyframes/);
    const joining = {
      ...full,
      keyframes: [layerKeyframe(100, { ...EMPTY_KEY_VALUES, hue: 4 }, 'smooth'), ...full.keyframes.slice(1)],
    };
    expect(joining.keyframes).toHaveLength(MAX_TRACK_KEYFRAMES);
    expect(whiteBalanceTarget(joining, layout, ASSETS, 100, null).reason).toBeNull();
  });
});

describe('Auto white balance capture', () => {
  const balance = { temperature: 0.214, tint: -0.031 };

  it('creates one keyframe at the playhead with both settings, in one Undo step', () => {
    const document = project();
    const before = structuredClone(document);
    const commands = whiteBalanceCommands(document.layers[0]!, 120, balance);
    expect(commands.map((command) => command.type)).toEqual(['layer-key-toggle', 'layer-key-toggle']);
    const next = commands.reduce(applyCommand, document);
    expect(next.layers[0]!.keyframes).toEqual([
      layerKeyframe(120, { ...EMPTY_KEY_VALUES, temperature: 0.214, tint: -0.031 }, 'linear'),
    ]);
    expect({ ...next, layers: [{ ...next.layers[0]!, keyframes: [] }, next.layers[1]] }).toEqual(before);
    const history = new EditHistory(document);
    history.replace(next);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('joins an existing keyframe like the diamonds and overwrites only its two values', () => {
    const document = project();
    const layer = document.layers[0]!;
    layer.colour.exposure = 0.3;
    layer.keyframes = [
      layerKeyframe(120, { ...EMPTY_KEY_VALUES, exposure: 0.5, opacity: 0.8 }, 'smooth'),
      layerKeyframe(200, { ...EMPTY_KEY_VALUES, exposure: -0.5, temperature: 1.2 }, 'hold'),
    ];
    const joined = whiteBalanceCommands(layer, 120, balance).reduce(applyCommand, document);
    const point = joined.layers[0]!.keyframes[0]!;
    const order = KEYFRAME_SETTINGS.map((setting) => setting.key);
    expect(point.values).toEqual({ ...layer.keyframes[0]!.values, temperature: 0.214, tint: -0.031 });
    expect(point.easing).toEqual({
      ...layer.keyframes[0]!.easing,
      temperature: joiningEasing(layer.keyframes, layer.keyframes[0]!, order),
      tint: joiningEasing(layer.keyframes, layer.keyframes[0]!, order),
    });
    expect(joined.layers[0]!.keyframes[1]).toEqual(layer.keyframes[1]);
    expect(joined.layers[0]!.colour).toEqual(layer.colour);

    const rerun = whiteBalanceCommands(joined.layers[0]!, 120, { temperature: -0.1, tint: 0.05 });
    expect(rerun.map((command) => command.type)).toEqual(['layer-key-value', 'layer-key-value']);
    const updated = rerun.reduce(applyCommand, joined);
    expect(updated.layers[0]!.keyframes[0]).toEqual({
      ...point,
      values: { ...point.values, temperature: -0.1, tint: 0.05 },
    });
    expect(updated.layers[0]!.keyframes[1]).toEqual(layer.keyframes[1]);
  });

  it('interpolates between two runs in preview and export sampling', () => {
    let document = project();
    const layer = (): ProjectDocument['layers'][0] => document.layers[0]!;
    document = whiteBalanceCommands(layer(), 100, { temperature: 0.4, tint: -0.1 }).reduce(applyCommand, document);
    document = whiteBalanceCommands(layer(), 400, { temperature: -0.2, tint: 0.2 }).reduce(applyCommand, document);
    expect(layer().keyframes.map((key) => key.frame)).toEqual([100, 400]);
    const middle = colourAt(layer(), 250);
    expect(middle.temperature).toBeCloseTo(0.1, 12);
    expect(middle.tint).toBeCloseTo(0.05, 12);
    expect(colourAt(layer(), 50).temperature).toBe(0.4);
    expect(colourAt(layer(), 430).temperature).toBe(-0.2);
    // Preview and native export both read this sampled per-source colour.
    const sampled = sampleTimeline(document, 250);
    expect(sampled.map((item) => item.colour.temperature)).toEqual([middle.temperature]);
  });
});
