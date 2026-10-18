import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/server/storage.js';
import { PROJECT_SCHEMA_VERSION } from '../../src/shared/model.js';
import {
  missingMigrations,
  OLDEST_PROJECT_SCHEMA_VERSION,
  upgradeProject,
} from '../../src/shared/project-migrations.js';

const FIXTURES = path.join(import.meta.dirname, '../fixtures/projects');
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

  it('rejects versions outside the supported range with the reason', () => {
    expect(() => upgradeProject({ schemaVersion: OLDEST_PROJECT_SCHEMA_VERSION - 1 })).toThrow('cannot be upgraded');
    expect(() => upgradeProject({ schemaVersion: PROJECT_SCHEMA_VERSION + 1 })).toThrow(
      'saved by a newer PasCap version',
    );
    expect(() => upgradeProject({ schemaVersion: '23' })).toThrow('Unsupported project schema version 23');
    expect(() => upgradeProject(null)).toThrow('Unsupported project schema version missing or invalid');
    expect(() => upgradeProject({ schemaVersion: 1 }, 'export snapshot')).toThrow(
      'Unsupported export snapshot schema version 1',
    );
  });
});
