import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/media/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 2,
    reporters: ['default', './tests/timing/vitest-reporter.ts'],
    // Tests choose NVDEC explicitly; the CPU decoder is the reference everywhere else.
    env: { PASCAP_HW_DECODE: 'off' },
  },
});
