import { describe, expect, it } from 'vitest';
import { AUTO_ADJUST, autoAdjustFrames, scaleCorrection, type AutoCorrection } from '../../src/shared/auto-adjust.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  animatedSettings,
  autoAdjustCommand,
  autoAdjustTarget,
  cachedAnalysis,
  rememberAnalysis,
  settingLabel,
} from '../../src/web/auto-adjust.js';
import { analysisAsset as asset } from './analysis-asset.js';

/** Clip A (source 100–400) cut to a reversed clip B (source 0–300 at 2×), on one track; an empty second track. */
function project(): ProjectDocument {
  const document = createProject('auto', 'Auto adjust');
  document.layers.push(createLayer('empty', 'Empty track'));
  document.clips = [
    createClip('a', 'one', 100, 400),
    { ...createClip('b', 'two', 0, 300), speed: { mode: 'constant', rate: 2 }, reverse: true },
  ];
  document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
  return document;
}

const ASSETS = [asset('one'), asset('two')];

const CORRECTION: AutoCorrection = {
  temperature: 0.3,
  tint: -0.1,
  saturation: 1.44,
  exposure: 0.6,
  brightness: 0.04,
  contrast: 1.21,
  highlights: -0.2,
  shadows: 0.1,
  whites: 0.3,
  blacks: -0.5,
};

describe('Auto adjust target', () => {
  it('analyses the whole source range of the clip at the playhead, reversed or retimed', () => {
    const document = project();
    const layout = calculateLayout(document);
    const layer = document.layers[0]!;
    const a = autoAdjustTarget(layer, layout, ASSETS, 10, null).target!;
    expect(a.clip.clip.id).toBe('a');
    expect(a.sourceFrames).toEqual(autoAdjustFrames(100, 400));
    const b = autoAdjustTarget(layer, layout, ASSETS, layout.clips[1]!.start + 3, null).target!;
    expect(b.clip.clip.id).toBe('b');
    expect(b.sourceFrames).toEqual(autoAdjustFrames(0, 300));
    expect(b.key).not.toBe(a.key);
  });

  it('explains why it cannot run', () => {
    const document = project();
    const layout = calculateLayout(document);
    const [layer, empty] = document.layers as [ProjectDocument['layers'][0], ProjectDocument['layers'][0]];
    expect(autoAdjustTarget(empty, layout, ASSETS, 10, null).reason).toBe(
      'Move the playhead over a clip on Empty track to analyse it.',
    );
    expect(autoAdjustTarget(layer, layout, ASSETS, layout.duration, null).reason).toMatch(/Move the playhead/);
    expect(autoAdjustTarget(layer, layout, [asset('one', 'preparing'), ASSETS[1]!], 10, null).reason).toBe(
      'Prepare the recording of the clip at the playhead first.',
    );
  });
});

describe('Auto adjust edit', () => {
  it('replaces the ten settings with the scaled correction in one Colour edit and one Undo step', () => {
    const document = project();
    const layer = document.layers[0]!;
    layer.colour = { ...layer.colour, hue: 12, vibrance: 0.4, hdr: 0.3, localContrast: 0.2, exposure: -1 };
    layer.colour.hsl.red.saturation = 0.25;
    layer.opacity = 0.8;
    const before = structuredClone(document);
    const command = autoAdjustCommand(layer, CORRECTION, 0.5)!;
    const next = applyCommand(document, command);
    const scaled = scaleCorrection(CORRECTION, 0.5);
    expect(next.layers[0]!.colour).toEqual({ ...layer.colour, ...scaled });
    // Hue, Vibrance, HDR, Local contrast, HSL, curves, Opacity, Transform and keyframes are untouched.
    expect({ ...next.layers[0]!, colour: before.layers[0]!.colour }).toEqual(before.layers[0]);
    expect(next.layers[0]!.colour.hsl).toEqual(before.layers[0]!.colour.hsl);
    expect(next.layers[1]).toEqual(before.layers[1]);
    expect(next.clips).toEqual(before.clips);
    const history = new EditHistory(document);
    history.replace(next);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('leaves animated settings and every keyframe unchanged, and reports them', () => {
    const document = project();
    const layer = document.layers[0]!;
    layer.colour.exposure = 0.25;
    layer.keyframes = [
      layerKeyframe(20, { ...EMPTY_KEY_VALUES, exposure: 0.5, hue: 10 }, 'smooth'),
      layerKeyframe(90, { ...EMPTY_KEY_VALUES, saturation: 1.3 }, 'linear'),
    ];
    expect(animatedSettings(layer).map(settingLabel)).toEqual(['Saturation', 'Exposure']);
    const next = applyCommand(document, autoAdjustCommand(layer, CORRECTION, AUTO_ADJUST.balancedIntensity)!);
    const colour = next.layers[0]!.colour;
    expect(colour.exposure).toBe(0.25);
    expect(colour.saturation).toBe(layer.colour.saturation);
    expect(colour.contrast).toBe(CORRECTION.contrast);
    expect(colour.blacks).toBe(CORRECTION.blacks);
    expect(next.layers[0]!.keyframes).toEqual(layer.keyframes);
  });

  it('has nothing to apply when all ten settings are animated', () => {
    const layer = project().layers[0]!;
    layer.keyframes = [
      layerKeyframe(
        20,
        {
          ...EMPTY_KEY_VALUES,
          temperature: 0,
          tint: 0,
          saturation: 1,
          exposure: 0,
          brightness: 0,
          contrast: 1,
          highlights: 0,
          shadows: 0,
          whites: 0,
          blacks: 0,
        },
        'linear',
      ),
    ];
    expect(autoAdjustCommand(layer, CORRECTION, 1)).toBeNull();
  });
});

describe('Auto adjust session memory', () => {
  it('keeps the last analysis of a clip until it is trimmed, prepared again or the project changes', () => {
    const document = project();
    const layout = calculateLayout(document);
    const layer = document.layers[0]!;
    const target = autoAdjustTarget(layer, layout, ASSETS, 10, null).target!;
    expect(cachedAnalysis('auto', target)).toBeNull();
    rememberAnalysis('auto', target, { key: target.key, correction: CORRECTION, percent: 60 });
    expect(cachedAnalysis('auto', target)).toEqual({ key: target.key, correction: CORRECTION, percent: 60 });

    const trimmed = applyCommand(document, { type: 'trim', clipId: 'a', sourceIn: 120, sourceOut: 400 });
    const trimmedTarget = autoAdjustTarget(trimmed.layers[0]!, calculateLayout(trimmed), ASSETS, 10, null).target!;
    expect(cachedAnalysis('auto', trimmedTarget)).toBeNull();

    const prepared = asset('one');
    prepared.prepared!.verification.verifiedAt = '2026-10-20T00:00:00.000Z';
    const reprepared = autoAdjustTarget(layer, layout, [prepared, ASSETS[1]!], 10, null).target!;
    expect(cachedAnalysis('auto', reprepared)).toBeNull();

    rememberAnalysis('other', target, { key: target.key, correction: CORRECTION, percent: 100 });
    expect(cachedAnalysis('auto', target)).toBeNull();
    expect(cachedAnalysis('other', target)?.percent).toBe(100);
  });
});
