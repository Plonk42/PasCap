import { PROJECT_SCHEMA_VERSION } from '../../src/shared/model.js';

/** Every earlier project schema version, each of which must be rejected and preserved. */
export const EARLIER_SCHEMA_VERSIONS = Array.from({ length: PROJECT_SCHEMA_VERSION - 1 }, (_, index) => index + 1);

/** Version rejection/preservation input, deliberately not a maintained historical model. */
export function unsupportedProject(schemaVersion: number, id: string, title: string) {
  return { schemaVersion, id, title };
}
