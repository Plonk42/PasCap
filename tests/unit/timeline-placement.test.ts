import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { placementSnapPoints, planTimelineDrop, snapPlacement } from '../../src/web/timeline-placement.js';

function project() {
  let document = createProject('flight', 'Flight');
  for (const [index, id] of ['a', 'b', 'c'].entries())
    document = applyCommand(document, { type: 'insert', clip: createClip(id, id, 0, 60), index });
  return applyCommand(document, { type: 'layer-add', layer: createLayer('upper', 'Overlay', false) });
}

describe('one authoritative timeline drop plan', () => {
  it('holds the grabbed point under the pointer for independent overlay placement', () => {
    const document = project();
    const plan = planTimelineDrop(document, { kind: 'clip', clipId: 'b', grabFrame: 23 }, 'upper', 123, false, 8, 0);
    expect(plan).toMatchObject({ start: 100, mode: 'position', duration: 60, guide: null, error: '' });
    expect(
      calculateLayout(applyCommand(document, plan.command!)).clips.find((clip) => clip.clip.id === 'b')?.start,
    ).toBe(plan.start);
  });
  it('matches the leading and trailing edges, with deterministic ties and no negative placement', () => {
    expect(snapPlacement(97, 30, [100], 5)).toEqual({ start: 100, guide: 100 });
    expect(snapPlacement(97, 30, [125], 5)).toEqual({ start: 95, guide: 125 });
    expect(snapPlacement(1, 30, [0], 5)).toEqual({ start: 0, guide: 0 });
    expect(snapPlacement(40, 30, [0, 100], 5)).toEqual({ start: 40, guide: null });
  });
  it('excludes the moving clip own old edges and still includes the stationary playhead', () => {
    let document = project();
    document = applyCommand(document, { type: 'place', clipId: 'b', layerId: 'upper', start: 215, index: 1 });
    expect(placementSnapPoints(document, 'b', 87)).not.toContain(215);
    expect(placementSnapPoints(document, 'b', 87)).not.toContain(275);
    const plan = planTimelineDrop(document, { kind: 'clip', clipId: 'b', grabFrame: 20 }, 'upper', 110, true, 4, 87);
    expect(plan).toMatchObject({ start: 87, guide: 87 });
  });
  it.each(['a', 'b', 'c'])('ripple marker equals actual committed start when moving %s after removal', (clipId) => {
    const document = project();
    for (const pointerFrame of [0, 55, 75, 125, 300]) {
      const plan = planTimelineDrop(
        document,
        { kind: 'clip', clipId, grabFrame: 10 },
        'video-1',
        pointerFrame,
        true,
        5,
        0,
      );
      expect(plan.error).toBe('');
      const next = applyCommand(document, plan.command!);
      expect(calculateLayout(next).clips.find((clip) => clip.clip.id === clipId)?.start).toBe(plan.start);
      expect(next.clips).toHaveLength(3);
    }
  });
  it('uses actual dissolved/ripple positions rather than pre-removal boundary indices', () => {
    let document = project();
    document = applyCommand(document, {
      type: 'transition',
      transition: { leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 20 },
    });
    const plan = planTimelineDrop(document, { kind: 'clip', clipId: 'b', grabFrame: 10 }, 'video-1', 100, true, 5, 0);
    expect(plan.error).toBe('');
    expect(
      calculateLayout(applyCommand(document, plan.command!)).clips.find((clip) => clip.clip.id === 'b')?.start,
    ).toBe(plan.start);
  });
  it('shows invalid same-overlay overlap without changing the committed document', () => {
    let document = project();
    document = applyCommand(document, { type: 'place', clipId: 'a', layerId: 'upper', start: 50, index: 0 });
    const before = JSON.stringify(document);
    const plan = planTimelineDrop(document, { kind: 'clip', clipId: 'b', grabFrame: 0 }, 'upper', 70, false, 5, 0);
    expect(plan.error).toContain('cannot overlap');
    expect(JSON.stringify(document)).toBe(before);
  });
  it('copies a media batch as consecutive placements and reports the first exact start', () => {
    const document = project();
    const payload = {
      kind: 'media' as const,
      clips: [createClip('new-a', 'a', 5, 25), createClip('new-b', 'b', 10, 40)],
    };
    const plan = planTimelineDrop(document, payload, 'upper', 122, true, 3, 0);
    expect(plan).toMatchObject({ start: 120, duration: 50, guide: 120, error: '' });
    const primary = planTimelineDrop(document, payload, 'video-1', 100, false, 3, 0);
    expect(primary).toMatchObject({ start: 120, index: 2, mode: 'ripple', error: '' });
  });

  it('solves a trailing-edge magnet with the duration at its new row-rate placement', () => {
    let document = project();
    document = applyCommand(document, {
      type: 'layer-update',
      layer: {
        ...document.layers[1]!,
        keyframes: [
          { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: 1 } },
          { frame: 100, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 3 } },
        ],
      },
    });
    const before = JSON.stringify(document);
    const plan = planTimelineDrop(document, { kind: 'clip', clipId: 'b', grabFrame: 13 }, 'upper', 55, true, 3, 69);
    expect(plan).toMatchObject({ start: 40, duration: 29, guide: 69, error: '' });
    const next = applyCommand(document, plan.command!);
    const placed = calculateLayout(next).clips.find((clip) => clip.clip.id === 'b')!;
    expect([placed.start, placed.duration, placed.end]).toEqual([40, 29, 69]);
    expect(next.layers).toEqual(
      document.layers.map((layer) =>
        layer.id === 'video-1'
          ? {
              ...layer,
              transitions: [{ leftId: 'a', rightId: 'c', type: 'cut', duration: 0 }],
            }
          : layer,
      ),
    );
    expect(JSON.stringify(document)).toBe(before);
  });

  it('reports the exact contextual batch width and consecutive media starts across a row speed curve', () => {
    let document = project();
    document = applyCommand(document, {
      type: 'layer-update',
      layer: {
        ...document.layers[1]!,
        keyframes: [
          { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: 1 } },
          { frame: 100, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 3 } },
        ],
      },
    });
    const clips = [createClip('new-a', 'a', 10, 70), createClip('new-b', 'b', 20, 80)];
    const plan = planTimelineDrop(document, { kind: 'media', clips }, 'upper', 42, false, 3, 0);
    expect(plan).toMatchObject({ start: 42, duration: 51, guide: null, error: '' });
    let next = applyCommand(document, {
      type: 'insert',
      clip: { ...clips[0]!, layerId: 'upper', start: 42 },
      index: 3,
    });
    const first = calculateLayout(next).clips.find((clip) => clip.clip.id === 'new-a')!;
    next = applyCommand(next, { type: 'insert', clip: { ...clips[1]!, layerId: 'upper', start: first.end }, index: 4 });
    const placed = calculateLayout(next).clips.filter((clip) => clip.clip.layerId === 'upper');
    expect(placed.map((clip) => [clip.start, clip.duration, clip.end])).toEqual([
      [42, 28, 70],
      [70, 23, 93],
    ]);
    expect(placed.at(-1)!.end - placed[0]!.start).toBe(plan.duration);
  });
});
