# GitHub planning and delivery

GitHub [issues](https://github.com/Plonk42/PasCap/issues) are the system of record
for bugs, approved features, tasks, next actions and blockers. Native dependencies,
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

1. **Inspect before acting.** Confirm the repository/host and current issue,
  comments, dependencies and Project selection. Search before creating a new issue; reuse
   an existing scope rather than duplicating it. A task/feature needs a goal,
   non-goals, observable acceptance, an outcome milestone and a concrete next action.
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
  commit each step with its tests/docs; commit messages and PR titles always use
  `(#N)`, for example `Improve timeline scrolling (#18)`, never `(Refs #N)` or
  automatic closing keywords. Automatically push approved, validated logical-step
  commits to remote `main` under the standing authorization below, without another
  approval request. An unpublished SHA is a local reference, not a working GitHub
  commit link; report any publication blocker.
5. **Review honestly.** Local implementation/testing can be complete while remote
   CI, publication or owner acceptance is pending. Inspect CI for the actual delivery
  commit; old green runs do not qualify new code. Automatically close concrete work
  issues after verified delivery to remote `main`, following the gate below. Closing
  milestones, publishing releases or running owner-media jobs still needs explicit
  authorization; validated code/documentation pushes do not. Keep optional
  sprint goals/review notes short; they must not become a second mutable backlog.
  Moving work between Project iterations does not accept or close its issues.

Public updates must be sanitized: no private source/project paths, snapshots,
credentials, recordings, licensed music or generated reports. Real imports,
preparations, benchmarks and long renders still require explicit owner consent.

## Automatic publication to main

The owner gives standing authorization for regular **agent-driven pushes to remote
`main`** of approved work. Publish after each completed, validated and reviewed
logical-step commit, and at handoff if such commits remain unpublished. Do not hold
an entire completed feature locally or ask for the same push permission again.
This is an event-driven work-cycle checkpoint, not a timer, background job, GitHub
Action or invented sprint cadence. Logging an issue alone does not approve its
implementation or publication; releases and scope expansion are not authorized.

Before pushing:

1. Verify the GitHub host/repository, local branch and target remote `main`. Review
  **all** outgoing commits and their affected checks/contracts; do not publish
  unrelated, unreviewed, unapproved or private content just because it is committed.
2. Validate the affected behaviour, review the diff and stage deliberately before
  committing. Keep unrelated user edits unstaged and intact; a dirty tree is not
  permission to stash, discard or include them. Documentation-only work needs
  applicable documentation validation, not invented runtime tests.
3. Fetch remote `main` and confirm the outgoing history is a fast-forward from its
  actual SHA. Use a normal explicit push to `main`; never force-push/rewrite remote
  history, bypass protections, auto-merge unrelated work or broaden permissions.
  If divergence, branch rules, failed validation or access prevents publication,
  stop publication and record the specific blocker/recovery action on the work issue.
  Use the protected-branch PR/review path when required rather than bypassing it.
4. Read back remote `main` and prove the intended commits are contained. Record the
  delivered SHA/link on the issue, inspect its actual-commit CI and run the closure
  reconciliation below. A successful push does not itself prove acceptance or CI.

Unpublished verified work remains `status:local-complete` with aligned Project
Status and a concrete publication next action. Published work awaiting a required
check, decision or acceptance remains open with the corresponding progress/blocker.
Never retry or weaken tests merely to obtain a green delivery checkpoint.

## Verified closure on main

The owner gives standing authorization to close a concrete work issue without another
approval request once its implementing commit reaches **remote `main`** and the issue
is actually fixed/implemented. A local commit, a merge notification, a checked box or
`status:local-complete` alone is not sufficient.

Before closing, the delivery agent must:

1. Read the live issue, comments, acceptance criteria and dependencies. Inspect the
  actual delivered code/contracts and relevant regression evidence; do not infer
  completion from a title, label, commit message or another issue's completion.
2. Verify the repository/host and remote `main` SHA, and prove the implementing
  commit is contained in that branch. Local branch names and unpushed commits do
  not qualify. Publication follows the validated-step gate above, not an attempt
  to bypass acceptance merely to trigger closure.
3. Confirm every applicable acceptance criterion with evidence for the delivered
  implementation. Inspect CI for the actual delivery commit (or a verified
  descendant containing it); pending/failed required checks keep the issue open.
  Documentation-only work needs applicable documentation validation, not invented
  runtime tests. Hardware/real-workload criteria still require their own consented
  evidence; unrelated deferred gates do not expand a completed issue's scope.
4. If complete, post a sanitized acceptance summary with the delivered SHA, evidence
  and CI links, then close with reason **completed**. Remove obsolete `status:*`
  and `iteration:current` labels, preserve category/priority/areas, milestone,
  history and native relationships, and set its existing Project item to **Done**.
  Read back both issue and Project state; report any synchronization failure.
5. If incomplete or uncertain, keep it open, align its progress label and Project
  Status, and record the specific missing criterion/blocker and next action.

Run this reconciliation after every validated-step push/merge reaches remote `main` and
at delivery handoff. This is a verification-driven agent policy, **not an installed
background GitHub Action or an unattended merge-only automation**. Use plain `(#N)`
issue references in commit messages and PR titles, without GitHub closing keywords
that could bypass verification. Generic
Project Auto-close workflows stay disabled. This policy does not authorize release,
milestone closure, legacy tracker #15 cleanup, scope expansion or media jobs.

## Scheduling contract for agents

**An issue is not a sprint. Never create, extend or synchronize an issue as a
sprint/iteration container, even when an older tracker exists.**

| Concept | Mechanism |
| --- | --- |
| Concrete feature, bug, verification or engineering deliverable | Issue |
| Sprint membership and dates | Native Project **Iteration field**, with agreed cadence/dates |
| Continuous delivery without timeboxes | Project backlog/Status board and bounded selected-work view |
| Work progress | Work issue progress label and explicitly aligned Project Status |
| Deliverable outcome | Milestone |
| Deliverable decomposition | Native parent/sub-issues, never scheduling membership |
| Actual prerequisite | Native blocked-by relationship |

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

| Category | Meaning |
| --- | --- |
| `bug` | Reproducible incorrect behaviour |
| `enhancement` | Product feature/improvement, proposed or approved explicitly |
| `task` | Engineering, verification, documentation, planning or operations |

`documentation`, `accessibility` and similar labels are modifiers, not competing
primary categories. Area labels are `area:editor`, `area:media`, `area:export`,
`area:preview`, `area:audio`, `area:ci`, `area:container`, `area:licensing` and
`area:workflow`; add multiple only where the scope actually crosses boundaries.

| Priority | Meaning |
| --- | --- |
| `priority:p0` | Critical: active data-loss/security incident or unusable core workflow; interrupt other work |
| `priority:p1` | High: correctness, source safety or a milestone/release gate |
| `priority:p2` | Normal: planned feature, usability or maintainability work |
| `priority:p3` | Low: optional improvement without a current milestone gate |

Priority orders actionable work; it neither removes a dependency/consent requirement
nor selects deferred container/hardware work for delivery automatically.

| Progress | Meaning |
| --- | --- |
| `status:backlog` | Triaged, not selected for active work |
| `status:ready` | Its stated next step is scoped/actionable without an outstanding prerequisite |
| `status:in-progress` | Active implementation, investigation or verification |
| `status:blocked` | Next step waits for a dependency, decision, consent or access; name it |
| `status:local-complete` | Implementation/local checks complete; publication, remote acceptance or review may remain |

`status:local-complete` is not all-criteria acceptance, issue closure or a remote
pass. Verified delivery to remote `main` authorizes automatic concrete-issue closure
under the gate above; remove obsolete open-progress/current-iteration labels,
preserving category/priority/area and history.
`iteration` and `iteration:current` are retained legacy labels, not required triage
metadata or the future scheduling mechanism. New work is selected through the Project,
not labeled/parented into a sprint issue.

## Projects and capability limits

When available, reuse or create a **repository-linked GitHub Project** containing
these same issues: backlog/table, Status board and iteration/milestone views.
Keep Project Status aligned with issue progress labels and use labels for priority;
do not build a competing backlog or unsynchronized priority field. Use a native
Iteration field for an agreed cadence only, not fabricated dates. Preserve native
issue parents and blocked-by relationships. Do not enable unconditional Project
Auto-close workflows or automatic releases, or broaden Actions permissions just to
manage tracking. Verified issue closure follows the gate above.

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

| View | Purpose at the setup checkpoint |
| --- | --- |
| [Backlog](https://github.com/users/Plonk42/projects/1/views/1) | All 16 issue records with Status, Labels, Milestone and hierarchy fields |
| [Delivery](https://github.com/users/Plonk42/projects/1/views/2) | Board with the native **Status column field**, verified through API readback |
| [Current iteration](https://github.com/users/Plonk42/projects/1/views/3) | Eight `iteration:current` issues, including tracker #15 and its seven existing sub-issues |
| [v0.1 · Local hardening](https://github.com/users/Plonk42/projects/1/views/4) | Ten existing hardening/workflow/feature/iteration records |
| [v0.2 · Workload qualification](https://github.com/users/Plonk42/projects/1/views/5) | The three existing owner/hardware qualification issues |
| [v0.3 · Docker & Podman](https://github.com/users/Plonk42/projects/1/views/6) | The three existing future container issues |
| [High-priority gates](https://github.com/users/Plonk42/projects/1/views/7) | Five open `priority:p1` issues; priority remains an issue label |

Status options are **Backlog, Ready, In progress, Blocked, Local complete and Done**.
The first five map directly to their `status:*` labels; Done is reserved for
explicitly accepted/closed issues. **There is no automatic two-way synchronization**:
when updating an issue, set its corresponding Project Status too. If a card is
dragged, reconcile the issue label and next action before treating that move as a
tracking update. A card move never approves implementation or issue closure.

All six newly created default Project workflows, including **Auto-close issue**,
were removed **before any issue was added**. No automatic closure, admission,
relabeling or Status transition is enabled. New triaged issues must be added
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
Publish approved, validated changes through the automatic-publication checkpoint
above; issue/label/milestone metadata is applied directly and verified separately.
