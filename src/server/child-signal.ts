import type { ChildProcess } from 'node:child_process';

/** Node sends kill() of a child whose spawn failed to process 0, the caller's own process group (#263). */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) child.kill(signal);
}
