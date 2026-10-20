import { useEffect, useState } from 'react';

/** Waiting indicators shown only once `active` has stayed true for `delayMs`, so fast seeks do not blink. */
export const WAITING_INDICATOR_DELAY_MS = 250;

/** A new `progress` value (such as each newly displayed frame) restarts the wait. */
export function useDelayedFlag(active: boolean, delayMs = WAITING_INDICATOR_DELAY_MS, progress?: unknown): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    setElapsed(false);
    if (!active) return;
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs, progress]);
  return active && elapsed;
}

/**
 * While `moving`, the value last held unchanged for `restMs` (initially the value when moving began);
 * otherwise the current value. Consumers then render once per pause rather than on every change.
 */
export function useRestingValue<T>(value: T, moving: boolean, restMs: number): T {
  const [rested, setRested] = useState(value);
  const [wasMoving, setWasMoving] = useState(moving);
  if (moving !== wasMoving) {
    setWasMoving(moving);
    if (moving) setRested(() => value);
  }
  useEffect(() => {
    if (!moving) return;
    const timer = window.setTimeout(() => setRested(() => value), restMs);
    return () => window.clearTimeout(timer);
  }, [value, moving, restMs]);
  return moving ? rested : value;
}
