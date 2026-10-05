import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { createConfig } from '../../src/server/config.js';
import { restoreExports } from '../../src/server/export-archive.js';
import { JobQueue } from '../../src/server/jobs.js';
import { unsupportedProject } from './project-fixtures.js';

const temporary: string[] = [];
afterEach(async () => { for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true }); });
describe('durable export receipts', () => {
  it('restores verified completed outputs without touching their receipt or source edit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-')); temporary.push(root);
    const id = randomUUID(); const folder = path.join(root, 'renders', id); await mkdir(folder, { recursive: true });
    const snapshot = createProject('flight', 'Flight'); snapshot.clips.push(createClip('one', 'source', 0, 10));
    snapshot.layers[0]!.keyframes = [{ frame: 5, interpolation: 'smooth', values: { ...EMPTY_KEY_VALUES, clipOpacity: 0.5, exposure: 0.7 } }];
    expect(snapshot.schemaVersion).toBe(6);
    const text = JSON.stringify({ kind: 'export', schemaVersion: 1, jobId: id, createdAt: new Date().toISOString(), snapshot, profile: 'draft720', verification: { frameCount: 10, fullDecode: true, faststart: true } });
    await writeFile(path.join(folder, 'receipt.json'), text); await writeFile(path.join(folder, 'export.mp4'), 'verified output fixture');
    const jobs = new JobQueue(); expect(await restoreExports(createConfig({ dataDir: root }), jobs)).toEqual([]);
    expect(jobs.get(id)).toMatchObject({ kind: 'export', state: 'completed', progress: 1, outputUrl: `/api/jobs/${id}/export` });
    expect(await readFile(path.join(folder, 'receipt.json'), 'utf8')).toBe(text);
    await restoreExports(createConfig({ dataDir: root }), jobs); expect(jobs.list()).toHaveLength(1); await jobs.close();
  });
  it.each([3, 4, 5])('leaves version-1 receipts with unsupported v%s snapshots and their completed outputs unchanged', async (version) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-')); temporary.push(root);
    const id = randomUUID(); const folder = path.join(root, 'renders', id); await mkdir(folder, { recursive: true });
    const snapshot = unsupportedProject(version, 'unsupported-flight', `Original v${version} flight`);
    const text = JSON.stringify({ kind: 'export', schemaVersion: 1, jobId: id, createdAt: new Date().toISOString(), snapshot, profile: 'draft720', verification: { frameCount: 60, fullDecode: true, faststart: true } });
    const output = 'completed legacy output fixture';
    await writeFile(path.join(folder, 'receipt.json'), text); await writeFile(path.join(folder, 'export.mp4'), output);
    const jobs = new JobQueue();
    try {
      const warnings = await restoreExports(createConfig({ dataDir: root }), jobs);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Unsupported export snapshot schema version ${version}; this build requires version 6`);
      expect(jobs.list()).toEqual([]);
      expect(await readFile(path.join(folder, 'receipt.json'), 'utf8')).toBe(text);
      expect(await readFile(path.join(folder, 'export.mp4'), 'utf8')).toBe(output);
    } finally { await jobs.close(); }
  });
  it('does not restore failed/incomplete outputs or rewrite corrupt receipts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-archive-')); temporary.push(root);
    const folder = path.join(root, 'renders', randomUUID()); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'receipt.json'), 'not-json');
    const jobs = new JobQueue(); expect(await restoreExports(createConfig({ dataDir: root }), jobs)).toHaveLength(1);
    expect(jobs.list()).toHaveLength(0); expect(await readFile(path.join(folder, 'receipt.json'), 'utf8')).toBe('not-json'); await jobs.close();
  });
});