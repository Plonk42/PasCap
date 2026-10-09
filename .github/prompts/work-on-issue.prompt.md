---
name: work-on-issue
description: 'Pick the X most relevant open PasCap GitHub issues and deliver them one by one, routine changes straight to main and risky ones on their own squash auto-merge PR. Use /work-on-issue 3 to work through the top three issues.'
argument-hint: 'Number of issues to address, e.g. 3'
agent: agent
---

# Work on the most relevant issues

Address the **X** most relevant open issues of `Plonk42/PasCap`, where X is the number
given after `/work-on-issue` (default 1). Follow the
[repository instructions](../copilot-instructions.md) and the
[GitHub workflow](../../docs/GITHUB_WORKFLOW.md), including its routing: routine
changes go directly to `main`, risky ones use a short-lived branch and PR.

Invocation approves implementing the selected issues. It does not approve releases,
milestone closure, real-media jobs, legacy tracker cleanup, or product decisions an
issue leaves open.

## 1. Select

1. `git pull --ff-only` on `main`. Note unrelated uncommitted edits: never stash,
   reset, discard or stage them.
2. List open issues (not PRs) with labels, milestone, body and comments, using
   `gh api --hostname github.com` or `gh … -R Plonk42/PasCap` (verify the host).
   Also check open PRs so an issue already in progress is skipped.
3. Rank by relevance, in this order:
   - CI failure signatures and `bug`s before `enhancement`/`task`;
   - `priority:p0` → `p3`;
   - earliest open outcome milestone (v0.1 before v0.2 before v0.3);
   - `status:ready` before unlabelled before `status:backlog`;
   - smaller, self-contained scope first; issues unblocking others first.
4. Skip, and report why, issues that are `status:blocked` or have open blocked-by
   links, need an owner decision or design approval still open in the issue, need
   real media, a release or credentials, or depend on another selected issue's
   unmerged PR. Never stack dependent risky PRs.
5. State the chosen X issues and the skipped candidates in one short list, then
   proceed without waiting for confirmation.

## 2. Deliver each issue, one at a time

For each selected issue, in ranked order:

1. `git pull --ff-only` on `main`. Read the issue, its comments, linked issues and
   the relevant contract guides; verify current behaviour in the code before
   changing anything.
2. Classify the change as routine or risky using the workflow table (when unsure,
   risky). For risky work, `git switch -c issue/<N>-<short-slug> origin/main`
   after `git fetch origin`.
3. Implement the smallest complete change meeting its acceptance criteria, with
   tests and guide updates. Respect the product, data-safety and architecture
   rules of the repository instructions.
4. Validate as the instructions require: affected unit tests, SonarQube diagnostics
   on changed code, live browser inspection at 1440 × 900 and 1280 × 720 for UI
   changes, `npm run format`, `npm run check`, and every affected Playwright spec
   found by searching `tests/browser`. Run Chrome/Firefox/native suites or CI-like
   runs only where the instructions call for them. Never weaken assertions, add
   retries or skip tests.
5. Commit coherent steps with only owned files (imperative summary with `(#N)`).
   - Routine: put `Closes #N` in the final commit and `git push origin main`.
   - Risky: push the branch, open a PR from the
     [template](../pull_request_template.md) with `Closes #N`, and run
     `gh pr merge --auto --squash`. Don't wait for CI; switch back to `main`.
6. If the issue cannot be finished (missing decision, failing validation you cannot
   fix, scope larger than expected), stop work on it and commit nothing incomplete
   to `main`. Risky work: push what is useful as a draft PR without `Closes`, then
   move on. Routine work: leave the partial edits uncommitted and end the run, so
   they never mix with the next issue. Comment on the issue only with information
   worth keeping.

## 3. Report

End with one short line per issue: number, title, commit or PR link (or reason stopped),
validation run, and remaining limitations. List skipped candidates separately.
