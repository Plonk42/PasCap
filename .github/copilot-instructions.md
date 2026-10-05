# PasCap working instructions

## Workflow

- Commit after each completed logical step, including its tests and relevant
  documentation. A logical step is a coherent tested behaviour, not each small
  correction; do not leave an entire feature uncommitted until the end.
- Before committing, review the diff, validate the affected behaviour, and stage
  deliberately. Preserve unrelated user edits; never discard them to obtain a
  clean tree. Do not commit generated media, caches, logs, credentials or private paths.
- Formatting is part of the logical step, **before validation, staging and commit**.
  Format changed files with their configured formatter, organize imports where
  applicable, save them and let save actions finish before reviewing/testing the
  final bytes. Do not defer formatting or saves until after the commit. If a save
  changes files after validation or staging, review the delta, rerun invalidated
  checks and restage deliberately before committing. Verify committed files have
  no leftover formatting diff after commit; preserve/report unrelated existing edits.
- The owner authorizes publishing approved, reviewed, validated logical-step commits
  to short-lived branches and opening/updating PRs targeting `main`, without repeated
  push approval. Never push directly to `main`, force-push or bypass protection,
  including as administrator. Preserve unrelated edits; use an isolated worktree
  when another deliverable is active. Record publication blockers and next actions.
- Verify non-CI acceptance against live scope/dependencies and the exact PR head
  before enabling native squash auto-merge. Add `Closes #N` only in the PR description
  when it completes the entire issue; incremental/investigation/hardware-pending PRs
  merely reference it. Required up-to-date PR CI (Node 22/24, native/browser and
  fail-closed Delivery gate) is the merge/closure gate; main push CI is a regression
  backstop, not a second closure wait. Green CI alone is not product acceptance.
  Disable auto-merge and remove closing links before further changes; revalidate
  changed inputs and rereview before rearming against the new head.
- At session start and handoff, inspect relevant PRs and pending deliveries using
  [the GitHub workflow](../docs/GITHUB_WORKFLOW.md). GitHub finishes an armed PR's
  merge and eligible issue closure independently of the chat. Reconcile closed
  issues' obsolete progress labels and Project Done at the next checkpoint; a board
  move never closes an issue. No custom closure Action, hook, bot or scheduled job.
  Releases, milestone closure, legacy cleanup and real-media jobs still need approval.
- Reply in English. Keep summaries concise and identify remaining limitations.
- Keep active documentation focused on the **current project state**: implemented
  behaviour, usage, contracts, limitations and applicable verification. Update or
  remove superseded descriptions instead of accumulating implementation chronology,
  previous baselines or explanations of how the project got here. Keep history in
  GitHub issues/commits or explicitly separate archives/design records, not in current
  guides/status pages; never present historical evidence as current verification.

## Efficient iteration

- Separate focused development feedback from applicable comprehensive delivery
  checks. Run affected tests while editing, not the full browser/native suites after
  every correction. Before committing, satisfy the affected acceptance gates;
  documentation-only changes need documentation checks, not unrelated runtime suites.
- Reuse checks/builds only while their relevant inputs are unchanged. Avoid redundant
  typecheck/build phases; use the [incremental validation guide](../docs/DEVELOPMENT.md)
  without changing scripts or weakening tests merely to shorten a task.
- Never build/check or reset fixtures while browser tests serve the same output/cache.
  Keep browser/media work serial. During terminal validation, subagent reviews must
  use file/search tools only: no terminal commands that could interrupt the run.
- Do not block delivery, repeatedly poll CI, start session CI watchers or rerun local
  suites to occupy a wait. Record the PR/head, verified non-CI acceptance, required
  CI state and auto-merge state, then yield. Failed CI or a stale/conflicting branch
  stays unmerged with a concrete next action. Next-session recovery inspects actual
  PR/check/issue state, not an assumed successful merge or an old green run.
- Keep investigation, issue/Project updates and documentation scoped to the selected
  deliverable; update affected contracts, not the whole backlog or unchanged guides.
  Prefer one concrete deliverable per chat. Use deeper reasoning for architecture,
  timing/ownership and hard failures; a faster model can handle bounded routine work
  when selected by the owner. Do not claim to switch models automatically.
- When evaluating latency, record measured investigation/editing, local-validation,
  delivery-administration and remote-CI durations in existing issue checkpoints;
  do not infer thinking time from session spans or test timeouts. See the
  [efficient work cycle](../docs/GITHUB_WORKFLOW.md).

## GitHub planning and delivery

- GitHub is the system of record for substantive bugs, features, engineering work,
  next actions, Project selection and milestones. Read relevant issue/Project context
  when work is tracked; search before creating an issue. Trivial non-functional
  housekeeping (formatting/import sorting/typos or committing already-reviewed edits)
  needs no issue, Project card or tracking checkpoint unless explicitly requested.
  Do not invent an issue merely to satisfy a commit-reference rule. Proposals/labels
  are not implementation approval; substantive follow-up belongs in GitHub.
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
  open-status synchronization is explicit; a board drag does not update the issue
  label or next action. Native closed-issue → Done is permitted when available;
  never enable Project Done → issue closure or a custom closure workflow.
  If unavailable, record the limitation and continue on the actual work issues;
  never create a replacement sprint issue or duplicate checklist. Record the selected
  issue links on the relevant work issue if a handoff needs context;
  never claim a board exists, request secrets or stop otherwise accessible tracking.
- At the start, after each completed logical step and at handoff, update the issue
  and Project Status when available, with progress, blockers,
  exact local commits, verification and the next action for tracked work. Its commit
  messages use `(#N)`, for example `Improve timeline scrolling (#18)`; issue-free
  housekeeping uses a descriptive message without a fabricated reference. Never
  use `(Refs #N)` or closing keywords in commits/titles. PR descriptions may use
  `Closes #N` only after full non-CI acceptance. Mark verified work awaiting PR
  merge `status:local-complete`, not delivered/closed; partial work retains its
  actual progress and next action.
- Keep local checks, required PR CI and consented hardware/real-workload qualification
  separate. Publish validated implementation steps, not unapproved work merely to
  advance tracking. Full-issue closure follows pre-merge acceptance plus protected
  merge; pending legacy direct-main deliveries still need verified remote evidence.
  Never close milestones, release or start media jobs without explicit approval.
  Public updates must contain sanitized evidence.
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
- **Until the first release candidate, prioritize fast iteration over backward
  compatibility.** Approved scoped changes may break existing saved projects and
  persisted formats; no separate compatibility approval or old-project support
  is required. Keep only the current strict contract: do not add migrations,
  legacy optional fields, compatibility defaults/adapters, parallel old-format
  readers or compatibility-only tests unless explicitly requested. Remove superseded
  code and update affected fixtures/tests/docs to the new contract; retain strict
  rejection and clear recreation/reset guidance for incompatible data. Never silently
  rewrite or delete existing data. Before RC1, agree the subsequent compatibility
  policy with the owner; see [the GitHub workflow](../docs/GITHUB_WORKFLOW.md).
  This does not relax source safety, current-behaviour verification or feature scope;
  historical feature worksheets still do not approve new work.

## Architecture and verification

- Shared integer-frame layout/retiming is authoritative for UI, preview and native
  export. Per-frame rendering stays outside React. Preserve serial heavy-job,
  native child/buffer ownership, exact frame counts and original identity guards.
- Keep strict schema 6 and uniform tracks: every layer requires `ripple`,
  `transitions`, `openingFade` and `closingFade`; no primary/overlay role or
  mandatory first ID. Display the saved bottom-to-top array order (row 1 below
  row 2 in composition). New tracks default to Ripple on. Enabling packs from the
  current first start in one Undo; while on, continuously sequence and persist
  actual starts. Turning off captures actual placements. Independent start/nudge
  while on is only for the first anchor; later clips explain how to turn Ripple off.
  Music, row points and other tracks keep absolute times. Preserve v1–v5 projects
  and receipt snapshots unchanged/incompatible, with no migration; registry/proxy
  formats are unchanged.
- Track-local black fades preserve coverage, including dormant settings on empty
  tracks. Non-cut transitions require touching clips or an existing dissolve;
  positioned dissolve edits explicitly adjust only the right clip, rejecting
  conflicts. Any track may be removed except the last; stacking has only endpoint
  restrictions. Preview has two slots per track (16 maximum) plus one reviewer.
  Generalized native export renders RGBA16 groups then merges without regrading:
  four raw buffers/22 bytes per pixel, two LUTs, three timeline representations,
  two retained clip files, one original decoder, two intermediate readers, one
  encoder and three video children per serial pass. The static fast path requires
  an eligible single opaque, unanimated, zero-origin contiguous track.
- `npm run check` validates types, unit/service tests and production build.
  `npm run test:browser` and `npm run test:media` use isolated synthetic fixtures;
  `npm run test:space` is an additional Linux private-tmpfs opt-in. Never use
  retries, skipped regressions or weaker assertions to hide a failure.
- Refer to [the development guide](../docs/DEVELOPMENT.md),
  [workspace/recovery contracts](../docs/WORKSPACE_AND_RECOVERY.md),
  [speed/audio contracts](../docs/SPEED_AND_AUDIO.md) and
  [layer/resource contracts](../docs/LAYERS_AND_KEYFRAMES.md). Update these when
  behaviour changes. Record dated verification evidence on the corresponding
  GitHub work issue and link actual-commit CI; do not maintain a separate delivery
  status document or relabel historical evidence as a new result.
