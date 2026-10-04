import { describe, expect, it } from 'vitest';
import { clipSpeedPreset } from '../../src/shared/clip-speed.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipCurvePoints, clipSpeedPointer, planClipSpeedDrag, previewClipSource, speedRatePosition } from '../../src/web/clip-speed-geometry.js';

function fixture() {
  const project = createProject('curve-gesture', 'Curve gesture'); const clip = createClip('clip', 'source', 0, 120);
  clip.speed = clipSpeedPreset(clip, 'flat'); project.clips = [clip]; return project;
}

describe('clip speed graph geometry and transaction planning', () => {
  it('uses a logarithmic speed axis with exact limits and independent integer source movement', () => {
    expect(speedRatePosition(0.1)).toBe(1); expect(speedRatePosition(8)).toBe(0);
    const height = 158;
    const dy = -(Math.log(2) / Math.log(80)) * height;
    expect(clipSpeedPointer({ originFrame: 60, originRate: 1, deltaX: 15, deltaY: dy, width: 180, height, sourceIn: 0, sourceOut: 120 })).toEqual({ frame: 70, rate: 2 });
  });
  it.each([{ dx: -1000, dy: 1000, frame: 0, rate: 0.1 }, { dx: 1000, dy: -1000, frame: 120, rate: 8 }])('bounds a pointer gesture at source $frame / rate $rate', ({ dx, dy, frame, rate }) => {
    expect(clipSpeedPointer({ originFrame: 60, originRate: 1, deltaX: dx, deltaY: dy, width: 180, height: 158, sourceIn: 0, sourceOut: 120 })).toEqual({ frame, rate });
  });
  it.each([0, -1, NaN])('rejects invalid captured graph width %s', (width) => {
    expect(() => clipSpeedPointer({ originFrame: 60, originRate: 1, deltaX: 0, deltaY: 0, width, height: 158, sourceIn: 0, sourceOut: 120 })).toThrow('geometry');
  });
  it('plans a whole-clip curve edit without touching its committed source/other keys and keeps the preview source under the new map', () => {
    const project = fixture(); const before = structuredClone(project);
    const plan = planClipSpeedDrag(project, 'clip', 60, 70, 1.125, 40, 40);
    expect(plan.error).toBe(''); expect(plan.command).toMatchObject({ type: 'speed', clipId: 'clip' });
    expect(project).toEqual(before); expect(plan.document.clips[0]!).toMatchObject({ sourceIn: 0, sourceOut: 120 });
    const placed = calculateLayout(plan.document).clips[0]!;
    expect(placed.retiming.sourceAt(plan.previewFrame)).toBe(40);
  });
  it('rejects a collision without merging or returning the last valid candidate', () => {
    const project = fixture(); const valid = planClipSpeedDrag(project, 'clip', 60, 70, 2, 20, 20);
    expect(valid.error).toBe('');
    const invalid = planClipSpeedDrag(project, 'clip', 60, 90, 3, 20, 20);
    expect(invalid.error).toContain('already exists'); expect(invalid.command).toBeNull();
    expect(invalid.document).toBe(project); expect(invalid.previewFrame).toBe(20);
  });
  it('rejects a speed/fade conflict atomically without shrinking existing fades', () => {
    const project = fixture(); project.openingFade = 110;
    const plan = planClipSpeedDrag(project, 'clip', 60, 60, 8, 20, 20);
    expect(plan.error).not.toBe(''); expect(plan.command).toBeNull(); expect(plan.document).toBe(project);
    expect(project.openingFade).toBe(110);
  });
  it('seeks boundary/off-trim stored points to the nearest actual source frame', () => {
    const project = fixture(); project.clips[0]!.sourceIn = 30; project.clips[0]!.sourceOut = 90;
    expect(previewClipSource(project, 'clip', 0)).toBe(0);
    expect(previewClipSource(project, 'clip', 120)).toBe(59);
  });
  it('previews the exact slow-motion source image when the floor inverse lands just before it', () => {
    const project = fixture(); project.clips[0]!.speed = { mode: 'curve', keyframes: [{ frame: 0, rate: 0.5, interpolation: 'linear' }, { frame: 60, rate: 0.75, interpolation: 'linear' }, { frame: 120, rate: 1, interpolation: 'hold' }] };
    const map = calculateLayout(project).clips[0]!.retiming;
    expect(map.sourceAt(map.outputAt(60))).toBe(59);
    expect(map.sourceAt(previewClipSource(project, 'clip', 60))).toBe(60);
  });
  it('previews the closest available fast image without moving its skipped source key', () => {
    const project = fixture(); project.clips[0]!.speed = { mode: 'curve', keyframes: [{ frame: 0, rate: 4, interpolation: 'hold' }, { frame: 3, rate: 4, interpolation: 'hold' }, { frame: 120, rate: 4, interpolation: 'hold' }] };
    const before = structuredClone(project); const map = calculateLayout(project).clips[0]!.retiming;
    expect(previewClipSource(project, 'clip', 3)).toBe(1); expect(map.sourceAt(1)).toBe(4);
    expect(project).toEqual(before);
  });
  it('previews the final output frame at the exclusive OUT even when its last source image repeats', () => {
    const project = fixture(); project.clips[0]!.speed = { mode: 'curve', keyframes: [{ frame: 0, rate: 0.25, interpolation: 'hold' }, { frame: 120, rate: 0.25, interpolation: 'hold' }] };
    expect(previewClipSource(project, 'clip', 120)).toBe(479);
    expect(calculateLayout(project).clips[0]!.retiming.sourceAt(479)).toBe(119);
  });
  it('draws the held rate up to its key rather than a fictional ramp and includes exact key positions', () => {
    const points = clipCurvePoints({ mode: 'curve', keyframes: [{ frame: 0, rate: 1, interpolation: 'hold' }, { frame: 30, rate: 2, interpolation: 'linear' }, { frame: 120, rate: 2, interpolation: 'hold' }] }, 0, 120);
    expect(points).toContain(`25,${speedRatePosition(2) * 100}`);
    const before = points.split(' ').map((point) => point.split(',').map(Number)).find(([x]) => x! > 24.99 && x! < 25);
    expect(before?.[1]).toBeCloseTo(speedRatePosition(1) * 100, 10);
  });
});