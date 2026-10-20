# PasCap working instructions

Reply in English. Keep summaries short and name remaining limitations.

## Workflow

PasCap is a solo, pre-release project: optimize for fast iteration, but the owner now
edits real projects with it, so saved data must keep working. Details are in
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
- **Backward compatibility is required** (owner, 2026-10-18), unless the owner
  explicitly waives it for a change. Projects (including export receipt snapshots),
  the video/music registries and receipts saved by any supported version must keep
  opening with the same meaning. An incompatible project change bumps
  `PROJECT_SCHEMA_VERSION` (src/shared/model.ts), adds the upgrade step from the
  previous version in `src/shared/project-migrations.ts` and a frozen
  `tests/fixtures/projects/schema-N.json` (never edit an existing one). Prefer
  additive changes that need no bump. Never silently drop or reinterpret saved
  values; reject data a build cannot open clearly and leave it unchanged.
  Regenerable caches (proxies, PCM, thumbnails, motion analysis) may instead
  require explicit re-preparation. Never write the schema number in docs.
- Never commit or post private paths, media, credentials, caches or generated reports.

## Architecture

- Shared integer-frame layout/retiming (`PlacedClip.retiming`) is authoritative for
  UI, preview and native export. Per-frame rendering stays outside React.
- Preview and source review decode proxies only with WebCodecs `VideoDecoder` in
  worker lanes delivering exact source frames under credit bounds; no `<video>`
  elements, media-element time or seek heuristics. See
  [WebCodecs preview](../docs/design/WEBCODECS_PREVIEW.md).
- Speed is clip-only: strict constant `rate` or a 1–256-keyframe curve on original
  source frames (presets such as Ramp up replace its keyframes). A clip's duration
  depends only on its own speed and source range, never its track, start or Ripple
  position; there is no track Speed channel.
- #171: every clip requires boolean `reverse` (Clip → Speed checkbox), a
  direction, not a negative rate. The retiming map mirrors forward output time, so
  duration and speed-keyframe footage are unchanged. Timeline edits act on the clip as
  displayed (left handle/Q trim source OUT; split/cut pieces stay reversed). Preview
  reverses GOP by GOP (≤ 6 held + 6 outstanding frames per lane); export decodes
  serial seeked chunks through FFmpeg `reverse` within `reverseChunkBytes` (256 MiB).
  See [speed/audio](../docs/SPEED_AND_AUDIO.md).
- Sliding timeline keyframe markers (track, Transform and any new type) must use
  `useKeyframeSlide`/`KeyframeMarkers` in `src/web/keyframe-slide.tsx`; a type
  only supplies its `KeyframeSlideKind`, never its own drag/keyboard handling.
- Section keyframe controls have no Animate toggle or stored preference: main capture diamonds and adjacent
  per-setting Previous/Next buttons are always visible while a section is expanded. Keep these main buttons
  because not every setting is enabled at every shared keyframe, alongside the existing stored
  enabled-setting chip arrows. All per-channel arrows visit strictly earlier/later keyframes where that
  channel is nonnull (zero is enabled), sharing the central off-duration inspection cursor. Each expanded
  section has one keyframe line (count, one Previous/Next pair over the same set, Reset), hidden
  while collapsed. Colour and Transform each end with their own stored keyframe list (same
  row pattern via one shared `StoredKeyframeList`); there is no separate Keyframes section. The pair: Colour visits Opacity/twelve scalar
  colour/HDR/Local contrast keyframes; Speed visits **all retained custom speed source keyframes of the
  selected clip**, including off-trim keyframes and original exclusive OUT; Speed's
  single setting has no extra per-setting arrows beside its diamond. Clip source navigation
  previews the nearest image mapped by authoritative retiming, using an independent
  clip-local stored-source cursor, not central track inspection or a clamped
  playhead as stored time. Transform visits all retained track Transform keyframes,
  including those after the duration, with its own track-local cursor. Successive stored
  keyframes remain reachable when previews coincide; main values/capture always use the
  real displayed project/source frame. Timeline speed markers still omit off-trim
  keyframes; exclusive OUT has a boundary marker seeking the last available image.
  Navigation never edits,
  saves or creates history. See [speed/audio](../docs/SPEED_AND_AUDIO.md) and
  [spatial transforms](../docs/design/SPATIAL_TRANSFORMS.md).
- #143: projects require `bookmarks`: 0–1,000 unique ascending project
  frames, `[]` on new projects. They are extra `snapPoints()` for every snapping gesture,
  slide through `useKeyframeSlide` (a dragged bookmark never snaps to itself) and never
  retime, render or export. See [timeline](../docs/TIMELINE_EDITING.md).
- The strict current schema requires complete row Colour with twelve graded scalar fields
  (including `vibrance`, −1…2, a chroma scale after Saturation weighted towards muted
  colours; #184 `whites`, −1…1, a white-point tone stage after Highlights, and `blacks`,
  −1…1, a black-point tone stage after Whites; raised it adds a matte lift),
  `hdr`, `localContrast`, `colour.hsl` (eight complete named bands) and `colour.curves` (master/red/green/blue
  2–16-point arrays). HSL/curves remain static, not animation channels. All Colour
  is row-owned, keyed or not; clips have no colour/correction. Neutral creators
  deep-clone nested structures; never repair missing saved fields. Advanced resets
  never overwrite scalar bases/keys or Opacity; Reset on an animated section never erases advanced
  settings. Keep existing LUT/buffer/decoder/native budgets and strict gates. See
  [the advanced colour contract](../docs/design/HSL_AND_CURVES.md).
- Approved #68: required row `temperature` and `tint` colour fields use normalized
  −2…2 and −1…1, neutral 0; positive Temperature warms, positive Tint adds magenta.
  For Temperature $T$, Tint $I$, raw gains are
  $q=(2^{T/2+I/4},2^{-I/4},2^{-T/2+I/4})$, normalized as
  $g=q/(0.2126q_R+0.7152q_G+0.0722q_B)$. Apply to decoded linear RGB before
  Exposure, then the remaining scalar SDR stages → encoded HSL → master → RGB
  curves → fades/coverage. CPU/reference/native/GPU use the same math and order.
  Nonzero settings intentionally colour greys; normalization preserves neutral-white
  linear luminance before clipping only, not arbitrary pixels or final output.
  No Kelvin/HDR output. #218 **Auto white balance** (under Tint) estimates Temperature/Tint
  from 7 proxy frames within ±15 of the playhead (its clip, mapped through retiming) on its
  own temporary reader, and keyframes both at the playhead like their diamonds, one Undo
  step; no schema/render/export change. #167 Phase 1 **Auto** (Colour keyframe line)
  fits eleven scalar settings from 16 proxy frames through the real grade (#225: colour is raised with
  Vibrance, limited on strong colours such as skies; Saturation only lowers it), previews them in a
  popover with Intensity (initially 80%, the fitted correction; 100% exaggerates it by a
  quarter) and applies one Undo step: **Track values** analyses the whole clip at the playhead
  and edits the bases, leaving animated settings and keyframes unchanged; **Keyframe at
  playhead** analyses ±30 frames and captures all eleven like their diamonds (initial once any is
  animated). Constants in `src/shared/auto-adjust.ts`, no schema/render change
  ([Auto adjust](../docs/design/AUTO_ADJUST.md)).
  Main/stored slider/exact-field/reset/diamond/navigation retain
  explicit capture, row ownership, empty-row editing and one-step gestures.
  Compare bypasses all Colour, including Temperature/Tint, and clip Detail, never coverage or geometry.
  See [Temperature and Tint](../docs/design/TEMPERATURE_AND_TINT.md).
- Owner-approved #70: required row `colour` contains all twelve scalar SDR channels,
  neutral on new rows, with sole row `opacity` initially 1. Reject saved
  `clip.colour`, `clip.correction` and missing row colour. Static and keyed Colour
  have identical row ownership; different treatments require different rows.
  Grade sampled RGB once with evaluated row Colour before fades/coverage.
  Ungraded neutralizes row Colour and clip Detail only. Native LUTs use only row Colour, with two
  reused buffers and unchanged bounds. Controls/keys work on empty rows. Moves/new
  clips adopt destination bases/keys/Opacity; trim/split/cut/duplicate preserve
  row bases and absolute points, without per-clip colour copies. HSL and curves
  retain that ownership, as do Temperature and Tint.
  See [row appearance](../docs/design/ROW_APPEARANCE.md).
- Owner-approved #131: Transform is **track-owned, exactly like Colour**.
  Every video track requires strict `transform: { base, keyframes }`; clips have no
  `spatial` field. Eight complete pose values and 0–256 ascending absolute project-frame
  keys `{ frame, values, easing, reset }`; each key enables any of the eight settings
  (others null, at least one number) with its own Easing, and each setting interpolates
  between its own keys with endpoint holds. A setting without keys holds its base;
  deleting its last key reveals that base. A Transform default keyframe (`reset: true`,
  neutral pose, Hold) never reaches back, like a Colour default keyframe. Reset transform
  behaves like Colour Reset: unanimated it restores the neutral base, animated it
  neutralizes the enabled settings of the key at the playhead. The pose applies to
  every source on the track (both dissolve sources, per source, no extra resampling
  pass); clip edits never copy or shift it and moves adopt the destination pose.
  Scale is 0.1–8, translation −2–2 output-width/height fractions, rotation
  −180°–180° clockwise with numeric, not shortest-arc interpolation. Crop fractions
  are each in 0–1 (a crop of 1, or opposite crops summing to 1 or more, cover nothing), without refit or moving the original-centre pivot;
  use unrounded original-aspect contain fit and top-left half-open crop bounds.
  Exact neutral rendering preserves opaque black letterboxing after grading;
  nonneutral uncovered pixels are transparent. Track → Transform follows Colour
  curves, collapsed by default, with a capture triangle and Previous/Next per setting,
  read-only animated main values without that setting's key at the real playhead,
  **Add default Transform keyframe**, stored-key navigation/exact fields and live
  slider preview; blue ▼ markers sit at the top of the track row. Any spatial
  edit/key requires layered export; native 22 bytes/pixel, two LUTs and process
  bounds remain unchanged. See [spatial transforms](../docs/design/SPATIAL_TRANSFORMS.md).
- Owner-approved #123: every clip requires strict static `detail: { sharpen 0–2,
clarity −1–1, denoise 0–1 }`, neutral 0, with no keyframes or track channel; split/
  cut/duplicate copy it. Filters run on bilinear source taps around the inverse-mapped
  point, before the Colour grade: Denoise (spatial bilateral) → Clarity → Sharpen,
  radii in 1/720 of the image height. Exact neutral bypasses the kernel (bit-identical).
  Shader tap tables and the native compositor share `src/shared/detail.ts`; any
  nonneutral detail requires composited export without new Node buffers or native processes.
  #147: export composites detail/HDR groups in one service-owned headless Chrome GPU
  worker page (same shaders, loopback HTTP, software renderers rejected) with automatic
  CPU fallback; the CPU kernel stays the parity reference.
  Compare bypasses Colour and Detail. Clip → Detail is the third section, collapsed
  by default, with live slider preview and one Undo per release. See
  [detail filters](../docs/design/DETAIL_FILTERS.md).
- Track Colour **Shadows**, **Highlights** (−1…1), **HDR** (`colour.hdr` 0–1, fourteenth
  keyframe channel `hdr`, an SDR local tone-mapping look) and **Local contrast**
  (`colour.localContrast` −1…1, fifteenth channel `localContrast`, the local-detail boost
  split out of HDR, which keeps only its tone compression) are local tone settings: evaluated at project time but applied in the shared detail
  kernel on source taps before grading (Denoise → HDR/Local contrast → Shadows/Highlights →
  Clarity → Sharpen) from one guided edge-aware base,
  excluded from the per-pixel grade and LUT identity; any nonzero or keyed value needs
  composited export. Shadows/Highlights are linear-light gains in stops chosen by the base
  after Exposure. See [detail filters](../docs/design/DETAIL_FILTERS.md).
- Final approved [#67](https://github.com/Plonk42/PasCap/issues/67): **Opacity** is
  one row-owned setting, not a clip setting. `VideoLayer.opacity` is a required
  number in 0–1; new tracks start at 1 (100%). No saved `clip.opacity` field.
  The sole row Opacity key channel is `opacity`; points require all fifteen nullable
  channels: `opacity`, `temperature`, `tint`, `exposure`, `brightness`,
  `contrast`, `hue`, `saturation`, `vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`,
  `localContrast`. Reject missing row opacity,
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
  Version-1 export receipts require strict current-schema snapshots and captured audio-source/
  instance-plan arrays; receipt, registry/proxy/PCM and benchmark format versions
  remain independent and unchanged.
  Reject and preserve projects/receipt snapshots older than the oldest supported
  schema (`OLDEST_PROJECT_SCHEMA_VERSION`), without automatic deletion.
- Owner-approved #135/#87: track and Transform keyframes store one Easing per enabled
  setting (`easing` mirrors `values`); a joining setting adopts the Easing its keyframe's
  settings agree on, else Linear. Track keyframes require boolean `reset`: a **default
  keyframe** (`reset: true`, created with all fifteen settings neutral and Hold Easing)
  never reaches back, so a setting whose first keyframe it is keeps its unkeyed value before
  it. Toggle **Add default keyframe** in the Colour keyframe line; amber filled marker.
  Transform keyframes carry the same `reset` flag (own toggle in the Transform line). See
  [layers/keyframes](../docs/LAYERS_AND_KEYFRAMES.md).
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
  [detail filters](../docs/design/DETAIL_FILTERS.md),
  [WebCodecs preview](../docs/design/WEBCODECS_PREVIEW.md),
  [workspace/recovery](../docs/WORKSPACE_AND_RECOVERY.md) and
  [development](../docs/DEVELOPMENT.md). Guides describe current behaviour only;
  history belongs in Git and issues.
