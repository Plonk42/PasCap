# Delivery status · 2026-10-04

## Implemented

The current UI update replaces **all nine inline help disclosures** with small
question-mark buttons and gives the existing Animation help the same hover/focus,
click-to-pin and Escape/outside-click contract. Explanations and numeric accessible
descriptions are retained. Help is beside the relevant heading, including collapsed
Inspector settings, Edit points, Placement & fades and Preview needs attention.
Expansion and help are independent native buttons; hidden content keeps its mounted
drafts. Editable sections, music/point/import controls and actual
storage/render/error details remain ordinary disclosures. This changes no persisted
schema, preview/native processing, source identity or rendering resource limits.

The preceding approved update added **precise clip-level speed curves**: editable presets,
source-frame/rate/easing fields, native graph/keyboard controls, source-preserving
live drafts and one Undo per completed gesture. Clip points remain independent
through trimming/splitting/duplication. Existing row Speed keeps its override
precedence, with explicit UI feedback; all row colour/opacity/key navigation remain.
The user also requested commits after each logical step, recorded in
[repository instructions](../.github/copilot-instructions.md).

The preceding UX-hardening update simplified the editor without removing features: **direct
panel/help controls, selection-first visual Inspector states, grouped responsive
timeline tools, visible Media Add/clear/mixed-selection feedback and quality cards
with export-space preflight/recovery**. It also fixes the deterministic raw-reader
exit race and splits preview/Inspector/Diagnostics loading without suppressing the
bundle warning. See [UX_HARDENING.md](UX_HARDENING.md) for identity and storage
assumptions, measured evidence and deferred relinking.

The previous update added **draggable shared row points and per-setting Previous/Next
navigation**. The service-side approved-root footage browser,
selective original-path registration, project-specific video/music bins and confirmed
document-only deletion remain; **strict schema 5 is unchanged**. The completed
982-test keyframe milestone, 886-test no-copy milestone, former 909-test copy-import baseline, schema-4
shared-keyframe/rush-cutting checks and prior v3 measurements below are historical
evidence. The current update's completed verification is separated below.

| Area | Delivery |
| --- | --- |
| Workspace | Direct panel/help controls, persisted pointer/keyboard resize, compact-window drawers, docked source/timeline tabs, source pinning and contextual options; deferred loading failures retain the editor with save-guarded reload/download |
| Projects | Search/filter/create/open/rename, empty new-project bins, confirmed document-only deletion preserving originals/cache/exports, explicit title drafts/autosave, URL/last-project restore, stale-revision rejection |
| Media | Project-specific video/music membership with timeline-reference union, shared content-deduplicated registry/proxy reuse, automatic proxy queue and explicit retries; compact list/grid, pinned repeated additions, sticky Add/count header, excerpt popup/reveal, reuse badges, source IN/OUT and original protection |
| Footage import | Default approved-root service browser, metadata-only one-folder reads, natural-sorted 2,000-entry cap/explicit truncation, selected original-path registration up to 5,000 paths, existing queue/partial errors; deliberate recursive folder form preserved, no footage copies |
| Timeline | Visible split/right-piece selection and quick trims, one-step marked-range cuts, primary ripple, recoverable trim headspace/autoscroll, contextual ghost/snaps, absolute overlays, duplicate/nudge/history; horizontal shared-point dragging with captured geometry/snap/autoscroll and reversible drafts |
| Layers | Up to eight, bottom-to-top composition, visibility/stack order, editable names, layer/clip opacity, independent placement and undoable layer deletion |
| Keyframes | Whole-row project-frame points, ten independent channels, shared easing to each channel's next participant, endpoint holds/static bases, 256 points maximum; drag/keyboard/list movement preserves all participants/easing in one Undo, collisions never merge/overwrite; footage edits never copy/shift points |
| Inspector | Clip/Sequence/Audio, compact hover/focus/pinned question-mark help, one Layer keyframes panel including empty rows, clickable hollow/filled diamonds immediately followed by always-present native SVG channel Previous/Next, explicit real-playhead capture/read-only animated values, chips/shared list, Enter/blur/Escape drafts and stable input identity |
| Navigation | Strict channel-participant neighbours including zero, shared editor-only stored-point cursor across setting/row/list/sidebar navigation, truthful clamped-preview labels, marker click/Enter and one-/ten-frame moves with focus/context isolation; existing timecode/help/divider/modal navigation |
| Colour | Independent static clip bases and seven independent row channels at project time, including held source frames; interpolate parameters before grading with unchanged CPU/GPU/65³ native LUT equations |
| Speed | 0.1×–8× constant/ramp/custom clip speed with 2–256 source-frame points, editable visual presets, exact fields and reversible graph gestures; overriding analytic row rates remain; layout/preview/native share `PlacedClip.retiming`, one duration rounding and repeat/drop mapping; timing conflicts reject the whole edit |
| Music | Standalone source registration, AAC proxy, bounded server waveform, placement/trim/gain/fades, explicit selected-range loop, Web Audio clock |
| Export | Original-based multi-layer 720p/4K SDR H.264, sampled animation/opacity, exact retiming/transitions, optional AAC, progress/cancel, receipts/full verification; native quality cards, metadata-only storage preflight, advisory allowance and owned-only ENOSPC/quota recovery |
| Activity | Nonmodal preparation/render queue/history, real progress/confirmed cancellation, retained accepted jobs through status errors, output/receipt links |
| Recovery | Bounded service startup/reads, preview/save retry, conflict/download/confirmed reload; shared-point Escape/pointercancel/lost capture/window blur restores preview/document/scroll without a draft save; no automatic overwrite/rebase or write retries |

Project **schema v5** requires `media: { videoIds, audioIds }`: two unique ID arrays,
at most 10,000 IDs each, explicitly empty for new projects. It retains static clip
colour/opacity/constant/ramp/custom speed, placement, complete layer point arrays and
music source bounds. Each layer point is
`{ frame, interpolation, values }`, with **all ten nullable fields required**, at
least one participant and unique ascending project frames. There is no clip
colour/opacity animation object. The existing required `speed` union now also
accepts explicit clip curve keys; valid constant/ramp values are unchanged, without
migration, optional legacy fields or defaulting. Earlier **v1/v2/v3/v4 projects and receipt snapshots**
remain incompatible and preserved: no migrations, compatibility fallback/default
local fields or history rewrite. Media registry entries and currently verified
ready proxies are reusable; create a new project and deliberately import its media.
Only that project's explicit membership plus clip/music references are visible,
not every global registry asset. Removing timeline excerpts does not remove imports.
Confirmed project deletion removes only its document, preserving originals, the
shared registry/proxy cache and successful exports/receipts. Old finished videos/
receipt files are not deleted or rewritten by the v5 archive loader; export receipt
format version 1 remains independent of its required schema-5 snapshot.

The non-browser fixture is **`preview-lab-v5`**; the isolated disposable browser
cache retains **`preview-lab`**, also strict v5, with all twelve registered video IDs
and registered music explicitly revision-saved in its bin after registrations.
Manual sample preparation targets only **`sample-taillefer-v5`**, reusing the already prepared first two Taillefer
recordings, and preserves older edits. **It has not been executed for this update
and must not be run without approval.** The live v3 sample appearing incompatible
is expected. Unsaved drafts remain in-memory until autosave succeeds or a snapshot
is downloaded; forced browser/laptop shutdown is not claimed to preserve them.
New measurements use **`preview-v5`** without replacing older reports; diagnostic
profile and reference receipt versions are independent of the project schema.

## Shared-point movement and channel-navigation contract

- Marker pointer capture snapshots the project, row/point, zoom, grabbed position,
  horizontal scroll and stationary playhead. Capture-relative travel is rounded
  once and bounded to **0–2,147,483,647**. Valid drafts preview live without changing
  the committed document/history/autosave; valid release moves every participant,
  value and existing easing in **one Undo step**.
- Snap uses captured clip/music/transition boundaries and playhead within eight
  pixels at the captured zoom; Alt bypasses it. Horizontal autoscroll retains that
  base geometry, without changing rows or automatic row reveal.
- Collisions **never merge or overwrite**. A red invalid ghost/release error leaves
  document/history unchanged, not at an earlier valid draft. Speed-related overlap,
  fade or transition conflicts reject the entire move, never shrink transitions.
  Escape, pointercancel, lost capture or window blur restores preview/document/scroll.
- Click/Enter selects a marker's row and seeks without editing. Focused Left/Right
  moves one project frame, Shift moves ten, with point/Timeline focus and shortcut
  isolation. Points can move beyond duration and remain stored/list-editable without
  extending the sequence merely for a marker; Speed may naturally recompile duration.
  Other row points, clip/source/static bases and music are not copied or shifted.
- All ten diamonds are immediately followed by native SVG Previous/Next buttons,
  before any existing reset. They remain visible, disabled without a peer/project
  or during any document-preview draft. Strict earlier/later neighbours require a non-null
  channel value, including zero; unrelated participation is skipped. Sidebar Layer
  opacity uses the same context, selects its own row and opens Clip without focus theft.
- A central editor-only inspection cursor is shared by setting, row, marker and
  list navigation, allowing successive off-duration points at one clamped preview
  frame. Labels distinguish stored time from actual preview; settings/diamonds still
  edit/capture at the **real playhead**. Manual seek/playback/row/project changes and
  deletion of the inspected point clear inspection; a valid point move/Undo retains
  it and list input identity. Navigation does not save or create history.

This is still one shared point list and strict schema 5, with no migration,
persisted inspection/point-ID fields, toolchain or native pipeline changes.
Usage: [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md),
[TIMELINE_EDITING.md](TIMELINE_EDITING.md) and
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).

## Current heading-help verification

The title-placement refinement is tracked in
[#16](https://github.com/Plonk42/PasCap/issues/16), with the first local step in
`7dd6abd`. Inspector Source range, Layer & opacity, Speed, Colour, Transition and
Sequence fades have independent section/help buttons in the same heading row.
Shared-point timing is beside Edit points, audio timing beside Placement & fades,
and startup diagnostics beside Preview needs attention; Animation remains beside
Layer keyframes. Collapsed content remains mounted, preserving drafts and numeric
descriptions, while its help stays reachable without opening the settings.

**2026-10-04 local evidence:** complete unit/service checks **886 pass**, strict
frontend/server types and production build pass; focused help/input checks **48 pass**
(39 help workflows, including 11 new placement/keyboard/draft/compact cases, plus
nine retained numeric cases). The complete retained browser suite **224 passes**;
the fresh distinct total is **1,110** (886 unit/service + 224 browser), with no
historical native results included. Entry JS is **480.75 kB / 145.07 kB gzip**,
with Inspector **49.83 / 14.36** deferred and the warning threshold unchanged.
Native/media tests are not rerun for this UI-only refinement. The preceding full
1,099-test help result below remains separate evidence, not a new native or CI pass.

An isolated 1440×900 synthetic/memory-only visual check verified a 270 px Inspector
with all four Clip headings collapsed, adjacent 24 px help controls and pinned
Speed help without expanding settings, changing the exact document or writing.
The owner page was untouched. Types, current IDE diagnostics, dependency audit and
source/documentation hygiene passed; remote CI and hardware qualification are not
claimed by these local checks.

The retained clip-speed compact-window test now waits for the actual one-drawer
resize state before opening Inspector; an immediate visibility check could race
that React transition and close the drawer again. Exact 24 px point targets,
270 px/720 px bounds, overflow and unchanged-document assertions remain intact;
there is no timeout increase, retry or weakened correctness check.

## Current help-popover verification

**Historical 1,099-test evidence for the preceding help-interaction update; title
placement is verified separately above.** Verification used isolated disposable synthetic
media and memory-only projects; no owner project/original is edited, imported, prepared
or rendered. [#16](https://github.com/Plonk42/PasCap/issues/16) tracks the explicitly
approved scope recorded in the [legacy delivery checkpoint #15](https://github.com/Plonk42/PasCap/issues/15).
Current scheduling follows [the GitHub workflow](GITHUB_WORKFLOW.md): native
Project Iteration fields for agreed timeboxes, or selected-work views without a
cadence, never new sprint-tracker issues. Existing checkpoint history is preserved.

| Check | Result |
| --- | --- |
| Complete unit/service check | **886 pass** on Node **22.23.3**, including ten new viewport-placement cases |
| Strict frontend/server types and production build | **Pass** |
| Full retained browser suite | **213 pass**, including all **28** new help workflows |
| Combined fresh distinct checks | **1,099 pass** (886 unit/service + 213 browser); no prior native results added to this total |
| Native/media qualification | **Not rerun for this UI-only change**; the prior 54-test native/private-tmpfs result below remains historical |
| Production entry JS | **479.80 kB / 144.80 kB gzip**, Inspector **50.08 / 14.34** deferred; unchanged 500 kB warning threshold |

Coverage includes all ten help contexts (nine replaced disclosures plus Animation),
hover without focus theft, pointer travel into text, click/Enter/Space pinning,
Escape-first invalid-input isolation, outside-click focus, single-help coordination,
hidden owners, keyboard-readable/scrollable text and touch. An outside pointer press
dismisses help before a resize control captures the gesture, so Escape still restores
its original size without saving the preference. Hover activation is confined to the
compact help owner, not empty space across its section. Numeric descriptions
remain readable while help is hidden. Compact 24 px targets and viewport bounds
are checked at 640/720/1024/1440 px, including a short 480 px-high viewport.

The completed-click focus path retains the normal single blur commit: removing
a pending number-field hint cannot move the button between pointerdown and mouseup
and accidentally lose the click. No help hover, pin or dismissal adds its own
history/save operation. Options remain click-only; functional point/music/source
and storage/render disclosures remain usable. No skips, retries or weakened
pixel/frame/resource assertions were introduced. These local UI checks do not
relabel the earlier 1,115-test core/native baseline or qualify hardware, long
flights, fresh remote CI or containers.

## Current clip-speed verification

**Historical 1,115-test evidence for the completed clip-speed update, preceding
the help-only UI change above.** All checks used
disposable synthetic sources or memory-only projects; no owner footage/project
was imported, prepared, edited or rendered.

| Check | Result |
| --- | --- |
| Unit/service | **876 pass** on both Node **22.23.3 and 24.21.0**; 56 new clip-speed/compiler/geometry cases |
| Strict frontend/server typechecks and production build | **Pass** |
| Full browser | **185 pass**, including 17 new clip-curve workflows |
| Opt-in native/media + private tmpfs acceptance | **54 pass**, including three new clip-curve parity cases and the separately enabled genuine ENOSPC test |
| Combined distinct tests | **1,115 pass**; Node-version repetitions are not counted twice |
| Dependency audit | **Zero vulnerabilities** |
| IDE diagnostics | **No reported issues** after fresh production/test/CSS analysis; no new suppressions/exclusions |
| Source/docs hygiene | Feature whitespace and local documentation links checked |
| Production entry JS | **475.73 kB / 143.83 kB gzip**, with Inspector **50.38 / 14.36** deferred; no 500 kB warning or raised threshold |

The 41 shared-speed cases and 15 graph/transaction cases verify strict 2–256
source-frame points, original/exclusive-OUT bounds, endpoint holds, exact
held/linear integration, bounded eased integration and immutable O(points) maps.
They retain one-frame holds in long recordings, independent trim/split/cut/duplicate
anchors, old constant/ramp behaviour, row override/restoration and atomic timing
rejection. Layout, preview, inverse queries and native rendering still consume
the same authoritative retiming map; row Speed's project-time integral is unchanged.

The new browser workflows verify five editable visual presets, exact numeric
frame/rate/easing drafts and decimal-preserving keyboard nudges, explicit
Add/Delete/navigation, stable focus through reordering/Undo and saved reload.
Native pointer gestures preview without saving and commit once on valid release;
collision/fade conflicts reject the whole release, never a last-valid draft.
Escape, pointer cancellation, capture loss and window blur restore the original
document/preview. Source-key navigation finds an exact rendered image when
available or the closest sampled image when skipped, with the exclusive OUT
previewing the last output frame. Stored points never move merely to match a
preview. Existing all-ten-channel navigation and two-decoder assertions remain;
the **270 px Inspector / 720 px drawer** checks retain accessible 24 px point targets.

The three new native cases compare **every output frame** with the shared map and
CPU composite: 65-frame static 720p curves/dissolve maximum RGB MAE **2.4444/255**,
15-frame layered 720p/custom-base/row-override **3.6667/255**, and genuine three-frame
4K custom speed **1.3333/255**. The **<4/255** gate, exact frame counts, original
identity/bytes, immutable receipts and decoder/buffer/resource assertions are
unchanged. These cases use temporary frame-coded originals without preparing proxies.

An isolated 1440×900 visual review used an existing synthetic proxy and memory-only
project routes, with **zero saves/imports/preparations/renders**. It did not exercise
the owner's open project. The browser renderer remains SwiftShader: short preview
and 4K correctness are not intended-GPU, long-flight or long-run A/V qualification.
The changed entry/chunk graph is a measured build result, not a total-download or
playback-performance claim; the older UX-hardening bundle measurements below remain
historical. No push, new remote CI result, release or issue closure is claimed.

Usage and source-time versus row-time semantics: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md)
and [USER_GUIDE.md](USER_GUIDE.md). The approved scope and logical-step commit policy
are recorded in [the implementation plan](../EDITOR_IMPLEMENTATION_PLAN.md#23-approved-precise-clip-speed-curves--2026-10-04)
and [repository instructions](../.github/copilot-instructions.md).

## Current UX-hardening verification

**Historical 1,039-test evidence, preceding the clip-speed update.** The latest
clip-speed verification is recorded separately; these entry sizes/counts remain
the evidence for the earlier logical step.

The final run used only disposable synthetic or memory-only projects:

| Check | Result |
| --- | --- |
| Unit/service | **820 pass**; complete suites also pass on Node **22.23.3 and 24.21.0**, with independent focused reader repetitions |
| Strict frontend/server typechecks and production build | **Pass** |
| Full browser | **168 pass**, including 17 new visual/control/storage/loading-recovery workflows |
| Opt-in native/media + private tmpfs acceptance | **51 pass**, including genuine native ENOSPC preserving a completed export, saved project and original |
| Combined distinct tests | **1,039 pass** |
| Dependency audit | **Zero vulnerabilities** |
| IDE diagnostics | **No reported issues**; no new suppressions/exclusions |
| Source/docs hygiene | **54 changed/existing-user files whitespace-clean; 147 local documentation links resolve** |
| Production entry JS | **370.62 kB / 113.88 kB gzip**, previously 535.03 / 161.17; no 500 kB warning or raised threshold |

The 39 additional unit/service cases cover read-only preflight/strict client
contracts, duration/profile/row/music allowances, actual output-volume/symlink
guards, no-space rejection and native/filesystem/quota cleanup; they also prove
the sampled identity limitation and eager bounded raw-reader ownership. The
deterministic right-close-before-first-read test fails on the previous code and
passes with exact EOF/frame/process/backpressure/cancellation checks intact.

Browser coverage retains every existing editing workflow, all ten channel controls,
pointer movement/cancellation, native Tab/reset order, preferences, history and
two-decoder checks. New cases exercise direct panels/help, mixed selection and
filter/search clearing, visual static/animated capture, section state, 640–1440 px
timeline/music hit targets, radio/meter keyboard access, explicit storage error/
blocked/tight/stale-read recovery, failed module containment, save-before-reload,
failed-save download and genuinely deferred diagnostics.

Native evidence includes actual 32 MiB private tmpfs exhaustion plus allocated-file
scratch observations at progress callbacks. Those observations exclude directory
metadata and between-sample peaks; the allowance is not a codec bound. Short
native/SwiftShader correctness is not long-4K or intended-GPU qualification.
No real user project, import, preparation, render or original mutation was used.
The live Export dialog was inspected and cancelled without submitting a render;
its preflight reads only filesystem/registered metadata. A development-service
restart was recovered through read-only connection retry.

Relinking (#2) remains explicitly pending strong identity/stable-cache design;
licensing, real-workload/hardware, fresh remote CI and container gates are not
declared complete. The detailed [hardening record](UX_HARDENING.md) separates them
from the locally verified changes.

## Current keyframe-update verification

**Historical 982-test evidence, preceding the UX-hardening verification above.**

The final pass used only disposable synthetic or memory-only projects:

| Check | Result |
| --- | --- |
| Unit/service | **781 pass**, including 40 new navigation + 20 new drag-planning cases |
| Strict frontend/server typechecks and production build | **Pass** |
| Browser | **151 pass**, including 21 navigation + 15 marker-movement workflows |
| Opt-in native/media | **50 pass** |
| Combined total | **982 passing tests** |
| Dependency audit | **Zero vulnerabilities** |
| SonarQube for IDE | **No reported issues** after changed production/test/CSS analysis; no new suppressions/exclusions |
| Source/docs hygiene | **162 files clean; 62 local documentation links valid** |
| Production entry JS | **535.03 kB / 161.17 kB gzip**; existing 500 kB warning remains visible |

Coverage includes whole-point values/easing, validated preview-only drafts,
one Undo/save/reload, collision recovery without merge/last-valid commit, Speed
duration/timing rejection, snap/Alt/captured-playhead geometry, horizontal autoscroll,
Escape/pointercancel/lost capture/window blur, empty rows, off-duration movement,
click/Enter/arrow focus and shortcut isolation. Channel-navigation coverage includes
all ten settings, zero/unrelated participation, visible disabled states, native
Tab order/reset placement, sidebar row selection without focus theft, successive
off-duration/empty-timeline inspection, real-playhead values/capture, cursor cleanup,
move/Undo input identity, and the **270 px inspector / 720 px drawer**. Final runtime
checks also retain numeric time-field playhead/Undo behaviour, correct click-only
marker seeking after draft restoration, and valid destination seeking when a moved
Speed point extends past the old preview duration. Concurrent clip/transition/trim/
music interactions are blocked during marker capture; the active gesture remains
captured and reversible. The full browser suite was run from a clean dedicated
fixture cache, keeping its deliberate twelve-recording bin independent of other
synthetic registrations made in earlier focused runs.

The earlier **886-test** no-copy pass and all older milestones below retain their
original evidence rather than being relabelled. An intermediate unchanged raw-pipe
unit test reported a short reader once; the final complete check passed without
raw-process changes or weaker frame assertions. No real user project, recording,
import, preparation, export or saved-document mutation was used for verification.
The visible shared page's adjacent navigation icons were inspected without any
editing/seek action; an empty development HMR stylesheet was refreshed, leaving
the saved project unchanged. Final button-outline styling was revalidated with
all 36 new browser workflows passing after the final production build.

## No-copy footage contract

- `ServiceConfig.mediaRoots` / `PASCAP_MEDIA_ROOTS`: JSON array of at most 32 unique
  absolute roots, default only the service user's `~/Videos`; `[]` disables browsing.
  Missing/unreadable roots are visible as unavailable, not a startup failure.
- `GET /api/footage/roots` lists roots/availability. `GET /api/footage?rootId=root-0&directory=%2Fmedia%2Ffootage%2FFlight`
  lists one folder inside the selected root; the optional directory is an encoded
  absolute service-side path. GET browsing reads metadata only, never media bytes,
  probes, recursive import, writes or job admission. The cache branch is excluded,
  folders sort first naturally, and the 2,000-entry cap explicitly asks users to
  choose a narrower folder when truncated.
- `POST /api/media/register-paths` accepts JSON `{"paths":["/media/footage/Flight/DJI_0001.MP4"]}`,
  1–5,000 absolute selected video paths inside approved roots. Explicit registration
  uses read-only original fingerprint/probe checks, the existing queue and partial
  source/queue errors. Ready/in-flight preparation is reused; browsing alone starts
  nothing, and failed/cancelled/interrupted work needs explicit retry.
- The absolute-folder-path form remains a deliberate recursive whole-folder action,
  including outside approved browser roots. It can autoqueue substantial work only
  on explicit submission and never silently adds a root. Local HTTP Host/Origin/
  client guards and source symlink checks remain intact. Manual video HTTP imports
  still reject the cache and its generated-data descendants as original footage.
- No upload endpoint, browser file picker, optional copy flow or true external
  desktop drag-and-drop import remains. External file/folder drops block navigation
  and show Import guidance without a POST; internal ready-Media-to-Timeline dragging
  is preserved. Standalone music still uses Audio.
- Imports reference originals; only generated proxies/thumbnails, metadata,
  exports/receipts and scratch are created, never duplicate originals. Original
  paths must stay accessible; moving files or disconnecting drives fails explicitly,
  with no implicit guessing/reassociation. An explicit relink workflow is pending.
- Previously copied sources from the removed implementation are not automatically
  deleted or migrated. Preserve their registered paths and bytes while referenced;
  this is data safety, not compatibility code. No schema bump or migration is added.

Usage: [TIMELINE_EDITING.md](TIMELINE_EDITING.md). Service configuration and future
container path/permission requirements: [DEPLOYMENT.md](DEPLOYMENT.md).

## PRIOR no-copy schema-5 milestone — HISTORICAL verification evidence (886 tests)

The completed no-copy pass used only disposable synthetic or memory-only projects.
**Every result here is historical milestone evidence preceding the current keyframe
update, not its final verification.** The approved-root browser/selective-registration
coverage is retained rather than discarded or relabelled as new movement/navigation work:

| Check | Result |
| --- | --- |
| Unit/service | **721 pass** |
| Strict frontend/server typecheck and production build | **Pass** |
| Browser | **115 pass** |
| Opt-in native/media | **50 pass** |
| Combined total | **886 passing tests** |
| Dependency audit | **Zero vulnerabilities**; multipart dependency removed |
| SonarQube for IDE | **No reported issues** after changed production/test/script files were analysed; no new suppressions/exclusions |
| Source/docs hygiene | **155 files clean; 59 local documentation links valid**; copy-import removal scan clean |
| Production entry JS | **526.51 kB / 158.71 kB gzip**; existing 500 kB warning remains visible |

Coverage includes **46 new no-copy unit/service cases**, JSON-only client contracts,
**10 replacement browser workflows** and two replacement native tests. Approved-root
configuration/default/disable/unavailable cases, metadata-only reads, natural sort,
bounded truncation/warnings, traversal/symlink/cache/HTTP guards, selective serial
registration and source/queue partial errors pass. Read-only native originals keep
their source paths, bytes, size, modification time, device/inode and permissions;
verified proxies are reused during repeated registration and after service restart.
Cache-adjacent selected files remain usable, recursive folder safety stays intact,
and manual HTTP imports cannot register generated cache descendants as originals.

Browser checks cover path-only JSON requests, no implicit import from browsing or
selection, folder/root/filter/cross-folder selection, stale-read cancellation,
explicit refresh/error recovery, unavailable-root guidance, partial queue/probe
failures, save/reload/project membership, native desktop-drop rejection without POST
or navigation, and compact layout. Existing internal Media-to-Timeline drag/edit,
history, projects, source review and native export/frame/colour assertions remain.
The upload route, copy receiver, multipart client/parser dependency and OS file
picker are absent. Removed-feature tests were not included in that milestone's total;
the former 909-test baseline remains historical rather than being relabelled.

At that milestone, the shared live page's new import dialog was visually inspected
and closed without selecting/registering a source, reading footage bytes or changing
the project.
No real user footage was copied, imported, prepared, rendered, deleted or migrated.
Docker/Podman targeting and outstanding container acceptance gates are documented
in [DEPLOYMENT.md](DEPLOYMENT.md); no image/container qualification is claimed.

## PRIOR schema-5 baseline — HISTORICAL former file-import validation (909 tests)

The former implementation's completed pass used only disposable synthetic or
memory-only projects. **Every result below is historical, not a current no-copy
validation result.** The total includes coverage of the removed copy-import feature.

| Check | Result |
| --- | --- |
| Unit/service | **744 pass** |
| Strict frontend/server typecheck and production build | **Pass** |
| Browser | **115 pass** |
| Opt-in native/media | **50 pass** |
| Combined total | **909 passing tests** |
| Dependency audit | **Zero vulnerabilities** |
| SonarQube for IDE | **No reported issues** after changed production files were analysed; no new suppressions/exclusions |
| Source/docs hygiene | **154 source/test/doc files clean; 44 local documentation links valid** |
| Production entry JS | **530.08 kB / 159.73 kB gzip**; existing 500 kB warning remains visible |

At that milestone, coverage verified empty video/audio bins on creation/reload,
imported unused sources, prepared-proxy reuse without a second preparation request, independent
project switching, membership after excerpt deletion, and audio imports without
assigning music. Project deletion covered explicit confirmation/cancel/focus,
dirty-document flush/close, decoder/history/preference cleanup, failure
retention, revision conflicts, stale-tab save rejection, and explicit deletion of
unsupported regular files without opening/migrating them. Filesystem/request
guards preserved originals, registry/proxies and successful exports. Genuine
incompatible schema-4 inputs omitted `media`; v1/v2/v3 cases were retained. Nested
confirmation restored focus to the still-open parent dialog, and duplicate project
titles were selected by ID in repeatable browser CRUD tests. These results do not
substitute for rerunning the retained behaviours against the no-copy replacement.
No real sample preparation, import, render or measurement was run for that milestone.

## PRIOR V4 milestone — historical verification evidence (807 tests)

The last completed schema-4 checks used disposable synthetic or memory-only projects:

| Check | Result |
| --- | --- |
| Unit/service | **661 pass** |
| Strict frontend/server typecheck and production build | **Pass** |
| Browser | **98 pass** |
| Opt-in native/media | **48 pass** |
| Combined total | **807 passing tests** |
| Dependency audit | **Zero vulnerabilities** |
| SonarQube for IDE | **No reported issues after fresh source/script/test analysis**; no new suppressions, rule disabling or analysis exclusions |
| Source/docs hygiene | **159 new-file whitespace checks clean; 47 local documentation links valid** |
| Production entry JS | **521.03 kB / 157.10 kB gzip**; Vite's 500 kB warning remains visible, not suppressed |

Source review and infrequent dialogs remain lazy-loaded. The larger shared-point
editor was included in that entry chunk; a build-size warning is not a GPU
performance result. Pixel/frame-count/resource/cancellation assertions were retained.

That schema-4 pass's verified regression coverage:

- **102 rush-editing unit cases**, five new shortcut cases and **13 browser rush
  workflows**: several independent excerpts from one source, pinned Add/range/frame
  retention, reuse counts/list/reveal, compact sticky-header reachability and
  popup Escape/outside-click, right-piece selection, mapped quick trims and source
  restoration, marked prefix/middle/suffix/whole removal in one Undo step, source/form
  shortcut isolation, transient marks without writes, real reordered ripple ghosts
  and long first-head autoscroll/start-origin/cancellation. Row keys/music/overlays
  stay fixed and incompatible fade/overlap edits are atomic.
- A new short **17-frame native cut-output case** checks every output image against
  the shared mapped source/grade, confirms the removed original interval is absent,
  retains independent recoverable pieces/receipt state, excludes original audio,
  requires no proxy and preserves original fingerprints/saved fixture bytes.
- Strict point shape/limits, independent participation and interpolation, static
  bases, project-time grade/opacity changes on held source frames, analytic row-rate
  integrals/inverse/discrete mapping and contextual layout/transition/overlap bounds.
- Hollow/filled diamond ARIA and first/last participant behavior; no implicit keys;
  empty-row context; dependencies/chips/single row markers; atomic shared time edits,
  collision drafts/focus/Undo, outside-duration list editing and closest-preview
  navigation without moving points.
- Trim/move/split/duplicate anchor independence, original-source static ramps,
  contextual ghost/snapping/end solving, OUT-preserving overlay trims and explicit
  unrepresentable-quantisation rejection, strict save/reload and old-data preservation.
- Native contextual `PlacedClip.retiming` parity for row easing/rates, project-time
  sampled composition, invalid supplied maps, cancellation, storage/archive preservation
  and unchanged original/media/audio/resource-bound regressions.
- Quality cleanup preserves serial media admission, source traversal/fingerprints,
  thumbnails, measurements, queue settlement and revisioned autosave through bounded
  serial helpers. New tests cover iteration/order/error cleanup, cancellation and
  final-drain submissions, stable fingerprint bytes and NaN/infinity rejection.
- Keyboard events belong to focusable controls; pane resizing exposes a numeric
  slider role, timecode focus follows explicit user activation, source shortcuts
  remain isolated, and waveform keys use stable positions. Browser resize/focus/
  draft/cancellation checks and all native frame/pixel assertions still pass.
- Stale SonarJS TypeScript-program caches were rebuilt by restarting only the
  managed analysis subprocess, not the editor or media service. This is local IDE
  analysis evidence, not a remote SonarQube Server/Cloud quality-gate claim.
- An isolated 1440×900 visual review used an in-memory v4 document and already
  prepared Taillefer proxies. Its diamond joined Saturation to the existing point
  without a second marker; participants/ARIA, decoded paused preview, and no error
  or unowned API request were checked. Project writes were intercepted in memory.
  This used SwiftShader for correctness, not intended-GPU performance certification.
- Read-only real-service checks confirm the old v3 sample is preserved/incompatible
  and no preparation/render jobs are active. The shared page was returned to its
  original URL with temporary routes removed; no v4 real-media sample was generated.

That rush-priority update kept strict schema 4 and the existing renderer/resource
contracts. Frequent actions share the existing responsive timeline toolbar rather
than consuming a second desktop action row. The source's excerpt list uses the
native nonmodal top layer and Add remains in its sticky header. Earlier **686-test**
Sonar cleanup and **661-test** row-key milestones preceded that 807-test result.

Only disposable synthetic or memory-only tests are authorised for this pass.
Intended-GPU/long-flight validation remains deferred; no additional real preparation,
library reimport, native render or soundtrack reuse has been approved.

## PRIOR V3 milestone — historical verification evidence (558 tests)

**Everything in this section is prior v3 evidence, not current schema-5 results.**

- At that milestone, **448 unit/service tests, 34 opt-in native-media tests and 76
  browser tests passed (558 total)**; strict typecheck/build and full dependency audit
  passed (zero vulnerabilities). Tracked/new-file whitespace checks were clean.
  Validation commands remain in [../README.md](../README.md).
- Strict TypeScript and compiled browser/server builds pass.
- Shared/model/service tests cover retiming curves, output-duration overlap bounds,
  source recovery, commands/history, music envelopes/loops, snapping, revision
  conflict handling, incompatible project preservation, file safety and export plans;
  layer allocation/order/overlap/placement, keyed interpolation and source-choice bounds.
  Added API deadlines/response classification, serial save retry/conflict behavior,
  service startup budgets/cancellation, editor number/timecode/size/preferences,
  activity ordering and keyboard mapping tests pass.
- Automatic-proxy tests cover concurrent registration/preparation deduplication,
  serial admission, ready/active reuse, explicit failed/cancelled retry, partial
  probe/queue errors, source identity changes and symlink-safe cache outputs.
  Two native import cases use disposable 12-frame 160×90 sources, not real footage.
- Browser tests exercise an isolated 12-recording library; project switching with
  unsaved edits; pointer trims/cancellation; speed-aware splits; each ramp curve;
  independent grading; waveform movement; music looping/fades/gain; repeated
  ramp-up/down playback through dissolves; simultaneous primary dissolve/upper-layer
  keyed playback with music; overlay pointer/keyboard trims, scrolled cross-layer
  dragging; key edits outside trimmed/fast-sampled ranges; hover source review,
  pre-trim insertion/reload/project isolation; collapse state; and short layered exports.
- UX tests also cover explicit numeric/title commits and invalid drafts; preserved
  key-row focus after time edits/undo/selection; source pinning; responsive widths
  **1440/1280/1024/900/720** with no document overflow; divider cancel/persistence;
  modal focus/context; save conflict download/confirmed reload; unavailable service/
  browser storage; partial import reporting; and accepted/rejected export responses
  without automatic duplicate POSTs. These use memory-only API fixtures.
- Nine editing-basics browser cases also cover compact default contexts/menus,
  real native clip drags preserving grabbed offset, exact snap/Alt/self-exclusion,
  invalid/cancelled placement, cross-row primary ripple ghosts, pre-trimmed media
  overlay ghosts, duplication/nudge keyboard contexts, layer rename and accepted
  automatic-queue imports with partial errors. Preview and commit assertions use
  actual stored/layout frames, not a cosmetic marker check.
- Infrequently used dialogs and source review were loaded on demand in v3; prior
  schema-4 production chunk/gzip measurements are reported separately above.
- Opt-in native tests cover one/few/many-clip cuts/fades/dissolves, all ramp curves
  in both directions and slow/fast rates with **every output frame** compared against
  the shared source map/CPU grade. The measured 168-frame pattern's maximum mean
  absolute error was **3.302/255** (threshold <4/255).
- Native music tests compare PCM envelopes and selected-range tone identity, AAC
  placement/duration and silence padding; mono is duplicated without 3 dB attenuation.
- Genuine **3840×2160** three-frame output passes dimensions/codec/SDR/frame-count,
  colour and one-frame black-fade tests. This is not a long 4K throughput result.
- Layered native tests compare every frame against the shared sampled CPU composite:
  compound keyed 24-frame edit maximum MAE **2.5825/255**, eight-layer pattern
  **2.8577/255**, genuine three-layer UHD **1.9006/255**, and UHD-to-720p graded
  composition **2.2672/255**. Lossless RGBA16 RGB error was **0.00192/255** with
  coverage assertions before H.264; sampled float-LUT MAE was **0.0689/255**.
- Thirty-two GPU group-composition cases pass CPU comparisons (MAE **0.315/255**,
  maximum **1.307/255**) in correctness-only SwiftShader. These figures are not
  target-GPU playback or colour-conversion certification.
- Read-only checks during the prior v3 milestone also sought/captured the prepared real Taillefer
  proxies at project frames **0, 60, 165, 210 and 329**, preserving the saved document.
  No additional source preparation, real native render or playback benchmark was
  started; this visible-page check also used SwiftShader.
- Cancellation/error tests remove all owned scratch and preserve successful outputs
  and the user's saved edit. A live browser export verifies output and receipt HTTP
  routes and range serving.

Tests use disposable synthetic media/projects, never write into original recording
directories, and do not reuse licensed/reference soundtrack material.

## Resource contract

Preview has a reusable pool: two decoder/texture slots for one nonempty layer,
up to nine for eight layers, plus at most one separate visible source-review decoder.
Inactive sources are reused/released, never allocated per stored clip.

Export reads one original at a time through the shared backpressured frame mapper.
The plain static single-layer path retains at most two lossless clips, two intermediate
decoders and one reusable RGB frame (**24.9 MB UHD**), plus native memory.

Any shared row point, including Speed-only or neutral-valued points, forces layered
dispatch; the static plan explicitly rejects it. Layers/nontrivial opacity/row points
use the unchanged sequential premultiplied RGBA16 composition: at most one original
decoder, two intermediate readers, one encoder
and three native video children per pass. Three reusable raw buffers total
**116,121,600 bytes UHD (116.1 MB)**. Two reusable 65³ Float32 LUTs add **6,591,000
bytes (6.6 MB)**. Native codec/filter/pipe buffers and selected audio PCM are additional.
Grades are generated from the evaluated parameters, not crossfaded endpoint LUTs;
there are no per-frame LUT files or per-frame native-process launches.
Source mapping is the layout's captured `PlacedClip.retiming`; grade/opacity sampling
uses the absolute project frame, including repeated source images. Primary dissolve
grouping and layer opacity after the group remain unchanged.

At most two lossless clip files and two complete timeline representations coexist
(a span collection counts as one). Layer accumulators are joined/deleted between
passes; final H.264 is encoded once. Selected PCM and the final MP4 remain through
verification. Scratch scales with these duration-dependent representations, not
with simultaneously decoded originals. This is bounded concurrency, **not a fixed
memory/disk-in-GB promise**. Long 4K or slow-motion edits may need substantial disk.

Animated LUT generation and CPU pixel passes can be slow. In the **prior v3**
milestone, a scoped three-frame, three-layer UHD test took approximately
**11.9 seconds end-to-end**; it is evidence
of that version's short correctness run, not schema-5 parity or long-render throughput
certification. Interrupted jobs are not resumed; owned failed/cancelled scratch is
removed and prior successes are preserved.

## Local container deployment — planned, not implemented

The approved eventual target is a **local Docker/Podman OCI application**, not
GitHub Pages or remote SaaS. Packaging is not implemented: no image or runnable
container recipe is claimed. The plan is one Node + FFmpeg/ffprobe + built-UI
container, host-browser GPU use, read-only original-source mounts, separate
read/write persistent data and accessible exports. Stable paths, non-root/rootless
permissions, SELinux cautions, future internal bind-address configuration with
host-loopback-only publishing, exact HTTP guards, SIGTERM/child reaping and native
toolchain parity are specified in [DEPLOYMENT.md](DEPLOYMENT.md). Both Docker and
Podman need future build/read-only-mount integration acceptance; no container GPU
or encoder-performance claim is made.

## Acceptance still pending

1. Fresh remote-runner evidence for the locally diagnosed/fixed raw-frame reader
   EOF remains pending after publication; see [#1](https://github.com/Plonk42/PasCap/issues/1).
   The deterministic local regression and completed current correctness suites are
   recorded above, not inferred from older 886/909-test milestones. The issue is
   not automatically closed by a local commit.
2. GPU-capable external browser checks for full-rate preview, responsive scrubbing,
   keyed layered/ramp/dissolve playback and long-run memory. Intel embedded/SwiftShader
   test speed is not an acceptance verdict.
3. An actual 5–10 minute flight edit with explicitly licensed music: save/reopen,
   complete preview, 720p draft and 4K final verification, source interruption and
   scratch-resource observation. The user explicitly chose to leave this long-flight
   validation for later; no additional footage preparation or long render was started.
4. Long-run A/V drift and audible loop/buffer behaviour on that browser. The current
   media-element preview re-seeks at a selected-range loop boundary and pauses audio/
   video together; gapless browser loop joins are not promised. Final PCM/AAC export
  loops/timing have historical disposable native evidence above, not final current
  update qualification; long-flight and intended-GPU checks remain separate pending gates.
5. Eventual Docker **and** Podman build, read-only-mount, persistent-data, permissions,
   networking, shutdown and native-toolchain parity acceptance in
   [DEPLOYMENT.md](DEPLOYMENT.md). Packaging has not been implemented or tested now.

Current correctness/hardware gates and future packaging work are explicitly separate;
none is claimed complete by historical evidence. The implemented extensions are specified in
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md) and the current UX/recovery contract
in [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md). Limits: eight layers, primary-only
boundary transitions, no same-overlay-row overlap, and browser-local media pre-trim
choices. Shared-point dragging/keyboard/time-field editing is implemented; collisions
remain rejected and off-duration points do not extend the sequence merely for a
marker. Optical flow, titles/transforms/masks and other excluded effects
remain out of scope. Local container packaging is approved future work, not a current
implementation; explicit source relinking also remains pending.

## Repository publication and continuous integration

The repository landing page is now concise; detailed end-user and contributor
material is organized in [USER_GUIDE.md](USER_GUIDE.md),
[DEVELOPMENT.md](DEVELOPMENT.md) and [the documentation index](README.md).
Personal default source paths were removed from the opt-in sample helper and
redacted in the retained design history; no original media or local cache belongs
in the initial commit.

The [GitHub Actions workflow](../.github/workflows/ci.yml) checks Node 22/24 types,
unit/service tests, builds and audit. A separate integration job builds/verifies
checksum-pinned FFmpeg 8.0.1, prepares only isolated synthetic fixtures, and runs
native/media plus Chrome tests. Workflow actions are commit-pinned, permissions
are read-only, and failure diagnostics have bounded retention. Actionlint and shell
syntax validation pass; the first actual remote CI result remains separate from
the already recorded local correctness runs.

The initial [CI run](https://github.com/Plonk42/PasCap/actions/runs/37162081461)
passed both Node 22/24 checks and all 50 native tests on the source-built FFmpeg
toolchain. Browser results were 150/151: the three-recording playback completion
check reached frame 92 of 144 before its 15-second deadline. Trace screenshots show
continued progress (20 → 37 → 81), not evidence of a frozen third decoder. The
correctness check now allows a bounded 45-second completion wait within 60 seconds
and records renderer/decoder diagnostics; exact end frame, failure and two-element
ownership assertions remain unchanged. No test retry or GPU-performance claim was
added. The follow-up CI result must be verified separately.

**2026-10-04 read-only remote inspection:** the more recent
[run 37183854541](https://github.com/Plonk42/PasCap/actions/runs/37183854541) on
publication commit `6d260c5` passed Node 22 and the native/browser job, but Node 24
failed the exact right-reader SOURCE OUT case tracked in #1. That run predates
local fix `48b4de9` and all clip-speed commits; it is not evidence against the
new deterministic fix or a passing current-delivery CI claim. Fresh CI containing
those commits still requires an explicitly approved push. Older run descriptions
above remain historical evidence, not current results.

The GitHub workflow alignment retains the eleven original issues and adds
[workflow #12](https://github.com/Plonk42/PasCap/issues/12), retrospective
[shared-point delivery #13](https://github.com/Plonk42/PasCap/issues/13),
[clip-speed delivery #14](https://github.com/Plonk42/PasCap/issues/14) and
[iteration #15](https://github.com/Plonk42/PasCap/issues/15). At that initial workflow
checkpoint, all fifteen remained open under the three outcome milestones, with
categorized priority/area/progress
labels, explicit next actions, ten native blocked-by relationships and six native
iteration sub-issues. Local completion is not closure or remote acceptance.
[GITHUB_WORKFLOW.md](GITHUB_WORKFLOW.md) defines the lifecycle and usable issue
views; [ROADMAP.md](ROADMAP.md) indexes scope/dependencies. Projects authorization
was unavailable at that initial checkpoint, so no board was claimed then.
Instructions/forms are committed locally
and need approval before publication; tracking metadata is applied remotely.

**Later 2026-10-04 Project setup:** owner-granted CLI project access was verified.
The private repository-linked
[PasCap planning Project](https://github.com/users/Plonk42/projects/1) contains
all 16 existing issues, with native Status aligned to issue labels and seven saved
backlog/delivery/current-iteration/milestone/priority views. Actual filter contents,
the board's Status column field and zero duplicate/draft items were verified.
All six new default automations, including Auto-close issue, were removed before
population. No issues/milestones were closed, no dates/duplicate priority fields
were added, and existing native parents/dependencies and historical evidence remain.
The Project is private; browser sign-in is separate from CLI authorization.
No runtime, browser or native/media suite was rerun for this metadata/documentation
step; it is not a fresh CI, hardware or rendering qualification result.

This workflow change does not rerun/relabel the recorded 1,115-test baseline,
qualify hardware/containers or authorize media work, a release or issue closure.
The later explicitly approved help UI scope is tracked separately in #16 and
the current help verification above; mutable progress remains in GitHub.
A project license remains a maintainer decision tracked in
[#5](https://github.com/Plonk42/PasCap/issues/5), not an automatic license grant.



