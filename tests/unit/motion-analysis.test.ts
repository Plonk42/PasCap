import { describe, expect, it } from 'vitest';
import { blockSpectra, estimateMotion } from '../../src/server/motion.js';
import {
  MOTION_ANALYSIS_VERSION,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  motionAnalysisSchema,
  motionRoughness,
  smoothRanges,
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
  };
}

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
    const roughness = motionRoughness(analysis(tx), FPS);
    expect(Math.max(...roughness.slice(120, 300))).toBeLessThan(0.5);
    const [best, ...others] = smoothRanges(roughness, 2, FPS);
    expect(best!.sourceIn).toBeGreaterThan(55);
    expect(best!.sourceIn).toBeLessThan(110);
    expect(best!.sourceOut).toBeGreaterThan(330);
    expect(best!.sourceOut).toBeLessThanOrEqual(370);
    for (const other of others)
      expect(other.sourceOut - other.sourceIn).toBeLessThanOrEqual(best!.sourceOut - best!.sourceIn);
  });

  it('suggests the whole recording when it is steady from start to end', () => {
    const roughness = motionRoughness(analysis([null, ...Array.from({ length: 299 }, () => 1)]), FPS);
    expect(smoothRanges(roughness, 2, FPS)).toEqual([{ sourceIn: 0, sourceOut: 300 }]);
  });

  it('bridges a short jolt but not a long one, and needs two seconds', () => {
    const rough = (start: number, length: number): number[] =>
      Array.from({ length: 600 }, (_, frame) => (frame >= start && frame < start + length ? 5 : 0));
    expect(smoothRanges(rough(300, 10), 2, FPS)).toEqual([{ sourceIn: 0, sourceOut: 600 }]);
    expect(smoothRanges(rough(300, 30), 2, FPS)).toEqual([
      { sourceIn: 0, sourceOut: 294 },
      { sourceIn: 336, sourceOut: 600 },
    ]);
    expect(
      smoothRanges(
        Array.from({ length: 50 }, () => 0),
        2,
        FPS,
      ),
    ).toEqual([]);
  });

  it('suggests more footage as the tolerance rises', () => {
    const roughness = Array.from({ length: 600 }, (_, frame) => (frame < 100 ? 3 : 1));
    expect(smoothRanges(roughness, 2, FPS)[0]).toEqual({ sourceIn: 106, sourceOut: 600 });
    expect(smoothRanges(roughness, 4, FPS)[0]).toEqual({ sourceIn: 0, sourceOut: 600 });
  });

  it('rejects analyses whose arrays do not match the frame count', () => {
    expect(motionAnalysisSchema.safeParse(analysis([null, 1, 2])).success).toBe(true);
    expect(motionAnalysisSchema.safeParse({ ...analysis([null, 1, 2]), frameCount: 4 }).success).toBe(false);
    expect(motionAnalysisSchema.safeParse({ ...analysis([null, 1]), extra: true }).success).toBe(false);
  });
});
