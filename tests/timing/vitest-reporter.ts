import path from 'node:path';
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';
import { publishTimingReport, timingReport } from './budget.js';

export default class VitestTimingReporter implements Reporter {
  #defaultTimeout = 0;

  onInit(vitest: Vitest): void {
    this.#defaultTimeout = vitest.config.testTimeout;
  }

  async onTestRunEnd(modules: ReadonlyArray<TestModule>): Promise<void> {
    const tests = modules.flatMap((module) =>
      Array.from(module.children.allTests(), (test: TestCase) => ({
        title: `${path.relative(process.cwd(), module.moduleId)} › ${test.fullName}`,
        duration: test.diagnostic()?.duration ?? 0,
        timeout: test.options.timeout ?? this.#defaultTimeout,
        state: test.result().state,
      })).filter((test) => test.state !== 'skipped' && test.state !== 'pending'),
    );
    await publishTimingReport(timingReport('Unit, service and native', tests));
  }
}
