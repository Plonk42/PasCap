import type { z } from 'zod';

/** Attaches a description for the assistant's JSON Schema; validation is unchanged. */
export function described<S extends z.ZodType>(schema: S, description: string): S {
  return schema.meta({ description });
}
