# Timeline editing

## Source footage and excerpt instances

Appearance is row-owned: complete required `layer.colour` plus the sole Opacity,
with shared project-time keys. Every clip on the same row shares Colour with or
without keys; different treatments require different rows. Moving adopts destination
appearance; trim/split/cut/duplicate preserve row bases and absolute points.
Main Colour edits work on empty rows. There is no clip colour/correction field.
Temperature and Tint are row-owned −1…1 scalars, neutral 0, with independent
explicit key capture. Positive Temperature warms; positive Tint adds magenta.
Their normalized linear gains precede Exposure and intentionally colour greys.
HSL/curves remain static. See [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
See [row appearance](design/ROW_APPEARANCE.md).

The media library describes complete recordings belonging to the open project's
bin, not every globally registered source. Strict schema 12 requires unique
`media.videoIds` and `media.audioIds` arrays (10,000 IDs maximum each). Imports add
membership even without timeline placement; clip/music references also remain
visible. New projects start with both arrays empty. **Remove from project** (the
trash on a Media card, on the selection header for a selection, or beside
**Audio → Music → Recording**) removes only that bin membership in one Undo step.
A recording still used by excerpts or music instances first asks for confirmation
with their counts, then removes those placements in the same step; Ripple rows
close the gaps as ordinary deletions do. Originals, registry entries, proxies,
thumbnails, PCM caches, other projects and exports are untouched; a deliberate
re-import makes it available again. Importing an existing source
deliberately reuses the global content-deduplicated registry/proxy cache; switching
projects never automatically adopts that global library. An insertion creates
a unique clip-instance ID and copies the latest media-review IN/OUT, or
`sourceIn = 0`, `sourceOut = registered frameCount` without a choice. New clips have
normal constant speed and a complete neutral spatial base
with no spatial keys, with no saved opacity field.
They use the destination row's `opacity` value or its overriding Opacity keys.
New clips start without custom speed or spatial keys; existing row curves immediately apply at their project placement.
The original and full proxy remain unchanged; no extra crop file is generated.
Multiple insertions of one recording have independent source ranges,
clip speed and spatial settings.

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
Clip spatial animation uses the same map's continuous `sourcePositionAt` for
geometry and integer `sourceAt` for the recorded image. Transform edits do not
change placement or duration; slow motion can move geometry on a held image
without optical flow. See [spatial transforms](design/SPATIAL_TRANSFORMS.md).

Project duration is the maximum of all retimed clip ends (including hidden
layers) and every independent music instance's start + duration. Music can extend
the project. After the last active video clip OUT, preview/export is opaque black,
not a frozen last image, while music continues/fades to its own OUT. Each video
closing fade remains inside its last clip and ends at that clip's OUT. Music-only
preview is allowed; export still requires at least one video clip.

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

Strict schema 12 requires complete row colour with Temperature/Tint and static HSL/curves, clip spatial settings, per-track Ripple, transitions and fades, and a required
0–8 identified-instance `music` array (`[]` without music); registry/proxy/PCM
formats are unchanged. Only generated proxies/thumbnails, metadata,
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
- With Ripple on, a committed trim continuously re-sequences later clips on that
  track from the existing first anchor. With Ripple off, a left
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
  even when a long beginning was omitted from the first excerpt. Release
  removes the temporary gutter; cancellation restores its initial scroll and document.
  No negative project start is stored. Right-edge autoscroll likewise exposes tails.
  Home/End and numeric source fields remain available for exact restoration.
- Numeric IN/OUT and **Restore full recording** share the same source and
  transition validation as handles.
- Trim/restoration never copies or shifts row points. Original-source static ramp
  anchors are retained; the row animation override continues across the new range.
  Clip spatial keys also retain original-source positions, including outside the
  new trim and at the original exclusive OUT; restoring a range restores access
  to those unchanged anchors, not a rewritten animation.

The selected excerpt's left/right trim edges are keyboard sliders. Arrow keys
move by one original source frame; Shift moves by ten. Home at the left edge requests
IN=0; End at the right edge requests the original OUT. A Ripple-off left restoration
cannot extend before project frame zero or silently change its retained timeline
OUT; source/placement quantisation and normal overlap/fade validation still apply.

## Cutting an unwanted part

The timeline's visible rush-edit controls expose **Split**, **Trim start**, **Trim end**,
Delete and **IN / OUT / Cut range** in the existing responsive toolbar, not another
row covering the lanes. It identifies **Ripple track** versus **Positioned track**
from that track's own Ripple setting, not its row number or identity.

- **Split / S** maps the playhead through the placed retiming map and creates two
  independent excerpts. On success the right piece is selected and its beginning
  previewed, ready for another split/trim/delete. Invalid splits preserve selection
  and history. The playhead must be strictly inside the excerpt's source range.
- **Trim start / Q** discards footage before the displayed source frame; **Trim
  end / W** discards footage after it, keeping that frame via source OUT = frame + 1.
  Ripple-on left trims keep their sequence start and recompile later clips;
  Ripple-off left trims retain their old OUT when representable.
  These are shrinking operations. Handles or Restore full recording recover omitted
  footage. Repeating an unchanged endpoint trim adds no history entry.
- With one excerpt selected, seek the first unwanted timeline frame and **IN / I**,
  then seek the last unwanted frame and **OUT / O**. OUT is stored as playhead + 1,
  exclusive. A hatched overlay, IN/OUT markers and timecode readout show the range.
  **Cut range / Shift+Delete** removes it atomically in **one Undo step**.
- Middle removal keeps a left excerpt with the original ID and a right excerpt with
  a fresh ID. Prefix/suffix removal keeps only the retained excerpt; a whole-range
  removal deletes it. Retained pieces share the original media but have independent
  ranges/settings, including original-source ramp anchors and deep-copied spatial
  base/full-pose keys. Off-trim and original exclusive-OUT anchors remain stored.
  No proxy is cut.
- With Ripple on, the track closes the removed gap and recalculates later starts/durations
  without changing their order, original-source ranges or static settings. The new
  left/right boundary is a cut. Existing valid incoming/outgoing transitions are
  retained/reanchored; fades are never silently shortened to make an invalid edit fit.
- With Ripple off, a cut keeps the removed gap and other clips' absolute placements. Its
  retained right piece starts at the original contextual output position of the
  retained source IN. Each piece retimes/rounds independently, like a mapped split;
  invalid overlap/quantisation is rejected. Ripple assembly is available on any track.
- Missing/reversed/outside marks and slow-motion ranges containing no original
  source frame cannot remove footage. Mark controls require the playhead within
  the selected excerpt; errors preserve document/history and valid existing marks.
- Marks are transient editor state, not autosaved/rendered fields. Clear/Escape,
  changing the selected excerpt/empty row, timing edits, Undo/Redo and project changes
  clear them. Source-review I/O controls are a separate context and never edit these
  marks or the timeline. Form/modal/slider/popover keyboard guards still apply.

Music, other tracks and row points do not follow a track's Ripple edits. Their absolute
project times remain fixed; row animation may therefore evaluate different footage
after sequencing changes. No migration or movement of animation anchors occurs.

## Insertion, reordering and history

One to eight uniform tracks display in saved **bottom-to-top composition order**:
row 1 renders below row 2, row 3 above row 2, and so on. There is no primary/overlay
editing role or required first-track ID. Tracks and layer headers have synchronized native vertical scrolling.
The ruler, playhead handle and timecode remain pinned above scrolling rows. Ticks
follow horizontal scroll; a ruler click/drag still maps to the exact timeline
frame. Scrolling creates no seek/history/save, and a drop on the ruler cannot
target a row hidden underneath it.

Every new track starts with **Ripple on**. **Layer options → Ripple** enables a
continuous packed sequence, not just a policy for future edits. Enabling sorts
current placements chronologically and closes gaps in **one Undo step**, preserving
the first clip's current start and valid existing dissolves. Later starts follow
the preceding contextual OUT minus incoming dissolve duration; commands persist
actual integer placements. Structural edits retain the pre-edit first anchor even
if a different clip becomes first. Turning Ripple off captures actual starts for
independent placement; it does not restore former gaps. Both directions are atomic
and undoable, and never move music, other tracks or absolute row points.

- Media drags carry registered IDs, not arbitrary paths. Only verified ready
  recordings can be added; the server validates registered source ranges on save.
- Ripple-on drops choose the nearest legal sequence slot after temporarily removing
  a moving instance, including retained incoming dissolves. Ripple-off drops target
  independent row/project placement. Plus/double-click use
  the selected layer; Ripple-on insertion appends, Ripple-off insertion starts at the
  playhead. Dragging any recording of a Media multi-selection drops every selected
  ready recording consecutively as one history operation.
  Batch cursor positions use each new clip's contextual retiming end. Every path
  copies current source-review ranges, never arbitrary source paths or row points.
- Existing excerpt drags reorder a Ripple-on track or change independent placement/track,
  without duplicating media/ranges. The pointer retains the offset where the clip
  was grabbed; selection cannot move the timeline origin underneath it. One shared
  integer-frame plan drives the row-specific placement ghost and committed command.
  The ghost start is the actual post-removal sequence start or independent
  start, and its width is recomputed for the destination row's rate curve at that
  start, not copied from the old placement. A snap guide may mark its contextual
  trailing edge rather than its leading edge.
  Invalid overlap/fade placements have a red ghost/reason and never enter history.
  Edge scrolling updates the same plan; cancellation leaves placement unchanged.
  Unchanged adjacent pairs retain their transition; new pairs become cuts.
- Ripple-on deletion closes the gap; Ripple-off deletion leaves other placements intact.
  Split finds the original source boundary through the placed map and preserves
  independent clip speed, including source-ramp anchors. Row Colour and Opacity are
  unchanged and apply to both pieces. It creates a cut between the pieces on
  that track. Each piece retimes/rounds independently,
  so total duration can change. Invalid edits never enter history.
- **Clip actions → Duplicate** / **Ctrl+D** copies the complete source excerpt,
  constant/ramp/custom speed and deep-copied spatial base/keys into
  an independent ID; it does not
  copy or change row Colour/Opacity. Ripple-on duplicates insert after the original with
  new cut boundaries. Ripple-off duplicates start immediately
  after the original's contextual end and acquire their own contextual duration;
  occupied placement is rejected atomically.
- **Trim/cut/move/split/duplicate never copy or shift row points.** Track Ripple
  leaves their project times fixed. Moving between rows leaves both rows' points
  and saved Opacity values intact, using the destination row value or curve;
  source ranges, clip speed and spatial settings remain independent.
  Splits/cuts/duplicates copy complete spatial poses and key arrays independently;
  trims/moves/Ripple never shift, rescale or discard their original-source anchors.
- **Alt+Left/Right** nudges a positioned clip or the first Ripple anchor one frame;
  adding Shift nudges ten. Clip actions also exposes frame-nudge buttons, and
  Clip → Placement has **Timeline start frame** on every track. Later Ripple
  starts are derived and disabled with an accessible reason: drag to reorder or
  turn Ripple off for independent placement. Moving the first anchor while it
  remains first re-sequences its track. Starts remain nonnegative, conflicts reject
  the whole edit, and each successful action is one Undo step.
- Session-only Undo/Redo covers clip commands and committed pointer gestures.
  Saved document revisions are managed separately by serial autosave.

## Row points, time ruler and transitions

Schema-12 shared row points belong to the **whole video row**, not individual clips. One ordered
point at a project frame has eleven required nullable channels: **Opacity**
(`opacity`), Speed and nine scalar colour settings, participating independently.
In control order: `opacity`, `speed`, `temperature`, `tint`, `exposure`,
`brightness`, `contrast`, `hue`, `saturation`, `highlights`, `shadows`.
Static HSL/curves are not animation channels.
Every `VideoLayer` also requires numeric `opacity` in 0–1, initially 1 (100%) on
new tracks. Without Opacity keys, every clip uses the row value; keys override it
on every clip in the row, including both dissolve sources. There is no saved
`clip.opacity`, second opacity channel or additional layer multiplier.
Points survive clip trimming/removal and may remain beyond current duration.
Each channel uses the point's shared easing
toward its **next participating point**, holds before/after its own endpoints and
uses its unkeyed value only when it has no participation on the row: the saved row
value for Opacity, row colour for colour, and individual clip speed for Speed.

The selected layer, including an empty one, has one **Keyframes** tab (accessible
name **Layer keyframes**) with its directly visible shared point list. Clip keeps
the playhead setting controls. Every setting has a clickable hollow/inactive or filled/active diamond with
`aria-pressed`; inactive is not HTML-disabled. Toggling affects only that channel;
the first participant creates/last removes the point. Animated values are read-only
between participating points until explicitly captured with the diamond; no slider
creates implicit keys. Keyframes shows dependencies and inner **Time, easing
& values**. Moving its Timeline frame moves all participants and the existing easing
in one Undo step, with collision and contextual timing validation. List input
identity/focus and expansion survive a single-point move and Undo.

Each row draws **one marker per stored point**, with participants in its title,
never per-clip duplicates; points after the last clip keep their markers there
without extending playback. **Click or Enter** selects the marker's row
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
point; ordinary playhead stepping, clip nudging and other editor shortcuts do not
also run.
Shared time-field editing remains available. A dragged point can be stored beyond
duration and stays list-editable, but does not extend the sequence merely for the
point. Moving it copies/shifts no other points, row values, clip settings/source ranges or music;
Speed participation may naturally recompile contextual clip durations.

### Channel navigation and off-duration inspection

All eleven setting diamonds are immediately followed by native SVG **Previous/Next**
buttons, before any existing reset. They remain visible but disabled without the
relevant neighbour, an opened project, or during any document-preview draft. They seek
strictly earlier/later points where that channel is not `null` (zero included),
skipping unrelated participation. **Clip → Colour** contains the single **Opacity**
slider/exact `NumberField`/diamond/navigation alongside the colour controls.
The numeric value uses **0–1**, initially **1**; the main label may show **100%**.
Its buttons visit `opacity` participants, with no sidebar duplicate.
Without Opacity keys, either value control edits row `opacity` and works on an empty row.
With keys, a missing participant at the real playhead stays read-only until its
diamond captures it; sliders never create implicit keys. Unkeyed colour remains
row-owned with or without keys. Opacity affects composition coverage, not SDR RGB grading.
**Clip → Placement** contains placement only. Layer options remains limited to
rename, Ripple, ordering and deletion, with visibility separate.

Setting buttons, row navigation and list time buttons share a central **editor-only
stored-point inspection cursor**. It advances through several off-duration points
instead of repeatedly choosing the same point from a clamped playhead. Preview
uses the nearest available project frame, black in a music-only region, or no
preview without video or music duration; labels
distinguish stored time from actual preview. List fields edit the stored point;
setting values/diamonds/capture still use the real playhead. Manual seek, playback,
row/project changes and deletion of the inspected point clear inspection; valid
single-point movement and Undo preserve the cursor and list input identity.
Navigation/inspection creates no history entry or save and adds no persisted fields.

The thin strip above video rows is the **time ruler**. Its separators/ticks denote
TIME; clicking/dragging seeks. The distinct **Cut / Fade / Dissolve** boundary
buttons open transition settings in Sequence, not keyframe controls. Full point
semantics are in [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

Every track owns its boundary list and opening/closing fades, edited in **Sequence**
for the selected track. Exactly one record joins each adjacent pair. Cut permits a
gap; non-cut transitions require touching clips or that pair's existing dissolve.
Gapped pairs explain the disabled non-cut choices: explicitly close the gap or
enable that track's Ripple first. Cross-dissolve duration explicitly sets the right
start to left OUT minus duration; changing/removing an existing dissolve changes
that overlap. Ripple on re-sequences the suffix; off changes only the paired right
clip and rejects conflicts with others. Arbitrary/triple overlap is forbidden.
Fade-through-black keeps a touching boundary without overlap. Track opening/closing
fades apply at actual first/last placements, darken only that row's RGB and preserve
coverage. Empty tracks retain dormant fades; adding footage validates them again.
No edit silently shortens fades/transitions to fit.

## Layers and preview

Clip names/selection are instance-based, not A/B slots. Every track has independent
Ripple, transitions/fades, visibility and a required row `opacity` value overridden
only by that row's `opacity` keys. Any track can be deleted except
the last remaining one; Raise/Lower are limited only by composition endpoints and
active interaction state. Track order/deletion and cross-track moves are undoable.
Each track's dissolve is one premultiplied group; simultaneous dissolves on
different tracks are allowed. With graded RGB $G_i$, black-fade brightness $b_i$,
evaluated Opacity $o_i$, dissolve weight $w_i$ and spatial coverage $m_i$, the group has
$C = \sum_i G_i b_i o_i w_i m_i$, $A = \sum_i o_i w_i m_i$ and source-over
$\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no layer multiplier.
At a project frame, each source uses the same evaluated row Opacity, from the
saved row value or overriding `opacity` curve; it is not applied again to the group.
Nonneutral transformed/cropped pixels outside the original have zero coverage;
exact neutral poses retain the old opaque black letterboxing after grading.

A nonempty one-layer project uses **two reusable video elements/textures**; eight
tracks use **16**, two slots per track, never one per stored clip.
A required instance retains its decoder; only inactive slots may be reassigned.
Next sources per enabled row are speculatively preloaded in free slots. Source
review uses one separate muted/paused decoder, not another timeline slot.

Resource changes invalidate uploaded texture identity and require a newly observed
decoded frame. Direct/rapid seeks cancel obsolete loads and speculative preloads.
The compositor does not upload a stale frame while the target recording loads.
All row opacity/colour channels use project time, so coverage and grading can change
even on held source frames. Appearance-only edits update rendering without reloading
unchanged timing/music. Source/static-speed/row-Speed/placement edits pause and reload
the placed map; moving/easing a point with Speed participation is also timing-changing.
Opacity and spatial changes remain appearance-only; continuous spatial geometry
can change on a held recorded image. Black fades preserve coverage and grouped
dissolves use the source-over contract above. See
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Snapping, projects and music

**Snap** uses an eight-pixel tolerance converted to project frames at the current
zoom. Ruler/playhead scrubbing snaps to video/music boundaries; trim handles also
snap to the original, stationary playhead. Shared-point drags use boundaries and
the stationary playhead captured at pointer down, with their captured zoom throughout
autoscroll. Ripple-off moves match either leading or trailing edge to other clip/music/
transition boundaries, frame zero or the captured
stationary playhead; their own old edges/transition regions are excluded. Holding
Alt bypasses these magnets. A trailing-edge snap solves a representable contextual
end under the row rate curve, rather than subtracting the old duration. Ripple-on
insertion remains boundary-based even with Snap off or Alt held; only an explicit
move of its retained first clip changes the anchor. The
toggle persists for the current timeline session, not the renderable document.

Projects are named separate **version-12** documents with complete required row colour, clip spatial
base/full-pose source-frame keys and per-layer Ripple,
transitions, opening/closing fades and numeric `opacity` in 0–1. New layers start
at 1 (100%); a missing saved field is invalid. Switching flushes autosave first,
blocks on failed saves, and resets session selection/history; successful export
snapshots are independent of the open project. Earlier v1–v11 projects and receipt
snapshots remain incompatible and preserved, without migration/fabricated defaults.
There is no automatic deletion. Row `opacity` is the required sole stored value;
saved `clip.opacity` and old `clipOpacity`/`layerOpacity` point fields are rejected,
not ignored or defaulted. Points require exactly eleven nullable channels: `opacity`,
`speed` and nine scalar colour fields, including required `temperature` and `tint`.
Row Colour requires both bases and static HSL/curves; missing fields are invalid.
Recreate projects and deliberately import recordings/music
to reuse registered sources/verified ready proxies. Confirmed project deletion removes only its saved
document, never originals, the shared registry/proxy cache or successful exports/
receipts. Removing an excerpt is not removing that recording from the import bin;
use **Remove from project** for that. The
existing live v3 sample appearing incompatible is expected. Registry/proxy formats
are unchanged.

The required `music` array holds **0–8 independent instances**, each with a unique
required `id`, registered `mediaId`, source IN/OUT, start/duration, gain, fades and
loop flag. No null/singular fallback, omitted-field default or old-format reader
is accepted. Version-1 export receipts require a strict v12 snapshot and captured
audio-source/instance-plan arrays; older snapshots/invalid arrays are rejected
while the receipt and finished output remain preserved. Current PCM format is unchanged.

Each music instance has its own backend-prepared waveform and timeline lane.
**Audio → Music → Music track** selects the instance; **Add music track** uses a
ready/prepared Recording and the selected-track trash action removes only that
placement. Import never implicitly places music. Selection creates no save/history
entry, and editing/removing one instance leaves all others and imported media intact.
Independent drafts cannot apply to another instance. Placement/trim gestures are
transient and commit once; each accepted edit/add/remove is one Undo step.
Invalid release/cancellation is atomic with no committed draft/history/save.
Numeric controls provide source IN/OUT, placement/duration and fades; gain uses a
native slider with an exact `NumberField`, and looping is explicit per instance.
Music is not retimed or rippled with video. All instances sum linearly after their
gain/fades and clamp once after the complete mix; one AudioContext/worklet/output
clock drives synchronisation, never per-instance clocks or queues.
See [the multiple-music contract](design/MULTIPLE_MUSIC.md).

## Media browser and interface scope

The default compact list has small thumbnails and independent vertical scrolling;
the alternative grid uses two columns. Each thumbnail maps the whole original
(frame 0 left, exclusive OUT right) and hatches the head/tail omitted by the
recording's applied source-review range, without a text badge; the exact frames
are the review button's accessible description. Unapplied numeric drafts and
existing excerpts do not change it. Search is always visible; **Media options**
holds sort (name/duration/newest), readiness/usage filters and List/Grid. A plain
click reviews a recording without selecting it; checkboxes, Ctrl-click and
Shift-click select. With two or more selected, the **Select all** row shows the
count with **Prepare** (when needed), remove and **Clear selected**, without
a separate footer or Add button. Unprepared cards say **Not prepared** under their
name. User imports automatically queue eligible proxies through one heavy
worker, reusing ready/in-flight work. Manual preparation remains for legacy
unprepared sources and explicit failed/cancelled retries; manual batches confirm
before starting multiple jobs. Startup and hover never queue old recordings.

Prepared recording buttons hover-scrub across the complete source range and show
a mouse-following marker. The source viewer is separate from the project playhead
and stays out of list flow so rows never move under an active hover/drag. Review
IN/OUT handles, numeric Apply and I/O marks are non-destructive. OUT is
exclusive; handle drafts cancel/release independently of timeline history/autosave.
There are no separate Mark IN/OUT or Reset buttons: Home/End on a handle restores
that edge. Invalid numeric drafts keep an inline error until Apply or Cancel.
The source track below the image spans the whole original with its five prepared
snapshots; hatching identifies omitted footage and timeline-style **IN / OUT**
handles (24 px pointer targets) trim, while the rest of the track scrubs. Drag
feedback previews IN or the last included frame (OUT − 1) with an overlay hint on
the image; Escape, pointer cancellation, capture loss or window blur restores the
applied range and prior source frame. Missing snapshots degrade to an explicit
**Snapshots unavailable** track without starting preparation.
The round **Play / Pause** button at the left of the source track plays only the
verified muted proxy within the applied range,
from the current observed frame if it precedes the last included frame, otherwise
from IN. It stops and seeks exactly OUT − 1, without looping or audio. A one-frame
range simply displays that frame. Numeric drafts do not change the played range.
Scrubbing, trimming, marking and Apply pause first; closing, hiding, switching
recordings/projects or leaving Source preview cancels pending playback and releases
its sole decoder. Loading/playback failures remain explicit with Retry. Source
playback never moves the timeline/music, changes excerpts/row points or saves/history.
Choices persist per project in that browser and affect future insertions only.
Source **Add excerpt** stays in the pinned review for repeated additions. Its
sticky header and native nonmodal excerpt popup keep adding/reviewing reachable
without a tall list shrinking the preview or moving controls. Media
plus/double-click/drop, explicit Show, selection and timeline edits return to Timeline.
Close/hidden/offscreen/project switch releases the one review decoder.

The normal editor shows Media, Preview, the contextual inspector and Timeline.
Panels are resizable/collapsible with browser-local layout persistence; source
review occupies a docked viewer tab rather than covering the workspace. Main and
stored Colour/Opacity/Transform values, playback rates and gain share native sliders with
adjacent exact `NumberField` controls, not read-only outputs or number-only layouts.
Pointer sliding changes only a local control draft; release applies one validated
document edit and updates the image. Escape, pointer cancellation, lost capture or
window blur restores the starting value without save/history. Each keyboard slider
adjustment is an individual validated edit. Numeric fields retain full entered
precision, commit on Enter/blur, keep invalid drafts editable and restore on Escape.
Integer source/placement frames, durations and fades retain exact native numeric
steppers and existing timecode feedback, without arbitrary timing sliders.
Source-review paired IN/OUT retains its explicit Apply workflow.
**Clip / Keyframes / Sequence / Audio** separates source/appearance/speed/Transform, the
whole-row point list, transitions/fades and music. The header directly exposes
panel toggles and help; **Workspace options**
holds layout reset and Diagnostics. **Layer options**
holds only rename/Ripple/stacking/deletion; **Clip actions** holds duplication/nudging,
while the frequent split/trim/delete/cut actions stay directly visible.
Diagnostic counters, shader tests and the two-clip native comparison tool remain
hidden behind Diagnostics. **Export** uses the bounded native multi-clip
renderer, with profiles for 720p drafts and 4K finals. The diagnostic two-excerpt
reference remains limited to two normal-speed clips on one enabled,
zero-origin contiguous track with row Opacity 1 and neutral spatial bases without
spatial keys, without music/extra tracks/shared row points,
including Speed-only points, and at most 3,600 project frames.
Clip sections collapse independently and retain expansion across reloads; collapsing
a section never disables its processing.
Keyboard help, context guards, Activity and save/connection recovery are documented
in [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).

Disposable browser regressions target correctness, not intended-GPU speed or
real-duration throughput. Intended-GPU preview and consented real-flight/long-run
qualification are tracked in [#6](https://github.com/Plonk42/PasCap/issues/6),
[#7](https://github.com/Plonk42/PasCap/issues/7) and
[#8](https://github.com/Plonk42/PasCap/issues/8).
Local Docker/Podman packaging is planned, not implemented; networking, packaging
and both-runtime acceptance belong to
[#9](https://github.com/Plonk42/PasCap/issues/9),
[#10](https://github.com/Plonk42/PasCap/issues/10) and
[#11](https://github.com/Plonk42/PasCap/issues/11), with the contract in
[DEPLOYMENT.md](DEPLOYMENT.md). Actual-commit correctness results are available in
[GitHub Actions](https://github.com/Plonk42/PasCap/actions).

Row Colour includes static **HSL ranges** and **Colour curves** in nested Clip → Colour sections. They affect every excerpt and both dissolve sources on the row, whether or not its nine scalar channels are keyed. Moves use the destination row's complete colour; clip edits never copy these settings. They are not speed curves or new animation channels. See [the schema-12 HSL/curves contract](design/HSL_AND_CURVES.md).
