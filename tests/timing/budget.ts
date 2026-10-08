import { appendFile } from 'node:fs/promises';

export interface TimedTest {
  title: string;
  /** Milliseconds actually used. */
  duration: number;
  /** Milliseconds allowed; zero means unlimited. */
  timeout: number;
}

export interface HeadroomReading {
  title: string;
  description: string;
}

/** Tests above this share of their limit need a larger limit before hosted runners hit it. */
export const TIMING_SHARE = 1 / 3;
const ROWS = 20;

const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)} s`;
const cell = (text: string): string => text.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');

/** Informational only: time limits are not performance gates on uncontrolled runners. */
export function timingReport(
  suite: string,
  tests: readonly TimedTest[],
  headroom: readonly HeadroomReading[] = [],
): { markdown: string; notable: boolean } {
  const tight = tests
    .filter((test) => test.timeout > 0 && test.duration >= test.timeout * TIMING_SHARE)
    .sort((left, right) => right.duration / right.timeout - left.duration / left.timeout);
  const lines = [`### ${suite} time limits`, ''];
  if (tight.length) {
    lines.push(
      `${tight.length} of ${tests.length} tests used at least a third of their time limit.`,
      '',
      '| Share | Used / limit | Test |',
      '| ---: | ---: | --- |',
      ...tight
        .slice(0, ROWS)
        .map(
          (test) =>
            `| ${Math.round((test.duration / test.timeout) * 100)}% | ${seconds(test.duration)} / ${seconds(test.timeout)} | ${cell(test.title)} |`,
        ),
    );
    if (tight.length > ROWS) lines.push('', `${tight.length - ROWS} more not shown.`);
  } else lines.push(`None of ${tests.length} tests used a third of its time limit.`);
  if (headroom.length)
    lines.push(
      '',
      '#### Real-time headroom',
      '',
      '| Test | Readings |',
      '| --- | --- |',
      ...headroom.slice(0, ROWS).map((reading) => `| ${cell(reading.title)} | ${cell(reading.description)} |`),
    );
  if (headroom.length > ROWS) lines.push('', `${headroom.length - ROWS} more readings not shown.`);
  return { markdown: `${lines.join('\n')}\n`, notable: tight.length > 0 };
}

/** Job summary in GitHub Actions; local runs print only tests that need attention. */
export async function publishTimingReport(report: { markdown: string; notable: boolean }): Promise<void> {
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) await appendFile(summary, `${report.markdown}\n`);
  if (summary || report.notable) process.stdout.write(`\n${report.markdown}`);
}
