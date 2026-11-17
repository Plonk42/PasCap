import { z } from 'zod';
import { fingerprintSchema } from './media.js';
import { idSchema } from './model.js';

/** Registered still images (JPEG, PNG), read in place: Color → Match can take one as its reference. */
export const MAX_IMAGES = 10_000;
export const IMAGE_FORMATS = ['jpeg', 'png'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const imageAssetSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    sourcePath: z.string().min(1).max(4096),
    format: z.enum(IMAGE_FORMATS),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fingerprint: fingerprintSchema,
    registeredAt: z.string(),
  })
  .strict();
export type ImageAsset = z.infer<typeof imageAssetSchema>;

/** `images.json`, beside the video and music registries. */
export const imagesFileSchema = z
  .object({
    version: z.literal(1),
    images: z.array(imageAssetSchema).max(MAX_IMAGES),
  })
  .strict();

export const imageRegistrationSchema = z
  .object({
    images: z.array(imageAssetSchema),
    errors: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
  })
  .strict();
export type ImageRegistration = z.infer<typeof imageRegistrationSchema>;

export const IMAGE_MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png' };

/** The original as the editor reads it; its digest makes a changed original a new URL. */
export function imageFileUrl(image: Pick<ImageAsset, 'id' | 'fingerprint'>): string {
  return `/api/images/${encodeURIComponent(image.id)}/file?v=${image.fingerprint.digest.slice(0, 16)}`;
}
