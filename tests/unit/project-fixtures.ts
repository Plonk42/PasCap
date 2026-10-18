import { OLDEST_PROJECT_SCHEMA_VERSION } from '../../src/shared/project-migrations.js';

/** Every project schema version older than the oldest supported one, each of which must be rejected and preserved. */
export const EARLIER_SCHEMA_VERSIONS = Array.from(
  { length: OLDEST_PROJECT_SCHEMA_VERSION - 1 },
  (_, index) => index + 1,
);

/** Version rejection/preservation input, deliberately not a maintained historical model. */
export function unsupportedProject(schemaVersion: number, id: string, title: string) {
  return { schemaVersion, id, title };
}
