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

  it('keeps the song tempo through a soft passage instead of following an arpeggio', () => {
    const truth = beatTimes(128, 0.3, 45);
    const soft = (time: number): boolean => time >= 12 && time < 30;
    // A soft passage whose quiet beat sits under a slightly louder arpeggio, 8% faster.
    const arpeggio = beatTimes(60 / 0.432, 12.1, 30).map((time) => ({ time, gain: 0.12 }));
    const hits = [...truth.map((time) => ({ time, gain: soft(time) ? 0.1 : 0.5 })), ...arpeggio];
    const result = analyse(render(45, hits, () => 0.02));
    const inside = (samples: number[]): number[] => samples.filter((sample) => soft(sample / RATE));
    expect(
      fMeasure(
        inside(beatSamples(result)),
        truth.filter((time) => soft(time)),
      ),
    ).toBeGreaterThanOrEqual(0.9);
    expect(Math.abs(result.tempo!.bpm / 128 - 1)).toBeLessThanOrEqual(0.01);
  });

  it('finds downbeats at chord changes when the kick is stronger on the third beat', () => {
    const bpm = 110;
    const truth = beatTimes(bpm, 0.4, 40);
    const chords = [
      [261.6, 329.6, 392],
      [196, 246.9, 293.7],
      [220, 261.6, 329.6],
      [174.6, 220, 261.6],
    ];
    // Bars start on the second beat; the kick sounds on beats one and three, harder on three.
    const signal = render(
      40,
      truth.map((time, index) => ({ time, gain: index % 4 === 3 ? 0.5 : 0.4, low: index % 2 === 1 })),
    );
    // Chords change on every fourth beat from the second one.
    const bar = (4 * 60) / bpm;
    const first = truth[1]!;
    for (let index = 0; index < signal.length; index++) {
      const time = index / RATE;
      const chord = chords[((Math.floor((time - first) / bar) % 4) + 4) % 4]!;
      for (const hz of chord) signal[index] = signal[index]! + 0.05 * Math.sin(2 * Math.PI * hz * time);
    }
    const result = analyse(signal);
    expect(result.meter?.beatsPerBar).toBe(4);
    expect(
      fMeasure(
        downbeatSamples(result),
        truth.filter((_, index) => index % 4 === 1),
      ),
    ).toBeGreaterThanOrEqual(0.8);
  });

  it('follows the bar through an extra half bar', () => {
    // Eight bars of four, one bar of two, eight bars of four: the kick marks every bar start.
    const times = beatTimes(120, 0.25, 40).slice(0, 66);
    const starts = new Set([
      ...Array.from({ length: 8 }, (_, bar) => 4 * bar),
      32,
      ...Array.from({ length: 8 }, (_, bar) => 34 + 4 * bar),
    ]);
    const hits = times.map((time, index) => ({ time, gain: starts.has(index) ? 0.8 : 0.4, low: starts.has(index) }));
    const result = analyse(render(34, hits, () => 0.02));
    expect(
      fMeasure(
        downbeatSamples(result),
        times.filter((_, index) => starts.has(index)),
      ),
    ).toBeGreaterThanOrEqual(0.8);
  });

  it('reports no tempo for hits without a steady pulse', () => {
    const random = noise(5);
    const hits = Array.from({ length: 60 }, () => ({ time: 15 * (random() + 1), gain: 0.3 + 0.2 * random() }));
    expect(analyse(render(30, hits, () => 0.02))).toMatchObject({ tempo: null, meter: null, beats: [] });
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
    // Boundaries sit on downbeats, so a cut there lands on the bar.
    expect(downbeatSamples(result)).toEqual(expect.arrayContaining([middle!.fromSample, middle!.toSample]));
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

  it('measures low, mid and high levels per second', () => {
    // A 100 Hz sine, then a 1 kHz sine, then white noise, each 0.5 peak for 3 s.
    const random = noise(3);
    const signal = Float32Array.from({ length: 9 * RATE }, (_, index) => {
      const time = index / RATE;
      if (time < 3) return 0.5 * Math.sin(2 * Math.PI * 100 * time);
      if (time < 6) return 0.5 * Math.sin(2 * Math.PI * 1_000 * time);
      return 0.5 * random();
    });
    const { tone } = analyse(signal);
    expect(tone).toHaveLength(9);
    const sine = 20 * Math.log10(0.5 / Math.SQRT2);
    expect(tone[1]![0]).toBeCloseTo(sine, 0);
    expect(tone[1]![1]).toBeLessThan(sine - 30);
    expect(tone[4]![1]).toBeCloseTo(sine, 0);
    expect(tone[4]![0]).toBeLessThan(sine - 30);
    // White noise spreads its power by bandwidth: most of it above 4 kHz.
    const [low, mid, high] = tone[7]!;
    expect(high).toBeGreaterThan(mid!);
    expect(mid).toBeGreaterThan(low!);
  });

  it.each([
    {
      key: { tonic: 'C', mode: 'major' },
      chords: [
        [261.6, 329.6, 392],
        [349.2, 440, 523.3],
        [392, 493.9, 587.3],
        [261.6, 329.6, 392],
      ],
    },
    {
      key: { tonic: 'A', mode: 'minor' },
      chords: [
        [440, 523.3, 659.3],
        [587.3, 698.5, 880],
        [659.3, 830.6, 987.8],
        [440, 523.3, 659.3],
      ],
    },
  ])('finds the key $key.tonic $key.mode from its chords', ({ key, chords }) => {
    const signal = Float32Array.from({ length: 16 * RATE }, (_, index) => {
      const time = index / RATE;
      return chords[Math.floor(time / 2) % 4]!.reduce((sum, hz) => sum + 0.1 * Math.sin(2 * Math.PI * hz * time), 0);
    });
    expect(analyse(signal).key).toMatchObject(key);
  });

  it('finds silences of at least 0.3 s, not shorter gaps', () => {
    const gap = (time: number): boolean => (time >= 4 && time < 5) || (time >= 7 && time < 7.15);
    const random = noise(9);
    const signal = Float32Array.from({ length: 10 * RATE }, (_, index) => (gap(index / RATE) ? 0 : 0.3 * random()));
    expect(analyse(signal).silences).toEqual([{ fromSample: 4 * RATE, toSample: 5 * RATE }]);
  });

  it('finds a gradual crescendo and a sudden drop', () => {
    // Noise rising from −40 to −10 dB over 4–14 s, holding, then cut to −40 dB at 20 s.
    const random = noise(13);
    const level = (time: number): number => {
      if (time < 4 || time >= 20) return -40;
      return time < 14 ? -40 + 3 * (time - 4) : -10;
    };
    const signal = Float32Array.from(
      { length: 26 * RATE },
      (_, index) => Math.sqrt(3) * 10 ** (level(index / RATE) / 20) * random(),
    );
    const { swells } = analyse(signal);
    expect(swells).toHaveLength(2);
    const [rise, drop] = swells;
    expect(rise).toMatchObject({ kind: 'crescendo', sudden: false });
    expect(rise!.changeDb).toBeGreaterThan(25);
    expect(Math.abs(rise!.fromSample / RATE - 5)).toBeLessThan(1.5);
    expect(Math.abs(rise!.toSample / RATE - 13)).toBeLessThan(1.5);
    expect(drop).toMatchObject({ kind: 'decrescendo', sudden: true });
    expect(drop!.changeDb).toBeLessThan(-25);
    expect(Math.abs(drop!.fromSample / RATE - 20)).toBeLessThan(0.5);
  });

  it('reports silence without tempo, beats or accents', () => {
    const result = analyse(new Float32Array(10 * RATE));
    expect(result).toMatchObject({ tempo: null, meter: null, beats: [], accents: [], samples: 10 * RATE });
    expect(result.sections).toEqual([{ fromSample: 0, toSample: 10 * RATE, kind: 'quiet', loudnessDb: -120 }]);
    expect(result.loudness.every((value) => value === -120)).toBe(true);
    expect(result).toMatchObject({ key: null, swells: [], silences: [{ fromSample: 0, toSample: 10 * RATE }] });
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
      reason: 'Every downbeat of this music clip is already a bookmark.',
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
      reason: "No downbeats fall within this music clip's placement.",
    });
  });
});
