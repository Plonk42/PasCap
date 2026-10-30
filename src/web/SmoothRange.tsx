import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { damagedAt, type MediaAsset, type MediaJob } from '../shared/media.js';
import type { MediaSelection } from '../shared/media-selection.js';
import type { SelectRange } from '../shared/model.js';
import {
  FLIGHT_SPEED_RANGE,
  motionProfile,
  MOVEMENT_RANGE,
  smoothRanges,
  SMOOTH_TOLERANCE,
  steadyLimits,
  type Bounds,
  type MotionAnalysis,
  type MotionProfile,
  type SmoothRange,
  type SteadyLimits,
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
import { RangeControl } from './RangeControl.js';
import { ResetLabel, resetBlocked } from './SettingValueControl.js';

const TOLERANCE_PREFERENCE = 'pascap-smooth-tolerance';
const LIMITS_PREFERENCE = 'pascap-steady-limits';
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

function validBounds(value: unknown, range: { min: number; max: number }): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [low, high]: unknown[] = value;
  return typeof low === 'number' && typeof high === 'number' && range.min <= low && low < high && high <= range.max;
}

function readLimits(): SteadyLimits {
  try {
    const stored: unknown = JSON.parse(readPreference(LIMITS_PREFERENCE) ?? 'null');
    if (typeof stored === 'object' && stored !== null) {
      const { movement, flightSpeed } = stored as Record<string, unknown>;
      if (validBounds(movement, MOVEMENT_RANGE) && validBounds(flightSpeed, FLIGHT_SPEED_RANGE))
        return { movement, flightSpeed };
    }
  } catch {
    // An unreadable preference falls back to the earlier single Allowed movement.
  }
  // The single Allowed movement kept before it became a range is that range's maximum.
  return steadyLimits(readTolerance());
}

const INITIAL_LIMITS = steadyLimits();
let keptLimits: SteadyLimits | null = null;
const limitsListeners = new Set<() => void>();

function currentLimits(): SteadyLimits {
  keptLimits ??= readLimits();
  return keptLimits;
}

function subscribeLimits(listener: () => void): () => void {
  limitsListeners.add(listener);
  return () => {
    limitsListeners.delete(listener);
  };
}

function keepLimits(value: SteadyLimits): void {
  keptLimits = value;
  writePreference(LIMITS_PREFERENCE, JSON.stringify(value));
  for (const listener of limitsListeners) listener();
}

/** The kept Allowed movement and Flight speed ranges, shared by every steady-range suggestion. */
export function useSteadyLimits(): [SteadyLimits, (value: SteadyLimits) => void] {
  return [useSyncExternalStore(subscribeLimits, currentLimits), keepLimits];
}

/** Identifies a recording's verified proxy, whose analysis is kept for the session. */
export function motionKey(asset: MediaAsset): string {
  return `${asset.id}/${asset.prepared?.verification.verifiedAt ?? ''}`;
}

export function knownMotion(asset: MediaAsset): MotionAnalysis | undefined {
  return known.get(motionKey(asset));
}

export function rememberMotion(asset: MediaAsset, analysis: MotionAnalysis): void {
  known.set(motionKey(asset), analysis);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ApiError('Request canceled.', 0, 'aborted'));
      },
      { once: true },
    );
  });
}

function failure(cause: unknown): Phase {
  return { kind: 'error', message: cause instanceof Error ? cause.message : 'Cannot analyze this recording.' };
}

export interface SmoothRangeState {
  phase: Phase;
  profile: MotionProfile | null;
  telemetry: readonly TelemetrySample[];
  /** Steady ranges, the best first: orbits and reveals before other moves, approaches and still footage. */
  ranges: readonly SmoothRange[];
  /** What the best range shows; null without one. */
  bestKind: ShotKind | null;
  /** The limits in effect, including a slider drag in progress. */
  limits: SteadyLimits;
  /** The kept limits, without a drag in progress. */
  savedLimits: SteadyLimits;
  setLimits: (value: SteadyLimits) => void;
  /** A slider drag's limits, or null when it ends or is canceled. */
  previewLimits: (value: SteadyLimits | null) => void;
  find: () => void;
}

/** Steady-range suggestions for one recording, from the analysis made when its proxy was prepared. */
export function useSmoothRange(asset: MediaAsset): SmoothRangeState {
  const ready = mediaReady(asset);
  const key = motionKey(asset);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [savedLimits, setLimits] = useSteadyLimits();
  const [draftLimits, setDraftLimits] = useState<SteadyLimits | null>(null);
  const limits = draftLimits ?? savedLimits;
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
      if (done.state === 'canceled') return setPhase({ kind: 'idle' });
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
      .analyzeMotion(asset.id)
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
      analysis && profile ? rankedSmoothRanges(analysis, smoothRanges(profile, limits, fps, asset.damage), fps) : [],
    [analysis, profile, limits, fps, asset.damage],
  );
  const best = ranges[0];
  const bestKind = analysis && best ? shotKind(analysis, best.sourceIn, best.sourceOut, fps) : null;
  const telemetry = analysis ? analysis.telemetry : NO_TELEMETRY;
  return {
    phase,
    profile,
    telemetry,
    ranges,
    bestKind,
    limits,
    savedLimits,
    setLimits,
    previewLimits: setDraftLimits,
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
            <i style={{ background: spec.color }} aria-hidden="true" />
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
  /** Where the dashed Allowed movement lines sit; no low line while the range starts at zero. */
  lowY: number | null;
  highY: number;
  hover: number | null;
  /** Shown instead of the legend while a dashed line is hovered or dragged. */
  movement: Bounds | null;
}

/** Image jolts, camera movement and the allowed movement, with the legend or the values under the pointer. */
function ImageLane(props: Readonly<ImageLaneProps>) {
  const { asset, profile, ranges, hover, movement } = props;
  const count = asset.metadata.frameCount;
  let label = (
    <>
      <span className="roughness">Jolts</span>
      <span className="series camera">Movement</span>
    </>
  );
  if (movement !== null)
    label = (
      <span className="tolerance">
        Allowed movement {movement[0].toFixed(1)} – {movement[1].toFixed(1)} · drag{' '}
        {props.lowY === null ? 'the line' : 'a line'}
      </span>
    );
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
        <line className="source-motion-tolerance" x1={0} x2={count} y1={props.highY} y2={props.highY} />
        {props.lowY !== null && (
          <line className="source-motion-tolerance low" x1={0} x2={count} y1={props.lowY} y2={props.lowY} />
        )}
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
  /** Heights (0–100 viewBox) of the limits drawn on this lane. */
  limits: readonly number[];
}

/** One flight data value on its own min–max scale, labeled with that extent or its value under the pointer. */
function SeriesLane({ spec, d, extent, count, ranges, value, limits }: Readonly<SeriesLaneProps>) {
  return (
    <div className="source-motion-plot" data-lane={spec.key} style={{ '--series': spec.color } as CSSProperties}>
      <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
        <Bands ranges={ranges} />
        <path className="source-motion-area" d={areaUnder(d)} />
        <path className="source-motion-line" d={d} />
        {limits.map((y) => (
          <line key={y} className="source-motion-limit" x1={0} x2={count} y1={y} y2={y} />
        ))}
      </svg>
      <span className="source-motion-readout" aria-hidden="true">
        <span className="series">{value === null ? spec.label : `${spec.label} ${spec.format(value)}`}</span>
        {value === null && extent && <span className="extent">{extent}</span>}
      </span>
    </div>
  );
}

type Drag = { kind: 'scrub' | 'low' | 'high'; pointer: number };

/** The jolts whose dashed line sits at y (0–100 from the top of the image lane), on the slider's steps. */
function toleranceAt(y: number, lowest: number, highest: number): number {
  const value = ((100 - y) / PLOT_SPAN) * ROUGHNESS_MAX;
  const stepped = Math.round(value / MOVEMENT_RANGE.step) * MOVEMENT_RANGE.step;
  return Number(Math.max(lowest, Math.min(highest, stepped)).toFixed(1));
}

/** A line dragged up to the other one stops a step before it. */
function draggedMovement([low, high]: Bounds, end: 'low' | 'high', y: number): Bounds {
  const step = MOVEMENT_RANGE.step;
  return end === 'low'
    ? [toleranceAt(y, MOVEMENT_RANGE.min, high - step), high]
    : [low, toleranceAt(y, low + step, MOVEMENT_RANGE.max)];
}

/** Where a flight speed limit sits on its lane, or null at an open end or off the lane's scale. */
function limitY(value: number, open: number, scale: { low: number; high: number } | null): number | null {
  if (!scale || value === open || value < scale.low || value > scale.high) return null;
  return laneY((value - scale.low) / (scale.high - scale.low));
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
  if (!count) return 'No steady range of 2 s or more within these limits';
  if (applied) return `The kept ranges are the ${count} steady ranges`;
  return `Keep the ${count} steady ranges, replacing the kept ranges; adds nothing to the timeline`;
}

function suggestionText(best: SmoothRange | undefined, kind: ShotKind | null, applied: boolean, rate: FrameRate) {
  if (!best || !kind)
    return {
      span: '',
      label: 'No steady range to use',
      hint: 'No steady range of 2 s or more within these limits',
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
  const { telemetry, ranges, limits, setLimits } = smooth;
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
        return { spec, extent, scale, d: seriesPath(spec, telemetry, count, fps, laneY) };
      }),
    [lanes, telemetry, count, fps],
  );
  const roughness = useMemo(() => roughnessPath(profile, count), [profile, count]);
  const cameraMotion = useMemo(() => cameraMotionPath(profile, count, plotY), [profile, count]);
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [nearLine, setNearLine] = useState<'low' | 'high' | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [lowMovement, highMovement] = limits.movement;
  const highY = plotY(highMovement / ROUGHNESS_MAX);
  const lowY = lowMovement > MOVEMENT_RANGE.min ? plotY(lowMovement / ROUGHNESS_MAX) : null;
  const position = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const y = event.clientY - box.top;
    const distance = (lineY: number | null) => (lineY === null ? Infinity : Math.abs(y - (lineY / 100) * IMAGE_PX));
    const nearest: 'low' | 'high' = distance(lowY) < distance(highY) ? 'low' : 'high';
    return {
      frame: Math.min(count - 1, Math.floor(x * count)),
      y: (y / IMAGE_PX) * 100,
      line: Math.min(distance(lowY), distance(highY)) <= LINE_GRAB_PX ? nearest : null,
    };
  };
  const end = (): void => {
    drag.current = null;
    setAdjusting(false);
  };
  const leave = (): void => {
    setHover(null);
    setNearLine(null);
  };
  const at = (value: number): string => `${count === 1 ? 0 : (value / (count - 1)) * 100}%`;

  return (
    <div
      className="source-motion"
      data-disabled={disabled || undefined}
      data-near-tolerance={(nearLine !== null && !disabled) || adjusting || undefined}
      title="Click or drag to scrub; drag a dashed line to change the allowed movement"
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        const point = position(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { kind: point.line ?? 'scrub', pointer: event.pointerId };
        if (point.line) setAdjusting(true);
        else onFrame(point.frame);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        const point = position(event);
        if (current?.pointer === event.pointerId && current.kind !== 'scrub') {
          setLimits({ ...limits, movement: draggedMovement(limits.movement, current.kind, point.y) });
          return;
        }
        setHover(point.frame);
        setNearLine(point.line);
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
        lowY={lowY}
        highY={highY}
        hover={hover}
        movement={adjusting || (nearLine !== null && drag.current === null) ? limits.movement : null}
      />
      {paths.map(({ spec, d, extent, scale }) => (
        <SeriesLane
          key={spec.key}
          spec={spec}
          d={d}
          extent={extent}
          count={count}
          ranges={ranges}
          value={hover === null ? null : seriesValue(spec, telemetry, hover, fps)}
          limits={
            spec.key === 'horizontalSpeed'
              ? [
                  limitY(limits.flightSpeed[0], FLIGHT_SPEED_RANGE.min, scale),
                  limitY(limits.flightSpeed[1], FLIGHT_SPEED_RANGE.max, scale),
                ].filter((y) => y !== null)
              : []
          }
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
        {phase.kind === 'error' ? 'Retry analyzing camera motion' : 'Analyze camera motion'}
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
  const { profile, telemetry, ranges, bestKind, savedLimits, setLimits, previewLimits } = smooth;
  const { collapsed } = view;
  const available = useMemo(() => availableSeries(telemetry), [telemetry]);
  const flightData = available.some((spec) => spec.key === 'horizontalSpeed');
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
            and the green bands steady ranges. Use best sets IN and OUT to the best one, favoring orbits and reveals
            over approaches and nearly still footage; Use all keeps every steady range.
          </p>
          <p className="editor-help-tip">
            Tip: drag the dashed lines, or move Allowed movement and Flight speed, to choose how steady and how fast the
            footage is.
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
          <LimitSetting
            name="Allowed movement"
            title="Jolts a steady range may have: raise the minimum to keep only lively footage, lower the maximum for only very steady footage"
            range={MOVEMENT_RANGE}
            value={savedLimits.movement}
            initial={INITIAL_LIMITS.movement}
            disabled={disabled}
            onCommit={(movement) => setLimits({ ...savedLimits, movement })}
            onDraft={(movement) => previewLimits(movement && { ...savedLimits, movement })}
          />
          {flightData && (
            <LimitSetting
              name="Flight speed"
              title={`Speed the drone flies at in a steady range; at ${FLIGHT_SPEED_RANGE.max} m/s the maximum has no limit`}
              range={FLIGHT_SPEED_RANGE}
              unit="m/s"
              value={savedLimits.flightSpeed}
              initial={INITIAL_LIMITS.flightSpeed}
              disabled={disabled}
              onCommit={(flightSpeed) => setLimits({ ...savedLimits, flightSpeed })}
              onDraft={(flightSpeed) => previewLimits(flightSpeed && { ...savedLimits, flightSpeed })}
            />
          )}
          <LaneChooser available={available} shown={view.shown} onShown={view.show} />
        </div>
      )}
    </section>
  );
}

interface LimitSettingProps {
  name: string;
  title: string;
  range: { min: number; max: number; step: number };
  unit?: string;
  value: Bounds;
  initial: Bounds;
  disabled: boolean;
  onCommit: (value: Bounds) => void;
  onDraft: (value: Bounds | null) => void;
}

/** A named minimum–maximum range of the steady-range limits, with its Reset. */
function LimitSetting({
  name,
  title,
  range,
  unit,
  value,
  initial,
  disabled,
  onCommit,
  onDraft,
}: Readonly<LimitSettingProps>) {
  const id = useId();
  const atInitial = value[0] === initial[0] && value[1] === initial[1];
  return (
    <div className="smooth-panel-tolerance">
      <ResetLabel
        htmlFor={id}
        title={title}
        name={name}
        blocked={resetBlocked(atInitial, disabled)}
        onReset={() => onCommit(initial)}
      >
        {name}
      </ResetLabel>
      <RangeControl
        id={id}
        aria-label={name}
        min={range.min}
        max={range.max}
        step={range.step}
        {...(unit === undefined ? {} : { unit })}
        value={value}
        disabled={disabled}
        title={title}
        resetKey={name}
        onCommit={onCommit}
        onDraft={onDraft}
      />
    </div>
  );
}
