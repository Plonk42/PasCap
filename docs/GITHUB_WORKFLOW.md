# GitHub planning and delivery

GitHub [issues](https://github.com/Plonk42/PasCap/issues) are the system of record
for substantive bugs, approved features, engineering tasks, next actions and blockers.
Not every action needs an issue: trivial non-functional formatting/import sorting,
typos and committing already-reviewed housekeeping use a descriptive commit and
protected PR, local verification and a concise chat handoff. Do not create
an issue, Project card or artificial acceptance checklist merely to commit/push.
Use an issue when work needs substantive scope/acceptance, investigation, coordination
or persistent follow-up, or when the owner explicitly asks to log it. Native dependencies,
sub-issues, [milestones](https://github.com/Plonk42/PasCap/milestones) and iteration
tracking describe how that work is delivered. Local guides describe contracts and
dated evidence; [ROADMAP.md](ROADMAP.md) is an outcome/dependency index, not a second
mutable backlog. Historical plans and feature worksheets do not approve new scope.

Record dated verification and acceptance evidence on the corresponding work issue:
exact commit, toolchain, commands/results, remaining criteria and actual-commit CI
links. Keep local checks, remote CI and consented hardware/real-workload evidence
distinct. Versioned guides contain current behaviour, contracts, limitations and
validation procedures, not a separate delivery-status ledger. Earlier documentation
and verification snapshots remain in Git history; they are not current acceptance.

## Work cycle

1. **Inspect before acting.** Confirm the repository/host and, for tracked work, current issue,
   comments, dependencies and Project selection. Search before creating a new issue; reuse
   an existing scope rather than duplicating it. A task/feature needs a goal,
   non-goals, observable acceptance, an outcome milestone and a concrete next action.
   Before any new task's edits or validation, complete the
   [fresh-main startup gate](#start-every-new-task-from-current-main), including housekeeping.
2. **Triage.** Apply the category, priority, area and progress labels below. Record
   decisions/consent needed and native blocked-by relationships for actual prerequisites.
   Add the same issue to the linked Project; do not duplicate it as a draft card.
   Assign a person only when responsibility is known; otherwise name the decision
   needed in the next action. Templates start at normal/backlog, not confirmed severity.
3. **Select bounded work in the Project.** For explicitly agreed timeboxes, assign
   existing approved issues to a native Iteration field. Without an agreed cadence,
   use the backlog/Status board and a selected-work view. Do not create a sprint
   issue, copy acceptance checklists or use parent/sub-issues for sprint membership.
   Native sub-issues describe deliverable decomposition; milestones describe outcomes.
   Never invent iteration dates/deadlines or infer selection from issue logging.
4. **Deliver incrementally.** At the start, after each completed logical step and
   at handoff, update the work issue and Project Status: progress, blockers,
   exact local commits, checks/evidence, remaining acceptance and the next action. Validate/review and
   commit each coherent step with its tests/docs, not every intermediate correction;
   use the focused-feedback and delivery-check separation below. Tracked commit messages and PR titles use
   `(#N)`, for example `Improve timeline scrolling (#18)`, never `(Refs #N)` or
   closing keywords in titles/commits. Publish approved, validated logical-step
   commits to short-lived branches and open/update protected PRs targeting `main`,
   without repeated approval. Issue-free housekeeping uses a descriptive message without a
   reference and needs no issue/Project administration. An unpublished SHA is a local reference, not a working GitHub
   commit link; report any publication blocker.
5. **Accept before auto-merge.** Verify non-CI acceptance against live scope and the
   exact reviewed PR head before enabling native auto-merge. A full-delivery PR may
   then use `Closes #N` in its description; partial work merely references its issue.
   Required up-to-date PR CI gates merge and eligible issue closure. Main push CI is
   a regression backstop, not a second closure wait. Closing milestones, publishing
   releases or running owner-media jobs still needs explicit authorization. Keep optional
   sprint goals/review notes short; they must not become a second mutable backlog.
   Moving work between Project iterations does not accept or close its issues.
6. **Retire task worktrees.** After an observed merge, at handoff and next-session
   reconciliation, apply the [worktree lifecycle](#worktree-lifecycle-and-cleanup).
   Remove safe completed agent-owned trees; record a reason and next action for
   each retained relevant tree. Remote head-branch deletion is not local cleanup.

Public updates must be sanitized: no private source/project paths, snapshots,
credentials, recordings, licensed music or generated reports. Real imports,
preparations, benchmarks and long renders still require explicit owner consent.

## Compatibility before the first release candidate

Until the first release candidate (RC1), **fast iteration takes precedence over
backward compatibility**. Approved scoped work may break existing saved projects
and persisted formats. Keeping old projects usable is not an acceptance gate and
does not need separate compatibility approval; the owner accepts recreating them.
This is not blanket approval for unrelated feature changes or data deletion.

- Maintain one **current, strict** data contract. Do not add migrations, optional
  legacy fields, compatibility defaults/adapters, parallel old-format readers or
  tests whose only purpose is retaining superseded behaviour unless the owner
  explicitly requests that compatibility work.
- Prefer changing/removing superseded code over carrying both implementations.
  Update affected fixtures, tests and documentation to the current contract; retain
  strict invalid/incompatible-data rejection and applicable current-behaviour tests.
- Record breaking changes and the required project recreation or explicit
  generated-data reset in the work issue/PR and affected usage contracts. Version
  changed formats deliberately so incompatible data is clearly identified, not
  silently accepted through defaults, rewritten or deleted. A reset requirement
  is guidance, not permission to perform the reset.
- Original media and completed exports stay untouched; incompatible saved data is
  preserved, not automatically rewritten/deleted. Source identity, atomic edits,
  resource bounds, verification, publication and issue-closure gates remain unchanged;
  recreating projects does not authorize real-media jobs.

Before declaring RC1, agree the subsequent compatibility/versioning policy with the
owner and record it here. Do not infer that policy, implement migrations in advance
or treat this workflow change as approval to publish a release candidate.

## Efficient development and delivery

Shorten the feedback loop, not the acceptance gate. A logical step delivers one
coherent, reviewable behaviour with its tests and affected contracts; small fixes
within that step do not each trigger a full validation/publication cycle. Do not
hold an entire multi-step feature until the end.

| Phase                 | Required work                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development feedback  | Run affected unit/service tests and focused browser/native regressions as appropriate; investigate failures before broader runs. Focused results are not full acceptance.                                                                                                                                                                                             |
| Logical-step delivery | Review the final diff and satisfy applicable comprehensive checks and issue criteria before committing/pushing. Code normally needs the unit/service, type and production-build checks; UI/render/timing changes also need their applicable integration suites. Documentation-only steps need link/content/whitespace checks and review, not unrelated runtime tests. |
| Pre-merge acceptance  | Review live issue scope/dependencies and the exact PR head; record all non-CI evidence before arming auto-merge. Required up-to-date PR CI gates merge and eligible closure. Pending/failed checks are not acceptance.                                                                                                                                                |

Choose the validation scope from the changed contracts, dependencies and live issue
criteria before running it. Broad schema/timing/render changes require broad coverage;
a focused pass cannot satisfy an explicitly required full suite. Do not retry, skip
regressions or weaken assertions to obtain a faster green result.

Use the [incremental validation guide](DEVELOPMENT.md#incremental-feedback) to
avoid duplicate typechecks/builds and reuse an unchanged build with a valid isolated
fixture baseline. Changes to relevant source, configuration, dependencies or
toolchain invalidate affected evidence. Never rebuild served output or reset the
cache during browser validation. Keep browser/media runs serial unless independently
isolated concurrency has been implemented and verified; increasing workers alone
is not an approved shortcut. Subagent reviews during terminal validation must use
file/search tools, with **no terminal commands**, to avoid interrupting the run.

CI is asynchronous: after recording non-CI acceptance and arming native auto-merge,
record the PR/head, required check state and next action, then yield. GitHub waits
and merges eligible work independently of the chat/editor. Do not repeatedly poll,
start session CI watchers or rerun local suites to occupy the wait. Failed CI,
conflicts or a stale base leave the PR unmerged and the issue open. No custom closure
Action, hook, bot or scheduled job is installed. Next-session reconciliation handles
failures and label/Project housekeeping; it is not required for a successful armed
PR to merge and close its fully addressed issues.

Issue-free housekeeping needs no fabricated checkpoints. Keep the existing
start/step/handoff checkpoints concise and limited to selected
work and actual dependencies. Do not repeat whole-backlog audits, update unchanged
guides or add a second status ledger. Preserve all publication, source-safety,
consent and closure rules below.

Prefer a fresh chat per concrete deliverable, carrying its issue, scope, relevant
contracts and evidence rather than unrelated conversation history. Deeper reasoning
is useful for architecture, frame timing/native ownership, hard failures and final
review; a faster owner-selected model can handle bounded routine edits/tracking.
Model choice does not change verification obligations or authorize automatic switching.
For the next few steps when investigating latency, record measured elapsed time for
investigation/editing, local checks and delivery administration in the existing issue
checkpoint; record remote-CI duration separately once available. Omit unavailable
measurements and note overlaps; session spans/timeouts are not model-thinking time.
This is lightweight evidence, not new instrumentation, benchmark/media work or a
separate reporting requirement for every future task.

## Protected PR delivery

The owner authorizes publishing approved, reviewed, validated work on short-lived
branches and opening/updating PRs targeting the default branch, `main`, without
repeated approval. **Never push directly to `main` or bypass protection**, including
as administrator. Housekeeping also uses PRs but needs no invented issue. Logging
an issue alone does not approve implementation, release or scope expansion.

### Start every new task from current main

Complete this gate **before editing or validating a new task**, not only before
publication. It applies to housekeeping too; logging a proposal does not select
implementation. A fresh chat is not proof of a fresh Git base.

1. Inspect the current branch, staged/unstaged/untracked work, linked worktrees,
   active jobs and relevant PRs. Preserve unfinished work and ongoing validation;
   do not switch or update a worktree that another task or service is using.
2. Verify the host/repository and intended `origin`, then fetch remote `main`.
   Read back its actual remote SHA and confirm fetched `origin/main` matches it.
   A failed fetch or cached tracking ref is not an up-to-date starting point. If
   the remote moves during verification, refresh before creating the task branch.
3. If the worktree is clean and idle, switch to local `main` and fast-forward only
   from `origin/main`. Require local `main` to equal the verified remote SHA with
   no ahead/behind commits before creating a **new** short-lived task branch.
   Never merge a previous PR's head into local `main`, including after squash merge.
4. If the worktree is dirty, busy or on another active task, leave it intact and
   create a clean isolated worktree with a **new** task branch directly from the
   freshly fetched `origin/main`. This also avoids moving `main` checked out in
   another worktree. Local-only/ahead/diverged `main` is not a valid base: preserve
   it and use the verified remote base in isolation, or report a blocker.
5. Verify the new task branch's initial `HEAD` equals that remote SHA and the task
   worktree is clean. Record the starting `main` SHA in the PR and, when tracked,
   its existing work issue. Stop before edits/validation if freshness, access or
   safe isolation cannot be established; never stash/reset/discard unrelated work
   to pass the gate.

Do not reuse an old task branch, stale local `main` or an unmerged PR as a new
task's foundation. If a needed dependency is not yet on `main`, keep the new task
blocked rather than silently stacking it on unmerged work. After a squash merge,
the next task starts from the new remote `main`, not the old branch's commit history.
Freshness is checked at task startup; strict up-to-date PR CI remains the merge gate.

Continuing the **same approved task** may retain its existing branch. Before
resuming paused work, fetch and inspect current `main`/PR state; when a base update
is needed, follow the disarm/update/revalidation rules below. Do not restart a
branch for each correction or logical step, or mix a new deliverable into it.

### Worktree lifecycle and cleanup

Linked worktrees are temporary task isolation, not permanent delivery archives.
Inspect relevant registered trees at startup, after an observed merge and at handoff.
An armed but unmerged PR keeps its tree; native auto-merge cannot remove local files.
If merge happens after the chat ends, the next active session owns reconciliation
and cleanup. Do not install a cleanup hook, background job or scheduled sweeper.

1. **Classify before deleting.** Inspect `git worktree list --porcelain`, ownership,
   branch/HEAD, locks, live PR state, dependent tasks and active terminals/processes
   (including their working directories). Never remove the primary workspace,
   another task's active tree or a tree serving validation/media/editor work. A
   clean Git status does not prove a directory is idle or disposable.
2. **Prove delivery or disposability.** For completed task trees, verify the actual
   PR is merged to the intended default branch and its recorded merge commit is
   contained in freshly fetched, remote-verified `main`. With squash merges, the
   old local head need not be an ancestor: check the accepted PR head/merged result
   and any later local commits instead. Preserve unpublished/local-only work.
   Detached baseline/reproduction trees retire when their last dependent task no
   longer needs them; a closed issue or deleted remote branch alone proves neither.
3. **Inspect every class of contents.** Review staged/unstaged changes, all untracked
   files and ignored contents explicitly (`git status --short --untracked-files=all`
   and `git ls-files --others --ignored --exclude-standard --directory`). Keep
   unfinished edits, private/user data and still-needed evidence. Ignored does not
   mean disposable: generated project data may reference originals outside the
   tree. Only known task-owned disposable synthetic fixtures, caches and builds may
   leave with the tree; never follow references to delete originals, shared data
   or sibling evidence directories. Preserve required evidence outside the tree
   on persistent storage first; do not publish it or erase it as cleanup.
4. **Remove safely and read back.** Leave the target directory in owned terminals,
   settle only this session's owned jobs, then use normal `git worktree remove`
   with the exact verified target. Never use `--force`, recursive bulk deletion,
   `git clean` or reset/stash to manufacture eligibility. If normal removal refuses
   or contents/ownership are uncertain, retain it and report the specific blocker.
   Verify the directory is absent and `git worktree list --porcelain` no longer
   registers it. Review local branch retirement separately: `git branch -d` only
   after no worktree uses it and no unique work remains; if squash ancestry causes
   refusal, keep the branch and report it rather than force-delete.
   `git worktree prune` removes stale administrative records for already-missing directories;
   it does not delete existing worktrees or substitute for this review.
5. **Finish the checkpoint.** Report removed trees and retained-tree reasons/next
   actions concisely in the handoff and relevant existing issue/PR. Pending PRs,
   failed acceptance, active jobs, unfinished edits and baseline dependencies are
   legitimate retention reasons, not silent exceptions. Recheck them at the next
   checkpoint; do not create a second cleanup ledger or issue for each directory.
   Keep private absolute paths out of public updates. Retire the workflow task's
   own tree through the same gate once its PR has actually merged.

### Repository merge requirements

`main` requires PRs and these GitHub Actions checks, with branches **up to date**:

- **Checks / Node 22**
- **Checks / Node 24**
- **Native media and browser / FFmpeg 8.0.1**
- **Delivery gate**

The [CI workflow](../.github/workflows/ci.yml) runs on PRs targeting `main`, pushes
to `main` and manual dispatch. The unconditional Delivery gate checks both the
matrix result and integration result for literal `success`; failed, skipped,
cancelled or missing prerequisites cannot pass it. All suite checks remain required
individually, with GitHub Actions as their expected source. Keep job names unique.
Do not add path filters, conditional skips, retries or weaker assertions to satisfy
protection. CI has read-only repository permissions and no merge/issue-writing job.

Protection applies to administrators, forbids force-push/deletion, and requires
resolved review conversations. The solo workflow requires **zero independent
approving reviews**; the agent's explicit pre-merge acceptance still applies.
Auto-merge and automatic head-branch deletion are enabled; squash is the default
delivery method. A merge queue is not configured. Do not manufacture a second
reviewer, broaden credentials or bypass checks to get a PR merged.

### Publish and accept a candidate

1. Confirm `github.com/Plonk42/PasCap`, fetch actual remote `main`, create a
   short-lived branch through the startup gate above and review **all** outgoing
   commits. Record the verified starting `main` SHA; continuing an existing task
   retains its branch, with base updates handled below. Preserve unrelated edits
   and ongoing validation; never stash/discard/include them to obtain a clean tree.
2. Format changed files and organize imports where applicable, save and finish save
   actions **before final validation, review and staging**. Late formatting changes
   invalidate affected checks/staging; review/recheck/restage. Commit each coherent
   validated logical step and check for leftover formatting afterward. Push normally
   to its branch and open/update a draft PR using the [template](../.github/pull_request_template.md).
3. Before marking ready and arming auto-merge, read live issue/comments/dependencies
   and review the exact head's implementation, contracts and regression evidence.
   Verify **every non-CI acceptance criterion**. Record head SHA, checks, consented
   evidence, remaining limitations and the closure decision in the PR/work issue.
   Green CI cannot replace this judgment. Documentation-only local validation needs
   documentation checks; repository-required remote CI still applies to every PR.
4. For a fully completed issue, add **`Closes #N` only in the PR description**.
   Titles/commits retain `(#N)`, never `(Refs #N)` or closing keywords. Partial
   logical steps, investigations and work awaiting hardware/owner criteria merely
   reference their issues; they may merge without closing them. Milestone/release
   acceptance and legacy tracker cleanup remain separate owner decisions.
   **Read back GitHub's actual closing-issue references before arming** and verify
   that they contain exactly the accepted issues. Closing keywords are parsed even
   in negated prose; ordinary mentions of excluded work must not contain a closing
   keyword directly followed by its issue number. Do not rely only on text matching.
5. Enable **native squash auto-merge for the reviewed head**, using a head-SHA guard
   when supported. GitHub waits for required up-to-date PR CI, merges to `main`,
   deletes the head branch and closes eligible linked issues as completed. Record
   actual PR/head/check/auto-merge state and yield; no session watch or closure bot.

Before making further changes to an armed PR, **disable auto-merge and remove its
closing links**. Updates invalidate affected acceptance; new commits, base updates
or conflict resolution require another review/validation before rearming against
the new head. Update a stale branch by merging remote `main` normally and rerunning
affected checks, never by force-pushing or weakening the strict requirement.

`status:local-complete` / Project Local complete means non-CI implementation is
complete but protected merge is pending, not delivered. Partial work retains its
actual progress. Failed CI/conflicts/access blockers stay open with an explicit
next action. A successful branch push or an old green run is not acceptance.

## Merge, closure and reconciliation

Required up-to-date **PR CI is the delivery/closure gate**. GitHub's test-merge
candidate is the relevant evidence; squash may create a different final SHA, so
record the PR head/test-merge run and actual merged commit rather than claiming
local commit containment after squash. Main push CI remains a regression backstop:
its completion is **not a second prerequisite for native issue closure**. A later
failure must be inspected and tracked, with the affected issue reopened if its
acceptance is contradicted; do not hide failures or treat a cancelled run as passed.

At session start, after an observed merge and at handoff, reconcile relevant PRs
and open `status:local-complete` issues, paginating the bounded candidate query:

1. Read actual PR head/base/merge/check/auto-merge state and the recorded non-CI
   evidence. Unmerged failed/stale/conflicting PRs remain actionable; record the
   precise blocker. Successful native auto-merge needs no live chat or watcher.
2. For merged full-delivery PRs, verify default-branch merge, actual merged commit
   on remote `main`, closing-issue state/reason and pre-merge CI/acceptance evidence.
   Remove obsolete `status:*` and `iteration:current` labels only from completed
   work issues, preserving category/priority/areas/milestone/history/relationships.
   Set/read back their existing Project items to **Done** if not already synchronized.
3. Native **closed issue → Project Done** is permitted when available. Never enable
   the inverse **Project Done → close issue**, unconditional closure or a custom
   closure Action/hook/bot/schedule. A board move is not acceptance. Progress labels
   are not automatically removed by GitHub's closing keywords.
4. Direct-main deliveries published before this policy retain their recorded gate:
   verify live acceptance, remote-main containment and successful required CI for
   their delivery or a verified descendant before manually closing as completed.
   Do not retroactively accept failed/pending work because the workflow changed.
   Their next correction goes through a protected PR, without enrolling new watchers.
5. Apply the [worktree cleanup gate](#worktree-lifecycle-and-cleanup) to relevant
   completed task/baseline trees. Verify removal or record why each remains;
   successful remote branch deletion does not discharge this local obligation.

The native **Item closed** workflow is enabled; the owner configured its action as
**Status → Done**. No inverse Auto-close issue workflow is enabled. The public API
confirms the workflow's name/enabled state but does not expose its action settings;
verify the actual Project Status after the next legitimate issue closure, without
closing unrelated work merely to test automation. Native merge/issue closure and
the configured Status update do not depend on a live chat. Obsolete progress labels
still need explicit reconciliation. If Status is not Done, use the accessible CLI
item update and record the discrepancy. Workflow configuration changes require the
authorized Project UI; report access/synchronization failures rather than requesting
secrets or broadening CI permissions. Unattended failure repair is not promised.

## Scheduling contract for agents

**An issue is not a sprint. Never create, extend or synchronize an issue as a
sprint/iteration container, even when an older tracker exists.**

| Concept                                                        | Mechanism                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| Concrete feature, bug, verification or engineering deliverable | Issue                                                           |
| Sprint membership and dates                                    | Native Project **Iteration field**, with agreed cadence/dates   |
| Continuous delivery without timeboxes                          | Project backlog/Status board and bounded selected-work view     |
| Work progress                                                  | Work issue progress label and explicitly aligned Project Status |
| Deliverable outcome                                            | Milestone                                                       |
| Deliverable decomposition                                      | Native parent/sub-issues, never scheduling membership           |
| Actual prerequisite                                            | Native blocked-by relationship                                  |

GitHub [Iteration fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-iteration-fields)
support dated blocks and filters such as `@current`. No cadence is currently agreed
for PasCap, and no native Iteration field has been configured. Do not manufacture
dates to fill that gap. Use continuous-delivery selection unless the owner explicitly
chooses timeboxes. Any new scheduling field/view or bulk selection needs explicit
approval; a policy change alone does not migrate existing metadata.

[#15](https://github.com/Plonk42/PasCap/issues/15) and the existing
`iteration`/`iteration:current` labels are **legacy checkpoint tracking**. Their
history and existing native relationships are preserved, not adopted as the pattern
for future work. Do not add new issues beneath #15, apply those labels to new issues,
or append recurring sprint checklists. Update the actual work issues and Project
instead. Do not close/delete/reparent/relabel legacy records without explicit cleanup
approval. Historical counts below are evidence, not current planning instructions.

## Label contract

After triage, each issue has exactly one primary category and priority, one or
more relevant areas, and an outcome milestone. Each **open** issue also has exactly
one progress label and a next action. Additional existing labels are preserved.

| Category      | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `bug`         | Reproducible incorrect behaviour                                 |
| `enhancement` | Product feature/improvement, proposed or approved explicitly     |
| `task`        | Engineering, verification, documentation, planning or operations |

`documentation`, `accessibility` and similar labels are modifiers, not competing
primary categories. Area labels are `area:editor`, `area:media`, `area:export`,
`area:preview`, `area:audio`, `area:ci`, `area:container`, `area:licensing` and
`area:workflow`; add multiple only where the scope actually crosses boundaries.

| Priority      | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `priority:p0` | Critical: active data-loss/security incident or unusable core workflow; interrupt other work |
| `priority:p1` | High: correctness, source safety or a milestone/release gate                                 |
| `priority:p2` | Normal: planned feature, usability or maintainability work                                   |
| `priority:p3` | Low: optional improvement without a current milestone gate                                   |

Priority orders actionable work; it neither removes a dependency/consent requirement
nor selects deferred container/hardware work for delivery automatically.

| Progress                | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `status:backlog`        | Triaged, not selected for active work                                                     |
| `status:ready`          | Its stated next step is scoped/actionable without an outstanding prerequisite             |
| `status:in-progress`    | Active implementation, investigation or verification                                      |
| `status:blocked`        | Next step waits for a dependency, decision, consent or access; name it                    |
| `status:local-complete` | Implementation/local checks complete; publication, remote acceptance or review may remain |

`status:local-complete` is not all-criteria acceptance, issue closure or a remote
pass. Full-delivery PRs close their issues only after pre-merge acceptance and
required up-to-date CI permit the protected merge. Reconcile obsolete progress
labels and Project Done afterward, preserving category/priority/area and history.
`iteration` and `iteration:current` are retained legacy labels, not required triage
metadata or the future scheduling mechanism. New work is selected through the Project,
not labeled/parented into a sprint issue.

## Projects and capability limits

When available, reuse or create a **repository-linked GitHub Project** containing
these same issues: backlog/table, Status board and iteration/milestone views.
Keep Project Status aligned with issue progress labels and use labels for priority;
do not build a competing backlog or unsynchronized priority field. Use a native
Iteration field for an agreed cadence only, not fabricated dates. Preserve native
issue parents and blocked-by relationships. Native closed-issue → Done is permitted;
Project Done → issue closure and automatic releases are not. Do not broaden Actions
permissions to manage tracking. Verified issue closure follows the gate above.

The initial setup lacked Projects scope. After the owner granted it, **2026-10-04
CLI read/write access was verified** and
[PasCap — Planning & delivery](https://github.com/users/Plonk42/projects/1) was
created under Plonk42 and linked to this repository. It is **private by default**;
sign in as the owner or an authorized collaborator to see it. CLI authorization
does not sign the browser in. The previous access limitation remains historical
evidence in [#12](https://github.com/Plonk42/PasCap/issues/12), not a current blocker.
Never ask for or post a token in chat or an issue. If access becomes unavailable,
record the limitation on the actual work issue and continue accessible issue tracking.
Do not create a fallback sprint issue or duplicate checklist; report scheduling as
unavailable until Project access is restored.

### Project views and maintenance

The historical setup checkpoint contained **16 issues**, with no duplicate
draft cards, seven saved views and their native labels/milestones/assignees/parent
fields. The actual view query results were checked, not just filter strings:

| View                                                                                 | Purpose at the setup checkpoint                                                           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [Backlog](https://github.com/users/Plonk42/projects/1/views/1)                       | All 16 issue records with Status, Labels, Milestone and hierarchy fields                  |
| [Delivery](https://github.com/users/Plonk42/projects/1/views/2)                      | Board with the native **Status column field**, verified through API readback              |
| [Current iteration](https://github.com/users/Plonk42/projects/1/views/3)             | Eight `iteration:current` issues, including tracker #15 and its seven existing sub-issues |
| [v0.1 · Local hardening](https://github.com/users/Plonk42/projects/1/views/4)        | Ten existing hardening/workflow/feature/iteration records                                 |
| [v0.2 · Workload qualification](https://github.com/users/Plonk42/projects/1/views/5) | The three existing owner/hardware qualification issues                                    |
| [v0.3 · Docker & Podman](https://github.com/users/Plonk42/projects/1/views/6)        | The three existing future container issues                                                |
| [High-priority gates](https://github.com/users/Plonk42/projects/1/views/7)           | Five open `priority:p1` issues; priority remains an issue label                           |

Status options are **Backlog, Ready, In progress, Blocked, Local complete and Done**.
The first five map directly to their `status:*` labels; Done is reserved for
explicitly accepted/closed issues. **There is no automatic two-way synchronization**:
when updating an issue, set its corresponding Project Status too. If a card is
dragged, reconcile the issue label and next action before treating that move as a
tracking update. A card move never approves implementation or issue closure.
The enabled Item closed workflow is configured for closed-issue → Done as described
above; closure housekeeping verifies the resulting Status and removes obsolete
issue progress labels. Open-status synchronization remains explicit.

At the historical setup checkpoint, all six default Project workflows, including
**Auto-close issue**, were removed before any issue was added. The current Item
closed workflow updates Status only; automatic issue closure from a board move,
admission and relabeling remain disabled. New triaged issues must be added
explicitly, keeping their existing IDs and native relationships. No second Priority,
next-action field or dated Iteration field was added at that checkpoint. The existing
Current iteration view is label-filtered legacy selection, not a native sprint.
Do not renew its tracker/label model; native dated iterations require agreed dates,
while continuous delivery uses selected work without a tracker issue.

The API supports saved layouts/filters/visible fields but does not currently expose
custom grouping/sorting inputs. The Delivery board's default Status columns are
verified and need **no manual setup**; separate filtered milestone views avoid
pretending a grouped table was configured. Optional table grouping can be chosen
in the signed-in browser's View options and saved. This is not a metadata-access
blocker, a release gate or a reason to broaden Actions permissions.

## Historical setup evidence · not scheduling instructions

- All eleven original issues retain their scope/comments/milestones, with triaged
  category/priority/area/progress and explicit next actions. Existing dependency
  links are now also **ten native blocked-by relationships**.
- [#12 — Workflow](https://github.com/Plonk42/PasCap/issues/12) tracks these rules,
  templates and repository tracking changes.
- [#13 — Shared-point movement/navigation](https://github.com/Plonk42/PasCap/issues/13)
  retrospectively records the delivered feature; its historical 982-test evidence
  is not relabelled as new work.
- [#14 — Precise clip speed](https://github.com/Plonk42/PasCap/issues/14) records the
  approved locally committed extension and its already recorded 1,115-test baseline.
- [#15 — Current iteration](https://github.com/Plonk42/PasCap/issues/15) groups
  #1, #3, #4 and #12–#14 as **six native sub-issues**, with checkpoints, blockers
  and next-iteration candidates. Dates are identifiers, not due dates.
- All fifteen issues remained open at this initial checkpoint; locally complete
  work is distinguished from owner decisions and deferred GPU/flight/container
  qualification.

Later explicitly approved additions, including the help UI in
[#16](https://github.com/Plonk42/PasCap/issues/16), are recorded in the existing
checkpoint and issues. These historical setup counts are not a second mutable backlog
or authorization to continue issue-based sprint tracking.

Current delivery-commit results and remaining acceptance are recorded on the
corresponding work issues and [GitHub Actions](https://github.com/Plonk42/PasCap/actions),
not copied into this guide. Old successful runs and local evidence are not
substituted for actual-commit CI.

### Working views

- [Planning Project](https://github.com/users/Plonk42/projects/1) — delivery and work selection; existing Current iteration view remains legacy until approved cleanup
- [Ready next actions](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Aready%22)
- [High-priority gates](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22priority%3Ap1%22)
- [Blocked work](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Ablocked%22)
- [Locally complete, acceptance pending](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Alocal-complete%22)

### Submission and review

In VS Code Copilot Chat, use **`/github-issue` followed by a short request** to log
and triage an issue, for example `/github-issue ripple should be a per-layer behavior`.
The repository-local [issue skill](../.github/skills/github-issue/SKILL.md) searches
existing issues first, applies category/priority/area/status/milestone metadata and
adds the same issue to the linked Project with aligned Status. It records a concrete
next action and reports access limitations. Logging an idea does **not** approve
implementation or select it for delivery. The ripple proposal is now logged as
[#17](https://github.com/Plonk42/PasCap/issues/17); its backlog state is not selection
or implementation approval.

Use the [bug form](../.github/ISSUE_TEMPLATE/bug_report.yml),
[feature form](../.github/ISSUE_TEMPLATE/feature_request.yml) or
[engineering task form](../.github/ISSUE_TEMPLATE/work_item.yml), never an issue
form to create a sprint container. Triage adjusts default priority/progress, applies
area labels and an outcome milestone; Project scheduling is separately authorized.
The [PR template](../.github/pull_request_template.md) keeps linked
tracking, local/remote/hardware verification and remaining next actions distinct.
GitHub serves the committed templates/instructions after they reach remote `main`.
Publish approved, validated changes through the protected-PR checkpoint
above; issue/label/milestone metadata is applied directly and verified separately.
