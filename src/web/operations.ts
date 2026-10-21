import type { z } from 'zod';
import {
  operationNamed,
  type OperationInput,
  type OperationName,
  type OperationOutput,
} from '../shared/operations/index.js';
import { request, type RequestOptions } from './api.js';

/** Calls a service operation with its typed input; the response is validated against its output schema. */
export function callOperation<N extends OperationName>(
  name: N,
  input: OperationInput<N>,
  options: RequestOptions = {},
): Promise<OperationOutput<N>> {
  const operation = operationNamed(name);
  // TypeScript cannot narrow the generic operation's schema to its own output type.
  const output = operation.output as unknown as z.ZodType<OperationOutput<N>>;
  return request(`/api/ops/${name}`, output, 'POST', input, {
    readOnly: operation.access === 'read',
    ...options,
  });
}
