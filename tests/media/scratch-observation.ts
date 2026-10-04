import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { isNotFound } from '../../src/server/errors.js';

/** Linux allocated regular-file bytes at progress points; excludes directory metadata and between-sample peaks. */
export function observedJobBytes(directory: string): number {
  let entries: Dirent[];
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (cause) {
    if (isNotFound(cause)) return 0;
    throw cause;
  }
  return entries.reduce((total, entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return total + observedJobBytes(filename);
    if (!entry.isFile()) throw new Error('Native test scratch must contain only owned regular files and directories.');
    return total + lstatSync(filename).blocks * 512;
  }, 0);
}