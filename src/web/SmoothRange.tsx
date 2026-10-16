import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { MediaAsset, MediaJob } from '../shared/media.js';
import type { MediaSelection } from '../shared/media-selection.js';
import {
  motionProfile,
  smoothRanges,
  SMOOTH_TOLERANCE,
  type MotionAnalysis,
  type MotionProfile,
  type SmoothRange,
} from '../shared/motion-analysis.js';
import { formatTimecode } from '../shared/timing.js';
import { api, ApiError } from './api.js';
import { mediaReady, sourceSeconds } from './display.js';
import { Icon } from './icons.js';
import { readPreference, writePreference } from './preferences.js';

const TOLERANCE_PREFERENCE = 'pascap-smooth-tolerance';
const POLL_MS = 1000;
/** Chart scale: roughness in % of width per s²; camera motion is scaled to its own peak. */
const ROUGHNESS_MAX = 8;
const SPEED_FLOOR = 5;
const CHART_POINTS = 600;

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

function failure(cause: unknown): Phase {
  return { kind: 'error', message: cause instanceof Error ? cause.message : 'Cannot analyse this recording.' };
}

export interface SmoothRangeState {
  phase: Phase;
  profile: MotionProfile | null;
  ranges: readonly SmoothRange[];
  tolerance: number;
  setTolerance: (value: number) => void;
  find: () => void;
}

/** Smooth-part suggestions for one recording, from the analysis made when its proxy was prepared. */
export function useSmoothRange(asset: MediaAsset): SmoothRangeState {
  const ready = mediaReady(asset);
  const key = `${asset.id}/${asset.prepared?.verification.verifiedAt ?? ''}`;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [tolerance, setToleranceState] = useState(readTolerance);
  const controller = useRef<AbortController | null>(null);

  const start = useCallback((): AbortSignal => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    return abort.signal;
  }, []);
  const finish = useCallback(
    (analysis: MotionAnalysis): void => {
      known.set(key, analysis);
      setPhase({ kind: 'ready', analysis });
    },
    [key],
  );

  useEffect(() => {
    const cached = known.get(key);
    if (cached || !ready) {
      setPhase(cached ? { kind: 'ready', analysis: cached } : { kind: 'idle' });
      return () => controller.current?.abort();
    }
    const signal = start();
    setPhase({ kind: 'checking' });
    api
      .motion(asset.id, { signal })
      .then(({ analysis }) => (analysis ? finish(analysis) : setPhase({ kind: 'idle' })))
      .catch((cause: unknown) => {
        if (!signal.aborted) setPhase(failure(cause));
      });
    return () => controller.current?.abort();
  }, [key, ready]);

  // Recordings prepared before the analysis existed can still be measured on request.
  const find = useCallback(() => {
    const signal = start();
    const poll = async (id: string): Promise<MediaJob> => {
      await wait(POLL_MS, signal);
      const job = (await api.jobs({ signal })).jobs.find((candidate) => candidate.id === id);
      if (!job) throw new Error('The analysis job is no longer listed. Try again.');
      if (job.state !== 'queued' && job.state !== 'running') return job;
      setPhase({ kind: 'running', progress: job.progress });
      return poll(id);
    };
    const run = async (): Promise<void> => {
      const { job } = await api.analyseMotion(asset.id);
      if (signal.aborted) return;
      setPhase({ kind: 'running', progress: job.progress });
      const done = await poll(job.id);
      if (done.state === 'cancelled') return setPhase({ kind: 'idle' });
      if (done.state === 'failed') throw new Error(done.message);
      const { analysis } = await api.motion(asset.id, { signal });
      if (!analysis) throw new Error('The analysis finished but its result is missing. Try again.');
      finish(analysis);
    };
    run().catch((cause: unknown) => {
      if (!signal.aborted) setPhase(failure(cause));
    });
  }, [asset.id, finish, start]);

  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  const profile = useMemo(() => (phase.kind === 'ready' ? motionProfile(phase.analysis, fps) : null), [phase, fps]);
  const ranges = useMemo(
    () => (profile ? smoothRanges(profile.roughness, tolerance, fps) : []),
    [profile, tolerance, fps],
  );
  const setTolerance = useCallback((value: number) => {
    setToleranceState(value);
    writePreference(TOLERANCE_PREFERENCE, String(value));
  }, []);
  return { phase, profile, ranges, tolerance, setTolerance, find };
}

/** At most CHART_POINTS samples: the peak roughness and mean motion of each bucket. */
function chartPaths(profile: MotionProfile, count: number): { roughness: string; speed: string } {
  const step = Math.max(1, Math.ceil(count / CHART_POINTS));
  const speedMax = profile.speed.reduce((peak, value) => Math.max(peak, value), SPEED_FLOOR);
  const y = (value: number, max: number): string => (100 - (Math.min(value, max) / max) * 96).toFixed(1);
  const rough: string[] = [];
  const speed: string[] = [];
  for (let start = 0; start < count; start += step) {
    const end = Math.min(count, start + step);
    let peak = 0;
    let sum = 0;
    for (let frame = start; frame < end; frame++) {
      peak = Math.max(peak, profile.roughness[frame]!);
      sum += profile.speed[frame]!;
    }
    const x = ((start + end) / 2).toFixed(1);
    rough.push(`${x},${y(peak, ROUGHNESS_MAX)}`);
    speed.push(`${x},${y(sum / (end - start), speedMax)}`);
  }
  return { roughness: `M0,100 L${rough.join(' L')} L${count},100 Z`, speed: `M${speed.join(' L')}` };
}

interface TimelineProps {
  asset: MediaAsset;
  range: MediaSelection;
  smooth: SmoothRangeState;
  frame: number;
  disabled: boolean;
  onFrame: (frame: number) => void;
  onApply: (range: SmoothRange) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * One row aligned under the range strip: Use (under Play), image roughness and camera
 * motion along the whole recording, and the tolerance as a handle on its dashed line.
 */
export function MotionTimeline({
  asset,
  range,
  smooth,
  frame,
  disabled,
  onFrame,
  onApply,
  onKeyDown,
}: Readonly<TimelineProps>) {
  const { profile, ranges, tolerance } = smooth;
  const count = asset.metadata.frameCount;
  const rate = asset.metadata.frameRate;
  const paths = useMemo(() => (profile ? chartPaths(profile, count) : null), [profile, count]);
  const scrubbing = useRef<number | null>(null);
  if (!paths) return null;
  const best = ranges[0];
  const applied = best?.sourceIn === range.sourceIn && best?.sourceOut === range.sourceOut;
  const seekAt = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    onFrame(Math.min(count - 1, Math.floor(fraction * count)));
  };
  const toleranceY = 100 - (Math.min(tolerance, ROUGHNESS_MAX) / ROUGHNESS_MAX) * 96;
  const toleranceTop = 100 - (SMOOTH_TOLERANCE.max / ROUGHNESS_MAX) * 96;
  const toleranceBottom = 100 - (SMOOTH_TOLERANCE.min / ROUGHNESS_MAX) * 96;
  const label = best
    ? `Use smooth part ${formatTimecode(best.sourceIn, rate)} to ${formatTimecode(best.sourceOut, rate)}`
    : 'No smooth part to use';
  const span = best
    ? `${formatTimecode(best.sourceIn, rate)} – ${formatTimecode(best.sourceOut, rate)} · ${sourceSeconds(best.sourceOut - best.sourceIn)}`
    : '';
  let hint = 'No steady part of 2 s or more at this tolerance';
  if (best) hint = applied ? `In use: ${span}` : `Set IN and OUT to the smooth part ${span}`;
  return (
    <div className="source-track" data-smooth-in={best?.sourceIn} data-smooth-out={best?.sourceOut}>
      <button
        className="smooth-use-button"
        type="button"
        data-applied={applied || undefined}
        aria-label={label}
        title={hint}
        disabled={disabled || !best || applied}
        onKeyDown={onKeyDown}
        onClick={() => best && onApply(best)}
      >
        <Icon name={applied ? 'check' : 'wand'} size={15} />
        <span>{applied ? 'In use' : 'Use'}</span>
      </button>
      <div className="source-motion-lane">
        <div
          className="source-motion"
          data-disabled={disabled || undefined}
          title="Red: roughness, how fast the camera motion changes. Grey: camera motion. Blue: smooth parts below the dashed tolerance. Click or drag to scrub."
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            scrubbing.current = event.pointerId;
            seekAt(event);
          }}
          onPointerMove={(event) => {
            if (scrubbing.current === event.pointerId) seekAt(event);
          }}
          onPointerUp={() => {
            scrubbing.current = null;
          }}
          onLostPointerCapture={() => {
            scrubbing.current = null;
          }}
        >
          <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
            {ranges.map((smoothRange, index) => (
              <rect
                key={`${smoothRange.sourceIn}-${smoothRange.sourceOut}`}
                className={index ? 'source-motion-band alternative' : 'source-motion-band'}
                x={smoothRange.sourceIn}
                width={smoothRange.sourceOut - smoothRange.sourceIn}
                y={0}
                height={100}
              />
            ))}
            <path className="source-motion-roughness" d={paths.roughness} />
            <path className="source-motion-speed" d={paths.speed} />
            <line className="source-motion-tolerance" x1={0} x2={count} y1={toleranceY} y2={toleranceY} />
          </svg>
          <span className="source-motion-legend" aria-hidden="true">
            <i className="roughness" />
            <span>Roughness</span>
            <i className="speed" />
            <span>Camera motion</span>
          </span>
          <span className="source-motion-summary">{best ? `Smooth ${span}` : 'No steady part of 2 s or more'}</span>
          <span
            className="source-motion-head"
            style={{ left: `${count === 1 ? 0 : (frame / (count - 1)) * 100}%` }}
            aria-hidden="true"
          />
        </div>
        {/* Vertical, spanning exactly the tolerance values of the dashed line it moves. */}
        <input
          className="source-motion-tolerance-input"
          type="range"
          aria-label="Smooth part tolerance"
          aria-valuetext={`${tolerance.toFixed(1)}: ${tolerance < SMOOTH_TOLERANCE.initial ? 'stricter' : 'more tolerant'}`}
          title="Tolerance: drag the dashed line up to accept more camera movement, down for only very steady footage"
          min={SMOOTH_TOLERANCE.min}
          max={SMOOTH_TOLERANCE.max}
          step={SMOOTH_TOLERANCE.step}
          value={tolerance}
          style={{ top: `${toleranceTop}%`, height: `${toleranceBottom - toleranceTop}%` }}
          onKeyDown={onKeyDown}
          onChange={(event) => smooth.setTolerance(Number(event.target.value))}
        />
      </div>
    </div>
  );
}

interface StatusProps {
  smooth: SmoothRangeState;
  disabled: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Recordings without an analysis yet: measure one on request, with its progress. */
export function SmoothRangeStatus({ smooth, disabled, onKeyDown }: Readonly<StatusProps>) {
  const { phase } = smooth;
  if (phase.kind === 'running')
    return (
      <output className="smooth-range-row">
        <span className="spinner" />
        Measuring camera motion… {Math.round(phase.progress * 100)} %
      </output>
    );
  if (phase.kind !== 'idle' && phase.kind !== 'error') return null;
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
}
