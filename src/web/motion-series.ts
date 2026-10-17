import type { MotionProfile, TelemetryField, TelemetrySample } from '../shared/motion-analysis.js';

export type SeriesKey = TelemetryField;

export interface SeriesSpec {
  key: SeriesKey;
  label: string;
  /** Readout prefix while hovering. */
  short: string;
  format: (value: number) => string;
  /** Smallest top of the scale, so small variations do not fill the plot. */
  floor: number;
  /** Scaled symmetrically around zero. */
  signed?: boolean;
}

const signedText = (value: number, digits: number): string => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

export const SERIES: readonly SeriesSpec[] = [
  {
    key: 'horizontalSpeed',
    label: 'Flight speed',
    short: 'Flight',
    format: (value) => `${value.toFixed(1)} m/s`,
    floor: 16,
  },
  {
    key: 'verticalSpeed',
    label: 'Vertical speed',
    short: 'Vertical',
    format: (value) => `${signedText(value, 1)} m/s`,
    floor: 3,
    signed: true,
  },
  {
    key: 'height',
    label: 'Height',
    short: 'Height',
    format: (value) => `${value.toFixed(0)} m`,
    floor: 20,
  },
  {
    key: 'distance',
    label: 'Distance from home',
    short: 'Distance',
    format: (value) => `${value.toFixed(0)} m`,
    floor: 50,
  },
  { key: 'iso', label: 'ISO', short: 'ISO', format: (value) => value.toFixed(0), floor: 200 },
  {
    key: 'shutter',
    label: 'Shutter speed',
    short: 'Shutter',
    format: (value) => `1/${value.toFixed(0)} s`,
    floor: 100,
  },
  {
    key: 'ev',
    label: 'Exposure bias',
    short: 'EV',
    format: (value) => `${signedText(value, 1)} EV`,
    floor: 1,
    signed: true,
  },
  {
    key: 'digitalZoom',
    label: 'Digital zoom',
    short: 'Zoom',
    format: (value) => `${value.toFixed(1)}×`,
    floor: 2,
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

/** One telemetry line on its own scale, each sample holding for the second after it; breaks at gaps. */
export function seriesPath(
  spec: SeriesSpec,
  telemetry: readonly TelemetrySample[],
  count: number,
  fps: number,
  plotY: (fraction: number) => number,
): string {
  const field = spec.key;
  const line = telemetry
    .filter((sample) => sample.time * fps <= count)
    .map((sample) => ({ x: sample.time * fps, value: sample[field] }));
  const last = telemetry.at(-1);
  if (last && last.time * fps < count) line.push({ x: Math.min(count, (last.time + 1) * fps), value: last[field] });
  const values = line.flatMap((point) => (point.value === null ? [] : [point.value]));
  if (!values.length) return '';
  const peak = Math.max(spec.floor, ...values.map(Math.abs));
  const low = spec.signed ? -peak : Math.min(0, ...values);
  const high = spec.signed ? peak : Math.max(spec.floor, ...values);
  let path = '';
  let pen = 'M';
  for (const point of line) {
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
