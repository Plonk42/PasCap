import { describe, expect, it } from 'vitest';
import { analyseFeatures, MusicFeatureExtractor } from '../../src/server/music-analysis.js';
import {
  beatBookmarks,
  musicBeatFrames,
  type MusicAnalysis,
  type MusicMeasurement,
} from '../../src/shared/music-analysis.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import { MAX_BOOKMARKS, type MusicTrack } from '../../src/shared/model.js';

const RATE = 48_000;
const TOLERANCE = 0.035 * RATE;

/** Deterministic white noise in −1…1. */
function noise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2_147_483_648 - 1;
  };
}

interface Hit {
  time: number;
  gain: number;
  /** A 60 Hz thump under the burst, like a kick drum. */
  low?: boolean;
}

/** Decaying noise bursts at the given times over optional background noise. */
function render(seconds: number, hits: Hit[], background: (time: number) => number = () => 0): Float32Array {
  const signal = new Float32Array(Math.round(seconds * RATE));
  const random = noise(7);
  for (let index = 0; index < signal.length; index++) signal[index] = background(index / RATE) * random();
  for (const { time, gain, low } of hits) {
    const start = Math.round(time * RATE);
    for (let offset = 0; offset < 0.08 * RATE && start + offset < signal.length; offset++) {
      const decay = Math.exp(-offset / (0.012 * RATE));
      const thump = low ? 2 * Math.exp(-offset / (0.04 * RATE)) * Math.sin((2 * Math.PI * 60 * offset) / RATE) : 0;
      signal[start + offset] = signal[start + offset]! + gain * (decay * random() + thump);
    }
  }
  return signal;
}

function beatTimes(bpm: number, offset: number, seconds: number): number[] {
  const times: number[] = [];
  for (let time = offset; time < seconds - 0.1; time += 60 / bpm) times.push(time);
  return times;
}

function analyse(signal: Float32Array, chunk = 65_536): MusicMeasurement {
  const extractor = new MusicFeatureExtractor();
  for (let from = 0; from < signal.length; from += chunk) extractor.push(signal.subarray(from, from + chunk));
  return analyseFeatures(extractor.finish());
}

function fMeasure(found: number[], truth: number[]): number {
  const used = new Set<number>();
  let matched = 0;
  for (const sample of found) {
    const index = truth.findIndex(
      (time, candidate) => !used.has(candidate) && Math.abs(time * RATE - sample) <= TOLERANCE,
    );
    if (index >= 0) {
      used.add(index);
      matched++;
    }
  }
  if (!matched) return 0;
  const precision = matched / found.length;
  const recall = matched / truth.length;
  return (2 * precision * recall) / (precision + recall);
}

const beatSamples = (result: MusicMeasurement): number[] => result.beats.map((beat) => beat.sample);
const downbeatSamples = (result: MusicMeasurement): number[] =>
  result.beats.filter((beat) => beat.downbeat).map((beat) => beat.sample);

describe('music analysis · synthetic signals', () => {
  it.each([60, 75, 90, 110, 128, 150, 174, 200])('finds click-track beats and tempo at %i BPM', (bpm) => {
    const truth = beatTimes(bpm, 0.137 + bpm / 1000, 30);
    const result = analyse(
      render(
        30,
        truth.map((time) => ({ time, gain: 0.5 })),
      ),
    );
    expect(fMeasure(beatSamples(result), truth)).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(result.tempo!.bpm / bpm - 1)).toBeLessThanOrEqual(0.02);
    expect(result.tempo!.confidence).toBeGreaterThan(0.5);
    const errors = result.beats.map((beat) =>
      Math.min(...truth.map((time) => Math.abs(time * RATE - beat.sample) / RATE)),
    );
    expect(errors.reduce((sum, error) => sum + error, 0) / errors.length).toBeLessThan(0.005);
  });

  it.each([85, 140])('follows amplitude-modulated noise at %i BPM', (bpm) => {
    const period = 60 / bpm;
    const offset = 0.31;
    const truth = beatTimes(bpm, offset, 30);
    const signal = render(30, [], (time) =>
      time < offset ? 0.1 : 0.1 + 0.6 * Math.exp(-((time - offset) % period) / 0.06),
    );
    const result = analyse(signal);
    expect(fMeasure(beatSamples(result), truth)).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(result.tempo!.bpm / bpm - 1)).toBeLessThanOrEqual(0.02);
  });

  it('keeps the beat under swung off-beats and background noise', () => {
    const truth = beatTimes(100, 0.5, 30);
    const hits = truth.flatMap((time) => [
      { time, gain: 0.6 },
      { time: time + (2 / 3) * 0.6, gain: 0.3 },
    ]);
    const result = analyse(render(30, hits, () => 0.05));
    expect(fMeasure(beatSamples(result), truth)).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(result.tempo!.bpm / 100 - 1)).toBeLessThanOrEqual(0.02);
  });

  it('follows a tempo change and reports it in the tempo curve', () => {
    const slow = beatTimes(100, 0.25, 20);
    const fast = beatTimes(130, slow.at(-1)! + 0.6, 40);
    const truth = [...slow, ...fast];
    const result = analyse(
      render(
        40,
        truth.map((time) => ({ time, gain: 0.5 })),
      ),
    );
    expect(fMeasure(beatSamples(result), truth)).toBeGreaterThanOrEqual(0.95);
    const curve = result.tempo!.curve;
    expect(curve[0]!.fromSample).toBe(0);
    expect(Math.abs(curve[0]!.bpm / 100 - 1)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(curve.at(-1)!.bpm / 130 - 1)).toBeLessThanOrEqual(0.02);
  });

  it.each([
    { beatsPerBar: 4, bpm: 120 },
    { beatsPerBar: 3, bpm: 96 },
  ] as const)('finds accented downbeats in $beatsPerBar-beat bars', ({ beatsPerBar, bpm }) => {
    const truth = beatTimes(bpm, 0.4, 40);
    // The track starts on its second beat, so the first beat is not a downbeat.
    const downbeat = (index: number): boolean => (index + 1) % beatsPerBar === 0;
    const hits = truth.map((time, index) => ({ time, gain: downbeat(index) ? 0.8 : 0.4, low: downbeat(index) }));
    const result = analyse(render(40, hits, () => 0.02));
    expect(fMeasure(beatSamples(result), truth)).toBeGreaterThanOrEqual(0.95);
    expect(result.meter?.beatsPerBar).toBe(beatsPerBar);
    expect(
      fMeasure(
        downbeatSamples(result),
        truth.filter((_, index) => downbeat(index)),
      ),
    ).toBeGreaterThanOrEqual(0.8);
  });

  it('places section boundaries at loudness steps and names quiet and peak sections', () => {
    const truth = beatTimes(120, 0.2, 60);
    const loud = (time: number): boolean => time >= 20 && time < 40;
    const hits = truth.map((time) => ({ time, gain: loud(time) ? 0.8 : 0.1 }));
    const result = analyse(render(60, hits, (time) => (loud(time) ? 0.2 : 0.02)));
    expect(result.sections.map((section) => section.kind)).toEqual(['quiet', 'peak', 'quiet']);
    const [, middle] = result.sections;
    expect(Math.abs(middle!.fromSample - 20 * RATE)).toBeLessThanOrEqual(RATE);
    expect(Math.abs(middle!.toSample - 40 * RATE)).toBeLessThanOrEqual(RATE);
    expect(result.sections[0]!.fromSample).toBe(0);
    expect(result.sections.at(-1)!.toSample).toBe(result.samples);
    expect(middle!.loudnessDb).toBeGreaterThan(result.sections[0]!.loudnessDb + 10);
    expect(result.loudness).toHaveLength(600);
  });

  it('names a steady crescendo a build', () => {
    const truth = beatTimes(120, 0.2, 40);
    const level = (time: number): number => (time < 20 ? 0.02 : 0.02 * 10 ** ((time - 20) / 10));
    const result = analyse(
      render(
        40,
        truth.map((time) => ({ time, gain: 0.3 })),
        level,
      ),
    );
    expect(result.sections.map((section) => section.kind)).toContain('build');
  });

  it('marks accents on hits far stronger than the rest', () => {
    const truth = beatTimes(120, 0.2, 30);
    const strong = new Set([10, 31, 47]);
    const result = analyse(
      render(
        30,
        truth.map((time, index) => ({ time, gain: strong.has(index) ? 1 : 0.1 })),
      ),
    );
    const accents = result.accents.filter((accent) => accent.strength > 0.6).map((accent) => accent.sample);
    expect(
      fMeasure(
        accents,
        [...strong].map((index) => truth[index]!),
      ),
    ).toBe(1);
  });

  it('is deterministic and independent of the streamed block size', () => {
    const truth = beatTimes(123, 0.21, 20);
    const signal = render(
      20,
      truth.map((time) => ({ time, gain: 0.5 })),
      () => 0.03,
    );
    const first = analyse(signal);
    expect(analyse(signal)).toEqual(first);
    expect(analyse(signal, 4_801)).toEqual(first);
  });

  it('reports silence without tempo, beats or accents', () => {
    const result = analyse(new Float32Array(10 * RATE));
    expect(result).toMatchObject({ tempo: null, meter: null, beats: [], accents: [], samples: 10 * RATE });
    expect(result.sections).toEqual([{ fromSample: 0, toSample: 10 * RATE, kind: 'quiet', loudnessDb: -120 }]);
    expect(result.loudness.every((value) => value === -120)).toBe(true);
  });

  it('finds no tempo in a held tone with a single onset', () => {
    const signal = Float32Array.from(
      { length: 6 * RATE },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / RATE),
    );
    expect(analyse(signal)).toMatchObject({ tempo: null, meter: null, beats: [] });
  });
});

describe('music beats at project frames', () => {
  const beats: MusicAnalysis['beats'] = [0, 10, 20, 30, 40].map((frame, index) => ({
    sample: Math.round(frame * MUSIC_SAMPLES_PER_FRAME),
    strength: 1,
    downbeat: index % 2 === 0,
  }));
  const track = (patch: Partial<MusicTrack>): MusicTrack => ({
    id: 'music',
    mediaId: 'audio-1',
    sourceIn: 0,
    sourceOut: 50,
    start: 100,
    duration: 50,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    ...patch,
  });

  it('offsets beats by the placement and drops those outside the selected range', () => {
    expect(musicBeatFrames(track({ sourceIn: 10, sourceOut: 35, duration: 25 }), beats)).toEqual([
      { frame: 100, downbeat: false, strength: 1 },
      { frame: 110, downbeat: true, strength: 1 },
      { frame: 120, downbeat: false, strength: 1 },
    ]);
  });

  it('repeats beats across loop wraps up to the placement end', () => {
    const placed = musicBeatFrames(track({ sourceIn: 5, sourceOut: 30, duration: 70, loop: true }), beats);
    expect(placed.map((beat) => beat.frame)).toEqual([105, 115, 130, 140, 155, 165]);
    expect(placed.map((beat) => beat.downbeat)).toEqual([false, true, false, true, false, true]);
  });

  it('places fractional source positions on the nearest project frame', () => {
    const sample = Math.round(12.6 * MUSIC_SAMPLES_PER_FRAME);
    expect(musicBeatFrames(track({}), [{ sample, strength: 0.5, downbeat: false }])).toEqual([
      { frame: 113, downbeat: false, strength: 0.5 },
    ]);
  });

  it('turns beats or downbeats into new bookmarks only, never a partial add past the limit', () => {
    const music = track({ sourceIn: 5, sourceOut: 30, duration: 70, loop: true });
    expect(beatBookmarks([], music, beats, 'beats')).toEqual({
      frames: [105, 115, 130, 140, 155, 165],
      reason: '',
    });
    expect(beatBookmarks([0, 115, 140], music, beats, 'downbeats')).toEqual({ frames: [165], reason: '' });
    expect(beatBookmarks([115, 140, 165], music, beats, 'downbeats')).toEqual({
      frames: [],
      reason: 'Every downbeat of this music track is already a bookmark.',
    });
    const full = Array.from({ length: MAX_BOOKMARKS - 4 }, (_, index) => 1_000 + index);
    expect(beatBookmarks(full, music, beats, 'beats')).toEqual({
      frames: [105, 115, 130, 140, 155, 165],
      reason: '6 beats would exceed 1,000 bookmarks (996 already set). Add downbeats only instead.',
    });
    expect(beatBookmarks(full, music, beats, 'downbeats').reason).toBe('');
    const unaccented = beats.map((beat) => ({ ...beat, downbeat: false }));
    expect(beatBookmarks([], music, unaccented, 'downbeats')).toEqual({
      frames: [],
      reason: "No downbeats fall within this music track's placement.",
    });
  });
});
