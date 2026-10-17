import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
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
  type TelemetrySample,
} from '../shared/motion-analysis.js';
import { formatTimecode, type FrameRate } from '../shared/timing.js';
import { api, ApiError } from './api.js';
import { mediaReady, sourceSeconds } from './display.js';
import { Icon } from './icons.js';
import {
  availableSeries,
  cameraMotionPath,
  DEFAULT_SERIES,
  SERIES,
  seriesPath,
  seriesValue,
  type SeriesKey,
  type SeriesSpec,
} from './motion-series.js';
import { Popover } from './Popover.js';
import { readPreference, writePreference } from './preferences.js';

const TOLERANCE_PREFERENCE = 'pascap-smooth-tolerance';
const COLLAPSED_PREFERENCE = 'pascap-smooth-panel-collapsed';
const SERIES_PREFERENCE = 'pascap-motion-timeline-series';
const POLL_MS = 1000;
/** Roughness scale in % of image width per s². */
const ROUGHNESS_MAX = 8;
const CHART_POINTS = 600;
/** Image lane height in pixels; telemetry lanes are sized in CSS. */
const IMAGE_PX = 44;
/** Of the image lane's 0–100 viewBox, the part under its text line. */
const PLOT_SPAN = 72;
const LINE_GRAB_PX = 6;

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'running'; progress: number }
  | { kind: 'ready'; analysis: MotionAnalysis }
  | { kind: 'error'; message: string };

/** Analyses already fetched this session, per verified proxy. */
const known = new Map<string, MotionAnalysis>();
const NO_TELEMETRY: readonly TelemetrySample[] = [];

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
  telemetry: readonly TelemetrySample[];
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
  const telemetry = phase.kind === 'ready' ? phase.analysis.telemetry : NO_TELEMETRY;
  return { phase, profile, telemetry, ranges, tolerance, setTolerance: keepTolerance, find };
}

/** The 0–100 viewBox height for a 0 (bottom) – 1 (top) fraction of a scale, below the lane's text line. */
function plotY(fraction: number): number {
  return 100 - Math.max(0, Math.min(1, fraction)) * PLOT_SPAN;
}

/** Telemetry lanes plot below their label. */
function laneY(fraction: number): number {
  return 94 - Math.max(0, Math.min(1, fraction)) * 56;
}

/** At most CHART_POINTS samples: the peak roughness of each bucket. */
function roughnessPath(profile: MotionProfile, count: number): string {
  const step = Math.max(1, Math.ceil(count / CHART_POINTS));
  const points: string[] = [];
  for (let start = 0; start < count; start += step) {
    const end = Math.min(count, start + step);
    let peak = 0;
    for (let frame = start; frame < end; frame++) peak = Math.max(peak, profile.roughness[frame]!);
    points.push(`${((start + end) / 2).toFixed(1)},${plotY(peak / ROUGHNESS_MAX).toFixed(1)}`);
  }
  return `M0,100 L${points.join(' L')} L${count},100 Z`;
}

function readSeries(): SeriesKey[] {
  try {
    const stored: unknown = JSON.parse(readPreference(SERIES_PREFERENCE) ?? 'null');
    if (Array.isArray(stored)) return SERIES.flatMap((spec) => (stored.includes(spec.key) ? [spec.key] : []));
  } catch {
    // An unreadable preference falls back to the default series.
  }
  return [...DEFAULT_SERIES];
}

interface ChooserProps {
  available: readonly SeriesSpec[];
  shown: readonly SeriesKey[];
  onShown: (shown: SeriesKey[]) => void;
}

/** Which telemetry values get a lane, kept as a browser preference. */
function LaneChooser({ available, shown, onShown }: Readonly<ChooserProps>) {
  return (
    <Popover
      label="Motion timeline series"
      className="smooth-panel-lanes-menu"
      trigger={
        <>
          <Icon name="sliders" size={14} />
          <span>Telemetry</span>
        </>
      }
    >
      <div className="source-motion-series-list">
        {available.map((spec) => (
          <label key={spec.key}>
            <input
              type="checkbox"
              checked={shown.includes(spec.key)}
              onChange={(event) => {
                const on = event.target.checked;
                onShown(
                  SERIES.filter((candidate) => (candidate.key === spec.key ? on : shown.includes(candidate.key))).map(
                    (candidate) => candidate.key,
                  ),
                );
              }}
            />
            <i style={{ background: spec.colour }} aria-hidden="true" />
            {spec.label}
          </label>
        ))}
        {available.length === 0 && <p>No drone telemetry in this recording.</p>}
      </div>
    </Popover>
  );
}

function Bands({ ranges }: Readonly<{ ranges: readonly SmoothRange[] }>) {
  return ranges.map((smoothRange, index) => (
    <rect
      key={`${smoothRange.sourceIn}-${smoothRange.sourceOut}`}
      className={index ? 'source-motion-band alternative' : 'source-motion-band'}
      x={smoothRange.sourceIn}
      width={smoothRange.sourceOut - smoothRange.sourceIn}
      y={0}
      height={100}
    />
  ));
}

interface ImageLaneProps {
  asset: MediaAsset;
  profile: MotionProfile;
  ranges: readonly SmoothRange[];
  roughness: string;
  cameraMotion: string;
  toleranceY: number;
  hover: number | null;
  /** Shown instead of the legend while the dashed line is hovered or dragged. */
  tolerance: number | null;
}

/** Image roughness, camera motion and the tolerance, with the legend or the values under the pointer. */
function ImageLane(props: Readonly<ImageLaneProps>) {
  const { asset, profile, ranges, hover, tolerance } = props;
  const count = asset.metadata.frameCount;
  let label = (
    <>
      <span className="roughness">Roughness</span>
      <span className="series camera">Camera motion</span>
    </>
  );
  if (tolerance !== null)
    label = <span className="tolerance">Tolerance {tolerance.toFixed(1)} · drag up to accept more movement</span>;
  else if (hover !== null)
    label = (
      <>
        <b>{formatTimecode(hover, asset.metadata.frameRate)}</b>
        <span className="roughness">Roughness {profile.roughness[hover]!.toFixed(1)}</span>
        <span className="series camera">Camera {profile.speed[hover]!.toFixed(1)} %/s</span>
      </>
    );
  return (
    <div className="source-motion-plot image" data-lane="image">
      <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
        <Bands ranges={ranges} />
        <path className="source-motion-roughness" d={props.roughness} />
        <path className="source-motion-line camera" d={props.cameraMotion} />
        <line className="source-motion-tolerance" x1={0} x2={count} y1={props.toleranceY} y2={props.toleranceY} />
      </svg>
      <span className="source-motion-readout" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

interface SeriesLaneProps {
  spec: SeriesSpec;
  d: string;
  count: number;
  ranges: readonly SmoothRange[];
  value: number | null;
}

/** One telemetry value on its own scale, labelled with its name or its value under the pointer. */
function SeriesLane({ spec, d, count, ranges, value }: Readonly<SeriesLaneProps>) {
  return (
    <div className="source-motion-plot" data-lane={spec.key} style={{ '--series': spec.colour } as CSSProperties}>
      <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
        <Bands ranges={ranges} />
        <path className="source-motion-line" d={d} />
      </svg>
      <span className="source-motion-readout" aria-hidden="true">
        <span className="series">{value === null ? spec.label : `${spec.label} ${spec.format(value)}`}</span>
      </span>
    </div>
  );
}

type Drag = { kind: 'scrub' | 'tolerance'; pointer: number };

/** The tolerance whose dashed line sits at y (0–100 from the top of the image lane), on the slider's steps. */
function toleranceAt(y: number): number {
  const value = ((100 - y) / PLOT_SPAN) * ROUGHNESS_MAX;
  const stepped = Math.round(value / SMOOTH_TOLERANCE.step) * SMOOTH_TOLERANCE.step;
  return Number(Math.max(SMOOTH_TOLERANCE.min, Math.min(SMOOTH_TOLERANCE.max, stepped)).toFixed(1));
}

function suggestionText(best: SmoothRange | undefined, applied: boolean, rate: FrameRate) {
  if (!best)
    return { span: '', label: 'No smooth part to use', hint: 'No steady part of 2 s or more at this tolerance' };
  const from = formatTimecode(best.sourceIn, rate);
  const to = formatTimecode(best.sourceOut, rate);
  const span = `${sourceSeconds(best.sourceOut - best.sourceIn)} · ${from} – ${to}`;
  return {
    span,
    label: `Use smooth part ${from} to ${to}`,
    hint: applied ? `In use: ${span}` : `Set IN and OUT to the smooth part ${span}`,
  };
}

interface LanesProps {
  asset: MediaAsset;
  smooth: SmoothRangeState;
  profile: MotionProfile;
  lanes: readonly SeriesSpec[];
  frame: number;
  disabled: boolean;
  onFrame: (frame: number) => void;
}

/**
 * Lanes aligned under the range strip, like the prototype report: image roughness, camera motion
 * and the draggable tolerance, then one lane per chosen telemetry value.
 */
function MotionLanes({ asset, smooth, profile, lanes, frame, disabled, onFrame }: Readonly<LanesProps>) {
  const { telemetry, ranges, tolerance, setTolerance } = smooth;
  const count = asset.metadata.frameCount;
  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  const paths = useMemo(
    () => lanes.map((spec) => ({ spec, d: seriesPath(spec, telemetry, count, fps, laneY) })),
    [lanes, telemetry, count, fps],
  );
  const roughness = useMemo(() => roughnessPath(profile, count), [profile, count]);
  const cameraMotion = useMemo(() => cameraMotionPath(profile, count, plotY), [profile, count]);
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [nearLine, setNearLine] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const toleranceY = plotY(tolerance / ROUGHNESS_MAX);
  const position = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const y = event.clientY - box.top;
    return {
      frame: Math.min(count - 1, Math.floor(x * count)),
      y: (y / IMAGE_PX) * 100,
      onLine: Math.abs(y - (toleranceY / 100) * IMAGE_PX) <= LINE_GRAB_PX,
    };
  };
  const end = (): void => {
    drag.current = null;
    setAdjusting(false);
  };
  const leave = (): void => {
    setHover(null);
    setNearLine(false);
  };
  const at = (value: number): string => `${count === 1 ? 0 : (value / (count - 1)) * 100}%`;

  return (
    <div className="source-track smooth-panel-lanes">
      <span className="source-track-spacer" aria-hidden="true" />
      <div className="source-motion-lane">
        <div
          className="source-motion"
          data-disabled={disabled || undefined}
          data-near-tolerance={(nearLine && !disabled) || adjusting || undefined}
          title="Red: roughness, how fast the camera motion changes (dashed: tolerance, drag it). Grey: camera motion. Other lanes: the drone's telemetry. Blue: smooth parts. Click or drag to scrub."
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            const point = position(event);
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { kind: point.onLine ? 'tolerance' : 'scrub', pointer: event.pointerId };
            if (point.onLine) setAdjusting(true);
            else onFrame(point.frame);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            const point = position(event);
            if (current?.pointer === event.pointerId && current.kind === 'tolerance') {
              setTolerance(toleranceAt(point.y));
              return;
            }
            setHover(point.frame);
            setNearLine(point.onLine);
            if (current?.pointer === event.pointerId) onFrame(point.frame);
          }}
          onPointerLeave={leave}
          onPointerUp={end}
          onLostPointerCapture={end}
        >
          <ImageLane
            asset={asset}
            profile={profile}
            ranges={ranges}
            roughness={roughness}
            cameraMotion={cameraMotion}
            toleranceY={toleranceY}
            hover={hover}
            tolerance={adjusting || (nearLine && drag.current === null) ? tolerance : null}
          />
          {paths.map(({ spec, d }) => (
            <SeriesLane
              key={spec.key}
              spec={spec}
              d={d}
              count={count}
              ranges={ranges}
              value={hover === null ? null : seriesValue(spec, telemetry, hover, fps)}
            />
          ))}
          {hover !== null && !nearLine && !adjusting && (
            <span className="source-motion-cursor" style={{ left: at(hover) }} aria-hidden="true" />
          )}
          <span className="source-motion-head" style={{ left: at(frame) }} aria-hidden="true" />
        </div>
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
function AnalysisStatus({ smooth, disabled, onKeyDown }: Readonly<StatusProps>) {
  const { phase } = smooth;
  if (phase.kind === 'running')
    return (
      <output className="smooth-panel-status">
        <span className="spinner" />
        Measuring camera motion… {Math.round(phase.progress * 100)} %
      </output>
    );
  if (phase.kind === 'checking') return <span className="smooth-panel-status">Reading the analysis…</span>;
  return (
    <>
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
    </>
  );
}

interface PanelProps {
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
 * The smooth-part section of Source preview: a header with the suggestion, Use, the tolerance and
 * the telemetry choice, then the motion lanes. Collapsing keeps only the title and suggestion.
 */
export function SmoothPartPanel({
  asset,
  range,
  smooth,
  frame,
  disabled,
  onFrame,
  onApply,
  onKeyDown,
}: Readonly<PanelProps>) {
  const { profile, telemetry, ranges, tolerance, setTolerance } = smooth;
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_PREFERENCE) === 'true');
  const [shown, setShown] = useState(readSeries);
  const available = useMemo(() => availableSeries(telemetry), [telemetry]);
  const lanes = useMemo(() => available.filter((spec) => shown.includes(spec.key)), [available, shown]);
  const best = ranges[0];
  const applied = best?.sourceIn === range.sourceIn && best?.sourceOut === range.sourceOut;
  const { span, label, hint } = suggestionText(best, applied, asset.metadata.frameRate);
  const toggle = (): void => {
    setCollapsed(!collapsed);
    writePreference(COLLAPSED_PREFERENCE, String(!collapsed));
  };
  const show = (keys: SeriesKey[]): void => {
    setShown(keys);
    writePreference(SERIES_PREFERENCE, JSON.stringify(keys));
  };

  return (
    <section
      className="smooth-panel"
      aria-label="Smooth part"
      data-collapsed={collapsed || undefined}
      data-smooth-in={best?.sourceIn}
      data-smooth-out={best?.sourceOut}
    >
      <div className="smooth-panel-header">
        <button
          className="smooth-panel-toggle"
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand smooth part' : 'Collapse smooth part'}
          title={
            collapsed ? 'Show the smooth part controls and motion lanes' : 'Hide the smooth part controls and lanes'
          }
          onKeyDown={onKeyDown}
          onClick={toggle}
        >
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} />
          <strong>Smooth part</strong>
        </button>
        {profile ? (
          <span className="smooth-panel-summary">{best ? span : 'No steady part of 2 s or more'}</span>
        ) : (
          <AnalysisStatus smooth={smooth} disabled={disabled} onKeyDown={onKeyDown} />
        )}
        {profile && !collapsed && (
          <>
            <button
              className="secondary-button small smooth-use-button"
              type="button"
              data-applied={applied || undefined}
              aria-label={label}
              title={hint}
              disabled={disabled || !best || applied}
              onKeyDown={onKeyDown}
              onClick={() => best && onApply(best)}
            >
              <Icon name={applied ? 'check' : 'wand'} size={14} />
              <span>{applied ? 'In use' : 'Use'}</span>
            </button>
            <label className="smooth-panel-tolerance">
              <span>Tolerance</span>
              <input
                type="range"
                aria-label="Smooth part tolerance"
                aria-valuetext={`${tolerance.toFixed(1)}: ${tolerance < SMOOTH_TOLERANCE.initial ? 'stricter' : 'more tolerant'}`}
                title="Right accepts more camera movement; left suggests only very steady footage"
                min={SMOOTH_TOLERANCE.min}
                max={SMOOTH_TOLERANCE.max}
                step={SMOOTH_TOLERANCE.step}
                value={tolerance}
                disabled={disabled}
                onKeyDown={onKeyDown}
                onChange={(event) => setTolerance(Number(event.target.value))}
              />
              <output>{tolerance.toFixed(1)}</output>
            </label>
            <LaneChooser available={available} shown={shown} onShown={show} />
          </>
        )}
      </div>
      {profile && !collapsed && (
        <MotionLanes
          asset={asset}
          smooth={smooth}
          profile={profile}
          lanes={lanes}
          frame={frame}
          disabled={disabled}
          onFrame={onFrame}
        />
      )}
    </section>
  );
}
