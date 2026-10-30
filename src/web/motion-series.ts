import type { MotionProfile, TelemetryField, TelemetrySample } from '../shared/motion-analysis.js';

export type SeriesKey = TelemetryField;

export interface SeriesSpec {
  key: SeriesKey;
  label: string;
  /** Readout prefix while hovering. */
  short: string;
  color: string;
  format: (value: number) => string;
  /** Smallest span of the scale, so sensor noise does not fill the lane. */
  minSpan: number;
}

const signedText = (value: number, digits: number): string => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

export const SERIES: readonly SeriesSpec[] = [
  {
    key: 'horizontalSpeed',
    label: 'Flight speed',
    short: 'Flight',
    color: '#7cc4e8',
    format: (value) => `${value.toFixed(1)} m/s`,
    minSpan: 2,
  },
  {
    key: 'verticalSpeed',
    label: 'Vertical speed',
    short: 'Vertical',
    color: '#b9a0ff',
    format: (value) => `${signedText(value, 1)} m/s`,
    minSpan: 1,
  },
  {
    key: 'height',
    label: 'Height',
    short: 'Height',
    color: '#9fe0a8',
    format: (value) => `${value.toFixed(0)} m`,
    minSpan: 5,
  },
  {
    key: 'distance',
    label: 'Distance from home',
    short: 'Distance',
    color: '#ee9fd0',
    format: (value) => `${value.toFixed(0)} m`,
    minSpan: 10,
  },
  { key: 'iso', label: 'ISO', short: 'ISO', color: '#f08f8f', format: (value) => value.toFixed(0), minSpan: 100 },
  {
    key: 'shutter',
    label: 'Shutter speed',
    short: 'Shutter',
    color: '#e2dc82',
    format: (value) => `1/${value.toFixed(0)} s`,
    minSpan: 50,
  },
  {
    key: 'ev',
    label: 'Exposure bias',
    short: 'EV',
    color: '#7fdcd0',
    format: (value) => `${signedText(value, 1)} EV`,
    minSpan: 0.7,
  },
  {
    key: 'digitalZoom',
    label: 'Digital zoom',
    short: 'Zoom',
    color: '#f2f2f2',
    format: (value) => `${value.toFixed(1)}×`,
    minSpan: 0.5,
  },
];

export const DEFAULT_SERIES: readonly SeriesKey[] = ['horizontalSpeed'];
/** % of image width per second at the top of the image lane, so recordings compare at a glance. */
export const CAMERA_MOTION_MAX = 10;
/** At most this many points per line, whatever the recording's length. */
const CHART_POINTS = 600;

/** The telemetry values this recording has. */
export function availableSeries(telemetry: readonly TelemetrySample[]): SeriesSpec[] {
  return SERIES.filter((spec) => telemetry.some((sample) => sample[spec.key] !== null));
}

/** Bucket means of camera motion; `plotY` maps 0 (bottom) – 1 (top) to the viewBox. */
export function cameraMotionPath(profile: MotionProfile, count: number, plotY: (fraction: number) => number): string {
  const frames = Math.min(count, profile.speed.length);
  const step = Math.max(1, Math.ceil(frames / CHART_POINTS));
  const points: string[] = [];
  for (let start = 0; start < frames; start += step) {
    const end = Math.min(frames, start + step);
    let sum = 0;
    for (let frame = start; frame < end; frame++) sum += profile.speed[frame]!;
    points.push(`${((start + end) / 2).toFixed(1)},${plotY(sum / (end - start) / CAMERA_MOTION_MAX).toFixed(1)}`);
  }
  return `M${points.join(' L')}`;
}

/** The area under a line path (or each piece of a broken one) down to the lane's bottom edge, y = 100. */
export function areaUnder(line: string): string {
  return line
    .split('M')
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((piece) => {
      const points = piece.split('L').map((point) => point.trim());
      const first = points[0]!.split(',')[0];
      const last = points.at(-1)!.split(',')[0];
      return `M${first},100 L${points.join(' L')} L${last},100 Z`;
    })
    .join(' ');
}

interface SeriesPoint {
  x: number;
  value: number | null;
}

/** The plotted samples, each holding for the second after it, up to the recording's last frame. */
function seriesPoints(spec: SeriesSpec, telemetry: readonly TelemetrySample[], count: number, fps: number) {
  const field = spec.key;
  const line: SeriesPoint[] = telemetry
    .filter((sample) => sample.time * fps <= count)
    .map((sample) => ({ x: sample.time * fps, value: sample[field] }));
  const last = telemetry.at(-1);
  if (last && last.time * fps < count) line.push({ x: Math.min(count, (last.time + 1) * fps), value: last[field] });
  return line;
}

/** The lane's scale, from the lowest to the highest value, widened around them to at least `minSpan`. */
export function seriesScale(
  spec: SeriesSpec,
  telemetry: readonly TelemetrySample[],
  count: number,
  fps: number,
): { min: number; max: number; low: number; high: number } | null {
  const values = seriesPoints(spec, telemetry, count, fps).flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const widen = Math.max(0, spec.minSpan - (max - min)) / 2;
  return { min, max, low: min - widen, high: max + widen };
}

/** One telemetry line on its own min–max scale; breaks at gaps. */
export function seriesPath(
  spec: SeriesSpec,
  telemetry: readonly TelemetrySample[],
  count: number,
  fps: number,
  plotY: (fraction: number) => number,
): string {
  const scale = seriesScale(spec, telemetry, count, fps);
  if (!scale) return '';
  const { low, high } = scale;
  let path = '';
  let pen = 'M';
  for (const point of seriesPoints(spec, telemetry, count, fps)) {
    if (point.value === null) {
      pen = 'M';
      continue;
    }
    path += `${pen}${point.x.toFixed(1)},${plotY((point.value - low) / (high - low)).toFixed(1)} `;
    pen = 'L';
  }
  return path.trim();
}

/** The telemetry value at a frame, linear between samples and held for a second after the last. */
export function seriesValue(
  spec: SeriesSpec,
  telemetry: readonly TelemetrySample[],
  frame: number,
  fps: number,
): number | null {
  const field = spec.key;
  const seconds = frame / fps;
  const next = telemetry.findIndex((sample) => sample.time > seconds);
  if (next === 0) return null;
  const a = telemetry[next === -1 ? telemetry.length - 1 : next - 1];
  const from = a?.[field] ?? null;
  if (a === undefined || from === null) return null;
  const b = next === -1 ? undefined : telemetry[next];
  const to = b?.[field] ?? null;
  if (b === undefined || to === null) return seconds - a.time <= 1 ? from : null;
  return from + ((to - from) * (seconds - a.time)) / (b.time - a.time);
}
