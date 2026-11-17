import { describe, expect, it } from 'vitest';
import type { MusicAnalysis } from '../../src/shared/music-analysis.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import { secondsToFrames } from '../../src/shared/timing.js';
import { adjacentMark, followWindow, musicMarks, windowTrack } from '../../src/web/music-review-window.js';

const COUNT = 6000;
const TEN = secondsToFrames(10);

describe('followWindow', () => {
  it('first centers the window on the frame, within the recording', () => {
    expect(followWindow(null, 3000, 10, COUNT)).toEqual({ start: 3000 - Math.floor(TEN / 2), length: TEN });
    expect(followWindow(null, 20, 10, COUNT)).toEqual({ start: 0, length: TEN });
    expect(followWindow(null, COUNT - 1, 10, COUNT)).toEqual({ start: COUNT - TEN, length: TEN });
  });

  it('keeps the window while it shows the frame, then turns the page just before it', () => {
    const view = { start: 1000, length: TEN };
    expect(followWindow(view, 1000, 10, COUNT)).toBe(view);
    expect(followWindow(view, 1000 + TEN - 1, 10, COUNT)).toBe(view);
    expect(followWindow(view, 1000 + TEN, 10, COUNT)).toEqual({
      start: 1000 + TEN - Math.round(TEN * 0.1),
      length: TEN,
    });
    expect(followWindow(view, 999, 10, COUNT)).toEqual({ start: 999 - Math.round(TEN * 0.1), length: TEN });
    expect(followWindow(view, 5, 10, COUNT)).toEqual({ start: 0, length: TEN });
  });

  it('centers again when the length changes and never exceeds the recording', () => {
    expect(followWindow({ start: 1000, length: TEN }, 1100, 20, COUNT)).toEqual({
      start: 1100 - Math.floor(secondsToFrames(20) / 2),
      length: secondsToFrames(20),
    });
    expect(followWindow(null, 40, 80, 100)).toEqual({ start: 0, length: 100 });
  });
});

describe('windowTrack', () => {
  it('plays the window at its own recording frames', () => {
    expect(windowTrack('song', { start: 300, length: 150 })).toMatchObject({
      mediaId: 'song',
      sourceIn: 300,
      sourceOut: 450,
      start: 300,
      duration: 150,
      loop: false,
    });
  });
});

describe('musicMarks and adjacentMark', () => {
  const at = (frame: number) => frame * MUSIC_SAMPLES_PER_FRAME;
  const analysis = {
    beats: [
      { sample: at(10), downbeat: true, strength: 1 },
      { sample: at(25), downbeat: false, strength: 1 },
      { sample: at(40), downbeat: true, strength: 1 },
    ],
    hits: [
      { sample: at(12), strength: 1, band: 'low', strong: true },
      { sample: at(30), strength: 0.2, band: 'high', strong: false },
      { sample: at(55), strength: 1, band: 'mid', strong: true },
    ],
    sections: [
      { fromSample: at(0), toSample: at(50), kind: 'quiet', loudnessDb: -20 },
      { fromSample: at(50), toSample: at(100), kind: 'peak', loudnessDb: -10 },
    ],
  } as unknown as MusicAnalysis;
  const whole = windowTrack('song', { start: 0, length: 100 });

  it('lists section starts, downbeats and strong hits at recording frames', () => {
    expect(musicMarks(whole, analysis)).toEqual({ section: [0, 50], downbeat: [10, 40], hit: [12, 55] });
  });

  it('finds the nearest mark strictly before or after a frame', () => {
    expect(adjacentMark([10, 40], 10, 1)).toBe(40);
    expect(adjacentMark([10, 40], 10, -1)).toBeUndefined();
    expect(adjacentMark([10, 40], 25, -1)).toBe(10);
    expect(adjacentMark([10, 40], 40, -1)).toBe(10);
    expect(adjacentMark([10, 40], 40, 1)).toBeUndefined();
    expect(adjacentMark([], 0, 1)).toBeUndefined();
  });
});
