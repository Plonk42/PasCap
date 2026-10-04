# GitHub planning and delivery

GitHub [issues](https://github.com/Plonk42/PasCap/issues) are the system of record
for bugs, approved features, tasks, next actions and blockers. Native dependencies,
sub-issues, [milestones](https://github.com/Plonk42/PasCap/milestones) and iteration
tracking describe how that work is delivered. Local guides describe contracts and
dated evidence; [ROADMAP.md](ROADMAP.md) is an outcome/dependency index, not a second
mutable backlog. Historical plans and feature worksheets do not approve new scope.

## Work cycle

1. **Inspect before acting.** Confirm the repository/host and current issue,
   comments, dependencies and iteration. Search before creating a new issue; reuse
   an existing scope rather than duplicating it. A task/feature needs a goal,
   non-goals, observable acceptance, an outcome milestone and a concrete next action.
2. **Triage.** Apply the category, priority, area and progress labels below. Record
   decisions/consent needed and native blocked-by relationships for actual prerequisites.
   Assign a person only when responsibility is known; otherwise name the decision
   needed in the next action. Templates start at normal/backlog, not confirmed severity.
3. **Select a bounded iteration.** Link existing approved issues to a tracker with
   the `iteration` label; mark it and its selected scope `iteration:current`.
   Use native sub-issues for a useful decomposition, without replacing existing
   parents. An already-parented issue can be linked from the iteration checklist.
   Milestones represent deliverable outcomes; iteration dates/deadlines are not invented.
4. **Deliver incrementally.** At the start, after each completed logical step and
   at handoff, update the issue and iteration: progress, blockers, exact local commits,
   checks/evidence, remaining acceptance and the next action. Validate/review and
   commit each step with its tests/docs; use `Refs #N` in commits/PRs, not closing
   keywords. An unpublished SHA is a local reference, not a working GitHub commit link.
5. **Review honestly.** Local implementation/testing can be complete while remote
   CI, publication or owner acceptance is pending. Inspect CI for the actual delivery
   commit; old green runs do not qualify new code. Close issues/milestones, push,
   publish or run owner-media jobs only with explicit authorization. An iteration
   summary records follow-ups and review decisions; moving `iteration:current` to
   the next agreed batch does not silently close its predecessor.

Public updates must be sanitized: no private source/project paths, snapshots,
credentials, recordings, licensed music or generated reports. Real imports,
preparations, benchmarks and long renders still require explicit owner consent.

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
nor makes deferred container/hardware work the current iteration automatically.

| Progress | Meaning |
| --- | --- |
| `status:backlog` | Triaged, not selected for active work |
| `status:ready` | Its stated next step is scoped/actionable without an outstanding prerequisite |
| `status:in-progress` | Active implementation, investigation or verification |
| `status:blocked` | Next step waits for a dependency, decision, consent or access; name it |
| `status:local-complete` | Implementation/local checks complete; publication, remote acceptance or review may remain |

`status:local-complete` is not all-criteria acceptance, issue closure or a remote
pass. Closing is explicit; remove obsolete open-progress/current-iteration labels
when closure is authorized, preserving category/priority/area and history.
`iteration` identifies a tracker; `iteration:current` identifies the active batch,
including its selected implementation issues, not a new feature category.

## Projects and capability limits

When available, reuse or create a **repository-linked GitHub Project** containing
these same issues: backlog/table, Status board and iteration/milestone views.
Keep Project Status aligned with issue progress labels and use labels for priority;
do not build a competing backlog or unsynchronized priority field. Use a native
Iteration field for an agreed cadence only, not fabricated dates. Preserve native
issue parents and blocked-by relationships. Do not enable automatic closure/releases
or broaden Actions permissions just to manage tracking.

The current GitHub authorization lacks Projects scope (even `read:project`);
issue, milestone, dependency and sub-issue APIs are usable. No Projects board is
claimed. Use the issue-based iteration now and record the limitation in
[#12](https://github.com/Plonk42/PasCap/issues/12). If the owner later grants
project-scoped access, link the same issues and retain their history; never ask
for or post a token in chat or an issue.

## Applied setup · 2026-10-04 · initial workflow checkpoint

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
iteration and issues. These historical setup counts are not a second mutable backlog.

The latest inspected remote [run 37183854541](https://github.com/Plonk42/PasCap/actions/runs/37183854541)
on publication commit `6d260c5` failed the old raw-reader case on Node 24 while
Node 22 and native/browser jobs passed. It does not contain local fix `48b4de9`
or the clip-speed commits. Fresh delivery-commit CI awaits an explicitly approved
push; old successful runs and local evidence are not substituted for it.

### Working views

- [Current iteration scope](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22iteration%3Acurrent%22)
- [Ready next actions](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Aready%22)
- [High-priority gates](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22priority%3Ap1%22)
- [Blocked work](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Ablocked%22)
- [Locally complete, acceptance pending](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Alocal-complete%22)

### Submission and review

Use the [bug form](../.github/ISSUE_TEMPLATE/bug_report.yml),
[feature form](../.github/ISSUE_TEMPLATE/feature_request.yml) or
[task/iteration form](../.github/ISSUE_TEMPLATE/work_item.yml). Triage adjusts
default priority/progress, applies area labels and adds real milestone/iteration
relationships. The [PR template](../.github/pull_request_template.md) keeps linked
tracking, local/remote/hardware verification and remaining next actions distinct.
These local templates/instructions require an approved push before GitHub serves
the updated files; the issue/label/milestone data is already applied remotely.
