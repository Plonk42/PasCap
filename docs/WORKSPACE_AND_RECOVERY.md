# Desktop workspace and recovery · 2026-10-04

The current workspace uses **strict schema 5 with project-specific video/music bins
and draggable shared project-time video-row points**, with per-setting channel
navigation. Layout preferences, stored-point inspection and recovery feedback remain editor-only; source
protection, music, dissolve/layer-opacity equations and native render bounds are
unchanged. The intended discrete-GPU and long real-flight checks remain deferred.

## Layout and navigation

- Header: project picker/title, Undo/Redo, save state, **Workspace options** and
  Export. Workspace options holds panel visibility/reset, Diagnostics and help.
- Left: independently scrolling Media list/grid with search, import and compact
  status. **Media options** holds filter/sort/view controls; batch actions and the
  insertion target appear when recordings are selected.
- Centre: docked **Timeline preview** / **Source preview** tabs, never an overlay
  covering other editor controls. Tab arrows and Home/End switch viewer contexts.
- Right: scrollable **Clip / Sequence / Audio** inspector tabs with readable inputs,
  independent collapsible sections. Clip contains source/static bases, opacity,
  speed, colour and one **Layer keyframes** panel for the selected row; Sequence
  owns transitions/fades; Audio owns music. Empty-row selection retains keyframe context.
- Bottom: frame-scaled multi-layer timeline, playhead timecode, highlighted active
  insertion layer, one marker per visible row point, dimmed hidden clips and Activity.
  The responsive toolbar keeps Split, Trim start/end, Delete and IN/OUT/Cut range
  directly visible; only duplication/overlay nudging remain in Clip actions.
  The thin ruler above video rows has TIME ticks/separators and click/drag seeking;
  distinct Cut/Fade/Dissolve buttons open boundary transitions, not keyframes.

Media/Clip widths and Timeline height can be resized by pointer or focused-divider
arrows (16 px; Shift uses 32 px). Double-click/Home resets a divider. Pointer move
changes only a transient UI size; release saves the layout preference. Escape,
pointer cancellation and lost capture restore the prior size. Dividers are disabled
during timeline trim/shared-point/music drafts to preserve captured geometry.

**Workspace options → Reset layout** restores defaults. Side-panel visibility and dimensions are
browser-local UI preferences, never document/history fields. Sizes are clamped to
viewport bounds; below 980 px, one side drawer is visible at a time. The prior v3
pass tested desktop widths 1440/1280/1024/900/720 without horizontal overflow; those
remain the regression matrix, not a completed current-update browser result. The CSS floor
is 640 px; this is not a mobile editor. Denied browser storage leaves layout/section
controls usable for the session and exposes an explanatory preference warning.
Current focused keyframe checks cover the 270 px inspector and 720 px drawer;
full-suite reporting for this update is still pending.

Choosing a layer selects its first excerpt (if present), highlights that row and
reveals it vertically. Empty-layer selection clears clip selection but retains the
insertion target **and row-wide Layer keyframes panel/settings**. Automatic row
reveal never runs under an active trim/shared-point/native clip drag. Selected excerpts and
source-list **Show** requests are also revealed horizontally; showing the first
excerpt restores the normal frame-zero gutter. Selection never changes
source/static bases, layer order or absolute project-frame row points.

Keyboard help is available via **Workspace options → Keyboard shortcuts** or `?`
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
Click or Enter on a marker selects its row and seeks without editing.

Options are nonmodal disclosures with normal Tab navigation, not custom ARIA menus.
They use the browser top layer to avoid clipping inside panels. Escape closes and
returns focus to the trigger; clicking outside closes without stealing focus from
the clicked control. Inspector tab arrows/Home/End switch contexts without discarding
mounted section state. Selecting a clip returns to Clip; a transition opens Sequence.
New preferences keep Source range, Layer & opacity and Speed collapsed, Colour open;
existing expansion preferences remain respected. Help/reset details are contextual,
not repeated across the main workspace. Collapsing never disables processing.

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

The **Layer keyframes** panel belongs to the selected **entire video row**, not the
selected clip. It remains available on an empty row and shows participants as chips.
All ten settings (Layer opacity, Clip opacity, Speed and seven colour parameters)
always expose a diamond beside their control: **◇ hollow/inactive** versus **◆
filled/active**, with `aria-pressed`. A hollow diamond remains clickable; inactivity
does not set HTML `disabled`. Actual invalid/draft states can disable actions.

Each diamond is immediately followed by native SVG **Previous/Next** buttons, then
any existing reset control. Both remain visible, disabled without the corresponding
neighbour, an opened project, or during any document-preview draft. They visit strictly
earlier/later points where that setting is not `null`, including zero, and skip
points participating only in unrelated channels. The duplicate sidebar Layer opacity
controls share this navigation, select their own row and open Clip without stealing
focus from the activated button. Navigation never saves or creates an Undo step.

Clicking joins/leaves **only that setting** at the current absolute project frame.
The first participant creates the shared point, the last removal deletes it, and
other participants/easing are preserved. A keyed channel's slider/number is read-only
where that channel is absent, including points belonging to other channels. Click
its hollow diamond to capture the displayed value first; there are no slider-created
implicit keys. Unanimated channels edit only the selected clip's static base, or
the layer's base opacity. Speed base modes stay Constant/Ramp up/Ramp down, with no
Keyframes option or automatic source endpoints.

**Edit points** exposes one shared list. Each row names the participating setting
dependencies; its inner **Time, easing & values** provides **Timeline frame**,
**Shared easing** and participant-specific values. A time edit moves all participants
and their existing easing together in **one Undo step**; colliding times/invalid
values/contextual timing are rejected without changing the committed document,
never merged or overwritten. One easing is shared at a point,
but each channel interpolates toward its own **next participating point**, with
endpoint holds and static bases only for entirely unanimated channels. Row
input identity/focus and project/layer expansion survive time reordering and Undo;
no persisted point IDs are added.

Points outside current duration remain stored/list-editable. A central editor-only
inspection cursor is shared by setting, row, marker and list navigation, advancing
through several off-duration points even when their previews clamp to the same last
available frame. Labels identify stored time separately from actual preview; an
empty timeline has no preview frame. List fields edit the inspected stored point,
but setting values, diamond state and capture **still use the real playhead**.
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

Reset speed to 1× changes only an active Speed participant when animated; without
Speed keys it resets the selected clip's constant/ramp base. It never clears the
curve or unrelated point participants. Colour **Reset keys** changes only enabled
colour values at the current point; individual resets also handle unanimated clip
bases. Trim/move/split/duplicate do not copy or shift row points. The contract is in
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
the default is the service user's `~/Videos`, and `[]` disables the browser.
Missing/unreadable roots stay visible as unavailable, not a service-startup failure.
Selected-path requests accept at most 5,000 video paths inside approved roots.
Read-only fingerprint/probe checks and the existing queue report accepted/rejected
sources and queue errors; ready/in-flight preparation is reused.

The separate absolute-folder-path form remains an explicit **recursive whole-folder
import**, including outside browser roots. It can queue substantial work and never
silently extends root configuration. Standalone music uses Audio. No original is
copied: strict schema 5 and original source paths remain unchanged, with only
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
Primary edits automatically close gaps/shift later excerpts without reordering their
sources. Overlays/music/shared row points keep their absolute project times. Invalid
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

Only strict v5 projects and v5 project snapshots in version-1 export receipts are interpreted.
Both `media` arrays are required, unique and limited to 10,000 IDs each; missing
membership is an invalid document, not an invitation to expose the global library.
Earlier v1/v2/v3/v4 projects/receipts and finished videos are preserved, incompatible
and never migrated or rewritten with fallback/default local fields. **Create a new
project** and import its media deliberately; registered recordings and currently verified ready proxies are reusable.
The live v3 sample appearing incompatible is expected. No sample preparation or
additional real-media import/render is needed to exercise this with disposable tests.

Startup validates the loopback service with at most five serial, abortable health
GETs and bounded backoff/deadlines (at most 32.5 s for health attempts). It does not
retry writes. An empty workspace presents Projects instead of silently creating a
project. Missing/incompatible URL targets do not open a different project without
explanation. A service failure exposes **Retry connecting**; a preview failure
exposes **Retry preview**, preserving the document and timeline position.

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
2. **Download unsaved project** — download a strict v5 JSON snapshot with the current
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

Export summarizes contextual duration, clips/layers, shared row **points and
participating settings**, enabled layers, profile and a fixed snapshot. A point
with several channels counts once, not as separate clip/channel keys. Both 720p/4K
use originals. Any row point, including Speed-only points, requires layered export.
Layered-resource warnings derive from the actual renderer limits; no invented
disk/time estimate is shown. Accepted export
submission opens Activity and later editing cannot change its snapshot.

Cancellation is one request per job until confirmed. **Cancelling…** means accepted,
not finished; actual cancelled/failed/completed state controls output links. Queued
jobs are cancellable. Failed status reads preserve the last-known jobs and show a
read-only Refresh action. Polling is serial/cancellable; it never automatically
resubmits a job. Old completed render shortcuts are hidden during submission/active
renders to avoid mistaking an old receipt for the new output, but remain in history.

Finished MP4/receipt links survive later failures and restored successful history
is preserved. Owned cancelled/failed scratch is cleaned by the unchanged service;
incomplete output is never offered as a finished video.

UX regressions use disposable synthetic or memory-only projects. The former
schema-5 909-test baseline, completed no-copy 886-test milestone and prior v3/v4
correctness checks are historical. The current marker/channel-navigation full-suite
baseline is **982 tests**, recorded in [DELIVERY_STATUS.md](DELIVERY_STATUS.md).
UX screenshots and short tests are not long-flight or intended-discrete-GPU
performance certification; those gates remain in [ROADMAP.md](ROADMAP.md).
This documentation update performs no additional sample preparation or real-media work.



