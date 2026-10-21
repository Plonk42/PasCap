import { describe, expect, it } from 'vitest';
import {
  MOTION_ANALYSIS_VERSION,
  type MotionAnalysis,
  type TelemetrySample,
} from '../../src/shared/motion-analysis.js';
import { cameraMotion, recordingShots } from '../../src/shared/recording-shots.js';

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
