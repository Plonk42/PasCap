import { describe, expect, it } from 'vitest';
import { fullMediaSelection, markMediaSelection, moveMediaSelectionEdge, resolveMediaSelection, sourceFrameAtRatio, sourcePointerRatio, validateMediaSelection } from '../../src/shared/media-selection.js';

describe('editor-only source selections', () => {
  it('starts with the complete registered recording and an exclusive OUT', () => {
    expect(fullMediaSelection('recording', 1_800)).toEqual({ mediaId: 'recording', sourceIn: 0, sourceOut: 1_800 });
    expect(fullMediaSelection('single-frame', 1)).toEqual({ mediaId: 'single-frame', sourceIn: 0, sourceOut: 1 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])('rejects an invalid registered frame count %s', (count) => {
    expect(() => fullMediaSelection('recording', count)).toThrow('registered integer frame count');
  });

  it.each([
    { sourceIn: -1, sourceOut: 100 },
    { sourceIn: 50, sourceOut: 50 },
    { sourceIn: 80, sourceOut: 50 },
    { sourceIn: 0, sourceOut: 101 },
    { sourceIn: 0.5, sourceOut: 100 },
    { sourceIn: 0, sourceOut: 99.5 },
    { sourceIn: NaN, sourceOut: 100 },
    { sourceIn: 0, sourceOut: Infinity },
  ])('rejects invalid source bounds %j', (bounds) => {
    expect(() => validateMediaSelection({ mediaId: 'recording', ...bounds }, 100)).toThrow('OUT is exclusive');
  });

  it.each(['', '../original.mp4', 'https://example.com/video', 'recording?url=elsewhere', 'x'.repeat(101)])('rejects unsafe media IDs %s', (mediaId) => {
    expect(() => fullMediaSelection(mediaId, 100)).toThrow('registered media ID');
  });

  it('resolves independent parent choices without mutating or sharing stored objects', () => {
    const chosen = Object.freeze({ mediaId: 'recording', sourceIn: 15, sourceOut: 90 });
    const ranges = Object.freeze({ recording: chosen });
    const resolved = resolveMediaSelection('recording', 100, ranges);
    expect(resolved).toEqual(chosen);
    expect(resolved).not.toBe(chosen);
    resolved.sourceIn = 20;
    expect(chosen.sourceIn).toBe(15);
    expect(resolveMediaSelection('other-recording', 400, ranges)).toEqual(fullMediaSelection('other-recording', 400));
  });

  it('does not treat inherited record properties as chosen ranges', () => {
    for (const mediaId of ['constructor', '__proto__', 'toString']) {
      expect(resolveMediaSelection(mediaId, 100, {})).toEqual(fullMediaSelection(mediaId, 100));
    }
  });

  it('rejects an entry keyed for the wrong media or outside the registered source', () => {
    expect(() => resolveMediaSelection('recording', 100, { recording: { mediaId: 'other', sourceIn: 0, sourceOut: 100 } })).toThrow('different recording');
    expect(() => resolveMediaSelection('recording', 100, { recording: { mediaId: 'recording', sourceIn: 0, sourceOut: 110 } })).toThrow('OUT is exclusive');
  });

  it('restores either end up to the original bounds without moving the opposite edge', () => {
    const range = Object.freeze({ mediaId: 'recording', sourceIn: 150, sourceOut: 510 });
    expect(moveMediaSelectionEdge(range, 'in', -200, 600)).toEqual({ ...range, sourceIn: 0 });
    expect(moveMediaSelectionEdge(range, 'out', 900, 600)).toEqual({ ...range, sourceOut: 600 });
    expect(range).toEqual({ mediaId: 'recording', sourceIn: 150, sourceOut: 510 });
  });

  it('keeps one frame when handles cross or reach either endpoint', () => {
    const range = { mediaId: 'recording', sourceIn: 150, sourceOut: 510 };
    expect(moveMediaSelectionEdge(range, 'in', 999, 600).sourceIn).toBe(509);
    expect(moveMediaSelectionEdge(range, 'out', -999, 600).sourceOut).toBe(151);
    expect(moveMediaSelectionEdge(fullMediaSelection('single', 1), 'in', 999, 1)).toEqual(fullMediaSelection('single', 1));
    expect(moveMediaSelectionEdge(fullMediaSelection('single', 1), 'out', -999, 1)).toEqual(fullMediaSelection('single', 1));
    expect(() => moveMediaSelectionEdge(range, 'in', 0.5, 600)).toThrow('whole source frames');
  });

  it('marks the exact displayed source frame, including the last original frame', () => {
    const range = Object.freeze(fullMediaSelection('recording', 600));
    expect(markMediaSelection(range, 'in', 150, 600)).toEqual({ ...range, sourceIn: 150 });
    expect(markMediaSelection(range, 'out', 509, 600)).toEqual({ ...range, sourceOut: 510 });
    expect(markMediaSelection(range, 'in', 599, 600)).toEqual({ ...range, sourceIn: 599 });
    expect(markMediaSelection(range, 'out', 599, 600)).toEqual(range);
    expect(range.sourceIn).toBe(0);
  });

  it('keeps I/O marks exact even when the displayed head is outside an earlier choice', () => {
    const range = { mediaId: 'recording', sourceIn: 150, sourceOut: 510 };
    expect(markMediaSelection(range, 'in', 550, 600)).toEqual({ ...range, sourceIn: 550, sourceOut: 551 });
    expect(markMediaSelection(range, 'out', 20, 600)).toEqual({ ...range, sourceIn: 20, sourceOut: 21 });
    expect(markMediaSelection(fullMediaSelection('single', 1), 'out', 0, 1)).toEqual(fullMediaSelection('single', 1));
  });

  it.each([-1, 600, 0.5, NaN, Infinity])('rejects a source mark outside an exact decoded frame %s', (head) => {
    expect(() => markMediaSelection(fullMediaSelection('recording', 600), 'in', head, 600)).toThrow('decoded frame');
  });
});

describe('source hover geometry', () => {
  it('maps the entire hover region to the first and last registered frames', () => {
    expect([-100, 10, 60, 110, 900].map((x) => sourceFrameAtRatio(sourcePointerRatio(x, 10, 100), 600))).toEqual([0, 0, 300, 599, 599]);
    expect(sourceFrameAtRatio(1, 1)).toBe(0);
  });

  it('handles reverse scrubbing without accumulated deltas', () => {
    expect([0.1, 0.9, 0.5, 0, 1, 0.1].map((ratio) => sourceFrameAtRatio(ratio, 101))).toEqual([10, 90, 50, 0, 100, 10]);
  });

  it('rejects non-finite or empty pointer regions', () => {
    expect(() => sourcePointerRatio(5, 0, 0)).toThrow('pointer geometry');
    expect(() => sourcePointerRatio(5, 0, -10)).toThrow('pointer geometry');
    expect(() => sourcePointerRatio(NaN, 0, 10)).toThrow('pointer geometry');
    expect(() => sourcePointerRatio(5, Infinity, 10)).toThrow('pointer geometry');
    expect(() => sourceFrameAtRatio(Infinity, 100)).toThrow('review position');
  });
});