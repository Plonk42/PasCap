import { describe, expect, it } from 'vitest';
import {
  ETA_MIN_SPAN_MS,
  ETA_WINDOW_MS,
  estimateRemainingMs,
  formatEta,
  recordProgress,
  type ProgressSample,
} from '../../src/web/job-eta.js';

function observe(points: readonly (readonly [number, number])[]): readonly ProgressSample[] {
  return points.reduce<readonly ProgressSample[]>(
    (samples, [seconds, progress]) => recordProgress(samples, seconds * 1000, progress),
    [],
  );
}

describe('export time remaining estimate', () => {
  it('has no estimate without observations, progress or enough elapsed time', () => {
    expect(estimateRemainingMs([])).toBeNull();
    expect(estimateRemainingMs(observe([[0, 0.1]]))).toBeNull();
    expect(
      estimateRemainingMs(
        observe([
          [0, 0.1],
          [ETA_MIN_SPAN_MS / 2000, 0.3],
        ]),
      ),
    ).toBeNull();
    expect(
      estimateRemainingMs(
        observe([
          [0, 0.1],
          [60, 0.101],
        ]),
      ),
    ).toBeNull();
    expect(formatEta(null)).toBeNull();
  });

  it('extrapolates the observed rate', () => {
    // 10% per 20 s from 30% leaves 70% = 140 s.
    expect(
      estimateRemainingMs(
        observe([
          [0, 0.2],
          [20, 0.3],
        ]),
      ),
    ).toBeCloseTo(140_000, 5);
    expect(
      estimateRemainingMs(
        observe([
          [0, 0.2],
          [20, 0.3],
          [40, 0.4],
        ]),
      ),
    ).toBeCloseTo(120_000, 5);
  });

  it('lets a slower phase take over from older fast progress and lengthens during a plateau', () => {
    const fast = observe([
      [0, 0.04],
      [60, 0.5],
    ]);
    const slowed = recordProgress(recordProgress(fast, 120_000, 0.52), 180_000, 0.54);
    expect(estimateRemainingMs(slowed)!).toBeGreaterThan(estimateRemainingMs(fast)!);
    const stalled = recordProgress(fast, 120_000, 0.5);
    expect(estimateRemainingMs(stalled)!).toBeGreaterThan(estimateRemainingMs(fast)!);
    expect(stalled).toHaveLength(2);
  });

  it('forgets observations older than the window', () => {
    const samples = observe([
      [0, 0.1],
      [30, 0.2],
      [ETA_WINDOW_MS / 1000 + 80, 0.9],
    ]);
    expect(samples.map((sample) => sample.progress)).toEqual([0.9]);
  });

  it('starts over when progress goes backwards', () => {
    expect(
      observe([
        [0, 0.4],
        [30, 0.6],
        [40, 0.1],
      ]),
    ).toEqual([{ time: 40_000, progress: 0.1 }]);
  });

  it('is zero at completion and never negative or non-finite', () => {
    expect(
      estimateRemainingMs(
        observe([
          [0, 0.5],
          [30, 1],
        ]),
      ),
    ).toBe(0);
    expect(formatEta(0)).toBe('less than a minute left');
  });

  it('formats coarse text that changes rarely', () => {
    expect(formatEta(40_000)).toBe('less than a minute left');
    expect(formatEta(50_000)).toBe('about 1 min left');
    expect(formatEta(5 * 60_000 + 20_000)).toBe('about 5 min left');
    expect(formatEta(59 * 60_000)).toBe('about 59 min left');
    expect(formatEta(61 * 60_000)).toBe('about 1 h left');
    expect(formatEta(95 * 60_000)).toBe('about 1 h 35 min left');
    expect(formatEta(2 * 60 * 60_000)).toBe('about 2 h left');
  });
});
