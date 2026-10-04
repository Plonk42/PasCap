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
- Keep active documentation focused on the **current project state**: implemented
  behaviour, usage, contracts, limitations and applicable verification. Update or
  remove superseded descriptions instead of accumulating implementation chronology,
  previous baselines or explanations of how the project got here. Keep history in
  GitHub issues/commits or explicitly separate archives/design records, not in current
  guides/status pages; never present historical evidence as current verification.

## GitHub planning and delivery

- GitHub is the system of record for issues, next actions, approved features,
  Project selection/iterations and milestones. Before implementation, read the relevant
  issue and Project context; search before creating a scoped issue. Proposals/labels are
  not approval to expand scope. Do not leave the next steps only in chat or local plans.
- After triage, give each issue one category (`bug`, `enhancement` or `task`),
  one `priority:p0`–`priority:p3`, relevant `area:*` labels and an outcome milestone.
  Every open issue also needs one `status:*` label and a concrete next action.
  Use the definitions in [the GitHub workflow](../docs/GITHUB_WORKFLOW.md).
- **Never create or maintain an issue as a sprint/iteration container.** Issues track
  concrete deliverables; native parent/sub-issue relationships describe decomposition,
  never sprint membership. Use the Project's native Iteration field for explicitly
  agreed timeboxes; do not invent cadence, start dates or deadlines. Without an agreed
  cadence, use the backlog/Status board and a bounded selected-work view instead.
- Existing #15 and `iteration`/`iteration:current` labels are legacy tracking, not a
  pattern to copy or a mandate to keep a second checklist synchronized. Preserve their
  history and existing relationships; do not close, reparent or bulk relabel them
  without explicit approval. Use native blocked-by links for real prerequisites and
  milestones for deliverable outcomes, not sprint dates or media-work permission.
- Use a repository-linked GitHub Project for board/iteration views when access is
  available, reusing the same issues and keeping its Status aligned with issue labels.
  Add new triaged issues to that Project, not duplicate draft cards. Status/label
  synchronization is explicit; a board drag does not update the issue label or next action.
  If unavailable, record the limitation and continue on the actual work issues;
  never create a replacement sprint issue or duplicate checklist. Record the selected
  issue links on the relevant work issue if a handoff needs context;
  never claim a board exists, request secrets or stop otherwise accessible tracking.
- At the start, after each completed logical step and at handoff, update the issue
  and Project Status when available, with progress, blockers,
  exact local commits, verification and the next action. Commit references use
  `Refs #N`; do not add automatic closing keywords.
  Mark verified unpublished work `status:local-complete`, not accepted/closed.
- Keep local checks, actual-commit remote CI and consented hardware/real-workload
  qualification separate. Do not push, close issues/milestones, release, or start
  media jobs merely to advance tracking. Public updates must contain sanitized evidence.
- Keep [the roadmap](../docs/ROADMAP.md) as an outcome/dependency index and local
  guides as contracts/evidence, not a competing mutable backlog. Preserve design history.

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
