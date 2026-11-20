import {
  MOTION_ANALYSIS_VERSION,
  type MotionAnalysis,
  type TelemetrySample,
} from '../../src/shared/motion-analysis.js';
import { MUSIC_ANALYSIS_HOP, type MusicAnalysis } from '../../src/shared/music-analysis.js';
import { MUSIC_SAMPLE_RATE } from '../../src/shared/music-format.js';
import type { AnalysisFrame } from '../../src/shared/white-balance.js';

/** Synthetic footage and music for auto edit tests. */

export interface Movement {
  /** Frames of steady movement. */
  frames: number;
  /** Content displacement per frame in analysis pixels, zoom and rotation per frame. */
  tx?: number;
  ty?: number;
  zoom?: number;
  rotation?: number;
}

/** Steady movements separated by one-second jolts, as the motion job measures them. */
export function motion(movements: readonly Movement[], telemetry: TelemetrySample[] = []): MotionAnalysis {
  const tx: (number | null)[] = [null];
  const ty: (number | null)[] = [null];
  const zoom: (number | null)[] = [null];
  const rotation: (number | null)[] = [null];
  movements.forEach((movement, index) => {
    if (index > 0)
      for (let frame = 0; frame < 30; frame++) {
        tx.push(frame % 2 ? 25 : -25);
        ty.push(frame % 3 ? 20 : -20);
        zoom.push(0);
        rotation.push(0);
      }
    for (let frame = 0; frame < movement.frames; frame++) {
      tx.push(movement.tx ?? 0);
      ty.push(movement.ty ?? 0);
      zoom.push(movement.zoom ?? 0);
      rotation.push(movement.rotation ?? 0);
    }
  });
  return {
    version: MOTION_ANALYSIS_VERSION,
    verifiedAt: '2026-11-20T10:00:00.000Z',
    frameCount: tx.length,
    tx,
    ty,
    zoom,
    rotation,
    telemetry,
  };
}

/** Telemetry once per second for `seconds`, at a height and distance. */
export function flight(seconds: number, height: number, distance: number, speed = 4): TelemetrySample[] {
  return Array.from({ length: seconds }, (_, time) => ({
    time,
    horizontalSpeed: speed,
    verticalSpeed: 0,
    height,
    distance,
    iso: 100,
    shutter: 500,
    ev: 0,
    digitalZoom: 1,
  }));
}

export interface SongSection {
  seconds: number;
  kind: 'quiet' | 'build' | 'peak' | 'release';
  loudnessDb: number;
}

/**
 * A click track at `bpm` in 4/4: a beat every beat, a downbeat every bar, a strong low hit on the third beat of
 * every second bar, sections of the given kinds and loudness, and `silence` seconds of leading silence.
 */
export function song(bpm: number, sections: readonly SongSection[], silence = 0): MusicAnalysis {
  const seconds = silence + sections.reduce((sum, section) => sum + section.seconds, 0);
  const samples = Math.round(seconds * MUSIC_SAMPLE_RATE);
  const beatSamples = (60 / bpm) * MUSIC_SAMPLE_RATE;
  const start = Math.round(silence * MUSIC_SAMPLE_RATE);
  const beats = [];
  const hits = [];
  for (let index = 0; start + index * beatSamples < samples; index++) {
    const sample = Math.round(start + index * beatSamples);
    beats.push({ sample, strength: 0.6, downbeat: index % 4 === 0 });
    if (index % 8 === 2) hits.push({ sample, strength: 0.9, band: 'low' as const, strong: true });
  }
  let from = start;
  const placed = sections.map((section) => {
    const to = Math.min(samples, from + Math.round(section.seconds * MUSIC_SAMPLE_RATE));
    const item = { fromSample: from, toSample: to, kind: section.kind, loudnessDb: section.loudnessDb };
    from = to;
    return item;
  });
  const loudness = Array.from({ length: Math.ceil(seconds * 10) }, (_, index) => {
    const sample = (index * MUSIC_SAMPLE_RATE) / 10;
    if (sample < start) return -120;
    return placed.find((section) => sample >= section.fromSample && sample < section.toSample)?.loudnessDb ?? -120;
  });
  return {
    version: 4,
    source: { content: 'a'.repeat(64), bytes: samples * 8, mtimeMs: 1 },
    sampleRate: MUSIC_SAMPLE_RATE,
    hop: MUSIC_ANALYSIS_HOP,
    samples,
    tempo: { bpm, confidence: 0.9, curve: [{ fromSample: 0, bpm }] },
    meter: { beatsPerBar: 4, confidence: 0.8 },
    beats,
    hits,
    loudness,
    tone: Array.from({ length: Math.ceil(seconds) }, () => [-20, -20, -30] as [number, number, number]),
    key: null,
    silences: silence > 0 ? [{ fromSample: 0, toSample: start }] : [],
    swells: [],
    sections: placed,
  };
}

/** A deterministic pseudo-random number in [0, 1). */
function hash(value: number): number {
  const x = Math.sin(value * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

/** A frame of a scene: blocks whose levels depend on `scene`, slightly varied by `variation`. */
export function scene(scene: number, variation = 0, width = 64, height = 36): AnalysisFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const block = Math.floor(x / 8) * 5 + Math.floor(y / 6);
      const level = 40 + 170 * hash(block * 31 + scene * 977) + 6 * hash(block + variation * 13);
      const offset = (y * width + x) * 4;
      data[offset] = Math.round(level * (0.8 + 0.3 * hash(scene + 1)));
      data[offset + 1] = Math.round(level);
      data[offset + 2] = Math.round(level * (0.8 + 0.3 * hash(scene + 2)));
      data[offset + 3] = 255;
    }
  return { width, height, data };
}
