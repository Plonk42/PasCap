import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { audioAssetSchema } from '../shared/audio.js';
import { defaultExportName, exportOutputNameSchema, exportProfileSchema, planExportMusic } from '../shared/export.js';
import { idSchema, MAX_MUSIC_TRACKS, projectSchema } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import { calculateLayout } from '../shared/timeline.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound } from './errors.js';
import { assertNoSymlinks } from './files.js';
import type { JobQueue } from './jobs.js';

const sampleCountSchema = z.number().int().nonnegative();
const exportMusicPlanSchema = z.strictObject({
  id: idSchema,
  mediaId: idSchema,
  loop: z.boolean(),
  sourceInSamples: sampleCountSchema,
  sourceOutSamples: sampleCountSchema,
  startSamples: sampleCountSchema,
  durationSamples: sampleCountSchema,
  activeSamples: sampleCountSchema,
  fadeInSamples: sampleCountSchema,
  fadeOutSamples: sampleCountSchema,
  videoSamples: sampleCountSchema.positive(),
  gain: z
    .number()
    .min(10 ** (-60 / 20))
    .max(10 ** (12 / 20)),
});

const receiptSchema = z
  .looseObject({
    kind: z.literal('export'),
    schemaVersion: z.literal(1),
    jobId: z.uuid(),
    createdAt: z.iso.datetime(),
    snapshot: projectSchema,
    profile: exportProfileSchema,
    // Receipts written before output names existed have none; they keep the default label.
    outputName: exportOutputNameSchema.optional(),
    musicSources: z.array(audioAssetSchema).max(MAX_MUSIC_TRACKS),
    settings: z.looseObject({
      audio: z.array(exportMusicPlanSchema).max(MAX_MUSIC_TRACKS),
    }),
    verification: z.looseObject({
      fullDecode: z.literal(true),
      faststart: z.literal(true),
      frameCount: z.number().int().positive(),
    }),
  })
  .superRefine((receipt, context) => {
    const sourceIds = new Set(receipt.musicSources.map((source) => source.id));
    const referencedIds = new Set(receipt.snapshot.music.map((music) => music.mediaId));
    if (
      sourceIds.size !== receipt.musicSources.length ||
      sourceIds.size !== referencedIds.size ||
      [...referencedIds].some((id) => !sourceIds.has(id))
    )
      context.addIssue({
        code: 'custom',
        path: ['musicSources'],
        message: 'Captured music sources must uniquely match all and only snapshot music media IDs.',
      });

    const plans = new Map(receipt.settings.audio.map((plan) => [plan.id, plan]));
    if (plans.size !== receipt.settings.audio.length || plans.size !== receipt.snapshot.music.length)
      context.addIssue({
        code: 'custom',
        path: ['settings', 'audio'],
        message: 'Audio plans must uniquely match snapshot music instance IDs.',
      });
    let duration: number;
    try {
      duration = calculateLayout(receipt.snapshot).duration;
    } catch (error) {
      // Zod refinements may continue after a nested refinement adds an issue.
      // A malformed persisted layout must be a validation failure, not an escape
      // from safeParse that loses the archive's preservation/error context.
      context.addIssue({
        code: 'custom',
        path: ['snapshot'],
        message: errorMessage(error),
      });
      return;
    }
    for (const music of receipt.snapshot.music) {
      const expected = planExportMusic(music, duration);
      const plan = plans.get(music.id);
      if (!plan || Object.entries(expected).some(([key, value]) => plan[key as keyof typeof plan] !== value))
        context.addIssue({
          code: 'custom',
          path: ['settings', 'audio'],
          message: `Audio plan for ${music.id} must match the authoritative snapshot music plan.`,
        });
    }
  });

interface ArchivedExport {
  receipt: z.infer<typeof receiptSchema>;
  finishedAt: string;
}

function parseReceipt(raw: unknown): z.infer<typeof receiptSchema> | null {
  if (typeof raw !== 'object' || raw === null || !('kind' in raw) || raw.kind !== 'export') return null;
  const snapshot = 'snapshot' in raw ? raw.snapshot : undefined;
  const rawVersion =
    typeof snapshot === 'object' && snapshot !== null && 'schemaVersion' in snapshot
      ? snapshot.schemaVersion
      : undefined;
  if (rawVersion !== 14) {
    const version =
      typeof rawVersion === 'string' || typeof rawVersion === 'number' ? String(rawVersion) : 'missing or invalid';
    throw new Error(
      `Unsupported export snapshot schema version ${version}; this build requires version 14. The existing receipt and successful output were not changed.`,
    );
  }
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Cannot restore this export receipt: ${parsed.error.message}. The existing receipt and successful output were not changed.`,
      { cause: parsed.error },
    );
  return parsed.data;
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

/** Restore strict v14 snapshots only; older receipts/outputs remain untouched and uninterpreted. */
export async function restoreExports(config: ServiceConfig, jobs: JobQueue): Promise<string[]> {
  const directory = path.join(config.dataDir, 'renders');
  let names;
  try {
    await assertNoSymlinks(directory);
    names = await readdir(directory, { withFileTypes: true });
  } catch (error) {
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
  for (const { receipt, finishedAt } of restored)
    jobs.restoreCompleted({
      id: receipt.jobId,
      kind: 'export',
      label: receipt.outputName ?? defaultExportName(receipt.snapshot.title, receipt.profile),
      state: 'completed',
      progress: 1,
      message: 'Verified export restored from receipt',
      createdAt: receipt.createdAt,
      finishedAt,
      outputUrl: `/api/jobs/${receipt.jobId}/export`,
      receiptUrl: `/api/jobs/${receipt.jobId}/receipt`,
    });
  return warnings;
}
