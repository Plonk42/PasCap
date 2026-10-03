import { z } from 'zod';

export const MAX_FOOTAGE_FILES = 5_000;
export const MAX_FOOTAGE_ENTRIES = 2_000;

export function isVideoFilename(filename: string): boolean {
  return /\.(mp4|mov|m4v)$/i.test(filename);
}

const pathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), { message: 'Footage paths cannot contain NUL.' });
export const footageRootSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().min(1), path: pathSchema,
  available: z.boolean(), error: z.string().nullable(),
}).strict();
const footageEntrySchema = z.discriminatedUnion('kind', [
  z.object({ name: z.string().min(1), path: pathSchema, kind: z.literal('directory'), size: z.null() }).strict(),
  z.object({ name: z.string().min(1), path: pathSchema, kind: z.literal('video'), size: z.number().int().nonnegative() }).strict(),
]);
export const footageDirectorySchema = z.object({
  rootId: z.string().min(1).max(128), directory: pathSchema, parent: pathSchema.nullable(),
  entries: z.array(footageEntrySchema).max(MAX_FOOTAGE_ENTRIES),
  ignored: z.number().int().nonnegative(), truncated: z.boolean(), warnings: z.array(z.string()).max(20),
}).strict();
export type FootageRoot = z.infer<typeof footageRootSchema>;
export type FootageDirectory = z.infer<typeof footageDirectorySchema>;