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
- **Long-lived dev branches** (owner-requested, no auto-merge, merged whole after
  evaluation): split each issue into steps that keep tests passing (add the new
  behaviour beside the old, then remove the old). Delete specs of removed behaviour
  rather than porting them; add focused specs for the new. Per step run
  `npm run check` plus the specs you edited; run the full suites on CI at the end of
  each issue (`gh workflow run ci.yml --ref <branch>`), not locally. Do live UI
  checks once per issue, on its final UI. Stop and report at each step boundary and
  before any bulk test migration, never one multi-hour turn.
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
  `git pull`; run each match, not only specs you edited (on a long-lived dev
  branch, CI runs them instead; see Workflow).
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
- Sliding timeline keyframe markers (clip grade, Transform and any new type) must use
  `useKeyframeSlide`/`KeyframeMarkers` in `src/web/keyframe-slide.tsx`; a type
  only supplies its `KeyframeSlideKind`, never its own drag/keyboard handling.
- Section keyframe controls have no Animate toggle or stored preference: main capture diamonds and adjacent
  per-setting Previous/Next buttons are always visible while a section is expanded. Keep these main buttons
  because not every setting is enabled at every keyframe, alongside the existing stored
  enabled-setting chip arrows. All per-channel arrows visit strictly earlier/later keyframes where that
  channel is nonnull (zero is enabled). Each expanded
  section has one keyframe line (count, one Previous/Next pair over the same set, Reset), hidden
  while collapsed. Colour and Transform each end with their own stored keyframe list (same
  row pattern via one shared `StoredKeyframeList`); there is no separate Keyframes section. The pair: Colour visits the twelve scalar
  colour/HDR/Local contrast keyframes of the clip grade or adjustment it edits; Speed visits **all retained custom speed source keyframes of the
  selected clip**, including off-trim keyframes and original exclusive OUT; Speed's
  single setting has no extra per-setting arrows beside its diamond. Clip source navigation
  previews the nearest image mapped by authoritative retiming, using an independent
  clip-local stored-source cursor, not a clamped playhead as stored time. Transform visits all retained track Transform keyframes,
  including those after the duration, with its own track-local cursor. Successive stored
  keyframes remain reachable when previews coincide; main values/capture always use the
  real displayed project/source frame. Timeline speed markers still omit off-trim
  keyframes; exclusive OUT has a boundary marker seeking the last available image.
  Navigation never edits,
  saves or creates history. See [speed/audio](../docs/SPEED_AND_AUDIO.md) and
  [spatial transforms](../docs/design/SPATIAL_TRANSFORMS.md).
- Projects require `selects`: per recording in `media.videoIds`, 1–100 ascending kept source ranges separated by at
  least one frame (no entry = whole recording, `[]` invalid), set by `select-set`/`select-narrow` and Source preview's
  applied range (the active range). They never retime, render or export and clips may use other frames. See
  [timeline](../docs/TIMELINE_EDITING.md#kept-ranges).
- #143: projects require `bookmarks`: 0–1,000 unique ascending project
  frames, `[]` on new projects. They are extra `snapPoints()` for every snapping gesture,
  slide through `useKeyframeSlide` (a dragged bookmark never snaps to itself) and never
  retime, render or export. See [timeline](../docs/TIMELINE_EDITING.md).
- Colour lives in **clip grades and adjustments** (#273/#286, owner-approved, below): each has a
  complete `colour` with twelve graded scalar fields (including `vibrance`, −1…2, a chroma scale
  after Saturation weighted towards muted colours; #184 `whites`, −1…1, a white-point tone stage
  after Highlights, and `blacks`, −1…1, a black-point tone stage after Whites; raised it adds a
  matte lift), `hdr`, `localContrast`, `colour.hsl` (eight complete named bands) and
  `colour.curves` (master/red/green/blue 2–16-point arrays). HSL/curves remain static, not
  animation channels. Video tracks have no Colour; saved `clip.colour`/`clip.correction` are
  invalid. Neutral creators deep-clone nested structures; never repair missing saved fields.
  Advanced resets never overwrite scalar bases/keys; Reset on an animated section never erases
  advanced settings. Keep existing LUT/buffer/decoder/native budgets and strict gates. See
  [the advanced colour contract](../docs/design/HSL_AND_CURVES.md).
- Approved #68: required `temperature` and `tint` colour fields use normalized
  −2…2 and −1…1, neutral 0; positive Temperature warms, positive Tint adds magenta.
  For Temperature $T$, Tint $I$, raw gains are
  $q=(2^{T/2+I/4},2^{-I/4},2^{-T/2+I/4})$, normalized as
  $g=q/(0.2126q_R+0.7152q_G+0.0722q_B)$. Apply to decoded linear RGB before
  Exposure, then the remaining scalar SDR stages → encoded HSL → master → RGB
  curves → fades/coverage. CPU/reference/native/GPU use the same math and order.
  Nonzero settings intentionally colour greys; normalization preserves neutral-white
  linear luminance before clipping only, not arbitrary pixels or final output.
  No Kelvin/HDR output. #285: both automatic tools write **clip grades only** (Colour tab, Clip
  target; adjustments have neither). #218 **Auto white balance** (under Tint) estimates Temperature/Tint
  from 16 proxy frames within ±30 of the playhead (on the graded clip, mapped through retiming) on its
  own temporary reader, and keyframes both at the source frame shown there like their diamonds, one Undo
  step; no schema/render/export change. #167 Phase 1 **Auto** (Colour keyframe line)
  fits eleven scalar settings from 16 proxy frames through the real grade (#225: colour is raised with
  Saturation and Vibrance, Saturation giving way first on strong colours such as skies), previews them in a
  popover with Intensity (initially 80%, the fitted correction; 100% exaggerates it by a
  quarter) and applies one Undo step. **Source** (named by scope): Playhead (±30 frames), This clip (whole graded clip) or Every clip on <track>
  (each analysed on its own, one `colour` edit per clip, **Apply to N clips**; keyframes go to this clip only). **Apply as**: Grade values edits
  the grades' values, leaving animated settings and keyframes unchanged; Keyframe (Playhead source only)
  captures all eleven at the source frame like their diamonds (initial, with Playhead, once any is
  animated). Constants in `src/shared/auto-adjust.ts`, no schema/render change
  ([Auto adjust](../docs/design/AUTO_ADJUST.md)).
  Main/stored slider/exact-field/reset/diamond/navigation retain
  explicit capture and one-step gestures.
  Compare bypasses all Colour, including Temperature/Tint, and clip Detail, never coverage or geometry.
  See [Temperature and Tint](../docs/design/TEMPERATURE_AND_TINT.md).
- v1.3 (dev branch `grading-284`), owner-approved #273/#286: every clip requires
  `grade: { colour, keyframes }` (0–64 keys at original-source frames, fourteen nullable
  channels), evaluated at the continuous source position (one frame lower when reversed) and kept
  with the footage through every clip edit. Projects require `adjustments`: 0–1,024 items
  `{ id, start, duration, colour, keyframes }`, ascending, never overlapping, each grading
  **every video track** within `[start, start + duration)` with hard edges; 0–64 keys counted from
  the item start, always within its range (a move or trim that would leave one outside is
  refused), moving with it (`adjustment-range` `move`) or keeping their project frames (`stay`, a trim). Items never follow
  clips and never extend duration. Each source is graded by its clip grade, then the item at that
  project frame, in sequence (each stage clips and encodes; local tone summed once in the detail
  kernel). Static export requires no adjustments and unkeyed scalar clip grades without local
  tone, one LUT per clip. The **Colour** tab (Clip / Colour / Track / Audio) edits the grade of the
  clip or adjustment selected on the timeline (adjustments are drawn on the pinned adjustment track
  or added over the ruler range or the selected clip, deleted from its header); clip keys are amber
  markers inside clips; Copy/Paste grade in the clip and adjustment menus; Original with Shift/Alt
  bypasses only clip grades /
  adjustments. Colour and `layer-key-*` commands take `clipId` (`colour`: `clipIds`) or
  `adjustmentId`. No migration (owner, 2026-10-28): projects and receipt snapshots saved with track
  Colour are rejected with the reason and left unchanged. Items are on a pinned timeline lane (#287)
  and edited through MCP with the `adjustment-*` commands (#288); see [clip grades and adjustments](../docs/design/CLIP_GRADES_AND_ADJUSTMENTS.md) and
  [row appearance](../docs/design/ROW_APPEARANCE.md).
- Owner-approved #131: Transform is **track-owned, exactly like Colour**.
  Every video track requires strict `transform: { base, keyframes }`; clips have no
  `spatial` field. Nine complete pose values (#286: the eight geometry settings and
  **Opacity**, 0–1, neutral 1) and 0–256 ascending absolute project-frame
  keys `{ frame, values, easing, reset }`; each key enables any of the nine settings
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
  Exact neutral rendering (geometry only: Opacity never leaves it) preserves opaque black
  letterboxing after grading; nonneutral uncovered pixels are transparent. Track → Transform is collapsed by default, with a capture triangle and Previous/Next per setting,
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
- Grade **Shadows**, **Highlights** (−1…1), **HDR** (`colour.hdr` 0–1, keyframe channel `hdr`,
  an SDR local tone-mapping look) and **Local contrast** (`colour.localContrast` −1…1, channel
  `localContrast`, the local-detail boost split out of HDR, which keeps only its tone
  compression) are local tone settings: evaluated per grade (summed for the clip grade and the
  adjustment) but applied in the shared detail
  kernel on source taps before grading (Denoise → HDR/Local contrast → Shadows/Highlights →
  Clarity → Sharpen) from one guided edge-aware base,
  excluded from the per-pixel grade and LUT identity; any nonzero or keyed value needs
  composited export. Shadows/Highlights are linear-light gains in stops chosen by the base
  after Exposure. See [detail filters](../docs/design/DETAIL_FILTERS.md).
- **Opacity** (#67, moved into Transform by #286) is track coverage, not a clip setting or a
  grade: `transform.base.opacity` 0–1 (new tracks 1) and the nullable `opacity` setting of
  Transform keyframes, with its own Easing, edited in **Track → Transform** (UI 0–100%, storage
  0–1) like the other Transform settings. A default Transform keyframe and Reset transform return
  it to 1. Opacity alone never sends a group to the GPU export worker. Group composition is
  $C = \sum_i G_i b_i o_i w_i m_i$, $A = \sum_i o_i w_i m_i$,
  $\mathrm{result} = C + \mathrm{lower}(1 - A)$, evaluating the track's Opacity for each source
  (both dissolve sources) with no additional layer multiplier; $m_i$ is spatial source coverage,
  including opaque neutral letterboxing. Black fades never reduce that coverage. **Placement**
  contains placement only; Track options contains only rename, Ripple, ordering and deletion.
  Version-1 export receipts require strict current-schema snapshots and captured audio-source/
  instance-plan arrays; receipt, registry/proxy/PCM and benchmark format versions
  remain independent and unchanged.
  Reject and preserve projects/receipt snapshots older than the oldest supported
  schema (`OLDEST_PROJECT_SCHEMA_VERSION`), without automatic deletion.
- Owner-approved #135/#87: grade and Transform keyframes store one Easing per enabled
  setting (`easing` mirrors `values`); a joining setting adopts the Easing its keyframe's
  settings agree on, else Linear. Grade keyframes require boolean `reset`: a **default
  keyframe** (`reset: true`, created with all fourteen settings neutral and Hold Easing)
  never reaches back, so a setting whose first keyframe it is keeps its unkeyed value before
  it. Toggle **Add default keyframe** in the Colour keyframe line; amber filled marker.
  Transform keyframes carry the same `reset` flag (own toggle in the Transform line). See
  [layers/keyframes](../docs/LAYERS_AND_KEYFRAMES.md).
- Music is a required 0–8 array of independently identified music tracks, never null
  or singular. #203: like a video track, each owns gain, opening/closing fades, Ripple and
  1–8 clips joined by Cut / Crossfade (two linear fades over the overlap) / Fade through
  silence; export and preview flatten clips with `musicTracks()` into one source each.
  Duration is the maximum of all video and music OUTs. After the last
  active video, preview/export is opaque black while music continues to its own OUT;
  video fades remain inside their clips. Mix serially after per-clip gain/fades
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
