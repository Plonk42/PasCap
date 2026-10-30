import type { MediaAsset } from '../../src/shared/media.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

/** A registered UHD recording of 600 frames whose 720p proxy is ready unless `status` says otherwise. */
export function analysisAsset(id: string, status: MediaAsset['status'] = 'ready'): MediaAsset {
  const frameCount = 600;
  return {
    id,
    name: `${id}.mp4`,
    sourcePath: `/synthetic/${id}.mp4`,
    fingerprint: {
      algorithm: 'sampled-sha256-v1',
      digest: '0'.repeat(64),
      size: 1,
      mtimeMs: 0,
      device: 0,
      inode: 0,
    },
    content: null,
    status,
    error: null,
    prepared:
      status === 'ready'
        ? {
            profile: 'h264-720p-bt709-gop15-v1',
            width: 1280,
            height: 720,
            thumbnailFrames: [0],
            verification: {
              frameCount,
              samples: [0, 300, 599].map((frame) => ({ frame, meanAbsoluteError8Bit: 0 })),
              verifiedAt: '2026-10-19T00:00:00.000Z',
            },
          }
        : null,
    damage: [],
    metadata: {
      width: 3840,
      height: 2160,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      frameRate: PROJECT_FPS,
      frameCount,
      durationSeconds: framesToSeconds(frameCount),
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
      hasAudio: false,
    },
  };
}
