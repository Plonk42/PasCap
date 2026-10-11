import { describe, expect, it } from 'vitest';
import { keyframeBefore, locateIndex, parseProxyIndex } from '../../src/preview/proxy-index.js';
import { PROJECT_FPS } from '../../src/shared/timing.js';
import { buildProxy, type ProxyFixtureOptions } from './proxy-fixture.js';

function parse(options: ProxyFixtureOptions = {}) {
  return parseProxyIndex(buildProxy(options).bytes, PROJECT_FPS);
}

describe('editing proxy sample index', () => {
  it.each([false, true])('maps every frame to its exact byte range (64-bit offsets=%s)', (wide) => {
    const fixture = buildProxy({ frames: 47, wide });
    const index = parseProxyIndex(fixture.bytes, PROJECT_FPS);
    expect(index).toMatchObject({ codec: 'avc1.64001f', width: 1280, height: 720, frameCount: 47 });
    expect([...index.offsets]).toEqual(fixture.offsets);
    expect([...index.sizes]).toEqual(fixture.sizes);
    expect([...index.description]).toEqual([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 0]);
    expect([...index.keyframes].flatMap((key, frame) => (key ? [frame] : []))).toEqual([0, 15, 30, 45]);
    for (const frame of [0, 14, 15, 29, 46]) {
      const begin = index.offsets[frame]!;
      expect(fixture.bytes.subarray(begin, begin + index.sizes[frame]!).every((byte) => byte === frame)).toBe(true);
    }
    expect([0, 1, 14, 15, 16, 46].map((frame) => keyframeBefore(index, frame))).toEqual([0, 0, 0, 15, 15, 45]);
  });

  it('accepts an index without an edit list and any equivalent timescale', () => {
    expect(parse({ editMediaTime: null }).frameCount).toBe(60);
    expect(parse({ timescale: 60_000, delta: 2002 }).frameCount).toBe(60);
  });

  it('locates the index before the media from a bounded head read', () => {
    const fixture = buildProxy();
    const location = locateIndex(fixture.bytes.subarray(0, 64));
    expect(location.start).toBeGreaterThan(0);
    expect(location.end).toBe(fixture.offsets[0]! - 8);
    expect(() => parseProxyIndex(fixture.bytes.subarray(0, location.end - 1), PROJECT_FPS)).toThrow(/truncated/);
  });

  it.each<[string, ProxyFixtureOptions, RegExp]>([
    ['an index after the media', { indexFirst: false }, /faststart/],
    ['reordered frames', { reordered: true }, /reordered \(B\) frames/],
    ['another frame rate', { delta: 1000 }, /frame duration is not 1001\/30000/],
    ['a shifting edit list', { editMediaTime: 1001 }, /edit list shifts frames/],
    ['another codec', { sampleEntry: 'hvc1' }, /not H\.264/],
    ['two video tracks', { videoTracks: 2 }, /exactly one video track/],
    ['a first frame that is not a keyframe', { firstKey: false }, /first frame is not a keyframe/],
  ])('rejects %s', (_name, options, message) => {
    expect(() => parse(options)).toThrow(message);
    expect(() => parse(options)).toThrow(/^Unsupported editing proxy: .*Prepare the recording again\.$/);
  });
});
