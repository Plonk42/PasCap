/** Version rejection/preservation input, deliberately not a maintained historical model. */
export function unsupportedProject(schemaVersion: number, id: string, title: string) {
  return { schemaVersion, id, title };
}