import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { damagedAt, type MediaAsset, type MediaJob } from '../shared/media.js';
import type { MediaSelection } from '../shared/media-selection.js';
import type { SelectRange } from '../shared/model.js';
import {
  motionProfile,
  smoothRanges,
  SMOOTH_TOLERANCE,
  type MotionAnalysis,
  type MotionProfile,
  type SmoothRange,
  type TelemetrySample,
} from '../shared/motion-analysis.js';
import { rankedSmoothRanges, shotKind, type ShotKind } from '../shared/recording-shots.js';
import { formatTimecode, type FrameRate } from '../shared/timing.js';
import { api, ApiError } from './api.js';
import { DamageMarks } from './DamageMarks.js';
import { mediaReady, sourceSeconds } from './display.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import {
  areaUnder,
  availableSeries,
  cameraMotionPath,
  DEFAULT_SERIES,
  SERIES,
  seriesPath,
  seriesScale,
  seriesValue,
  type SeriesKey,
  type SeriesSpec,
} from './motion-series.js';
import { Popover } from './Popover.js';
import { readPreference, writePreference } from './preferences.js';
import { ResetLabel, resetBlocked } from './SettingValueControl.js';
import { ValueControl } from './ValueControl.js';

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
  | { kind: 'running'; queued: boolean; progress: number }
  | { kind: 'ready'; analysis: MotionAnalysis }
  | { kind: 'error'; message: string };

/** Analyses already fetched this session, per verified proxy. */
const known = new Map<string, MotionAnalysis>();
const NO_TELEMETRY: readonly TelemetrySample[] = [];
const KIND_NAMES: Readonly<Record<ShotKind, string>> = {
  orbit: 'orbit',
  reveal: 'reveal',
  move: 'camera move',
  approach: 'approach',
  static: 'nearly still',
};

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
  /** Steady ranges, the best first: orbits and reveals before other moves, approaches and still footage. */
  ranges: readonly SmoothRange[];
  /** What the best range shows; null without one. */
  bestKind: ShotKind | null;
  /** The allowed movement in effect, including a slider drag in progress. */
  tolerance: number;
  /** The kept allowed movement, without a drag in progress. */
  savedTolerance: number;
  setTolerance: (value: number) => void;
  /** A slider drag's value, or null when it ends or is cancelled. */
  previewTolerance: (value: number | null) => void;
  find: () => void;
}

/** Steady-range suggestions for one recording, from the analysis made when its proxy was prepared. */
export function useSmoothRange(asset: MediaAsset): SmoothRangeState {
  const ready = mediaReady(asset);
  const key = `${asset.id}/${asset.prepared?.verification.verifiedAt ?? ''}`;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [savedTolerance, setSavedTolerance] = useState(readTolerance);
  const [draftTolerance, setDraftTolerance] = useState<number | null>(null);
  const tolerance = draftTolerance ?? savedTolerance;
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

  /** Shows a camera motion job's progress, then its analysis. */
  const follow = useCallback(
    async (job: MediaJob, signal: AbortSignal): Promise<void> => {
      const poll = async (current: MediaJob): Promise<MediaJob> => {
        if (current.state !== 'queued' && current.state !== 'running') return current;
        setPhase({ kind: 'running', queued: current.state === 'queued', progress: current.progress });
        await wait(POLL_MS, signal);
        const next = (await api.jobs({ signal })).jobs.find((candidate) => candidate.id === current.id);
        if (!next) throw new Error('The analysis job is no longer listed. Try again.');
        return poll(next);
      };
      const done = await poll(job);
      if (done.state === 'cancelled') return setPhase({ kind: 'idle' });
      if (done.state === 'failed') throw new Error(done.message);
      const { analysis } = await api.motion(asset.id, { signal });
      if (!analysis) throw new Error('The analysis finished but its result is missing. Try again.');
      finish(analysis);
    },
    [asset.id, finish],
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
      .then(({ analysis, job }) => {
        if (analysis) return finish(analysis);
        // Preparation queues the analysis after the batch's proxies.
        if (job) return follow(job, signal);
        setPhase({ kind: 'idle' });
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setPhase(failure(cause));
      });
    return () => controller.current?.abort();
  }, [key, ready]);

  // Recordings prepared before the analysis existed can still be measured on request.
  const find = useCallback(() => {
    const signal = start();
    api
      .analyseMotion(asset.id)
      .then(({ job }) => (signal.aborted ? undefined : follow(job, signal)))
      .catch((cause: unknown) => {
        if (!signal.aborted) setPhase(failure(cause));
      });
  }, [asset.id, follow, start]);

  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  const analysis = phase.kind === 'ready' ? phase.analysis : null;
  const profile = useMemo(() => (analysis ? motionProfile(analysis, fps) : null), [analysis, fps]);
  const ranges = useMemo(
    () =>
      analysis && profile ? rankedSmoothRanges(analysis, smoothRanges(profile, tolerance, fps, asset.damage), fps) : [],
    [analysis, profile, tolerance, fps, asset.damage],
  );
  const best = ranges[0];
  const bestKind = analysis && best ? shotKind(analysis, best.sourceIn, best.sourceOut, fps) : null;
  const keepTolerance = useCallback((value: number) => {
    setSavedTolerance(value);
    writePreference(TOLERANCE_PREFERENCE, String(value));
  }, []);
  const telemetry = analysis ? analysis.telemetry : NO_TELEMETRY;
  return {
    phase,
    profile,
    telemetry,
    ranges,
    bestKind,
    tolerance,
    savedTolerance,
    setTolerance: keepTolerance,
    previewTolerance: setDraftTolerance,
    find,
  };
}

/** The 0–100 viewBox height for a 0 (bottom) – 1 (top) fraction of a scale, below the lane's text line. */
function plotY(fraction: number): number {
  return 100 - Math.max(0, Math.min(1, fraction)) * PLOT_SPAN;
}

/** Telemetry lanes plot below their label. */
function laneY(fraction: number): number {
  return 94 - Math.max(0, Math.min(1, fraction)) * 56;
}

/** The proxy can have a frame fewer than the original: its last measured value covers the rest. */
function measuredAt(values: readonly number[], frame: number): number {
  return values[Math.min(frame, values.length - 1)]!;
}

/** At most CHART_POINTS samples: the peak roughness of each bucket. */
function roughnessPath(profile: MotionProfile, count: number): string {
  const frames = Math.min(count, profile.roughness.length);
  const step = Math.max(1, Math.ceil(frames / CHART_POINTS));
  const points: string[] = [];
  for (let start = 0; start < frames; start += step) {
    const end = Math.min(frames, start + step);
    let peak = 0;
    for (let frame = start; frame < end; frame++) peak = Math.max(peak, profile.roughness[frame]!);
    points.push(`${((start + end) / 2).toFixed(1)},${plotY(peak / ROUGHNESS_MAX).toFixed(1)}`);
  }
  return `M0,100 L${points.join(' L')} L${frames},100 Z`;
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

/** Which flight data values get a lane, kept as a browser preference. */
function LaneChooser({ available, shown, onShown }: Readonly<ChooserProps>) {
  return (
    <Popover
      label="Flight data lanes"
      className="smooth-panel-lanes-menu"
      trigger={
        <>
          <Icon name="sliders" size={14} />
          <span>Flight data</span>
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
        {available.length === 0 && <p>No flight data in this recording.</p>}
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

/** Image jolts, camera movement and the allowed movement, with the legend or the values under the pointer. */
function ImageLane(props: Readonly<ImageLaneProps>) {
  const { asset, profile, ranges, hover, tolerance } = props;
  const count = asset.metadata.frameCount;
  let label = (
    <>
      <span className="roughness">Jolts</span>
      <span className="series camera">Movement</span>
    </>
  );
  if (tolerance !== null)
    label = <span className="tolerance">Allowed movement {tolerance.toFixed(1)} · drag the line</span>;
  else if (hover !== null && damagedAt(asset.damage, hover))
    label = (
      <>
        <b>{formatTimecode(hover, asset.metadata.frameRate)}</b>
        <span className="damaged">Damaged · shown black</span>
      </>
    );
  else if (hover !== null)
    label = (
      <>
        <b>{formatTimecode(hover, asset.metadata.frameRate)}</b>
        <span className="roughness">Jolts {measuredAt(profile.roughness, hover).toFixed(1)}</span>
        <span className="series camera">Movement {measuredAt(profile.speed, hover).toFixed(1)} %/s</span>
      </>
    );
  return (
    <div className="source-motion-plot image" data-lane="image">
      <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
        <Bands ranges={ranges} />
        <path className="source-motion-roughness" d={props.roughness} />
        <path className="source-motion-area camera" d={areaUnder(props.cameraMotion)} />
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
  /** The lowest and highest recorded values, which span the lane. */
  extent: string;
  count: number;
  ranges: readonly SmoothRange[];
  value: number | null;
}

/** One flight data value on its own min–max scale, labelled with that extent or its value under the pointer. */
function SeriesLane({ spec, d, extent, count, ranges, value }: Readonly<SeriesLaneProps>) {
  return (
    <div className="source-motion-plot" data-lane={spec.key} style={{ '--series': spec.colour } as CSSProperties}>
      <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
        <Bands ranges={ranges} />
        <path className="source-motion-area" d={areaUnder(d)} />
        <path className="source-motion-line" d={d} />
      </svg>
      <span className="source-motion-readout" aria-hidden="true">
        <span className="series">{value === null ? spec.label : `${spec.label} ${spec.format(value)}`}</span>
        {value === null && extent && <span className="extent">{extent}</span>}
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

/** Steady ranges in source order, as kept ranges. */
export function steadyKeptRanges(ranges: readonly SmoothRange[]): SelectRange[] {
  return [...ranges]
    .sort((a, b) => a.sourceIn - b.sourceIn)
    .map(({ sourceIn, sourceOut }) => ({ sourceIn, sourceOut }));
}

function sameRanges(kept: readonly SelectRange[], ranges: readonly SmoothRange[]): boolean {
  const steady = steadyKeptRanges(ranges);
  return (
    kept.length === steady.length &&
    kept.every(
      (item, index) => item.sourceIn === steady[index]!.sourceIn && item.sourceOut === steady[index]!.sourceOut,
    )
  );
}

function useAllHint(count: number, applied: boolean): string {
  if (!count) return 'No steady range of 2 s or more at this allowed movement';
  if (applied) return `The kept ranges are the ${count} steady ranges`;
  return `Keep the ${count} steady ranges, replacing the kept ranges; adds nothing to the timeline`;
}

function suggestionText(best: SmoothRange | undefined, kind: ShotKind | null, applied: boolean, rate: FrameRate) {
  if (!best || !kind)
    return {
      span: '',
      label: 'No steady range to use',
      hint: 'No steady range of 2 s or more at this allowed movement',
    };
  const from = formatTimecode(best.sourceIn, rate);
  const to = formatTimecode(best.sourceOut, rate);
  const span = `${KIND_NAMES[kind]} · ${sourceSeconds(best.sourceOut - best.sourceIn)} · ${from} – ${to}`;
  return {
    span,
    label: `Use best steady range ${from} to ${to}`,
    hint: applied ? `In use: ${span}` : `Set IN and OUT to the best steady range, ${span}`,
  };
}

export interface MotionLanesProps {
  asset: MediaAsset;
  smooth: SmoothRangeState;
  view: CameraMotionView;
  /** The range shown on the strip above, including a trim draft. */
  range: MediaSelection;
  disabled: boolean;
  onFrame: (frame: number) => void;
}

/** The lanes stacked under the range strip, sharing its playhead; nothing while unmeasured or collapsed. */
export function MotionLanes(props: Readonly<MotionLanesProps>) {
  const { profile } = props.smooth;
  if (!profile || props.view.collapsed) return null;
  return <Lanes {...props} profile={profile} />;
}

/**
 * Image jolts, camera movement and the draggable allowed movement, then one lane per chosen
 * flight data value; the range omitted by IN/OUT is hatched as on the strip.
 */
function Lanes({
  asset,
  smooth,
  view,
  range,
  profile,
  disabled,
  onFrame,
}: Readonly<MotionLanesProps & { profile: MotionProfile }>) {
  const { telemetry, ranges, tolerance, setTolerance } = smooth;
  const count = asset.metadata.frameCount;
  const rate = asset.metadata.frameRate;
  const fps = rate.numerator / rate.denominator;
  const lanes = useMemo(
    () => availableSeries(telemetry).filter((spec) => view.shown.includes(spec.key)),
    [telemetry, view.shown],
  );
  const paths = useMemo(
    () =>
      lanes.map((spec) => {
        const scale = seriesScale(spec, telemetry, count, fps);
        const extent =
          scale === null || scale.min === scale.max ? '' : `${spec.format(scale.min)} – ${spec.format(scale.max)}`;
        return { spec, extent, d: seriesPath(spec, telemetry, count, fps, laneY) };
      }),
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
    <div
      className="source-motion"
      data-disabled={disabled || undefined}
      data-near-tolerance={(nearLine && !disabled) || adjusting || undefined}
      title="Click or drag to scrub; drag the dashed line to change the allowed movement"
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
      {paths.map(({ spec, d, extent }) => (
        <SeriesLane
          key={spec.key}
          spec={spec}
          d={d}
          extent={extent}
          count={count}
          ranges={ranges}
          value={hover === null ? null : seriesValue(spec, telemetry, hover, fps)}
        />
      ))}
      <span
        className="source-motion-omitted"
        style={{ left: 0, width: `${(range.sourceIn / count) * 100}%` }}
        aria-hidden="true"
      />
      <span
        className="source-motion-omitted"
        style={{ left: `${(range.sourceOut / count) * 100}%`, right: 0 }}
        aria-hidden="true"
      />
      <DamageMarks damage={asset.damage} count={count} className="source-motion-damaged" />
      {hover !== null && !nearLine && !adjusting && (
        <span className="source-motion-cursor" style={{ left: at(hover) }} aria-hidden="true" />
      )}
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
        {phase.queued ? 'Camera motion queued…' : `Measuring camera motion… ${Math.round(phase.progress * 100)} %`}
      </output>
    );
  if (phase.kind === 'checking') return <span className="smooth-panel-status">Reading the analysis…</span>;
  return (
    <>
      <button
        className="secondary-button small"
        type="button"
        title="Measure the camera motion of this recording (a background job) and suggest its best steady range"
        disabled={disabled}
        onKeyDown={onKeyDown}
        onClick={smooth.find}
      >
        {phase.kind === 'error' ? 'Retry analysing camera motion' : 'Analyse camera motion'}
      </button>
      {phase.kind === 'error' && (
        <span className="smooth-range-error" role="alert">
          {phase.message}
        </span>
      )}
    </>
  );
}

export interface CameraMotionView {
  collapsed: boolean;
  toggle: () => void;
  shown: readonly SeriesKey[];
  show: (keys: SeriesKey[]) => void;
}

/** Browser preferences shared by the lanes under the strip and the panel below the range fields. */
export function useCameraMotionView(): CameraMotionView {
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_PREFERENCE) === 'true');
  const [shown, setShown] = useState(readSeries);
  return {
    collapsed,
    toggle: () => {
      setCollapsed(!collapsed);
      writePreference(COLLAPSED_PREFERENCE, String(!collapsed));
    },
    shown,
    show: (keys) => {
      setShown(keys);
      writePreference(SERIES_PREFERENCE, JSON.stringify(keys));
    },
  };
}

interface PanelProps {
  asset: MediaAsset;
  range: MediaSelection;
  smooth: SmoothRangeState;
  view: CameraMotionView;
  disabled: boolean;
  onApply: (range: SmoothRange) => void;
  /** The recording's kept ranges, to tell when they already are the steady ranges. */
  kept: readonly SelectRange[];
  /** Keeps exactly the steady ranges, in one Undo step; adds nothing to the timeline. */
  onUseAll: (ranges: readonly SmoothRange[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * The camera motion controls below the range fields: a header with the best steady range and Use,
 * then the allowed movement and the flight data choice. Collapsing also hides the lanes.
 */
export function CameraMotionPanel({
  asset,
  range,
  smooth,
  view,
  disabled,
  onApply,
  kept,
  onUseAll,
  onKeyDown,
}: Readonly<PanelProps>) {
  const { profile, telemetry, ranges, bestKind, savedTolerance, setTolerance, previewTolerance } = smooth;
  const toleranceId = useId();
  const { collapsed } = view;
  const available = useMemo(() => availableSeries(telemetry), [telemetry]);
  const best = ranges[0];
  const applied = best?.sourceIn === range.sourceIn && best?.sourceOut === range.sourceOut;
  const { span, label, hint } = suggestionText(best, bestKind, applied, asset.metadata.frameRate);
  const allApplied = ranges.length > 0 && sameRanges(kept, ranges);

  return (
    <section
      className="smooth-panel"
      aria-label="Camera motion"
      data-collapsed={collapsed || undefined}
      data-smooth-in={best?.sourceIn}
      data-smooth-out={best?.sourceOut}
    >
      <div className="smooth-panel-header">
        <button
          className="smooth-panel-toggle"
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand camera motion' : 'Collapse camera motion'}
          title={collapsed ? 'Show the camera motion controls and lanes' : 'Hide the camera motion controls and lanes'}
          onKeyDown={onKeyDown}
          onClick={view.toggle}
        >
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} />
          <strong>Camera motion</strong>
        </button>
        <HelpPopover label="Camera motion" guide="find-the-best-steady-range">
          <p>
            The lanes under the range show how the camera moves: the amber area marks jolts, the white line its movement
            and the green bands steady ranges. Use best sets IN and OUT to the best one, favouring orbits and reveals
            over approaches and nearly still footage; Use all keeps every steady range.
          </p>
          <p className="editor-help-tip">
            Tip: drag the dashed line, or move Allowed movement, to accept more or less movement.
          </p>
        </HelpPopover>
        {profile ? (
          <span
            className="smooth-panel-summary"
            title={best ? `Best steady range: ${span}` : 'No steady range of 2 s or more'}
          >
            {best ? (
              <>
                Best steady range <b>{span}</b>
              </>
            ) : (
              'No steady range of 2 s or more'
            )}
          </span>
        ) : (
          <AnalysisStatus smooth={smooth} disabled={disabled} onKeyDown={onKeyDown} />
        )}
        {profile && !collapsed && (
          <div className="smooth-panel-actions">
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
              <span>{applied ? 'In use' : 'Use best'}</span>
            </button>
            <button
              className="secondary-button small smooth-use-all-button"
              type="button"
              data-applied={allApplied || undefined}
              aria-label={`Use all ${ranges.length} steady ranges as kept ranges`}
              title={useAllHint(ranges.length, allApplied)}
              disabled={disabled || !ranges.length || allApplied}
              onKeyDown={onKeyDown}
              onClick={() => onUseAll(ranges)}
            >
              <Icon name={allApplied ? 'check' : 'wand'} size={14} />
              <span>{allApplied ? 'All in use' : `Use all ${ranges.length}`}</span>
            </button>
          </div>
        )}
      </div>
      {profile && !collapsed && (
        <div className="smooth-panel-controls">
          <div className="smooth-panel-tolerance">
            <ResetLabel
              htmlFor={toleranceId}
              title="Right accepts more camera movement; left suggests only very steady footage"
              name="Allowed movement"
              blocked={resetBlocked(savedTolerance === SMOOTH_TOLERANCE.initial, disabled)}
              onReset={() => setTolerance(SMOOTH_TOLERANCE.initial)}
            >
              Allowed movement
            </ResetLabel>
            <ValueControl
              id={toleranceId}
              aria-label="Allowed movement"
              min={SMOOTH_TOLERANCE.min}
              max={SMOOTH_TOLERANCE.max}
              step={SMOOTH_TOLERANCE.step}
              value={savedTolerance}
              disabled={disabled}
              resetKey="allowed-movement"
              onCommit={setTolerance}
              onDraft={previewTolerance}
            />
          </div>
          <LaneChooser available={available} shown={view.shown} onShown={view.show} />
        </div>
      )}
    </section>
  );
}
