import { describe, expect, it } from 'vitest';
import {
  MOTION_ANALYSIS_VERSION,
  motionProfile,
  smoothRanges,
  type MotionAnalysis,
  type TelemetrySample,
} from '../../src/shared/motion-analysis.js';
import {
  bestSteadyRange,
  cameraMotion,
  rankedSmoothRanges,
  rankRanges,
  recordingShots,
  SHOT_SCORE_SECONDS,
  shotKind,
  shotScore,
  type ShotKind,
} from '../../src/shared/recording-shots.js';

const FPS = 30000 / 1001;
const FRAMES = 600;

/** A steady pan, a jolt, then a steady tilt; content displacement per frame in analysis pixels. */
function analysis(telemetry: TelemetrySample[] = []): MotionAnalysis {
  const tx: (number | null)[] = [];
  const ty: (number | null)[] = [];
  for (let frame = 0; frame < FRAMES; frame++) {
    const jolt = frame >= 290 && frame < 320;
    tx.push(frame === 0 ? null : frame < 290 ? 3 : jolt ? (frame % 2 ? 25 : -25) : 0);
    ty.push(frame === 0 ? null : frame >= 320 ? -2 : jolt ? (frame % 3 ? 20 : -20) : 0);
  }
  return {
    version: MOTION_ANALYSIS_VERSION,
    verifiedAt: '2026-10-21T10:00:00.000Z',
    frameCount: FRAMES,
    tx,
    ty,
    zoom: tx.map((value) => (value === null ? null : 0)),
    rotation: tx.map((value) => (value === null ? null : 0)),
    telemetry,
  };
}

function sample(time: number, height: number): TelemetrySample {
  return {
    time,
    horizontalSpeed: 4,
    verticalSpeed: time < 10 ? 0 : 1,
    height,
    distance: 100 + time,
    iso: 100,
    shutter: 500,
    ev: 0,
    digitalZoom: 1,
  };
}

describe('recording shots', () => {
  it('names the camera move from the mean picture movement', () => {
    const motion = analysis();
    expect(cameraMotion(motion, 10, 280, FPS)).toBe('pan left');
    expect(cameraMotion(motion, 330, 600, FPS)).toBe('tilt down');
    expect(cameraMotion({ ...motion, tx: motion.tx.map((value) => value && -value) }, 10, 280, FPS)).toBe('pan right');
    const diagonal = { ...motion, ty: motion.tx.map((value) => value && 2.5) };
    expect(cameraMotion(diagonal, 10, 280, FPS)).toBe('pan left and tilt up');
    const pushing = { ...motion, zoom: motion.zoom.map((value) => (value === null ? null : 0.025)) };
    expect(cameraMotion(pushing, 330, 600, FPS)).toBe('push in and tilt down');
    const still = { ...motion, tx: motion.tx.map((value) => value && 0.001) };
    expect(cameraMotion(still, 10, 280, FPS)).toBe('static');
  });

  it('reports the steady ranges around a jolt with their movement and flight data, in source order', () => {
    const telemetry = Array.from({ length: 21 }, (_, second) => sample(second, 50 + second));
    const { shots, stillShare } = recordingShots(analysis(telemetry), [], undefined, 2, FPS);
    expect(shots.map((shot) => [shot.motion, shot.sourceIn < 290, shot.sourceOut > 320])).toEqual([
      ['pan left', true, false],
      ['tilt down', false, true],
    ]);
    expect(shots[0]!.sourceIn).toBe(0);
    expect(shots[1]!.sourceOut).toBe(FRAMES);
    expect(shots[0]!.speed).toBeCloseTo((3 * 100 * FPS) / 320, 0);
    expect(shots[0]!.roughness).toBeLessThan(2);
    expect(shots[0]!.flight).toMatchObject({ horizontalSpeed: 4, verticalSpeed: 0 });
    expect(shots[1]!.flight!.height).toBeGreaterThan(60);
    expect(stillShare).toBe(0);
  });

  it('keeps steady ranges inside the kept ranges and out of damaged frames', () => {
    const kept = [
      { sourceIn: 100, sourceOut: 200 },
      { sourceIn: 400, sourceOut: 430 },
    ];
    const { shots } = recordingShots(analysis(), [], kept, 2, FPS);
    // 400–430 is one second, shorter than a steady range.
    expect(shots.map((shot) => [shot.sourceIn, shot.sourceOut])).toEqual([[100, 200]]);
    const damaged = recordingShots(analysis(), [{ start: 100, end: 160 }], undefined, 2, FPS).shots;
    expect(damaged.some((shot) => shot.sourceIn < 160 && shot.sourceOut > 100)).toBe(false);
    expect(damaged[0]!.flight).toBeNull();
  });
});

type Movement = Partial<Record<'tx' | 'ty' | 'zoom' | 'rotation', number>>;

/** Steady stretches of `seconds` with movement per frame, separated by one-second jolts. */
function stretches(parts: { seconds: number; movement: Movement | ((frame: number) => Movement) }[]): MotionAnalysis {
  const values = { tx: [], ty: [], zoom: [], rotation: [] } as Record<keyof Movement, (number | null)[]>;
  const push = (movement: Movement) =>
    (Object.keys(values) as (keyof Movement)[]).forEach((key) => values[key].push(movement[key] ?? 0));
  parts.forEach((part, index) => {
    if (index > 0)
      for (let frame = 0; frame < 30; frame++) push({ tx: frame % 2 ? 25 : -25, ty: frame % 3 ? 20 : -20 });
    for (let frame = 0; frame < Math.round(part.seconds * FPS); frame++)
      push(typeof part.movement === 'function' ? part.movement(frame) : part.movement);
  });
  for (const key of Object.keys(values) as (keyof Movement)[]) values[key][0] = null;
  return {
    version: MOTION_ANALYSIS_VERSION,
    verifiedAt: '2026-10-22T10:00:00.000Z',
    frameCount: values.tx.length,
    ...values,
    telemetry: [],
  };
}

/** Flight data every second with these speeds. */
function flying(seconds: number, horizontalSpeed: number, verticalSpeed = 0): TelemetrySample[] {
  return Array.from({ length: seconds }, (_, time) => ({ ...sample(time, 50), horizontalSpeed, verticalSpeed }));
}

describe('ranking steady ranges', () => {
  // 1 analysis pixel per frame is about 9.4 % of the image width per second.
  const approach = { tx: 0.02, zoom: 0.002 };
  // A slow drift to and fro, faster than a hover now and then but barely moving on average.
  const nearlyStill = (frame: number) => ({ tx: 0.03 + 0.04 * Math.sin((2 * Math.PI * frame) / 300) });
  const orbit = { tx: 0.1, rotation: 0.002 };

  it('ranks a short orbit above a long approach and a long nearly still stretch', () => {
    const motion = stretches([
      { seconds: 20, movement: approach },
      { seconds: 20, movement: nearlyStill },
      { seconds: 7, movement: orbit },
    ]);
    const { shots } = recordingShots(motion, [], undefined, 2, FPS);
    expect(shots.map((shot) => [shot.kind, shot.rank])).toEqual([
      ['approach', 2],
      ['static', 3],
      ['orbit', 1],
    ]);
    // Source preview suggests the same range as the assistant's rank 1.
    const ranges = smoothRanges(motionProfile(motion, FPS), 2, FPS);
    expect(ranges[0]).toMatchObject({ sourceIn: shots[0]!.sourceIn });
    const best = rankedSmoothRanges(motion, ranges, FPS)[0]!;
    expect([best.sourceIn, best.sourceOut]).toEqual([shots[2]!.sourceIn, shots[2]!.sourceOut]);
    // Use best in Media keeps the same range.
    expect(bestSteadyRange(motion, [], 2, FPS)).toEqual(best);
    expect(bestSteadyRange(stretches([{ seconds: 1, movement: orbit }]), [], 2, FPS)).toBeNull();
  });

  it('names orbits, reveals, approaches and other moves from the picture and the flight data', () => {
    const kind = (movement: Movement, telemetry: TelemetrySample[] = []) =>
      shotKind({ ...stretches([{ seconds: 10, movement }]), telemetry }, 0, 300, FPS);
    // Sideways movement is an orbit while the drone flies, a pan while it hovers or without flight data.
    expect(kind({ tx: 0.3 }, flying(10, 4))).toBe('orbit');
    expect(kind({ tx: 0.3 }, flying(10, 0.2))).toBe('move');
    expect(kind({ tx: 0.3 })).toBe('move');
    expect(kind({ tx: 0.1, rotation: 0.002 })).toBe('orbit');
    expect(kind({ zoom: -0.003 })).toBe('reveal');
    expect(kind({ zoom: 0.003 }, flying(10, 6, 2))).toBe('reveal');
    expect(kind({ zoom: 0.003 }, flying(10, 6))).toBe('approach');
    // Content moving down may be a forward flight looking down: not a reveal.
    expect(kind({ ty: 0.3 }, flying(10, 4))).toBe('move');
    expect(kind({ tx: 0.02 })).toBe('static');
  });

  it('counts length up to ten seconds, then prefers the longer range, then the earlier', () => {
    const ranges = [
      { sourceIn: 0, sourceOut: 120 },
      { sourceIn: 200, sourceOut: 500 },
      { sourceIn: 600, sourceOut: 1200 },
      { sourceIn: 1300, sourceOut: 1900 },
    ];
    const kinds = new Map<number, ShotKind>([
      [0, 'orbit'],
      [200, 'move'],
      [600, 'approach'],
      [1300, 'approach'],
    ]);
    // 10 s of move (7) beats 20 s of approach (4) and 4 s of orbit (4); equal approaches keep source order.
    expect(rankRanges(ranges, (range) => kinds.get(range.sourceIn)!, FPS).map((range) => range.sourceIn)).toEqual([
      200, 0, 600, 1300,
    ]);
    expect(shotScore('orbit', 600, FPS)).toBe(SHOT_SCORE_SECONDS);
  });
});
