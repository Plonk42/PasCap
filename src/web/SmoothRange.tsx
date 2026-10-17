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
  type FlightSpeedSample,
  type MotionAnalysis,
  type MotionProfile,
  type SmoothRange,
} from '../shared/motion-analysis.js';
import { formatTimecode, type FrameRate } from '../shared/timing.js';
import { api, ApiError } from './api.js';
import { mediaReady, sourceSeconds } from './display.js';
import { Icon } from './icons.js';
import { readPreference, writePreference } from './preferences.js';

const TOLERANCE_PREFERENCE = 'pascap-smooth-tolerance';
const POLL_MS = 1000;
/** Chart scales: roughness in % of width per s²; camera motion is scaled to its own peak. */
const ROUGHNESS_MAX = 8;
const MOTION_FLOOR = 5;
/** m/s: about the top speed of small DJI drones, so recordings compare at a glance. */
const FLIGHT_SPEED_SCALE = 16;
const CHART_POINTS = 600;
/** The top of the plotted area in the 0–100 viewBox, leaving room for one line of text. */
const PLOT_TOP = 30;
const LINE_GRAB_PX = 6;
const THUMB_PX = 14;

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'running'; progress: number }
  | { kind: 'ready'; analysis: MotionAnalysis }
  | { kind: 'error'; message: string };

/** Analyses already fetched this session, per verified proxy. */
const known = new Map<string, MotionAnalysis>();
const NO_FLIGHT_SPEED: readonly FlightSpeedSample[] = [];

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
  flightSpeed: readonly FlightSpeedSample[];
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
  const [tolerance, setTolerance] = useState(readTolerance);
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
  const keepTolerance = useCallback((value: number) => {
    setTolerance(value);
    writePreference(TOLERANCE_PREFERENCE, String(value));
  }, []);
  const flightSpeed = phase.kind === 'ready' ? phase.analysis.flightSpeed : NO_FLIGHT_SPEED;
  return { phase, profile, flightSpeed, ranges, tolerance, setTolerance: keepTolerance, find };
}

interface ChartPaths {
  roughness: string;
  motion: string;
  flight: string;
  motionMax: number;
  flightMax: number;
}

/** Plot height in the 0–100 viewBox; the band above it holds the legend and summary text. */
function plotY(value: number, max: number): number {
  return 100 - (Math.min(value, max) / max) * (100 - PLOT_TOP);
}

/** At most CHART_POINTS samples: the peak roughness and mean motion of each bucket. */
function chartPaths(
  profile: MotionProfile,
  flightSpeed: readonly FlightSpeedSample[],
  count: number,
  fps: number,
): ChartPaths {
  const step = Math.max(1, Math.ceil(count / CHART_POINTS));
  const motionMax = profile.speed.reduce((peak, value) => Math.max(peak, value), MOTION_FLOOR);
  const flightMax = flightSpeed.reduce((peak, sample) => Math.max(peak, sample.value), FLIGHT_SPEED_SCALE);
  const rough: string[] = [];
  const motion: string[] = [];
  for (let start = 0; start < count; start += step) {
    const end = Math.min(count, start + step);
    let peak = 0;
    let sum = 0;
    for (let frame = start; frame < end; frame++) {
      peak = Math.max(peak, profile.roughness[frame]!);
      sum += profile.speed[frame]!;
    }
    const x = ((start + end) / 2).toFixed(1);
    rough.push(`${x},${plotY(peak, ROUGHNESS_MAX).toFixed(1)}`);
    motion.push(`${x},${plotY(sum / (end - start), motionMax).toFixed(1)}`);
  }
  const flight = flightSpeed
    .filter((sample) => sample.time * fps <= count)
    .map((sample) => `${(sample.time * fps).toFixed(1)},${plotY(sample.value, flightMax).toFixed(1)}`);
  // Each sample stands for the second that follows it.
  const last = flightSpeed.at(-1);
  if (last && last.time * fps < count)
    flight.push(`${Math.min(count, (last.time + 1) * fps).toFixed(1)},${plotY(last.value, flightMax).toFixed(1)}`);
  return {
    roughness: `M0,100 L${rough.join(' L')} L${count},100 Z`,
    motion: `M${motion.join(' L')}`,
    flight: flight.length > 1 ? `M${flight.join(' L')}` : '',
    motionMax,
    flightMax,
  };
}

/** Linear between the recorded samples; null outside them. */
function flightSpeedAt(samples: readonly FlightSpeedSample[], seconds: number): number | null {
  const next = samples.findIndex((sample) => sample.time > seconds);
  const last = samples.at(-1);
  if (next === -1) return last && seconds - last.time <= 1 ? last.value : null;
  if (next === 0) return null;
  const a = samples[next - 1]!;
  const b = samples[next]!;
  return a.value + ((b.value - a.value) * (seconds - a.time)) / (b.time - a.time);
}

interface ReadoutProps {
  asset: MediaAsset;
  profile: MotionProfile;
  flightSpeed: readonly FlightSpeedSample[];
  hover: number | null;
  /** Shown instead of the values while the dashed line is hovered or dragged. */
  tolerance: number | null;
}

/** The legend, or the values under the pointer, above the plotted lines. */
function MotionReadout({ asset, profile, flightSpeed, hover, tolerance }: Readonly<ReadoutProps>) {
  const rate = asset.metadata.frameRate;
  let content = (
    <>
      <span className="roughness">Roughness</span>
      <span className="motion">Camera motion</span>
      {flightSpeed.length > 0 && <span className="flight">Flight speed</span>}
    </>
  );
  if (tolerance !== null) {
    content = <span className="tolerance">Tolerance {tolerance.toFixed(1)} · drag up to accept more movement</span>;
  } else if (hover !== null) {
    const flight = flightSpeedAt(flightSpeed, (hover * rate.denominator) / rate.numerator);
    content = (
      <>
        <b>{formatTimecode(hover, rate)}</b>
        <span className="roughness">Roughness {profile.roughness[hover]!.toFixed(1)}</span>
        <span className="motion">Camera {profile.speed[hover]!.toFixed(1)} %/s</span>
        {flight !== null && <span className="flight">Flight {flight.toFixed(1)} m/s</span>}
      </>
    );
  }
  return (
    <span className="source-motion-readout" aria-hidden="true">
      {content}
    </span>
  );
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

type Drag = { kind: 'scrub' | 'tolerance'; pointer: number };

/** The tolerance whose dashed line sits at y (0–100 from the top), on the slider's steps. */
function toleranceAt(y: number): number {
  const value = ((100 - y) / (100 - PLOT_TOP)) * ROUGHNESS_MAX;
  const stepped = Math.round(value / SMOOTH_TOLERANCE.step) * SMOOTH_TOLERANCE.step;
  return Number(Math.max(SMOOTH_TOLERANCE.min, Math.min(SMOOTH_TOLERANCE.max, stepped)).toFixed(1));
}

function suggestionText(best: SmoothRange | undefined, applied: boolean, rate: FrameRate) {
  if (!best)
    return { span: '', label: 'No smooth part to use', hint: 'No steady part of 2 s or more at this tolerance' };
  const from = formatTimecode(best.sourceIn, rate);
  const to = formatTimecode(best.sourceOut, rate);
  const span = `${from} – ${to} · ${sourceSeconds(best.sourceOut - best.sourceIn)}`;
  return {
    span,
    label: `Use smooth part ${from} to ${to}`,
    hint: applied ? `In use: ${span}` : `Set IN and OUT to the smooth part ${span}`,
  };
}

/**
 * One row aligned under the range strip: Use (under Play), image roughness, camera motion and
 * recorded flight speed along the whole recording, and the tolerance as a draggable dashed line.
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
  const { profile, flightSpeed, ranges, tolerance, setTolerance } = smooth;
  const count = asset.metadata.frameCount;
  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  const paths = useMemo(
    () => (profile ? chartPaths(profile, flightSpeed, count, fps) : null),
    [profile, flightSpeed, count, fps],
  );
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [nearLine, setNearLine] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  if (!paths || !profile) return null;
  const best = ranges[0];
  const applied = best?.sourceIn === range.sourceIn && best?.sourceOut === range.sourceOut;
  const toleranceY = plotY(tolerance, ROUGHNESS_MAX);
  const toleranceTop = plotY(SMOOTH_TOLERANCE.max, ROUGHNESS_MAX);
  const toleranceBottom = plotY(SMOOTH_TOLERANCE.min, ROUGHNESS_MAX);
  const position = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const y = ((event.clientY - box.top) / box.height) * 100;
    return {
      frame: Math.min(count - 1, Math.floor(x * count)),
      y,
      onLine: Math.abs(((y - toleranceY) / 100) * box.height) <= LINE_GRAB_PX,
    };
  };
  const end = (): void => {
    drag.current = null;
    setAdjusting(false);
  };
  const { span, label, hint } = suggestionText(best, applied, rate);
  const hasFlight = paths.flight !== '';

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
          data-near-tolerance={(nearLine && !disabled) || adjusting || undefined}
          title={`Red: roughness, how fast the camera motion changes (dashed: tolerance, drag it). Grey: camera motion in the picture.${hasFlight ? ' Yellow: flight speed recorded by the drone.' : ''} Blue: smooth parts. Click or drag to scrub.`}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            const at = position(event);
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { kind: at.onLine ? 'tolerance' : 'scrub', pointer: event.pointerId };
            if (at.onLine) setAdjusting(true);
            else onFrame(at.frame);
          }}
          onPointerMove={(event) => {
            const at = position(event);
            const current = drag.current;
            if (current?.pointer === event.pointerId && current.kind === 'tolerance') {
              setTolerance(toleranceAt(at.y));
              return;
            }
            setHover(at.frame);
            setNearLine(at.onLine);
            if (current?.pointer === event.pointerId) onFrame(at.frame);
          }}
          onPointerLeave={() => {
            setHover(null);
            setNearLine(false);
          }}
          onPointerUp={end}
          onLostPointerCapture={end}
        >
          <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
            {ranges.map((smoothRange, index) => (
              <rect
                key={`${smoothRange.sourceIn}-${smoothRange.sourceOut}`}
                className={index ? 'source-motion-band alternative' : 'source-motion-band'}
                x={smoothRange.sourceIn}
                width={smoothRange.sourceOut - smoothRange.sourceIn}
                y={PLOT_TOP}
                height={100 - PLOT_TOP}
              />
            ))}
            <path className="source-motion-roughness" d={paths.roughness} />
            <path className="source-motion-speed" d={paths.motion} />
            {hasFlight && <path className="source-motion-flight" d={paths.flight} />}
            <line className="source-motion-tolerance" x1={0} x2={count} y1={toleranceY} y2={toleranceY} />
          </svg>
          <MotionReadout
            asset={asset}
            profile={profile}
            flightSpeed={hasFlight ? flightSpeed : []}
            hover={hover}
            tolerance={adjusting || (nearLine && drag.current === null) ? tolerance : null}
          />
          <span className="source-motion-summary">{best ? `Smooth ${span}` : 'No steady part of 2 s or more'}</span>
          {hover !== null && !nearLine && !adjusting && (
            <span
              className="source-motion-cursor"
              style={{ left: `${count === 1 ? 0 : (hover / (count - 1)) * 100}%` }}
              aria-hidden="true"
            />
          )}
          <span
            className="source-motion-head"
            style={{ left: `${count === 1 ? 0 : (frame / (count - 1)) * 100}%` }}
            aria-hidden="true"
          />
        </div>
        {/* The thumb centre travels exactly over the tolerance values of the dashed line. */}
        <input
          className="source-motion-tolerance-input"
          type="range"
          aria-label="Smooth part tolerance"
          aria-valuetext={`${tolerance.toFixed(1)}: ${tolerance < SMOOTH_TOLERANCE.initial ? 'stricter' : 'more tolerant'}`}
          title={`Tolerance ${tolerance.toFixed(1)}: drag up to accept more camera movement, down for only very steady footage`}
          min={SMOOTH_TOLERANCE.min}
          max={SMOOTH_TOLERANCE.max}
          step={SMOOTH_TOLERANCE.step}
          value={tolerance}
          disabled={disabled}
          style={{
            top: `calc(${toleranceTop}% - ${THUMB_PX / 2}px)`,
            height: `calc(${toleranceBottom - toleranceTop}% + ${THUMB_PX}px)`,
          }}
          onKeyDown={onKeyDown}
          onChange={(event) => setTolerance(Number(event.target.value))}
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
