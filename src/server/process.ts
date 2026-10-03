import { spawn } from 'node:child_process';
import { ServiceError } from './errors.js';

interface ProcessOptions {
  signal?: AbortSignal;
  cwd?: string;
  onProgress?: (fields: Record<string, string>) => void;
  maxBytes?: number;
}

/** No shell, bounded output, cancellable child process. All arguments remain separate. */
export function runProcess(binary: string, args: string[], options: ProcessOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new ServiceError('Job cancelled.', 499)); return; }
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}) });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let pending = '';
    let overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 32 * 1024 * 1024)) { overflow = true; cancel(); return; }
      if (!options.onProgress) { chunks.push(chunk); return; }
      pending += chunk.toString('utf8');
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        const equals = line.indexOf('=');
        if (equals >= 0) options.onProgress({ [line.slice(0, equals)]: line.slice(equals + 1) });
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_768); });
    const cleanUp = (): void => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', cancel);
    };
    child.once('error', (error) => { cleanUp(); reject(new ServiceError(`Cannot start ${binary}: ${error.message}`, 503)); });
    child.once('close', (code) => {
      cleanUp();
      if (options.signal?.aborted) reject(new ServiceError('Job cancelled.', 499));
      else if (overflow) reject(new ServiceError(`${binary} exceeded its output limit.`, 500));
      else if (code !== 0) reject(new ServiceError(`${binary} exited ${code}: ${stderr.trim()}`, 422));
      else resolve(Buffer.concat(chunks));
    });
  });
}