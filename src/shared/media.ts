import { z } from 'zod';
import { frameSchema, idSchema, rateSchema } from './model.js';
import { formatTimecode } from './timing.js';

export const fingerprintSchema = z
  .object({
    algorithm: z.literal('sampled-sha256-v1'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
    device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(),
  })
  .strict();
/** SHA-256 of every byte of an original, independent of its path and filesystem. */
export const contentSchema = z
  .object({
    algorithm: z.literal('sha256-full-v1'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict();
export const metadataSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    codec: z.string(),
    pixelFormat: z.string(),
    frameRate: rateSchema,
    frameCount: frameSchema.positive(),
    durationSeconds: z.number().positive(),
    colourPrimaries: z.literal('bt709'),
    colourTransfer: z.literal('bt709'),
    colourSpace: z.literal('bt709'),
    colourRange: z.enum(['tv', 'pc']),
    hasAudio: z.boolean(),
  })
  .strict();
export const proxyVerificationSchema = z
  .object({
    frameCount: frameSchema.positive(),
    samples: z
      .array(z.object({ frame: frameSchema, meanAbsoluteError8Bit: z.number().nonnegative() }).strict())
      .length(3),
    verifiedAt: z.string(),
  })
  .strict();
/** Every editing proxy profile has a keyframe exactly every 15 frames (closed GOP). */
export const PROXY_GOP_FRAMES = 15;
export const preparedSchema = z
  .object({
    profile: z.literal('h264-720p-bt709-gop15-v1'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    thumbnailFrames: z.array(frameSchema).min(1),
    verification: proxyVerificationSchema,
  })
  .strict();
/** Original frames [start, end) shown black: a group of pictures containing undecodable frames. */
export const damagedRangeSchema = z
  .object({ start: frameSchema, end: frameSchema })
  .strict()
  .refine((range) => range.end > range.start, 'A damaged range must contain at least one frame.');
export const mediaAssetSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    sourcePath: z.string(),
    fingerprint: fingerprintSchema,
    /** Recorded by the first preparation; null until then. Required to relink a moved original. */
    content: contentSchema.nullable(),
    metadata: metadataSchema,
    status: z.enum(['registered', 'queued', 'preparing', 'ready', 'error']),
    error: z.string().nullable(),
    prepared: preparedSchema.nullable(),
    /** Found by preparation; registries written before damage detection have none recorded. */
    damage: z.array(damagedRangeSchema).default([]),
  })
  .strict();
export const registrySchema = z.object({ version: z.literal(2), assets: z.array(mediaAssetSchema) }).strict();
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type SourceFingerprint = z.infer<typeof fingerprintSchema>;
export type SourceContent = z.infer<typeof contentSchema>;
export type VideoMetadata = z.infer<typeof metadataSchema>;
export type DamagedRange = z.infer<typeof damagedRangeSchema>;

/** Inclusive timecodes, e.g. "00:13:00–00:13:29"; OUT stays exclusive in storage. */
export function damageLabel(damage: readonly DamagedRange[]): string {
  return damage.map((range) => `${formatTimecode(range.start)}–${formatTimecode(range.end - 1)}`).join(', ');
}
export function damagedAt(damage: readonly DamagedRange[], frame: number): boolean {
  return damage.some((range) => frame >= range.start && frame < range.end);
}
export type ProxyVerification = z.infer<typeof proxyVerificationSchema>;

export const jobSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['prepare', 'reference', 'audio', 'export', 'relink', 'motion', 'music-analysis']),
    label: z.string(),
    state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    progress: z.number().min(0).max(1),
    message: z.string(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    outputUrl: z.string().nullable(),
    receiptUrl: z.string().nullable(),
  })
  .strict();
export type MediaJob = z.infer<typeof jobSchema>;

/** Camera motion and music analyses wait for every other queued job, so a batch's proxies all come first. */
export function runsInBackground(job: Pick<MediaJob, 'kind'>): boolean {
  return job.kind === 'motion' || job.kind === 'music-analysis';
}
