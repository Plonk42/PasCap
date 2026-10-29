import { describe, expect, it } from 'vitest';
import { whiteBalanceCommands } from '../../src/shared/auto-colour.js';
import { EditHistory, applyCommand } from '../../src/shared/commands.js';
import { gradeKeyAsLayerKey, layerKeyAsGradeKey, MAX_GRADE_KEYFRAMES } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS, layerKeyframe, joiningEasing } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { whiteBalanceTarget } from '../../src/web/auto-white-balance.js';
import { gradeOwnerOf } from '../../src/web/colour-owner.js';
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
const CLIP_A = { kind: 'clip', clipId: 'a' } as const;
const grade = (document: ProjectDocument, clipId: string) => document.clips.find((clip) => clip.id === clipId)!.grade;
const key = (frame: number, values: Partial<typeof EMPTY_KEY_VALUES>, easing: 'linear' | 'smooth' | 'hold') =>
  layerKeyAsGradeKey(layerKeyframe(frame, { ...EMPTY_KEY_VALUES, ...values }, easing));

describe('Auto white balance target', () => {
  it('analyses the graded clip around the playhead through its retiming, reversed clips included', () => {
    const document = project();
    const layout = calculateLayout(document);
    const a = whiteBalanceTarget(document, 'a', layout, ASSETS, 100);
    expect(a.reason).toBeNull();
    expect(a.target!.clip.clip.id).toBe('a');
    expect(a.target!.frame).toBe(200);
    expect(a.target!.projectFrames).toEqual([70, 74, 77, 81, 85, 89, 92, 96, 100, 104, 109, 113, 117, 121, 126, 130]);
    expect(a.target!.sourceFrames).toEqual([
      170, 174, 177, 181, 185, 189, 192, 196, 200, 204, 209, 213, 217, 221, 226, 230,
    ]);
    const b = whiteBalanceTarget(document, 'b', layout, ASSETS, 400).target!;
    const placed = layout.clips[1]!;
    expect(b.frame).toBe(placed.retiming.sourceAt(400 - placed.start));
    expect(b.sourceFrames).toEqual(b.projectFrames.map((frame) => placed.retiming.sourceAt(frame - placed.start)));
    // Reversed: later project frames show earlier source frames, two apart at 2×.
    expect(b.sourceFrames.every((frame, index) => index === 0 || frame < b.sourceFrames[index - 1]!)).toBe(true);
  });

  it('keys the graded clip in a dissolve, never reading across its ends', () => {
    const document = project();
    const layout = calculateLayout(document);
    const [a, b] = layout.clips as [(typeof layout.clips)[0], (typeof layout.clips)[0]];
    expect(b.start).toBe(a.end - 10);
    expect(whiteBalanceTarget(document, 'a', layout, ASSETS, b.start + 8).target!.clip.clip.id).toBe('a');
    expect(whiteBalanceTarget(document, 'b', layout, ASSETS, b.start + 1).target!.clip.clip.id).toBe('b');
    const target = whiteBalanceTarget(document, 'a', layout, ASSETS, a.end - 12).target!;
    expect(target.projectFrames.every((frame) => frame < a.end)).toBe(true);
  });

  it('explains why it cannot run', () => {
    const document = project();
    const layout = calculateLayout(document);
    expect(whiteBalanceTarget(document, 'gone', layout, ASSETS, 100).reason).toBe(
      'This clip is no longer on the timeline.',
    );
    expect(whiteBalanceTarget(document, 'a', layout, ASSETS, 350).reason).toBe(
      'Move the playhead over this clip to balance its light.',
    );
    expect(whiteBalanceTarget(document, 'a', layout, [asset('one', 'preparing'), asset('two')], 100).reason).toBe(
      'Prepare the recording of this clip first.',
    );
    grade(document, 'a').keyframes = Array.from({ length: MAX_GRADE_KEYFRAMES }, (_, index) =>
      key(300 + index, { exposure: 0.5 }, 'linear'),
    );
    expect(whiteBalanceTarget(document, 'a', layout, ASSETS, 100).reason).toMatch(/grade already has 64 keyframes/);
    // Playhead 200 shows source frame 300, which holds a keyframe to join.
    expect(whiteBalanceTarget(document, 'a', layout, ASSETS, 200).reason).toBeNull();
  });
});

describe('Auto white balance capture', () => {
  const balance = { temperature: 0.214, tint: -0.031 };

  it('creates one keyframe of the clip grade at the source frame, in one Undo step', () => {
    const document = project();
    const before = structuredClone(document);
    const commands = whiteBalanceCommands(gradeOwnerOf(document, 'a')!, 220, balance, CLIP_A);
    expect(commands.map((command) => command.type)).toEqual(['layer-key-toggle', 'layer-key-toggle']);
    const next = commands.reduce(applyCommand, document);
    expect(grade(next, 'a').keyframes).toEqual([key(220, { temperature: 0.214, tint: -0.031 }, 'linear')]);
    expect(next.layers).toEqual(before.layers);
    expect(next.clips[1]).toEqual(before.clips[1]);
    const history = new EditHistory(document);
    history.replace(next);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('joins an existing keyframe like the diamonds and overwrites only its two values', () => {
    const document = project();
    grade(document, 'a').colour.exposure = 0.3;
    grade(document, 'a').keyframes = [
      key(220, { exposure: 0.5, hue: 4 }, 'smooth'),
      key(300, { exposure: -0.5, temperature: 1.2 }, 'hold'),
    ];
    const owner = gradeOwnerOf(document, 'a')!;
    const joined = whiteBalanceCommands(owner, 220, balance, CLIP_A).reduce(applyCommand, document);
    const point = gradeKeyAsLayerKey(grade(joined, 'a').keyframes[0]!);
    const order = KEYFRAME_SETTINGS.map((setting) => setting.key);
    const easing = joiningEasing(owner.keyframes, owner.keyframes[0]!, order);
    expect(point.values).toEqual({ ...owner.keyframes[0]!.values, temperature: 0.214, tint: -0.031 });
    expect(point.easing).toEqual({ ...owner.keyframes[0]!.easing, temperature: easing, tint: easing });
    expect(grade(joined, 'a').keyframes[1]).toEqual(grade(document, 'a').keyframes[1]);
    expect(grade(joined, 'a').colour).toEqual(grade(document, 'a').colour);

    const rerun = whiteBalanceCommands(gradeOwnerOf(joined, 'a')!, 220, { temperature: -0.1, tint: 0.05 }, CLIP_A);
    expect(rerun.map((command) => command.type)).toEqual(['layer-key-value', 'layer-key-value']);
    const updated = rerun.reduce(applyCommand, joined);
    expect(gradeKeyAsLayerKey(grade(updated, 'a').keyframes[0]!)).toEqual({
      ...point,
      values: { ...point.values, temperature: -0.1, tint: 0.05 },
    });
  });

  it('interpolates between two runs in preview and export sampling', () => {
    let document = project();
    const run = (frame: number, temperature: number, tint: number): void => {
      const commands = whiteBalanceCommands(gradeOwnerOf(document, 'a')!, frame, { temperature, tint }, CLIP_A);
      document = commands.reduce(applyCommand, document);
    };
    run(200, 0.4, -0.1);
    run(380, -0.2, 0.2);
    expect(grade(document, 'a').keyframes.map((point) => point.frame)).toEqual([200, 380]);
    // Preview and native export both read the sampled clip grade: project frame 190 shows source frame 290.
    const middle = sampleTimeline(document, 190).find((sample) => sample.clipId === 'a')!.grade;
    expect(middle.temperature).toBeCloseTo(0.1, 12);
    expect(middle.tint).toBeCloseTo(0.05, 12);
    expect(sampleTimeline(document, 50)[0]!.grade.temperature).toBe(0.4);
    expect(sampleTimeline(document, 285).find((sample) => sample.clipId === 'a')!.grade.temperature).toBe(-0.2);
  });
});
