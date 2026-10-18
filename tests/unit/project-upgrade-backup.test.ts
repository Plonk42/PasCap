import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectStore } from '../../src/server/storage.js';
import { createProject, PROJECT_SCHEMA_VERSION } from '../../src/shared/model.js';

// Stands in for a future migration from the previous schema version.
vi.mock('../../src/shared/project-migrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/project-migrations.js')>();
  const { PROJECT_SCHEMA_VERSION: current } = await import('../../src/shared/model.js');
  return {
    ...actual,
    upgradeProject: (value: unknown) => {
      const saved = value as { schemaVersion: number };
      return saved.schemaVersion === current - 1 ? { ...saved, schemaVersion: current } : actual.upgradeProject(value);
    },
  };
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('keeps the original bytes of an upgraded project before its first save overwrites them', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pascap-upgrade-'));
  temporary.push(dataDir);
  await mkdir(path.join(dataDir, 'projects'));
  const filename = path.join(dataDir, 'projects', 'older.json');
  const previous = PROJECT_SCHEMA_VERSION - 1;
  const original = `${JSON.stringify({ ...createProject('older', 'Older'), schemaVersion: previous, revision: 3 }, null, 2)}\n`;
  await writeFile(filename, original);
  const store = new ProjectStore(dataDir);

  const loaded = await store.load('older');
  expect(loaded.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  expect(await readFile(filename, 'utf8')).toBe(original);

  const saved = await store.save({ ...loaded, title: 'Edited' }, 3);
  const backup = `${filename}.schema-${previous}.bak`;
  expect(await readFile(backup, 'utf8')).toBe(original);
  expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(saved);

  await store.save({ ...saved, title: 'Edited again' }, saved.revision);
  expect(await readFile(backup, 'utf8')).toBe(original);
  expect(await readdir(path.join(dataDir, 'projects'))).toEqual(['older.json', `older.json.schema-${previous}.bak`]);
  expect((await store.list()).map((entry) => [entry.id, entry.title])).toEqual([['older', 'Edited again']]);
});
