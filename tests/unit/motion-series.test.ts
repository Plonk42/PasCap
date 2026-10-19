import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '../../src/shared/motion-analysis.js';
import {
  areaUnder,
  availableSeries,
  cameraMotionPath,
  CAMERA_MOTION_MAX,
  SERIES,
  seriesPath,
  seriesScale,
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

  it('fills under a line down to the lane bottom, piece by piece', () => {
    expect(areaUnder('M0,50 L10,20 M30,60 L40,40')).toBe(
      'M0,100 L0,50 L10,20 L10,100 Z M30,100 L30,60 L40,40 L40,100 Z',
    );
    expect(areaUnder('')).toBe('');
  });

  it('scales a lane from its lowest to its highest value', () => {
    expect(seriesScale(spec('horizontalSpeed'), telemetry, 90, FPS)).toEqual({ min: 2, max: 8, low: 2, high: 8 });
    expect(seriesPath(spec('horizontalSpeed'), telemetry, 90, FPS, identity)).toBe(
      'M0.0,0.0 L30.0,0.3 L60.0,1.0 L90.0,1.0',
    );
  });

  it('widens a nearly flat lane around its values so noise does not fill it', () => {
    const flat = [0, 1].map((time) => ({ ...empty, time, height: 40 + time }));
    expect(seriesScale(spec('height'), flat, 60, FPS)).toEqual({ min: 40, max: 41, low: 38, high: 43 });
    expect(seriesScale(spec('iso'), telemetry, 90, FPS)).toBeNull();
  });

  it('plots camera motion on a fixed scale so recordings compare', () => {
    const speed = [0, CAMERA_MOTION_MAX / 2, CAMERA_MOTION_MAX];
    expect(cameraMotionPath({ speed, roughness: [0, 0, 0] }, 3, identity)).toBe('M0.5,0.0 L1.5,0.5 L2.5,1.0');
  });

  it('stops camera motion at the last measured proxy frame when the original has one more', () => {
    const speed = [0, CAMERA_MOTION_MAX];
    expect(cameraMotionPath({ speed, roughness: [0, 0] }, 3, identity)).toBe('M0.5,0.0 L1.5,1.0');
  });
});
