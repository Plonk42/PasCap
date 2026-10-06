import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/server/process.js';

const enabled = process.env['PASCAP_SPACE_TESTS'] === '1';

/** Separate explicit opt-in: Linux unshare/user namespaces + mount/umount are required. */
describe.skipIf(!enabled)('genuine ENOSPC in a private nonprivileged 32 MiB tmpfs', () => {
  it('fails clearly, publishes no partial MP4 and preserves an actual completed export, save and original', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-space-native-'));
    try {
      const output = await runProcess('unshare', [
        '--user',
        '--map-root-user',
        '--mount',
        '--propagation',
        'private',
        process.execPath,
        '--import',
        'tsx',
        path.resolve('tests/media/space-worker.ts'),
        root,
      ]);
      const report = JSON.parse(output.toString('utf8')) as {
        capacityBytes: number;
        availableBefore: number;
        availableAfterCleanup: number;
        allowanceBytes: number;
        failure: string;
        previousExportPreserved: boolean;
        savedProjectPreserved: boolean;
        originalPreserved: boolean;
        partialPublished: boolean;
      };
      expect(report.capacityBytes).toBe(32 * 1024 ** 2);
      expect(report.availableAfterCleanup).toBe(report.availableBefore);
      expect(report.allowanceBytes).toBeGreaterThan(report.capacityBytes);
      expect(report.failure).toContain('ran out of space');
      expect(report).toMatchObject({
        previousExportPreserved: true,
        savedProjectPreserved: true,
        originalPreserved: true,
        partialPublished: false,
      });
      console.log(
        `Private tmpfs ENOSPC: ${report.capacityBytes} byte capacity, ${report.availableAfterCleanup} bytes recovered after owned-job cleanup; completed export/project/original preserved, no partial publication.`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
