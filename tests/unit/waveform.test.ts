import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detailWaveformLevels } from '../../src/server/audio.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import {
  coarseWaveform,
  decodeWaveform,
  waveformColumnCount,
  waveformColumns,
  WAVEFORM_BUCKET,
  WAVEFORM_MAX_COLUMNS,
  type WaveformLevels,
} from '../../src/shared/waveform.js';
import { waveformPath } from '../../src/web/music-waveform.js';

const RATE = 48_000;

/** Interleaved stereo PCM16 of the given length where `level(frame)` gives the left sample; the right one is half of it. */
function pcm(frames: number, level: (frame: number) => number): Buffer {
  const bytes = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    const left = level(frame);
    bytes.writeInt16LE(left, frame * 4);
    bytes.writeInt16LE(Math.round(left / 2), frame * 4 + 2);
  }
  return bytes;
}

describe('detail waveform reducer', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-waveform-'));
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  async function reduce(name: string, bytes: Buffer): Promise<Int8Array> {
    const filename = path.join(directory, name);
    await writeFile(filename, bytes);
    return detailWaveformLevels(filename);
  }

  it('keeps one minimum and maximum per 10 ms of either channel, for the whole file', async () => {
    const levels = await reduce(
      'ramp.pcm',
      pcm(RATE, (frame) => (frame < RATE / 2 ? 16_384 : -32_768)),
    );
    expect(levels).toHaveLength(2 * 100);
    expect([levels[0], levels[1]]).toEqual([0, 64]);
    expect([levels[2 * 99], levels[2 * 99 + 1]]).toEqual([-127, 0]);
  });

  it('shows a 50 ms click in silence and nothing around it', async () => {
    const click = pcm(RATE * 3, (frame) => (frame >= RATE && frame < RATE + 2400 ? 30_000 : 0));
    const levels = await reduce('click.pcm', click);
    const loud: number[] = [];
    for (let bucket = 0; bucket < levels.length / 2; bucket++) if (levels[bucket * 2 + 1]! > 0) loud.push(bucket);
    expect(loud).toEqual([100, 101, 102, 103, 104]);
    expect(levels[2 * 100 + 1]).toBe(Math.ceil((30_000 * 127) / 32_768));
  });

  it('does not lose a barely audible sample and ends on a short last bucket', async () => {
    const frames = WAVEFORM_BUCKET * 130 + 7;
    const levels = await reduce(
      'quiet.pcm',
      pcm(frames, (frame) => (frame === frames - 1 ? -1 : 0)),
    );
    expect(levels).toHaveLength(2 * 131);
    expect([levels[2 * 130], levels[2 * 130 + 1]]).toEqual([-1, 0]);
    expect([levels[2 * 129], levels[2 * 129 + 1]]).toEqual([0, 0]);
  });

  it('stays 200 bytes per second whatever the length', async () => {
    const levels = await reduce(
      'long.pcm',
      pcm(RATE * 30, (frame) => (frame % 2 === 0 ? 1000 : -1000)),
    );
    expect(levels).toHaveLength(200 * 30);
  });
});

function wave(buckets: [number, number][], bucketSamples = WAVEFORM_BUCKET): WaveformLevels {
  return { bucketSamples, levels: Int8Array.from(buckets.flat()) };
}

describe('waveform columns', () => {
  const seconds = (count: number): number => Math.floor((count * 30_000) / 1001);
  /** Silence with one loud 10 ms bucket at the given second. */
  function hit(at: number, length = 4): WaveformLevels {
    const buckets: [number, number][] = Array.from({ length: 100 * length }, () => [0, 0]);
    buckets[at * 100] = [-100, 127];
    return wave(buckets);
  }
  const clip = (sourceIn: number, sourceOut: number, duration: number, loop = false) => ({
    sourceIn,
    sourceOut,
    duration,
    loop,
  });

  it('keeps a short hit visible however few columns the clip gets', () => {
    const columns = waveformColumns(hit(2), clip(0, seconds(4), seconds(4)), 8);
    expect(Array.from(columns.max).map((value) => value > 0.99)).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(columns.min[4]).toBeCloseTo(-100 / 127);
  });

  it('follows the clip trim: the hit moves left by the trimmed start', () => {
    const columns = waveformColumns(hit(2), clip(seconds(1), seconds(4), seconds(3)), 6);
    expect(Array.from(columns.max).findIndex((value) => value > 0.99)).toBe(2);
  });

  it('repeats the selected range when the clip loops, also across the wrap', () => {
    const duration = seconds(3.4);
    const columns = waveformColumns(hit(2), clip(seconds(1), seconds(3), duration, true), 17);
    const hits = Array.from(columns.max)
      .map((value, index) => (value > 0.99 ? index : -1))
      .filter((index) => index >= 0);
    // Loop length 2 s plays the hit 1 s into every pass: at 1 s and 3 s of a 3.4 s clip, 5 columns per second.
    expect(hits).toEqual([5, 15]);
  });

  it('reads beyond the recording as silence and a one-column clip as its whole range', () => {
    const beyond = waveformColumns(hit(2), clip(0, seconds(5), seconds(5)), 5);
    expect(beyond.max[4]).toBe(0);
    expect(waveformColumns(hit(2), clip(0, seconds(4), seconds(4)), 1).max[0]).toBeGreaterThan(0.99);
  });

  it('draws the stored peaks as a symmetric fallback', () => {
    const coarse = coarseWaveform([0.5, 0, 1], 3 * RATE)!;
    expect(coarse.bucketSamples).toBe(RATE);
    expect(Array.from(coarse.levels)).toEqual([-64, 64, 0, 0, -127, 127]);
    expect(coarseWaveform([], RATE)).toBeNull();
  });

  it('draws no more columns than pixels, buckets or the cap', () => {
    const levels = hit(0, 4);
    expect(waveformColumnCount(levels, seconds(4), 300.2)).toBe(301);
    expect(waveformColumnCount(levels, seconds(4), 100_000)).toBe(
      Math.ceil((seconds(4) * MUSIC_SAMPLES_PER_FRAME) / 480),
    );
    expect(waveformColumnCount(wave([[0, 0]]), 1, 0)).toBe(1);
    const long = wave(Array.from({ length: 100_000 }, () => [0, 0]));
    expect(waveformColumnCount(long, seconds(1000), 1e6)).toBe(WAVEFORM_MAX_COLUMNS);
  });

  it('decodes the service data', () => {
    const decoded = decodeWaveform(Buffer.from(Int8Array.from([-127, 5, 0, 0])).toString('base64'), 480);
    expect(Array.from(decoded.levels)).toEqual([-127, 5, 0, 0]);
    expect(() => decodeWaveform(Buffer.from([1, 2, 3]).toString('base64'), 480)).toThrow();
  });
});

describe('waveform outline', () => {
  it('outlines each column between its lowest and highest level and closes the shape', () => {
    const path = waveformPath({ min: Float32Array.from([-1, -0.5]), max: Float32Array.from([1, 0.5]) });
    expect(path).toBe('M0 2H1V12H2V32H1V42H0Z');
  });

  it('keeps silence a visible line', () => {
    expect(waveformPath({ min: Float32Array.from([0]), max: Float32Array.from([0]) })).toBe('M0 21.3H1V22.8H0Z');
  });
});
