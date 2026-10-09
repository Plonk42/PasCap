# Timeline editing

## Recordings, ranges and clips

Appearance is video track-owned: complete required `layer.colour` plus the sole Opacity,
with shared project-time keyframes. Every clip on the same track shares Colour with or
without keyframes; different treatments require different tracks. Moving adopts destination
appearance; trim/split/cut/duplicate preserve track bases and absolute keyframes.
Main Colour edits work on empty tracks. There is no clip colour/correction field.
Temperature and Tint are track-owned −1…1 scalars, neutral 0, with independent
explicit keyframe capture. Positive Temperature warms; positive Tint adds magenta.
Their normalized linear gains precede Exposure and intentionally colour greys.
HSL/curves remain static. See [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
See [track appearance](design/ROW_APPEARANCE.md).

The media library describes complete recordings belonging to the open project's
bin, not every globally registered source. Strict schema 12 requires unique
`media.videoIds` and `media.audioIds` arrays (10,000 IDs maximum each). Imports add
membership even without timeline placement; clip/music references also remain
visible. New projects start with both arrays empty. **Remove from project** (the
trash on a Media card or music file, or on the selection header for a selection)
removes only that bin membership in one Undo step.
A recording still used by clips or music tracks first asks for confirmation
with their counts, then removes those placements in the same step; Ripple tracks
close the gaps as ordinary deletions do. Originals, registry entries, proxies,
thumbnails, PCM caches, other projects and exports are untouched; a deliberate
re-import makes it available again. Importing an existing source
deliberately reuses the global content-deduplicated registry/proxy cache; switching
projects never automatically adopts that global library. An insertion creates
a unique clip-instance ID and copies the latest media-review IN/OUT, or
`sourceIn = 0`, `sourceOut = registered frameCount` without a choice. New clips have
normal constant speed and a complete neutral spatial base
with no spatial keyframes, with no saved opacity field.
They use the destination track's `opacity` value or its overriding Opacity keyframes.
New clips start without custom speed or spatial keyframes; existing track curves immediately apply at their project placement.
The original and full proxy remain unchanged; no extra crop file is generated.
Multiple insertions of one recording have independent source ranges,
clip speed and spatial settings.

For several clips from one recording, set source IN/OUT and **Add clip**, then
mark the next range and add again. Successful additions leave **Source preview** pinned
to the same recording/frame, with the applied range unchanged and explicit success
feedback: **Clip added · mark another range**. The source is not unmounted/reloaded
for each addition. Failed insertion keeps the review/range and never reports success.
**Add clip** (labelled with the applied
range length) and a compact **Show N clips** popover stay in the sticky source header, including on
short laptop screens; opening the list does not resize source review. The popup
shows original ranges/tracks; Escape closes just the popup and **Show** selects, seeks and horizontally
reveals that clip. Library reuse badges count clips, not duplicate recording files.

Timeline source OUT is exclusive. Integer frames at 30000/1001 remain the
authoritative stored timing; displayed seconds are derived, not accumulated.
Output duration/source sampling uses each authoritative **`PlacedClip.retiming`**,
not the raw source-range length at non-1× speed. A video track Speed curve uses absolute
project time and can give the same clip range a different duration at another
start/track. Without keyed Speed settings, the clip's static constant/source-ramp
map applies. See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md).
Clip spatial animation uses the same map's continuous `sourcePositionAt` for
geometry and integer `sourceAt` for the recorded image. Transform edits do not
change placement or duration; slow motion can move geometry on a held image
without optical flow. See [spatial transforms](design/SPATIAL_TRANSFORMS.md).

Project duration is the maximum of all retimed clip ends (including hidden
tracks) and every independent music track's start + duration. Music can extend
the project. After the last active video clip OUT, preview/export is opaque black,
not a frozen last image, while music continues/fades to its own OUT. Each video
closing fade remains inside its last clip and ends at that clip's OUT. Music-only
preview is allowed; export still requires at least one video clip.

## Importing recordings from the filesystem

Create/open a project, then choose **Import → Browse recordings**. Its default is
a service-side browser, not an operating-system file picker. Choose an approved root,
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

Strict schema 12 requires complete video track colour with Temperature/Tint and static HSL/curves, clip spatial settings, per-track Ripple, transitions and fades, and a required
0–8 identified music track `music` array (`[]` without music); registry/proxy/PCM
formats are unchanged. Only generated proxies/thumbnails, metadata,
exports/receipts and scratch are created, not duplicate originals. Keep originals
accessible at their registered paths: moving files or disconnecting a drive fails
explicitly, even with a proxy; there is no implicit guessing/reassociation and an
explicit relink workflow is pending. Previously copied source files from the
removed implementation are not automatically deleted or migrated: preserve their
registered paths and bytes. This is data safety, not compatibility code.

## Non-destructive trim gestures

These timeline-edge gestures use output-frame geometry; the Clip inspector's
original-source range controls have the separate contract below.

- Pointer down captures the handle, pauses preview and snapshots the committed
  document and frame/pixel scale.
- Pointer movement computes output-frame delta from the original pointer position,
  including horizontal scroll. The contextual placed map converts the requested
  output-duration change back to a recoverable original endpoint; drafts do not
  accumulate rounding or rescale track keyframes.
- A left drag changes IN; a right drag changes OUT. Bounds come from registered
  media metadata, **never the previously shortened clip duration**.
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
  OUT holds, including under a track rate curve. If integer-frame quantisation cannot
  represent that retained OUT, the trim is explicitly rejected rather than moving
  it silently. Right trims leave the start fixed. Inspector source edits keep placement.
  The selected original's dashed extent appears during trim hover/focus/drafts,
  independently of the Clip inspector's full-original **Range** bar.
- The timeline origin stays fixed rather than shifting when a clip is selected.
  On a left-handle gesture only, recoverable headspace is reserved and scroll is
  compensated before paint: pointer/frame-zero positions do not jump at gesture start.
  Keeping the pointer inside the left viewport edge autoscrolls through that headspace,
  even when a long beginning was omitted from the first clip. Release
  removes the temporary gutter; cancellation restores its initial scroll and document.
  No negative project start is stored. Right-edge autoscroll likewise exposes tails.
  Home/End and exact source fields remain available for exact restoration.
- Inspector IN/OUT and **Restore full recording** share the same source and
  transition validation as handles.
- Trim/restoration never copies or shifts track keyframes. Original-source static ramp
  anchors are retained; the track animation override continues across the new range.
  Clip spatial keyframes also retain original-source positions, including outside the
  new trim and at the original exclusive OUT; restoring a range restores access
  to those unchanged anchors, not a rewritten animation.

The selected clip's left/right trim edges are keyboard sliders. Arrow keys
move by one original source frame; Shift moves by ten. Home at the left edge requests
IN=0; End at the right edge requests the original OUT. A Ripple-off left restoration
cannot extend before project frame zero or silently change its retained timeline
OUT; source/placement quantisation and normal overlap/fade validation still apply.

### Clip inspector Range

One full-original range bar hatches omitted footage and has draggable **IN / OUT**
handles. Exact **Source IN / OUT** text fields sit below the respective ends,
displaying **HH:MM:SS:FF** (30 fps NDF). They accept whole original-frame numbers
or timecode on Enter/blur; OUT remains exclusive. Empty, malformed, fractional,
out-of-original or conflicting ranges retain editable inline errors, never clamp
or silently round; Escape restores. There are no duplicate section duration,
original-length, source-frame or recoverable head/tail labels. **Restore full
recording** remains available.

Both fields and bar handles use ordinary source-range trim: the selected clip's
placement stays fixed in either Ripple mode; Ripple re-sequences its suffix
normally. They do not use the timeline left handle's retained-OUT rule above.
Source bounds, at least one retained frame, retiming and transition/fade validation
remain authoritative; original speed/spatial anchors and track keyframes stay unchanged.

Dragging previews the complete validated document, including contextual layout
and paused preview, without history/autosave. A final valid release commits one
Undo step; an unchanged range adds none. Invalid final release, Escape, pointer
cancellation, lost capture or window blur restores the starting document/preview,
never commits an earlier valid draft. Focused handle arrows move one original
frame (Shift ten); Home on IN restores zero and End on OUT restores the original
exclusive OUT. Source review remains independent, with its current paired numeric
**Apply range / Cancel range** workflow.

## Cutting an unwanted part

The timeline's visible clip-edit controls expose **Split**, **Trim start**, **Trim end**,
Delete and **IN / OUT / Cut range** in the existing responsive toolbar, not another
toolbar covering the lanes. Each track header has one **Ripple** toggle icon
(`aria-pressed`) showing and switching that track's own setting in one Undo step.

- **Split / S** maps the playhead through the placed retiming map and creates two
  independent clips. On success the right piece is selected and its beginning
  previewed, ready for another split/trim/delete. Invalid splits preserve selection
  and history. The playhead must be strictly inside the clip's source range.
- **Trim start / Q** discards footage before the displayed source frame; **Trim
  end / W** discards footage after it, keeping that frame via source OUT = frame + 1.
  Ripple-on left trims keep their sequence start and recompile later clips;
  Ripple-off left trims retain their old OUT when representable.
  These are shrinking operations. Handles or Restore full recording recover omitted
  footage. Repeating an unchanged endpoint trim adds no history entry.
- With one clip selected, seek the first unwanted timeline frame and **IN / I**,
  then seek the last unwanted frame and **OUT / O**. OUT is stored as playhead + 1,
  exclusive. A hatched overlay, IN/OUT markers and timecode readout show the range.
  **Cut range / Shift+Delete** removes it atomically in **one Undo step**.
- Middle removal keeps a left clip with the original ID and a right clip with
  a fresh ID. Prefix/suffix removal keeps only the retained clip; a whole-range
  removal deletes it. Retained pieces share the original media but have independent
  ranges/settings, including original-source ramp anchors and deep-copied spatial
  base/full-pose keyframes. Off-trim and original exclusive-OUT anchors remain stored.
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
  the selected clip; errors preserve document/history and valid existing marks.
- Marks are transient editor state, not autosaved/rendered fields. Clear/Escape,
  changing the selected clip/empty track, timing edits, Undo/Redo and project changes
  clear them. Source-review I/O controls are a separate context and never edit these
  marks or the timeline. Form/modal/slider/popover keyboard guards still apply.

Music, other tracks and track keyframes do not follow a track's Ripple edits. Their absolute
project times remain fixed; track animation may therefore evaluate different footage
after sequencing changes. No migration or movement of animation anchors occurs.

## Insertion, reordering and history

One to eight uniform tracks display in saved **bottom-to-top composition order**:
track 1 renders below track 2, track 3 above track 2, and so on. There is no primary/overlay
editing role or required first-track ID. Tracks and track headers have synchronized native vertical scrolling.
The ruler, playhead handle and timecode remain pinned above scrolling tracks. Ticks
follow horizontal scroll; a ruler click/drag still maps to the exact timeline
frame. Scrolling creates no seek/history/save, and a drop on the ruler cannot
target a track hidden underneath it.

Every new video track starts with **Ripple on**. **Track options → Ripple** enables a
continuous packed sequence, not just a policy for future edits. Enabling sorts
current placements chronologically and closes gaps in **one Undo step**, preserving
the first clip's current start and valid existing dissolves. Later starts follow
the preceding contextual OUT minus incoming dissolve duration; commands persist
actual integer placements. Structural edits retain the pre-edit first anchor even
if a different clip becomes first. Turning Ripple off captures actual starts for
independent placement; it does not restore former gaps. Both directions are atomic
and undoable, and never move music, other tracks or absolute track keyframes.

- Media drags carry registered IDs, not arbitrary paths. Only verified ready
  recordings can be added; the server validates registered source ranges on save.
- Ripple-on drops choose the nearest legal sequence slot after temporarily removing
  a moving clip, including retained incoming dissolves. Ripple-off drops target
  independent track/project placement. Plus/double-click use
  the selected video track; Ripple-on insertion appends, Ripple-off insertion starts at the
  playhead. Dragging any recording of a Media multi-selection drops every selected
  ready recording consecutively as one history operation.
  Batch cursor positions use each new clip's contextual retiming end. Every path
  copies current source-review ranges, never arbitrary source paths or track keyframes.
- Existing clip drags reorder a Ripple-on track or change independent placement/track,
  without duplicating media/ranges. The pointer retains the offset where the clip
  was grabbed; selection cannot move the timeline origin underneath it. One shared
  integer-frame plan drives the track-specific placement ghost and committed command.
  The ghost start is the actual post-removal sequence start or independent
  start, and its width is recomputed for the destination track's rate curve at that
  start, not copied from the old placement. A snap guide may mark its contextual
  trailing edge rather than its leading edge.
  Invalid overlap/fade placements have a red ghost/reason and never enter history.
  Edge scrolling updates the same plan; cancellation leaves placement unchanged.
  Unchanged adjacent pairs retain their transition; new pairs become cuts.
- Ripple-on deletion closes the gap; Ripple-off deletion leaves other placements intact.
  Split finds the original source boundary through the placed map and preserves
  independent clip speed, including source-ramp anchors. Track Colour and Opacity are
  unchanged and apply to both pieces. It creates a cut between the pieces on
  that track. Each piece retimes/rounds independently,
  so total duration can change. Invalid edits never enter history.
- **Clip actions → Duplicate** / **Ctrl+D** copies the complete clip range,
  constant/ramp/custom speed and deep-copied spatial base/keyframes into
  an independent ID; it does not
  copy or change track Colour/Opacity. Ripple-on duplicates insert after the original with
  new cut boundaries. Ripple-off duplicates start immediately
  after the original's contextual end and acquire their own contextual duration;
  occupied placement is rejected atomically.
- **Trim/cut/move/split/duplicate never copy or shift track keyframes.** Track Ripple
  leaves their project times fixed. Moving between tracks leaves both tracks' keyframes
  and saved Opacity values intact, using the destination track value or curve;
  source ranges, clip speed and spatial settings remain independent.
  Splits/cuts/duplicates copy complete spatial poses and keyframe arrays independently;
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

## Track keyframes, time ruler and transitions

Schema-12 shared track keyframes belong to the **whole video track**, not individual clips. One ordered
keyframe at a project frame has eleven required nullable channels: **Opacity**
(`opacity`), Speed and nine scalar colour settings, enabled independently.
In control order: `opacity`, `speed`, `temperature`, `tint`, `exposure`,
`brightness`, `contrast`, `hue`, `saturation`, `highlights`, `shadows`.
Static HSL/curves are not animation channels.
Every `VideoLayer` also requires numeric `opacity` in 0–1, initially 1 (100%) on
new tracks. Without Opacity keyframes, every clip uses the track value; keyframes override it
on every clip in the track, including both dissolve sources. There is no saved
`clip.opacity`, second opacity channel or additional track multiplier.
Keyframes survive clip trimming/removal and may remain beyond current duration.
Each channel uses the keyframe's shared easing
toward its **next keyframe with that setting enabled**, holds before/after its own endpoints and
uses its unkeyed value only when it has no keyed settings on the track: the saved track
value for Opacity, track colour for colour, and individual clip speed for Speed.

The selected video track, including an empty one, has one **Track → Keyframes** section
(list accessible name **Track keyframes**) with its directly visible shared keyframe list. Clip keeps
the playhead Speed and Transform controls; Track keeps Colour and Opacity.
Colour, Speed and Transform each have a native **Animate** toggle, a separate
presentation-only browser-local preference. Without a stored choice, unanimated
sections start off and existing keyframes start on. Turning it off retains all keyframes,
rendering, read-only constraints and history without a project save or Undo step;
no schema or data changes result. Main scalar Colour/Opacity and track Speed
diamonds and adjacent per-setting **Previous/Next** buttons appear only when their
section's Animate is on; Animate off hides both while retaining rendering and
read-only constraints. Each diamond is clickable hollow/inactive or filled/active with
`aria-pressed`; inactive is not HTML-disabled. Toggling affects only that channel;
the first enabled setting creates/last removes the keyframe. Animated values are read-only
between keyframes with that setting enabled until explicitly captured with the diamond; no slider
creates implicit keyframes. Keyframes shows dependencies and an inner **Edit**
disclosure. All visible easing selectors read **Easing**, including track,
Transform, clip speed and ramp, retaining contextual accessible names and
interpolation. Moving its Timeline frame moves all enabled settings and the existing easing
in one Undo step, with collision and contextual timing validation. List input
identity/focus and expansion survive a single-keyframe move and Undo.

Each video track draws **one marker per stored keyframe**, with enabled settings in its title,
never per-clip duplicates; keyframes after the last clip keep their markers there
without extending playback. **Click or Enter** selects the marker's track
and seeks without editing. **Drag horizontally** to move the shared keyframe:

- Capture the committed project, track/keyframe, zoom, grabbed pointer position,
  horizontal scroll and stationary playhead. Compute from that captured base plus
  scroll travel, round the delta once and clamp to frames **0–2,147,483,647**.
- Validate every target as a complete shared-keyframe move. Valid drafts update
  geometry/paused preview only; history, autosave and the committed document remain
  unchanged until release. A valid release moves all enabled settings/values/easing in
  **one Undo step**, not one operation per channel or pointer event.
- Snap to captured clip/music/transition boundaries and the captured playhead
  within **eight pixels at the captured zoom**; Alt bypasses it. Horizontal edge
  autoscroll retains that geometry and never changes tracks or auto-reveals another track.
- An occupied time shows a **red invalid ghost**, never a merge/overwrite, including
  when the destination has unrelated enabled settings. Release reports the error and
  commits nothing, rather than using an earlier valid draft. Speed-related overlap,
  fade or transition conflicts reject the entire move; transitions are never shrunk.
- Escape, pointer cancellation, unexpected lost capture or window blur restores
  preview/document/initial horizontal scroll without a draft save or history entry.

On a focused marker, **Left/Right** moves the keyframe one project frame;
**Shift+Left/Right** moves ten, without snapping. The cursor/focus follows the
keyframe; ordinary playhead stepping, clip nudging and other editor shortcuts do not
also run.
Shared time-field editing remains available. A dragged keyframe can be stored beyond
duration and stays list-editable, but does not extend the sequence merely for the
keyframe. Moving it copies/shifts no other keyframes, track values, clip settings/source ranges or music;
keyed Speed settings may naturally recompile contextual clip durations.

### Clip source-keyframe markers

Inside each timeline clip rectangle, Transform keyframes use a pale-blue **◆** lane
and custom-speed keyframes a separate salmon/dashed **◆** lane. Marker output positions
come from authoritative `PlacedClip.retiming`, including track Speed overrides.
Off-trim keyframes are omitted; exclusive OUT has a boundary marker that seeks the
final available frame. Speed override is indicated and retains the clip keyframes.
Click, Enter or Space selects the clip and seeks the nearest mapped image without
editing, history, save or dragging; keyboard handling is isolated from timeline
shortcuts. These are not the draggable shared project-time track markers above.

### Channel navigation and off-duration inspection

With Animate on, each section header has one native **Previous/Next** pair.
Colour visits the union of Opacity and nine scalar keyframes, skipping speed-only
keyframes. Speed visits track Speed keyframes plus all retained custom speed source
keyframes of the selected clip, including off-trim keyframes and original exclusive
OUT, previewing the nearest mapped image through authoritative retiming. Track
Speed overrides but retains clip keyframes and their navigation. Transform likewise
visits all retained full-pose source keyframes, including off-trim/original OUT.
Speed and Transform each keep an independent clip-local stored-source cursor,
separate from track inspection, so successive keyframes remain reachable when
several preview the same first/last image. Stored time never replaces the real
displayed project/source frame for main values or capture. Timeline source markers
still omit off-trim keyframes and retain the exclusive-OUT boundary marker.

Per-channel native **Previous/Next** arrows remain beside each main diamond when
Animate is on, because not every setting is enabled at every shared keyframe.
Enabled setting chips in stored Keyframes rows retain their arrows too.
All these per-channel arrows are disabled without the relevant neighbour, an opened
project, or during any document-preview draft. They seek
strictly earlier/later keyframes where that channel is not `null` (zero included),
skipping unrelated enabled settings. **Track → Colour** contains the single **Opacity**
slider/exact `NumberField` alongside the colour controls, its Animate-on diamond
and adjacent per-setting arrows.
Main and stored sliders/exact fields use **0–100%**, neutral **100%**.
Required track `opacity` and keyframe values remain **0–1**; UI conversion changes no schema.
Its main and stored-chip arrows visit keyframes with `opacity` enabled; the Colour header
visits the colour/Opacity union, with no sidebar duplicate.
Without Opacity keyframes, either value control edits track `opacity` and works on an empty track.
With keyframes, a setting not enabled at the real playhead stays read-only until its
diamond captures it; sliders never create implicit keyframes. Unkeyed colour remains
track-owned with or without keyframes. Opacity affects composition coverage, not SDR RGB grading.
**Clip → Placement** contains placement only. Track options remains limited to
rename, Ripple, ordering and deletion, with visibility separate.

Main per-setting arrows, stored-setting chip arrows, section navigation to track
keyframes, track navigation and list time buttons share a central
**editor-only stored-keyframe inspection cursor**.
It advances through several off-duration keyframes
instead of repeatedly choosing the same keyframe from a clamped playhead. Preview
uses the nearest available project frame, black in a music-only region, or no
preview without video or music duration; labels
distinguish stored time from actual preview. List fields edit the stored keyframe;
setting values/diamonds/capture still use the real playhead. Manual seek, playback,
track/project changes and deletion of the inspected keyframe clear inspection; valid
single-keyframe movement and Undo preserve the cursor and list input identity.
Navigation/inspection creates no history entry or save and adds no persisted fields.

The thin strip above video tracks is the **time ruler**. Its separators/ticks denote
TIME; clicking/dragging seeks. The distinct **Cut / Fade / Dissolve** boundary
buttons open that boundary in Track → Transitions, not keyframe controls. Full keyframe
semantics are in [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

Every track owns its boundary list and opening/closing fades, edited in **Track**
for the selected track. Track → Transitions lists every boundary left to right;
the selected one (from a boundary button, the list, or the selected clip's incoming
boundary, else its outgoing one) is expanded. No earlier choice sticks when the
selection changes. Exactly one record joins each adjacent pair. Cut permits a
gap; non-cut transitions require touching clips or that pair's existing dissolve.
Gapped pairs explain the disabled non-cut choices: explicitly close the gap or
enable that track's Ripple first. Cross-dissolve duration explicitly sets the right
start to left OUT minus duration; changing/removing an existing dissolve changes
that overlap. Ripple on re-sequences the suffix; off changes only the paired right
clip and rejects conflicts with others. Arbitrary/triple overlap is forbidden.
Fade-through-black keeps a touching boundary without overlap. Track opening/closing
fades apply at actual first/last placements, darken only that track's RGB and preserve
coverage. Empty tracks retain dormant fades; adding footage validates them again.
No edit silently shortens fades/transitions to fit.

## Video tracks and preview

Clip names/selection are instance-based, not A/B slots. Every track has independent
Ripple, transitions/fades, visibility and a required track `opacity` value overridden
only by that track's `opacity` keyframes. Any video track can be deleted except
the last remaining one; Raise/Lower are limited only by composition endpoints and
active interaction state. Track order/deletion and cross-track moves are undoable.
Each track's dissolve is one premultiplied group; simultaneous dissolves on
different tracks are allowed. With graded RGB $G_i$, black-fade brightness $b_i$,
evaluated Opacity $o_i$, dissolve weight $w_i$ and spatial coverage $m_i$, the group has
$C = \sum_i G_i b_i o_i w_i m_i$, $A = \sum_i o_i w_i m_i$ and source-over
$\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no track multiplier.
At a project frame, each source uses the same evaluated track Opacity, from the
saved track value or overriding `opacity` curve; it is not applied again to the group.
Nonneutral transformed/cropped pixels outside the original have zero coverage;
exact neutral poses retain the old opaque black letterboxing after grading.

A nonempty one-video-track project uses **two reusable video elements/textures**; eight
tracks use **16**, two slots per track, never one per stored clip.
A required clip retains its decoder; only inactive slots may be reassigned.
Next sources per enabled video track are speculatively preloaded in free slots. Source
review uses one separate muted/paused decoder, not another timeline slot.

Resource changes invalidate uploaded texture identity and require a newly observed
decoded frame. Direct/rapid seeks cancel obsolete loads and speculative preloads.
The compositor does not upload a stale frame while the target recording loads.
All track opacity/colour channels use project time, so coverage and grading can change
even on held source frames. Appearance-only edits update rendering without reloading
unchanged timing/music. Source/static-speed/track-Speed/placement edits pause and reload
the placed map; moving/easing a keyframe with Speed enabled is also timing-changing.
Opacity and spatial changes remain appearance-only; continuous spatial geometry
can change on a held recorded image. Black fades preserve coverage and grouped
dissolves use the source-over contract above. See
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Snapping, projects and music

**Snap** uses an eight-pixel tolerance converted to project frames at the current
zoom. Ruler/playhead scrubbing snaps to video/music boundaries; trim handles also
snap to the original, stationary playhead. Shared-keyframe drags use boundaries and
the stationary playhead captured at pointer down, with their captured zoom throughout
autoscroll. Ripple-off moves match either leading or trailing edge to other clip/music/
transition boundaries, frame zero or the captured
stationary playhead; their own old edges/transition regions are excluded. Holding
Alt bypasses these magnets. A trailing-edge snap solves a representable contextual
end under the track rate curve, rather than subtracting the old duration. Ripple-on
insertion remains boundary-based even with Snap off or Alt held; only an explicit
move of its retained first clip changes the anchor. The
toggle persists for the current timeline session, not the renderable document.

Projects are named separate **version-12** documents with complete required video track colour, clip spatial
base/full-pose source-frame keyframes and per-track Ripple,
transitions, opening/closing fades and numeric `opacity` in 0–1. New tracks start
at 1 (100%); a missing saved field is invalid. Switching flushes autosave first,
blocks on failed saves, and resets session selection/history; successful export
snapshots are independent of the open project. Earlier v1–v11 projects and receipt
snapshots remain incompatible and preserved, without migration/fabricated defaults.
There is no automatic deletion. Track `opacity` is the required sole stored value;
saved `clip.opacity` and old `clipOpacity`/`layerOpacity` keyframe fields are rejected,
not ignored or defaulted. Keyframes require exactly eleven nullable channels: `opacity`,
`speed` and nine scalar colour fields, including required `temperature` and `tint`.
Track Colour requires both bases and static HSL/curves; missing fields are invalid.
Recreate projects and deliberately import recordings/music
to reuse registered sources/verified ready proxies. Confirmed project deletion removes only its saved
document, never originals, the shared registry/proxy cache or successful exports/
receipts. Removing a clip is not removing that recording from the import bin;
use **Remove from project** for that. The
existing live v3 sample appearing incompatible is expected. Registry/proxy formats
are unchanged.

The required `music` array holds **0–8 independent music tracks**, each with a unique
required `id`, registered `mediaId`, source IN/OUT, start/duration, gain, fades and
loop flag. No null/singular fallback, omitted-field default or old-format reader
is accepted. Version-1 export receipts require a strict v12 snapshot and captured
audio-source/instance-plan arrays; older snapshots/invalid arrays are rejected
while the receipt and finished output remain preserved. Current PCM format is unchanged.

Each music track has its own backend-prepared waveform and timeline lane.
**Audio → Music → Music track** selects the track; **Add music track** lists
ready music files and creates a track (dragging one from Media → Music onto
the music lane does the same), and the selected-track trash action removes only that
placement. Import never implicitly places music. Selection creates no save/history
entry, and editing/removing one music track leaves all others and imported media intact.
Independent drafts cannot apply to another music track. Placement/trim gestures are
transient and commit once; each accepted edit/add/remove is one Undo step.
Invalid release/cancellation is atomic with no committed draft/history/save.
Numeric controls provide source IN/OUT, placement/duration and fades; gain uses a
native slider with an exact `NumberField`, and looping is explicit per music track.
Music is not retimed or rippled with video tracks. All music tracks sum linearly after their
gain/fades and clamp once after the complete mix; one AudioContext/worklet/output
clock drives synchronisation, never per-track clocks or queues.
See [the multiple-music contract](design/MULTIPLE_MUSIC.md).

## Media browser and interface scope

The default compact list has small thumbnails and independent vertical scrolling;
the alternative grid uses two columns. Each thumbnail maps the whole original
(frame 0 left, exclusive OUT right) and hatches the head/tail omitted by the
recording's applied source-review range, without a text badge; the exact frames
are the review button's accessible description. Unapplied numeric drafts and
existing clips do not change it. Search is always visible; **Media options**
holds sort (name/duration/newest), readiness/usage filters and List/Grid. A plain
click reviews a recording without selecting it; checkboxes, Ctrl-click and
Shift-click select. With two or more selected, the **Select all** bar shows the
count with **Prepare** (when needed), remove and **Clear selected**, without
a separate footer or Add button. Unprepared cards say **Not prepared** under their
name. User imports automatically queue eligible proxies through one heavy
worker, reusing ready/in-flight work. Manual preparation remains for legacy
unprepared sources and explicit failed/cancelled retries; manual batches confirm
before starting multiple jobs. Startup and hover never queue old recordings.

Prepared recording buttons hover-scrub across the complete source range and show
a mouse-following marker. The source viewer is separate from the project playhead
and stays out of list flow so recording cards never move under an active hover/drag. Review
IN/OUT handles, numeric **Apply range** and I/O marks are non-destructive. OUT is
exclusive; handle drafts cancel/release independently of timeline history/autosave.
There are no separate Mark IN/OUT or Reset buttons: Home/End on a handle restores
that edge. Invalid numeric drafts keep an inline error until **Apply range** or **Cancel range**.
The source range strip below the image spans the whole original with its five prepared
snapshots; hatching identifies omitted footage and timeline-style **IN / OUT**
handles (24 px pointer targets) trim, while the rest of the track scrubs. Drag
feedback previews IN or the last included frame (OUT − 1) with an overlay hint on
the image; Escape, pointer cancellation, capture loss or window blur restores the
applied range and prior source frame. Missing snapshots degrade to an explicit
**Snapshots unavailable** track without starting preparation.
The round **Play / Pause** button at the left of the source range strip plays only the
verified muted proxy within the applied range,
from the current observed frame if it precedes the last included frame, otherwise
from IN. It stops and seeks exactly OUT − 1, without looping or audio. A one-frame
range simply displays that frame. Numeric drafts do not change the played range.
Scrubbing, trimming, marking and **Apply range** pause first; closing, hiding, switching
recordings/projects or leaving Source preview cancels pending playback and releases
its sole decoder. Loading/playback failures remain explicit with Retry. Source
playback never moves the timeline/music, changes clips/track keyframes or saves/history.
Choices persist per project in that browser and affect future insertions only.
Source **Add clip** stays in the pinned review for repeated additions. Its
sticky header and native nonmodal clip popup keep adding/reviewing reachable
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
**Clip → Range** uses the full-original bar and exact timecode text fields above.
Other integer source/placement frames, durations and fades retain exact native
numeric steppers and existing timecode feedback, without arbitrary timing sliders.
Source-review paired IN/OUT retains its explicit **Apply range / Cancel range** workflow.
**Clip / Track / Audio** separates clip-owned source/placement/speed/Transform,
track-owned Colour/keyframes/transitions/fades, and music. The header directly exposes
help; **Workspace options**
holds the Media/Clip panel toggles, layout reset and Diagnostics. **Track options**
holds only rename/Ripple/stacking/deletion; **Clip actions** holds duplication/nudging,
while the frequent split/trim/delete/cut actions stay directly visible.
Diagnostic counters, shader tests and the two-clip native comparison tool remain
hidden behind Diagnostics. **Export** uses the bounded native multi-clip
renderer, with profiles for 720p drafts and 4K finals. The diagnostic two-clip
reference remains limited to two normal-speed clips on one enabled,
zero-origin contiguous video track with Opacity 1 and neutral spatial bases without
spatial keyframes, without music/extra tracks/shared track keyframes,
including Speed-only keyframes, and at most 3,600 project frames.
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

Video track Colour includes static **HSL ranges** and **Colour curves** in nested Track → Colour sections. They affect every clip and both dissolve sources on the track, whether or not its nine scalar channels are keyed. Moves use the destination track's complete colour; clip edits never copy these settings. They are not speed curves or new animation channels. See [the schema-12 HSL/curves contract](design/HSL_AND_CURVES.md).
