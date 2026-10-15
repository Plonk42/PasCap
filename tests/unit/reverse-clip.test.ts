import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { createClip, createProject, type ProjectDocument, type VideoClip } from '../../src/shared/model.js';
import { removeSelectedRange, splitSourceFrame, trimAtPlayhead } from '../../src/shared/rush-editing.js';
import { trimOnTimeline } from '../../src/shared/source-range.js';
import { compileRetiming, type SpeedSettings } from '../../src/shared/speed.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipKeyframeKind, clipKeyframeSlideTarget } from '../../src/web/clip-keyframe-drag.js';
import { clipKeyframeMarkers } from '../../src/web/clip-keyframe-markers.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';

function reversed(
  sourceIn: number,
  sourceOut: number,
  speed: SpeedSettings = { mode: 'constant', rate: 1 },
): VideoClip {
  return { ...createClip('reversed', 'video', sourceIn, sourceOut), speed, reverse: true };
}
function project(clip: VideoClip, ripple = true, start = 0): ProjectDocument {
  const document = createProject('reverse', 'Reverse');
  document.layers[0]!.ripple = ripple;
  document.clips = [{ ...clip, start }];
  return applyCommand(document, { type: 'reverse', clipId: clip.id, reverse: clip.reverse });
}
function shown(document: ProjectDocument): number[][] {
  return calculateLayout(document).clips.map((placed) =>
    Array.from({ length: placed.duration }, (_, frame) => placed.retiming.sourceAt(frame)),
  );
}

describe('reversed retiming map', () => {
  it('plays OUT − 1 back to IN at 1× with unchanged duration and mirrored inverses', () => {
    const map = compileRetiming(reversed(10, 20));
    expect(map.duration).toBe(10);
    expect(Array.from({ length: 10 }, (_, frame) => map.sourceAt(frame))).toEqual([
      19, 18, 17, 16, 15, 14, 13, 12, 11, 10,
    ]);
    expect([map.sourcePositionAt(0), map.sourcePositionAt(10)]).toEqual([20, 10]);
    for (let source = 10; source < 20; source++) expect(map.sourceAt(map.outputAt(source))).toBe(source);
  });

  it.each([0.1, 0.37, 0.5, 1, 2, 3, 8])('mirrors constant %s× exactly within the source range', (rate) => {
    const speed = { mode: 'constant', rate } as const;
    const forward = compileRetiming({ ...reversed(7, 61, speed), reverse: false });
    const backward = compileRetiming(reversed(7, 61, speed));
    expect(backward.duration).toBe(forward.duration);
    for (let frame = 0; frame < forward.duration; frame++)
      expect(backward.sourceAt(frame)).toBe(7 + 61 - 1 - forward.sourceAt(frame));
  });

  it('keeps a slow-motion keyframe range on the same footage when reversed', () => {
    const speed: SpeedSettings = {
      mode: 'curve',
      keyframes: [
        { frame: 30, rate: 0.25, interpolation: 'hold' },
        { frame: 40, rate: 2, interpolation: 'linear' },
        { frame: 70, rate: 1, interpolation: 'smooth' },
      ],
    };
    const forward = compileRetiming({ ...reversed(0, 100, speed), reverse: false });
    const backward = compileRetiming(reversed(0, 100, speed));
    expect(backward.duration).toBe(forward.duration);
    const count = (map: typeof forward, from: number, to: number): number =>
      Array.from({ length: map.duration }, (_, frame) => map.sourceAt(frame)).filter(
        (source) => source >= from && source < to,
      ).length;
    // The 0.25× footage between frames 30 and 40 still lasts about forty output frames.
    expect(Math.abs(count(backward, 30, 40) - count(forward, 30, 40))).toBeLessThanOrEqual(1);
    let previous = Infinity;
    for (let frame = 0; frame < backward.duration; frame++) {
      const source = backward.sourceAt(frame);
      const position = backward.sourcePositionAt(frame);
      expect(source).toBeLessThanOrEqual(previous);
      expect(source).toBeGreaterThanOrEqual(position - 1 - 1e-6);
      expect(source).toBeLessThan(position + 1e-6);
      previous = source;
    }
    expect(backward.sourceAt(0)).toBe(99);
  });
});

describe('reversed clip edits act on the displayed clip', () => {
  it('toggles direction in one Undo step without moving or resizing the clip', () => {
    const forward = project({ ...reversed(0, 20), reverse: false }, false, 12);
    const history = new EditHistory(forward);
    const next = history.commit({ type: 'reverse', clipId: 'reversed', reverse: true });
    expect(next.clips[0]).toMatchObject({ reverse: true, start: 12, sourceIn: 0, sourceOut: 20 });
    expect(calculateLayout(next).duration).toBe(calculateLayout(forward).duration);
    expect(history.undo().clips[0]!.reverse).toBe(false);
    expect(() => applyCommand(next, { type: 'reverse', clipId: 'missing', reverse: false })).toThrow();
  });

  it('splits so both pieces stay reversed and the right one starts with the displayed frame', () => {
    const document = project(reversed(0, 20));
    const placed = calculateLayout(document).clips[0]!;
    expect(placed.retiming.sourceAt(5)).toBe(14);
    const next = applyCommand(document, {
      type: 'split',
      clipId: 'reversed',
      sourceFrame: splitSourceFrame(placed, 5),
      newClipId: 'right',
    });
    expect(
      next.clips.map(({ id, sourceIn, sourceOut, start, reverse }) => ({ id, sourceIn, sourceOut, start, reverse })),
    ).toEqual([
      { id: 'reversed', sourceIn: 15, sourceOut: 20, start: 0, reverse: true },
      { id: 'right', sourceIn: 0, sourceOut: 15, start: 5, reverse: true },
    ]);
    expect(shown(next).flat()).toEqual(shown(document).flat());
  });

  it.each([
    [true, 5],
    [false, 8],
  ])('cuts the displayed range of a reversed clip (Ripple %s)', (ripple, rightStart) => {
    const document = project(reversed(0, 20), ripple);
    const command = removeSelectedRange(document, 'reversed', { inFrame: 5, outFrame: 8 }, 'right');
    expect(command).toMatchObject({ sourceIn: 12, sourceOut: 15 });
    const next = applyCommand(document, command);
    expect(next.clips.map(({ id, sourceIn, sourceOut, start }) => ({ id, sourceIn, sourceOut, start }))).toEqual([
      { id: 'reversed', sourceIn: 15, sourceOut: 20, start: 0 },
      { id: 'right', sourceIn: 0, sourceOut: 12, start: rightStart },
    ]);
    const before = shown(document)[0]!;
    expect(shown(next)).toEqual([before.slice(0, 5), before.slice(8)]);
  });

  it('cuts the start or end of a reversed clip from the matching source end', () => {
    const document = project(reversed(0, 20), false, 4);
    const head = applyCommand(document, removeSelectedRange(document, 'reversed', { inFrame: 0, outFrame: 7 }, 'x'));
    expect(head.clips).toMatchObject([{ sourceIn: 0, sourceOut: 17, start: 7 }]);
    const tail = applyCommand(document, removeSelectedRange(document, 'reversed', { inFrame: 20, outFrame: 30 }, 'x'));
    // Project frames 20–23 show sources 3…0.
    expect(tail.clips).toMatchObject([{ sourceIn: 4, sourceOut: 20, start: 4 }]);
  });

  it('trims start/end at the playhead in output terms (Q/W)', () => {
    for (const ripple of [true, false]) {
      const document = project(reversed(0, 20), ripple, 10);
      // Project frame 15 shows source 14.
      const before = applyCommand(document, trimAtPlayhead(document, 'reversed', 15, 'in'));
      expect(before.clips[0]).toMatchObject({ sourceIn: 0, sourceOut: 15, start: ripple ? 10 : 15 });
      expect(shown(before)[0]![0]).toBe(14);
      const after = applyCommand(document, trimAtPlayhead(document, 'reversed', 15, 'out'));
      expect(after.clips[0]).toMatchObject({ sourceIn: 14, sourceOut: 20, start: 10 });
      expect(shown(after)[0]!.at(-1)).toBe(14);
    }
  });

  it('trims source OUT with the left handle and source IN with the right handle', () => {
    const document = project(reversed(5, 20), true);
    expect(applyCommand(document, trimOnTimeline(document, 'reversed', 'in', 3, 30, 'output')).clips[0]).toMatchObject({
      sourceIn: 5,
      sourceOut: 17,
    });
    expect(
      applyCommand(document, trimOnTimeline(document, 'reversed', 'out', -2, 30, 'output')).clips[0],
    ).toMatchObject({ sourceIn: 7, sourceOut: 20 });
    expect(applyCommand(document, trimOnTimeline(document, 'reversed', 'out', 4, 30, 'source')).clips[0]).toMatchObject(
      {
        sourceIn: 1,
        sourceOut: 20,
      },
    );
    const positioned = project(reversed(5, 20), false, 10);
    expect(trimOnTimeline(positioned, 'reversed', 'in', 3, 30, 'output')).toEqual({
      type: 'trim-place',
      clipId: 'reversed',
      sourceIn: 5,
      sourceOut: 17,
      start: 13,
    });
    // Restoring the left edge recovers footage after OUT and keeps the right edge at frame 25.
    expect(trimOnTimeline(positioned, 'reversed', 'in', -6, 30, 'source')).toEqual({
      type: 'trim-place',
      clipId: 'reversed',
      sourceIn: 5,
      sourceOut: 26,
      start: 4,
    });
    expect(trimOnTimeline(positioned, 'reversed', 'in', -40, 30, 'source')).toMatchObject({ sourceOut: 30, start: 0 });
  });

  it('duplicates the direction with the clip', () => {
    const next = applyCommand(project(reversed(0, 20)), { type: 'duplicate', clipId: 'reversed', newClipId: 'copy' });
    expect(next.clips.map((clip) => clip.reverse)).toEqual([true, true]);
  });
});

describe('reversed timeline speed markers', () => {
  it('mirrors marker positions: OUT is the left boundary and IN previews the last frame', () => {
    const speed: SpeedSettings = {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 1, interpolation: 'linear' },
        { frame: 6, rate: 1, interpolation: 'linear' },
        { frame: 20, rate: 1, interpolation: 'linear' },
      ],
    };
    const document = project(reversed(0, 20, speed), true, 0);
    const placed = calculateLayout(document).clips[0]!;
    expect(
      clipKeyframeMarkers(placed).map(({ sourceFrame, outputFrame, seekFrame }) => [
        sourceFrame,
        outputFrame,
        seekFrame,
      ]),
    ).toEqual([
      [0, 19, 19],
      [6, 13, 13],
      [20, 0, 0],
    ]);
    expect(previewClipSource(document, 'reversed', 6)).toBe(13);
    expect(previewClipSource(document, 'reversed', 0)).toBe(19);
    expect(previewClipSource(document, 'reversed', 20)).toBe(0);
    const kind = clipKeyframeKind('speed', {
      frameCountOf: () => 40,
      onSelect: () => {},
      onSeek: () => {},
      onOpen: () => {},
    });
    const target = clipKeyframeSlideTarget(placed, clipKeyframeMarkers(placed)[1]!);
    // → moves the marker right, to a lower source frame of the reversed clip.
    expect(kind.step(document, target, 1).frame).toBe(5);
    expect(kind.planAt(document, target, 15).frame).toBe(4);
    // Dragging onto the first frame keeps the image it shows rather than jumping to OUT.
    expect(kind.planAt(document, target, 0).frame).toBe(19);
  });
});
