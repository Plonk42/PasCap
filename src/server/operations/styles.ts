import type { listStyles } from '../../shared/operations/styles.js';
import { styleSummary } from '../../shared/styles.js';
import type { OperationRunner } from './context.js';

export const runListStyles: OperationRunner<typeof listStyles> = async ({ styles }) => ({
  styles: (await styles.list()).map(styleSummary),
});
