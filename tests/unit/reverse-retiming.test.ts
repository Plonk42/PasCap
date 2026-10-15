import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  excerptFilter,
  excerptInputArgs,
  retimeRawVideo,
  reverseChunkFrames,
  type SourceExcerpt,
} from '../../src/server/retime-process.js';
import { createClip } from '../../src/shared/model.js';
import { compileRetiming, type SpeedSettings } from '../../src/shared/speed.js';

// Four six-byte frames per reversed decoder chunk.
vi.mock('../../src/shared/export.js', async (original) => {
  const actual = await original<typeof import('../../src/shared/export.js')>();
  return { ...actual, EXPORT_RESOURCES: { ...actual.EXPORT_RESOURCES, reverseChunkBytes: 24 } };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-reverse-retime-'));
  directories.push(directory);
  return directory;
}
/** A fake decoder emitting one excerpt, last frame first, each frame filled with its source index. */
function decoder(excerpt: Readonly<SourceExcerpt>, extra = 0): string[] {
  const frames = Array.from(
    { length: excerpt.sourceOut - excerpt.sourceIn + extra },
    (_, index) => excerpt.sourceOut - 1 - index,
  );
  return [
    '-e',
    `const b=Buffer.from(${JSON.stringify(frames.flatMap((frame) => Array(6).fill(frame % 256)))});process.stdout.write(b);`,
  ];
}

describe('reversed raw retiming (no FFmpeg needed)', () => {
  it('selects excerpts by input seek and native reverse only when reversed', () => {
    expect(excerptInputArgs({ sourceIn: 30, sourceOut: 40, reverse: false })).toEqual([]);
    expect(excerptFilter({ sourceIn: 30, sourceOut: 40, reverse: false }, 'scale=1:1')).toBe(
      'trim=start_frame=30:end_frame=40,setpts=PTS-STARTPTS,scale=1:1',
    );
    expect(excerptInputArgs({ sourceIn: 0, sourceOut: 4, reverse: true })).toEqual([]);
    const [flag, seek] = excerptInputArgs({ sourceIn: 30, sourceOut: 34, reverse: true });
    expect(flag).toBe('-ss');
    // Strictly between the PTS of frames 29 and 30.
    expect(Number(seek)).toBeGreaterThan((29 * 1001) / 30000);
    expect(Number(seek)).toBeLessThan((30 * 1001) / 30000);
    expect(excerptFilter({ sourceIn: 30, sourceOut: 34, reverse: true }, 'scale=1:1')).toBe(
      'trim=end_frame=4,setpts=PTS-STARTPTS,scale=1:1,reverse',
    );
    expect(reverseChunkFrames(6)).toBe(4);
    expect(reverseChunkFrames(1_000)).toBe(1);
  });

  it.each<SpeedSettings>([
    { mode: 'constant', rate: 1 },
    { mode: 'constant', rate: 0.4 },
    { mode: 'constant', rate: 3 },
    {
      mode: 'curve',
      keyframes: [
        { frame: 9, rate: 0.3, interpolation: 'smooth' },
        { frame: 15, rate: 2.5, interpolation: 'linear' },
      ],
    },
  ])('writes exact descending sourceAt frames from serial four-frame chunks for %j', async (speed) => {
    const directory = await temp();
    const clip = { ...createClip('reverse', 'video', 7, 25), speed, reverse: true };
    const destination = path.join(directory, 'reversed.rgb');
    const excerpts: SourceExcerpt[] = [];
    const report = await retimeRawVideo({
      ffmpeg: process.execPath,
      cwd: directory,
      decodeArgs: (excerpt) => {
        excerpts.push({ ...excerpt });
        return decoder(excerpt);
      },
      encodeArgs: [
        '-e',
        `process.stdin.pipe(require('node:fs').createWriteStream(${JSON.stringify(destination)},{flags:'wx'}));`,
      ],
      clip,
      frameBytes: 6,
      signal: new AbortController().signal,
    });
    expect(excerpts).toEqual([
      { sourceIn: 21, sourceOut: 25, reverse: true },
      { sourceIn: 17, sourceOut: 21, reverse: true },
      { sourceIn: 13, sourceOut: 17, reverse: true },
      { sourceIn: 9, sourceOut: 13, reverse: true },
      { sourceIn: 7, sourceOut: 9, reverse: true },
    ]);
    const map = compileRetiming(clip);
    const actual = await readFile(destination);
    expect(actual).toHaveLength(map.duration * 6);
    for (let frame = 0; frame < map.duration; frame++)
      expect([...actual.subarray(frame * 6, (frame + 1) * 6)]).toEqual(Array(6).fill(map.sourceAt(frame)));
    expect(report).toMatchObject({
      decodedFrames: 18,
      outputFrames: map.duration,
      rawFrameBuffers: 1,
      decoderProcesses: 5,
    });
  });

  it.each([
    [-1, 'ended before its exact selected frame count'],
    [1, 'emitted frames outside its selected range'],
  ])('rejects a chunk decoder emitting %i frames too many/few', async (extra, message) => {
    const directory = await temp();
    const clip = { ...createClip('reverse', 'video', 0, 10), reverse: true };
    await expect(
      retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        decodeArgs: (excerpt) => decoder(excerpt, excerpt.sourceIn === 6 ? extra : 0),
        encodeArgs: ['-e', 'process.stdin.resume();'],
        clip,
        frameBytes: 6,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(message);
  });
});
