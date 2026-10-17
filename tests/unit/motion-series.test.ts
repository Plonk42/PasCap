import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '../../src/shared/motion-analysis.js';
import { availableSeries, SERIES, seriesPath, seriesValue } from '../../src/web/motion-series.js';

const FPS = 30;
const profile = { speed: Array.from({ length: 90 }, (_, frame) => frame / 10), roughness: new Array(90).fill(0) };
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

describe('motion timeline series', () => {
  it('offers camera motion and only the telemetry values the recording has', () => {
    expect(availableSeries([]).map((candidate) => candidate.key)).toEqual(['motion']);
    expect(availableSeries(telemetry).map((candidate) => candidate.key)).toEqual([
      'motion',
      'horizontalSpeed',
      'height',
    ]);
  });

  it('reads camera motion per frame and telemetry between its samples, holding the last second', () => {
    expect(seriesValue(spec('motion'), profile, telemetry, 25, FPS)).toBe(2.5);
    expect(seriesValue(spec('horizontalSpeed'), profile, telemetry, 45, FPS)).toBe(6);
    expect(seriesValue(spec('horizontalSpeed'), profile, telemetry, 89, FPS)).toBe(8);
    expect(seriesValue(spec('height'), profile, telemetry, 15, FPS)).toBe(10);
    expect(seriesValue(spec('height'), profile, telemetry, 45, FPS)).toBeNull();
    expect(seriesValue(spec('height'), profile, telemetry, 65, FPS)).toBe(30);
    expect(seriesValue(spec('horizontalSpeed'), profile, [], 10, FPS)).toBeNull();
  });

  it('breaks a line where a value is missing', () => {
    const path = seriesPath(spec('height'), profile, telemetry, 90, FPS, (fraction) => 100 - fraction * 100);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(seriesPath(spec('iso'), profile, telemetry, 90, FPS, (fraction) => fraction)).toBe('');
  });
});
