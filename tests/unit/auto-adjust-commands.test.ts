import { describe, expect, it } from 'vitest';
import {
  AUTO_ADJUST,
  AUTO_ADJUST_SETTINGS,
  autoAdjustFrames,
  autoAdjustWindow,
  scaleCorrection,
  type AutoCorrection,
} from '../../src/shared/auto-adjust.js';
import { animatedSettings, autoAdjustCommand, trackSamples, type AutoOwner } from '../../src/shared/auto-colour.js';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { createAdjustment, layerKeyAsGradeKey, MAX_GRADE_KEYFRAMES } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, type PlacedClip } from '../../src/shared/timeline.js';
import {
  animatedParts,
  autoAdjustCommands,
  clipsKeepingAnimated,
  autoAdjustTarget,
  cachedAnalysis,
  initialChoice,
  keyframeReason,
  rememberAnalysis,
  settingLabel,
  type AutoAdjustContext,
  type AutoAdjustSource,
} from '../../src/web/auto-adjust.js';
import { adjustmentColourOwner, gradeOwnerOf } from '../../src/web/colour-owner.js';
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

/** Auto on the grade of `clipId`, with the playhead at `playhead`. */
function context(
  document: ProjectDocument,
  clipId: string,
  playhead: number,
  assets: MediaAsset[] = ASSETS,
): AutoAdjustContext {
  return { project: document, clipId, layout: calculateLayout(document), assets, playhead };
}

function target(document: ProjectDocument, clipId: string, playhead: number, source: AutoAdjustSource = 'clip') {
  return autoAdjustTarget(context(document, clipId, playhead), source).target!;
}

function applied(document: ProjectDocument, commands: readonly EditCommand[]): ProjectDocument {
  return commands.reduce(applyCommand, document);
}

const grade = (document: ProjectDocument, clipId: string) => document.clips.find((clip) => clip.id === clipId)!.grade;

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
const OTHER: AutoCorrection = { ...CORRECTION, temperature: -0.4, exposure: -0.3, contrast: 0.9 };

describe('Auto adjust target', () => {
  it('analyses the whole source range of the graded clip, reversed or retimed, wherever the playhead is', () => {
    const document = project();
    const a = target(document, 'a', 10);
    expect(a.parts.map(({ clip, asset }) => [clip.clip.id, asset.id])).toEqual([['a', 'one']]);
    expect(a.parts[0]!.sourceFrames).toEqual(autoAdjustFrames(100, 400));
    expect(target(document, 'a', 350).key).toBe(a.key);
    const b = target(document, 'b', 10);
    expect(b.parts.map(({ clip, asset }) => [clip.clip.id, asset.id])).toEqual([['b', 'two']]);
    expect(b.parts[0]!.sourceFrames).toEqual(autoAdjustFrames(0, 300));
    expect(b.key).not.toBe(a.key);
  });

  it('analyses each clip of the track on its own, whole, from any of them', () => {
    const document = project();
    const track = target(document, 'a', 10, 'track');
    expect(track.label).toBe('2 clips on Track 1, each on its own');
    expect(track.parts.map(({ clip, name, sourceFrames }) => [clip.clip.id, name, sourceFrames])).toEqual([
      ['a', 'Clip 1 (one)', autoAdjustFrames(100, 400)],
      ['b', 'Clip 2 (two)', autoAdjustFrames(0, 300)],
    ]);
    expect(target(document, 'b', 400, 'track').key).toBe(track.key);
    expect(autoAdjustTarget(context(document, 'a', 10, [ASSETS[0]!, asset('two', 'preparing')]), 'track').reason).toBe(
      'Prepare the recordings of every clip on Track 1 first.',
    );
  });

  it('samples a whole track in proportion to its duration on screen for the estimate operation', () => {
    const layout = calculateLayout(project());
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
  });

  it('explains why it cannot run', () => {
    const document = project();
    expect(autoAdjustTarget(context(document, 'gone', 10)).reason).toBe('This clip is no longer on the timeline.');
    expect(autoAdjustTarget(context(document, 'a', 10, [asset('one', 'preparing'), ASSETS[1]!])).reason).toBe(
      'Prepare the recording of this clip first.',
    );
    expect(autoAdjustTarget(context(document, 'a', 350), 'playhead').reason).toBe(
      'Move the playhead over this clip to analyse 1 s around it.',
    );
  });
});

describe('Auto adjust edit', () => {
  const LOOK: AutoOwner = { kind: 'adjustment', adjustmentId: 'look' };
  /** The project with an adjustment over its first clip. */
  function adjusted(): ProjectDocument {
    const document = project();
    document.adjustments = [createAdjustment('look', 0, 300)];
    return document;
  }
  const look = (document: ProjectDocument) => adjustmentColourOwner(document.adjustments[0]!, 'look');

  it('replaces the eleven settings with the scaled correction in one Colour edit and one Undo step', () => {
    const document = adjusted();
    const item = document.adjustments[0]!;
    item.colour = { ...item.colour, hue: 12, vibrance: 0.4, hdr: 0.3, localContrast: 0.2, exposure: -1 };
    item.colour.hsl.red.saturation = 0.25;
    document.layers[0]!.transform.base.opacity = 0.8;
    const before = structuredClone(document);
    const command = autoAdjustCommand(look(document), CORRECTION, 0.5, LOOK)!;
    const next = applyCommand(document, command);
    const scaled = scaleCorrection(CORRECTION, 0.5);
    expect(next.adjustments[0]!.colour).toEqual({ ...item.colour, ...scaled });
    // Hue, HDR, Local contrast, HSL, curves, keyframes, the range, the tracks (Opacity, Transform) and clips are untouched.
    expect({ ...next.adjustments[0]!, colour: before.adjustments[0]!.colour }).toEqual(before.adjustments[0]);
    expect(next.adjustments[0]!.colour.hsl).toEqual(before.adjustments[0]!.colour.hsl);
    expect(next.layers).toEqual(before.layers);
    expect(next.clips).toEqual(before.clips);
    const history = new EditHistory(document);
    history.replace(next);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('leaves animated settings and every keyframe unchanged, and reports them', () => {
    const document = adjusted();
    const item = document.adjustments[0]!;
    item.colour.exposure = 0.25;
    item.keyframes = [
      layerKeyAsGradeKey(layerKeyframe(20, { ...EMPTY_KEY_VALUES, exposure: 0.5, hue: 10 }, 'smooth')),
      layerKeyAsGradeKey(layerKeyframe(90, { ...EMPTY_KEY_VALUES, saturation: 1.3 }, 'linear')),
    ];
    expect(animatedSettings(look(document)).map(settingLabel)).toEqual(['Saturation', 'Exposure']);
    const next = applyCommand(
      document,
      autoAdjustCommand(look(document), CORRECTION, AUTO_ADJUST.balancedIntensity, LOOK)!,
    );
    const colour = next.adjustments[0]!.colour;
    expect(colour.exposure).toBe(0.25);
    expect(colour.saturation).toBe(item.colour.saturation);
    expect(colour.contrast).toBe(CORRECTION.contrast);
    expect(colour.blacks).toBe(CORRECTION.blacks);
    expect(next.adjustments[0]!.keyframes).toEqual(item.keyframes);
  });

  it('has nothing to apply when all eleven settings are animated', () => {
    const document = adjusted();
    document.adjustments[0]!.keyframes = [
      layerKeyAsGradeKey(
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
      ),
    ];
    expect(autoAdjustCommand(look(document), CORRECTION, 1, LOOK)).toBeNull();
  });
});

describe('Auto adjust on clip grades', () => {
  it('writes the clip grade only, keeping its keyframes, the track Colour and the other clips', () => {
    const document = project();
    grade(document, 'a').colour.hue = 12;
    grade(document, 'a').keyframes = [
      layerKeyAsGradeKey(layerKeyframe(150, { ...EMPTY_KEY_VALUES, hue: 4 }, 'linear')),
    ];
    const before = structuredClone(document);
    const next = applied(
      document,
      autoAdjustCommands(
        context(document, 'a', 10),
        target(document, 'a', 10),
        'values',
        new Map([['a', CORRECTION]]),
        0.5,
      ),
    );
    expect(grade(next, 'a').colour).toEqual({ ...before.clips[0]!.grade.colour, ...scaleCorrection(CORRECTION, 0.5) });
    expect(grade(next, 'a').keyframes).toEqual(before.clips[0]!.grade.keyframes);
    expect(next.layers).toEqual(before.layers);
    expect(next.clips[1]).toEqual(before.clips[1]);
    // The grade follows its footage through a trim.
    const trimmed = applyCommand(next, { type: 'trim', clipId: 'a', sourceIn: 150, sourceOut: 400 });
    expect(grade(trimmed, 'a')).toEqual(grade(next, 'a'));
  });

  it('grades each clip of the track with its own correction, in one Undo step', () => {
    const document = project();
    const before = structuredClone(document);
    const track = target(document, 'a', 10, 'track');
    const commands = autoAdjustCommands(
      context(document, 'a', 10),
      track,
      'values',
      new Map([
        ['a', CORRECTION],
        ['b', OTHER],
      ]),
      0.8,
    );
    expect(commands.map((command) => (command as { clipIds?: string[] }).clipIds)).toEqual([['a'], ['b']]);
    const next = applied(document, commands);
    expect(grade(next, 'a').colour).toMatchObject(scaleCorrection(CORRECTION, 0.8));
    expect(grade(next, 'b').colour).toMatchObject(scaleCorrection(OTHER, 0.8));
    expect(next.layers).toEqual(before.layers);
    const history = new EditHistory(document);
    history.replace(next);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('leaves each grade’s animated settings unchanged and counts the clips animating them', () => {
    const document = project();
    for (const id of ['a', 'b'])
      grade(document, id).keyframes = [
        layerKeyAsGradeKey(layerKeyframe(10, { ...EMPTY_KEY_VALUES, exposure: 0.5 }, 'linear')),
      ];
    grade(document, 'b').keyframes.push(
      layerKeyAsGradeKey(layerKeyframe(20, { ...EMPTY_KEY_VALUES, contrast: 1.1 }, 'linear')),
    );
    const track = target(document, 'a', 10, 'track');
    expect(animatedParts(document, track)).toEqual([
      { setting: 'exposure', clips: 2 },
      { setting: 'contrast', clips: 1 },
    ]);
    expect(clipsKeepingAnimated(document, track)).toBe(2);
    const next = applied(
      document,
      autoAdjustCommands(
        context(document, 'a', 10),
        track,
        'values',
        new Map([
          ['a', CORRECTION],
          ['b', OTHER],
        ]),
        0.8,
      ),
    );
    expect(grade(next, 'a').colour.exposure).toBe(0);
    expect(grade(next, 'b').colour.contrast).toBe(1);
    expect(grade(next, 'a').colour.contrast).toBe(scaleCorrection(CORRECTION, 0.8).contrast);
    grade(document, 'a').keyframes = [];
    expect(clipsKeepingAnimated(document, target(document, 'a', 10, 'track'))).toBe(1);
  });
});

describe('Auto adjust session memory', () => {
  it('keeps the last analysis of a clip until it is trimmed, prepared again or the project changes', () => {
    const document = project();
    const corrections = new Map([['a', CORRECTION]]);
    const whole = target(document, 'a', 10);
    expect(cachedAnalysis('auto', whole)).toBeNull();
    rememberAnalysis('auto', whole, { corrections, percent: 60 });
    expect(cachedAnalysis('auto', whole)).toEqual({ corrections, percent: 60 });

    const trimmed = applyCommand(document, { type: 'trim', clipId: 'a', sourceIn: 120, sourceOut: 400 });
    expect(cachedAnalysis('auto', target(trimmed, 'a', 10))).toBeNull();

    const prepared = asset('one');
    prepared.prepared!.verification.verifiedAt = '2026-10-20T00:00:00.000Z';
    const reprepared = autoAdjustTarget(context(document, 'a', 10, [prepared, ASSETS[1]!])).target!;
    expect(cachedAnalysis('auto', reprepared)).toBeNull();

    rememberAnalysis('other', whole, { corrections, percent: 100 });
    expect(cachedAnalysis('auto', whole)).toBeNull();
    expect(cachedAnalysis('other', whole)?.percent).toBe(100);
  });

  it('keeps the analyses of a clip, of each playhead and of the track apart', () => {
    const document = project();
    const whole = target(document, 'a', 50);
    const at50 = target(document, 'a', 50, 'playhead');
    const at80 = target(document, 'a', 80, 'playhead');
    rememberAnalysis('auto', at50, { corrections: new Map([['a', CORRECTION]]), percent: 70 });
    expect(cachedAnalysis('auto', whole)).toBeNull();
    expect(cachedAnalysis('auto', at80)).toBeNull();
    expect(cachedAnalysis('auto', target(document, 'a', 10, 'track'))).toBeNull();
    expect(cachedAnalysis('auto', target(document, 'a', 50, 'playhead'))?.percent).toBe(70);
  });
});

function keyedValues(document: ProjectDocument, clipId: string, frame: number): Partial<Record<string, number | null>> {
  const key = grade(document, clipId).keyframes.find((point) => point.frame === frame)!;
  return Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, key.values[setting]]));
}

describe('Auto adjust keyframe', () => {
  it('analyses the frames within 1 s of the playhead, through the clip retiming', () => {
    const document = project();
    const layout = calculateLayout(document);
    const frames = target(document, 'a', 100, 'playhead').parts[0]!.sourceFrames;
    expect(frames).toEqual(autoAdjustWindow(layout.clips[0]!, 100).map((frame) => frame + 100));
    expect(frames).toHaveLength(AUTO_ADJUST.frames);
    expect(Math.min(...frames)).toBe(170);
    expect(Math.max(...frames)).toBe(230);
    // Reversed at 2×: each project frame shows a source frame counted down from the end, two apart.
    const b = layout.clips[1]!;
    const reversed = target(document, 'b', b.start + 40, 'playhead').parts[0]!.sourceFrames;
    expect(reversed).toEqual(autoAdjustWindow(b, b.start + 40).map((frame) => b.retiming.sourceAt(frame - b.start)));
    expect(reversed[0]).toBeGreaterThan(reversed.at(-1)!);
  });

  it('keys only from the playhead on the clip, with room for a keyframe at its source frame', () => {
    const document = project();
    expect(keyframeReason(context(document, 'a', 11), 'playhead')).toBeNull();
    expect(keyframeReason(context(document, 'a', 11), 'clip')).toMatch(/analyse the playhead/);
    expect(keyframeReason(context(document, 'a', 11), 'track')).toBe(
      'Keyframes go to this clip only, at the playhead.',
    );
    expect(keyframeReason(context(document, 'a', 350), 'playhead')).toBe('Move the playhead over this clip to key it.');
    // Playhead 11 shows source frame 111, 10 shows 110.
    grade(document, 'a').keyframes = Array.from({ length: MAX_GRADE_KEYFRAMES }, (_, index) =>
      layerKeyAsGradeKey(layerKeyframe(100 + index * 2, { ...EMPTY_KEY_VALUES, hue: 0 }, 'linear')),
    );
    expect(keyframeReason(context(document, 'a', 11), 'playhead')).toMatch(/grade already has 64 keyframes/);
    expect(keyframeReason(context(document, 'a', 10), 'playhead')).toBeNull();
    // Grade values need no keyframe room.
    expect(autoAdjustTarget(context(document, 'a', 11), 'playhead').target).not.toBeNull();
  });

  it('keys the eleven settings at the source frame shown, in one Undo step, joining or overwriting a keyframe there', () => {
    const document = project();
    grade(document, 'a').colour.exposure = -0.4;
    grade(document, 'a').keyframes = [
      layerKeyAsGradeKey(layerKeyframe(160, { ...EMPTY_KEY_VALUES, hue: 20, exposure: 0.2 }, 'smooth')),
    ];
    const before = structuredClone(document);
    const corrections = new Map([['a', CORRECTION]]);
    const keyAt = (doc: ProjectDocument, playhead: number, intensity: number) =>
      autoAdjustCommands(
        context(doc, 'a', playhead),
        target(doc, 'a', playhead, 'playhead'),
        'keyframe',
        corrections,
        intensity,
      );
    const next = applied(document, keyAt(document, 60, 0.6));
    expect(keyedValues(next, 'a', 160)).toEqual(scaleCorrection(CORRECTION, 0.6));
    const key = grade(next, 'a').keyframes[0]!;
    expect(grade(next, 'a').keyframes).toHaveLength(1);
    expect(key.values.hue).toBe(20);
    // Joining settings adopt the Easing the keyframe's settings agree on.
    expect(AUTO_ADJUST_SETTINGS.every((setting) => key.easing[setting] === 'smooth')).toBe(true);
    expect(grade(next, 'a').colour).toEqual(before.clips[0]!.grade.colour);
    expect(next.layers).toEqual(before.layers);
    const history = new EditHistory(document);
    history.replace(next);
    expect(history.undo()).toEqual(before);

    // A second keyframe elsewhere is new, with Linear easing; the first is unchanged.
    const later = applied(next, keyAt(next, 90, 0.8));
    expect(grade(later, 'a').keyframes.map((point) => point.frame)).toEqual([160, 190]);
    expect(keyedValues(later, 'a', 190)).toEqual(CORRECTION);
    expect(grade(later, 'a').keyframes[1]!.easing.exposure).toBe('linear');
    expect(grade(later, 'a').keyframes[0]).toEqual(key);
  });

  it('starts with a keyframe from the playhead once the grade animates a setting Auto sets', () => {
    const document = project();
    expect(initialChoice(context(document, 'a', 20))).toEqual({ source: 'clip', apply: 'values' });
    grade(document, 'a').keyframes = [
      layerKeyAsGradeKey(layerKeyframe(120, { ...EMPTY_KEY_VALUES, hue: 10 }, 'linear')),
    ];
    expect(initialChoice(context(document, 'a', 20))).toEqual({ source: 'clip', apply: 'values' });
    grade(document, 'a').keyframes = [
      layerKeyAsGradeKey(layerKeyframe(120, { ...EMPTY_KEY_VALUES, temperature: 0.2 }, 'linear')),
    ];
    expect(initialChoice(context(document, 'a', 20))).toEqual({ source: 'playhead', apply: 'keyframe' });
    // Off the clip, the playhead cannot be keyed: the whole clip's values.
    expect(initialChoice(context(document, 'a', 350))).toEqual({ source: 'clip', apply: 'values' });
    expect(animatedSettings(gradeOwnerOf(document, 'a')!).map(settingLabel)).toEqual(['Temperature']);
  });
});
