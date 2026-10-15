import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { needsLayeredExport } from '../../src/shared/export.js';
import { createClip, createProject, projectSchema, type Transition } from '../../src/shared/model.js';
import {
  calculateLayout,
  sampleSlots,
  sampleTimeline,
  transitionConsumption,
  transitionOffset,
} from '../../src/shared/timeline.js';

const pause = (fade: number, frames: number): Transition => ({
  leftId: 'a',
  rightId: 'b',
  type: 'fade-black-pause',
  fade,
  pause: frames,
});

function sequence(ripple = true) {
  let document = createProject('test', 'Pause');
  document = applyCommand(document, { type: 'insert', clip: createClip('a', 'media-a', 10, 110), index: 0 });
  document = applyCommand(document, { type: 'insert', clip: createClip('b', 'media-b', 20, 100), index: 1 });
  document = applyCommand(document, { type: 'insert', clip: createClip('c', 'media-c', 0, 50), index: 2 });
  if (!ripple) {
    document = applyCommand(document, { type: 'layer-update', layer: { ...document.layers[0]!, ripple } });
    document = applyCommand(document, { type: 'place', clipId: 'c', layerId: 'video-1', start: 190, index: 2 });
  }
  return document;
}

describe('transitions with their own timeslot', () => {
  it('fades footage out and in but inserts the black pause between the clips', () => {
    const project = applyCommand(sequence(), { type: 'transition', transition: pause(3, 4) });
    const layout = calculateLayout(project);
    expect(layout.clips.map((placed) => [placed.start, placed.end])).toEqual([
      [0, 100],
      [104, 184],
      [184, 234],
    ]);
    expect(layout.transitions[0]).toMatchObject({ start: 97, boundary: 100, end: 107, slot: { start: 100, end: 104 } });
    expect(layout.clips[0]!.duration + layout.clips[1]!.duration).toBe(180);
    const weights = [96, 97, 98, 99].map((frame) => sampleTimeline(project, frame)[0]!.weight);
    expect(weights).toEqual([1, 1, 0.5, 0]);
    expect([104, 105, 106, 107].map((frame) => sampleTimeline(project, frame)[0]!.weight)).toEqual([0, 0.5, 1, 1]);
    expect(sampleTimeline(project, 104)[0]!.sourceFrame).toBe(20);
  });

  it('samples the slot as an image-less black layer with the track geometry and Opacity', () => {
    const base = applyCommand(sequence(), { type: 'transition', transition: pause(3, 4) });
    const project = applyCommand(base, { type: 'layer-update', layer: { ...base.layers[0]!, opacity: 0.6 } });
    for (const frame of [100, 103]) {
      expect(sampleTimeline(project, frame)).toEqual([]);
      expect(sampleSlots(project, frame)).toEqual([
        expect.objectContaining({ clipId: 'a', mediaId: 'media-a', layerId: 'video-1', brightness: 0, opacity: 0.6 }),
      ]);
    }
    expect(sampleSlots(project, 99)).toEqual([]);
    expect(sampleSlots(project, 104)).toEqual([]);
    const hidden = applyCommand(project, { type: 'layer-update', layer: { ...project.layers[0]!, enabled: false } });
    expect(sampleSlots(hidden, 101)).toEqual([]);
  });

  it('moves only the right clip on a positioned track and closes the slot when the type changes', () => {
    const project = applyCommand(sequence(false), { type: 'transition', transition: pause(3, 10) });
    expect(project.clips.map((clip) => clip.start)).toEqual([0, 110, 190]);
    expect(() => applyCommand(project, { type: 'transition', transition: pause(3, 11) })).toThrow();
    const closed = applyCommand(project, {
      type: 'transition',
      transition: { leftId: 'a', rightId: 'b', type: 'fade-through-black', duration: 6 },
    });
    expect(closed.clips.map((clip) => clip.start)).toEqual([0, 100, 190]);
  });

  it('keeps an exact stored slot and strict fields', () => {
    const project = applyCommand(sequence(false), { type: 'transition', transition: pause(3, 10) });
    const moved = structuredClone(project);
    moved.clips[1]!.start = 109;
    expect(() => calculateLayout(moved)).toThrow('exactly its pause frames');
    expect(() => projectSchema.parse(project)).not.toThrow();
    const transition = project.layers[0]!.transitions[0]!;
    for (const invalid of [
      { ...transition, pause: 0 },
      { ...transition, fade: 0 },
      { ...transition, duration: 10 },
    ])
      expect(() =>
        projectSchema.parse({
          ...project,
          layers: [{ ...project.layers[0]!, transitions: [invalid, project.layers[0]!.transitions[1]] }],
        }),
      ).toThrow();
  });

  it('rejects fades longer than the footage around the slot', () => {
    expect(() => applyCommand(sequence(), { type: 'transition', transition: pause(81, 5) })).toThrow(
      'regions overlap or exceed',
    );
  });

  it('describes slot offsets and consumption for every type', () => {
    const pair = { leftId: 'a', rightId: 'b' };
    expect(transitionOffset({ ...pair, type: 'cut', duration: 0 })).toBe(0);
    expect(transitionOffset({ ...pair, type: 'fade-through-black', duration: 6 })).toBe(0);
    expect(transitionOffset({ ...pair, type: 'cross-dissolve', duration: 6 })).toBe(-6);
    expect(transitionOffset(pause(3, 9))).toBe(9);
    expect([transitionConsumption(pause(3, 9), 'out'), transitionConsumption(pause(3, 9), 'in')]).toEqual([3, 3]);
  });

  it('routes a slot to layered export', () => {
    expect(needsLayeredExport(sequence())).toBe(false);
    expect(needsLayeredExport(applyCommand(sequence(), { type: 'transition', transition: pause(3, 4) }))).toBe(true);
  });
});
