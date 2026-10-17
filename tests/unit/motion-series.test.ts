import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '../../src/shared/motion-analysis.js';
import {
  availableSeries,
  cameraMotionPath,
  CAMERA_MOTION_MAX,
  SERIES,
  seriesPath,
  seriesValue,
} from '../../src/web/motion-series.js';

const FPS = 30;
const empty = {
  horizontalSpeed: null,
  verticalSpeed: null,
  height: null,
  distance: null,
  iso: null,
  shutter: null,
  ev: null,
  digitalZoom: null,
};
const telemetry: TelemetrySample[] = [
  { ...empty, time: 0, horizontalSpeed: 2, height: 10 },
  { ...empty, time: 1, horizontalSpeed: 4, height: null },
  { ...empty, time: 2, horizontalSpeed: 8, height: 30 },
];
const spec = (key: string) => SERIES.find((candidate) => candidate.key === key)!;
const identity = (fraction: number): number => fraction;

describe('motion timeline series', () => {
  it('offers only the telemetry values the recording has', () => {
    expect(availableSeries([])).toEqual([]);
    expect(availableSeries(telemetry).map((candidate) => candidate.key)).toEqual(['horizontalSpeed', 'height']);
  });

  it('reads telemetry between its samples, holding the last one for a second', () => {
    expect(seriesValue(spec('horizontalSpeed'), telemetry, 45, FPS)).toBe(6);
    expect(seriesValue(spec('horizontalSpeed'), telemetry, 89, FPS)).toBe(8);
    expect(seriesValue(spec('height'), telemetry, 15, FPS)).toBe(10);
    expect(seriesValue(spec('height'), telemetry, 45, FPS)).toBeNull();
    expect(seriesValue(spec('height'), telemetry, 65, FPS)).toBe(30);
    expect(seriesValue(spec('horizontalSpeed'), [], 10, FPS)).toBeNull();
  });

  it('breaks a line where a value is missing', () => {
    expect(seriesPath(spec('height'), telemetry, 90, FPS, identity).match(/M/g)).toHaveLength(2);
    expect(seriesPath(spec('iso'), telemetry, 90, FPS, identity)).toBe('');
  });

  it('plots camera motion on a fixed scale so recordings compare', () => {
    const speed = [0, CAMERA_MOTION_MAX / 2, CAMERA_MOTION_MAX];
    expect(cameraMotionPath({ speed, roughness: [0, 0, 0] }, 3, identity)).toBe('M0.5,0.0 L1.5,0.5 L2.5,1.0');
  });
});
