---
name: github-issue
description: "Log and triage a PasCap GitHub issue from a short request. Use /github-issue to search for duplicates, record scoped bugs, feature proposals or tasks, and apply category, priority, area, status, outcome milestone and linked Project tracking."
argument-hint: "Describe the bug, feature proposal or task to log"
user-invocable: true
disable-model-invocation: true
---

# Log a GitHub issue

Turn the text following `/github-issue` into one scoped GitHub issue, or reuse an
existing matching issue. Invocation authorizes logging and triage, **not product
implementation**, publication, iteration admission, issue closure or media jobs.
Do not run this workflow merely because an example invocation appears in chat.
The standing protected-PR/pre-merge-acceptance policy applies when delivering
approved work, not while merely logging an issue; see the
[GitHub workflow](../../../docs/GITHUB_WORKFLOW.md#protected-pr-delivery).

Explicit `/github-issue` invocation requests tracking. Do not invoke this skill
implicitly for trivial non-functional formatting/import sorting/typos or a request
to commit/push already-reviewed housekeeping: those need no issue or Project card.
Substantive bugs/features/engineering work still use scoped issues. Housekeeping
also uses protected PRs. Pre-merge acceptance and native auto-merge/eligible closure
belong to approved delivery, never issue logging; no custom closure automation.

## Inspect first

1. Read the repository instructions and [GitHub workflow](../../../docs/GITHUB_WORKFLOW.md).
   Use the appropriate [issue form](../../ISSUE_TEMPLATE/) as the content contract.
2. Verify the current Git remote, repository owner/name, GitHub host and authenticated
   identity before any write. PasCap is currently `Plonk42/PasCap` on `github.com`;
   do not assume a GitHub integration configured for an enterprise host reaches it.
   Prefer tools on the verified host; use `gh api --hostname github.com` when the
   integration targets another host. Never display tokens or request secrets.
3. Fetch live labels, open outcome milestones, and repository-linked Projects with
   their Status fields/options and native Iteration/selected-work context. Do not
   look for or create a sprint-tracker issue as the scheduling mechanism. Discover IDs rather
   than hard-coding them. Follow pagination; do not treat a partial list as complete.
   For organization repositories, check supported native issue types as well;
   native types do not replace required category labels.
4. Search **open and closed** issues using several relevant terms/synonyms, then
   read likely matches, comments and dependencies. An unavailable search is not
   proof that no duplicate exists: use a paginated issue listing or report the blocker.
   Prefer reusing an open issue covering the same outcome; add only meaningful new
   information without replacing its history or metadata. Do not reopen a closed
   match automatically; ask whether this is a recurrence/new scope if uncertain.

## Scope and triage

- Preserve the user's intent. Inspect relevant code/docs only as needed to establish
  current behaviour; do not invent reproductions, approvals, technical solutions or
  completed verification. A short but clear request is enough to log a proposal.
  Ask only if a missing decision prevents safe scoping, destination or milestone choice.
- Issues track concrete deliverables, not sprint containers. If the request is only
  to create/manage a sprint, do not create an issue: explain the native Project
  Iteration mechanism and ask for missing cadence/dates or selection approval before
  scheduling. Without agreed timeboxes, use a selected-work view. Existing #15 is
  a legacy checkpoint, not a template for another tracker or recurring checklist.
- Give the issue **exactly one** category: `bug` for evidenced incorrect behaviour,
  `enhancement` for a product proposal/improvement, or `task` for engineering,
  documentation, verification or operations. Preserve unrelated modifiers on reuse.
- Give it **exactly one** priority and explain why: `priority:p0` active critical
  data-loss/security/core-workflow failure; `priority:p1` correctness/source-safety
  or a milestone/release gate; `priority:p2` normal planned/design work (default);
  `priority:p3` optional non-gating improvement. Never infer urgency from wording alone.
- Apply only relevant live `area:*` labels. The current areas are editor, media,
  export, preview, audio, ci, container, licensing and workflow. Documentation and
  accessibility are modifiers, not primary categories. Do not create labels ad hoc.
- Every open issue needs **exactly one** `status:*` and a concrete next action.
  New unapproved proposals default to `status:backlog`; actionable selected work can
  be `status:ready`. Use `status:blocked` for a real prerequisite/decision/consent
  blocking the stated next step, and name it. Logging alone is never `in-progress`
  implementation or `local-complete`. Preserve a reused issue's actual delivery state.
- Assign one existing **outcome milestone** using its live scope, not a made-up
  deadline. Current outcomes: v0.1 local editor hardening; v0.2 real-workload
  qualification; v0.3 Docker/Podman delivery. A milestone assignment is a planning
  proposal, not scope approval. If none fits, ask rather than create one silently.
- Record actual prerequisites as native blocked-by relationships when supported.
  Preserve existing parents; add a native sub-issue only when that decomposition is
  appropriate and authorized, never for sprint membership. Mere topical similarity
  is not a dependency.
- Inspect Project selection but **do not** assign an Iteration or selected-work field
  without explicit selection approval. Do not apply legacy `iteration` or
  `iteration:current` labels to new issues or parent them to #15. Preserve existing
  legacy metadata unless its cleanup is explicitly approved.
  Mention relevant Project context without implying admission. Assign a person
  only when responsibility is known, not automatically to the reporter.

## Issue body

Use a concise, actionable title and these sections, adapting to the matching form:

- **Goal / user problem:** the requested outcome and verified current behaviour.
- **Scope and non-goals:** bounded behaviour; preserve originals, strict persisted
  data, reversible edits and authoritative integer-frame timing. No unrelated feature,
  compatibility migration or owner-media qualification is implied.
- **Acceptance criteria:** observable checklist. Distinguish proposed acceptance from
  verified delivery; include relevant regressions without running media work to log it.
- **Dependencies, milestone and Project context:** known issue links, proposed outcome,
  real blockers and native Project iteration/selected-work context, when applicable.
  New proposals remain unselected; a tracker issue is not required.
- **State and approval:** proposal vs explicitly approved work; chosen progress state.
- **Priority rationale:** concise reason for the selected priority.
- **Next action:** the smallest specific next design, investigation or delivery step;
  state the owner decision/consent needed where applicable.

Publish only sanitized facts: no private filesystem paths, source/project snapshots,
credentials, licensed recordings/music or generated diagnostic reports.

## Write, synchronize and verify

1. Create the issue with its category, priority, areas, status and milestone, or
   update the matched issue minimally. Preserve historical comments and unrelated
   labels, relationships, assignees and metadata. Resolve conflicting primary labels
   deliberately instead of appending another category/priority/status.
2. Add the **same issue** once to the repository-linked Project, not a draft card or
   duplicate. Explicitly set its native Status to match its issue progress label:
   Backlog, Ready, In progress, Blocked or Local complete. Done is for verified
   closed issues only. Logging does not run publication or delivery closure; the
   standing protected-PR and pre-merge acceptance policies are in the GitHub
   workflow. Native closed-issue → Done is permitted when available, but never
   Project Done → issue closure or a custom closure workflow.
3. If Project/dependency access is unavailable, record the exact limitation and next
   action on the actual work issue and continue what is accessible. Do not create a
   fallback sprint issue/checklist or claim unavailable synchronization succeeded.
4. If a write times out or its result is uncertain, read/search current state before
   retrying; never blindly create a second issue, comment or Project item.
5. Read back the issue and Project item. Verify category/priority/status cardinality,
   area, milestone, next action, native relationships and Project Status. Report any
   partial failure honestly with a recovery action; do not close/delete the issue.
6. Return the issue link, whether created or reused, selected labels/milestone,
   Project result and next action. Do not change source files, commit, push, start
   tests/media jobs, or implement the request merely to log the issue.

## Example interpretation

`/github-issue ripple should be a per-layer behavior` requests a **feature proposal**,
not a bug fix or an implementation. After duplicate/code checks, normally choose
`enhancement`, `priority:p2`, `area:editor`, `status:backlog` and the existing v0.1
editor outcome. Record per-layer ripple choice as the proposed goal, with independent
layer timing and reversible edits as design/acceptance concerns. The next action is
to review and approve the per-layer timing semantics, including transitions and
music/keyframe treatment. Do not invent the toggle design, change the schema, select
it for delivery, or implement it without separate approval.
