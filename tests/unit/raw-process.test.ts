import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawFrameReader, runRawVideoPass, writeRawFrame } from '../../src/server/raw-process.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const temporary: string[] = [];
afterEach(async () => {
  vi.clearAllMocks(); vi.mocked(spawn).mockReset();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('raw stdout ownership begins at reader creation', () => {
  it('retains the second reader output even when that child closes before the first requested frame', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-reader-exit-')); temporary.push(directory);
    const destination = path.join(directory, 'sum.rgb');
    const events: string[] = [];
    let rightChild: ChildProcess | null = null;
    const report = await runRawVideoPass({ ffmpeg: process.execPath, cwd: directory, signal: new AbortController().signal }, async (pass) => {
      const left = pass.reader(['-e', 'process.stdout.write(Buffer.from([1,2,3,4,5,6]));'], 'left');
      const right = pass.reader(['-e', 'process.stdout.write(Buffer.from([6,5,4,3,2,1]));'], 'right');
      rightChild = vi.mocked(spawn).mock.results[1]!.value as ChildProcess;
      rightChild.once('exit', (code) => events.push(`right exit ${code}`));
      rightChild.stdout!.once('end', () => events.push('right stdout end'));
      const closed = once(rightChild, 'close');
      const encoder = pass.encoder(['-e', `process.stdin.pipe(require('node:fs').createWriteStream(${JSON.stringify(destination)},{flags:'wx'}));`], 'encoder');
      const a = Buffer.alloc(3); const b = Buffer.alloc(3);
      await left.requireFrame(a);
      // The existing flaky test allowed this ordering by chance. Exercise it deliberately.
      const [code] = await closed;
      expect(code).toBe(0); events.push('right first frame requested');
      await right.requireFrame(b);
      for (let index = 0; index < 3; index++) a[index] = a[index]! + b[index]!;
      await writeRawFrame(encoder, a);
      await left.requireFrame(a); await right.requireFrame(b);
      for (let index = 0; index < 3; index++) a[index] = a[index]! + b[index]!;
      await writeRawFrame(encoder, a);
      encoder.end(); await left.requireEnd(a); await right.requireEnd(b);
    });
    expect(events).toContain('right exit 0');
    expect(events.indexOf('right stdout end')).toBeLessThan(events.indexOf('right first frame requested'));
    expect(await readFile(destination)).toEqual(Buffer.alloc(6, 7));
    expect(report).toMatchObject({ peakReaders: 2, peakEncoders: 1, peakChildren: 3, readerProcesses: 2, encoderProcesses: 1, largestReadChunkBytes: 6 });
    expect(rightChild!.exitCode).toBe(0);
    for (const result of vi.mocked(spawn).mock.results) expect((result.value as ChildProcess).exitCode).toBe(0);
  });

  it('still rejects truncated and extra output instead of accepting early EOF', async () => {
    const frame = Buffer.alloc(3);
    const truncated = RawFrameReader.create(Readable.from([Buffer.alloc(2)]), 'truncated', () => {});
    await expect(truncated.requireFrame(frame)).rejects.toThrow('truncated raw frame');
    const extra = RawFrameReader.create(Readable.from([Buffer.alloc(6)]), 'extra', () => {});
    await extra.requireFrame(frame); await expect(extra.requireEnd(frame)).rejects.toThrow('outside its selected range');
    const empty = RawFrameReader.create(Readable.from([]), 'empty', () => {});
    await expect(empty.requireFrame(frame)).rejects.toThrow('exact selected frame count');
  });
  it('retains an early stream failure without an unhandled rejection before its first frame is requested', async () => {
    const stream = new Readable({ read() {} });
    const reader = RawFrameReader.create(stream, 'early error', () => {});
    stream.destroy(new Error('intentional early stream failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(reader.requireFrame(Buffer.alloc(3))).rejects.toThrow('intentional early stream failure');
  });
});