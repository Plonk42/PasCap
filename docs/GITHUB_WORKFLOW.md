# GitHub workflow

PasCap is a solo, pre-release project. The workflow favours fast iteration: small
commits straight to `main`, CI as an asynchronous backstop, pull requests only for
risky changes and GitHub issues only for work worth tracking.

## Delivering changes

| Change                                                                                                                                                             | Route                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **Routine:** UI/editor behaviour, docs, tests, small fixes, refactors                                                                                              | Fast local gate, commit, push to `main`          |
| **Risky:** playback/A-V clock, decoder/compositor, native export/FFmpeg, project schema or persisted formats, source-media safety, CI/scripts, dependency upgrades | Short-lived branch and PR with squash auto-merge |

When unsure, treat the change as risky.

For either route, check SonarQube for IDE diagnostics on affected code files and
fix relevant new findings without suppressing them
([details](DEVELOPMENT.md#validation)).

### Routine changes

1. `git pull --ff-only` on `main`. Leave unrelated uncommitted edits untouched and
   unstaged.
2. Edit, running the affected unit tests and the dev server while working. UI
   changes also need [live visual inspection](DEVELOPMENT.md#live-ui-inspection).
3. Run the fast gate: `npm run format`, then `npm run check` plus the affected
   Playwright specs for UI changes ([commands](DEVELOPMENT.md#fast-local-validation)),
   found by search rather than memory. Docs-only changes need only `npm run format`.
4. Commit each coherent step with its tests and doc updates, then
   `git push origin main`. GitHub reports the push as bypassing the PR rule; that
   is expected for routine changes.
5. CI runs on `main`. If it fails, fixing it is the next task: fix forward rather
   than revert unless the breakage blocks other work.

### Risky changes

1. Branch from current `main`, commit coherent steps, push and open a PR using the
   [template](../.github/pull_request_template.md).
2. Enable squash auto-merge with `gh pr merge --auto --squash`. GitHub merges when
   the **Delivery gate** passes; don't wait for CI in the session.
3. If CI fails, the PR stays open: fix it on the same branch. If `main` moved and
   the PR conflicts, merge `main` into the branch. Rebase and force-push with
   `--force-with-lease` only when explicitly asked, or to drop an already
   squash-merged base from your own unmerged branch.
4. Don't stack dependent PRs that change persisted formats or shared playback/
   compositor code: land each one before branching the next from `main`. One CI
   problem in a stack blocks every PR above it.

### CI failures

A failure only on hosted runners is a real-condition signal, not flakiness. Group
recent failures with `npm run ci:failures`, reproduce with the CI-like browser run
and fix the cause ([steps](DEVELOPMENT.md#ci-only-failures-and-time-limits)). The
same failing signature twice warrants a bug issue and takes priority over new
feature work. Time limits may be raised for legitimately heavy work; runner speed
is never a correctness or performance gate.

### Commits, closing issues and approvals

- Use an imperative summary such as `Improve timeline scrolling (#18)`. Reference
  related issues with `(#N)`; put `Closes #N` in the commit message (direct push)
  or PR description when the work completes the issue. GitHub then closes it and
  the Project moves it to Done.
- Never force-push `main`, weaken or skip tests to get green, or commit private
  paths, media, credentials, caches or generated reports.
- Releases, milestone closure, real-media jobs and cleanup of legacy tracking
  ([#15](https://github.com/Plonk42/PasCap/issues/15) and the `iteration` labels)
  need explicit owner approval.

## CI and branch protection

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to
`main` and manual dispatch, with read-only permissions. A newer push to the same
branch cancels the older run.

| Job                                      | Runs                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Checks / Node 22 (and Node 24 on `main`) | `npm run check` (including formatting); `npm audit` on `main`                                              |
| Native media / FFmpeg 8.0.1              | Synthetic native suite (`npm run test:media`)                                                              |
| Chrome browser 1/4 to 4/4                | Full Chrome suite sharded by spec file, fresh fixtures per shard                                           |
| Firefox music and playback               | Scoped Firefox regressions ([details](DEVELOPMENT.md#firefox-music-regression-and-optional-investigation)) |
| Delivery gate                            | Succeeds only if every job above succeeded                                                                 |

The separate [real-time stress workflow](../.github/workflows/realtime-stress.yml)
repeats the Chrome music/playback regressions nightly and on manual dispatch. It
is not a required check. Job summaries list tests near their time limits and
real-time headroom readings.

`main` protection: pull requests for non-admin pushes, **Delivery gate** as the
only required check (branches need not be up to date), linear history, resolved
conversations, no force push or deletion. Administrator enforcement is off so the
owner can push routine changes directly. Squash merging, auto-merge and automatic
head-branch deletion are enabled.

## Issues and planning

- Open an issue for bugs, features, investigations and multi-step work worth
  tracking; search first. Routine changes need no issue. Logging an issue does
  not approve implementation.
- Triage with one category, one priority, relevant areas and an outcome
  [milestone](https://github.com/Plonk42/PasCap/milestones). Record real
  prerequisites as native blocked-by links.
- `status:*` labels and Project Status are optional planning aids. Don't update
  them for every commit, and don't clean them up after closure.
- Comment only when it adds information worth keeping: a reproduction, a decision
  or a failing CI run. No per-step checkpoints.
- [ROADMAP.md](ROADMAP.md) indexes outcomes; issues hold mutable progress. Guides
  describe current behaviour; history belongs in Git and issues.

| Category      | Meaning                                                |
| ------------- | ------------------------------------------------------ |
| `bug`         | Reproducible incorrect behaviour                       |
| `enhancement` | Product feature or improvement                         |
| `task`        | Engineering, verification, documentation or operations |

| Priority      | Meaning                                                |
| ------------- | ------------------------------------------------------ |
| `priority:p0` | Data loss, security incident or unusable core workflow |
| `priority:p1` | Correctness, source safety or a milestone gate         |
| `priority:p2` | Normal planned work (default)                          |
| `priority:p3` | Optional improvement                                   |

Areas: `area:editor`, `area:media`, `area:export`, `area:preview`, `area:audio`,
`area:ci`, `area:container`, `area:licensing` and `area:workflow`.
`documentation` and `accessibility` are modifiers.

The private [planning Project](https://github.com/users/Plonk42/projects/1) shows
the same issues on a Status board (sign-in required). Its **Item closed** workflow
sets closed issues to Done; a board move never closes an issue. There are no sprint
issues or agreed iteration cadence.

Use `/github-issue <short request>` in Copilot Chat to log and triage an issue
through the [issue skill](../.github/skills/github-issue/SKILL.md), or the
[bug](../.github/ISSUE_TEMPLATE/bug_report.yml),
[feature](../.github/ISSUE_TEMPLATE/feature_request.yml) and
[task](../.github/ISSUE_TEMPLATE/work_item.yml) forms.

## Compatibility before the first release candidate

Until RC1, fast iteration takes precedence over backward compatibility. Approved
changes may break saved projects and persisted formats; the owner accepts
recreating them.

- Keep one current, strict data contract: no migrations, optional legacy fields,
  compatibility defaults, old-format readers or compatibility-only tests unless
  explicitly requested.
- Version changed formats so incompatible data is rejected clearly. Never silently
  rewrite or delete existing data; originals and completed exports stay untouched.
- Mention required project recreation or data resets in the commit or PR and the
  affected guides. A reset requirement is guidance, not permission to perform it.

Before RC1, agree the subsequent compatibility policy with the owner and record it
here.
