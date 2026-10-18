import { PROJECT_SCHEMA_VERSION } from './model.js';

/** Oldest saved project schema this build still opens: the first one used for real editing. */
export const OLDEST_PROJECT_SCHEMA_VERSION = 23;

type SavedProject = Record<string, unknown>;
type Migration = (document: SavedProject) => SavedProject;

/** `MIGRATIONS[v]` upgrades a document saved with schema `v` to schema `v + 1`; it never mutates its input. */
const MIGRATIONS: Readonly<Partial<Record<number, Migration>>> = {};

export function supportedProjectVersions(): string {
  return OLDEST_PROJECT_SCHEMA_VERSION === PROJECT_SCHEMA_VERSION
    ? `version ${PROJECT_SCHEMA_VERSION}`
    : `versions ${OLDEST_PROJECT_SCHEMA_VERSION}–${PROJECT_SCHEMA_VERSION}`;
}

/** Every schema version without an upgrade step to the next one; empty when the chain is complete. */
export function missingMigrations(): number[] {
  return Array.from(
    { length: PROJECT_SCHEMA_VERSION - OLDEST_PROJECT_SCHEMA_VERSION },
    (_, index) => OLDEST_PROJECT_SCHEMA_VERSION + index,
  ).filter((version) => !MIGRATIONS[version]);
}

/**
 * Upgrades a saved project document to the current schema in memory, without validating it.
 * Throws for versions this build cannot open; the caller validates the result with `projectSchema`.
 */
export function upgradeProject(value: unknown, subject = 'project'): unknown {
  const rawVersion =
    typeof value === 'object' && value !== null && 'schemaVersion' in value ? value.schemaVersion : undefined;
  if (
    typeof rawVersion !== 'number' ||
    !Number.isInteger(rawVersion) ||
    rawVersion < OLDEST_PROJECT_SCHEMA_VERSION ||
    rawVersion > PROJECT_SCHEMA_VERSION
  ) {
    const version =
      typeof rawVersion === 'string' || typeof rawVersion === 'number' ? String(rawVersion) : 'missing or invalid';
    const reason =
      typeof rawVersion === 'number' && rawVersion > PROJECT_SCHEMA_VERSION
        ? 'It was saved by a newer PasCap version; update PasCap to open it.'
        : `Projects older than version ${OLDEST_PROJECT_SCHEMA_VERSION} cannot be upgraded.`;
    throw new Error(
      `Unsupported ${subject} schema version ${version}; this build requires ${supportedProjectVersions()}. ${reason}`,
    );
  }
  let document = value as SavedProject;
  for (let version = rawVersion; version < PROJECT_SCHEMA_VERSION; version += 1) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`No upgrade from project schema version ${version} to ${version + 1}.`);
    document = { ...migrate(document), schemaVersion: version + 1 };
  }
  return document;
}
