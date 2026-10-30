import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/server/storage.js';
import { PROJECT_SCHEMA_VERSION, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import {
  missingMigrations,
  OLDEST_PROJECT_SCHEMA_VERSION,
  upgradeProject,
} from '../../src/shared/project-migrations.js';

const FIXTURES = path.join(import.meta.dirname, '../fixtures/projects');
/** Projects saved before schema 28, with track Color or British field names: rejected, never upgraded. */
const UNSUPPORTED = path.join(FIXTURES, 'unsupported');
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('project compatibility', () => {
  it('upgrades every supported schema version step by step to the current one', () => {
    expect(OLDEST_PROJECT_SCHEMA_VERSION).toBeLessThanOrEqual(PROJECT_SCHEMA_VERSION);
    expect(missingMigrations()).toEqual([]);
  });

  it('keeps a frozen project file for every supported schema version', async () => {
    const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.json')).sort();
    expect(names).toEqual(
      Array.from(
        { length: PROJECT_SCHEMA_VERSION - OLDEST_PROJECT_SCHEMA_VERSION + 1 },
        (_, index) => `schema-${OLDEST_PROJECT_SCHEMA_VERSION + index}.json`,
      ).sort(),
    );
  });

  it('opens every frozen project file with this build without rewriting it', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pascap-compatibility-'));
    temporary.push(dataDir);
    await mkdir(path.join(dataDir, 'projects'));
    const store = new ProjectStore(dataDir);
    for (const name of (await readdir(FIXTURES)).filter((entry) => entry.endsWith('.json'))) {
      const bytes = await readFile(path.join(FIXTURES, name), 'utf8');
      const saved = JSON.parse(bytes) as { id: string; schemaVersion: number };
      const filename = path.join(dataDir, 'projects', `${saved.id}.json`);
      await writeFile(filename, bytes);
      const loaded = await store.load(saved.id);
      expect(loaded.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
      expect(loaded.clips.length).toBeGreaterThan(0);
      expect(await readFile(filename, 'utf8')).toBe(bytes);
      await rm(filename);
    }
  });

  it('keeps the adjustments, clip grades and Transform Opacity of a schema-28 project through the load', async () => {
    const saved = JSON.parse(await readFile(path.join(FIXTURES, 'schema-28.json'), 'utf8')) as ProjectDocument;
    const loaded = projectSchema.parse(upgradeProject(saved));
    expect(loaded).toEqual(saved);
    expect(loaded.adjustments.length).toBeGreaterThan(1);
    expect(loaded.adjustments[0]!.keyframes.length).toBeGreaterThan(0);
    expect(loaded.layers[0]!.transform.base.opacity).toBeLessThan(1);
    expect(loaded.clips.some((clip) => clip.grade.keyframes.length > 0)).toBe(true);
  });

  it('rejects projects saved with track Color or British field names, with the reason, and leaves their files unchanged', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pascap-compatibility-'));
    temporary.push(dataDir);
    await mkdir(path.join(dataDir, 'projects'));
    const store = new ProjectStore(dataDir);
    const names = (await readdir(UNSUPPORTED)).filter((entry) => entry.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const bytes = await readFile(path.join(UNSUPPORTED, name), 'utf8');
      const saved = JSON.parse(bytes) as { id: string; schemaVersion: number };
      expect(saved.schemaVersion).toBeLessThan(OLDEST_PROJECT_SCHEMA_VERSION);
      const filename = path.join(dataDir, 'projects', `${saved.id}.json`);
      await writeFile(filename, bytes);
      await expect(store.load(saved.id)).rejects.toThrow(
        saved.schemaVersion < 27 ? 'track Color, which PasCap replaced' : 'renamed to American English',
      );
      expect(await readFile(filename, 'utf8')).toBe(bytes);
      expect(await readdir(path.join(dataDir, 'projects'))).toEqual([`${saved.id}.json`]);
      await rm(filename);
    }
  });

  it('rejects versions outside the supported range with the reason', () => {
    expect(() => upgradeProject({ schemaVersion: OLDEST_PROJECT_SCHEMA_VERSION - 1 })).toThrow('cannot be upgraded');
    expect(() => upgradeProject({ schemaVersion: PROJECT_SCHEMA_VERSION + 1 })).toThrow(
      'saved by a newer PasCap version',
    );
    expect(() => upgradeProject({ schemaVersion: '27' })).toThrow('Unsupported project schema version 27');
    expect(() => upgradeProject(null)).toThrow('Unsupported project schema version missing or invalid');
    expect(() => upgradeProject({ schemaVersion: 1 }, 'export snapshot')).toThrow(
      'Unsupported export snapshot schema version 1',
    );
  });
});
