# Timeline editing

## Source footage and excerpt instances

The media library describes complete recordings belonging to the open project's
bin, not every globally registered source. Strict schema 5 requires unique
`media.videoIds` and `media.audioIds` arrays (10,000 IDs maximum each). Imports add
membership even without timeline placement; clip/music references also remain
visible. New projects start with both arrays empty. Importing an existing source
deliberately reuses the global content-deduplicated registry/proxy cache; switching
projects never automatically adopts that global library. An insertion creates
a unique clip-instance ID and copies the latest media-review IN/OUT, or
`sourceIn = 0`, `sourceOut = registered frameCount` without a choice. New clips have
neutral static colour, opacity 1 and normal constant speed. They have no clip
animation; any existing row curves immediately apply at their project placement.
The original and full proxy remain unchanged; no extra crop file is generated.
Multiple insertions of one recording have independent source ranges and static bases.

For several excerpts from one rush, set source IN/OUT and **Add excerpt**, then
mark the next range and add again. Successful additions leave Source preview pinned
to the same recording/frame, with the applied range unchanged and explicit success
feedback. The source is not unmounted/reloaded for each addition. Failed insertion
keeps the review/range and never reports success. **Add excerpt** and a compact
**excerpts from this rush** popover stay in the sticky source header, including on
short laptop screens; opening the list does not resize source review. The popup
shows original ranges/layers; Escape closes just the popup and **Show** selects, seeks and horizontally
reveals that instance. Library reuse badges count excerpts, not duplicate source files.

Timeline source OUT is exclusive. Integer frames at 30000/1001 remain the
authoritative stored timing; displayed seconds are derived, not accumulated.
Output duration/source sampling uses each authoritative **`PlacedClip.retiming`**,
not the raw source-range length at non-1× speed. A row Speed curve uses absolute
project time and can give the same source excerpt a different duration at another
start/layer. Without Speed participants, the clip's static constant/source-ramp
map applies. See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md).

## Importing recordings from the filesystem

Create/open a project, then choose **Import**. Its default is the **service-side
footage browser**, not an operating-system file picker. Choose an approved root,
open a folder, select **MP4, MOV or M4V** recordings and explicitly confirm path
registration. Imports reference those original absolute paths and belong to the
current project's bin; they are not inserted into the timeline automatically.

Browsing lists **one folder's metadata only**: no media-byte reads, probing,
registration, writes or preparation jobs. Folders appear first with naturally
sorted names. At most **2,000 entries** are shown; an explicit truncation warning
means choose a narrower folder, not that all recordings were discovered. The cache
branch is excluded and symlinks are rejected. Missing/unreadable approved roots
remain visible as unavailable instead of preventing service startup.

`PASCAP_MEDIA_ROOTS` is a JSON array of at most 32 unique absolute roots, defaulting
only to the service user's `~/Videos`; `[]` disables the browser. Selected-path
registration accepts at most **5,000 absolute video paths per request**, constrained
to approved roots. Existing read-only fingerprint/probe checks report individual
failures. Confirming registration queues eligible proxies through the same
one-heavy-worker queue; ready/in-flight work is reused, and failed/cancelled/
interrupted preparation requires explicit **Prepare**. Merely opening folders or
selecting files never starts that work. Use Audio for standalone music.

The separate **absolute-folder-path form** preserves the existing deliberate
recursive import. It can register and autoqueue a whole folder, including one
outside browser roots, so choose a narrow folder and submit only when that work is
intended. This action never silently adds an approved root. See
[../README.md](../README.md#footage-service-api) for the browsing/registration API
and [DEPLOYMENT.md](DEPLOYMENT.md) for service-side paths and planned mounts.

There is **no footage copy mode, upload endpoint, browser file picker or true
external desktop drag-and-drop import**. A browser drop does not provide a trusted
original absolute path. External file/folder drops prevent navigation and give
Import guidance, **without a POST**. Internal dragging of ready registered Media
into Timeline remains unchanged. Uncertain registration results are not retried
automatically; check Media/Activity before resubmitting.

Strict schema 5 is unchanged. Only generated proxies/thumbnails, metadata,
exports/receipts and scratch are created, not duplicate originals. Keep originals
accessible at their registered paths: moving files or disconnecting a drive fails
explicitly, even with a proxy; there is no implicit guessing/reassociation and an
explicit relink workflow is pending. Previously copied source files from the
removed implementation are not automatically deleted or migrated: preserve their
registered paths and bytes. This is data safety, not compatibility code.

## Non-destructive trim gestures

- Pointer down captures the handle, pauses preview and snapshots the committed
  document and frame/pixel scale.
- Pointer movement computes output-frame delta from the original pointer position,
  including horizontal scroll. The contextual placed map converts the requested
  output-duration change back to a recoverable original endpoint; drafts do not
  accumulate rounding or rescale row points.
- A left drag changes IN; a right drag changes OUT. Bounds come from registered
  media metadata, **never the previously shortened excerpt duration**.
- Geometry and paused preview update against the draft. Autosave/history and the
  committed document remain untouched until pointer release.
- Release publishes one validated command; one Undo restores the previous range.
  Escape, pointer cancellation or unexpected capture loss cancels the draft.
- Source limits stop a handle at zero/original frame count; at least one frame
  remains selected. Transition/fade incompatibility is an invalid edit, not a
  reason to shorten transitions silently.
- Primary clips downstream ripple when a trim is committed. On overlays, a left
  handle/keyboard trim solves the new start and source IN together so the timeline
  OUT holds, including under a row rate curve. If integer-frame quantisation cannot
  represent that retained OUT, the trim is explicitly rejected rather than moving
  it silently. Right trims leave the start fixed. Numeric source edits keep placement.
  The selected original's dashed extent appears during trim hover/focus/drafts,
  and Source range exposes the recoverable head/tail amounts.
- The timeline origin stays fixed rather than shifting when a clip is selected.
  On a left-handle gesture only, recoverable headspace is reserved and scroll is
  compensated before paint: pointer/frame-zero positions do not jump at gesture start.
  Keeping the pointer inside the left viewport edge autoscrolls through that headspace,
  even when a long beginning was omitted from the first primary excerpt. Release
  removes the temporary gutter; cancellation restores its initial scroll and document.
  No negative project start is stored. Right-edge autoscroll likewise exposes tails.
  Home/End and numeric source fields remain available for exact restoration.
- Numeric IN/OUT and **Restore full recording** share the same source and
  transition validation as handles.
- Trim/restoration never copies or shifts row points. Original-source static ramp
  anchors are retained; the row animation override continues across the new range.

The selected excerpt's left/right trim edges are keyboard sliders. Arrow keys
move by one original source frame; Shift moves by ten. Home at the left edge requests
IN=0; End at the right edge requests the original OUT. An overlay left restoration
cannot extend before project frame zero or silently change its retained timeline
OUT; source/placement quantisation and normal overlap/fade validation still apply.

## Cutting an unwanted part

The timeline's visible rush-edit controls expose **Split**, **Trim start**, **Trim end**,
Delete and **IN / OUT / Cut range** in the existing responsive toolbar, not another
row covering the lanes. It identifies **Ripple sequence** versus **Positioned overlay**.

- **Split / S** maps the playhead through the placed retiming map and creates two
  independent excerpts. On success the right piece is selected and its beginning
  previewed, ready for another split/trim/delete. Invalid splits preserve selection
  and history. The playhead must be strictly inside the excerpt's source range.
- **Trim start / Q** discards footage before the displayed source frame; **Trim
  end / W** discards footage after it, keeping that frame via source OUT = frame + 1.
  Primary clips ripple; the overlay left trim retains its old OUT when representable.
  These are shrinking operations. Handles or Restore full recording recover omitted
  footage. Repeating an unchanged endpoint trim adds no history entry.
- With one excerpt selected, seek the first unwanted timeline frame and **IN / I**,
  then seek the last unwanted frame and **OUT / O**. OUT is stored as playhead + 1,
  exclusive. A hatched overlay, IN/OUT markers and timecode readout show the range.
  **Cut range / Shift+Delete** removes it atomically in **one Undo step**.
- Middle removal keeps a left excerpt with the original ID and a right excerpt with
  a fresh ID. Prefix/suffix removal keeps only the retained excerpt; a whole-range
  removal deletes it. Retained pieces share the original media but have independent
  ranges/static settings, including original-source ramp anchors. No proxy is cut.
- The primary row closes the removed gap and recalculates later starts/durations
  without changing their order, original-source ranges or static settings. The new
  left/right boundary is a cut. Existing valid incoming/outgoing transitions are
  retained/reanchored; fades are never silently shortened to make an invalid edit fit.
- An overlay cut keeps the removed gap and other clips' absolute placements. Its
  retained right piece starts at the original contextual output position of the
  retained source IN. Each piece retimes/rounds independently, like a mapped split;
  invalid overlap/quantisation is rejected. Use the primary row for ripple assembly.
- Missing/reversed/outside marks and slow-motion ranges containing no original
  source frame cannot remove footage. Mark controls require the playhead within
  the selected excerpt; errors preserve document/history and valid existing marks.
- Marks are transient editor state, not autosaved/rendered fields. Clear/Escape,
  changing the selected excerpt/empty row, timing edits, Undo/Redo and project changes
  clear them. Source-review I/O controls are a separate context and never edit these
  marks or the timeline. Form/modal/slider/popover keyboard guards still apply.

Music, overlays and row points do not follow primary ripple edits. Their absolute
project times remain fixed; row animation may therefore evaluate different footage
after sequencing changes. No timing migration or schema extension is introduced.

## Insertion, reordering and history

The primary sequence is displayed first, with overlays below it in front-to-back
overlay order; saved bottom-to-top composition and primary/overlay timing are
unchanged. Tracks and layer headers have synchronized native vertical scrolling.
The ruler, playhead handle and timecode remain pinned above scrolling rows. Ticks
follow horizontal scroll; a ruler click/drag still maps to the exact timeline
frame. Scrolling creates no seek/history/save, and a drop on the ruler cannot
target a row hidden underneath it.

- Media drags carry registered IDs, not arbitrary paths. Only verified ready
  recordings can be added; the server validates registered source ranges on save.
- Primary drops choose the nearest legal ripple slot after temporarily removing
  a moving instance, including retained incoming dissolves. Overlay drops target
  independent row/project placement. Plus/double-click/batch use
  the selected layer; primary insertion appends, overlay insertion starts at the
  playhead, and a batch places its instances consecutively as one history operation.
  Batch cursor positions use each new clip's contextual retiming end. Every path
  copies current source-review ranges, never arbitrary source paths or row points.
- Existing excerpt drags reorder primary IDs or change overlay placement/layer,
  without duplicating media/ranges. The pointer retains the offset where the clip
  was grabbed; selection cannot move the timeline origin underneath it. One shared
  integer-frame plan drives the row-specific placement ghost and committed command.
  The ghost start is the actual post-removal ripple start or independent overlay
  start, and its width is recomputed for the destination row's rate curve at that
  start, not copied from the old placement. A snap guide may mark its contextual
  trailing edge rather than its leading edge.
  Invalid overlap/fade placements have a red ghost/reason and never enter history.
  Edge scrolling updates the same plan; cancellation leaves placement unchanged.
  Unchanged adjacent pairs retain their transition; new pairs become cuts.
- Primary deletion closes the gap; overlay deletion leaves other placements intact.
  Split finds the original source boundary through the placed map and preserves
  independent static colour/opacity/speed, including source-ramp anchors. It creates
  a primary cut or positioned overlay pieces. Each piece retimes/rounds independently,
  so total duration can change. Invalid edits never enter history.
- **Clip actions → Duplicate** / **Ctrl+D** copies the complete source excerpt,
  static grade, opacity and constant/ramp/custom speed into an independent ID. Primary
  duplicates insert after the original with new cut boundaries. Overlay duplicates start immediately
  after the original's contextual end and acquire their own contextual duration;
  occupied placement is rejected atomically.
- **Trim/cut/move/split/duplicate never copy or shift row points.** A primary ripple
  leaves their project times fixed. Moving between rows leaves both rows' points
  intact and evaluates the destination row curve; source/static bases remain independent.
- **Alt+Left/Right** nudges a selected overlay one frame; adding Shift nudges ten.
  Clip actions also exposes frame-nudge buttons. Starts remain nonnegative, occupied
  placement is rejected, and each successful action is one Undo step. Primary clips
  do not gain free placement or frame nudging.
- Session-only Undo/Redo covers clip commands and committed pointer gestures.
  Saved document revisions are managed separately by serial autosave.

## Row points, time ruler and transitions

Schema-5 points belong to the **whole video row**, not individual clips. One ordered
point at a project frame holds independently participating Layer opacity, Clip
opacity, Speed and seven colour settings. Points survive clip trimming/removal and
may remain beyond current duration. Each channel uses the point's shared easing
toward its **next participating point**, holds before/after its own endpoints and
uses its static base only when it has no participation on the row.

The selected layer, including an empty one, has one **Layer keyframes** panel in
Clip. Every setting has a clickable hollow/inactive or filled/active diamond with
`aria-pressed`; inactive is not HTML-disabled. Toggling affects only that channel;
the first participant creates/last removes the point. Animated values are read-only
between participating points until explicitly captured with the diamond; no slider
creates implicit keys. **Edit points** shows dependencies and inner **Time, easing
& values**. Moving its Timeline frame moves all participants and the existing easing
in one Undo step, with collision and contextual timing validation. List input
identity/focus and expansion survive a single-point move and Undo.

Within current duration, each row draws **one marker per point**, with participants
in its title, never per-clip duplicates. **Click or Enter** selects the marker's row
and seeks without editing. **Drag horizontally** to move the shared point:

- Capture the committed project, row/point, zoom, grabbed pointer position,
  horizontal scroll and stationary playhead. Compute from that captured base plus
  scroll travel, round the delta once and clamp to frames **0–2,147,483,647**.
- Validate every target as a complete shared-point move. Valid drafts update
  geometry/paused preview only; history, autosave and the committed document remain
  unchanged until release. A valid release moves all participants/values/easing in
  **one Undo step**, not one operation per channel or pointer event.
- Snap to captured clip/music/transition boundaries and the captured playhead
  within **eight pixels at the captured zoom**; Alt bypasses it. Horizontal edge
  autoscroll retains that geometry and never changes rows or auto-reveals another row.
- An occupied time shows a **red invalid ghost**, never a merge/overwrite, including
  when the destination has unrelated participants. Release reports the error and
  commits nothing, rather than using an earlier valid draft. Speed-related overlap,
  fade or transition conflicts reject the entire move; transitions are never shrunk.
- Escape, pointer cancellation, unexpected lost capture or window blur restores
  preview/document/initial horizontal scroll without a draft save or history entry.

On a focused marker, **Left/Right** moves the point one project frame;
**Shift+Left/Right** moves ten, without snapping. The cursor/focus follows the
point (or returns to Timeline if its marker is now outside duration); ordinary
playhead stepping, clip nudging and other editor shortcuts do not also run.
Shared time-field editing remains available. A dragged point can be stored beyond
duration and stays list-editable, but does not extend the sequence merely for the
point. Moving it copies/shifts no other points, clip/source/static bases or music;
Speed participation may naturally recompile contextual clip durations.

### Channel navigation and off-duration inspection

All ten setting diamonds are immediately followed by native SVG **Previous/Next**
buttons, before any existing reset. They remain visible but disabled without the
relevant neighbour, an opened project, or during any document-preview draft. They seek
strictly earlier/later points where that channel is not `null` (zero included),
skipping unrelated participation. The sidebar Layer opacity controls share the
same context, select their own row and open Clip without stealing button focus.

Setting buttons, row navigation and list time buttons share a central **editor-only
stored-point inspection cursor**. It advances through several off-duration points
instead of repeatedly choosing the same point from a clamped playhead. Preview
uses the nearest available frame, or no preview on an empty timeline; labels
distinguish stored time from actual preview. List fields edit the stored point;
setting values/diamonds/capture still use the real playhead. Manual seek, playback,
row/project changes and deletion of the inspected point clear inspection; valid
single-point movement and Undo preserve the cursor and list input identity.
Navigation/inspection creates no history entry or save and adds no persisted fields.

The thin strip above video rows is the **time ruler**. Its separators/ticks denote
TIME; clicking/dragging seeks. The distinct **Cut / Fade / Dissolve** boundary
buttons open transition settings in Sequence, not keyframe controls. Full point
semantics are in [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Layers and preview

Clip names/selection are instance-based, not A/B slots. The primary layer remains
ripple-edited and first in the bottom-to-top stack. Up to seven overlays have
absolute starts, independent gaps/tails, visibility and opacity; two excerpts cannot
overlap on the same overlay row. Layer order/deletion and movement between rows are
undoable. Primary-only transitions are grouped before applying layer opacity.

A nonempty one-layer project uses **two reusable video elements/textures**; eight
layers use up to **nine** (two primary dissolve sources plus seven overlay sources).
A required instance retains its decoder; only inactive slots may be reassigned.
Next sources per enabled row are speculatively preloaded in free slots. Source
review uses one separate muted/paused decoder, not another timeline slot.

Resource changes invalidate uploaded texture identity and require a newly observed
decoded frame. Direct/rapid seeks cancel obsolete loads and speculative preloads.
The compositor does not upload a stale frame while the target recording loads.
All row opacity/colour channels are evaluated at project time, so grading can change
even on held source frames. Appearance-only edits update rendering without reloading
unchanged timing/music. Source/static-speed/row-Speed/placement edits pause and reload
the placed map; moving/easing a point with Speed participation is also timing-changing.
Dissolve grouping and layer-opacity equations are unchanged. See
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Snapping, projects and music

**Snap** uses an eight-pixel tolerance converted to project frames at the current
zoom. Ruler/playhead scrubbing snaps to video/music boundaries; trim handles also
snap to the original, stationary playhead. Shared-point drags use boundaries and
the stationary playhead captured at pointer down, with their captured zoom throughout
autoscroll. Overlay moves match either leading or trailing edge to other clip/music/
transition boundaries, frame zero or the captured
stationary playhead; their own old edges/transition regions are excluded. Holding
Alt bypasses these magnets. A trailing-edge snap solves a representable contextual
end under the row rate curve, rather than subtracting the old duration. Primary
ripple insertion remains boundary-based even with Snap off or Alt held: contiguous
primary sequencing is not free positioning. The
toggle persists for the current timeline session, not the renderable document.

Projects are named separate **version-5** documents. Switching flushes autosave first,
blocks on failed saves, and resets session selection/history; successful export
snapshots are independent of the open project. Earlier v1/v2/v3/v4 projects and receipt
snapshots remain incompatible and preserved, without migration/fabricated defaults.
Create a new project and deliberately import recordings/music to reuse registered
sources/verified ready proxies. Confirmed project deletion removes only its saved
document, never originals, the shared registry/proxy cache or successful exports/
receipts. Removing an excerpt is not removing that recording from the import bin. The
existing live v3 sample appearing incompatible is expected.

The music waveform is registered/prepared by the backend. Its placement and trim
gestures are transient and one-step undoable. Numeric controls provide source
IN/OUT, placement/duration, gain, fades and explicit looping. Music is not retimed
with video; its own clock drives synchronisation while active.

## Media browser and interface scope

The default compact list has small thumbnails and independent vertical scrolling;
the alternative grid uses two columns. Search is always visible; **Media options**
holds sort (name/duration/newest), readiness/usage filters and List/Grid. Checkboxes,
Ctrl-click and Shift-click support selection; batch actions appear only with a
selection. User imports automatically queue eligible proxies through one heavy
worker, reusing ready/in-flight work. Manual preparation remains for legacy
unprepared sources and explicit failed/cancelled retries; manual batches confirm
before starting multiple jobs. Startup and hover never queue old recordings.

Prepared recording buttons hover-scrub across the complete source range and show
a mouse-following marker. The source viewer is separate from the project playhead
and stays out of list flow so rows never move under an active hover/drag. Review
IN/OUT handles, numeric Apply, I/O marks and Reset are non-destructive. OUT is
exclusive; handle drafts cancel/release independently of timeline history/autosave.
Choices persist per project in that browser and affect future insertions only.
Source **Add excerpt** stays in the pinned review for repeated additions. Its
sticky header and native nonmodal excerpt popup keep adding/reviewing reachable
without a tall list shrinking the preview or moving controls. Media
plus/double-click/drop, explicit Show, selection and timeline edits return to Timeline.
Close/hidden/offscreen/project switch releases the one review decoder.

The normal editor shows Media, Preview, the contextual inspector and Timeline.
Panels are resizable/collapsible with browser-local layout persistence; source
review occupies a docked viewer tab rather than covering the workspace. Numeric
inspector fields commit on Enter/blur, retain invalid drafts for correction and
support Escape. Source-review paired IN/OUT retains its explicit Apply workflow.
**Clip / Sequence / Audio** separates source/appearance/speed, transitions/fades and
music. The header directly exposes panel toggles and help; **Workspace options**
holds layout reset and Diagnostics. **Layer options**
holds rename/opacity/stacking/deletion; **Clip actions** holds duplication/nudging,
while the frequent split/trim/delete/cut actions stay directly visible.
Diagnostic counters, shader tests and the two-clip native comparison tool remain
hidden behind Diagnostics. **Export** uses the bounded native multi-clip
renderer, with profiles for 720p drafts and 4K finals. The diagnostic two-excerpt
reference remains limited to normal speed without music/extra layers/nontrivial
opacity/shared row points, including Speed-only points.
Clip sections collapse independently and retain expansion across reloads; collapsing
a section never disables its processing.
Keyboard help, context guards, Activity and save/connection recovery are documented
in [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).

GPU performance remains unvalidated on the intended discrete GPU, per the user's
request. Disposable browser regressions target correctness, not embedded-GPU speed;
the completed no-copy schema-5 **886-test** milestone, former-copy **909-test**
baseline and prior v3/v4 verification are historical evidence in
[DELIVERY_STATUS.md](DELIVERY_STATUS.md). The **982-test** marker/navigation and
**1,039-test** UX-hardening runs retain their historical evidence; current clip-speed
results are recorded separately there. Local Docker/Podman packaging is planned, not
implemented; hardware and real-duration gates are tracked in [ROADMAP.md](ROADMAP.md).


