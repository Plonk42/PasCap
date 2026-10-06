import { describe, expect, it } from 'vitest';
import { MusicRenderer } from '../../src/preview/music-renderer.js';
import { musicGainAt } from '../../src/shared/audio.js';
import { musicSchema } from '../../src/shared/model.js';
import {
  decodeMusicRange,
  MUSIC_CHUNK_SAMPLES,
  MUSIC_QUEUE_CHUNKS,
  MUSIC_SAMPLES_PER_FRAME,
  musicReadAt,
} from '../../src/shared/music-stream.js';

const track = musicSchema.parse({
  mediaId: 'song',
  sourceIn: 1,
  sourceOut: 3,
  start: 10,
  duration: 20,
  gainDb: -6,
  fadeIn: 2,
  fadeOut: 2,
  loop: true,
});
function chunk(offset: number, value = 0.25) {
  const data = new Float32Array(MUSIC_CHUNK_SAMPLES * 2);
  for (let index = 0; index < data.length; index += 2) {
    data[index] = value;
    data[index + 1] = -value;
  }
  return { offset, data };
}

describe('strict sample-frame music reads', () => {
  it('splits placement, selected source OUT, wraps and final duration in integer sample coordinates', () => {
    expect(musicReadAt(track, 9, MUSIC_CHUNK_SAMPLES)).toEqual({ source: null, samples: 1602 });
    expect(musicReadAt(track, 10, MUSIC_CHUNK_SAMPLES)).toEqual({ source: 1602, samples: 3203 });
    const next = 10 + 3203 / MUSIC_SAMPLES_PER_FRAME;
    expect(musicReadAt(track, next, MUSIC_CHUNK_SAMPLES)).toEqual({ source: 1602, samples: 3203 });
    const last = 30 - 1 / MUSIC_SAMPLES_PER_FRAME;
    expect(musicReadAt(track, last, MUSIC_CHUNK_SAMPLES).samples).toBe(1);
    expect(musicReadAt(track, 30, MUSIC_CHUNK_SAMPLES)).toEqual({ source: null, samples: MUSIC_CHUNK_SAMPLES });
  });
  it('never loops a non-looping source or reads beyond its selected OUT', () => {
    const music = { ...track, loop: false, duration: 2 };
    expect(musicReadAt(music, 11, MUSIC_CHUNK_SAMPLES)).toEqual({ source: 3204, samples: 1601 });
    expect(musicReadAt(music, 12, MUSIC_CHUNK_SAMPLES).source).toBeNull();
  });
  it.each([1, 2, 3, 4, 5])(
    'keeps warm seek source samples identical to uninterrupted placement at rounding phase %s',
    (start) => {
      const music = { ...track, start, duration: 20 };
      const origin = Math.round(start * MUSIC_SAMPLES_PER_FRAME);
      const sourceIn = Math.round(music.sourceIn * MUSIC_SAMPLES_PER_FRAME);
      const length = Math.round(music.sourceOut * MUSIC_SAMPLES_PER_FRAME) - sourceIn;
      for (let frame = start; frame < start + 20; frame++) {
        expect(musicReadAt(music, frame, 1).source).toBe(
          sourceIn + ((Math.round(frame * MUSIC_SAMPLES_PER_FRAME) - origin) % length),
        );
      }
    },
  );
  it.each([10, 11, 15, 29])(
    'applies exact PCM16 stereo values and the real gain/fade envelope at frame %s',
    (frame) => {
      const bytes = new ArrayBuffer(8);
      const view = new DataView(bytes);
      view.setInt16(0, 8192, true);
      view.setInt16(2, -16384, true);
      view.setInt16(4, 32767, true);
      view.setInt16(6, -32768, true);
      const output = decodeMusicRange(bytes, track, frame);
      expect(output[0]).toBeCloseTo(0.25 * musicGainAt(track, frame), 7);
      expect(output[1]).toBeCloseTo(-0.5 * musicGainAt(track, frame), 7);
      expect(output[2]).toBeCloseTo((32767 / 32768) * musicGainAt(track, frame + 1 / MUSIC_SAMPLES_PER_FRAME), 7);
      expect(output[3]).toBeCloseTo(-musicGainAt(track, frame + 1 / MUSIC_SAMPLES_PER_FRAME), 7);
    },
  );
  it.each([0, 1, 3, 65540])('rejects %s malformed/oversized PCM bytes', (length) => {
    expect(() => decodeMusicRange(new ArrayBuffer(length), track, 10)).toThrow('bounded stereo PCM16');
  });
});

describe('bounded audio-thread rendering', () => {
  it('renders actual left/right samples, releases one credit at each boundary and keeps exact consumed counts', () => {
    const renderer = new MusicRenderer();
    for (let index = 0; index < MUSIC_QUEUE_CHUNKS; index++)
      renderer.enqueue(chunk(index * MUSIC_CHUNK_SAMPLES, (index + 1) / 8));
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    for (let quantum = 0; quantum < MUSIC_CHUNK_SAMPLES / 128; quantum++) {
      const result = renderer.render(left, right);
      expect(left.every((value) => value === 0.125)).toBe(true);
      expect(right.every((value) => value === -0.125)).toBe(true);
      expect(result).toEqual({ released: quantum === MUSIC_CHUNK_SAMPLES / 128 - 1 ? 1 : 0, underrun: false });
      expect(renderer.played).toBe((quantum + 1) * 128);
    }
    expect(renderer.queuedChunks).toBe(3);
    renderer.enqueue(chunk(4 * MUSIC_CHUNK_SAMPLES));
    expect(renderer.queuedChunks).toBe(4);
    renderer.render(left, right);
    expect(left[0]).toBe(0.25);
    expect(right[0]).toBe(-0.25);
  });
  it('reports a genuine empty queue immediately, freezes source consumption and zeros only the failed output', () => {
    const renderer = new MusicRenderer();
    renderer.enqueue(chunk(0));
    const left = new Float32Array(MUSIC_CHUNK_SAMPLES);
    const right = new Float32Array(MUSIC_CHUNK_SAMPLES);
    expect(renderer.render(left, right)).toEqual({ released: 1, underrun: false });
    expect(renderer.render(left, right)).toEqual({ released: 0, underrun: true });
    expect(renderer.running).toBe(false);
    expect(renderer.played).toBe(MUSIC_CHUNK_SAMPLES);
    expect(left.every((value) => value === 0)).toBe(true);
    expect(right.every((value) => value === 0)).toBe(true);
    renderer.render(left, right);
    expect(renderer.played).toBe(MUSIC_CHUNK_SAMPLES);
  });
  it('treats legitimate PCM silence as consumed audio, not a missing source or timing calibration signal', () => {
    const renderer = new MusicRenderer();
    renderer.enqueue(chunk(0, 0));
    expect(renderer.render(new Float32Array(128), new Float32Array(128)).underrun).toBe(false);
    expect(renderer.played).toBe(128);
    expect(renderer.running).toBe(true);
  });
  it('rejects gaps, duplication, oversized blocks and a fifth outstanding block', () => {
    const renderer = new MusicRenderer();
    expect(() => renderer.enqueue(chunk(1))).toThrow('credit-controlled');
    expect(() => renderer.enqueue({ offset: 0, data: new Float32Array(2) })).toThrow('credit-controlled');
    for (let index = 0; index < 4; index++) renderer.enqueue(chunk(index * MUSIC_CHUNK_SAMPLES));
    expect(() => renderer.enqueue(chunk(4 * MUSIC_CHUNK_SAMPLES))).toThrow('credit-controlled');
    expect(renderer.queuedChunks).toBe(4);
    expect(renderer.played).toBe(0);
  });
});
