import { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { analyzeProxy, blockSpectra, estimateMotion, measureFrames, parseTelemetry } from '../../src/server/motion.js';
import { MotionPool } from '../../src/server/motion-pool.js';
import {
  FLIGHT_SPEED_RANGE,
  MOTION_ANALYSIS_VERSION,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  motionAnalysisSchema,
  motionProfile,
  smoothRanges,
  steadyLimits,
  STILL_SPEED,
  telemetryAt,
  type MotionAnalysis,
} from '../../src/shared/motion-analysis.js';

const FPS = 30000 / 1001;

/** A measured profile without flight data. */
const measured = (roughness: number[], speed: number[]) => ({
  roughness,
  speed,
  flightSpeed: roughness.map(() => null),
});

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

/** Content point p moves to p + t + zoom·p + rotation·perp(p) about the center. */
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

  it('measures chunks, in process or on worker threads, exactly like one pass', async () => {
    const bytes = MOTION_WIDTH * MOTION_HEIGHT;
    const frames = new Uint8Array(7 * bytes);
    for (let index = 0; index < 7; index++) frames.set(render(index * 1.5, -index, index * 0.002, 0), index * bytes);
    const serial = measureFrames(frames, false);
    expect(serial).toHaveLength(7);
    expect(serial[0]).toBeNull();
    // Each chunk after the first starts with the frame before it.
    const chunks = [frames.slice(0, 3 * bytes), frames.slice(2 * bytes, 6 * bytes), frames.slice(5 * bytes)];
    expect(chunks.flatMap((chunk, index) => measureFrames(chunk, index > 0))).toEqual(serial);
    const pool = MotionPool.forHost(3)!;
    try {
      expect(pool.threads).toBe(2);
      const measured = await Promise.all(
        chunks.map((chunk, index) => pool.measure(index, { frames: chunk, withPrevious: index > 0 })),
      );
      expect(measured.flat()).toEqual(serial);
      expect(chunks[0]!.byteLength).toBe(0);
    } finally {
      await pool.close();
    }
    expect(MotionPool.forHost(2)).toBeNull();
  });

  it('never signals a decoder that failed to start, which Node would send to the whole process group (#263)', async () => {
    // Recorded, not sent: the signal of a failed spawn goes to kill(0), the test runner's own group.
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(false);
    try {
      const controller = new AbortController();
      controller.abort();
      // A job reaches the decoder within a microtask, before the failed spawn reports itself on the next tick.
      await Promise.resolve();
      await expect(
        analyzeProxy('/pascap-missing-ffmpeg', 'proxy.mp4', 30, 'verified', controller.signal, () => {}),
      ).rejects.toThrow('Job canceled.');
      const unstarted = (kill.mock.contexts as ChildProcess[]).filter((child) => child.pid === undefined);
      expect(unstarted.map((child) => child.spawnfile)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
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
    const [best, ...others] = smoothRanges(profile, steadyLimits(2), FPS);
    expect(best!.sourceIn).toBeGreaterThan(55);
    expect(best!.sourceIn).toBeLessThan(110);
    expect(best!.sourceOut).toBeGreaterThan(330);
    expect(best!.sourceOut).toBeLessThanOrEqual(370);
    for (const other of others)
      expect(other.sourceOut - other.sourceIn).toBeLessThanOrEqual(best!.sourceOut - best!.sourceIn);
  });

  it('suggests the whole recording when it is steady from start to end', () => {
    const profile = motionProfile(analysis([null, ...Array.from({ length: 299 }, () => 1)]), FPS);
    expect(smoothRanges(profile, steadyLimits(2), FPS)).toEqual([{ sourceIn: 0, sourceOut: 300 }]);
  });

  it('leaves out a steady range where the camera does not move at all', () => {
    const roughness = Array.from({ length: 600 }, (_, frame) => (frame >= 280 && frame < 320 ? 5 : 0));
    const hoverThenPan = Array.from({ length: 600 }, (_, frame) => (frame < 300 ? 0.1 : 3));
    expect(smoothRanges(measured(roughness, hoverThenPan), steadyLimits(2), FPS)).toEqual([
      { sourceIn: 326, sourceOut: 600 },
    ]);
    // A few moving frames among still ones do not make a hover interesting; a slow drift does.
    const nudged = hoverThenPan.map((speed, frame) => (frame === 100 ? 3 : speed));
    expect(smoothRanges(measured(roughness, nudged), steadyLimits(2), FPS)).toHaveLength(1);
    const drift = hoverThenPan.map((speed, frame) => (frame < 300 ? STILL_SPEED + 0.1 : speed));
    expect(smoothRanges(measured(roughness, drift), steadyLimits(2), FPS)).toHaveLength(2);
  });

  it('bridges a short jolt but not a long one, and needs two seconds', () => {
    const moving = (roughness: number[]) =>
      measured(
        roughness,
        roughness.map(() => 3),
      );
    const rough = (start: number, length: number) =>
      moving(Array.from({ length: 600 }, (_, frame) => (frame >= start && frame < start + length ? 5 : 0)));
    expect(smoothRanges(rough(300, 10), steadyLimits(2), FPS)).toEqual([{ sourceIn: 0, sourceOut: 600 }]);
    expect(smoothRanges(rough(300, 30), steadyLimits(2), FPS)).toEqual([
      { sourceIn: 0, sourceOut: 294 },
      { sourceIn: 336, sourceOut: 600 },
    ]);
    expect(smoothRanges(moving(Array.from({ length: 50 }, () => 0)), steadyLimits(2), FPS)).toEqual([]);
  });

  it('never includes or bridges damaged frames, even shorter than a bridged jolt', () => {
    const profile = measured(
      Array.from({ length: 600 }, () => 0),
      Array.from({ length: 600 }, () => 3),
    );
    expect(smoothRanges(profile, steadyLimits(2), FPS, [{ start: 300, end: 305 }])).toEqual([
      { sourceIn: 0, sourceOut: 294 },
      { sourceIn: 311, sourceOut: 600 },
    ]);
  });

  it('suggests more footage as the tolerance rises', () => {
    const roughness = Array.from({ length: 600 }, (_, frame) => (frame < 100 ? 3 : 1));
    const profile = measured(
      roughness,
      roughness.map(() => 3),
    );
    expect(smoothRanges(profile, steadyLimits(2), FPS)[0]).toEqual({ sourceIn: 106, sourceOut: 600 });
    expect(smoothRanges(profile, steadyLimits(4), FPS)[0]).toEqual({ sourceIn: 0, sourceOut: 600 });
  });

  it('keeps only frames whose jolts reach the minimum of the allowed movement', () => {
    const roughness = Array.from({ length: 600 }, (_, frame) => (frame < 300 ? 0.5 : 1.5));
    const profile = measured(
      roughness,
      roughness.map(() => 3),
    );
    expect(smoothRanges(profile, { ...steadyLimits(2), movement: [1, 2] }, FPS)).toEqual([
      { sourceIn: 306, sourceOut: 600 },
    ]);
    expect(smoothRanges(profile, { ...steadyLimits(2), movement: [0, 1] }, FPS)).toEqual([
      { sourceIn: 0, sourceOut: 294 },
    ]);
  });

  it('keeps only frames flown within the flight speed range, judging none where the drone recorded no speed', () => {
    const roughness = Array.from({ length: 900 }, () => 0);
    const speed = roughness.map(() => 3);
    // 2 m/s for 10 s, then 8 m/s, with no speed recorded over the last 10 s.
    const flightSpeed = roughness.map((_, frame) => {
      if (frame < 300) return 2;
      return frame < 600 ? 8 : null;
    });
    const profile = { roughness, speed, flightSpeed };
    const limits = (low: number, high: number) => ({ ...steadyLimits(2), flightSpeed: [low, high] as const });
    expect(smoothRanges(profile, limits(0, 5), FPS)).toEqual([
      { sourceIn: 0, sourceOut: 294 },
      { sourceIn: 606, sourceOut: 900 },
    ]);
    expect(smoothRanges(profile, limits(5, 10), FPS)).toEqual([{ sourceIn: 306, sourceOut: 900 }]);
    // At the slider's top the maximum is open.
    expect(smoothRanges(profile, limits(5, FLIGHT_SPEED_RANGE.max), FPS)).toEqual([{ sourceIn: 306, sourceOut: 900 }]);
    const faster = { ...profile, flightSpeed: flightSpeed.map((value) => value && value * 3) };
    expect(smoothRanges(faster, limits(7, 20), FPS)).toEqual([{ sourceIn: 306, sourceOut: 900 }]);
    expect(smoothRanges(faster, limits(7, 19), FPS)).toEqual([{ sourceIn: 606, sourceOut: 900 }]);
  });

  it('reads the flight speed of every frame like the flight data lanes', () => {
    const telemetry = [0, 1, 2].map((time) => ({
      time: time + 0.5,
      horizontalSpeed: time === 1 ? null : 2 + 2 * time,
      verticalSpeed: null,
      height: null,
      distance: null,
      iso: null,
      shutter: null,
      ev: null,
      digitalZoom: null,
    }));
    const tx = [null, ...Array.from({ length: 149 }, () => 1)];
    const { flightSpeed } = motionProfile({ ...analysis(tx), telemetry }, FPS);
    expect(flightSpeed).toHaveLength(150);
    flightSpeed.forEach((value, frame) => expect(value).toBe(telemetryAt(telemetry, 'horizontalSpeed', frame, FPS)));
    expect(flightSpeed.slice(0, 15).every((value) => value === null)).toBe(true);
    expect(flightSpeed[15]).toBe(2);
    expect(flightSpeed[90]).toBe(6);
    expect(flightSpeed[149]).toBeNull();
  });

  it('rejects analyses whose arrays do not match the frame count', () => {
    expect(motionAnalysisSchema.safeParse(analysis([null, 1, 2])).success).toBe(true);
    expect(motionAnalysisSchema.safeParse({ ...analysis([null, 1, 2]), frameCount: 4 }).success).toBe(false);
    expect(motionAnalysisSchema.safeParse({ ...analysis([null, 1]), extra: true }).success).toBe(false);
  });
});
