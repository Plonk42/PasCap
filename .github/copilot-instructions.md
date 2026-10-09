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
- Never force-push `main`. Rebase/force-push a task branch only when asked, or to
  drop an already squash-merged base from your own unmerged branch, with
  `--force-with-lease`. Don't stack dependent risky PRs; land each first.
- Issues are for bugs, features and multi-step work worth tracking. Routine changes
  need no issue, label update, Project card or checkpoint comment.
- Releases, milestone closure, real-media jobs and legacy tracker cleanup need
  explicit approval.

## Validation

- While editing: affected unit tests (`npm test -- tests/unit/<file>.test.ts`) and
  the dev server.
- Check SonarQube for IDE diagnostics on affected code files while editing and
  before delivery. Fix relevant new findings; never add `NOSONAR`, suppress
  warnings or exclude files. Report justified exceptions or unavailable analysis.
- UI/layout/control/interaction changes **must** be checked live in the VS Code
  integrated browser with Playwright on disposable synthetic or memory-only
  projects: rendered screenshots before changes and after the final edit, relevant
  states at 1440 × 900 and the 1280 × 720 minimum supported viewport. Smaller
  windows are best effort and need no checks. Tests or DOM snapshots alone are not
  visual validation. Steps: [development](../docs/DEVELOPMENT.md). Report what was
  inspected; if browser access is unavailable, name the blocker and missing check.
- Before pushing: `npm run format`, then `npm run check` (formatting, unit/service
  tests, types, build, licenses) plus the affected Playwright specs for UI changes.
  Find affected specs by searching `tests/browser` for every accessible name,
  selector and visible/help text the change renamed, removed or newly hides, after
  `git pull`; run each match, not only specs you edited.
  Docs-only changes need only `npm run format`.
- Full Chrome, Firefox and native suites run in CI. Run them locally only for
  playback, decoding, native export or test-infrastructure changes.
- Never weaken assertions, add retries or skip regressions to get green. Don't
  build or reset fixtures while a browser run is serving them.
- A CI-only failure is a real-condition signal: group it with `npm run ci:failures`,
  reproduce with `npm run test:browser:ci-like` and fix the cause; a repeated
  signature becomes a bug before more feature work. Size heavy time limits at about
  three times measured time; runner speed is never a gate.

## Product and data safety

- Originals are referenced in place, never uploaded, copied or modified. Tests use
  synthetic media or memory-only projects. Real imports, preparations, exports,
  benchmarks and long renders need explicit owner consent.
- Keep the editor simple to learn without removing features: common actions where
  expected, accessible native controls, visual feedback over explanatory text.
  Preserve keyboard/focus behaviour and one Undo step per completed gesture;
  invalid edits never silently clamp, merge or overwrite.
- User-facing animation text uses **Keyframe**, **enabled setting** and **Easing**,
  following [the editor control catalogue](../docs/design/EDITOR_CONTROLS.md).
  Keep contextual accessible names and technical/internal math terms such as
  anchor, participant and `interpolation` where needed; do not rename saved fields
  or internal identifiers merely to match visible labels.
- Until the first release candidate, approved changes may break saved projects and
  persisted formats. Keep one strict current contract: no migrations, legacy fields,
  compatibility defaults or old-format readers unless requested. Reject
  incompatible data clearly; never silently rewrite or delete it.
- Never commit or post private paths, media, credentials, caches or generated reports.

## Architecture

- Shared integer-frame layout/retiming (`PlacedClip.retiming`) is authoritative for
  UI, preview and native export. Per-frame rendering stays outside React.
- Section keyframe controls have no Animate toggle or stored preference: main capture diamonds and adjacent
  per-setting Previous/Next buttons are always visible while a section is expanded. Keep these main buttons
  because not every setting is enabled at every shared keyframe, alongside the existing stored
  enabled-setting chip arrows. All per-channel arrows visit strictly earlier/later keyframes where that
  channel is nonnull (zero is enabled), sharing the central off-duration inspection cursor. Each expanded
  section has one keyframe line (count, one Previous/Next pair over the same set, Reset keyframes), hidden
  while collapsed. The pair: Colour visits Opacity/nine scalar
  colour keyframes; Speed visits track Speed keyframes and **all retained custom
  speed source keyframes of the selected clip**, including off-trim keyframes and
  original exclusive OUT, even under a track Speed override. Clip source navigation
  previews the nearest image mapped by authoritative retiming, using an independent
  clip-local stored-source cursor, not central track inspection or a clamped
  playhead as stored time. Transform likewise visits all retained source
  keyframes with its own clip-local cursor. Successive stored keyframes remain
  reachable when previews coincide; main values/capture always use the real
  displayed project/source frame. Timeline source markers still omit off-trim
  keyframes; exclusive OUT has a boundary marker seeking the last available image.
  Navigation never edits,
  saves or creates history. See [speed/audio](../docs/SPEED_AND_AUDIO.md) and
  [spatial transforms](../docs/design/SPATIAL_TRANSFORMS.md).
- Strict schema 12 requires complete row Colour with nine scalar fields plus
  `colour.hsl` (eight complete named bands) and `colour.curves` (master/red/green/blue
  2–16-point arrays). HSL/curves remain static, not animation channels. All Colour
  is row-owned, keyed or not; clips have no colour/correction. Neutral creators
  deep-clone nested structures; never repair missing saved fields. Advanced resets
  never overwrite scalar bases/keys or Opacity; Reset keyframes never erases advanced
  settings. Keep existing LUT/buffer/decoder/native budgets and strict gates. See
  [the advanced colour contract](../docs/design/HSL_AND_CURVES.md).
- Approved #68: required row `temperature` and `tint` colour fields use normalized
  −1…1, neutral 0; positive Temperature warms, positive Tint adds magenta.
  For Temperature $T$, Tint $I$, raw gains are
  $q=(2^{T/2+I/4},2^{-I/4},2^{-T/2+I/4})$, normalized as
  $g=q/(0.2126q_R+0.7152q_G+0.0722q_B)$. Apply to decoded linear RGB before
  Exposure, then the remaining scalar SDR stages → encoded HSL → master → RGB
  curves → fades/coverage. CPU/reference/native/GPU use the same math and order.
  Nonzero settings intentionally colour greys; normalization preserves neutral-white
  linear luminance before clipping only, not arbitrary pixels or final output.
  No Kelvin/HDR/AWB. Main/stored slider/exact-field/reset/diamond/navigation retain
  explicit capture, row ownership, empty-row editing and one-step gestures.
  Compare bypasses all Colour, including Temperature/Tint, never coverage or geometry.
  See [Temperature and Tint](../docs/design/TEMPERATURE_AND_TINT.md).
- Owner-approved #70: required row `colour` contains all nine scalar SDR channels,
  neutral on new rows, with sole row `opacity` initially 1. Reject saved
  `clip.colour`, `clip.correction` and missing row colour. Static and keyed Colour
  have identical row ownership; different treatments require different rows.
  Grade sampled RGB once with evaluated row Colour before fades/coverage.
  Ungraded neutralizes only row Colour. Native LUTs use only row Colour, with two
  reused buffers and unchanged bounds. Controls/keys work on empty rows. Moves/new
  clips adopt destination bases/keys/Opacity; trim/split/cut/duplicate preserve
  row bases and absolute points, without per-clip colour copies. HSL and curves
  retain that ownership, as do Temperature and Tint.
  See [row appearance](../docs/design/ROW_APPEARANCE.md).
- Every clip requires strict `spatial: { base, keyframes }`: eight complete pose
  values and 0–256 ascending original-source keys with required easing; each key
  enables any of the eight settings (others null, at least one number) and each
  setting interpolates between its own keys with endpoint holds. A setting without
  keys holds its base; deleting its last key reveals that base; Reset transform
  clears keys and restores the neutral base deliberately.
  Retain/deep-copy original anchors through trims, cuts, splits and duplication,
  including off-trim keys and original exclusive OUT. Evaluate geometry with
  `PlacedClip.retiming.sourcePositionAt`; `sourceAt` remains recorded-image identity.
  Scale is 0.1–8, translation −2–2 output-width/height fractions, rotation
  −180°–180° clockwise with numeric, not shortest-arc interpolation. Crop fractions
  are each below 1 (opposite crops summing to 1 or more cover nothing), without refit or moving the original-centre pivot;
  use unrounded original-aspect contain fit and top-left half-open crop bounds.
  Exact neutral rendering preserves opaque black letterboxing after grading;
  nonneutral uncovered pixels are transparent. Clip → Transform is the fourth
  section, collapsed by default, with a source-frame capture diamond and Previous/Next per setting,
  read-only animated main values without that setting's key at the real displayed source frame,
  stored-key navigation/exact fields and release-only value sliders. Any spatial
  edit/key requires layered export; native 22 bytes/pixel, two LUTs and process
  bounds remain unchanged. See [spatial transforms](../docs/design/SPATIAL_TRANSFORMS.md).
- Final approved [#67](https://github.com/Plonk42/PasCap/issues/67): **Opacity** is
  one row-owned setting, not a clip setting. `VideoLayer.opacity` is a required
  number in 0–1; new tracks start at 1 (100%). No saved `clip.opacity` field.
  The sole row Opacity key channel is `opacity`; points require all eleven nullable
  channels: `opacity`, `speed`, `temperature`, `tint`, `exposure`, `brightness`,
  `contrast`, `hue`, `saturation`, `highlights`, `shadows`. Reject missing row opacity,
  saved `clip.opacity` and old `clipOpacity`/`layerOpacity` channels; do not supply
  compatibility defaults. `layer.opacity` is the valid sole stored row value.
  Put the single **Opacity** slider/diamond/navigation in **Track → Colour** beside
  the colour sliders, usable on empty rows too. Main and stored sliders/exact
  fields use 0–100%, neutral 100%; convert only at the UI boundary, keeping
  `VideoLayer.opacity` and `opacity` key values in 0–1 with no schema change.
  Without Opacity keys, the slider
  edits `row.opacity`; keys override that value on every clip, including both
  dissolve sources. Sliders never create keys; an animated channel without a
  participant at the real playhead is read-only until its diamond captures it.
  **Placement** contains placement only; Layer options contains only rename,
  Ripple, ordering and deletion. Visibility stays separate. Unkeyed colour
  uses the row base. Opacity is coverage, not SDR RGB grading.
  Group composition is $C = \sum_i G_i b_i o_i w_i m_i$, $A = \sum_i o_i w_i m_i$,
  $\mathrm{result} = C + \mathrm{lower}(1 - A)$, evaluating row Opacity for each
  source with no additional layer multiplier; $m_i$ is spatial source coverage,
  including opaque neutral letterboxing. Black fades never reduce that coverage.
  Version-1 export receipts require strict v12 snapshots and captured audio-source/
  instance-plan arrays; receipt, registry/proxy/PCM and benchmark format versions
  remain independent and unchanged.
  Reject and preserve incompatible v1–v11 projects/receipt snapshots; require recreation,
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
  [Temperature and Tint](../docs/design/TEMPERATURE_AND_TINT.md),
  [spatial transforms](../docs/design/SPATIAL_TRANSFORMS.md),
  [workspace/recovery](../docs/WORKSPACE_AND_RECOVERY.md) and
  [development](../docs/DEVELOPMENT.md). Guides describe current behaviour only;
  history belongs in Git and issues.
