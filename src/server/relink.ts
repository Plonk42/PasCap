import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isAudioFilename, isVideoFilename } from '../shared/footage.js';
import type { MediaJob, SourceContent, SourceFingerprint } from '../shared/media.js';
import { forEachSerial } from '../shared/serial.js';
import { isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks, assertSourceIdentity, fingerprintFile, hashFile } from './files.js';
import type { JobContext, JobQueue } from './jobs.js';

export interface RelinkCandidate {
  id: string;
  name: string;
  content: SourceContent;
}
export interface RelinkLibrary {
  relinkCandidates(): Promise<RelinkCandidate[]>;
  commitRelink(id: string, sourcePath: string, fingerprint: SourceFingerprint): Promise<void>;
}
interface Wanted extends RelinkCandidate {
  library: RelinkLibrary;
}
interface Found {
  path: string;
  size: number;
}
interface Verified {
  path: string;
  fingerprint: SourceFingerprint;
}

export const MAX_RELINK_FOLDER_FILES = 100_000;

function inside(parent: string, filename: string): boolean {
  const relative = path.relative(parent, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Media files of the wanted sizes below a folder, skipping symlinks and PasCap's own cache. */
async function discover(directory: string, cache: string, sizes: ReadonlySet<number>): Promise<Found[]> {
  const found: Found[] = [];
  let files = 0;
  const visit = async (folder: string): Promise<void> => {
    if (inside(cache, folder)) return;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    await forEachSerial(entries, async (entry) => {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) return visit(filename);
      if (!entry.isFile() || !(isVideoFilename(entry.name) || isAudioFilename(entry.name))) return;
      if (++files > MAX_RELINK_FOLDER_FILES)
        throw new ServiceError(
          `${directory} holds more than ${MAX_RELINK_FOLDER_FILES} recordings. Choose a narrower folder.`,
          422,
        );
      try {
        const { size } = await lstat(filename);
        if (sizes.has(size)) found.push({ path: filename, size });
      } catch {
        // Removed while listing: not a candidate.
      }
    });
  };
  await visit(directory);
  return found;
}

function summary(relinked: number, wanted: readonly Wanted[], missing: readonly string[]): string {
  const total = `${wanted.length} missing ${wanted.length === 1 ? 'recording' : 'recordings'}`;
  if (!missing.length) return `Relinked all ${total}`;
  const names = missing.slice(0, 5).join(', ') + (missing.length > 5 ? `, and ${missing.length - 5} more` : '');
  return `Relinked ${relinked} of ${total}. Not found: ${names}`;
}

async function relinkFolder(
  directory: string,
  cache: string,
  libraries: readonly RelinkLibrary[],
  context: JobContext,
): Promise<string> {
  const wanted: Wanted[] = [];
  await forEachSerial(libraries, async (library) => {
    wanted.push(...(await library.relinkCandidates()).map((candidate) => ({ ...candidate, library })));
  });
  if (!wanted.length)
    throw new ServiceError('No missing recording can be relinked: none has a recorded checksum.', 409);
  context.update(0.01, `Searching ${directory}`);
  const files = await discover(directory, cache, new Set(wanted.map((item) => item.content.size)));
  const wantedNames = new Set(wanted.map((item) => item.name));
  // Files keeping their old name are checked first: they are the likeliest copies.
  files.sort((a, b) => Number(wantedNames.has(path.basename(b.path))) - Number(wantedNames.has(path.basename(a.path))));
  const total = Math.max(
    1,
    files.reduce((sum, file) => sum + file.size, 0),
  );
  const byName = new Map<string, Verified>();
  const byDigest = new Map<string, Verified>();
  let done = 0;
  await forEachSerial(files, async (file) => {
    const name = path.basename(file.path);
    const open = wanted.some(
      (item) =>
        item.content.size === file.size &&
        !byName.has(item.id) &&
        (item.name === name || !byDigest.has(item.content.digest)),
    );
    if (open) {
      try {
        const fingerprint = await fingerprintFile(file.path);
        const content = await hashFile(file.path, context.signal, (fraction) =>
          context.update(0.01 + ((done + fraction * file.size) / total) * 0.97, `Checking ${file.path}`),
        );
        await assertSourceIdentity(file.path, fingerprint, true);
        const verified = { path: file.path, fingerprint };
        if (!byDigest.has(content.digest)) byDigest.set(content.digest, verified);
        wanted
          .filter((item) => item.name === name && item.content.digest === content.digest)
          .forEach((item) => byName.set(item.id, verified));
      } catch (error) {
        if (context.signal.aborted) throw error;
      }
    }
    done += file.size;
  });
  if (context.signal.aborted) throw new ServiceError('Job canceled.', 499);
  let relinked = 0;
  const missing: string[] = [];
  await forEachSerial(wanted, async (item) => {
    const target = byName.get(item.id) ?? byDigest.get(item.content.digest);
    if (!target) {
      missing.push(item.name);
      return;
    }
    await assertSourceIdentity(target.path, target.fingerprint, true);
    await item.library.commitRelink(item.id, target.path, target.fingerprint);
    relinked++;
  });
  if (!relinked)
    throw new ServiceError(
      `None of the ${wanted.length} missing recordings is in ${directory} or its subfolders. Nothing was changed.`,
      404,
    );
  return summary(relinked, wanted, missing);
}

/** Queues one job that relinks every missing recording whose exact bytes are found below a folder. */
export async function submitFolderRelink(
  jobs: JobQueue,
  cache: string,
  libraries: readonly RelinkLibrary[],
  directory: string,
): Promise<MediaJob> {
  let folder;
  try {
    folder = await assertNoSymlinks(directory);
  } catch (error) {
    if (isNotFound(error)) throw new ServiceError(`${directory} does not exist.`, 404);
    throw error;
  }
  if (!folder.isDirectory()) throw new ServiceError('Choose a folder to search.', 422);
  if (inside(cache, directory)) throw new ServiceError('The PasCap cache cannot hold original recordings.', 403);
  return jobs.submit('relink', `Folder ${path.basename(directory)}`, (context) =>
    relinkFolder(directory, cache, libraries, context),
  );
}
