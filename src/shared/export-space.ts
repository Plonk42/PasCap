import { z } from 'zod';
import {
  EXPORT_PROFILES,
  EXPORT_RESOURCES,
  exportAudioSample,
  LAYERED_EXPORT_RESOURCES,
  needsLayeredExport,
  planExportMusic,
  type ExportProfile,
} from './export.js';
import type { ProjectDocument } from './model.js';
import { calculateLayout } from './timeline.js';

/** Minimum headroom to START a job, not a bound on its duration-dependent disk use. */
export const MIN_EXPORT_FREE_BYTES = 16 * 1024 ** 2;
const bytes = z.number().nonnegative();
export const exportSpaceEstimateSchema = z
  .object({
    losslessBytes: bytes,
    encodedBytes: bytes,
    audioBytes: bytes,
    overheadBytes: bytes,
    totalBytes: bytes,
  })
  .strict();
export const exportPreflightSchema = z
  .object({
    directory: z.string().min(1),
    availableBytes: bytes,
    estimate: exportSpaceEstimateSchema,
    status: z.enum(['available', 'tight', 'blocked']),
    checkedAt: z.iso.datetime(),
  })
  .strict();
export type ExportSpaceEstimate = z.infer<typeof exportSpaceEstimateSchema>;
export type ExportPreflight = z.infer<typeof exportPreflightSchema>;

/**
 * Planning allowance, NOT a prediction or an FFV1/H.264 upper bound.
 * Budget two uncompressed bgr0 clips / up to three RGBA16 timelines (lower,
 * track group and output; a span collection counts as one), one byte/pixel/frame for
 * EACH of the encoded chunks and final MP4, the largest selected s16 stereo PCM
 * plus two full-project Float64 stereo accumulators (serial three-file peak), then 25%
 * plus the start reserve for containers/LUTs/receipts/other overhead.
 * Compression, frame content and concurrent filesystem users change actual use.
 */
export function estimateExportSpace(document: ProjectDocument, profile: ExportProfile): ExportSpaceEstimate {
  const layout = calculateLayout(document);
  const target = EXPORT_PROFILES[profile];
  const pixels = target.width * target.height;
  const enabled = new Set(document.layers.filter((layer) => layer.enabled).map((layer) => layer.id));
  const durations = layout.clips
    .filter((placed) => enabled.has(placed.clip.layerId))
    .map((placed) => placed.duration)
    .sort((a, b) => b - a);
  const clipFrames = durations
    .slice(0, EXPORT_RESOURCES.maxLosslessClipsOnDisk)
    .reduce((sum, duration) => sum + duration, 0);
  const timelineFrames = needsLayeredExport(document)
    ? layout.duration * LAYERED_EXPORT_RESOURCES.maxLosslessTimelineRepresentations
    : 0;
  const losslessBytes = pixels * (clipFrames * 4 + timelineFrames * 8);
  const encodedBytes = pixels * layout.duration * 2;
  const music = document.music.map((track) => planExportMusic(track, layout.duration));
  const selectedPcmBytes = Math.max(
    0,
    ...music.map((track) => (track.activeSamples > 0 ? (track.sourceOutSamples - track.sourceInSamples) * 4 : 0)),
  );
  const accumulatorBytes = music.length
    ? exportAudioSample(layout.duration) *
      EXPORT_RESOURCES.audioChannels *
      (EXPORT_RESOURCES.audioAccumulatorBits / 8) *
      (EXPORT_RESOURCES.maxAudioScratchFiles - 1)
    : 0;
  const audioBytes = selectedPcmBytes + accumulatorBytes;
  const subtotal = losslessBytes + encodedBytes + audioBytes;
  const overheadBytes = Math.ceil(subtotal * 0.25) + MIN_EXPORT_FREE_BYTES;
  return exportSpaceEstimateSchema.parse({
    losslessBytes,
    encodedBytes,
    audioBytes,
    overheadBytes,
    totalBytes: subtotal + overheadBytes,
  });
}

export function formatStorageBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('Storage sizes must be finite and non-negative.');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  const unit = value > 0 ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
