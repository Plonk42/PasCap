import { describe, expect, it } from 'vitest';
import { blockSpectra, estimateMotion, parseTelemetry } from '../../src/server/motion.js';
import {
  MOTION_ANALYSIS_VERSION,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  motionAnalysisSchema,
  motionProfile,
  smoothRanges,
  STILL_SPEED,
  type MotionAnalysis,
} from '../../src/shared/motion-analysis.js';

const FPS = 30000 / 1001;

let seed = 7;
const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
const waves = Array.from({ length: 60 }, () => {
  const frequency = 0.03 + random() * 0.5;
  const angle = random() * Math.PI * 2;
  return {
    kx: frequency * Math.cos(angle),
    ky: frequency * Math.sin(angle),
    phase: random() * Math.PI * 2,
    amplitude: 12 / (1 + frequency * 6),
  };
});
function scene(x: number, y: number): number {
  let value = 128;
  for (const wave of waves) value += wave.amplitude * Math.sin(wave.kx * x + wave.ky * y + wave.phase);
  return value;
}

/** Content point p moves to p + t + zoom·p + rotation·perp(p) about the centre. */
function render(tx: number, ty: number, zoom: number, rotation: number): Uint8Array {
  const frame = new Uint8Array(MOTION_WIDTH * MOTION_HEIGHT);
  const scale = 1 + zoom;
  const determinant = scale * scale + rotation * rotation;
  for (let y = 0; y < MOTION_HEIGHT; y++)
    for (let x = 0; x < MOTION_WIDTH; x++) {
      const qx = x - MOTION_WIDTH / 2 - tx;
      const qy = y - MOTION_HEIGHT / 2 - ty;
      const sx = (scale * qx + rotation * qy) / determinant;
      const sy = (scale * qy - rotation * qx) / determinant;
      frame[y * MOTION_WIDTH + x] = Math.round(scene(sx + MOTION_WIDTH / 2, sy + MOTION_HEIGHT / 2));
    }
  return frame;
}

function analysis(tx: (number | null)[]): MotionAnalysis {
  const zeros = tx.map((value) => (value === null ? null : 0));
  return {
    version: MOTION_ANALYSIS_VERSION,
    verifiedAt: '2026-10-16T00:00:00.000Z',
    frameCount: tx.length,
    tx,
    ty: zeros,
    zoom: zeros,
    rotation: zeros,
    telemetry: [],
  };
}

const NO_VALUES = {
  horizontalSpeed: null,
  verticalSpeed: null,
  height: null,
  distance: null,
  iso: null,
  shutter: null,
  ev: null,
  digitalZoom: null,
};

describe('recorded telemetry', () => {
  it('reads every value of the DJI telemetry subtitles and ignores other text', () => {
    const srt = [
      '1\n00:00:00,000 --> 00:00:01,000\nF/1.7, SS 747.99, ISO 100, EV 0, DZOOM 1.000, GPS (5.9271, 45.0521, 23), D 26.20m, H 26.80m, H.S 0.00m/s, V.S -0.00m/s \n',
      '2\n00:00:01,000 --> 00:00:02,000\nF/1.7, SS 642.76, ISO 400, EV +0.7, DZOOM 2.000, GPS (5.9281, 45.0532, 23), D 170.79m, H -2.50m, H.S 10.24m/s, V.S -0.50m/s \n',
      '3\n01:02:03,500 --> 01:02:04,500\nH.S -3.5m/s\n',
      '4\n00:00:04,000 --> 00:00:05,000\nA caption without telemetry\n',
    ].join('\n');
    expect(parseTelemetry(srt)).toEqual([
      {
        time: 0,
        horizontalSpeed: 0,
        verticalSpeed: -0,
        height: 26.8,
        distance: 26.2,
        iso: 100,
        shutter: 747.99,
        ev: 0,
        digitalZoom: 1,
      },
      {
        time: 1,
        horizontalSpeed: 10.24,
        verticalSpeed: -0.5,
        height: -2.5,
        distance: 170.79,
        iso: 400,
        shutter: 642.76,
        ev: 0.7,
        digitalZoom: 2,
      },
      { ...NO_VALUES, time: 3723.5, horizontalSpeed: 3.5 },
    ]);
    expect(parseTelemetry('')).toEqual([]);
  });
});

describe('camera motion estimation', () => {
  const base = blockSpectra(render(0, 0, 0, 0));
  it.each([
    { tx: 3.4, ty: -2.2, zoom: 0, rotation: 0 },
    { tx: 0.3, ty: 0.2, zoom: 0, rotation: 0 },
    { tx: -12, ty: 5, zoom: 0, rotation: 0 },
    { tx: 0, ty: 0, zoom: 0.01, rotation: 0 },
    { tx: 0, ty: 0, zoom: 0, rotation: 0.012 },
    { tx: 6, ty: 1.5, zoom: -0.008, rotation: 0.006 },
  ])('measures translation $tx,$ty, zoom $zoom and rotation $rotation', (expected) => {
    const motion = estimateMotion(base, render(expected.tx, expected.ty, expected.zoom, expected.rotation));
    expect(motion).not.toBeNull();
    expect(Math.abs(motion!.tx - expected.tx)).toBeLessThan(0.15);
    expect(Math.abs(motion!.ty - expected.ty)).toBeLessThan(0.15);
    expect(Math.abs(motion!.zoom - expected.zoom)).toBeLessThan(0.0015);
    expect(Math.abs(motion!.rotation - expected.rotation)).toBeLessThan(0.0015);
  });

  it('reports nothing for a featureless frame', () => {
    const flat = new Uint8Array(MOTION_WIDTH * MOTION_HEIGHT).fill(90);
    expect(estimateMotion(blockSpectra(flat), flat)).toBeNull();
  });
});

describe('smooth ranges', () => {
  it('keeps a steady pan and drops the jerky start and end', () => {
    // Jerky reframing for 2 s, a constant pan for 10 s, then braking to a stop.
    const tx = Array.from({ length: 450 }, (_, frame) => {
      if (frame === 0) return null;
      if (frame < 60) return 4 * Math.sin(frame / 3);
      if (frame < 360) return 2;
      return Math.max(0, 2 - (frame - 360) * 0.2);
    });
    const profile = motionProfile(analysis(tx), FPS);
    expect(Math.max(...profile.roughness.slice(120, 300))).toBeLessThan(0.5);
    const [best, ...others] = smoothRanges(profile, 2, FPS);
    expect(best!.sourceIn).toBeGreaterThan(55);
    expect(best!.sourceIn).toBeLessThan(110);
    expect(best!.sourceOut).toBeGreaterThan(330);
    expect(best!.sourceOut).toBeLessThanOrEqual(370);
    for (const other of others)
      expect(other.sourceOut - other.sourceIn).toBeLessThanOrEqual(best!.sourceOut - best!.sourceIn);
  });

  it('suggests the whole recording when it is steady from start to end', () => {
    const profile = motionProfile(analysis([null, ...Array.from({ length: 299 }, () => 1)]), FPS);
    expect(smoothRanges(profile, 2, FPS)).toEqual([{ sourceIn: 0, sourceOut: 300 }]);
  });

  it('leaves out a steady range where the camera does not move at all', () => {
    const roughness = Array.from({ length: 600 }, (_, frame) => (frame >= 280 && frame < 320 ? 5 : 0));
    const hoverThenPan = Array.from({ length: 600 }, (_, frame) => (frame < 300 ? 0.1 : 3));
    expect(smoothRanges({ roughness, speed: hoverThenPan }, 2, FPS)).toEqual([{ sourceIn: 326, sourceOut: 600 }]);
    // A few moving frames among still ones do not make a hover interesting; a slow drift does.
    const nudged = hoverThenPan.map((speed, frame) => (frame === 100 ? 3 : speed));
    expect(smoothRanges({ roughness, speed: nudged }, 2, FPS)).toHaveLength(1);
    const drift = hoverThenPan.map((speed, frame) => (frame < 300 ? STILL_SPEED + 0.1 : speed));
    expect(smoothRanges({ roughness, speed: drift }, 2, FPS)).toHaveLength(2);
  });

  it('bridges a short jolt but not a long one, and needs two seconds', () => {
    const moving = (roughness: number[]) => ({ roughness, speed: roughness.map(() => 3) });
    const rough = (start: number, length: number) =>
      moving(Array.from({ length: 600 }, (_, frame) => (frame >= start && frame < start + length ? 5 : 0)));
    expect(smoothRanges(rough(300, 10), 2, FPS)).toEqual([{ sourceIn: 0, sourceOut: 600 }]);
    expect(smoothRanges(rough(300, 30), 2, FPS)).toEqual([
      { sourceIn: 0, sourceOut: 294 },
      { sourceIn: 336, sourceOut: 600 },
    ]);
    expect(smoothRanges(moving(Array.from({ length: 50 }, () => 0)), 2, FPS)).toEqual([]);
  });

  it('suggests more footage as the tolerance rises', () => {
    const roughness = Array.from({ length: 600 }, (_, frame) => (frame < 100 ? 3 : 1));
    const profile = { roughness, speed: roughness.map(() => 3) };
    expect(smoothRanges(profile, 2, FPS)[0]).toEqual({ sourceIn: 106, sourceOut: 600 });
    expect(smoothRanges(profile, 4, FPS)[0]).toEqual({ sourceIn: 0, sourceOut: 600 });
  });

  it('rejects analyses whose arrays do not match the frame count', () => {
    expect(motionAnalysisSchema.safeParse(analysis([null, 1, 2])).success).toBe(true);
    expect(motionAnalysisSchema.safeParse({ ...analysis([null, 1, 2]), frameCount: 4 }).success).toBe(false);
    expect(motionAnalysisSchema.safeParse({ ...analysis([null, 1]), extra: true }).success).toBe(false);
  });
});
