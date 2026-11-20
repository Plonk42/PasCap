import { forEachSerial } from '../shared/serial.js';
import { analysisSize, type AnalysisFrame } from '../shared/white-balance.js';
import { VideoStreams } from './video-streams.js';

/** The decoded frame as the compositor uploads it, downscaled, in encoded RGBA bytes. */
function readPixels(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): AnalysisFrame {
  const { width, height } = analysisSize(sourceWidth, sourceHeight);
  const context = new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read decoded frames back for analysis.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return { width, height, data: context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data };
}

/** A still image (JPEG or PNG) at the analysis size, decoded by the browser like a proxy frame. */
export async function sampleImage(url: string, signal: AbortSignal): Promise<AnalysisFrame> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const reason =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  const bitmap = await createImageBitmap(await response.blob());
  try {
    signal.throwIfAborted();
    return readPixels(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
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
        sampled.set(frame, readPixels(decoded, decoded.displayWidth, decoded.displayHeight));
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
