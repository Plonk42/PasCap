import { constants, type Dirent, type Stats } from 'node:fs';
import { access, lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { isAudioFilename, isVideoFilename, MAX_FOOTAGE_ENTRIES, MAX_FOOTAGE_FILES, type AudioDirectory, type FootageDirectory, type FootageRoot } from '../shared/footage.js';
import { forEachSerial } from '../shared/serial.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';

type MediaKind = 'video' | 'audio';
type BrowserEntry = FootageDirectory['entries'][number] | AudioDirectory['entries'][number];
type BrowserDirectory = Omit<FootageDirectory, 'entries'> & { entries: BrowserEntry[] };
const naturalNames = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 512;

/** Relative boundaries, not string prefixes: /shots-elsewhere is not in /shots. */
function contains(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function directoryError(error: unknown): unknown {
  if (isNotFound(error)) return new ServiceError('Footage directory is missing or disconnected.', 404);
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') return new ServiceError('Footage directory is not readable by the PasCap service.', 403);
    if (error.code === 'ENOTDIR') return new ServiceError('Footage path must be a directory.', 422);
  }
  return error;
}

function compareEntries(a: BrowserEntry, b: BrowserEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return naturalNames.compare(a.name, b.name) || a.name.localeCompare(b.name);
}

function entryKind(info: Pick<Stats, 'isSymbolicLink' | 'isDirectory' | 'isFile'>, name: string, mediaKind: MediaKind): BrowserEntry['kind'] | null {
  if (info.isSymbolicLink()) return null;
  if (info.isDirectory()) return 'directory';
  const supported = mediaKind === 'audio' ? isAudioFilename(name) : isVideoFilename(name);
  return info.isFile() && supported ? mediaKind : null;
}

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(message.slice(0, MAX_WARNING_LENGTH));
  else warnings[MAX_WARNINGS - 1] = 'Additional entry warnings were omitted.';
}

/** Keep only the first natural-sorted page, even for a very large directory. */
function retainEntry(entries: BrowserEntry[], entry: BrowserEntry): boolean {
  const full = entries.length === MAX_FOOTAGE_ENTRIES;
  if (full && compareEntries(entry, entries.at(-1)!) >= 0) return true;
  let low = 0; let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareEntries(entries[middle]!, entry) < 0) low = middle + 1;
    else high = middle;
  }
  entries.splice(low, 0, entry);
  if (full) entries.pop();
  return full;
}

/** Metadata-only service-side browsing. Never copies, probes or prepares sources. */
export class FootageBrowser {
  readonly #roots: Omit<FootageRoot, 'available' | 'error'>[];
  readonly #cache: string;

  constructor(config: ServiceConfig) {
    this.#roots = config.mediaRoots.map((directory, index) => {
      const root = path.resolve(directory);
      return { id: `root-${index}`, name: path.basename(root) || root, path: root };
    });
    this.#cache = path.resolve(config.dataDir);
  }

  async roots(): Promise<FootageRoot[]> {
    const roots: FootageRoot[] = [];
    await forEachSerial(this.#roots, async (root) => {
      try {
        this.#scopedPath(root.path, root.path);
        await this.#assertDirectory(root.path);
        roots.push({ ...root, available: true, error: null });
      } catch (error) { roots.push({ ...root, available: false, error: errorMessage(error).slice(0, MAX_WARNING_LENGTH) }); }
    });
    return roots;
  }

  async browse(rootId: string, directory?: string): Promise<FootageDirectory> {
    return this.#scan(rootId, directory, 'video');
  }

  async browseAudio(rootId: string, directory?: string): Promise<AudioDirectory> {
    return this.#scan(rootId, directory, 'audio');
  }

  #scan(rootId: string, directory: string | undefined, mediaKind: 'video'): Promise<FootageDirectory>;
  #scan(rootId: string, directory: string | undefined, mediaKind: 'audio'): Promise<AudioDirectory>;
  async #scan(rootId: string, directory: string | undefined, mediaKind: MediaKind): Promise<BrowserDirectory> {
    const root = this.#roots.find((candidate) => candidate.id === rootId);
    if (!root) throw new ServiceError('Approved footage root not found.', 404);
    const selected = this.#scopedPath(directory ?? root.path, root.path);
    await this.#assertDirectory(selected);
    const result: BrowserDirectory = { rootId, directory: selected, parent: selected === root.path ? null : path.dirname(selected), entries: [], ignored: 0, truncated: false, warnings: [] };
    try {
      const listing = await opendir(selected);
      // One directory only. Both result storage and diagnostic storage are bounded.
      for await (const entry of listing) {
        try {
          const item = await this.#readEntry(selected, entry, mediaKind);
          if (!item) { result.ignored++; continue; }
          if (retainEntry(result.entries, item)) result.truncated = true;
        } catch (error) {
          result.ignored++;
          addWarning(result.warnings, `Cannot inspect ${entry.name}: ${errorMessage(error)}`);
        }
      }
    } catch (error) { throw directoryError(error); }
    return result;
  }

  async #readEntry(directory: string, entry: Dirent, mediaKind: MediaKind): Promise<BrowserEntry | null> {
    const filename = path.join(directory, entry.name);
    if (contains(this.#cache, filename) || entryKind(entry, entry.name, mediaKind) === null) return null;
    const info = await lstat(filename);
    const kind = entryKind(info, entry.name, mediaKind);
    if (kind === null) return null;
    if (kind === 'directory') return { name: entry.name, path: filename, kind, size: null };
    return { name: entry.name, path: filename, kind, size: info.size };
  }

  /** Validate the entire batch before any source registration or worker admission.
   * Existence, regular-file and symlink checks remain serial registration errors,
   * so a missing/replaced source does not discard the other valid selections.
   */
  validatePaths(paths: readonly string[]): string[] {
    if (paths.length === 0 || paths.length > MAX_FOOTAGE_FILES) throw new ServiceError(`Select between 1 and ${MAX_FOOTAGE_FILES} recording paths.`, 400);
    return paths.map((filename) => {
      const selected = this.#scopedPath(filename);
      if (!isVideoFilename(path.basename(selected))) throw new ServiceError('Select recording paths ending in .mp4, .mov or .m4v.', 400);
      return selected;
    });
  }

  /** Browser-selected audio is root-scoped; registration owns existence, symlink and probe checks. */
  validateAudioPath(filename: string): string {
    const selected = this.#scopedPath(filename);
    if (!isAudioFilename(path.basename(selected))) throw new ServiceError('Select an audio path ending in .wav, .mp3, .m4a, .aac, .flac, .ogg, .opus, .aiff, .aif or .wma.', 400);
    return selected;
  }

  /** Deliberate manual imports may be outside browser roots, but never inside generated cache data. */
  validateManualPath(filename: string): string {
    if (filename.includes('\0')) throw new ServiceError('Import paths cannot contain NUL.', 400);
    const selected = path.resolve(filename);
    if (contains(this.#cache, selected)) throw new ServiceError('The PasCap cache cannot be registered as original footage.', 403);
    return selected;
  }

  #scopedPath(filename: string, root?: string): string {
    if (!filename || filename.length > 4096 || filename.includes('\0') || !path.isAbsolute(filename) || filename.split(path.sep).includes('..')) {
      throw new ServiceError('Footage paths must be absolute, at most 4096 characters, without NUL or parent traversal.', 400);
    }
    const selected = path.resolve(filename);
    const approved = root === undefined ? this.#roots.some((candidate) => contains(candidate.path, selected)) : contains(root, selected);
    if (!approved) throw new ServiceError('Footage path is outside the selected approved root.', 403);
    if (contains(this.#cache, selected)) throw new ServiceError('The PasCap cache cannot be browsed or registered as footage.', 403);
    return selected;
  }

  async #assertDirectory(directory: string): Promise<void> {
    try {
      if (!(await assertNoSymlinks(directory)).isDirectory()) throw new ServiceError('Footage path must be a directory.', 422);
      await access(directory, constants.R_OK | constants.X_OK);
    } catch (error) { throw directoryError(error); }
  }
}