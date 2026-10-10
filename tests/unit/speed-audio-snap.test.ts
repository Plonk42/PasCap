import { describe, expect, it } from 'vitest';
import { musicGainAt, musicSourceFrame } from '../../src/shared/audio.js';
import { applyCommand } from '../../src/shared/commands.js';
import { createClip, createProject, projectSchema } from '../../src/shared/model.js';
import { snapFrame, snapPoints } from '../../src/shared/snap.js';
import { trimByOutputFrames } from '../../src/shared/source-range.js';
import { clipDuration, compileRetiming, sourceFrameAt } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { unsupportedProject } from './project-fixtures.js';

describe('shared retiming and recoverable speed edits', () => {
  it('requires explicit v15 static speed settings; earlier documents are not guessed', () => {
    const project = createProject('flight', 'Flight');
    expect(project.schemaVersion).toBe(15);
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
      expect(() => projectSchema.parse({ ...project, schemaVersion })).toThrow();
    expect(() => projectSchema.parse(unsupportedProject(4, 'old-flight', 'Unsupported flight'))).toThrow();
    const clip = createClip('a', 'source', 0, 600);
    const { speed: _speed, ...incomplete } = clip;
    expect(() => projectSchema.parse({ ...project, clips: [incomplete] })).toThrow();
  });
  it('doubles/halves output duration with nearest interval source-frame sampling', () => {
    const original = createClip('a', 'source', 10, 610);
    const slow = { ...original, speed: { mode: 'constant' as const, rate: 0.5 } };
    const fast = { ...original, speed: { mode: 'constant' as const, rate: 2 } };
    expect(clipDuration(slow)).toBe(1200);
    expect(clipDuration(fast)).toBe(300);
    expect([0, 1, 2, 1199].map((frame) => sourceFrameAt(slow, frame))).toEqual([10, 10, 11, 609]);
    expect([0, 1, 299].map((frame) => sourceFrameAt(fast, frame))).toEqual([10, 12, 608]);
    expect(trimByOutputFrames(fast, 'out', -30, 700).sourceOut).toBe(550);
  });
  for (const curve of ['linear', 'ease-in', 'ease-out', 'smooth'] as const) {
    it(`compiles monotonic ${curve} curves, preserving source anchors while trimming`, () => {
      const clip = {
        ...createClip('a', 'source', 0, 600),
        speed: {
          mode: 'curve' as const,
          keyframes: [
            { frame: 0, rate: 0.5, interpolation: curve },
            { frame: 600, rate: 2, interpolation: curve },
          ],
        },
      };
      const map = compileRetiming(clip);
      const samples = Array.from({ length: map.duration }, (_, frame) => map.sourceAt(frame));
      expect(samples.every((source, frame) => frame === 0 || source >= samples[frame - 1]!)).toBe(true);
      expect(samples[0]).toBe(0);
      expect(samples.at(-1)).toBeLessThan(600);
      expect(map.duration).toBeGreaterThan(300);
      expect(map.duration).toBeLessThan(1200);
      const trimmed = { ...clip, sourceIn: 150, sourceOut: 510 };
      expect(trimmed.speed).toEqual(clip.speed);
      expect(clipDuration(trimmed)).toBeLessThan(map.duration);
    });
  }
  it('retimes transitions in output frames and supports independent per-clip colour/speed undo', () => {
    let project = applyCommand(createProject('p', 'P'), {
      type: 'insert',
      clip: createClip('a', 'source', 0, 120),
      index: 0,
    });
    project = applyCommand(project, { type: 'insert', clip: createClip('b', 'source', 0, 120), index: 1 });
    project = applyCommand(project, { type: 'speed', clipId: 'a', speed: { mode: 'constant', rate: 2 } });
    project = applyCommand(project, {
      type: 'transition',
      transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 30 },
    });
    expect(calculateLayout(project).duration).toBe(150);
    expect(sampleTimeline(project, 45).map((layer) => [layer.sourceFrame, layer.weight])).toEqual([
      [90, 0.5],
      [15, 0.5],
    ]);
    expect(() => applyCommand(project, { type: 'speed', clipId: 'a', speed: { mode: 'constant', rate: 8 } })).toThrow();
    expect(project.clips[1]?.speed).toEqual({ mode: 'constant', rate: 1 });
  });
  it('compiled cache entries do not retain mutable editor ranges or curve settings', () => {
    const clip = {
      ...createClip('mutable', 'source', 0, 75),
      speed: {
        mode: 'curve' as const,
        keyframes: [
          { frame: 0, rate: 0.5, interpolation: 'smooth' as const },
          { frame: 75, rate: 2, interpolation: 'smooth' as const },
        ],
      },
    };
    const map = compileRetiming(clip);
    const before = [map.duration, map.sourceAt(30), map.rateAt(30)];
    clip.sourceOut = 60;
    clip.speed.keyframes[1]!.rate = 5;
    expect([map.duration, map.sourceAt(30), map.rateAt(30)]).toEqual(before);
  });
});

describe('music and snapping', () => {
  const music = {
    id: 'song-instance',
    mediaId: 'song',
    sourceIn: 30,
    sourceOut: 90,
    start: 10,
    duration: 120,
    gainDb: -6,
    fadeIn: 20,
    fadeOut: 20,
    loop: true,
  };
  it('loops only the chosen source interval, with silence outside placement', () => {
    expect([9, 10, 69, 70, 129, 130].map((frame) => musicSourceFrame(music, frame))).toEqual([
      null,
      30,
      89,
      30,
      89,
      null,
    ]);
    expect(musicGainAt(music, 10)).toBe(0);
    expect(musicGainAt(music, 30)).toBeCloseTo(10 ** (-6 / 20));
    expect(musicGainAt(music, 120)).toBeCloseTo(0.5 * 10 ** (-6 / 20));
    expect(musicGainAt(music, 130)).toBe(0);
  });
  it('rejects music without explicit loop when the track exceeds the selected source', () => {
    expect(() => projectSchema.parse({ ...createProject('p', 'P'), music: [{ ...music, loop: false }] })).toThrow();
  });
  it('snaps to the closest clip or music boundary only within tolerance', () => {
    const project = applyCommand(createProject('p', 'P'), {
      type: 'insert',
      clip: createClip('a', 'source', 0, 100),
      index: 0,
    });
    const points = snapPoints({ ...project, music: [music, { ...music, id: 'second', start: 40 }] });
    expect(points).toContain(10);
    expect(points).toContain(130);
    expect(points).toContain(40);
    expect(points).toContain(160);
    expect(snapFrame(97, points, 4)).toBe(100);
    expect(snapFrame(94, points, 4)).toBe(94);
    expect(snapFrame(128, points, 4)).toBe(130);
  });
});
