import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { exportProfileSchema } from '../shared/export.js';
import { projectSchema } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound } from './errors.js';
import { assertNoSymlinks } from './files.js';
import type { JobQueue } from './jobs.js';

const receiptSchema = z.looseObject({
  kind: z.literal('export'), schemaVersion: z.literal(1), jobId: z.uuid(),
  createdAt: z.iso.datetime(), snapshot: projectSchema, profile: exportProfileSchema,
  verification: z.looseObject({ fullDecode: z.literal(true), faststart: z.literal(true), frameCount: z.number().int().positive() }),
});

interface ArchivedExport { receipt: z.infer<typeof receiptSchema>; finishedAt: string }

function parseReceipt(raw: unknown): z.infer<typeof receiptSchema> | null {
  if (typeof raw !== 'object' || raw === null || !('kind' in raw) || raw.kind !== 'export') return null;
  const snapshot = 'snapshot' in raw ? raw.snapshot : undefined;
  const rawVersion = typeof snapshot === 'object' && snapshot !== null && 'schemaVersion' in snapshot ? snapshot.schemaVersion : undefined;
  if (rawVersion !== 6) {
    const version = typeof rawVersion === 'string' || typeof rawVersion === 'number' ? String(rawVersion) : 'missing or invalid';
    throw new Error(`Unsupported export snapshot schema version ${version}; this build requires version 6. The existing receipt and successful output were not changed.`);
  }
  return receiptSchema.parse(raw);
}

async function readCompletedExport(folder: string, id: string): Promise<ArchivedExport | null> {
  const receiptPath = path.join(folder, 'receipt.json');
  const info = await assertNoSymlinks(receiptPath);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid or oversized receipt.');
  const raw: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
  const receipt = parseReceipt(raw);
  if (!receipt) return null;
  if (receipt.jobId !== id) throw new Error('Receipt ID does not match its output directory.');
  const output = await assertNoSymlinks(path.join(folder, 'export.mp4'));
  if (!output.isFile() || !output.size) throw new Error('Completed output is absent.');
  return { receipt, finishedAt: output.mtime.toISOString() };
}

/** Restore strict v6 snapshots only; older receipts/outputs remain untouched and uninterpreted. */
export async function restoreExports(config: ServiceConfig, jobs: JobQueue): Promise<string[]> {
  const directory = path.join(config.dataDir, 'renders');
  let names;
  try { await assertNoSymlinks(directory); names = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const warnings: string[] = [];
  const restored: ArchivedExport[] = [];
  await forEachSerial(names, async (entry) => {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) return;
    const folder = path.join(directory, entry.name);
    try {
      const completed = await readCompletedExport(folder, entry.name); // NOSONAR -- bound receipt memory by reading one archive entry at a time.
      if (completed) restored.push(completed);
    } catch (error) {
      if (!isNotFound(error)) warnings.push(`${entry.name}: ${errorMessage(error)}`);
    }
  });
  restored.sort((a, b) => Date.parse(a.receipt.createdAt) - Date.parse(b.receipt.createdAt));
  for (const { receipt, finishedAt } of restored) jobs.restoreCompleted({
    id: receipt.jobId, kind: 'export', label: `${receipt.snapshot.title} · ${receipt.profile === 'draft720' ? '720p' : '4K'}`,
    state: 'completed', progress: 1, message: 'Verified export restored from receipt', createdAt: receipt.createdAt, finishedAt,
    outputUrl: `/api/jobs/${receipt.jobId}/export`, receiptUrl: `/api/jobs/${receipt.jobId}/receipt`,
  });
  return warnings;
}