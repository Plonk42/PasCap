import { describe, expect, it } from 'vitest';
import { describeHeadroom, type RealtimeHeadroom } from '../browser/music-evidence.js';
import { timingReport } from '../timing/budget.js';

describe('timing report', () => {
  it('lists only tests that used at least a third of their limit, tightest first', () => {
    const report = timingReport('Browser', [
      { title: 'fast', duration: 1_000, timeout: 30_000 },
      { title: 'third', duration: 10_000, timeout: 30_000 },
      { title: 'tight | piped', duration: 54_000, timeout: 60_000 },
      { title: 'unlimited', duration: 90_000, timeout: 0 },
    ]);
    expect(report.notable).toBe(true);
    const rows = report.markdown.split('\n').filter((line) => /^\| \d+%/.test(line));
    expect(rows).toEqual([String.raw`| 90% | 54.0 s / 60.0 s | tight \| piped |`, '| 33% | 10.0 s / 30.0 s | third |']);
    expect(report.markdown).toContain('2 of 4 tests used at least a third');
  });

  it('states when every test is comfortably inside its limit and appends headroom readings', () => {
    const report = timingReport(
      'Native',
      [{ title: 'quick', duration: 100, timeout: 60_000 }],
      [{ title: 'music', description: 'music starts 1, underruns 0, lowest queued 2.4 blocks' }],
    );
    expect(report.notable).toBe(false);
    expect(report.markdown).toContain('None of 1 tests used a third of its time limit.');
    expect(report.markdown).toContain('| music | music starts 1, underruns 0, lowest queued 2.4 blocks |');
  });
});

describe('real-time headroom description', () => {
  const reading = (overrides: Partial<RealtimeHeadroom>): RealtimeHeadroom => ({
    document: 'a',
    starts: 0,
    underruns: 0,
    lowestQueued: null,
    longestTask: null,
    longTasks: 0,
    ...overrides,
  });

  it('combines documents: summed counts, lowest queue and longest task', () => {
    expect(
      describeHeadroom([
        reading({ starts: 1, lowestQueued: 2.44, longestTask: 160, longTasks: 3 }),
        reading({ document: 'b', starts: 1, underruns: 1, lowestQueued: 0.06, longestTask: 70, longTasks: 0 }),
      ]),
    ).toBe(
      'music starts 2, underruns 1, lowest queued 0.1 blocks; longest main-thread task 160 ms, 3 of at least 100 ms',
    );
  });

  it('distinguishes absent music, browsers without long tasks and quiet main threads', () => {
    expect(describeHeadroom([])).toBe('no music started; main-thread long tasks unavailable');
    expect(describeHeadroom([reading({ longestTask: 0 })])).toBe('no music started; no main-thread task over 50 ms');
    expect(describeHeadroom([reading({ starts: 1 })])).toBe(
      'music starts 1, underruns 0, lowest queued unreported; main-thread long tasks unavailable',
    );
  });
});
