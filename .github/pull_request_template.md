## Linked tracking

<!-- For tracked work: (#N), also in the PR title/commit messages, without closing
keywords. Trivial non-functional housekeeping needs no issue, Project card or
fabricated reference; write "Not needed — housekeeping" here instead. -->

<!-- Standing authorization: publish approved, reviewed, validated logical steps
to remote main regularly, respecting branch protection and unrelated user edits.
After delivery, close addressed issues without another approval only after checking
actual implementation, applicable acceptance and delivery-commit CI. Push/merge
alone is not acceptance. Releases, milestones and media jobs remain separate. -->

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

- Local commits/checks: <!-- exact commands, results and synthetic fixture scope; distinguish focused feedback from applicable comprehensive delivery gates; docs-only changes need docs checks -->
- Remote CI: <!-- actual commit/run/status; when only required CI remains, record verified non-CI acceptance and the temporary background watch/run; completion notification resumes LLM closure, with next-session recovery if interrupted -->
- Hardware/real workload: <!-- separate consent/evidence or explicitly deferred -->
- Phase durations, when investigating iteration latency: <!-- measured investigation/editing, local checks, administration and separate CI elapsed time; omit unavailable values, note overlaps; no timeout/session-span estimates -->

## Remaining work and next action

<!-- Blockers, limitations, acceptance still pending and linked follow-up issues. -->

- [ ] Relevant contracts/evidence and, when tracked, issue/Project Status are updated; no duplicate sprint checklist or housekeeping issue is created.
- [ ] Approved, reviewed and validated commits are published to remote main at the logical-step/handoff checkpoint, or a concrete publication blocker is recorded; no force-push or protection bypass.
- [ ] When tracked, closure eligibility is verified. If only required CI remains, a temporary session-owned watch is started with run/SHA/evidence recorded. On completion, the LLM verifies acceptance, closes eligible issues with reason completed and reconciles Project Done. No closure Action/bot or guaranteed follow-up after session shutdown; pending deliveries are revisited at next-session start.
- [ ] Original/media safety and unrelated user edits are preserved.
- [ ] No private paths/media, credentials, caches or generated reports are included.
