import { OLDEST_PROJECT_SCHEMA_VERSION, supportedProjectVersions } from '../../src/shared/project-migrations.js';

/** How a rejection names the schema versions this build opens, e.g. "versions 23–24". */
export const SUPPORTED_VERSIONS = supportedProjectVersions();

/** Every project schema version older than the oldest supported one, each of which must be rejected and preserved. */
export const EARLIER_SCHEMA_VERSIONS = Array.from(
  { length: OLDEST_PROJECT_SCHEMA_VERSION - 1 },
  (_, index) => index + 1,
);

/** Version rejection/preservation input, deliberately not a maintained historical model. */
export function unsupportedProject(schemaVersion: number, id: string, title: string) {
  return { schemaVersion, id, title };
}
