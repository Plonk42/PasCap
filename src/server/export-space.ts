import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { estimateExportSpace, exportPreflightSchema, formatStorageBytes, MIN_EXPORT_FREE_BYTES, type ExportPreflight } from '../shared/export-space.js';
import type { ExportProfile } from '../shared/export.js';
import type { ProjectDocument } from '../shared/model.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';

async function exportVolume(dataDirectory: string, directory: string): Promise<string> {
  try {
    if (!(await assertNoSymlinks(directory)).isDirectory()) throw new ServiceError('The export location must be a regular directory.', 422);
    return directory;
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
    if (!(await assertNoSymlinks(dataDirectory)).isDirectory()) throw new ServiceError('The data location must be a regular directory.', 422);
    return dataDirectory;
  }
}

/** Read filesystem metadata only. The output and job-owned scratch share this volume. */
export async function readExportSpace(dataDirectory: string, document: ProjectDocument, profile: ExportProfile): Promise<ExportPreflight> {
  const directory = path.join(dataDirectory, 'renders');
  let availableBytes: number;
  try {
    // An existing renders directory may be a separate mounted volume.
    const disk = await statfs(await exportVolume(dataDirectory, directory), { bigint: true });
    if (disk.bsize <= 0n || disk.bavail < 0n) throw new Error('The filesystem did not report usable free space.');
    availableBytes = Number(disk.bsize * disk.bavail);
    if (!Number.isFinite(availableBytes)) throw new Error('The filesystem reported an unsupported capacity.');
  } catch (cause) {
    throw new ServiceError(`Cannot check export storage at ${directory}. Check the mount and permissions, then retry. ${errorMessage(cause)}`, 503);
  }
  const estimate = estimateExportSpace(document, profile);
  let status: ExportPreflight['status'] = 'available';
  if (availableBytes < MIN_EXPORT_FREE_BYTES) status = 'blocked';
  else if (availableBytes < estimate.totalBytes) status = 'tight';
  return exportPreflightSchema.parse({ directory, availableBytes, estimate, status, checkedAt: new Date().toISOString() });
}

export function requireExportReserve(space: ExportPreflight): void {
  if (space.availableBytes < MIN_EXPORT_FREE_BYTES) {
    throw new ServiceError(`Not enough free space to start an export at ${space.directory}: ${formatStorageBytes(space.availableBytes)} available. Free at least ${formatStorageBytes(MIN_EXPORT_FREE_BYTES)} and retry. This is only the start reserve; the full render may need substantially more. No render was started.`, 507);
  }
}

/** Native FFmpeg reports ENOSPC in stderr; filesystem writes expose the errno. */
export function exportStorageFailure(cause: unknown, directory: string): unknown {
  const errno = cause instanceof Error && 'code' in cause ? cause.code : null;
  const detail = errorMessage(cause);
  const quota = errno === 'EDQUOT' || /disk quota exceeded/i.test(detail);
  if (errno !== 'ENOSPC' && !quota && !/no space left on device/i.test(detail)) return cause;
  const recovery = quota ? 'Export reached a storage quota. Free space within your quota or ask its administrator to raise it' : 'Export ran out of space. Free space on this volume';
  return new ServiceError(`${recovery} at ${directory}, then start a new export. Only this job's temporary/partial files are cleaned up; originals, saved projects and completed exports are kept.`, 507);
}