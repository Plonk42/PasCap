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
  Add the same issue to the linked Project; do not duplicate it as a draft card.
   Assign a person only when responsibility is known; otherwise name the decision
   needed in the next action. Templates start at normal/backlog, not confirmed severity.
3. **Select a bounded iteration.** Link existing approved issues to a tracker with
   the `iteration` label; mark it and its selected scope `iteration:current`.
   Use native sub-issues for a useful decomposition, without replacing existing
   parents. An already-parented issue can be linked from the iteration checklist.
   Milestones represent deliverable outcomes; iteration dates/deadlines are not invented.
4. **Deliver incrementally.** At the start, after each completed logical step and
  at handoff, update the issue, iteration and Project Status: progress, blockers,
  exact local commits, checks/evidence, remaining acceptance and the next action. Validate/review and
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

The initial setup lacked Projects scope. After the owner granted it, **2026-10-04
CLI read/write access was verified** and
[PasCap — Planning & delivery](https://github.com/users/Plonk42/projects/1) was
created under Plonk42 and linked to this repository. It is **private by default**;
sign in as the owner or an authorized collaborator to see it. CLI authorization
does not sign the browser in. The previous access limitation remains historical
evidence in [#12](https://github.com/Plonk42/PasCap/issues/12), not a current blocker.
Never ask for or post a token in chat or an issue. If access becomes unavailable,
record that limitation and continue using the same iteration issue and labels.

### Project views and maintenance

The verified setup checkpoint contains all **16 existing issues**, with no duplicate
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
next-action field or dated Iteration field was added. The rolling iteration uses
`iteration:current`; native dated iterations require an agreed cadence first.

The API supports saved layouts/filters/visible fields but does not currently expose
custom grouping/sorting inputs. The Delivery board's default Status columns are
verified and need **no manual setup**; separate filtered milestone views avoid
pretending a grouped table was configured. Optional table grouping can be chosen
in the signed-in browser's View options and saved. This is not a metadata-access
blocker, a release gate or a reason to broaden Actions permissions.

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

In VS Code Copilot Chat, use **`/github-issue` followed by a short request** to log
and triage an issue, for example `/github-issue ripple should be a per-layer behavior`.
The repository-local [issue skill](../.github/skills/github-issue/SKILL.md) searches
existing issues first, applies category/priority/area/status/milestone metadata and
adds the same issue to the linked Project with aligned Status. It records a concrete
next action and reports access limitations. Logging an idea does **not** approve
implementation or add it to the current iteration; the example is not a filed issue.

Use the [bug form](../.github/ISSUE_TEMPLATE/bug_report.yml),
[feature form](../.github/ISSUE_TEMPLATE/feature_request.yml) or
[task/iteration form](../.github/ISSUE_TEMPLATE/work_item.yml). Triage adjusts
default priority/progress, applies area labels and adds real milestone/iteration
relationships. The [PR template](../.github/pull_request_template.md) keeps linked
tracking, local/remote/hardware verification and remaining next actions distinct.
These local templates/instructions require an approved push before GitHub serves
the updated files; the issue/label/milestone data is already applied remotely.
