import type { z } from 'zod';
import { described } from '../described.js';
import { frameSchema } from '../model.js';

/** The saved revision a read used, so a result read before or during an edit can be recognized. */
export const revisionReadSchema = described(
  frameSchema,
  'Saved revision this result was read from; older than your last edit means it is stale, so read again.',
);

/** Who can call an operation: the editor through HTTP, the assistant through MCP. */
export type OperationAudience = 'editor' | 'assistant';

/**
 * One service capability. The HTTP route, the typed web client, the catalog and later the
 * MCP tool are generated from it; the server pairs it with its `run` implementation.
 */
export interface OperationSpec<
  N extends string = string,
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  /** snake_case; the route segment and the MCP tool name. */
  name: N;
  /** Written for an LLM: when to use it and what it returns. */
  description: string;
  input: I;
  output: O;
  /** Write operations change a saved project and bump its revision. */
  access: 'read' | 'write';
  audience: readonly OperationAudience[];
}

export function defineOperation<const N extends string, I extends z.ZodType, O extends z.ZodType>(
  spec: OperationSpec<N, I, O>,
): OperationSpec<N, I, O> {
  return spec;
}
