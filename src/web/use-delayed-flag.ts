import { useEffect, useState } from 'react';

/** Waiting indicators shown only once `active` has stayed true for `delayMs`, so fast seeks do not blink. */
export const WAITING_INDICATOR_DELAY_MS = 250;

export function useDelayedFlag(active: boolean, delayMs = WAITING_INDICATOR_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    setElapsed(false);
    if (!active) return;
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}
