import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertNoSymlinks, discoverVideos, fingerprintFile } from '../../src/server/files.js';
import { JobQueue, type JobContext } from '../../src/server/jobs.js';
import type { MediaJob } from '../../src/shared/media.js';

// No filesystem, media processes, cache, originals or server are used here.
const filesystem = vi.hoisted(() => ({
  lstat: vi.fn<(filename: string) => Promise<Stats>>(),
  open: vi.fn<(filename: string, flags: string) => Promise<FileHandle>>(),
  readdir: vi.fn<(folder: string, options: { withFileTypes: true }) => Promise<Dirent[]>>(),
}));
vi.mock('node:fs/promises', () => filesystem);

const queues: JobQueue[] = [];
const releases: (() => void)[] = [];
function createQueue(): JobQueue {
  const queue = new JobQueue(); queues.push(queue); return queue;
}
function deferred() {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}
function fileStats(overrides: Partial<Stats> = {}): Stats {
  return {
    dev: 7, ino: 11, size: 0, mtimeMs: 1_000,
    isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false,
    ...overrides,
  } as Stats;
}
function mockHandle(before: Stats, readLimit = before.size, after = before) {
  let active = 0; let maximum = 0;
  const read = vi.fn(async (buffer: Buffer, _offset: number, length: number, position: number) => {
    active++; maximum = Math.max(maximum, active);
    try {
      await Promise.resolve();
      const bytesRead = Math.min(length, readLimit);
      buffer.fill(position % 251, 0, bytesRead);
      return { bytesRead, buffer };
    } finally { active--; }
  });
  const stat = vi.fn(async () => after);
  const close = vi.fn(async () => {});
  filesystem.lstat.mockResolvedValue(before);
  filesystem.open.mockResolvedValue({ read, stat, close } as unknown as FileHandle);
  return { read, stat, close, maximum: () => maximum };
}
function dirent(name: string, kind: 'directory' | 'file' | 'link'): Dirent {
  return { name, isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'directory', isFile: () => kind === 'file' } as Dirent;
}

beforeEach(() => {
  filesystem.lstat.mockReset(); filesystem.open.mockReset(); filesystem.readdir.mockReset();
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
});

describe('serial source traversal and fingerprint compatibility', () => {
  it('checks ancestors in order and stops before traversing a symlink', async () => {
    filesystem.lstat.mockImplementation(async (filename) => fileStats({ isSymbolicLink: () => filename === '/unit/linked' }));
    await expect(assertNoSymlinks('/unit/linked/deeper/video.mp4')).rejects.toThrow('Symlinks');
    expect(filesystem.lstat.mock.calls.map(([filename]) => filename)).toEqual(['/', '/unit', '/unit/linked']);
  });

  it.each([
    { label: 'empty files', size: 0, bytes: 0, offsets: [0] },
    { label: 'small files with deduplicated offsets', size: 17, bytes: 17, offsets: [0] },
    { label: 'three distinct regions', size: 3_145_745, bytes: 1_048_576, offsets: [0, 1_048_584, 2_097_169] },
    { label: 'short reads without retries', size: 3_145_745, bytes: 7, offsets: [0, 1_048_584, 2_097_169] },
  ])('preserves the exact digest for $label', async ({ size, bytes, offsets }) => {
    const before = fileStats({ size });
    const handle = mockHandle(before, bytes);
    const hash = createHash('sha256').update(`pascap-sampled-v1:${size}:1000:7:11:`);
    offsets.forEach((offset) => { hash.update(String(offset)); hash.update(Buffer.alloc(bytes, offset % 251)); });
    expect(await fingerprintFile('/unit/video.mp4')).toEqual({
      algorithm: 'sampled-sha256-v1', digest: hash.digest('hex'), size, mtimeMs: 1_000, device: 7, inode: 11,
    });
    expect(handle.read.mock.calls.map((call) => call[3])).toEqual(offsets);
    expect(handle.read.mock.calls.map((call) => call[2])).toEqual(offsets.map(() => Math.min(1_048_576, size)));
    expect(handle.maximum()).toBe(1);
    expect(handle.stat).toHaveBeenCalledOnce(); expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(['size', 'mtimeMs', 'ino'] as const)('rejects a changed %s after short reads and closes the handle', async (property) => {
    const before = fileStats({ size: 17 });
    const handle = mockHandle(before, 7, fileStats({ ...before, [property]: before[property] + 1 }));
    await expect(fingerprintFile('/unit/video.mp4')).rejects.toThrow('Source changed while it was being read.');
    expect(handle.read).toHaveBeenCalledOnce(); expect(handle.close).toHaveBeenCalledOnce();
  });

  it('retains sorted depth-first discovery without following links or mutating entries', async () => {
    const root = '/unit/videos';
    const entries = [dirent('z.mp4', 'file'), dirent('b', 'directory'), dirent('c.mov', 'file'), dirent('a.txt', 'file'), dirent('a-link', 'link')];
    filesystem.lstat.mockResolvedValue(fileStats({ isDirectory: () => true, isFile: () => false }));
    filesystem.readdir.mockImplementation(async (folder) => {
      if (folder === root) return entries;
      if (folder === `${root}/b`) return [dirent('z.MOV', 'file'), dirent('a.mp4', 'file')];
      throw new Error(`Unexpected directory ${folder}`);
    });
    expect(await discoverVideos(root)).toEqual({ files: [`${root}/b/a.mp4`, `${root}/b/z.MOV`, `${root}/c.mov`, `${root}/z.mp4`], errors: [], ignored: 2 });
    expect(filesystem.readdir.mock.calls.map(([folder]) => folder)).toEqual([root, `${root}/b`]);
    expect(entries.map((entry) => entry.name)).toEqual(['z.mp4', 'b', 'c.mov', 'a.txt', 'a-link']);
  });
});

describe('serial queue lifecycle', () => {
  it('holds the latch through tasks and settlement, skips queued cancellation, and drains new submissions', async () => {
    const queue = createQueue(); const order: string[] = [];
    const taskGate = deferred(); const settlementGate = deferred(); const entered = deferred();
    let cancelledId = ''; let finished = false;
    const cancelledTask = vi.fn(async () => { order.push('cancelled:task'); });
    const cancelledSettlement = vi.fn(async (job: MediaJob) => { order.push(`cancelled:${job.state}`); });
    const first = queue.submit('prepare', 'first', async () => {
      order.push('first:task');
      cancelledId = queue.submit('prepare', 'nested submission', cancelledTask, cancelledSettlement).id;
      await taskGate.promise;
    }, async () => {
      order.push('first:settlement:start'); entered.resolve();
      await settlementGate.promise; order.push('first:settlement:end');
    });
    expect(queue.get(cancelledId).state).toBe('queued');
    queue.cancel(cancelledId); taskGate.resolve(); await entered.promise;
    const waiting = queue.wait(first.id).then((job) => { finished = true; return job; });
    const late = queue.submit('prepare', 'during settlement', async () => { order.push('late:task'); });
    expect(queue.get(late.id).state).toBe('queued'); expect(finished).toBe(false);
    settlementGate.resolve();
    const results = await Promise.all([waiting, queue.wait(cancelledId), queue.wait(late.id)]);
    expect(results.map((job) => job.state)).toEqual(['completed', 'cancelled', 'completed']);
    expect(finished).toBe(true); expect(cancelledTask).not.toHaveBeenCalled(); expect(cancelledSettlement).toHaveBeenCalledOnce();
    expect(order).toEqual(['first:task', 'first:settlement:start', 'first:settlement:end', 'cancelled:cancelled', 'late:task']);
  });

  it('reports failed settlement before resolving wait and continues with the next task', async () => {
    const queue = createQueue(); const entered = deferred(); const gate = deferred(); let finished = false;
    const settled = vi.fn(async () => { entered.resolve(); await gate.promise; throw new Error('Receipt write rejected.'); });
    const first = queue.submit('export', 'first', async () => {}, settled);
    const nextTask = vi.fn(async () => {});
    const next = queue.submit('prepare', 'next', nextTask);
    await entered.promise;
    const waiting = queue.wait(first.id).then((job) => { finished = true; return job; });
    expect(finished).toBe(false); expect(nextTask).not.toHaveBeenCalled();
    gate.resolve();
    expect(await waiting).toMatchObject({ state: 'failed', message: 'Cannot persist job result: Receipt write rejected.' });
    expect(finished).toBe(true); expect(settled).toHaveBeenCalledOnce();
    expect((await queue.wait(next.id)).state).toBe('completed'); expect(nextTask).toHaveBeenCalledOnce();
  });

  it('makes close wait for running and queued cancellation settlements exactly once', async () => {
    const queue = createQueue(); const firstEntered = deferred(); const secondEntered = deferred();
    const firstGate = deferred(); const secondGate = deferred(); let closed = false;
    const firstTask = vi.fn((context: JobContext) => new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true });
    }));
    const firstSettlement = vi.fn(async () => { firstEntered.resolve(); await firstGate.promise; });
    const secondSettlement = vi.fn(async () => { secondEntered.resolve(); await secondGate.promise; });
    const first = queue.submit('prepare', 'running', firstTask, firstSettlement);
    const secondTask = vi.fn(async () => {});
    const second = queue.submit('prepare', 'queued', secondTask, secondSettlement);
    const closing = queue.close().then(() => { closed = true; });
    await firstEntered.promise; expect(closed).toBe(false); expect(secondTask).not.toHaveBeenCalled();
    firstGate.resolve(); await secondEntered.promise; expect(closed).toBe(false);
    secondGate.resolve(); await closing;
    expect((await queue.wait(first.id)).state).toBe('cancelled'); expect((await queue.wait(second.id)).state).toBe('cancelled');
    expect(firstTask).toHaveBeenCalledOnce(); expect(secondTask).not.toHaveBeenCalled();
    expect(firstSettlement).toHaveBeenCalledOnce(); expect(secondSettlement).toHaveBeenCalledOnce();
  });

  it('restarts immediately for a submission in the final drain microtask', async () => {
    const queue = createQueue();
    const first = queue.submit('prepare', 'first', async () => {});
    await queue.wait(first.id);
    // wait resumes after the empty-queue predicate, but before #drain resumes.
    const task = vi.fn(async () => {});
    const next = queue.submit('prepare', 'at idle boundary', task);
    expect(task).toHaveBeenCalledOnce(); expect(queue.get(next.id).state).toBe('running');
    expect((await queue.wait(next.id)).state).toBe('completed');
  });
});