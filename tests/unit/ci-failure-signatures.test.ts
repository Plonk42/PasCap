import { expect, it } from 'vitest';
import { failureSignatures } from '../../scripts/ci/failure-signatures.js';

const log = [
  '2026-10-08T00:12:01.1Z   1) tests/browser/grade-comparison.spec.ts:850:1 › comparison during music playback preserves the real worklet epoch ───────',
  '2026-10-08T00:12:01.1Z',
  '2026-10-08T00:12:01.1Z     Error: expect(received).toBe(expected) // Object.is equality',
  '2026-10-08T00:12:02.1Z   2) tests/browser/spatial-gpu.spec.ts:208:3 › pure GPU spatial numeric parity at 3840×2160 ──',
  '2026-10-08T00:12:02.1Z     Test timeout of 30000ms exceeded.',
  '2026-10-08T08:55:01.4Z      × exports full row HSL/curves at final4k 60089ms',
  '2026-10-08T08:55:01.4Z  FAIL  tests/media/layered-export.test.ts > native export > exports full row HSL/curves at final4k',
  '2026-10-08T08:55:01.4Z Error: Test timed out in 60000ms.',
  '2026-10-08T08:56:00.0Z  1 failed',
  '2026-10-08T08:56:00.0Z    tests/browser/grade-comparison.spec.ts:850:1 › comparison during music playback preserves the real worklet epoch',
].join('\n');

it('groups Playwright and Vitest failures by file and title, classifying timeouts', () => {
  expect(failureSignatures(log)).toEqual([
    {
      test: 'tests/browser/grade-comparison.spec.ts › comparison during music playback preserves the real worklet epoch',
      kind: 'failure',
    },
    { test: 'tests/browser/spatial-gpu.spec.ts › pure GPU spatial numeric parity at 3840×2160', kind: 'timeout' },
    {
      test: 'tests/media/layered-export.test.ts › native export > exports full row HSL/curves at final4k',
      kind: 'timeout',
    },
  ]);
});

it('ignores logs without recognised test failures', () => {
  expect(failureSignatures('npm ERR! network\nProcess completed with exit code 1.')).toEqual([]);
});

it('strips ANSI colour from Vitest output and recognises Firefox prerequisite failures', () => {
  const coloured = [
    '2026-10-08T08:55:01.4Z \u001b[31m FAIL \u001b[39m tests/media/layered-export.test.ts > exports at final4k',
    '2026-10-08T08:55:01.4Z \u001b[31mError: Test timed out in 60000ms.\u001b[39m',
    '2026-10-08T09:40:01.0Z Error: Firefox WebGL2 prerequisite failed. On GPU-less Linux, install Xvfb.',
  ].join('\n');
  expect(failureSignatures(coloured)).toEqual([
    { test: 'tests/media/layered-export.test.ts › exports at final4k', kind: 'timeout' },
    { test: 'Firefox WebGL2 prerequisite failed', kind: 'failure' },
  ]);
});
