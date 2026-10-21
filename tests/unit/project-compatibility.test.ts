import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/server/storage.js';
import {
  musicTracksSchema,
  PROJECT_SCHEMA_VERSION,
  projectSchema,
  type MusicLane,
  type MusicTrack,
} from '../../src/shared/model.js';
import { musicTracks } from '../../src/shared/music-lanes.js';
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

  it('upgrades each schema-23 music track to a track holding one clip that plays exactly the same', async () => {
    const saved = JSON.parse(await readFile(path.join(FIXTURES, 'schema-23.json'), 'utf8')) as {
      music: MusicTrack[];
    };
    const before = structuredClone(saved);
    const upgraded = projectSchema.parse(upgradeProject(saved));
    expect(saved).toEqual(before);
    expect(saved.music.length).toBeGreaterThan(0);
    expect(musicTracks(upgraded.music)).toEqual(saved.music);
    expect(upgraded.music.map((lane) => lane.id)).toEqual(saved.music.map((_, index) => `music-track-${index + 1}`));
    for (const lane of upgraded.music) expect(lane).toMatchObject({ ripple: false, transitions: [] });
  });

  it('keeps every saved music value through the upgrade, so invalid data is still rejected', () => {
    const track = {
      id: 'music-track-1',
      mediaId: 'song',
      sourceIn: 0,
      sourceOut: 30,
      start: 0,
      duration: 30,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    };
    const upgrade = (music: unknown) => upgradeProject({ schemaVersion: 23, music }) as { music: unknown };
    const [lane] = upgrade([track]).music as MusicLane[];
    const { gainDb, fadeIn, fadeOut, ...clip } = track;
    // A lane ID never collides with a saved ID, which the clip keeps.
    expect(lane).toEqual({
      id: 'music-track-1-x',
      gainDb,
      ripple: false,
      openingFade: fadeIn,
      closingFade: fadeOut,
      clips: [clip],
      transitions: [],
    });
    expect(musicTracksSchema.safeParse(upgrade([{ ...track, extra: true }]).music).success).toBe(false);
    const { gainDb: _gain, ...missing } = track;
    expect(musicTracksSchema.safeParse(upgrade([missing]).music).success).toBe(false);
    expect(upgrade(null).music).toBeNull();
    expect(upgrade([null]).music).toEqual([null]);
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
