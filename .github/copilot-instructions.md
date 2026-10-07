# PasCap working instructions

Reply in English. Keep summaries short and name remaining limitations.

## Workflow

PasCap is a solo, pre-release project: optimize for fast iteration. Details are in
[the GitHub workflow](../docs/GITHUB_WORKFLOW.md).

- Start from current `main` (`git pull --ff-only`). Never stash, reset, discard or
  commit unrelated edits that are already in the checkout; leave them unstaged.
- **Routine changes go directly to `main`:** UI/editor behaviour, docs, tests, small
  fixes and refactors. Run the fast gate below, commit and `git push origin main`.
  CI on `main` is the backstop; if it fails, fixing it is the next task.
- **Risky changes use a short-lived branch and PR** with squash auto-merge
  (`gh pr merge --auto --squash`): playback/A-V clock, decoder/compositor, native
  export/FFmpeg, project schema or persisted formats, source-media safety, CI and
  scripts, dependency upgrades. Don't wait for CI in the session; report the PR.
- Commit each coherent step with its tests and doc updates, not every small
  correction. Imperative summary; add `(#N)` when tied to an issue, or `Closes #N`
  when the commit (or PR) completes it.
- Never force-push `main`. Rebase/force-push a task branch only when asked, with
  `--force-with-lease`.
- Issues are for bugs, features and multi-step work worth tracking. Routine changes
  need no issue, label update, Project card or checkpoint comment.
- Releases, milestone closure, real-media jobs and legacy tracker cleanup need
  explicit approval.

## Validation

- While editing: affected unit tests (`npm test -- tests/unit/<file>.test.ts`) and
  the dev server.
- Before pushing: `npm run format`, then `npm run check` (formatting, unit/service
  tests, types, build, licenses) plus the affected Playwright specs for UI changes.
  Docs-only changes need only `npm run format`.
- Full Chrome, Firefox and native suites run in CI. Run them locally only for
  playback, decoding, native export or test-infrastructure changes.
- Never weaken assertions, add retries or skip regressions to get green. Don't
  build or reset fixtures while a browser run is serving them.

## Product and data safety

- Originals are referenced in place, never uploaded, copied or modified. Tests use
  synthetic media or memory-only projects. Real imports, preparations, exports,
  benchmarks and long renders need explicit owner consent.
- Keep the editor simple to learn without removing features: common actions where
  expected, accessible native controls, visual feedback over explanatory text.
  Preserve keyboard/focus behaviour and one Undo step per completed gesture;
  invalid edits never silently clamp, merge or overwrite.
- Until the first release candidate, approved changes may break saved projects and
  persisted formats. Keep one strict current contract: no migrations, legacy fields,
  compatibility defaults or old-format readers unless requested. Reject
  incompatible data clearly; never silently rewrite or delete it.
- Never commit or post private paths, media, credentials, caches or generated reports.

## Architecture

- Shared integer-frame layout/retiming (`PlacedClip.retiming`) is authoritative for
  UI, preview and native export. Per-frame rendering stays outside React.
- Strict schema 8 with uniform tracks, each requiring `ripple`, `transitions`,
  `openingFade` and `closingFade`; rows show the saved bottom-to-top order.
- Final approved [#67](https://github.com/Plonk42/PasCap/issues/67): **Opacity** is
  one row-owned setting, not a clip setting. `VideoLayer.opacity` is a required
  number in 0–1; new tracks start at 1 (100%). No saved `clip.opacity` field.
  The sole row key channel is `opacity`; points require all nine nullable channels:
  `opacity`, `speed` and the seven colour settings. Reject missing row opacity,
  saved `clip.opacity` and old `clipOpacity`/`layerOpacity` channels; do not supply
  compatibility defaults. `layer.opacity` is the valid sole stored row value.
  Put the single **Opacity** slider/diamond/navigation in **Clip → Colour** beside
  the colour sliders, usable on empty rows too. Without Opacity keys, the slider
  edits `row.opacity`; keys override that value on every clip, including both
  dissolve sources. Sliders never create keys; an animated channel without a
  participant at the real playhead is read-only until its diamond captures it.
  **Placement** contains placement only; Layer options contains only rename,
  Ripple, ordering and deletion. Visibility stays separate. Unkeyed colour
  settings remain per-clip; Opacity is composition coverage, not SDR RGB grading.
  Group composition is $C = \sum_i G_i b_i o_i w_i$, $A = \sum_i o_i w_i$,
  $\mathrm{result} = C + \mathrm{lower}(1 - A)$, evaluating row Opacity for each
  source with no additional layer multiplier.
  Preserve incompatible v1–v7 projects/receipt snapshots; require recreation,
  without migrations, compatibility defaults or automatic deletion.
- Music is a required 0–8 array of independently identified instances, never null
  or singular. Duration is the maximum of all video and music OUTs. After the last
  active video, preview/export is opaque black while music continues to its own OUT;
  video fades remain inside their clips. Mix serially after per-instance gain/fades
  and clamp once after the complete sum, with one bounded queue/output clock.
- Heavy native work stays serial with bounded children/buffers, exact frame counts
  and source identity guards.
- Read and update the relevant contract guide when behaviour changes:
  [timeline](../docs/TIMELINE_EDITING.md),
  [layers/keyframes/resources](../docs/LAYERS_AND_KEYFRAMES.md),
  [speed/audio](../docs/SPEED_AND_AUDIO.md),
  [workspace/recovery](../docs/WORKSPACE_AND_RECOVERY.md) and
  [development](../docs/DEVELOPMENT.md). Guides describe current behaviour only;
  history belongs in Git and issues.
