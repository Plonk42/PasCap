import { forEachSerial } from '../shared/serial.js';
import type { AnalysisFrame } from '../shared/white-balance.js';
import { VideoStreams } from './video-streams.js';

/** Pixels read per analysed frame: a 720p proxy is read at 320 × 180. */
export const ANALYSIS_PIXELS = 320 * 180;

export function analysisSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(ANALYSIS_PIXELS / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The decoded frame as the compositor uploads it, downscaled, in encoded RGBA bytes. */
function readPixels(frame: VideoFrame): AnalysisFrame {
  const { width, height } = analysisSize(frame.displayWidth, frame.displayHeight);
  const context = new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read decoded frames back for analysis.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(frame, 0, 0, width, height);
  return { width, height, data: context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data };
}

/**
 * Decodes exact source frames of a verified proxy on its own temporary one-decoder reader, separate
 * from the timeline and source review, closing each frame once read. Always releases the reader.
 */
export async function sampleProxyFrames(
  url: string,
  sourceFrames: readonly number[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, AnalysisFrame>> {
  if (typeof VideoDecoder !== 'function')
    throw new Error('Analysis needs WebCodecs video decoding in a current browser.');
  signal.throwIfAborted();
  const frames = [...new Set(sourceFrames)].sort((left, right) => left - right);
  const streams = new VideoStreams(1);
  const sampled = new Map<number, AnalysisFrame>();
  try {
    streams.start(0, url, frames, true, false);
    await forEachSerial(frames, async (frame) => {
      await streams.ready(0, frame, 1, signal);
      const decoded = streams.take(0, frame);
      if (!decoded) throw new Error(`Source frame ${frame} was not decoded.`);
      try {
        sampled.set(frame, readPixels(decoded));
      } finally {
        decoded.close();
      }
      onProgress?.(sampled.size, frames.length);
    });
    return sampled;
  } finally {
    streams.dispose();
  }
}
