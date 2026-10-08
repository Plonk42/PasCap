import path from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { publishTimingReport, timingReport, type HeadroomReading, type TimedTest } from './budget.js';

export default class PlaywrightTimingReporter implements Reporter {
  readonly #tests: TimedTest[] = [];
  readonly #headroom: HeadroomReading[] = [];

  printsToStdio(): boolean {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') return;
    // titlePath: root, project, file, describes…, title.
    const title = [path.relative(process.cwd(), test.location.file), ...test.titlePath().slice(3)].join(' › ');
    this.#tests.push({ title, duration: result.duration, timeout: test.timeout });
    for (const annotation of result.annotations)
      if (annotation.type === 'realtime-headroom' && annotation.description)
        this.#headroom.push({ title, description: annotation.description });
  }

  async onEnd(): Promise<void> {
    await publishTimingReport(timingReport('Browser', this.#tests, this.#headroom));
  }
}
