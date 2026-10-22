# Timeline editing

## Recordings, ranges and clips

Appearance is video track-owned: complete required `layer.colour` plus the sole Opacity,
with shared project-time keyframes. Every clip on the same track shares Colour with or
without keyframes; different treatments require different tracks. Moving adopts destination
appearance; trim/split/cut/duplicate preserve track bases and absolute keyframes.
Main Colour edits work on empty tracks. There is no clip colour/correction field.
Temperature (−2…2) and Tint (−1…1) are track-owned scalars, neutral 0, with independent
explicit keyframe capture. Positive Temperature warms; positive Tint adds magenta.
Their normalized linear gains precede Exposure and intentionally colour greys.
HSL/curves remain static. See [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
See [track appearance](design/ROW_APPEARANCE.md).

The media library describes complete recordings belonging to the open project's
bin, not every globally registered source. Projects require unique
`media.videoIds` and `media.audioIds` arrays (10,000 IDs maximum each). Imports add
membership even without timeline placement; clip/music references also remain
visible. New projects start with both arrays empty. **Remove from project** (the
trash on a Media card or music file, or on the selection header for a selection)
removes only that bin membership in one Undo step.
A recording still used by clips or music clips first asks for confirmation
with their counts, then removes those placements in the same step; Ripple tracks
close the gaps as ordinary deletions do, and a music track left without clips goes too. Originals, registry entries, proxies,
thumbnails, PCM caches, other projects and exports are untouched; a deliberate
re-import makes it available again. Importing an existing source
deliberately reuses the global content-deduplicated registry/proxy cache; switching
projects never automatically adopts that global library. An insertion creates
a unique clip-instance ID and copies the latest media-review IN/OUT, or
`sourceIn = 0`, `sourceOut = registered frameCount` without a choice. New clips have
normal constant speed, `reverse` `false` and neutral Sharpen/Clarity/Denoise, with no saved opacity or
transform field. They use the destination track's `opacity` value or its overriding Opacity
keyframes, and its Transform.
New clips start without custom speed keyframes; existing track curves immediately apply at their project placement.
The original and full proxy remain unchanged; no extra crop file is generated.
Multiple insertions of one recording have independent source ranges and
clip speed.

For several clips from one recording, set source IN/OUT and **Add clip**, then
mark the next range and add again. Successful additions keep **Source preview** on
the same recording/frame, with the applied range unchanged and explicit success
feedback: **Clip added · mark another range**. The source is not unmounted/reloaded
for each addition. Failed insertion keeps the review/range and never reports success.
**Add clip** (labelled with the applied
range length) and a compact **Show N clips** popover beside the recording name stay in the sticky source header, including on
short laptop screens; opening the list does not resize source review. The popup
shows original ranges/tracks; Escape closes just the popup and **Show** selects, seeks and horizontally
reveals that clip. Library reuse badges count clips, not duplicate recording files.

Timeline source OUT is exclusive. Integer frames at 30000/1001 remain the
authoritative stored timing; displayed seconds are derived, not accumulated.
Output duration/source sampling uses each authoritative **`PlacedClip.retiming`**,
the clip's own compiled speed map, not the raw source-range length at non-1× speed.
A clip's duration depends only on its own speed and source range, never its track,
start or Ripple position. See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md).
Transform belongs to the video track, like Colour, and evaluates at project time;
Transform edits do not change placement or duration. See
[spatial transforms](design/SPATIAL_TRANSFORMS.md).

Project duration is the maximum of all retimed clip ends (including hidden
tracks) and every music clip's start + duration. Music can extend
the project. After the last active video clip OUT, preview/export is opaque black,
not a frozen last image, while music continues/fades to its own OUT. Each video
closing fade remains inside its last clip and ends at that clip's OUT. Music-only
preview is allowed; export still requires at least one video clip.

## Importing recordings from the filesystem

Create/open a project, then choose **Import** in the Media panel. The **Import media**
dialog is a service-side browser, not an operating-system file picker, laid out like
one: approved **Locations** on the left, then a breadcrumb, **All / Video / Music**
filter and one folder's folders and recordings with type and size. Check **MP4, MOV
or M4V** video and music recordings (Shift-click selects a range; selection survives
folder changes) and choose **Import**, or double-click one recording to import it
alone. Imports reference those original absolute paths and belong to the current
project's bin; they are not inserted into the timeline automatically. A complete
import closes the dialog; rejected or unqueued recordings keep it open with a report
and stay selected. The dialog reopens on the last folder.

Browsing lists **one folder's metadata only**: no probing, registration, writes
next to the originals or preparation jobs. Folders appear first with naturally
sorted names. At most **2,000 entries** of each kind are listed; an explicit warning
means choose a narrower folder, not that all recordings were discovered. The cache
branch is excluded and symlinks are rejected. Missing/unreadable approved roots
remain visible as unavailable instead of preventing service startup.

Video rows show a **preview**: a small picture of the keyframe nearest the
recording's middle, read by the service only once the row scrolls into view.
It is the one deliberate exception to metadata-only browsing, and it is bounded:
the service reads the container index and that keyframe (plus FFmpeg's start-of-file
probe and read-ahead of about a dozen keyframes), never the whole recording, and sends
the browser a JPEG of at most 320 × 180, never the original. At most two previews
are read at once (the dialog also requests at most two, so imports keep their
connection), sixteen more may wait, and each read stops after 20 seconds. Closing
the dialog, changing folder or unmounting a row cancels its read. Previews are
cached by path and file identity in the data directory's `browse-previews/`
(at most 4,000, least recently shown evicted first), never next to the originals;
no recording is registered or prepared. A file that cannot be decoded shows a
crossed-eye placeholder whose tooltip gives the reason; **Refresh** retries it.
Music rows keep their icon.

`PASCAP_MEDIA_ROOTS` is a JSON array of at most 32 unique absolute roots, defaulting
only to the service user's `~/Videos`; `[]` disables the browser. Selected-path
registration accepts at most **5,000 absolute video paths per request**, constrained
to approved roots. Existing read-only fingerprint/probe checks report individual
failures. Confirming registration queues eligible proxies through the same
one-heavy-worker queue; ready/in-flight work is reused, and failed/cancelled/
interrupted preparation requires explicit **Prepare**. Merely opening folders or
selecting files never starts that work. Music follows the same dialog; see
[music](SPEED_AND_AUDIO.md#music).

**Damaged recordings.** The decoder drops video frames it cannot read and silently
conceals the frames that depend on them, so preparation compares the passthrough
proxy's frames with the original's: any missing frame fails preparation and records
its whole group of pictures, from the keyframe at or before it to the next keyframe
(exclusive), as the asset's `damage` ranges in the video registry (absent in older
registries, meaning none). Only an explicit **Prepare … with damaged frames shown
black** prepares it then: every decode of that original (proxy, static and composited
export, forward or seeked reversed chunks) refills dropped frames with FFmpeg `fps`,
pads a damaged tail and blacks out the recorded ranges before counting frames, so
exact frame counts and positions hold. Those decodes omit `-xerror`/`explode` and
strip packet decode timestamps (`setts=dts=NOPTS`): after a hole the decoder can emit
a stale picture whose timestamp goes backwards, and FFmpeg would then label every
later frame from decode timestamps, one frame late in DJI files. Pictures keep their
own timestamps only in decode order, so recordings with B-frames are refused with an
explanation, and the black-out preparation fails unless the two frames after each
damaged range match their own original frames better than their neighbours.
Undamaged originals keep strict decoding and unchanged filters. The diagnostic
reference rejects damaged recordings, and proxy samples and thumbnails avoid the
black ranges. Source preview hatches them red on the range strip and motion lanes,
whose hover readout names them, and steady ranges never include or bridge them: their
black has no motion to measure, so the analysis would otherwise hold the previous
value and call them smooth. The original is never modified.

**Other location** (bottom of Locations) imports a typed path, including outside
browser roots: a video or music recording, or a folder through the existing
recursive import. A folder can register and autoqueue many recordings, so choose a
narrow one and submit only when that work is intended. This action never silently
adds an approved root. See
[../README.md](../README.md#footage-service-api) for the browsing/registration API
and [DEPLOYMENT.md](DEPLOYMENT.md) for service-side paths and planned mounts.

There is **no footage copy mode, upload endpoint, browser file picker or true
external desktop drag-and-drop import**. A browser drop does not provide a trusted
original absolute path. External file/folder drops prevent navigation and give
Import guidance, **without a POST**. Internal dragging of ready registered Media
into Timeline remains unchanged. Uncertain registration results are not retried
automatically; check Media/Activity before resubmitting.

The strict current schema requires complete video track colour with Temperature/Tint/Vibrance/Whites/Blacks/HDR/Local contrast and static HSL/curves, track Transform, a boolean clip `reverse`, per-track Ripple, transitions and fades, and a required
0–8 music track `music` array of clips joined by transitions (`[]` without music); proxy/PCM formats are
unchanged and the registries are version 2 (full-content checksums). Only generated
proxies/thumbnails, metadata,
exports/receipts and scratch are created, not duplicate originals. Keep originals
accessible at their registered paths: moving files or disconnecting a drive fails
explicitly, even with a proxy; there is no implicit guessing/reassociation. The
explicit **Relink** action in Media accepts a moved copy only after a full-content
match ([relinking](design/SOURCE_RELINK.md)). Previously copied source files from the
removed implementation are not automatically deleted or migrated: preserve their
registered paths and bytes. This is data safety, not compatibility code.

## Non-destructive trim gestures

These timeline-edge gestures use output-frame geometry; the Clip tab's
original-source range controls have the separate contract below.

- Pointer down captures the handle, pauses preview and snapshots the committed
  document and frame/pixel scale.
- Pointer movement computes output-frame delta from the original pointer position,
  including horizontal scroll. The clip's placed map converts the requested
  output-duration change back to a recoverable original endpoint; drafts do not
  accumulate rounding or rescale track keyframes.
- A left drag changes IN; a right drag changes OUT. A [reversed](SPEED_AND_AUDIO.md#reverse)
  clip shows source OUT at its left, so its left drag changes OUT and its right drag
  changes IN: handles always trim the clip as displayed. Bounds come from registered
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
  OUT holds; restoring IN stops where the start would precede project frame 0.
  Right trims leave the start fixed. Clip → Range edits keep placement.
  The selected original's dashed extent appears during trim hover/focus/drafts,
  independently of the Clip tab's full-original **Range** bar.
- The timeline origin stays fixed rather than shifting when a clip is selected.
  On a left-handle gesture only, recoverable headspace is reserved and scroll is
  compensated before paint: pointer/frame-zero positions do not jump at gesture start.
  Keeping the pointer inside the left viewport edge autoscrolls through that headspace,
  even when a long beginning was omitted from the first clip. Release
  removes the temporary gutter; cancellation restores its initial scroll and document.
  No negative project start is stored. Right-edge autoscroll likewise exposes tails.
  Home/End and exact source fields remain available for exact restoration.
- Clip → Range IN/OUT and **Restore full recording** share the same source and
  transition validation as handles.
- Trim/restoration never copies or shifts track keyframes. Original-source speed
  keyframes are retained, including outside the new trim.

The selected clip's left/right trim edges are keyboard sliders. Arrow keys
move by one original source frame; Shift moves by ten. Home at the left edge restores
the whole head (IN=0, or OUT = original OUT when reversed); End at the right edge
restores the whole tail (original OUT, or IN=0 when reversed). Each handle reports the
source endpoint it edits. A Ripple-off left restoration
cannot extend before project frame zero or silently change its retained timeline
OUT; normal overlap/fade validation still applies.

### Clip Range

One full-original range bar hatches omitted footage and has draggable **IN / OUT**
handles. Exact **Source IN / OUT** text fields sit below the respective ends,
displaying **MM:SS:FF** (30 fps NDF). They accept whole original-frame numbers
or timecode on Enter/blur; OUT remains exclusive. Empty, malformed, fractional,
out-of-original or conflicting ranges retain editable inline errors, never clamp
or silently round; Escape restores. There are no duplicate section duration,
original-length, source-frame or recoverable head/tail labels. **Restore full
recording** remains available.

Both fields and bar handles use ordinary source-range trim: the selected clip's
placement stays fixed in either Ripple mode; Ripple re-sequences its suffix
normally. They do not use the timeline left handle's retained-OUT rule above.
Source bounds, at least one retained frame, retiming and transition/fade validation
remain authoritative; original speed anchors and track keyframes stay unchanged.

Dragging previews the complete validated document, including layout
and paused preview, without history/autosave. A final valid release commits one
Undo step; an unchanged range adds none. Invalid final release, Escape, pointer
cancellation, lost capture or window blur restores the starting document/preview,
never commits an earlier valid draft. Focused handle arrows move one original
frame (Shift ten); Home on IN restores zero and End on OUT restores the original
exclusive OUT. Source review remains independent: its numeric IN/OUT pair applies on
Enter or when focus leaves both fields; Escape restores.

## Cutting an unwanted part

The timeline's visible clip-edit controls expose **Split**, **Trim start**, **Trim end**,
Delete (which removes the selected range while one is selected) in the existing responsive toolbar, not another
toolbar covering the lanes. Each track header has one **Ripple** toggle icon
(`aria-pressed`) showing and switching that track's own setting in one Undo step.

- **Split / S** maps the playhead through the placed retiming map and creates two
  independent clips. On success the right piece is selected and its beginning
  previewed, ready for another split/trim/delete. Invalid splits preserve selection
  and history. The playhead must be strictly inside the clip's source range. On a
  reversed clip both pieces stay reversed: the left keeps the higher source frames and
  the right starts with the image at the playhead.
- **Trim start / Q** discards footage before the displayed source frame; **Trim
  end / W** discards footage after it, keeping that frame via source OUT = frame + 1.
  Both act in output order, so on a reversed clip Q sets source OUT = frame + 1 and
  W sets source IN = frame.
  Ripple-on left trims keep their sequence start and recompile later clips;
  Ripple-off left trims retain their old OUT.
  These are shrinking operations. Handles or Restore full recording recover omitted
  footage. Repeating an unchanged endpoint trim adds no history entry.
- **Drag on the time ruler** to select a project-frame range (OUT exclusive): a
  highlighted band on the ruler, with an IN – OUT timecode readout below it for as long
  as the range stays selected, and a hatched
  overlay on the part of the selected clip it covers. The preview follows the moving
  edge (its first or last removed frame). Snapping (eight pixels, Alt bypasses) and
  edge autoscroll follow the other timeline gestures; Escape, pointer cancellation,
  lost capture or window blur restore the previous range and playhead. A plain
  click seeks and clears the range; the playhead handle scrubs.
- While a range is selected, preview **Play / Space** plays only that range: from
  the playhead when it is inside the range before its last frame, otherwise from
  IN, stopping on the last included frame (OUT − 1) so the section can be replayed.
  At the end of the range, or of the timeline without one, Play restarts from IN or
  frame 0, also when pressed while the preview is still settling on the last frame.
  The preview's start/end buttons and **Home/End** likewise go to IN and the last
  included frame (OUT − 1) while a range is selected, else to the timeline's ends.
- **Delete / Shift+Delete** with a range selected (the trash turns orange and reads
  **Delete selected range**) is enabled only when a clip is also selected and the
  range overlaps it; otherwise its tooltip names the reason. It removes the
  overlapping part of the clip atomically in **one Undo step**. Without a range,
  Delete removes the whole selected clip.
- Middle removal keeps a left clip with the original ID and a right clip with
  a fresh ID. Prefix/suffix removal keeps only the retained clip; a whole-range
  removal deletes it. Retained pieces share the original media but have independent
  ranges/settings, including original-source speed keyframes. Off-trim and original
  exclusive-OUT speed anchors remain stored.
  No proxy is cut. A reversed clip removes the source frames its range displays and
  keeps the higher remaining frames as the left piece; every piece stays reversed.
- With Ripple on, the track closes the removed gap and recalculates later starts
  without changing their order, original-source ranges, durations or settings. The new
  left/right boundary is a cut. Existing valid incoming/outgoing transitions are
  retained/reanchored; fades are never silently shortened to make an invalid edit fit.
- With Ripple off, a cut keeps the removed gap and other clips' absolute placements. Its
  retained right piece starts at the original output position of the
  retained source IN. Each piece retimes/rounds independently, like a split;
  invalid overlap/quantisation is rejected. Ripple assembly is available on any track.
- Ranges outside the selected clip and slow-motion ranges containing no original
  source frame cannot remove footage; errors preserve document/history and the range.
- The range is transient editor state, not an autosaved/rendered field, and does not
  belong to a clip: selecting another clip or track keeps it. Clear/Escape, a ruler
  click, other timing edits (trims, moves, speed, deletions, music), Undo/Redo and
  project changes clear it. Transition and fade edits keep it at its project frames,
  even when they shift clips, so a range around a boundary can be replayed while the
  transition is tuned; its OUT is shortened to a shorter project, and a range starting
  after the new end is cleared. Source-review I/O
  controls are a separate context and never edit it or the timeline.
  Form/modal/slider/popover keyboard guards still apply.

Music, other tracks and track keyframes do not follow a track's Ripple edits. Their absolute
project times remain fixed; track animation may therefore evaluate different footage
after sequencing changes. No migration or movement of animation anchors occurs.

## Insertion, reordering and history

One to eight uniform tracks display in saved **bottom-to-top composition order**:
track 1 renders below track 2, track 3 above track 2, and so on. There is no primary/overlay
editing role or required first-track ID. Tracks and track headers have synchronized native vertical scrolling.
The ruler, playhead handle and timecode remain pinned above scrolling tracks. Ticks
follow horizontal scroll; ruler clicks, range drags and the playhead handle still map
to the exact timeline frame. Scrolling creates no seek/history/save, and a drop on the ruler cannot
target a track hidden underneath it.

Every new video track starts with **Ripple on**. **Track options → Ripple** enables a
continuous packed sequence, not just a policy for future edits. Enabling sorts
current placements chronologically and closes gaps in **one Undo step**, preserving
the first clip's current start and valid existing dissolves. Later starts follow
the preceding OUT minus incoming dissolve duration; commands persist
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
  Batch cursor positions use each new clip's retimed end. Every path
  copies current source-review ranges, never arbitrary source paths or track keyframes.
- The layers icon beside a Media card's plus (**Add … to a new track**) creates a video track
  and inserts the recording there in one Undo step, at the playhead, selecting the new track.
  It is disabled at eight tracks.
- Existing clip drags reorder a Ripple-on track or change independent placement/track,
  without duplicating media/ranges. The pointer retains the offset where the clip
  was grabbed; selection cannot move the timeline origin underneath it. One shared
  integer-frame plan drives the track-specific placement ghost and committed command.
  The ghost start is the actual post-removal sequence start or independent
  start, and its width is the clip's own duration, which the destination never
  changes. A snap guide may mark its
  trailing edge rather than its leading edge.
  Invalid overlap/fade placements have a red ghost/reason and never enter history.
  Edge scrolling updates the same plan; cancellation leaves placement unchanged.
  Unchanged adjacent pairs retain their transition; new pairs become cuts.
- **Several clips** can be selected: **Ctrl-click** (Cmd-click) adds a clip, which becomes the
  primary clip that Clip properties edit (solid outline; the others are dashed), or removes a
  selected one; the **Select all clips** icon in a track header adds that track's clips. A plain
  click, or selecting a track, returns to one selected clip. The selection is editor-only, never
  saved. Dragging any selected clip moves them all by the same number of frames: clips from one
  track follow the pointer to its track, clips from several tracks stay on their own tracks. On
  a Ripple-off destination each keeps its offset from the others and any moved edge snaps; on a
  Ripple-on destination they follow its sequence: clips arriving from another track join it as
  one block at the slot nearest their new start, and on their own track each run of consecutive
  selected clips moves to the slot nearest its shifted start, so a small drag changes nothing.
  Every moved clip shows a ghost. The whole move is validated at once: a start before frame 0,
  an overlap or a fade/transition conflict turns the ghosts red and commits nothing, never
  clamping or moving part of the selection. A valid drop is one Undo step. **Delete** removes
  every selected clip and **Alt+Left/Right** nudges them all (Ripple tracks keep their order),
  each in one Undo step; track keyframes, Colour and Transform never move with clips.
- Ripple-on deletion closes the gap; Ripple-off deletion leaves other placements intact.
  Split finds the original source boundary through the placed map and preserves
  independent clip speed, including source-frame speed keyframes. Track Colour and Opacity are
  unchanged and apply to both pieces. It creates a cut between the pieces on
  that track. Each piece retimes/rounds independently,
  so total duration can change. Invalid edits never enter history.
- **Duplicate** (right-click the clip, or its Menu key) / **Ctrl+D** copies the complete clip range,
  constant/custom speed, direction and detail filters into
  an independent ID; it does not
  copy or change track Colour/Opacity/Transform. Ripple-on duplicates insert after the original with
  new cut boundaries. Ripple-off duplicates start immediately
  after the original's end with the same duration;
  occupied placement is rejected atomically.
- **Move to new track** (the same menu) creates a video track and moves the clip there in one Undo step,
  keeping its start and order; the new track has neutral Colour and Transform and Opacity 1, since they are track-owned. It is
  unavailable when the clip is alone on its track or eight tracks exist.
- **Trim/cut/move/split/duplicate never copy or shift track keyframes.** Track Ripple
  leaves their project times fixed. Moving between tracks leaves both tracks' keyframes,
  Transform and saved Opacity values intact, using the destination track value or curve;
  source ranges and clip speed remain independent.
  Splits/cuts/duplicates copy detail filters independently;
  trims/moves/Ripple never shift, rescale or discard speed's original-source anchors.
- **Alt+Left/Right** nudges a positioned clip or the first Ripple anchor one frame;
  adding Shift nudges ten. Clip → Placement's **Timeline start frame** field,
  available on every track, steps one frame with its stepper. Later Ripple
  starts are derived and disabled with a tooltip reason: drag to reorder or
  turn Ripple off for independent placement. Moving the first anchor while it
  remains first re-sequences its track. Starts remain nonnegative, conflicts reject
  the whole edit, and each successful action is one Undo step.
- Session-only Undo/Redo covers clip commands and committed pointer gestures.
  Saved document revisions are managed separately by serial autosave.

## Track keyframes, time ruler and transitions

Shared track keyframes belong to the **whole video track**, not individual clips. One ordered
keyframe at a project frame has fifteen required nullable channels: **Opacity**
(`opacity`), twelve scalar colour settings, **HDR** (`hdr`) and **Local contrast**
(`localContrast`), enabled independently.
In control order: `opacity`, `temperature`, `tint`, `exposure`,
`brightness`, `contrast`, `hue`, `saturation`, `vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`, `localContrast`.
Static HSL/curves are not animation channels; speed is clip-only.
Every `VideoLayer` also requires numeric `opacity` in 0–1, initially 1 (100%) on
new tracks. Without Opacity keyframes, every clip uses the track value; keyframes override it
on every clip in the track, including both dissolve sources. There is no saved
`clip.opacity`, second opacity channel or additional track multiplier.
Keyframes survive clip trimming/removal and may remain beyond current duration.
Each channel uses its own Easing at the keyframe
toward its **next keyframe with that setting enabled**, holds before/after its own endpoints and
uses its unkeyed value only when it has no keyed settings on the track: the saved track
value for Opacity and track colour for colour.

The selected video track, including an empty one, has its directly visible shared keyframe list
(accessible name **Track keyframes**) at the end of **Track → Colour**, under a small
**Keyframes** heading. Clip keeps
the playhead Speed controls; Track keeps Colour, Opacity and Transform. Track Transform
keyframes are a separate project-frame list at the end of **Track → Transform**, with their own markers
(see [spatial transforms](design/SPATIAL_TRANSFORMS.md)).
Colour, Speed and Transform always show their capture diamonds while the section is expanded, Colour and Transform with adjacent per-setting **Previous/Next** buttons; there is no Animate toggle and no stored preference. Each expanded section has one keyframe line with the **number of keyframes**, one **Previous/Next** pair over the same set and **Reset**. The line is hidden while the section is collapsed; the title row and its help stay reachable. Rendering, retained keyframes and read-only constraints never depend on what is shown. Each diamond is clickable hollow/inactive or filled/active with
`aria-pressed`; inactive is not HTML-disabled. Toggling affects only that channel;
the first enabled setting creates/last removes the keyframe. Animated values are read-only
between keyframes with that setting enabled until explicitly captured with the diamond; no slider
creates implicit keyframes. The stored list shows dependencies and an inner **Edit**
disclosure. All visible easing selectors read **Easing**, including track,
Transform and clip speed, retaining contextual accessible names and
interpolation. Moving its Timeline frame moves all enabled settings and their Easing
in one Undo step, with collision validation. List input
identity/focus and expansion survive a single-keyframe move and Undo.

Each video track draws **one marker per stored keyframe**, with enabled settings in its title,
(a [default keyframe](LAYERS_AND_KEYFRAMES.md#default-keyframes) is filled amber with a
diamond-and-return-arrow icon instead of ◆),
never per-clip duplicates; keyframes after the last clip keep their markers there
without extending playback. **Click or Enter** selects the marker's track
and seeks, opening Track → Colour, without editing. **Drag horizontally** to move the shared keyframe:

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
  commits nothing, rather than using an earlier valid draft.
- Escape, pointer cancellation, unexpected lost capture or window blur restores
  preview/document/initial horizontal scroll without a draft save or history entry.

On a focused marker, **Left/Right** moves the keyframe one project frame;
**Shift+Left/Right** moves ten, without snapping. The cursor/focus follows the
keyframe; ordinary playhead stepping, clip nudging and other editor shortcuts do not
also run. **Delete** or **Backspace** removes the focused keyframe in one Undo step, also
on a track without clips or outside the duration.
Shared time-field editing remains available. A dragged keyframe can be stored beyond
duration and stays list-editable, but does not extend the sequence merely for the
keyframe. Moving it copies/shifts no other keyframes, track values, clip settings/source ranges or music,
and retimes no clip.

### Clip speed-keyframe markers and track Transform markers

Inside each timeline clip rectangle, custom-speed keyframes use a boxed salmon **●** lane.
Marker output positions come from authoritative `PlacedClip.retiming`.
Off-trim keyframes are omitted; exclusive OUT has a boundary marker that seeks the
final available frame.
Click, Enter or Space selects the clip, seeks the nearest mapped image and opens Clip → Speed; a click edits nothing. They also slide: drag one horizontally, or press ←/→ (one original source frame, Shift ten), keeping its easing. A drag previews without history/save; a valid release is one Undo step, while Escape, cancellation, blur or an occupied/invalid frame restores. Moving a speed keyframe retimes its clip, so its duration and Ripple suffix can change; overlap/fade/transition conflicts reject the release. Keyboard handling is isolated from timeline
shortcuts.

Track Transform keyframes are boxed blue **▼** markers at the top of their track row,
one per stored keyframe at its project frame (a default keyframe is filled light blue with
the default-keyframe icon). They behave like the Colour markers above: click or Enter
selects the track, seeks and opens Track → Transform; drag or Left/Right moves the whole
Transform keyframe in one Undo step, never merging into an occupied frame.

### Channel navigation and off-duration inspection

Each section's keyframe line has one native **Previous/Next** pair, beside the keyframe count it visits.
Colour visits the union of Opacity, twelve scalar, HDR and Local contrast keyframes. Speed visits all
retained custom speed source keyframes of the selected clip, including off-trim
keyframes and original exclusive OUT, previewing the nearest mapped image through
authoritative retiming. Transform visits all track Transform keyframes, including
those after the duration, with its own track-local cursor.
Speed keeps an independent clip-local stored-source cursor,
separate from track inspection, so successive keyframes remain reachable when
several preview the same first/last image. Stored time never replaces the real
displayed project/source frame for main values or capture. Timeline speed markers
still omit off-trim keyframes and retain the exclusive-OUT boundary marker.

Per-channel native **Previous/Next** arrows remain beside each main Opacity and colour diamond, because not every setting is enabled at every shared keyframe.
Enabled setting chips in stored Colour keyframe rows retain their arrows too.
All these per-channel arrows are disabled without the relevant neighbour, an opened
project, or during any document-preview draft. They seek
strictly earlier/later keyframes where that channel is not `null` (zero included),
skipping unrelated enabled settings. **Track → Colour** contains the single **Opacity**
slider/exact `NumberField` alongside the colour controls, its diamond and adjacent per-setting arrows.
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
TIME; a click seeks, a drag selects a range to cut and the playhead handle scrubs.
The distinct **Cut / Fade / Pause / Dissolve** boundary
buttons open that boundary in Track → Transitions, not keyframe controls. Full keyframe
semantics are in [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

Every track owns its boundary list and opening/closing fades, edited in **Track**
for the selected track. Track → Transitions lists every boundary left to right;
the selected one (from a boundary button, the list, or the selected clip's incoming
boundary, else its outgoing one) is expanded. No earlier choice sticks when the
selection changes. Exactly one record joins each adjacent pair. Cut permits a
gap; non-cut transitions require touching clips or that pair's existing dissolve or pause.
Gapped pairs explain the disabled non-cut choices: explicitly close the gap or
enable that track's Ripple first. Cross-dissolve duration explicitly sets the right
start to left OUT minus duration; changing/removing an existing dissolve changes
that overlap. Ripple on re-sequences the suffix; off changes only the paired right
clip and rejects conflicts with others. Arbitrary/triple overlap is forbidden.
Fade-through-black keeps a touching boundary without overlap.

**Fade through black with pause** (`fade-black-pause`, timeline label **Pause**) has
two settings: **Fade** frames, the length of both the fade-out at the end of the left
clip and the fade-in at the start of the right clip, and **Pause** frames of black
between them. The fades consume footage like a fade through black; the pause does
not: it is the transition's own **timeslot**, so the right clip starts exactly at left
OUT plus pause. Like a dissolve's overlap, that offset is stored placement: Ripple
sequences it, and with Ripple off choosing, lengthening or removing the pause moves
only the paired right clip and rejects conflicts. The timeline draws the slot as a
dark block in the track. During the slot the track shows black with its Transform
geometry (the left clip's recording aspect) and its Opacity, so lower tracks stay
covered exactly as during a fade through black; no frame is decoded for it. Any slot
routes export through the composited path. Future transitions that need their own
time use the same slot: `transitionOffset` places the right clip and `sampleSlots`
supplies what the slot draws. Track opening/closing
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

Preview decodes editing proxies with WebCodecs in a worker: a nonempty
one-video-track project uses **two decoders/textures**; eight tracks use **16**, two
per track, never one per stored clip. Each decoder delivers exact source frames;
active clips keep their decoders and the next clip of each enabled track is
prefilled in a free one, so cuts, dissolves and clips on other tracks start without
seeking during playback. A required frame that is not yet decoded holds the
previous image and buffers (**Diagnostics** counts stalls at clip boundaries
separately from mid-clip stalls, with the total stall time); with music the
audio clock continues and late frames are skipped. Source review uses its own
one-decoder worker. See [WebCodecs preview decoding](design/WEBCODECS_PREVIEW.md).

Seeks and timing changes discard obsolete decoded frames by stream generation;
no stale frame is uploaded while the target recording decodes. Scrubbing the playhead or
ruler never cancels the frame being decoded while the pointer moves: it is drawn, then the
newest position, possibly through a cheaper exact frame on the way, and the image settles on
the exact frame once the pointer rests ([scrubbing](design/WEBCODECS_PREVIEW.md#timeline-scrubbing)).
All track opacity/colour channels use project time, so coverage and grading can change
even on held source frames. Appearance-only edits update rendering without reloading
unchanged timing/music. Source/speed/placement edits pause and reload
the placed map; shared track keyframe edits never change timing.
Opacity and Transform changes remain appearance-only. Black fades preserve coverage and grouped
dissolves use the source-over contract above. See
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Snapping, projects and music

**Snap** uses an eight-pixel tolerance converted to project frames at the current
zoom. Ruler clicks and playhead scrubbing snap to video/music boundaries and
[bookmarks](#bookmarks); ruler range
edges also snap to the playhead captured at pointer down. Trim handles also
snap to the original, stationary playhead. Shared Colour and Transform keyframe and clip
speed-keyframe drags use boundaries, bookmarks and
the stationary playhead captured at pointer down, with their captured zoom throughout
autoscroll; a speed keyframe snapped to its clip's end lands on its exclusive OUT. Ripple-off moves match either leading or trailing edge to other clip/music/
transition boundaries, bookmarks, frame zero or the captured
stationary playhead; their own old edges/transition regions are excluded. Holding
Alt bypasses these magnets. A trailing-edge snap starts the clip its own duration
before the magnet. Ripple-on
insertion remains boundary-based even with Snap off or Alt held; only an explicit
move of its retained first clip changes the anchor. The
toggle persists for the current timeline session, not the renderable document.

### Snap to beats

**Snap to beats** (metronome icon beside **Snap**) adds the analysed beats of every
music clip ([music analysis](SPEED_AND_AUDIO.md#music-analysis)) to the snap targets of
every snapping gesture above, so cuts land on the beat. Its menu chooses **Off**,
**Beats** or **Downbeats only**; the button toggles between Off and the last choice, and
the choice is a browser preference. It works only while **Snap** is on (otherwise the
button explains why), and Alt still bypasses it. The beats are computed from each music
clip's current placement, source range and loops at the start of every gesture, so they
follow the clip when it moves, is trimmed or changes recording; a music clip being
moved or trimmed never snaps to its own beats. Nothing is written to the project:
bookmarks stay the user's own. While beat snapping is active, the beats it uses appear
as ticks along the bottom of the time ruler (downbeats taller), thinned like the clip
ticks below when they are closer than 4 pixels. Music without an analysis or without a
steady beat adds no targets.

### Bookmarks

A **bookmark** marks one project-time frame, for example a beat or an event in the
footage, as an extra snap point. Bookmarks belong to the project, which
requires `bookmarks`, an array of at most 1,000 unique ascending integer project
frames (0–2,147,483,647), `[]` on new projects; a missing or malformed array is
invalid, never defaulted. They are editing aids only: they never retime clips,
music or keyframes and are never rendered or exported.

- **Bookmark** in the timeline toolbar, or **M**, adds a bookmark at the playhead.
  When the playhead is on a bookmark, the toolbar button becomes **Delete bookmark
  at playhead** (trash icon). **M** on an existing bookmark is rejected with an
  error, never merged. Without footage or music there is no playhead to mark.
  While a time range is selected, the button turns orange and, with **M**, adds
  bookmarks at the range's IN and OUT edges (skipping any already present) in one Undo step;
  it is disabled when both exist.
- **Previous / Next bookmark** beside the toolbar button, or **Shift+↑ / Shift+↓**,
  move the playhead to the nearest bookmark strictly before or after it, without
  editing; a bookmark after the last frame previews that last frame.
- Bookmarks are small lilac outlines of the playhead shape (“ghost playheads”) in the
  lower half of the time ruler, filled on hover, focus or drag, with a faint dashed
  line through the tracks (stronger while dragged). Click, Enter or Space seeks to one without editing.
- A bookmark slides like the other timeline markers (`useKeyframeSlide`): drag it
  (3-pixel threshold, snapping to clip/music/transition boundaries, other bookmarks
  and the playhead, never its own origin; Alt bypasses; edge autoscroll), or press
  ←/→ on a focused bookmark (one frame, Shift ten). Drafts preview without
  history/save; a valid release is one Undo step. An occupied frame shows a red
  ghost and commits nothing; Escape, pointer cancellation, lost capture or window
  blur restores. Delete or Backspace on a focused bookmark removes it.
- Every gesture that snaps to clip boundaries also snaps to bookmarks within the
  same eight pixels: trims, clip moves and drops, music placement/trim, track and
  clip speed-keyframe drags, ruler clicks/ranges and playhead scrubbing. Snapping
  to existing boundaries is unchanged. To snap to the music's beats, use
  [Snap to beats](#snap-to-beats) rather than bookmarks.

Each analysed music clip shows its beats as ticks above its tone strip, downbeats
taller and brighter, following its placement, source range and loops; when beats are
closer than 4 pixels only downbeats are drawn, then none. The ticks are display only;
the clip also shows the music's structure ([music analysis](SPEED_AND_AUDIO.md#music-analysis)).

Adding, moving and deleting are each one Undo step and autosave like other edits.
Bookmarks are project-wide: not per track, named, coloured or ranged.

Projects are named separate **current-schema** documents with complete required video track colour, track
Transform base/per-setting project-frame keyframes, a boolean clip `reverse`, project bookmarks and per-track Ripple,
transitions, opening/closing fades and numeric `opacity` in 0–1. New tracks start
at 1 (100%); a missing saved field is invalid. Switching flushes autosave first,
blocks on failed saves, and resets session selection/history; successful export
snapshots are independent of the open project. Projects saved with an older supported
schema are upgraded on load; projects and receipt snapshots older than the oldest supported
schema remain rejected and preserved, without fabricated defaults.
There is no automatic deletion. Track `opacity` is the required sole stored value;
saved `clip.opacity` and old `clipOpacity`/`layerOpacity` keyframe fields are rejected,
not ignored or defaulted. Keyframes require exactly fifteen nullable channels: `opacity`,
twelve scalar colour fields (including required `temperature`, `tint`, `vibrance`, `whites` and `blacks`), `hdr` and `localContrast`.
Track Colour requires those bases and static HSL/curves; missing fields are invalid.
Recreate projects older than the oldest supported schema and deliberately import recordings/music
to reuse registered sources/verified ready proxies. Confirmed project deletion removes only its saved
document, never originals, the shared registry/proxy cache or successful exports/
receipts. Removing a clip is not removing that recording from the import bin;
use **Remove from project** for that. Proxy formats are
unchanged; the registries are version 2 (full-content checksums).

The required `music` array holds **0–8 independent music tracks**. Like a video track,
each has a unique `id`, gain, Ripple, opening/closing fades, **1–8 clips** (each with a
unique `id`, registered `mediaId`, source IN/OUT, start/duration and loop flag) and one
transition per adjacent pair of clips. No null/singular fallback or omitted-field default
is accepted; projects saved before music tracks held clips open with one clip per track.
Version-1 export receipts require a strict current-schema snapshot and captured
audio-source/plan arrays (one plan per music clip); older snapshots/invalid arrays are
rejected while the receipt and finished output remain preserved. Current PCM format is unchanged.

Each music track has its own timeline lane holding its clips, each with its
backend-prepared waveform (the level every 10 ms, one column per pixel, [details](SPEED_AND_AUDIO.md#music-waveform)): a clip shows the recording name (and **loop**), kept at the
left edge while the clip starts off-screen, and a boundary button (**Cut**, **Crossfade**, **Fade** or **Pause**) sits between adjacent clips. Clicking a clip, or Enter on it, selects it and
its track, as does **Audio → Music → Music track** (then **Clip**); a boundary button
selects the clip before it and focuses that transition in Audio. **Add music track**
lists ready music files and creates a track with one clip; **+ Clip** adds a clip after
the selected track's last one. Dragging a ready file from Media → Music onto a music
track adds a clip there at the drop frame (a Ripple track takes it at the nearest place in
its sequence), or starts a track when dropped on the empty music area. The trash actions
remove the selected clip or the whole track. Import never implicitly places music.
Selection creates no save/history entry, and editing/removing one clip or track leaves
all others and imported media intact.
Independent drafts cannot apply to another music track or clip. Placement/trim gestures
are transient and commit once; each accepted edit/add/remove is one Undo step.
Invalid release/cancellation is atomic with no committed draft/history/save.
Numeric controls provide source IN/OUT, placement/duration, track fades and transition
durations; gain uses a native slider with an exact `NumberField`, and looping is explicit
per clip. A music track's **Ripple** plays its clips one after another from the first
one's start, re-sequencing later clips after a move, trim, removal or transition change;
without it each clip keeps its start. Music is never retimed or rippled with video tracks.
A Crossfade overlaps two clips by its duration with two linear fades; a Fade through
silence fades the first clip out, then the second in; a Pause leaves a dark dashed slot of silence between them, which the right clip starts after. Transitions or fades that do not
fit are refused, never shortened. All music clips sum linearly after their
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
IN/OUT handles, numeric fields and I/O marks are non-destructive. OUT is
exclusive; handle drafts cancel/release independently of timeline history/autosave.
There are no separate Mark IN/OUT buttons: Home/End on a handle restores
that edge, and the reset icon after OUT (**Reset source range**) restores the whole recording
(IN = 0, OUT = frame count) in one action, replacing any unapplied numeric draft and keeping the
displayed frame; it is dimmed with its reason when the range already covers the whole recording.
The numeric pair applies on Enter or when focus leaves both fields, validating IN and OUT
together; invalid drafts keep an inline error until corrected or restored with Escape.
The source range strip below the image spans the whole original with its five prepared
snapshots; hatching identifies omitted footage and timeline-style **IN / OUT**
handles (24 px pointer targets) trim, while the rest of the track scrubs. Drag
feedback previews IN or the last included frame (OUT − 1) with an overlay hint on
the image; Escape, pointer cancellation, capture loss or window blur restores the
applied range and prior source frame. Missing snapshots degrade to an explicit
**Snapshots unavailable** track without starting preparation.
The round **Play / Pause** button at the left of the source range strip plays the
verified proxy, without audio, within the applied range,
from the current displayed frame if it precedes the last included frame, otherwise
from IN. It stops on exactly OUT − 1, without looping. A one-frame
range simply displays that frame. Numeric drafts do not change the played range.
While the **Source preview** tab is shown, Space plays or pauses it like this button,
never the timeline.
Scrubbing, trimming, marking and numeric range edits pause first; closing, hiding, switching
recordings/projects or leaving Source preview cancels pending playback and releases
its sole decoder. Loading/playback failures remain explicit with Retry. Source
playback never moves the timeline/music, changes clips/track keyframes or saves/history.
The applied range is the recording's **kept range** and part of the project (`selects`, below):
applying one saves with the project, in one Undo step, and affects future insertions only.

### Kept ranges

A project's required `selects` field maps recordings of its bin to the ranges the user keeps of
them: ascending integer `{ sourceIn, sourceOut }` ranges (OUT exclusive, at least one frame, at most 100,
separated by at least one frame since touching ranges are one) inside the registered recording. No entry
means the whole recording is available; an empty list is invalid. A recording that leaves the project with
**Remove from project** loses its entry. Clips, trims and the timeline may still use any frame: selects
record what the user kept and never retime, render or export (assistant sessions will be bound by them,
[ASSISTANT_MCP](design/ASSISTANT_MCP.md#project-selects-schema-bump)). Edits are the commands `select-set`
(replaces a recording's ranges; an empty list makes the whole recording available again) and
`select-narrow` (a subset of the existing ranges only).

Source preview edits the **active** kept range, the first by default: setting IN/OUT by handle, numeric field,
I/O marks or **Use** (steadiest range) creates the entry with its first range and later changes that range;
**Add clip** copies it. The handles stop one frame from the neighbouring kept ranges (their range sliders end
there, Home/End too); typed IN/OUT that overlap or touch another kept range are rejected with an inline
error, never merged or clamped. **Reset source range** returns to the whole recording (IN = 0, OUT = frame
count), removing every kept range in one step. The trash after it, **Delete selected kept range**, removes only
the active range, the next one becoming active (the last one leaves the whole recording again); without a kept
range it is unavailable, with its reason.

The **Kept ranges** button beside the readout (**Whole recording**, or **N kept ranges**) opens their list:
one row per range with its IN → OUT timecodes and length, which makes that range active (moving to its IN),
and a trash, **Remove kept range N** (removing the last one keeps the whole recording again). Below the list:

- **Add range** keeps a further range of 60 frames, or less where the room ends: from the displayed frame when
  it is at least one frame from every kept range, otherwise centred in the largest free stretch. It is
  unavailable, with its reason, without room and at 100 ranges.
- **Add all N** (with two or more ranges; **Add all N kept ranges to** the target track) inserts one clip per
  kept range in recording order, like **Add all** steady ranges, in one Undo step.

On the range strip, the other kept ranges are lighter outlined blocks: clicking one makes it active (and
scrubs there), and **Shift-drag** in a free stretch draws a new kept range, which stops one frame from its
neighbours and becomes active on release (a Shift-click without moving adds nothing). Escape, pointer
cancellation or lost capture abandon the drawing. Each change is one Undo step, and applying never leaves
Source preview. The active range is editor-only state; ranges kept before this field
existed in the browser (`localStorage`) are not read.

### Camera motion and the steadiest range

Source preview suggests the steadiest stretch of a drone recording, where the camera
moves without brutal changes of angle or speed. Once a proxy is verified the recording
is ready, and a **Camera motion analysis** job measures it in the background: that job
runs after every other queued job, so a batch import makes all its proxies first. It
decodes the verified editing proxy at 320 × 180 grey and measures, for
every frame, the camera's global motion since the previous one (translation, zoom and
rotation from block phase correlation, with a robust fit that ignores moving water,
trees or other subjects). Featureless frames stay unmeasured. Chunks of 30 frames are
measured on up to eight worker threads (host cores − 1, in process below three cores),
with results identical to one pass: about 350 frames/s for a 720p proxy on the
16-thread development machine, roughly a tenth of the recording's duration. It also reads the original's first subtitle track,
where DJI Mini drones record telemetry once per second, and keeps horizontal and
vertical speed (`H.S`, `V.S`, m/s), height (`H`) and distance from home (`D`, m), ISO,
shutter speed (`SS`), exposure bias (`EV`) and digital zoom (`DZOOM`); GPS position and
aperture are not kept. This demuxes only that track (about 0.2 s for a 600 MB rush);
recordings without it simply have no telemetry. The result is cached as
`motion-v3.json` beside the proxy and its thumbnails, tied to the proxy's verification
time; re-preparing the proxy replaces it, and older `motion-v1.json`/`motion-v2.json`
caches are ignored (use **Analyse camera motion** to measure again). A failed or
cancelled measurement leaves the proxy usable; Source preview then offers **Analyse
camera motion**. The original
is identity-checked and only its subtitle track is read.

Opening a recording reads its analysis, once per session. Directly under the range strip,
in the same column, the **motion timeline** stacks lanes, each labelled at its top-left;
one playhead line runs through the strip and every lane, and the footage omitted by IN/OUT
(including a trim draft) is hatched across them. The 44 px image lane plots the **jolts**
(amber area: how fast the camera movement changes, % of image width per s², up to 8),
the **movement** in the picture (white line, up to 10 % of width per s) and the **allowed
movement** (dashed accent line); a 30 px lane follows for each chosen flight data value,
scaled from its lowest to its highest value in the recording, which its label shows (a
nearly flat value is widened to a minimum span, such as 5 m of height or 2 m/s of speed,
so sensor noise does not fill the lane), each in its own colour, matching its swatch in the menu; steady ranges are
accent bands across every lane, the suggested one strongest. While hovering, every lane
label shows its value under the pointer (flight data interpolated between its
once-per-second samples) and the image lane the timecode. Clicking or dragging any lane
scrubs like the strip. Below the IN/OUT fields, separated by a hairline, the **Camera
motion** section has a header row: its title (a chevron button, **Collapse camera
motion**), its help, **Steadiest range** with its length and IN–OUT timecode, and **Use**.
A controls row follows: the **Allowed movement** setting, the shared slider with exact
field and Reset (0.5–6, initially 2; neutral is the initial value), and **Flight data**
(**Flight data lanes**), a menu choosing which flight data values this recording has get
a lane, **Flight speed** initially. Collapsing hides the lanes and controls, keeping the
title and the suggestion; the collapse, allowed movement and flight data choices are
browser preferences. The suggestion is the longest stretch of at least 2 s below the
allowed movement, bridging jolts shorter than 0.5 s and keeping 0.2 s clear of rough
edges inside the recording. A stretch where the camera stands still is not a steady range:
when at least 99.5 % of its frames move less than 0.5 % of the image width per second
(about three minutes to pan one width), the drone is hovering with nothing happening in
the picture, so it gets no band, suggestion or Add all clip. Move the **Allowed movement** slider, or drag the dashed line
itself (it highlights within 6 px, and the image lane shows its value; dragging the line
never scrubs). **Use** applies the suggestion as the applied source range (and shows its
IN frame), like any other range choice: no project edit, history or save; it reads **In
use** once applied. **Add all N** (**Add all N steady ranges to** the target track)
inserts one independent clip per steady range at the current allowed movement, in
recording order, exactly like **Add clip** with that range: Ripple-on tracks append,
positioned tracks start at the playhead, and the whole batch is one Undo step. It leaves
the applied source range unchanged. While its analysis waits or runs, the header shows
**Camera motion queued…** or its progress. Recordings prepared before this analysis existed show **Analyse
camera motion** in the header instead, which queues one **Camera motion analysis** job
(shown in Activity). Forward
acceleration seen straight ahead barely changes the picture, so speed changes without
turning are not detected by the jolts; the flight speed line shows them, but does
not change the suggestion. Flight logs are not used.

Source **Add clip** stays in the pinned review for repeated additions. Its
sticky header and native nonmodal clip popup keep adding/reviewing reachable
without a tall list shrinking the preview or moving controls. Media
plus/double-click/drop, explicit Show, selection and timeline edits return to Timeline.
Close/hidden/offscreen/project switch releases the one review decoder.

The normal editor shows Media, Preview, the contextual Properties panel and Timeline.
Panels are resizable/collapsible with browser-local layout persistence; source
review occupies a docked viewer tab rather than covering the workspace. Main and
stored Colour/Opacity/Transform values, playback rates and gain share native sliders with
adjacent exact `NumberField` controls, not read-only outputs or number-only layouts.
Dragging a Colour, Opacity, HSL or Transform slider (main or stored) previews the draft value in the image, coalesced to the display rate, without any document, history, autosave or Properties change, and without restarting music. Release commits one validated edit and one Undo step. Escape, pointer cancellation, lost capture, window blur or an invalid value restores the control and the preview. Other sliders (speed, gain) keep their release-only image update. Each keyboard slider
adjustment is an individual validated edit. Numeric fields retain full entered
precision, commit on Enter/blur, keep invalid drafts editable and restore on Escape.
**Clip → Range** uses the full-original bar and exact timecode text fields above.
Other integer source/placement frames, durations and fades retain exact native
numeric steppers and existing timecode feedback, without arbitrary timing sliders.
Source-review IN/OUT fields apply as a pair on Enter or when focus leaves both; Escape restores.
**Clip / Track / Audio** separates clip-owned source/placement/speed/Detail,
track-owned Colour/Transform/keyframes/transitions/fades, and music. The header directly exposes
help; **Workspace options**
holds layout reset and Diagnostics, while Media and the Properties panel collapse from their
own headings. **Track options**
holds only rename/Ripple/stacking/deletion; a clip's right-click menu holds Duplicate,
while the frequent split/trim/delete/cut actions stay directly visible. The timeline
zoom keeps its slider and **Fit**, with **Zoom out / Zoom in** buttons beside it.
Zoom is a session value from 12 to 180 px/s; zoom out goes lower, as far as the scale at which the
whole timeline extent fits the viewport, so a project of any length can be shown in full. **Fit**
(or **F**) sets that scale (at most 180 px/s): the extent is the playable duration, music and stored
keyframes and bookmarks after it, and a short margin remains after its end, so no horizontal
scrollbar appears. Recoverable footage past a selected last clip stays reachable by scrolling and
can add one. Ruler labels stay at least 120 px apart below 24 px/s.
Diagnostic counters, shader tests and the two-clip native comparison tool remain
hidden behind Diagnostics. **Export** uses the bounded native multi-clip
renderer, with profiles for 720p drafts and 4K finals. The diagnostic two-clip
reference remains limited to two normal-speed forward clips on one enabled,
zero-origin contiguous video track with Opacity 1, Shadows/Highlights/HDR/Local contrast 0 and a neutral track Transform
without keyframes and neutral detail filters, without music/extra tracks/shared track keyframes
and at most 3,600 project frames.
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

Video track Colour includes static **HSL ranges** and **Colour curves**, each in its own collapsible Track section after Colour. They affect every clip and both dissolve sources on the track, whether or not its twelve scalar channels are keyed. Moves use the destination track's complete colour; clip edits never copy these settings. They are not speed curves or new animation channels. See [the HSL/curves contract](design/HSL_AND_CURVES.md).
