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
const COLLAPSED_PREFERENCE = 'pascap-motion-timeline-collapsed';
const SERIES_PREFERENCE = 'pascap-motion-timeline-series';
const POLL_MS = 1000;
/** Roughness scale in % of image width per s²; other series scale to their own range. */
const ROUGHNESS_MAX = 8;
const CHART_POINTS = 600;
/** The top of the plotted area in the 0–100 viewBox, leaving room for one line of text. */
const PLOT_TOP = 30;
const LINE_GRAB_PX = 6;
const COLLAPSED_PX = 22;
const THUMB_PX = 14;

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

/** The plotted area of the 0–100 viewBox, for a 0 (bottom) – 1 (top) fraction of a scale. */
function plotY(fraction: number): number {
  return 100 - Math.max(0, Math.min(1, fraction)) * (100 - PLOT_TOP);
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

interface ReadoutProps {
  asset: MediaAsset;
  profile: MotionProfile;
  telemetry: readonly TelemetrySample[];
  series: readonly SeriesSpec[];
  hover: number | null;
  /** Shown instead of the values while the dashed line is hovered or dragged. */
  tolerance: number | null;
}

/** The legend, or the values under the pointer, above the plotted lines. */
function MotionReadout({ asset, profile, telemetry, series, hover, tolerance }: Readonly<ReadoutProps>) {
  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  if (tolerance !== null)
    return (
      <span className="source-motion-readout" aria-hidden="true">
        <span className="tolerance">Tolerance {tolerance.toFixed(1)} · drag up to accept more movement</span>
      </span>
    );
  const values = series.map((spec) => ({
    spec,
    value: hover === null ? null : seriesValue(spec, profile, telemetry, hover, fps),
  }));
  return (
    <span className="source-motion-readout" aria-hidden="true">
      {hover !== null && <b>{formatTimecode(hover, rate)}</b>}
      <span className="roughness">Roughness{hover !== null && ` ${profile.roughness[hover]!.toFixed(1)}`}</span>
      {values.map(({ spec, value }) =>
        hover !== null && value === null ? null : (
          <span key={spec.key} className="series" style={{ '--series': spec.colour } as CSSProperties}>
            {value === null ? spec.label : `${spec.short} ${spec.format(value)}`}
          </span>
        ),
      )}
    </span>
  );
}

interface ToolsProps {
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  available: readonly SeriesSpec[];
  shown: readonly SeriesKey[];
  onShown: (shown: SeriesKey[]) => void;
  hasTelemetry: boolean;
}

/** Collapse and series choice, kept as browser preferences. */
function MotionTools({ collapsed, onCollapsed, available, shown, onShown, hasTelemetry }: Readonly<ToolsProps>) {
  return (
    <span className="source-motion-tools">
      <button
        className="source-motion-toggle"
        type="button"
        aria-label={collapsed ? 'Expand motion timeline' : 'Collapse motion timeline'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Show roughness, camera motion and telemetry' : 'Show only the smooth parts'}
        onClick={() => onCollapsed(!collapsed)}
      >
        <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={13} />
      </button>
      {!collapsed && (
        <Popover
          label="Motion timeline series"
          className="source-motion-series"
          trigger={<Icon name="sliders" size={13} />}
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
                      SERIES.filter((candidate) =>
                        candidate.key === spec.key ? on : shown.includes(candidate.key),
                      ).map((candidate) => candidate.key),
                    );
                  }}
                />
                <i style={{ background: spec.colour }} aria-hidden="true" />
                {spec.label}
              </label>
            ))}
            {!hasTelemetry && <p>No drone telemetry in this recording.</p>}
          </div>
        </Popover>
      )}
    </span>
  );
}

interface PlotProps {
  count: number;
  ranges: readonly SmoothRange[];
  collapsed: boolean;
  roughness: string;
  lines: readonly { spec: SeriesSpec; d: string }[];
  toleranceY: number;
}

function MotionPlot({ count, ranges, collapsed, roughness, lines, toleranceY }: Readonly<PlotProps>) {
  const top = collapsed ? 0 : PLOT_TOP;
  return (
    <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
      {ranges.map((smoothRange, index) => (
        <rect
          key={`${smoothRange.sourceIn}-${smoothRange.sourceOut}`}
          className={index ? 'source-motion-band alternative' : 'source-motion-band'}
          x={smoothRange.sourceIn}
          width={smoothRange.sourceOut - smoothRange.sourceIn}
          y={top}
          height={100 - top}
        />
      ))}
      {!collapsed && (
        <>
          <path className="source-motion-roughness" d={roughness} />
          {lines.map(({ spec, d }) => (
            <path key={spec.key} className="source-motion-line" data-series={spec.key} d={d} stroke={spec.colour} />
          ))}
          <line className="source-motion-tolerance" x1={0} x2={count} y1={toleranceY} y2={toleranceY} />
        </>
      )}
    </svg>
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

const inTools = (event: ReactPointerEvent): boolean =>
  event.target instanceof Element && event.target.closest('.source-motion-tools') !== null;

/** Pixels: the chart grows a little with more series. */
function expandedHeight(series: number): number {
  return 56 + Math.min(4, Math.max(0, series - 2)) * 6;
}

/**
 * One row aligned under the range strip: Use (under Play), image roughness, camera motion and
 * the chosen telemetry along the whole recording, and the tolerance as a draggable dashed line.
 * Collapsed, it keeps only the smooth parts.
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
  const { profile, telemetry, ranges, tolerance, setTolerance } = smooth;
  const count = asset.metadata.frameCount;
  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_PREFERENCE) === 'true');
  const [shown, setShown] = useState(readSeries);
  const available = useMemo(() => availableSeries(telemetry), [telemetry]);
  const visible = useMemo(() => available.filter((spec) => shown.includes(spec.key)), [available, shown]);
  const roughness = useMemo(() => (profile ? roughnessPath(profile, count) : ''), [profile, count]);
  const lines = useMemo(
    () =>
      profile ? visible.map((spec) => ({ spec, d: seriesPath(spec, profile, telemetry, count, fps, plotY) })) : [],
    [profile, visible, telemetry, count, fps],
  );
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [nearLine, setNearLine] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  if (!profile) return null;
  const best = ranges[0];
  const applied = best?.sourceIn === range.sourceIn && best?.sourceOut === range.sourceOut;
  const toleranceY = plotY(tolerance / ROUGHNESS_MAX);
  const toleranceTop = plotY(SMOOTH_TOLERANCE.max / ROUGHNESS_MAX);
  const toleranceBottom = plotY(SMOOTH_TOLERANCE.min / ROUGHNESS_MAX);
  const position = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const y = ((event.clientY - box.top) / box.height) * 100;
    return {
      frame: Math.min(count - 1, Math.floor(x * count)),
      y,
      onLine: !collapsed && Math.abs(((y - toleranceY) / 100) * box.height) <= LINE_GRAB_PX,
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
  const collapse = (value: boolean): void => {
    setCollapsed(value);
    leave();
    writePreference(COLLAPSED_PREFERENCE, String(value));
  };
  const show = (keys: SeriesKey[]): void => {
    setShown(keys);
    writePreference(SERIES_PREFERENCE, JSON.stringify(keys));
  };
  const { span, label, hint } = suggestionText(best, applied, rate);

  return (
    <div
      className="source-track source-motion-row"
      data-collapsed={collapsed || undefined}
      data-smooth-in={best?.sourceIn}
      data-smooth-out={best?.sourceOut}
      style={{ '--motion-height': `${collapsed ? COLLAPSED_PX : expandedHeight(visible.length)}px` } as CSSProperties}
    >
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
        <Icon name={applied ? 'check' : 'wand'} size={collapsed ? 13 : 15} />
        {!collapsed && <span>{applied ? 'In use' : 'Use'}</span>}
      </button>
      <div className="source-motion-lane">
        <div
          className="source-motion"
          data-disabled={disabled || undefined}
          data-near-tolerance={(nearLine && !disabled) || adjusting || undefined}
          title="Red: roughness, how fast the camera motion changes (dashed: tolerance, drag it). Lines: the series chosen with the sliders button. Blue: smooth parts. Click or drag to scrub."
          onPointerDown={(event) => {
            if (disabled || event.button !== 0 || inTools(event)) return;
            const at = position(event);
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { kind: at.onLine ? 'tolerance' : 'scrub', pointer: event.pointerId };
            if (at.onLine) setAdjusting(true);
            else onFrame(at.frame);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (current === null && inTools(event)) return leave();
            const at = position(event);
            if (current?.pointer === event.pointerId && current.kind === 'tolerance') {
              setTolerance(toleranceAt(at.y));
              return;
            }
            setHover(at.frame);
            setNearLine(at.onLine);
            if (current?.pointer === event.pointerId) onFrame(at.frame);
          }}
          onPointerLeave={leave}
          onPointerUp={end}
          onLostPointerCapture={end}
        >
          <MotionPlot
            count={count}
            ranges={ranges}
            collapsed={collapsed}
            roughness={roughness}
            lines={lines}
            toleranceY={toleranceY}
          />
          <MotionTools
            collapsed={collapsed}
            onCollapsed={collapse}
            available={available}
            shown={shown}
            onShown={show}
            hasTelemetry={available.length > 1}
          />
          {!collapsed && (
            <MotionReadout
              asset={asset}
              profile={profile}
              telemetry={telemetry}
              series={visible}
              hover={hover}
              tolerance={adjusting || (nearLine && drag.current === null) ? tolerance : null}
            />
          )}
          <span className="source-motion-summary">{best ? `Smooth ${span}` : 'No steady part of 2 s or more'}</span>
          {hover !== null && !nearLine && !adjusting && !collapsed && (
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
        {!collapsed && (
          // The thumb centre travels exactly over the tolerance values of the dashed line.
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
        )}
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
