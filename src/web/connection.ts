import { whileSerial } from '../shared/serial.js';
import { api, ApiError, type ServiceHealth } from './api.js';

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;
const ATTEMPT_TIMEOUT_MS = 5_000;

function cancelled(): ApiError { return new ApiError('Connecting to the local PasCap service was cancelled.', 0, 'aborted'); }

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const onAbort = (): void => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(cancelled());
    };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** At most five health GETs (32.5s total). Never retries writes or an incompatible response. */
export async function waitForService(signal: AbortSignal, onAttempt?: (attempt: number, maxAttempts: number) => void): Promise<ServiceHealth> {
  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  let attempt = 0;
  let health: ServiceHealth | null = null;
  await whileSerial(() => attempt < maxAttempts && health === null, async () => {
    attempt++;
    if (signal.aborted) throw cancelled();
    onAttempt?.(attempt, maxAttempts);
    try { health = await api.health({ signal, timeoutMs: ATTEMPT_TIMEOUT_MS }); }
    catch (error: unknown) {
      if (!(error instanceof ApiError) || !error.retryable || attempt === maxAttempts) throw error;
      // Startup attempts and backoff are deliberately serial and abortable.
      await delay(RETRY_DELAYS_MS[attempt - 1]!, signal);
    }
  });
  if (health !== null) return health;
  throw new ApiError('The local PasCap service is unavailable. Start it and retry connecting.', 0, 'network');
}
