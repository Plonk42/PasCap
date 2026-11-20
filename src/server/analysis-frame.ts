import path from 'node:path';
import type { AnalysisFrame } from '../shared/white-balance.js';
import type { ServiceConfig } from './config.js';
import { ServiceError } from './errors.js';
import { runProcess } from './process.js';

/** One frame of a video at `time` seconds, or of a still with null, read in place with FFmpeg at the analysis size. */
export async function readAnalysisFrame(
  config: Pick<ServiceConfig, 'ffmpeg'>,
  filename: string,
  size: { width: number; height: number },
  time: number | null,
): Promise<AnalysisFrame> {
  const bytes = size.width * size.height * 4;
  const seek = time === null ? [] : ['-ss', time.toFixed(6)];
  const data = await runProcess(
    config.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-threads',
      '2',
      ...seek,
      '-i',
      filename,
      '-frames:v',
      '1',
      '-vf',
      `scale=${size.width}:${size.height}:flags=area+accurate_rnd+full_chroma_int:out_range=pc,format=rgba`,
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { maxBytes: bytes },
  );
  if (data.length !== bytes) throw new ServiceError(`${path.basename(filename)} gave no frame at ${time ?? 0} s.`, 422);
  return { ...size, data: new Uint8Array(data) };
}
