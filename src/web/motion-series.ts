import type { MotionProfile, TelemetryField, TelemetrySample } from '../shared/motion-analysis.js';

export type SeriesKey = 'motion' | TelemetryField;

export interface SeriesSpec {
  key: SeriesKey;
  label: string;
  /** Readout prefix while hovering. */
  short: string;
  colour: string;
  format: (value: number) => string;
  /** Smallest top of the scale, so small variations do not fill the plot. */
  floor: number;
  /** Scaled symmetrically around zero. */
  signed?: boolean;
}

const signedText = (value: number, digits: number): string => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

export const SERIES: readonly SeriesSpec[] = [
  {
    key: 'motion',
    label: 'Camera motion',
    short: 'Camera',
    colour: '#c9d4e0',
    format: (value) => `${value.toFixed(1)} %/s`,
    floor: 5,
  },
  {
    key: 'horizontalSpeed',
    label: 'Flight speed',
    short: 'Flight',
    colour: '#e6c35c',
    format: (value) => `${value.toFixed(1)} m/s`,
    floor: 16,
  },
  {
    key: 'verticalSpeed',
    label: 'Vertical speed',
    short: 'Vertical',
    colour: '#b58cff',
    format: (value) => `${signedText(value, 1)} m/s`,
    floor: 3,
    signed: true,
  },
  {
    key: 'height',
    label: 'Height',
    short: 'Height',
    colour: '#7cc4e8',
    format: (value) => `${value.toFixed(0)} m`,
    floor: 20,
  },
  {
    key: 'distance',
    label: 'Distance from home',
    short: 'Distance',
    colour: '#e88fc7',
    format: (value) => `${value.toFixed(0)} m`,
    floor: 50,
  },
  { key: 'iso', label: 'ISO', short: 'ISO', colour: '#f0a35e', format: (value) => value.toFixed(0), floor: 200 },
  {
    key: 'shutter',
    label: 'Shutter speed',
    short: 'Shutter',
    colour: '#d8d77a',
    format: (value) => `1/${value.toFixed(0)} s`,
    floor: 100,
  },
  {
    key: 'ev',
    label: 'Exposure bias',
    short: 'EV',
    colour: '#9fe0c0',
    format: (value) => `${signedText(value, 1)} EV`,
    floor: 1,
    signed: true,
  },
  {
    key: 'digitalZoom',
    label: 'Digital zoom',
    short: 'Zoom',
    colour: '#f2f2f2',
    format: (value) => `${value.toFixed(1)}×`,
    floor: 2,
  },
];

export const DEFAULT_SERIES: readonly SeriesKey[] = ['motion', 'horizontalSpeed'];
/** At most this many points per line, whatever the recording's length. */
const CHART_POINTS = 600;

/** Camera motion, and each telemetry value this recording has. */
export function availableSeries(telemetry: readonly TelemetrySample[]): SeriesSpec[] {
  return SERIES.filter(
    (spec) => spec.key === 'motion' || telemetry.some((sample) => sample[spec.key as TelemetryField] !== null),
  );
}

interface Point {
  x: number;
  value: number | null;
}

/** Bucket means of camera motion, or the telemetry samples, each holding for the second after it. */
function points(
  spec: SeriesSpec,
  profile: MotionProfile,
  telemetry: readonly TelemetrySample[],
  count: number,
  fps: number,
): Point[] {
  if (spec.key === 'motion') {
    const step = Math.max(1, Math.ceil(count / CHART_POINTS));
    const result: Point[] = [];
    for (let start = 0; start < count; start += step) {
      const end = Math.min(count, start + step);
      let sum = 0;
      for (let frame = start; frame < end; frame++) sum += profile.speed[frame]!;
      result.push({ x: (start + end) / 2, value: sum / (end - start) });
    }
    return result;
  }
  const field = spec.key;
  const result = telemetry
    .filter((sample) => sample.time * fps <= count)
    .map((sample) => ({ x: sample.time * fps, value: sample[field] }));
  const last = telemetry.at(-1);
  if (last && last.time * fps < count) result.push({ x: Math.min(count, (last.time + 1) * fps), value: last[field] });
  return result;
}

/** An SVG path for one series; `plotY` maps 0 (scale bottom) – 1 (top) to the viewBox. */
export function seriesPath(
  spec: SeriesSpec,
  profile: MotionProfile,
  telemetry: readonly TelemetrySample[],
  count: number,
  fps: number,
  plotY: (fraction: number) => number,
): string {
  const line = points(spec, profile, telemetry, count, fps);
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

/** The value at a frame: camera motion exactly, telemetry linearly between its samples. */
export function seriesValue(
  spec: SeriesSpec,
  profile: MotionProfile,
  telemetry: readonly TelemetrySample[],
  frame: number,
  fps: number,
): number | null {
  if (spec.key === 'motion') return profile.speed[frame] ?? null;
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
