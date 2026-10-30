import { useEffect, useMemo, useState } from 'react';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument, SelectRange } from '../shared/model.js';
import { bestSteadyRange } from '../shared/recording-shots.js';
import { forEachSerial } from '../shared/serial.js';
import { api } from './api.js';
import { mediaReady } from './display.js';
import { knownMotion, motionKey, rememberMotion, useSteadyLimits } from './SmoothRange.js';

const POLL_MS = 2000;

type Lookup = 'read' | 'pending' | 'missing' | 'failed';

export interface BestRangeChange {
  mediaId: string;
  range: SelectRange;
  /** How many kept ranges it replaces. */
  replaced: number;
}

export interface BestRangesPlan {
  changes: BestRangeChange[];
  /** Recordings whose only kept range already is their best steady range. */
  unchanged: number;
  skipped: { name: string; reason: string }[];
  /** Some selected recordings' camera motion is still being read. */
  loading: boolean;
}

function skipReason(asset: MediaAsset, lookup: Lookup | undefined): string | null {
  if (asset.status === 'queued' || asset.status === 'preparing') return 'still being prepared';
  if (!mediaReady(asset)) return 'not prepared';
  if (lookup === 'pending') return 'camera motion still being analyzed';
  if (lookup === 'missing') return 'camera motion not analyzed';
  if (lookup === 'failed') return 'camera motion could not be read';
  return null;
}

/**
 * What keeping the best steady range of each recording would change: the range Use best keeps
 * within the current Maximum jolts, Movement and Flight speed, replacing every kept range of the recording.
 */
export function useBestRanges(
  assets: readonly MediaAsset[],
  selects: ProjectDocument['selects'] | undefined,
): BestRangesPlan {
  const [limits] = useSteadyLimits();
  const [lookups, setLookups] = useState<ReadonlyMap<string, Lookup>>(new Map());
  const [poll, setPoll] = useState(0);
  const readyKey = assets
    .filter(mediaReady)
    .map((asset) => motionKey(asset))
    .join('|');

  useEffect(() => {
    const unread = assets.filter((asset) => mediaReady(asset) && !knownMotion(asset));
    if (!unread.length) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const settle = (asset: MediaAsset, lookup: Lookup): void => {
      pending ||= lookup === 'pending';
      setLookups((previous) => new Map(previous).set(motionKey(asset), lookup));
    };
    void forEachSerial(unread, async (asset) => {
      if (abort.signal.aborted) return;
      try {
        const { analysis, job } = await api.motion(asset.id, { signal: abort.signal });
        if (analysis) rememberMotion(asset, analysis);
        if (analysis) settle(asset, 'read');
        else settle(asset, job && ['queued', 'running'].includes(job.state) ? 'pending' : 'missing');
      } catch {
        if (!abort.signal.aborted) settle(asset, 'failed');
      }
    }).then(() => {
      if (pending && !abort.signal.aborted) timer = setTimeout(() => setPoll((count) => count + 1), POLL_MS);
    });
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [readyKey, poll]);

  return useMemo(() => {
    const plan: BestRangesPlan = { changes: [], unchanged: 0, skipped: [], loading: false };
    for (const asset of assets) {
      const analysis = mediaReady(asset) ? knownMotion(asset) : undefined;
      const lookup = lookups.get(motionKey(asset));
      if (!analysis && mediaReady(asset) && !lookup) {
        plan.loading = true;
        continue;
      }
      const reason = analysis ? null : skipReason(asset, lookup);
      const rate = asset.metadata.frameRate;
      const best = analysis && bestSteadyRange(analysis, asset.damage, limits, rate.numerator / rate.denominator);
      if (!best) {
        plan.skipped.push({ name: asset.name, reason: reason ?? 'no steady range of 2 s or more' });
        continue;
      }
      const kept = selects?.[asset.id] ?? [];
      const range = { sourceIn: best.sourceIn, sourceOut: best.sourceOut };
      if (kept.length === 1 && kept[0]!.sourceIn === range.sourceIn && kept[0]!.sourceOut === range.sourceOut)
        plan.unchanged++;
      else plan.changes.push({ mediaId: asset.id, range, replaced: kept.length });
    }
    return plan;
    // The analyses come from the session cache, which `lookups` follows.
  }, [assets, lookups, selects, limits]);
}

export function recordingCount(count: number): string {
  return `${count} ${count === 1 ? 'recording' : 'recordings'}`;
}

/** How many selected recordings would lose kept ranges they have. */
export function replacingCount(plan: BestRangesPlan): number {
  return plan.changes.filter((change) => change.replaced > 0).length;
}

function skippedText(plan: BestRangesPlan): string {
  return plan.skipped.map(({ name, reason }) => `${name} (${reason})`).join(', ');
}

/** Why the action cannot change anything, or null when it can. */
export function bestRangesUnavailable(plan: BestRangesPlan): string | null {
  if (plan.loading) return 'Reading the camera motion of the selected recordings…';
  if (plan.changes.length) return null;
  if (!plan.skipped.length)
    return plan.unchanged === 1
      ? 'Its only kept range already is its best steady range'
      : 'Their only kept ranges already are their best steady ranges';
  return `No best steady range to keep: ${skippedText(plan)}`;
}

export function bestRangesHint(plan: BestRangesPlan): string {
  const replacing = replacingCount(plan);
  const replaced = replacing ? `, replacing the kept ranges of ${recordingCount(replacing)}` : '';
  const skipped = plan.skipped.length ? `. Skipped: ${skippedText(plan)}` : '';
  const count = plan.changes.length;
  return `Keep the best steady range of ${recordingCount(count)} as ${count === 1 ? 'its' : 'their'} only kept range${replaced}; adds nothing to the timeline${skipped}`;
}

export function bestRangesReport(plan: BestRangesPlan): string {
  const skipped = plan.skipped.length ? ` Skipped: ${skippedText(plan)}.` : '';
  return `Kept the best steady range of ${recordingCount(plan.changes.length)}.${skipped}`;
}
