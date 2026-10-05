## Linked tracking

<!-- Tracked titles/commits use (#N), never closing keywords. Initially reference
the issue without a closing link. Add Closes #N HERE only after verifying that this
PR completes every non-CI acceptance criterion, with no remaining hardware/owner
gate. Partial/investigation PRs merely reference it. Housekeeping needs no invented
issue/card; write "Not needed — housekeeping" here instead. -->

<!-- Approved logical steps are published on short-lived branches through protected
PRs, never direct main pushes or administrator bypass. Before enabling native
squash auto-merge, review/validate the exact head and record non-CI acceptance below.
Required up-to-date PR CI gates merge/closure; main push CI is a regression backstop.
Releases, milestones, legacy cleanup and real-media jobs remain separate. -->

Project context: <!-- native Project Iteration if explicitly scheduled, or selected-work view; no sprint-tracker issue required -->

Milestone: <!-- outcome milestone -->

## Scope and non-goals

<!-- Approved change, relevant dependencies and deliberately excluded work. -->

<!-- Before RC1, approved project/persisted-format breaks are acceptable without
backward-compatibility scaffolding or separate compatibility approval. Disclose any
incompatibility and required recreation/reset; do not silently rewrite/delete data.
Add migration/legacy support only when explicitly requested. This does not relax
source safety or verification. Agree the subsequent policy with the owner before
RC1; do not infer a post-RC promise or release approval. -->

## Verification

- Starting main SHA: <!-- freshly fetched/remote-verified SHA before the task's first edits or validation; initial task HEAD matched it, worktree clean, new branch or isolated worktree; never a stale/previous/unmerged PR branch -->
- Local commits/checks: <!-- exact commands, results and synthetic fixture scope; distinguish focused feedback from applicable comprehensive delivery gates; docs-only changes need docs checks -->
- Non-CI acceptance: <!-- reviewed PR head SHA, live issue criteria/dependencies, implementation/contracts and evidence; name any remaining gate and omit closing links for partial delivery -->
- Required PR CI: <!-- actual PR head/test-merge run and Node 22/24, native/browser, Delivery gate states; pending/failed/skipped is not passed -->
- Auto-merge: <!-- disabled, or armed with squash for the reviewed head; disable and remove closing links before pushing further changes -->
- Hardware/real workload: <!-- separate consent/evidence or explicitly deferred -->
- Phase durations, when investigating iteration latency: <!-- measured investigation/editing, local checks, administration and separate CI elapsed time; omit unavailable values, note overlaps; no timeout/session-span estimates -->

## Remaining work and next action

<!-- Blockers, limitations, acceptance still pending and linked follow-up issues. -->

- [ ] Relevant contracts/evidence and, when tracked, issue/Project Status are updated; no duplicate sprint checklist or housekeeping issue is created.
- [ ] The new task started from verified current remote main before edits/validation, on a new clean branch/worktree; its starting SHA is recorded and unrelated work preserved. Same-task continuation follows the disarm/update/revalidation rules.
- [ ] Approved, reviewed and validated commits are published to this branch/PR, or a concrete blocker is recorded; no direct main push, force-push or protection bypass.
- [ ] Non-CI acceptance is verified for the exact head before auto-merge is armed. GitHub's actual closing-issue references are read back and contain only fully completed issues, never partial work or deferred hardware/owner gates; negated closing phrases are not safe exclusions.
- [ ] Required up-to-date PR CI is left to native auto-merge, without session watchers or custom closure automation. Next-session reconciliation removes obsolete progress labels and verifies issue/Project Done; failed CI remains actionable, not accepted.
- [ ] Original/media safety and unrelated user edits are preserved.
- [ ] No private paths/media, credentials, caches or generated reports are included.
