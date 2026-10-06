## Linked tracking

<!-- Tracked titles/commits use (#N), never closing keywords. Initially reference
the issue without a closing link. Add Closes #N HERE only after verifying that this
PR completes every non-CI acceptance criterion, with no remaining hardware/owner
gate. Partial/investigation PRs merely reference it. Housekeeping needs no invented
issue/card; write "Not needed — housekeeping" here instead. -->

<!-- This template is for code/mixed and other PR-path work. Pure workflow/instruction
text is committed and pushed directly to main after documentation checks with
[skip ci], without creating a PR; executable CI/scripts/hooks are not eligible.
Approved PR-path steps use short-lived branches, never direct main pushes or administrator bypass. Before enabling native
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

- Starting main SHA: <!-- freshly fetched/remote-verified SHA before the task's first edits or validation; initial task HEAD matched it; new branch in the current workarea by default, never a stale/previous/unmerged PR branch -->
- Checkout choice: <!-- current workarea by default, regardless of open tabs/dev servers; preserve incidental prototypes/prose/formatting unstaged. Worktree exception requires a substantive unfinished-work or active-session conflict and retirement condition, not merely processes, a new chat/task or remote CI wait -->
- Local commits/checks: <!-- exact commands, results and synthetic fixture scope; distinguish focused feedback from applicable comprehensive delivery gates; docs-only changes need docs checks -->
- Non-CI acceptance: <!-- reviewed PR head SHA, live issue criteria/dependencies, implementation/contracts and evidence; name any remaining gate and omit closing links for partial delivery -->
- Required PR CI: <!-- actual PR head/test-merge run and Node 22/24, native/browser, Delivery gate states; pending/failed/skipped is not passed -->
- Auto-merge: <!-- disabled, or armed with squash for the reviewed head; disable and remove closing links before pushing further changes -->
- Hardware/real workload: <!-- separate consent/evidence or explicitly deferred -->
- Phase durations, when investigating iteration latency: <!-- measured investigation/editing, local checks, administration and separate CI elapsed time; omit unavailable values, note overlaps; no timeout/session-span estimates -->

## Remaining work and next action

<!-- Blockers, limitations, acceptance still pending and linked follow-up issues. -->

- [ ] Relevant contracts/evidence and, when tracked, issue/Project Status are updated; no duplicate sprint checklist or housekeeping issue is created.
- [ ] The new task started from verified current remote main before edits/validation, on a new branch in the current workarea by default; any worktree exception identifies substantive unfinished work or a conflicting active session and its retirement condition, not open tabs or running processes. Its starting SHA is recorded and incidental contents/unrelated work preserved and excluded from delivery. Same-task continuation follows the disarm/update/revalidation rules.
- [ ] Approved, reviewed and validated commits are published to this branch/PR, or a concrete blocker is recorded; no direct main push or protection bypass. A force-push is permitted only after an explicitly requested task-branch rebase, using an explicit expected-SHA lease and renewed exact-head acceptance under the workflow; never force-push main.
- [ ] Non-CI acceptance is verified for the exact head before auto-merge is armed. GitHub's actual closing-issue references are read back and contain only fully completed issues, never partial work or deferred hardware/owner gates; negated closing phrases are not safe exclusions.
- [ ] Required up-to-date PR CI is left to native auto-merge, without session watchers or custom closure automation. Next-session reconciliation removes obsolete progress labels and verifies issue/Project Done; failed CI remains actionable, not accepted.
- [ ] Original/media safety and unrelated user edits are preserved.
- [ ] Sequential branch handoff is safe: owned validation is settled and no substantive work/session conflict exists before returning to updated main, preserving incidental contents; ordinary dev servers/open tabs are not blockers. A published PR awaiting CI retains its accepted branch/head without requiring another checkout. Generated outputs/fixtures are verified before reuse after switching.
- [ ] Worktree lifecycle is reconciled: safe completed task/baseline trees are removed with directory/registration readback, or each retained relevant tree has a reason and cleanup next action. This PR's tree remains while unmerged and is checked after observed merge/next session; no forced removal or deletion of unfinished work, private data or required evidence.
- [ ] No private paths/media, credentials, caches or generated reports are included.
