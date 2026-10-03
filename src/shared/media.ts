import { z } from 'zod';
import { frameSchema, idSchema, rateSchema } from './model.js';

export const fingerprintSchema = z.object({
  algorithm: z.literal('sampled-sha256-v1'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
}).strict();
export const metadataSchema = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(),
  codec: z.string(), pixelFormat: z.string(),
  frameRate: rateSchema, frameCount: frameSchema.positive(), durationSeconds: z.number().positive(),
  colourPrimaries: z.literal('bt709'), colourTransfer: z.literal('bt709'), colourSpace: z.literal('bt709'),
  colourRange: z.enum(['tv', 'pc']), hasAudio: z.boolean(),
}).strict();
export const proxyVerificationSchema = z.object({
  frameCount: frameSchema.positive(),
  samples: z.array(z.object({ frame: frameSchema, meanAbsoluteError8Bit: z.number().nonnegative() }).strict()).length(3),
  verifiedAt: z.string(),
}).strict();
export const preparedSchema = z.object({
  profile: z.literal('h264-720p-bt709-gop15-v1'),
  width: z.number().int().positive(), height: z.number().int().positive(),
  thumbnailFrames: z.array(frameSchema).min(1),
  verification: proxyVerificationSchema,
}).strict();
export const mediaAssetSchema = z.object({
  id: idSchema, name: z.string(), sourcePath: z.string(),
  fingerprint: fingerprintSchema, metadata: metadataSchema,
  status: z.enum(['registered', 'queued', 'preparing', 'ready', 'error']),
  error: z.string().nullable(), prepared: preparedSchema.nullable(),
}).strict();
export const registrySchema = z.object({ version: z.literal(1), assets: z.array(mediaAssetSchema) }).strict();
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type SourceFingerprint = z.infer<typeof fingerprintSchema>;
export type VideoMetadata = z.infer<typeof metadataSchema>;
export type ProxyVerification = z.infer<typeof proxyVerificationSchema>;

export const jobSchema = z.object({
  id: idSchema, kind: z.enum(['prepare', 'reference', 'audio', 'export']), label: z.string(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  progress: z.number().min(0).max(1), message: z.string(),
  createdAt: z.string(), finishedAt: z.string().nullable(),
  outputUrl: z.string().nullable(), receiptUrl: z.string().nullable(),
}).strict();
export type MediaJob = z.infer<typeof jobSchema>;