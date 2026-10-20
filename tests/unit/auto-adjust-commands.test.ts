import { describe, expect, it } from 'vitest';
import {
  AUTO_ADJUST,
  AUTO_ADJUST_SETTINGS,
  autoAdjustFrames,
  autoAdjustWindow,
  scaleCorrection,
  type AutoCorrection,
} from '../../src/shared/auto-adjust.js';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import {
  createClip,
  createLayer,
  createProject,
  MAX_TRACK_KEYFRAMES,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { calculateLayout, type PlacedClip } from '../../src/shared/timeline.js';
import {
  animatedSettings,
  autoAdjustCommand,
  autoAdjustCommands,
  autoAdjustTarget,
  cachedAnalysis,
  initialChoice,
  keyframeReason,
  rememberAnalysis,
  settingLabel,
  trackSamples,
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
  vibrance: 0.25,
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
    expect(a.reads.map(({ asset }) => asset.id)).toEqual(['one']);
    expect(a.reads[0]!.sourceFrames).toEqual(autoAdjustFrames(100, 400));
    const b = autoAdjustTarget(layer, layout, ASSETS, layout.clips[1]!.start + 3, null).target!;
    expect(b.reads.map(({ asset }) => asset.id)).toEqual(['two']);
    expect(b.reads[0]!.sourceFrames).toEqual(autoAdjustFrames(0, 300));
    expect(b.key).not.toBe(a.key);
  });

  it('analyses every clip of the track in proportion to its duration on screen, from any of them', () => {
    const document = project();
    const layout = calculateLayout(document);
    const layer = document.layers[0]!;
    const [a, b] = layout.clips as [PlacedClip, PlacedClip];
    // A lasts 300 frames, reversed B at 2× 150: 16 frames at the centres of 450 / 16 frame slices.
    const samples = trackSamples(layout.clips);
    expect(samples.map(({ clip }) => clip.clip.id)).toEqual([...Array(11).fill('a'), ...Array(5).fill('b')]);
    const positions = Array.from({ length: 16 }, (_, index) => Math.floor(((index + 0.5) * 450) / 16));
    expect(samples.map(({ sourceFrame }) => sourceFrame)).toEqual(
      positions.map((position) =>
        position < 300 ? a.retiming.sourceAt(position) : b.retiming.sourceAt(position - 300),
      ),
    );
    const target = autoAdjustTarget(layer, layout, ASSETS, 10, null, 'track').target!;
    expect(target.label).toBe('2 clips on Track 1');
    expect(target.reads.map(({ asset, sourceFrames }) => [asset.id, sourceFrames.length])).toEqual([
      ['one', 11],
      ['two', 5],
    ]);
    expect(autoAdjustTarget(layer, layout, ASSETS, b.start + 3, null, 'track').target!.key).toBe(target.key);
    expect(autoAdjustTarget(layer, layout, [ASSETS[0]!, asset('two', 'preparing')], 10, null, 'track').reason).toBe(
      'Prepare the recordings of every clip on Track 1 first.',
    );
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
  it('replaces the eleven settings with the scaled correction in one Colour edit and one Undo step', () => {
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
    // Hue, HDR, Local contrast, HSL, curves, Opacity, Transform and keyframes are untouched.
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

  it('has nothing to apply when all eleven settings are animated', () => {
    const layer = project().layers[0]!;
    layer.keyframes = [
      layerKeyframe(
        20,
        {
          ...EMPTY_KEY_VALUES,
          temperature: 0,
          tint: 0,
          saturation: 1,
          vibrance: 0,
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
    rememberAnalysis('auto', target, { correction: CORRECTION, percent: 60 });
    expect(cachedAnalysis('auto', target)).toEqual({ correction: CORRECTION, percent: 60 });

    const trimmed = applyCommand(document, { type: 'trim', clipId: 'a', sourceIn: 120, sourceOut: 400 });
    const trimmedTarget = autoAdjustTarget(trimmed.layers[0]!, calculateLayout(trimmed), ASSETS, 10, null).target!;
    expect(cachedAnalysis('auto', trimmedTarget)).toBeNull();

    const prepared = asset('one');
    prepared.prepared!.verification.verifiedAt = '2026-10-20T00:00:00.000Z';
    const reprepared = autoAdjustTarget(layer, layout, [prepared, ASSETS[1]!], 10, null).target!;
    expect(cachedAnalysis('auto', reprepared)).toBeNull();

    rememberAnalysis('other', target, { correction: CORRECTION, percent: 100 });
    expect(cachedAnalysis('auto', target)).toBeNull();
    expect(cachedAnalysis('other', target)?.percent).toBe(100);
  });

  it('keeps the analyses of a clip and of each playhead apart', () => {
    const document = project();
    const layout = calculateLayout(document);
    const layer = document.layers[0]!;
    const whole = autoAdjustTarget(layer, layout, ASSETS, 50, null).target!;
    const at50 = autoAdjustTarget(layer, layout, ASSETS, 50, null, 'playhead').target!;
    const at80 = autoAdjustTarget(layer, layout, ASSETS, 80, null, 'playhead').target!;
    rememberAnalysis('auto', at50, { correction: CORRECTION, percent: 70 });
    expect(cachedAnalysis('auto', whole)).toBeNull();
    expect(cachedAnalysis('auto', at80)).toBeNull();
    expect(cachedAnalysis('auto', autoAdjustTarget(layer, layout, ASSETS, 50, null, 'playhead').target!)?.percent).toBe(
      70,
    );
  });
});

function keyedValues(document: ProjectDocument, frame: number): Partial<Record<string, number | null>> {
  const key = document.layers[0]!.keyframes.find((point) => point.frame === frame)!;
  return Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, key.values[setting]]));
}

describe('Auto adjust keyframe', () => {
  it('analyses the frames within 1 s of the playhead, through the clip retiming', () => {
    const document = project();
    const layout = calculateLayout(document);
    const layer = document.layers[0]!;
    const a = autoAdjustTarget(layer, layout, ASSETS, 100, null, 'playhead').target!;
    expect(a.frame).toBe(100);
    const frames = a.reads[0]!.sourceFrames;
    expect(frames).toEqual(autoAdjustWindow(layout.clips[0]!, 100).map((frame) => frame + 100));
    expect(frames).toHaveLength(AUTO_ADJUST.frames);
    expect(Math.min(...frames)).toBe(170);
    expect(Math.max(...frames)).toBe(230);
    // Reversed at 2×: each project frame shows a source frame counted down from the end, two apart.
    const b = layout.clips[1]!;
    const reversed = autoAdjustTarget(layer, layout, ASSETS, b.start + 40, null, 'playhead').target!.reads[0]!
      .sourceFrames;
    expect(reversed).toEqual(autoAdjustWindow(b, b.start + 40).map((frame) => b.retiming.sourceAt(frame - b.start)));
    expect(reversed[0]).toBeGreaterThan(reversed.at(-1)!);
  });

  it('keys only from the playhead, with room for a keyframe there', () => {
    const document = project();
    const layer = document.layers[0]!;
    expect(keyframeReason(layer, 'playhead', 11)).toBeNull();
    expect(keyframeReason(layer, 'clip', 11)).toMatch(/analyse the playhead/);
    expect(keyframeReason(layer, 'track', 11)).toMatch(/analyse the playhead/);
    layer.keyframes = Array.from({ length: MAX_TRACK_KEYFRAMES }, (_, index) =>
      layerKeyframe(index * 2, { ...EMPTY_KEY_VALUES, hue: 0 }, 'linear'),
    );
    expect(keyframeReason(layer, 'playhead', 11)).toMatch(/already has 256 keyframes/);
    expect(keyframeReason(layer, 'playhead', 10)).toBeNull();
    // Track values need no keyframe room.
    expect(autoAdjustTarget(layer, calculateLayout(document), ASSETS, 11, null, 'playhead').target).not.toBeNull();
  });

  it('keys the eleven settings at the playhead in one Undo step, joining or overwriting a keyframe there', () => {
    const document = project();
    const layer = document.layers[0]!;
    layer.colour.exposure = -0.4;
    layer.keyframes = [layerKeyframe(60, { ...EMPTY_KEY_VALUES, hue: 20, exposure: 0.2 }, 'smooth')];
    const before = structuredClone(document);
    const scaled = scaleCorrection(CORRECTION, 0.6);
    let next = document;
    for (const command of autoAdjustCommands(layer, 'keyframe', 60, CORRECTION, 0.6))
      next = applyCommand(next, command);
    expect(keyedValues(next, 60)).toEqual(scaled);
    const key = next.layers[0]!.keyframes[0]!;
    expect(next.layers[0]!.keyframes).toHaveLength(1);
    expect(key.values.hue).toBe(20);
    // Joining settings adopt the Easing the keyframe's settings agree on.
    expect(AUTO_ADJUST_SETTINGS.every((setting) => key.easing[setting] === 'smooth')).toBe(true);
    expect(next.layers[0]!.colour).toEqual(before.layers[0]!.colour);
    const history = new EditHistory(document);
    history.replace(next);
    expect(history.undo()).toEqual(before);

    // A second keyframe elsewhere is new, with Linear easing; the first is unchanged.
    let later = next;
    for (const command of autoAdjustCommands(next.layers[0]!, 'keyframe', 90, CORRECTION, 0.8))
      later = applyCommand(later, command);
    expect(later.layers[0]!.keyframes.map((point) => point.frame)).toEqual([60, 90]);
    expect(keyedValues(later, 90)).toEqual(CORRECTION);
    expect(later.layers[0]!.keyframes[1]!.easing.exposure).toBe('linear');
    expect(later.layers[0]!.keyframes[0]).toEqual(key);
  });

  it('starts with a keyframe from the playhead once the track animates a setting Auto sets', () => {
    const layer = project().layers[0]!;
    expect(initialChoice(layer)).toEqual({ source: 'clip', apply: 'values' });
    layer.keyframes = [layerKeyframe(20, { ...EMPTY_KEY_VALUES, hue: 10 }, 'linear')];
    expect(initialChoice(layer)).toEqual({ source: 'clip', apply: 'values' });
    layer.keyframes = [layerKeyframe(20, { ...EMPTY_KEY_VALUES, temperature: 0.2 }, 'linear')];
    expect(initialChoice(layer)).toEqual({ source: 'playhead', apply: 'keyframe' });
    expect(autoAdjustCommands(layer, 'values', 20, CORRECTION, 0.8)).toEqual([
      autoAdjustCommand(layer, CORRECTION, 0.8),
    ]);
  });
});
