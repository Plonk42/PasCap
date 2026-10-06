# Desktop workspace and recovery

The workspace uses **strict schema 6 with uniform video tracks, required per-track
Ripple/transitions/fades, project-specific video/music bins and draggable shared
project-time row points**, with per-setting channel navigation. Layout preferences,
stored-point inspection and recovery feedback remain editor-only. Source protection,
music and dissolve/layer-opacity equations are unchanged; current native bounds
are in [the resource contract](LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits).
The intended discrete-GPU and long real-flight checks remain deferred.

## Layout and navigation

- Header: project picker/title, Undo/Redo, save state, direct **Media / Inspector**
  toggles and keyboard help, **Workspace options** and Export. Workspace options
  keeps layout reset and Diagnostics.
- Left: independently scrolling Media list/grid with search, import and compact
  status. **Media options** holds filter/sort/view controls; batch actions and the
  insertion target appear when recordings are selected.
- Centre: docked **Timeline preview** / **Source preview** tabs, never an overlay
  covering other editor controls. Tab arrows and Home/End switch viewer contexts.
- Right: scrollable **Clip / Layer keyframes / Sequence / Audio** inspector tabs
  with readable inputs and independent collapsible sections. Clip contains
  source/static bases and playhead opacity, speed, colour and diamonds. Layer
  keyframes contains the selected row's whole-point list, participant chips,
  Animation help and point navigation; Sequence owns that track's transitions/fades;
  Audio owns music. Empty-row selection retains keyframe context and dormant fades.
- Bottom: frame-scaled multi-layer timeline, playhead timecode, highlighted active
  insertion layer, one marker per visible row point, dimmed hidden clips and Activity.
  The responsive toolbar keeps Split, Trim start/end, Delete and IN/OUT/Cut range
  directly visible; duplication/start nudging remain in Clip actions.
  Rows display the saved bottom-to-top composition array: row 1 renders below row 2,
  row 3 above row 2, and so on, with no primary/overlay role. The thin ruler remains
  pinned above scrolling video rows with TIME ticks/separators, playhead handle/timecode and click/drag seeking;
  distinct Cut/Fade/Dissolve buttons open boundary transitions, not keyframes.

Media/Clip widths and Timeline height can be resized by pointer or focused-divider
arrows (16 px; Shift uses 32 px). Double-click/Home resets a divider. Pointer move
changes only a transient UI size; release saves the layout preference. Escape,
pointer cancellation and lost capture restore the prior size. Dividers are disabled
during timeline trim/shared-point/music drafts to preserve captured geometry.

**Workspace options → Reset layout** restores defaults. Side-panel visibility and dimensions are
browser-local UI preferences, never document/history fields. Sizes are clamped to
viewport bounds; below 980 px, one side drawer is visible at a time. Desktop widths
1440/1280/1024/900/720 form the responsive regression matrix; the workspace should
not overflow horizontally. The CSS floor is 640 px; this is not a mobile editor.
Denied browser storage leaves layout/section controls usable for the session and
exposes an explanatory preference warning. Keyframe controls must remain reachable
in the 270 px inspector and 720 px drawer; the 640 px toolbar and music lane must
retain usable pointer targets. These are UI contracts, not performance certification.

Choosing a layer selects its first excerpt (if present), highlights that row and
reveals it vertically. Empty-layer selection clears clip selection but retains the
insertion target **and row-wide Layer keyframes context/settings**. Selecting a
clip or a populated/empty row preserves the user's chosen Inspector tab. Its fields
refresh for the new editing context without applying the previous row/clip's drafts
to that selection. Automatic row reveal never runs under an active
trim/shared-point/native clip drag. Selected excerpts and source-list **Show**
requests are also revealed horizontally; showing the first
excerpt restores the normal frame-zero gutter. Selection never changes
source/static bases, layer order or absolute project-frame row points.

The timeline and layer headers both support native vertical scrolling, including
wheel/trackpad, scrollbars and keyboard focus reveal. They share the same vertical
position and row geometry; horizontal timeline scrolling does not move the headers.
All eight rows and the music lane remain reachable at compact timeline heights.
Scrolling alone does not seek, edit, create history or save.
The ruler stays visible at every vertical scroll position while its ticks follow
horizontal timeline scroll. Header focus and automatic reveal account for the
pinned heading/ruler. Clip/media drops target actual visible rows, never the ruler
or a row hidden underneath it.
Layer options explain unavailable stack actions: the top composition track cannot
be raised further, the bottom cannot be lowered further, and the last remaining
track cannot be deleted. Every other track can be reordered/deleted; the initial
ID is not a protected base. Actions remain undoable, and active drafts/unavailable
preview still block mutations.

**Layer options → Ripple** is a native checkbox with contextual help and visible
row state; new tracks default on. Enabling packs current clips from the first
current start, closing gaps in one Undo and retaining valid dissolves. While on,
later clips continuously follow the first anchor; commands persist actual starts.
Turning off captures actual placements for independent edits. **Timeline start
frame** and nudges work on positioned clips or the first Ripple anchor; later
Ripple starts are disabled with an accessible explanation to drag to reorder or
turn Ripple off. Music, other tracks and absolute row points never follow Ripple.

In **Sequence**, boundary controls and **Sequence fades** use the selected track.
Gapped pairs are Cut only, with a reason to close the gap or enable Ripple before
adding a non-cut effect. A positioned dissolve edit explicitly adjusts its paired
right clip; other clips stay fixed and conflicts reject the whole edit. Black
opening/closing/transition fades darken only that row's RGB, preserving coverage.
Empty tracks retain dormant fades; adding footage validates them again.

Keyboard help is available via the **header help button** or `?`
outside form/modal/source controls. Space, S, Q/W, I/O, Shift+Delete, Escape,
Ctrl+D, Delete/Backspace, Undo/Redo,
arrows, Shift+arrows, Alt+arrows, Alt+Shift+arrows, Home/End and F
are mapped explicitly. Native button Space remains button activation. Editing
shortcuts cannot mutate clips while using a modal, source control, input, options
popover, activity drawer or pane divider. Skip links expose the major editor regions.
On a focused row marker, Left/Right moves that point one project frame and Shift
moves ten. Marker keyboard events remain in that context, retaining point/Timeline
focus while navigating to the moved point, without also firing ordinary playhead-step,
clip-nudge or other editor shortcuts.
Click or Enter on a marker selects its row and seeks without editing; marker and
whole-row point navigation preserve the chosen Inspector tab.

Options are nonmodal disclosures with normal Tab navigation, not custom ARIA menus.
They use the browser top layer to avoid clipping inside panels. Escape closes and
returns focus to the trigger; clicking outside closes without stealing focus from
the clicked control. Inspector tab arrows/Home/End switch contexts without discarding
mounted content or its valid/invalid drafts within the same editing context.
Selecting a clip or row keeps the chosen tab; explicit Cut/Fade/Dissolve boundary
buttons open Sequence.
**Expand all / Collapse all** below the Inspector tabs changes all seven top-level
settings sections across Clip, Sequence and Audio, including hidden or temporarily
absent sections. A mixed state offers Expand all. Individual toggles and the existing
section preferences remain authoritative; the Layer keyframes tab's **Edit points**,
its nested **Time, easing & values**, other nested details and help are excluded.
Bulk expansion is presentation-only and leaves mounted drafts, processing, history
and saves unchanged. If preference storage fails, choices still work for the session.
New preferences keep Source range, Layer & opacity and Speed collapsed, Colour open;
existing expansion preferences remain respected. Help/reset details are contextual,
not repeated across the main workspace. Collapsing never disables processing.

All inline help uses a small **question-mark button**, including animation, source,
opacity, speed, colour, keyframe/transition/fade/audio timing and startup details.
Inspector Source range, Layer & opacity, Speed, Colour, Transition and Sequence
fades put help beside their titles, reachable even when collapsed. Expansion and
help are independent native buttons in normal section → help → fields Tab order;
help never opens or closes the settings. Hidden content remains mounted, retaining
its valid/invalid drafts and section preferences.
Shared-point timing help sits beside **Edit points**, audio timing beside
**Placement & fades**, and startup details beside **Preview needs attention**.
These title-row help targets remain available without expanding their settings;
collapsing content does not hide its heading help. Hiding the owning tab/pane
still dismisses help. **Animation help** sits beside the Layer keyframes heading
in its dedicated tab, alongside whole-row point navigation.
Hovering the question-mark target or keyboard focus previews help without moving
focus or applying a draft; empty space across a section does not activate help.
The pointer can move into the text without closing it. Click, Enter or Space pins
it until Escape, another explicit help activation, or an outside click. A second
click on the same button also closes it. Down arrow focuses the readable/scrollable
text; Escape returns to its button only when focus was in that help, otherwise the
focused field stays put. An outside click does not steal the clicked control's focus.
An outside pointer press dismisses before a control captures a drag, retaining that
gesture's normal Escape cancellation. With help open, Escape dismisses help before
cancelling a field draft or closing a dialog.
Pinned help is not displaced by another hover. The native top layer avoids clipping,
stays within viewport bounds and never covers its own question-mark target. When
the full text fits neither above nor below, the panel scrolls on the larger side,
retaining pointer travel, wheel scrolling and keyboard focus. It closes when its
owner is hidden. No help interaction
seeks, changes history or saves; explicitly clicking away from a numeric field still
has the ordinary one-commit blur behavior. Editable section/point/music/import controls,
storage/render breakdowns and real warning/error lists remain normal disclosures.

The preview timecode accepts nominal 30 fps NDF **HH:MM:SS:FF** or an integer
timeline frame; it is not rounded wall-clock seconds. Out-of-range/invalid input
stays editable with an error and never seeks. Escape returns to the current display.

## Numbers, titles and animation

Inspector number fields keep a local text draft. Enter or leaving the field applies
one validated value; Escape restores. Empty, nonfinite, fractional frame, range,
duplicate key and conflicting timing inputs stay editable with inline errors.
Numbers are not coerced to zero/clamped/rounded to conceal an invalid edit. An
unchanged draft creates no undo step, and Enter then blur cannot submit it twice.

Project titles and layer names follow the same draft/apply/cancel pattern; empty
names are invalid. Layer rename lives in **Layer options**, accepts 1–100 trimmed
characters, and commits as one undoable operation.
Editable sliders, mode/select controls and per-control colour resets remain live;
animated channels without participation at the playhead are read-only until captured.
The paired source-review IN/OUT form deliberately uses an explicit **Apply** to
validate its two endpoints atomically.

### Shared row animation

The dedicated **Layer keyframes** tab belongs to the selected **entire video row**,
not the selected clip. It remains available on an empty row and contains the shared
point list, count, whole-row Previous/Next navigation and participant chips.
Its question-mark **Animation help** button uses the common hover/pin/dismiss
contract above; explanatory text does not replace the shared point editor.
**Clip** keeps the source/static bases and playhead value/diamond controls.
All ten settings (Layer opacity, Clip opacity, Speed and seven colour parameters)
always expose a diamond beside their control: **◇ hollow/inactive** versus **◆
filled/active**, with `aria-pressed`. A hollow diamond remains clickable; inactivity
does not set HTML `disabled`. Actual invalid/draft states can disable actions.

Each diamond is immediately followed by native SVG **Previous/Next** buttons, then
any existing reset control. Both remain visible, disabled without the corresponding
neighbour, an opened project, or during any document-preview draft. They visit strictly
earlier/later points where that setting is not `null`, including zero, and skip
points participating only in unrelated channels. The duplicate sidebar Layer opacity
controls share this navigation and select their own row. Navigation preserves the
chosen Inspector tab and the activated button's focus, rather than forcing Clip;
it never saves or creates an Undo step.

Clicking joins/leaves **only that setting** at the current absolute project frame.
The first participant creates the shared point, the last removal deletes it, and
other participants/easing are preserved. A keyed channel's main Clip slider/number
is read-only where that channel is absent, including points belonging to other
channels. Click its hollow diamond to capture the displayed value first; there are no slider-created
implicit keys. Unanimated channels edit only the selected clip's static base, or
the layer's base opacity. Clip Speed modes include Constant/Ramp up/Ramp down and
the explicitly approved Custom curve with source-frame keys. Its presets, precise
fields and reversible graph gestures do not create row Speed participation.

**Layer keyframes → Edit points** exposes one shared list. Each row names the
participating setting dependencies; its inner **Time, easing & values** provides
**Timeline frame**, **Shared easing** and participant-specific values.
A time edit moves all participants
and their existing easing together in **one Undo step**; colliding times/invalid
values/contextual timing are rejected without changing the committed document,
never merged or overwritten. One easing is shared at a point,
but each channel interpolates toward its own **next participating point**, with
endpoint holds and static bases only for entirely unanimated channels. Row
input identity/focus and project/layer expansion survive time reordering and Undo;
no persisted point IDs are added.

Stored colour/opacity participants reuse the main sliders, units and individual
colour resets, with precise numeric fields alongside them. Speed reuses **Layer
rate ×** and Reset to 1×, not clip mode/preset/source-curve controls. Each accepted
value or reset targets only that existing stored participant in one Undo step;
point time, shared easing, other participants and static bases stay unchanged.
There is no implicit joining. Numeric drafts retain entered precision and apply
on Enter/blur; Escape restores. Empty, nonfinite, out-of-range or timing-conflicting
values retain inline errors without clamping or shortening transitions.

Points outside current duration remain stored/list-editable. A central editor-only
inspection cursor is shared by setting, row, marker and list navigation, advancing
through several off-duration points even when their previews clamp to the same last
available frame. Labels identify stored time separately from actual preview; an
empty timeline has no preview frame. List controls edit their stored point,
but Clip's setting values, diamond state and capture **still use the real playhead**.
Manual seek (including the same clamped frame), playback, row/project changes and
deletion of the inspected point clear inspection. A valid single-point move/Undo
preserves the cursor and input identity; **Follow playhead** ends inspection explicitly.

One marker per visible row point lists participants in its title. **Horizontal
marker dragging** captures the project/row/point, zoom, grabbed pointer position,
scroll and stationary playhead. Capture-relative travel is rounded once and bounded
to frames 0–2,147,483,647. Valid drafts preview live but never enter autosave/history;
valid release moves all participants/values/easing in one Undo step. Snap uses
captured clip/music/transition boundaries and playhead within eight pixels; Alt
bypasses it. Horizontal autoscroll retains the captured geometry, with no row move
or automatic row reveal.

An occupied time or Speed-related overlap/fade/transition conflict shows a red
invalid ghost. Release reports the error without merging, overwriting, shortening
transitions or committing an earlier valid draft. Escape, pointer cancellation,
unexpected capture loss or window blur restores preview/document/scroll without a
draft save. A point may move beyond duration without extending the sequence merely
to display it; Speed can naturally recompile clip durations. Other points, source/
static clip bases and music are not copied or shifted. The shared time field remains
an exact alternative, with the same atomic move validation.

In Clip, Reset speed to 1× changes only an active Speed participant when animated;
without Speed keys it resets the selected clip's constant/ramp/custom base.
It never clears the row curve or unrelated point participants. Colour **Reset keys**
changes only enabled colour values at the current point; individual resets also
handle unanimated clip bases. Stored-point resets in Layer keyframes target that
point's existing participant, not a different value at the playhead.
Trim/move/split/duplicate do not copy or shift row points. The contract is in
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Source review and import

**Import** defaults to a service-side browser for approved footage roots. Choose a
root/folder, select MP4/MOV/M4V recordings and explicitly confirm registration of
their original absolute paths into the current project's bin. Browsing/selection
alone starts no work: one-folder metadata reads do not read media bytes, probe,
register, write or queue preparation. Folders are first with natural-name sorting;
the 2,000-entry limit has explicit truncation guidance to choose a narrower folder.
The cache branch is excluded and symlink/path checks remain enforced.

`PASCAP_MEDIA_ROOTS` accepts a JSON array of at most 32 unique absolute paths;
the default is the service user's `~/Videos`, and `[]` disables both footage and music browsing.
Missing/unreadable roots stay visible as unavailable, not a service-startup failure.
Selected-path requests accept at most 5,000 video paths inside approved roots.
Read-only fingerprint/probe checks and the existing queue report accepted/rejected
sources and queue errors; ready/in-flight preparation is reused.

The separate absolute-folder-path form remains an explicit **recursive whole-folder
import**, including outside browser roots. It can queue substantial work and never
silently extends root configuration. Standalone music uses **Audio → Music → Browse
music files** beside the retained manual **Music file path / Import audio** form.
The native modal selects one audio candidate with radios, supports root/folder,
Up/Root, search and metadata-only Refresh, and exposes unavailable roots, truncation
and access warnings. Browsing, selecting and Cancel/Escape never register, prepare,
edit or save; dismissal restores focus to Browse music files. Root changes clear
selection, while folder/filter changes retain the one selected file until replaced.
Only **Import selected music** submits its root-scoped path. Cancel/Escape and duplicate
submissions are blocked while registration and the project-bin update are processing.
Success adds audio membership to the importing project and displays the accepted job,
without selecting music or changing placement; the modal then closes. Failure or an
uncertain write keeps selection and the actual error visible, with guidance to check
Activity/project state before repeating the import; there is no automatic write retry.
Late folder reads are aborted on navigation/dismissal. Manual music paths remain
deliberate imports outside browser roots and never expand configured roots. No original is
copied: strict schema 6 references original source paths, with only
generated proxies/thumbnails, metadata, exports/receipts and scratch written locally.

There is no upload endpoint, browser file picker, optional copy flow or true
external desktop file/folder drag-and-drop import. External drops prevent navigation
and show Import guidance **without a POST**; a browser drop is not a trusted original
filesystem path. Internal dragging of ready Media into Timeline is preserved.
No hidden write retry or original overwrite occurs; accepted registrations remain
kept if a later source or queue admission fails.

Hover X maps a prepared recording's review button across its complete source.
Source preview has its own one muted paused decoder, observed-frame checks,
buffering/error/retry state and release on close/hidden/offscreen/project change.
It never moves the project playhead or prepares/plays an original implicitly.

Pin holds that source while hovering other rows. Explicit click/focus can select
another prepared source. IN/OUT handles/Apply/I/O marks/Reset stay recoverable.
Applied choices are per-project browser-local state; unavailable storage leaves
valid choices usable for the current session with a warning. All insertion paths
copy the latest applied range and create independent clip instances. Changing a
choice never alters existing excerpts. **Add excerpt** leaves the same source pinned
and open, at the same range/frame, with feedback only after a successful insertion.
The sticky source header keeps Add and a compact excerpt-count popup reachable
even when range fields need scrolling on a short screen. The native nonmodal list
does not resize the preview; Escape closes only the popup and outside-click Add
leaves focus on that action. The list shows original IN/OUT and row names;
**Show** selects/seeks/reveals a chosen instance. The recording's library badge counts
its independent excerpts. Failed Add retains source/range/frame without stale success.
Other insertion paths, explicit Show, timeline selection and edits return to Timeline;
Source remains available through its tab. Changing rushes leaves exactly one
range editor/decoder, without stale duplicate controls.

Timeline IN/OUT marks select an unwanted part of one excerpt, with OUT after the
displayed frame. **Cut range** removes it in one Undo step, retaining independent
left/right excerpts where needed. **Split** selects the new right piece; **Q/W**
keep the displayed frame while shrinking the head/tail. Marks are temporary,
cleared by selection/timing/history/project changes, never project/autosave fields.
Ripple-on edits close gaps/re-sequence later excerpts on that track from its first
anchor; off keeps other clips at independent starts. Left handle/keyboard trims
keep the sequence start while on, retain timeline OUT while off, and reject an
unrepresentable integer-frame OUT. Numeric source edits keep the start in either
mode. Music, other tracks and shared row points keep their absolute project times. Invalid
fade/overlap/quantisation edits remain atomic. Full details are in
[TIMELINE_EDITING.md](TIMELINE_EDITING.md).

Left-handle gestures temporarily reserve omitted headspace with equal pre-paint
scroll compensation, so dragging near the viewport's left edge can restore a long
trimmed beginning without leaving the window or an initial frame-zero jump.
Cancel restores document/scroll; release commits once and removes the temporary gutter.

Explicit selected-path registration, recursive folder-form submission and
single-source library additions add recordings to the open project's video bin
and automatically queue eligible editing proxies through the one-heavy-job worker.
Browsing is not registration and never starts that queue. Admission does not wait
for encoding to complete.
Reports distinguish new/already-registered recordings, returned queued/running jobs,
ignored files, probe rejections and queue admission problems. Accepted jobs appear
in Activity immediately after the import response, even if a status refresh fails.

The global content-deduplicated registry/proxy cache is shared, but project bins
are not: import membership is saved explicitly in `media.videoIds` and
`media.audioIds`. Standalone audio import populates the open project's music bin.
The visible libraries include that explicit membership plus clip/music references,
so imports remain visible with an empty timeline. New projects start with both
arrays empty and never inherit all globally registered videos/music. Deliberately
importing an already registered source into another project adds membership while
reusing eligible prepared assets, without changing originals.

Reimport/concurrent additions reuse ready proxies or pending/active preparation;
they do not encode the same source twice. Registration remains kept when queue
admission fails. Failed/cancelled/interrupted jobs are not retried automatically;
the row's **Prepare** action is explicit. Single/batch preparation also remains for
older registered media, with confirmation for a manual multi-recording batch.
Startup, library reads and hovering never queue existing unprepared sources.
Rejected import items are not fabricated as successes, and uncertain write results
must be checked before submitting the import again.

Music reimport reuses an entry only for the same absolute path and unchanged source
identity. Deliberately importing a moved file or another hard-linked location
creates a new music entry and verifies the selected path, not a missing old one.
The old entry, its project references and caches remain unchanged; this is a fresh
import, not relinking. Choose the new **Recording** entry separately to place music.
The serial worker reuses an eligible verified PCM cache without rewriting it.

## Projects, service connection and errors

Projects are searchable by title/ID with compatibility filtering and recent ordering.
Unsupported/invalid documents retain their reason and remain unchanged. The current
project is identified; per-action pending state prevents double submission. Errors
stay inside the dialog, preserve typed titles/quality choices and never close it
as a false success. Closing restores keyboard focus to the origin, including when
the dialog was loaded asynchronously while its trigger was disabled.

**Delete project** requires explicit confirmation and removes only the selected
saved document. It never deletes original recordings, shared registry entries,
proxies/cache files, successful MP4s or receipts. This is not cache garbage
collection; another project's membership and immutable export snapshots are unaffected.

Only strict v6 projects and v6 project snapshots in version-1 export receipts are interpreted.
Both `media` arrays are required, unique and limited to 10,000 IDs each; missing
membership is an invalid document, not an invitation to expose the global library.
Every layer requires `ripple`, `transitions`, `openingFade` and `closingFade`;
project-level transitions/fades and a mandatory first-track identity are absent.
Earlier v1–v5 projects/receipt snapshots are preserved, incompatible
and never migrated or rewritten with fallback/default local fields. **Create a new
project** and import its media deliberately; finished videos remain untouched,
and registry/proxy formats are unchanged. Registered recordings and currently
verified ready proxies are reusable.
The live v3 sample appearing incompatible is expected. No sample preparation or
additional real-media import/render is needed to exercise this with disposable tests.

Startup validates the loopback service with at most five serial, abortable health
GETs and bounded backoff/deadlines (at most 32.5 s for health attempts). It does not
retry writes. An empty workspace presents Projects instead of silently creating a
project. Missing/incompatible URL targets do not open a different project without
explanation. A service failure exposes **Retry connecting**; a preview failure
exposes **Retry preview**, preserving the document and timeline position.

Playback retains an already accepted image for normal one-frame decoder-callback
latency rather than flashing black or restarting music. Exact source maps across
all active clips and project-time appearance still govern drawing; a changed clip
set or stale appearance cannot reuse that image. Genuine larger mismatches, missing
sources and failed music synchronization remain explicit buffering/errors. Source
wraps and renderer throughput can still interrupt playback; this is not gapless
audio or intended-GPU/long-run qualification.

Music uses one sample-owned Web Audio worklet with four bounded PCM blocks and
serial byte-range refill. The actual rendered source origin/output timestamp
governs A/V playback; block-updated media-element time does not trigger false
restarts. Selected-range loops are filled continuously, while true empty-queue,
processor/read failures and greater-than-one-frame drift remain explicit. Pause
invalidates the complete epoch and outstanding reads before late work can restart.
Missing current PCM caches appear as Audio → Music **Retry** preparation actions;
no read automatically prepares, rewrites or removes older AAC caches. Explicit
preparation creates the current versioned PCM cache without changing originals,
project documents, registry/video-proxy formats or finished exports.

Read and response decoding have deadlines; incompatible/HTML responses are errors,
not defaults. If a write transport times out, its result may be uncertain: check
current project/job state before repeating it. Accepted job/create/export responses
are not reclassified as failures merely because a following status GET fails.

## Source availability and persistent storage

Originals must remain readable at their registered absolute service-side paths.
Moving recordings or disconnecting a drive causes explicit identity/missing-source
errors, even with a ready proxy. The editor does not guess another path, silently
reassociate a source or bypass fingerprints; an explicit relink workflow is pending.
Previously copied source files from the removed implementation are **not deleted
or migrated automatically**. Preserve registered source paths and bytes still in
use. This is data safety, not compatibility/migration code or an optional copy mode.

Keep writable cache/scratch outside footage and preserve project/registry data and
successful outputs. The approved eventual local Docker/Podman OCI package uses
read-only source mounts and separate read/write persistent data, with stable
service-side path mapping; packaging is **not implemented yet**. No source belongs
in an image, no implicit path migration is promised, and ephemeral container storage
is not suitable for saved work. See [DEPLOYMENT.md](DEPLOYMENT.md) for the future
layout, permissions, loopback publishing and SIGTERM/child-reaping acceptance.

## Save recovery

Serial revisioned autosave remains the only automatic project writer. A failure
keeps the current document/history in the editor and stops automatic retries, even
if further changes arrive. **Retry save** is offered only for recoverable transport/
server failures and uses the same expected revision; it never rebases a conflict.
Keyframe navigation/inspection and pointer-move previews never enqueue document
saves. Only a valid committed point move enters history/autosave; cancellation or
invalid release leaves the saved document and history unchanged.

For an HTTP 409 or incompatible save response, **Review latest save** explains:

1. **Keep editing this draft** — no saved document changes; the save error persists.
2. **Download unsaved project** — download a strict v6 JSON snapshot with the current
   local changes/expected revision before replacing them.
3. **Discard local changes and reload** — explicitly replace local history/document
   with a newly read saved version. It performs no overwrite POST/PUT.

The snapshot is for manual recovery/examination; no JSON-import/migration workflow
is added. Switching projects or exporting is blocked while autosave remains dirty.
Reload/discard never happens just because the service reports a conflict. Browser
navigation warns about committed unsaved changes and dirty UI fields/pointer drafts.
A forced browser or laptop shutdown can still lose in-memory unsaved changes:
download a copy or wait for **Saved locally** before closing. No crash-proof local
draft database or interrupted-render resume is claimed.

## Activity and exports

Activity is a nonmodal drawer, with running first, FIFO queued jobs, then history by
completion date. It includes video/audio preparation, reference renders, exports,
failures and cancellations. Progress is numeric/bar-based; settled outcomes are
announced without reading every progress poll aloud. Escape closes a focused drawer
and returns focus to Activity, without pausing the editor or native job.

Export summarizes contextual duration, clips/layers, track-local Ripple/transitions/
fades, shared row **points and participating settings**, enabled layers, profile
and a fixed snapshot. A point
with several channels counts once, not as separate clip/channel keys. Both 720p/4K
use originals. The static fast path requires one enabled opaque, unanimated,
zero-origin contiguous track and opaque clips; any row point, leading start,
gap or unsupported coverage uses generalized layered export. That path renders
premultiplied RGBA16 groups, then source-overs without regrading. Preview reuses
two slots per track (16 maximum) plus one source reviewer. Native limits are four
raw buffers/22 bytes per pixel, two LUTs, three timeline representations and two
retained clip files, with serial one-original/two-intermediate/one-encoder passes
and at most three native video children. Exact byte bounds are in
[the resource contract](LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits). Export
shows free space on its output/scratch volume and an explicitly advisory planning
allowance, not a compressed-size guarantee or time estimate. Low space/mount
errors have recheck/recovery actions; genuine ENOSPC cleans only the failed job,
preserving originals, saved edits and completed outputs. Storage and Rendering
details remain disclosed. Accepted submission opens Activity and later editing
cannot change its snapshot. See [UX_HARDENING.md](UX_HARDENING.md) for storage
assumptions, measurement procedures and the private constrained-volume test.

Preview/Inspector loading is deferred without changing per-frame ownership.
Module-load failures keep the editor available and offer **Reload editor**, which
first flushes pending committed edits, plus **Download project**. A save failure
prevents reload and retains the draft; browsers cache failed imports, so this is
not a misleading same-module Retry. Runtime preview errors still use Retry preview.

Cancellation is one request per job until confirmed. **Cancelling…** means accepted,
not finished; actual cancelled/failed/completed state controls output links. Queued
jobs are cancellable. Failed status reads preserve the last-known jobs and show a
read-only Refresh action. Polling is serial/cancellable; it never automatically
resubmits a job. Old completed render shortcuts are hidden during submission/active
renders to avoid mistaking an old receipt for the new output, but remain in history.

Finished MP4/receipt links survive later failures and restored successful history
is preserved. Owned cancelled/failed scratch is cleaned by the unchanged service;
incomplete output is never offered as a finished video.

UX regressions use disposable synthetic or memory-only projects. Actual-commit
results belong in [GitHub Actions](https://github.com/Plonk42/PasCap/actions) and
the corresponding [work issues](https://github.com/Plonk42/PasCap/issues), including
[#16](https://github.com/Plonk42/PasCap/issues/16) for contextual-help acceptance.
UX screenshots and short tests are not intended-GPU, long-flight or long-run A/V
certification; those requirements belong to
[#6](https://github.com/Plonk42/PasCap/issues/6),
[#7](https://github.com/Plonk42/PasCap/issues/7) and
[#8](https://github.com/Plonk42/PasCap/issues/8). Real-media jobs require explicit
owner consent.



