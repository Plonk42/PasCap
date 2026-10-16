import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { MediaAsset, MediaJob } from '../shared/media.js';
import type { MediaSelection } from '../shared/media-selection.js';
import {
  motionRoughness,
  smoothRanges,
  SMOOTH_TOLERANCE,
  type MotionAnalysis,
  type SmoothRange,
} from '../shared/motion-analysis.js';
import { formatTimecode } from '../shared/timing.js';
import { api, ApiError } from './api.js';
import { sourceSeconds } from './display.js';
import { readPreference, writePreference } from './preferences.js';

const TOLERANCE_PREFERENCE = 'pascap-smooth-tolerance';
const POLL_MS = 1000;

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'running'; progress: number }
  | { kind: 'ready'; analysis: MotionAnalysis }
  | { kind: 'error'; message: string };

/** Analyses already fetched this session, per verified proxy. */
const known = new Map<string, MotionAnalysis>();

function readTolerance(): number {
  const value = Number(readPreference(TOLERANCE_PREFERENCE));
  return value >= SMOOTH_TOLERANCE.min && value <= SMOOTH_TOLERANCE.max ? value : SMOOTH_TOLERANCE.initial;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ApiError('Request cancelled.', 0, 'aborted'));
      },
      { once: true },
    );
  });
}

export interface SmoothRangeState {
  phase: Phase;
  ranges: readonly SmoothRange[];
  tolerance: number;
  setTolerance: (value: number) => void;
  find: () => void;
}

/** Smooth-part suggestions for one recording; analysis runs only when asked. */
export function useSmoothRange(asset: MediaAsset): SmoothRangeState {
  const key = `${asset.id}/${asset.prepared?.verification.verifiedAt ?? ''}`;
  const initial = (): Phase => {
    const analysis = known.get(key);
    return analysis ? { kind: 'ready', analysis } : { kind: 'idle' };
  };
  const [phase, setPhase] = useState<Phase>(initial);
  const [tolerance, setToleranceState] = useState(readTolerance);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    setPhase(initial());
    return () => controller.current?.abort();
  }, [key]);

  const find = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const { signal } = abort;
    const finish = (analysis: MotionAnalysis | null): void => {
      if (!analysis) throw new Error('The analysis finished but its result is missing. Try again.');
      known.set(key, analysis);
      setPhase({ kind: 'ready', analysis });
    };
    const poll = async (id: string): Promise<MediaJob> => {
      await wait(POLL_MS, signal);
      const job = (await api.jobs({ signal })).jobs.find((candidate) => candidate.id === id);
      if (!job) throw new Error('The analysis job is no longer listed. Try again.');
      if (job.state !== 'queued' && job.state !== 'running') return job;
      setPhase({ kind: 'running', progress: job.progress });
      return poll(id);
    };
    const run = async (): Promise<void> => {
      setPhase({ kind: 'checking' });
      const cached = (await api.motion(asset.id, { signal })).analysis;
      if (cached) return finish(cached);
      const { job } = await api.analyseMotion(asset.id);
      if (signal.aborted) return;
      setPhase({ kind: 'running', progress: job.progress });
      const done = await poll(job.id);
      if (done.state === 'cancelled') return setPhase({ kind: 'idle' });
      if (done.state === 'failed') throw new Error(done.message);
      finish((await api.motion(asset.id, { signal })).analysis);
    };
    run().catch((cause: unknown) => {
      if (signal.aborted) return;
      setPhase({ kind: 'error', message: cause instanceof Error ? cause.message : 'Cannot analyse this recording.' });
    });
  }, [asset.id, key]);

  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  const roughness = useMemo(() => (phase.kind === 'ready' ? motionRoughness(phase.analysis, fps) : null), [phase, fps]);
  const ranges = useMemo(() => (roughness ? smoothRanges(roughness, tolerance, fps) : []), [roughness, tolerance, fps]);
  const setTolerance = useCallback((value: number) => {
    setToleranceState(value);
    writePreference(TOLERANCE_PREFERENCE, String(value));
  }, []);
  return { phase, ranges, tolerance, setTolerance, find };
}

interface RowProps {
  asset: MediaAsset;
  range: MediaSelection;
  smooth: SmoothRangeState;
  disabled: boolean;
  onApply: (range: SmoothRange) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Below the source range strip: find, show and apply the steadiest part of the recording. */
export function SmoothRangeRow({ asset, range, smooth, disabled, onApply, onKeyDown }: Readonly<RowProps>) {
  const { phase, ranges, tolerance } = smooth;
  const rate = asset.metadata.frameRate;
  const best = ranges[0];
  if (phase.kind === 'idle' || phase.kind === 'error')
    return (
      <div className="smooth-range-row">
        <button
          className="secondary-button small"
          type="button"
          title="Measure the camera motion of this recording (a background job) and suggest its steadiest part"
          disabled={disabled}
          onKeyDown={onKeyDown}
          onClick={smooth.find}
        >
          {phase.kind === 'error' ? 'Retry finding the smooth part' : 'Find smooth part'}
        </button>
        {phase.kind === 'error' && (
          <span className="smooth-range-error" role="alert">
            {phase.message}
          </span>
        )}
      </div>
    );
  if (phase.kind !== 'ready')
    return (
      <output className="smooth-range-row">
        <span className="spinner" />
        {phase.kind === 'running'
          ? `Measuring camera motion… ${Math.round(phase.progress * 100)} %`
          : 'Looking for an earlier analysis…'}
      </output>
    );
  const applied = best?.sourceIn === range.sourceIn && best?.sourceOut === range.sourceOut;
  return (
    <div className="smooth-range-row" data-smooth-in={best?.sourceIn} data-smooth-out={best?.sourceOut}>
      <span className="smooth-range-swatch" aria-hidden="true" />
      {best ? (
        <>
          <span>
            Smooth part{' '}
            <strong>
              {formatTimecode(best.sourceIn, rate)} – {formatTimecode(best.sourceOut, rate)}
            </strong>{' '}
            · {sourceSeconds(best.sourceOut - best.sourceIn)}
            {ranges.length > 1 && ` · ${ranges.length - 1} more`}
          </span>
          <button
            className="secondary-button small"
            type="button"
            aria-label={`Use smooth part ${formatTimecode(best.sourceIn, rate)} to ${formatTimecode(best.sourceOut, rate)}`}
            title="Set IN and OUT to the suggested smooth part"
            disabled={disabled || applied}
            onKeyDown={onKeyDown}
            onClick={() => onApply(best)}
          >
            {applied ? 'In use' : 'Use'}
          </button>
        </>
      ) : (
        <span>No steady part of 2 s or more at this tolerance</span>
      )}
      <label
        className="smooth-range-tolerance"
        title="Lower suggests only very steady footage; higher tolerates more camera movement"
      >
        <span>Tolerance</span>
        <input
          type="range"
          aria-label="Smooth part tolerance"
          min={SMOOTH_TOLERANCE.min}
          max={SMOOTH_TOLERANCE.max}
          step={SMOOTH_TOLERANCE.step}
          value={tolerance}
          onKeyDown={onKeyDown}
          onChange={(event) => smooth.setTolerance(Number(event.target.value))}
        />
      </label>
    </div>
  );
}
