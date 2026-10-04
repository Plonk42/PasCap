# PasCap working instructions

## Workflow

- Commit after each completed logical step, including its tests and relevant
  documentation. Do not leave an entire feature uncommitted until the end.
- Before committing, review the diff, validate the affected behaviour, and stage
  deliberately. Preserve unrelated user edits; never discard them to obtain a
  clean tree. Do not commit generated media, caches, logs, credentials or private paths.
- Do not push, publish releases or close GitHub issues unless requested. Distinguish
  verified local results from remote CI and hardware qualification.
- Reply in English. Keep summaries concise and identify remaining limitations.

## Product and data safety

- Make the editor simple to learn without removing features. Place common actions
  where expected, use relevant accessible native controls, prefer visual feedback
  to repeated explanatory text, and disclose advanced details contextually.
- Preserve keyboard/focus behaviour, responsive hit targets, reversible drafts and
  one Undo step per completed gesture. Invalid edits must not silently clamp,
  merge, overwrite or shorten unrelated settings.
- Originals are referenced in place, never uploaded/copied/modified. Verification
  uses disposable synthetic media or memory-only projects. Real imports,
  preparations, exports, benchmarks and long renders need explicit owner consent.
- Keep persisted data strict. Do not add migrations, optional legacy fields or
  compatibility defaults unless explicitly requested. New feature scope must
  not be inferred from historical feature worksheets.

## Architecture and verification

- Shared integer-frame layout/retiming is authoritative for UI, preview and native
  export. Per-frame rendering stays outside React. Preserve serial heavy-job,
  native child/buffer ownership, exact frame counts and original identity guards.
- `npm run check` validates types, unit/service tests and production build.
  `npm run test:browser` and `npm run test:media` use isolated synthetic fixtures;
  `npm run test:space` is an additional Linux private-tmpfs opt-in. Never use
  retries, skipped regressions or weaker assertions to hide a failure.
- Refer to [the development guide](../docs/DEVELOPMENT.md),
  [workspace/recovery contracts](../docs/WORKSPACE_AND_RECOVERY.md),
  [speed/audio contracts](../docs/SPEED_AND_AUDIO.md) and
  [current delivery evidence](../docs/DELIVERY_STATUS.md). Update these when
  behaviour changes; do not relabel historical evidence as a new result.