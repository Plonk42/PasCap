import { describe, expect, it } from 'vitest';
import { damageLabel, mediaAssetSchema } from '../../src/shared/media.js';
import { damagedRanges, originalErrorArgs, repairFilter } from '../../src/server/damage.js';

describe('damaged recordings', () => {
  it('extends undecodable frames to their whole groups of pictures and merges neighbours', () => {
    const keyframes = [0, 30, 60, 90, 120];
    expect(damagedRanges([31, 33, 32], keyframes, 150)).toEqual([{ start: 30, end: 60 }]);
    expect(damagedRanges([59, 61], keyframes, 150)).toEqual([{ start: 30, end: 90 }]);
    expect(damagedRanges([30, 121, 149], keyframes, 150)).toEqual([
      { start: 30, end: 60 },
      { start: 120, end: 150 },
    ]);
    expect(damagedRanges([5], [], 20)).toEqual([{ start: 0, end: 20 }]);
  });

  it('labels ranges with inclusive timecodes', () => {
    expect(
      damageLabel([
        { start: 390, end: 420 },
        { start: 900, end: 930 },
      ]),
    ).toBe('00:13:00–00:13:29, 00:30:00–00:30:29');
  });

  it('decodes undamaged originals strictly and unchanged', () => {
    expect(originalErrorArgs({ damage: [] })).toEqual(['-xerror', '-err_detect', 'explode']);
    expect(repairFilter([], 0)).toBe('');
    expect(originalErrorArgs({ damage: [{ start: 0, end: 30 }] })).toEqual([]);
    expect(
      repairFilter(
        [
          { start: 0, end: 30 },
          { start: 60, end: 90 },
        ],
        10,
      ),
    ).toContain("enable='between(n,-10,19)+between(n,50,79)'");
  });

  it('reads registry entries written before damage detection as undamaged', () => {
    const asset = {
      id: 'video',
      name: 'a.mp4',
      sourcePath: '/videos/a.mp4',
      fingerprint: {
        algorithm: 'sampled-sha256-v1',
        digest: 'a'.repeat(64),
        size: 1,
        mtimeMs: 0,
        device: 0,
        inode: 0,
      },
      content: null,
      metadata: {
        width: 320,
        height: 180,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        frameRate: { numerator: 30000, denominator: 1001 },
        frameCount: 100,
        durationSeconds: 3.3,
        colourPrimaries: 'bt709',
        colourTransfer: 'bt709',
        colourSpace: 'bt709',
        colourRange: 'tv',
        hasAudio: false,
      },
      status: 'registered',
      error: null,
      prepared: null,
    };
    expect(mediaAssetSchema.parse(asset).damage).toEqual([]);
    expect(() => mediaAssetSchema.parse({ ...asset, damage: [{ start: 5, end: 5 }] })).toThrow();
  });
});
