import { lstat, open, readdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceFingerprint } from '../shared/media.js';
import { forEachSerial } from '../shared/serial.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';

export function assertCacheOutsideSource(sourceDirectory: string, dataDirectory: string): void {
  const relative = path.relative(path.resolve(sourceDirectory), path.resolve(dataDirectory));
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!outside) throw new ServiceError('The PasCap cache must be outside the imported source folder. Choose a different source folder or PASCAP_DATA_DIR.', 422);
}

/** Reject symlinks in every source path component, not just the leaf. */
export async function assertNoSymlinks(filename: string): Promise<Stats> {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let result = await lstat(current);
  await forEachSerial(absolute.slice(parsed.root.length).split(path.sep), async (component) => {
    current = path.join(current, component);
    result = await lstat(current);
    if (result.isSymbolicLink()) throw new ServiceError(`Symlinks are not supported: ${current}`, 422);
  });
  return result;
}

export async function fingerprintFile(filename: string): Promise<SourceFingerprint> {
  const before = await assertNoSymlinks(filename);
  if (!before.isFile()) throw new ServiceError('Source must be a regular file.', 422);
  const hash = createHash('sha256');
  hash.update(`pascap-sampled-v1:${before.size}:${before.mtimeMs}:${before.dev}:${before.ino}:`);
  const handle = await open(filename, 'r');
  try {
    const length = Math.min(1024 * 1024, before.size);
    const offsets = [...new Set([0, Math.max(0, Math.floor(before.size / 2) - Math.floor(length / 2)), Math.max(0, before.size - length)])];
    await forEachSerial(offsets, async (offset) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      hash.update(String(offset)); hash.update(buffer.subarray(0, bytesRead));
    });
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new ServiceError('Source changed while it was being read.', 409);
  } finally { await handle.close(); }
  return { algorithm: 'sampled-sha256-v1', digest: hash.digest('hex'), size: before.size, mtimeMs: before.mtimeMs, device: before.dev, inode: before.ino };
}

/** deep also rechecks the three byte samples; it is NOT a full-file checksum. */
export async function assertSourceIdentity(filename: string, fingerprint: SourceFingerprint, deep = false): Promise<void> {
  let stat: Stats;
  try { stat = await assertNoSymlinks(filename); }
  catch (error) {
    if (isNotFound(error)) throw new ServiceError('The original recording is missing. Reconnect its drive or restore the original at its registered path. PasCap does not relink automatically.', 409);
    throw error;
  }
  if (!stat.isFile() || stat.size !== fingerprint.size || stat.mtimeMs !== fingerprint.mtimeMs || stat.ino !== fingerprint.inode || stat.dev !== fingerprint.device) throw new ServiceError('Source is missing or changed. Re-register it; the old clip will not be reassociated.', 409);
  if (deep && (await fingerprintFile(filename)).digest !== fingerprint.digest) throw new ServiceError('Source content changed. Re-register it before preparing or rendering.', 409);
}

export interface Discovery { files: string[]; errors: { path: string; message: string }[]; ignored: number }
export async function discoverVideos(directory: string): Promise<Discovery> {
  const root = path.resolve(directory);
  if (!(await assertNoSymlinks(root)).isDirectory()) throw new ServiceError('Import path must be a directory.');
  const result: Discovery = { files: [], errors: [], ignored: 0 };
  const visit = async (folder: string): Promise<void> => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch (error) { result.errors.push({ path: folder, message: errorMessage(error) }); return; }
    const sortedEntries = [...entries];
    sortedEntries.sort((a, b) => a.name.localeCompare(b.name));
    await forEachSerial(sortedEntries, async (entry) => {
      const filename = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) { result.ignored++; return; }
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && /\.(mp4|mov|m4v)$/i.test(entry.name)) result.files.push(filename);
      else result.ignored++;
      if (result.files.length > 5_000) throw new ServiceError('Import is limited to 5,000 recordings.');
    });
  };
  await visit(root);
  return result;
}

export interface ByteRange { start: number; end: number }
export function parseByteRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end };
}