# User guide

PasCap is a local Linux video editor: the browser edits a project, and the local
service prepares previews and exports from original files. There is no account,
upload or cloud workflow. For setup, see [DEVELOPMENT.md](DEVELOPMENT.md#run-locally);
for source paths, storage and the native toolchain, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Start a project

Open **Projects**, create a named project, then import its recordings and music.
A new project has an **empty timeline and empty video/music bins**; it does not
inherit the shared media registry. Importing the same original into another project
deliberately adds it to that project's bin and reuses eligible verified proxies.
Removing a clip or music track does not remove the imported recording.

Projects use **a strict current format**, with complete required video track colour and track
Transform (base plus per-setting project-frame keyframes), a required `bookmarks` array of project frames (`[]` on new projects), a required `music` array of 0–8 independent
music tracks of clips joined by transitions, with unique required IDs (`[]` without music), every video track's Ripple, transitions and
opening/closing fades and required numeric `opacity` in 0–1 (1 on new tracks),
with fifteen nullable animation channels, in control order: `opacity`,
`temperature`, `tint`, `exposure`, `brightness`, `contrast`, `hue`, `saturation`,
`vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`, `localContrast`. Clip speed is constant or a 1–256-keyframe custom curve,
and every clip requires a boolean `reverse`.
Video track Colour requires Temperature/Tint/Vibrance/Whites/Blacks/HDR/Local contrast bases and static
HSL/curves; missing fields and saved clip colour/correction are invalid.
Track `opacity` is the sole saved Opacity value; saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` keyframe channels are invalid, not ignored or defaulted.
Projects saved by this or a later PasCap version keep opening: an update that
changes the project format upgrades a project when it opens and, on its first save,
keeps the original file beside it (`<id>.json.schema-N.bak`). Project documents and
receipt snapshots from early development versions stay on disk but cannot be opened:
there is no automatic repair or deletion. A project saved by a newer PasCap version
is refused until you update. Export receipts
remain version 1 with a strict current-schema snapshot and required audio-source/instance-plan arrays.
Finished videos remain
untouched. **Delete project** requires confirmation and deletes only the saved
project document, not originals, the shared registry/proxy cache or exports/receipts.
Proxy and current PCM cache formats are unchanged; the video and music registries are
version 2 (`videos.json`, `music.json`, with full-content checksums), so recordings
from older registries must be imported again.

### Project files

PasCap saves projects automatically in its data directory. To keep your own copy,
for a backup or before a risky edit, open **Projects** and choose **Save file** on a
project: Chrome asks where to save it, other browsers download it as
`<title>.pascap.json`. Unsaved edits of the current project are saved first. To
return to that copy, choose **Open project file…** in Projects: it opens as a **new**
project with the same title and never replaces the project it came from. Its
recordings and music must already be imported in this PasCap service, with their
originals in place; otherwise nothing is created. A file only references recordings
by their PasCap ID: it contains no media, proxies or exports.

Keep originals readable at their registered service-side paths. Moving a file,
changing a mount or disconnecting a drive can fail even with a ready proxy.
If an original was moved, its Media card shows **Original missing**: choose
**Relink** (link icon) and pick the moved copy, or type its path under **Other
location**. Activity checks every byte against the registered original; on a match
clips, proxy and settings are kept, and a different file is refused. If a whole
folder moved, choose **Relink folder…** above the Media list (or **Search this
folder** in any Relink dialog), open the new folder and search it: every missing
recording found there or in its subfolders is relinked in one Activity job, which
lists any it did not find. Recordings
never prepared have no checksum and cannot be relinked: import them again. There is
no automatic path guessing or search; see [relinking](design/SOURCE_RELINK.md).
Keep generated data outside footage, and back up originals and saved project/export
data separately.

## Import and prepare recordings

1. Choose **Import** in the Media panel. The **Import media** dialog browses the
   service's approved locations (listed on its left), not your browser's
   operating-system file picker. Open a folder, check video and music recordings
   (Shift-click selects a range; **Video** / **Music** narrow the list) and choose
   **Import**, or double-click one recording to import just that one.
2. Browsing and selection alone start **no preparation**. Each listing reads one
   folder's metadata; it does not probe, register or write anything next to your
   recordings. Video rows show a small picture from the middle of the recording
   once they scroll into view (a crossed eye means no picture could be read; hover
   it for the reason). Folders sort first. A warning that a folder has too many
   entries means choose a narrower folder.
3. Registration references original paths without copying footage. Eligible editing
   proxies queue automatically; **Activity** shows queued/running jobs and progress.
   Only **Ready** recordings can be inserted or hover-reviewed. Preparation is serial;
   ready assets and queued/running work are reused rather than encoded twice.
4. A complete import closes the dialog. Otherwise its report lists what was not
   imported or queued, and those recordings stay selected: accepted registrations are
   kept. Check Media/Activity before repeating an uncertain request. Failed, cancelled
   or interrupted preparation needs explicit **Prepare**; **Prepare selected**
   confirms a manual multi-recording batch.
5. To take a recording out of this project, use its trash button (or the trash on
   the selection header). If clips use it, PasCap asks first and removes them
   too; Undo restores everything. The original file and prepared media are kept.

**Other location**, at the bottom of the locations, imports a path you type: a video
or music recording, or a folder, which recursively imports every video recording in
it and can queue substantial work. Use it deliberately, with a narrow folder.
It may target a path outside approved locations, but does not add a location.
Startup, library reads and hovering never prepare old unprepared recordings.

Approved roots default to the service user's Videos folder. `PASCAP_MEDIA_ROOTS`
configures them; unavailable roots remain visible, symlinks are rejected and the
cache branch is excluded. Selected-path requests accept at most 5,000 recordings.
There is **no upload, browser file picker or optional copy mode**. External desktop
file/folder drops only block navigation and show Import guidance; internal dragging
of ready Media into Timeline is supported.

MP4/MOV/M4V extensions are not a guarantee of compatibility. Current source checks
require one unrotated video stream, constant **30000/1001 fps**, unambiguous zero-start
timestamps/frame counts, 8-bit `yuv420p`, and explicit SDR BT.709 colour/range tags.
HDR, untagged colour and ambiguous timing are rejected, not silently normalised.
See [TIMELINE_EDITING.md](TIMELINE_EDITING.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

### Damaged recordings

A recording damaged by a bad copy or card can contain video frames no decoder can
read. Players such as VLC skip them; PasCap stops instead, because every frame
must stay at its exact position. Preparation then fails with **Damaged** on the
card and names the spoiled time, for example _00:13:00–00:13:29_: the whole
second around the unreadable frames, since the frames that depend on them decode
as garbage. Choose the card's wrench button (**Prepare … with damaged frames shown
black**) to use the rest of the recording. Those frames then show black in the
preview and in every export, and the card keeps a **Damaged** badge; hover it for
the time range. In Source preview they are hatched red on the range strip and the
camera motion lanes (hovering reads **Damaged · shown black**), and steady ranges
never include them. The original is never modified. Copying the recording again from
the camera card may give an undamaged file.

## Review a recording and add clips

Hover a ready recording to open **Source preview**; horizontal mouse position
scrubs its full source range without moving the timeline playhead. Clicking a
recording keeps it in **Source preview**: hovering another recording previews that
one, and moving the pointer off it returns to the clicked recording and frame.
Review opens paused, without audio, and
uses a separate decoder; it never plays or prepares an original implicitly.

Set source **IN/OUT** by dragging the handles, with focused source **I/O**, or with
the paired numeric fields, which apply together on Enter or when you leave both;
Escape restores an unapplied draft. OUT is exclusive; **O** includes
the displayed frame. Drag a handle back to an edge (or press **Home**/**End** on it)
to restore that edge, or use the reset icon after **OUT** to restore the full recording.
The applied range is a **kept range** of the recording, saved with the project (so it follows
the project file, one Undo step each). A recording can keep several: the **Kept ranges** button beside
the time readout lists them with their timecodes and lengths. Click a row (or a lighter block on the
strip) to edit that range, use the trash to remove it, **New range** to keep another (from the displayed
frame when it is free, else in the largest free stretch) and **Add N clips to timeline** to add one clip per
kept range.
**Shift-drag** on the strip draws a new kept range. Handles stop next to the other kept ranges, and the
reset icon returns to the whole recording, removing every kept range; the trash after it deletes only the
selected kept range.
Ranges cannot overlap or touch. Clips can still use any frame of the recording.
Details: [kept ranges](TIMELINE_EDITING.md#kept-ranges).

The source range strip under the image shows snapshots across the whole recording, like
a timeline clip. Its **IN / OUT** handles restore omitted footage as well as trim;
hatched parts are outside the selected range, and clicking elsewhere on the strip
scrubs. Dragging previews the boundary frame; release applies, while Escape/capture
loss/cancellation/window blur restores the prior choice. The round **Play / Pause**
button left of the strip reviews the applied range, without audio, from the current frame or IN.
It stops at the last included frame (OUT − 1), without looping; a one-frame range
just displays that frame. Unapplied numeric drafts are not played or inserted.
Scrubbing or changing the range pauses first. Closing, switching sources/projects
or leaving the Source tab cancels playback. Source playback does not move the
timeline or music and does not create Undo steps or saves. Failures expose Retry.

Choose **Add clip** (it shows the applied range length, for example **Add clip 3.00 s**),
mark another range, then add again: each addition creates an independent clip and
keeps the same source open at the same frame/range. **Clip added · mark another range**
confirms a successful addition.
The **Show N clips** button beside the recording name lists existing ranges; **Show** selects,
seeks and reveals one on the timeline. Reuse badges count clips, not copied files.
In Media, a hatched head/tail on a recording's thumbnail shows the omitted part of
its applied range, like a miniature timeline.
Media **+**, double-click and drag/drop (dragging a selected recording carries the
whole selection) also copy the applied range
(or the full recording without a choice). Later source choices never alter existing
clips. Plus/double-click target the selected video track; a drop targets the track under the pointer.

### Find the best steady range

After a drone recording is prepared, a background job measures its camera motion
(Activity shows it after the other jobs, so every proxy of an import comes first). Lanes directly under the
source range strip share its playhead and hatching: the first shows jolts (amber area:
sudden angle or speed changes), camera movement (white line) and the dashed allowed
movement (drag it); the green bands mark steady ranges, the suggested one strongest.
Stretches where the camera does not move at all, such as a hover, are left out.
Hover to read the values at that moment; click or drag to scrub. Below the IN/OUT
fields, **Camera motion** gives the **Best steady range**, what it shows, its length and IN–OUT, and **Use best**
sets IN and OUT to it. The best one favours an orbit (the picture turns, or slides sideways while the
drone flies) or a reveal (a climb or a pull out), then other camera moves, then an approach (only
pushing in) and nearly still footage, each counting its length up to 10 s.
**Use all N** keeps every steady range instead, in recording order and in one
Undo step; neither adds clips: use the **Kept ranges** list for that.
Move **Allowed movement** left for only very steady footage,
right to accept more movement. **Flight data** adds or removes lanes: flight and
vertical speed, height, distance from home, ISO, shutter speed, exposure bias and digital
zoom, for example to spot a climb or an exposure jump. The chevron hides the lanes and
controls, keeping the suggestion. Recordings prepared earlier offer **Analyse camera
motion** to measure them once. Straight-ahead speed changes barely move the picture: the
flight speed lane shows them, so check the start of forward flights yourself.

## Assemble, trim and cut

Use up to **eight uniform video tracks**. Each starts with **Ripple on**; find the
checkbox in **Track options**. Enabling it packs clips and closes gaps in **one
Undo step**, preserving the first clip's current start and valid existing dissolves.
While on, insert/reorder/delete/trim/speed edits continuously sequence that track
from its first anchor. Turning it off keeps actual placements for independent
edits; it does not restore old gaps. Other tracks, music and track keyframes stay fixed.
With Ripple off, edits never move unrelated clips and conflicts reject the edit.
Same-track overlap is allowed only for an exact adjacent cross-dissolve; use different
tracks for independent simultaneous footage.

Video tracks follow **bottom-to-top composition order**: track 1 renders below track 2, track 3
above track 2, and so on. There is no primary/overlay role or special first-track ID.
Raise/Lower change composition priority; any track can be reordered or deleted
except the last remaining video track. Scroll over the tracks or track headers to
reach all video and music tracks. The time ruler and its playhead handle remain
visible while scrolling; its ticks follow horizontal scroll. Clicking it seeks,
dragging it selects a range to cut and dragging the playhead handle scrubs, without
editing a track. Track options explains unavailable actions at
stack endpoints or on the last remaining track. It contains only rename, Ripple,
Raise/Lower and Delete; visibility stays in the sidebar and Opacity in **Colour → Track**.

Select a clip and drag a timeline edge inward to shorten it or outward to restore
omitted footage up to the original bounds. The dashed extent shows available source.
Left-edge autoscroll can recover a long omitted beginning. With Ripple on, a timeline
left handle/keyboard trim keeps the sequence start; with it off, it changes the
start to retain timeline OUT. Invalid overlap or fade edits are rejected.
Originals and full proxies are never cut or regenerated by trimming.

**Clip → Range** has one full-original bar with hatched omitted footage and
draggable **IN / OUT** handles. Exact **Source IN / OUT** text fields below its
ends show **MM:SS:FF** (30 fps NDF); enter a whole original-frame number or
timecode and press Enter or leave the field to apply. OUT is exclusive. Invalid
drafts stay editable with an error; Escape restores. There are no duplicate
duration, original-length, source-frame or recoverable head/tail labels.
**Restore full recording** restores both endpoints.

These fields and bar handles keep clip placement fixed in both Ripple modes,
re-sequencing the Ripple suffix normally rather than retaining timeline OUT.
Dragging previews the complete validated document; final valid release is one
Undo step. An invalid final release, Escape, cancellation, lost capture or blur
restores without applying an earlier valid draft. Focused handle arrows move one
original frame (Shift ten); Home on IN restores zero and End on OUT restores the
original exclusive OUT. Source review keeps its independent numeric IN/OUT pair (Enter/blur applies, Escape restores).

- **Split / S** splits at the playhead and selects the new right piece.
- **Trim start / Q** removes the head before the displayed frame; **Trim end / W**
  removes the tail after it. Both keep that frame; handles can recover omitted footage.
- To remove a middle section, **drag on the time ruler** across the unwanted frames
  (the preview shows the edge you drag) and select the clip. The hatched part of
  the selected clip is removed by **Delete** (the orange trash) or Shift+Delete, in **one Undo step**;
  without a clip, or with a range outside the clip, its tooltip says why.
  A click on the ruler or Escape clears the range; changing a transition or fade keeps
  it. While a range is selected, Play
  replays only that range, stopping on its last frame; the start/end buttons and
  **Home/End** go to the range's first and last frame.
  Ripple-on cuts close the gap on that track; off keeps the removed gap and fixed neighbours.
- **Duplicate** (right-click the clip) or **Ctrl+D** makes an independent clip. Timeline
  Delete removes a clip, not its original or project-bin membership.

Placement ghosts show the actual video track/start with the clip's own duration,
which never depends on its track or start.
Red invalid ghosts never commit. **Snap** uses nearby boundaries; **Alt** bypasses
magnets, but cannot turn a Ripple-on track into free placement. Trim and keyframe drags
preview transiently, commit once on valid release, and cancel with Escape.
**Timeline start frame** works on independently positioned clips
or the **first Ripple anchor only**. Later Ripple clips expose a tooltip reason:
drag to reorder, or turn Ripple off in Track options to set an independent start.

To move several clips together, **Ctrl-click** (Cmd-click) them, or use a track header's
**Select all clips** icon to add a whole track; Ctrl-click a selected clip to remove it. The
last one clicked is the clip **Clip** properties edit (solid outline). Drag any selected clip:
clips from one track follow the pointer to another track, clips from several tracks only move
in time. On a Ripple-on track they slot into the sequence instead of keeping their gaps. Every
clip shows a ghost, and if any of them cannot go there all ghosts turn red and nothing moves.
**Delete** removes all the selected clips and **Alt+←/→** nudges them, each in one Undo step.
A plain click selects one clip again. Details: [timeline editing](TIMELINE_EDITING.md#insertion-reordering-and-history).

**Bookmarks** mark times of interest, such as a beat, so edits snap to them. Press
**M** or choose **Bookmark** in the timeline toolbar to add one at the playhead; on
an existing bookmark the button deletes it instead. With a time range selected, the
button turns orange and adds a bookmark at each end of the range. Bookmarks are small lilac outlines
of the playhead in
the lower half of the time ruler: click one to go there, drag it or use ←/→
(Shift: ten frames) to move it, and press Delete to remove it. The arrows beside
**Bookmark**, or **Shift+↑ / Shift+↓**, jump to the previous / next bookmark. Trims, moves, music
placement, keyframe drags and ruler scrubbing snap to bookmarks like they snap to
clip edges; **Alt** bypasses. Each add, move or delete is one Undo step. Bookmarks
are saved with the project but never rendered or exported. Details:
[bookmarks](TIMELINE_EDITING.md#bookmarks).

To cut on the music, turn on **Snap to beats** (metronome icon beside **Snap**): every
snapping gesture then also lands on the analysed beats of the music clips, wherever they
are placed, and the ruler shows those beats as ticks. Its arrow chooses **Beats**,
**Downbeats only**, **Hits** (the strong hits: a kick, a snare or a crash that stands out,
also in music without a steady beat) or **Beats and hits**. Analysed music clips also show
their hits as marks coloured by band (low, mid, high; strong ones taller), sections (quiet,
build, peak, release), swells, silences and a low/mid/high tone strip; hover one for a
readout, or open **Audio → Music structure** for a list with the key and the strong hits.
Details: [snap to beats](TIMELINE_EDITING.md#snap-to-beats) and
[music analysis](SPEED_AND_AUDIO.md#music-analysis).

The waveform on every music clip shows the music's level every 10 ms, one column per pixel of
the clip, so a short hit or a silence sits where it plays; zoom in for more detail. It follows
trims and loops. Details: [music waveform](SPEED_AND_AUDIO.md#music-waveform).

Boundary **Cut / Fade / Pause / Dissolve** and **Fades** belong to the selected
track in **Track**; clicking a boundary button opens that tab and scrolls to the
boundary, expanded.
Gapped pairs are Cut only: explicitly close the gap or enable Ripple before adding
a fade/dissolve. A cross-dissolve explicitly adjusts the right clip to its overlap;
with Ripple off, no other clip moves and conflicts reject it. With Ripple on, check
**Keep the cut in place** first to lengthen both clips by half the overlap instead,
so the change stays where you cut (on the music, say) and later clips do not move.
**Fade through black with pause** fades out over **Fade** frames, holds black for
**Pause** frames, then fades in over the same **Fade** frames. The pause adds time
between the clips instead of hiding footage, so the right clip moves later by the
pause, the same way a dissolve moves it earlier.
Black fades darken only that video track's RGB, preserving coverage rather than revealing
lower footage. Opening/closing fades use actual first/last placements and remain
stored but dormant on empty tracks. A closing fade ends at its last video clip's
OUT, not a later music OUT; after all video ends the picture is black, never a
frozen last image. Details: [TIMELINE_EDITING.md](TIMELINE_EDITING.md).

## Colour, speed and shared video track keyframes

Each clip has independent constant or custom-curve speed; speed
is clip-only, never a track setting.
Colour is graded twice: by the clip's own **grade**, then by its video track's Colour, which
every clip on the track shares (see [Grade one clip](#grade-one-clip)). Transform belongs to the
video track, not the clip.
**Opacity** is one setting for the selected **whole video track**, not a clip.
Find its single native slider/exact numeric field in **Colour → Track**, with its
capture diamond and adjacent per-setting Previous/Next buttons. Colour groups its sliders
under small headings, each with a **Reset** icon that resets the group's editable settings in
one Undo step: **Opacity**; **Colour** (Temperature, Tint, Hue, Saturation, Vibrance); **Light**
(Exposure, Brightness, Contrast, Highlights, Shadows, Whites, Blacks); **Effects** (HDR, Local contrast).
**Vibrance** saturates muted colours more than strong ones: raise it to bring out a hazy
sky or dull foliage without making faces or bright colours garish; lower it to mute the
weakest colours first.
**Shadows** and **Highlights** work on areas, like Lightroom's: raise Shadows to open up
a shaded slope or a backlit subject, lower Highlights to bring back a bright sky. Each
area is brightened or darkened as a whole according to its overall brightness, so dark
texture in a sunlit field and the contrast inside the lifted area are kept, and mid-grey
never moves. They choose tones after Exposure. Nonzero or keyed Shadows or Highlights
make export use the slower composited path. Details:
[local Shadows and Highlights](design/DETAIL_FILTERS.md#local-shadows-and-highlights).
**Whites** moves the brightest tones: lower it to bring back a blown-out sky, raise it
to make whites brighter. **Blacks** moves the darkest tones: lower it to deepen hazy or
flat blacks, raise it for a faded, matte look.
Main and stored sliders/exact fields use **0–100%**, neutral **100%**.
Saved track `opacity` and keyframe values remain **0–1**; this is UI conversion only, not a schema change.
Without Opacity keyframes, either value control edits the track's saved `opacity` and works even
on an empty track. With keyframes, the track's `opacity` curve overrides that value on every
clip, including both sources in a dissolve. Removing its final keyed setting reveals
the unchanged saved track value. There is no saved clip opacity, additional track
multiplier or duplicate sidebar control/navigation.
With the Colour tab's **Track** target, static and keyed colour controls edit the video track,
including empty tracks; all clips on that track share that treatment, after their own grades. The
clip's right-click menu offers **Move to new track** (one Undo step, keeping the clip's start). Opacity shares their
UI treatment, but controls composition coverage, not the SDR RGB grade.
**Clip → Placement** contains placement only. Sliders never create implicit keyframes;
an animated setting that is not enabled at the real playhead is read-only until
its hollow diamond captures a keyframe there. It is shown dimmed with a lock cue
(**Add a keyframe ◇ to edit**), and dragging or typing in it changes nothing.
Speed accepts **0.1×–8×**. The main **Speed ×** rate and each custom-curve keyframe
rate pair a native slider with an exact numeric field, alongside modes, presets
and the curve graph. Slow motion repeats frames and acceleration drops them;
there is no optical-flow synthesis.
Speed changes only that clip's output duration, never because of its track or start:
Ripple-on tracks re-sequence, off keeps independent starts,
and incompatible fades/transitions/overlaps reject the edit rather than being shrunk.

### Grade one clip

The **Colour** Properties tab edits the selected clip's **grade** by default: its pinned header
names the clip and says **This clip only**. The **Clip / Track** switch beside it (or the arrow
keys on it) moves to the track's Colour, which then applies to every clip on the track after their
own grades; selecting another clip returns to Clip. Without a selected clip the tab edits the
track. With several clips selected, it asks you to select one, or offers the track.

A clip grade has the same Colour, HSL ranges and Colour curves sections as the track, without
Opacity, **Auto** and **Auto white balance**. It stays with the clip's footage: trimming, moving
it (to another track too), Ripple, splitting, duplicating and Reverse keep it, and split or
duplicated pieces each get a copy. Its keyframes are frames of the recording: a diamond keys the
image shown at the playhead (move the playhead onto the clip first), slow motion eases between
keyframes, and they appear as amber ◆ markers inside the clip on the timeline, which you can
click, drag or move with the arrow keys and delete with Delete. The **Clip keyframes** list
counts in source frames.

To give several clips the same look, right-click a clip whose grade has no keyframes and choose
**Copy grade**, then right-click another and choose **Paste grade**: it replaces that clip's grade
and removes its keyframes, in one Undo step. Paste on a selected clip applies to every selected
clip.

### Animation controls

Colour, Speed and Transform always show their capture diamonds while the section is expanded, Colour and Transform with adjacent per-setting **Previous/Next** buttons; there is no Animate toggle and no stored preference. Each expanded section has one keyframe line with the **number of keyframes**, one **Previous/Next** pair over the same set and **Reset**. The line is hidden while the section is collapsed; the title row and its help stay reachable. Rendering, retained keyframes and read-only constraints never depend on what is shown.

Colour and Transform capture buttons have adjacent per-setting **Previous/Next** buttons
because not every setting is enabled at every keyframe; Speed has a single setting, so its
keyframe line's pair is enough. Each section's keyframe line counts the keyframes its single **Previous/Next** pair visits. Colour visits any Opacity, scalar
colour, HDR or Local contrast keyframe. Speed visits **all retained custom
speed source keyframes of the selected clip**, including off-trim keyframes and the
original exclusive OUT, previewing the nearest mapped image.
Speed keeps a clip-local stored-source selection separate from track
inspection, so several stored keyframes can be visited even when they preview
the same first/last image. Transform visits all its track keyframes, including those
after the duration, with its own track-local selection. Enabled setting chips in stored Colour keyframe rows retain
their per-channel arrows too. All main and stored per-channel arrows visit only
strictly earlier/later keyframes where that setting is nonnull, including zero,
using the shared central off-duration inspection cursor. Main capture always
uses the real displayed project/source frame, not an inspected stored time.

Track-keyframe, Transform and custom clip-speed selectors all visibly read
**Easing**. Their contextual accessible names (such as **Track keyframe easing N**)
and interpolation remain unchanged.

### Temperature and Tint

In **Colour → Track**, **Temperature** and **Tint** open the Colour group. They use
normalized **−2…2** and **−1…1**, neutral **0**, not Kelvin.
Positive Temperature warms, negative cools; positive Tint adds magenta, negative
adds green. Nonzero settings intentionally colour greys. The common gain formula
runs in linear RGB before Exposure; it preserves neutral-white linear luminance
before clipping only, not final brightness or arbitrary coloured pixels.

**Auto white balance**, under Tint, removes a colour cast at the playhead: it measures
the light in sixteen frames around it (up to a second each side, within the clip
there) and keyframes Temperature and Tint at the playhead, exactly as their diamonds
would, in one Undo step. Where the light changes during a flight, run it again further
on: Temperature and Tint then ease from one keyframe to the next. It removes cool casts
more than warm ones, so a sunset stays warm, and large uniform areas such as sky or sea
barely count. Rerun at a keyframe, it replaces only these two values. It needs a
prepared clip of the track at the playhead; Escape cancels it.

Sliders, exact fields and the **Reset** icon beside each setting's name (or double-click the name) reset it to 0 and use the same main/stored
control rules as other scalar Colour settings. Main diamonds come with adjacent per-setting Previous/Next buttons; its header visits the
colour/Opacity union, while main and stored-setting chip arrows visit individual
channels. Without keyframes, edit the track base even on an empty
track; every clip on that track adopts it. With
keyframes, capture explicitly at the real playhead before editing a setting that is not enabled there.
Removing the final keyed setting reveals the unchanged saved track base. Slider
movement stays local until release; valid edits make one Undo step, invalid or
cancelled edits apply nothing. Numeric entry retains its precision.

The **HSL ranges** and **Colour curves** sections, below Colour in Track, also belong to the video track, but remain
static, with no animation diamonds. Pick a range or curve channel with its coloured
square; Colour curves shows all four curves together, editing only the selected one.
Colour curves pass smoothly through their control
nodes without overshooting them. They follow scalar grading, so HSL's grey
protection does not undo Temperature/Tint colouring. The Original preview bypasses
all these Colour stages, retaining Opacity and geometry. Exact processing:
[Temperature/Tint](design/TEMPERATURE_AND_TINT.md) and
[HSL/curves](design/HSL_AND_CURVES.md).

### Auto adjust

**Auto**, at the end of the Colour keyframe line, suggests a balanced correction for the
clip at the playhead: it balances white, exposure, contrast, black and white points and
colour, restoring footage shot flat, and opens dark shadow areas with Shadows. It raises
colour with Saturation and Vibrance, which lifts muted colours more than strong ones; where
strong colours such as a blue sky fill much of the frame, it relies on Vibrance so they stay
close to how they were. It lowers only very colourful footage, with Saturation.
First choose its **Source**, what it analyses: **Playhead** (the second around it), **Clip**
(16 frames spread over the clip at the playhead) or **Track** (16 frames spread over all the
track's clips, each in proportion to its duration). Then choose how to **Apply as**:

- **Track values** sets Temperature, Tint, Saturation, Vibrance, Exposure, Brightness,
  Contrast, Highlights, Shadows, Whites and Blacks for the whole track. Settings the track
  animates are left unchanged, and the popover lists them.
- **Keyframe** keys those eleven settings at the playhead, from the Playhead source only. Run
  it again at other moments of a clip whose light changes: the keyframes follow the light
  between them. Once the track animates any of the eleven, Auto starts with Playhead and
  Keyframe.

The popover previews the result in the image. **Intensity** starts at 80%, the suggested
correction: lower it for a lighter touch, or raise it towards 100% for a stronger,
exaggerated look. Then **Apply** makes the change in one Undo step. **Cancel**, Escape or a
click elsewhere leaves the track as it was. Reopening Auto on the same frames skips the
analysis and starts at the intensity you last applied, so you can change it later. Track
values are one look for the whole track: shots that need different corrections need their own
clip grades, different tracks or keyframes. Keyframes stay at their timeline frames when you trim or move clips, and with
Linear Easing a correction eases across a cut into the next shot: set **Hold** on a shot's
last keyframe to keep shots apart. See [Auto adjust](design/AUTO_ADJUST.md).

### HDR

**HDR**, in the Effects group of **Colour → Track**, opens shadows and recovers highlights
over large areas, like a tone-mapped look, while keeping local detail as it is; **0** is off
and **1** is the strongest.
It is an SDR effect, not HDR output, and can be keyframed like the other Colour
settings. Nonzero or keyed HDR makes export use the slower composited path.
The Original preview bypasses it. Details: [detail filters](design/DETAIL_FILTERS.md#hdr-look).

**Local contrast**, just below HDR, raises or lowers the contrast between neighbouring
areas and their surroundings, without changing their overall brightness; flat areas never
move. Together with HDR it gives the classic tone-mapped look. **0** is off, **+1** the strongest and
**−1** flattens each area towards its surroundings. It can be keyframed like the other
Colour settings; nonzero or keyed Local contrast makes export use the slower composited
path, and the Original preview bypasses it. Details:
[local contrast](design/DETAIL_FILTERS.md#local-contrast).

### Show the original image

The **Timeline preview** heading has a native **Original** button, accessible as
**Show original preview**. The preview shows the image without Colour and Detail
(with an **Original** badge) only while you hold it: press and hold the pointer, or
hold Enter/Space on the focused button, while paused or playing. Hold **Shift** as you
press it to bypass only clip grades (and Detail), or **Alt** for only the tracks' Colour;
the badge names what is bypassed. Releasing the
pointer (anywhere), the key, moving focus away or leaving the window restores the
graded preview. There is no global shortcut. **Source preview** is unchanged.

Original means the **composed timeline preview without grading**, not the untouched
recording, an original-resolution view or an isolated selected clip. It neutralizes all evaluated
colour settings across enabled video tracks, including clip grades, track colour bases/keyframes
and both dissolve sources, and every clip's Sharpen, Clarity and Denoise. Exact observed source frames, retiming, track Opacity,
spatial geometry/coverage (Transform), visibility, black fades, stacking and music remain unchanged.

This is editor-only: holding never seeks, saves, enters Undo history, changes
exports, schema, proxies or originals, or adds decoders. Same-project seeks,
appearance edits and timing reloads keep the engine's mode while it is held; changing project or reloading
the editor with a fresh preview engine resets to normal graded preview.

### Precise clip speed curves

Select the clip and open **Clip → Speed**. Its keyframe line shows **N keyframes**,
one **Previous/Next** pair and **Reset** (constant 1×, removing the keyframes).
**Speed mode** offers **Constant speed** (with 0.25×–4× presets) or **Custom curve**.
In the **Speed ×** row, double-click the name to reset the editable rate to 1×.
Speed keyframes belong only to the selected clip, not to every clip in its video track.

- The **Keyframe Speed** circle (○/●) captures the rate at the displayed source
  frame with Linear easing, turning a constant clip into a one-keyframe curve, or
  removes the keyframe there. A capture retimes the clip, so preview follows the new
  keyframe. Removing the last keyframe keeps its rate as constant speed.
- In constant mode the **Speed ×** slider/field edits the rate. In curve mode it is
  read-only (dimmed, **Add a keyframe ◇ to edit**) unless a keyframe exists at the
  displayed source frame; it then edits that keyframe's rate. Sliders never create keyframes.
- Curve presets **Flat / Ramp up / Ramp down / Accelerate / Decelerate / Slow centre /
  Fast centre** replace this clip's keyframes. Ramp up and Ramp down place two
  keyframes at source IN and OUT: 0.5×→2× and 2×→0.5×.
- Drag graph keyframes horizontally for original source time and vertically for speed. The graph
  has a logarithmic 0.1×–8× axis; the vertical line is the displayed source frame.
- For precise edits, choose a keyframe in **Selected clip speed keyframe** and enter
  **Source frame**, **Speed ×** and **Easing**. Source frames use exact integer fields; Speed × pairs
  a slider with a field retaining the decimal precision you enter. Enter/blur applies,
  Escape restores. The trash beside the selector deletes the selected keyframe.
- Click the graph background or a keyframe to seek. The keyframe line's Previous/Next
  pair and the selector reach all retained clip source keyframes, including off-trim
  and original-exclusive-OUT keyframes. Each previews the
  nearest mapped image, with a separate stored-source selection that can advance
  even when the image stays the same. The original-OUT keyframe previews the last
  available image, never a frame beyond the recording.
- Graph-keyframe drag drafts preview live without saving, unlike value sliders.
  Valid release is one Undo; Escape, pointer cancellation/capture loss or window blur
  restores the prior edit.
  Red collisions or timing conflicts never merge, overwrite or shrink transitions.
- Focus a keyframe: arrows move one source frame or 0.01×; Shift moves ten frames
  or 0.1×. Enter seeks; Delete removes it (the last one leaves constant speed).
- Keyframes retain original source positions through trims, moves to other tracks,
  splits and marked cuts; duplicated/split clips have independent curves. A clip's
  duration depends only on its own speed and source range. No generated slow-motion
  frames or optical flow are added.

Details: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md#precise-clip-curve-editor).

### Play a clip backwards

Tick **Reverse** in **Clip → Speed** to play the clip from its last frame back to
its first; untick it to restore forward playback. Each toggle is one Undo step and the
clip keeps its length, place and speed keyframes: a slow-motion moment stays on the
same footage. The clip label reads **reverse** and the Speed badge shows ◂.

Timeline edits act on what you see: the left handle and **Trim start** (Q) remove the
end of the recording, the right handle and **Trim end** (W) its beginning. Split and
**Cut range** keep every piece reversed; Duplicate copies the setting. **Clip → Range**
and the speed graph still show the recording in its original order.

Details: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md#reverse).

### Crop, scale, translate and rotate a track

Select a video track (or one of its clips) and open **Track → Transform** (collapsed
initially, after Colour curves). Transform works exactly like Colour: it belongs to the
whole track, applies to every clip on it (both sources of a dissolve too) and works on
an empty track. Its eight
controls are **Crop left / Crop right / Crop top / Crop bottom / Scale / Translate X /
Translate Y / Rotation °**, each with a native slider and exact number field.
Scale preserves aspect and accepts **0.1–8**. Translation accepts **−2–2** as
fractions of the whole output width/height, not source pixels. Rotation is
clockwise, **−180°–180°**, around each image's centre. Crop fractions each
stay within 0–1; a crop of 1, or opposite crops that meet or cross, display nothing. Cropping never refits or
recentres the retained image. Uncovered pixels from nonneutral transforms reveal
lower tracks; exact neutral poses retain the old opaque black letterbox.

- Without keyframes, values edit the track's saved base. Click a setting's own blue triangle (for example **Keyframe Scale**) to capture that
  setting's evaluated value at the playhead; other settings
  stay unkeyed, or join the same keyframe with their own triangle. A keyed setting
  is read-only at a frame without its keyframe until captured; sliders
  never add keyframes, and unkeyed settings stay editable. Each setting also has
  **Previous/Next** buttons that visit only its own keyframes. Dragging a slider
  previews the result live; release commits one Undo step.
- Each setting interpolates between its own keyframes, using its own **Easing** at the
  keyframe on its left; a keyed setting overrides its base, holding before the first/after
  the last keyframe. Rotation interpolates
  numerically, not by shortest arc: +170° to −170° passes through 0°.
- **Add default Transform keyframe** in the keyframe line adds a default keyframe at the
  playhead (neutral pose, Hold), or removes the one there, exactly like the Colour default
  keyframe: it returns the pose to neutral from its frame without changing earlier frames.
- At the end of the section, below the eight settings, a **Keyframes** list shows one row per
  Transform keyframe, exactly like Colour's list: click anywhere on a row (or its timecode) to
  seek the nearest available frame; **Default** and **Outside duration** badges where they
  apply, a trash and its enabled settings, each with Previous/Next arrows. The keyframe
  line's **Previous/Next** pair and the rows reach all keyframes, including those after the
  duration; the current row is marked, and a keyframe after the duration is described above
  the list. A row's **Edit** (closed initially) holds **Timeline frame**, **Easing** and a
  slider/field per enabled setting, which edit that keyframe; time and
  value edits do not seek automatically.
  **Easing** sets every setting of the keyframe at once; when they should differ, choose
  **Per setting** and pick each one. Differing settings read **Mixed** and keep their
  per-setting choices visible. A setting added to a keyframe takes the Easing its other
  settings share, or Linear. The same applies to stored track keyframes in Colour's keyframe list.
- Numeric Enter/blur applies exact values; Escape restores. Collisions,
  fractional frames and out-of-bounds values stay
  editable with errors, never silently clamp or overwrite. Escape, cancellation,
  capture loss or window blur cancels a slider drag without saving; keyboard adjustments
  are individual validated edits.
- A row's trash removes that whole keyframe. Removing a setting's last
  keyframe reveals its unchanged base. **Reset transform** works like Colour's Reset:
  without keyframes it restores the neutral base; with keyframes it resets the enabled
  settings of the keyframe at the playhead, in one Undo step.

Up to **256** Transform keyframes belong to each video track, separately from its
Colour keyframes, at absolute timeline frames. Trims, moves, splits, cuts, duplicates
and Ripple never copy or shift them; a clip moved to another track adopts that track's
Transform. Transform edits do not change timing, Opacity,
music, originals or proxies. Native Export supports these transforms through the
composited path; the diagnostic two-clip reference does not.
Details: [spatial transforms](design/SPATIAL_TRANSFORMS.md).

### Sharpen, clarity and denoise a clip

Select a clip and open **Clip → Detail** (collapsed initially, after Speed).
**Sharpen** (0–2) crisps fine edges without bright or dark outlines, **Clarity** (−1–1) adds midtone local contrast without halos along strong edges
or, below zero, softens it, and **Denoise** (0–1) smooths grain, and colour blotches more
strongly, while keeping strong
edges. Each has a native slider and an exact field; 0 leaves the clip untouched.
Dragging a slider previews the result live in the image; releasing commits one Undo
step, and Escape cancels. Double-click a setting's name to reset it, or use
**Reset detail** for all three. Settings belong to this clip only, are not animated,
follow it to another track and are copied by Split, Cut range and Duplicate.

The filters work on the recording before the track's Colour, scaled to the image
height, so the 720p preview shows what both export profiles produce: a 4K export sharpens
what the preview sharpens, not grain finer than the preview can show. **Original**
hides them together with Colour. Any detail setting renders through the composited
exporter and makes it slower, especially in 4K. Details:
[detail filters](design/DETAIL_FILTERS.md).

### Seek keyframes from the timeline

Inside each clip rectangle, a boxed salmon **●** lane shows custom-speed source
keyframes, distinct from shared project-time track markers.
Positions follow authoritative retiming. Off-trim keyframes are omitted. An
exclusive-OUT boundary marker seeks the final available frame. Click or focus a
marker and press Enter/Space to select its clip, seek the nearest mapped image and open Clip → Speed.
Drag a marker, or press ←/→ on it (Shift for ten), to move that key to another original source frame; its easing stays, a valid release is one Undo step, and Escape or an occupied frame restores it. Moving a speed key retimes its clip, so the clip's duration can change; timing conflicts reject the move. Clicking edits nothing, and keyboard
events do not also run timeline shortcuts. Unlike the markers, stored Speed
navigation reaches all retained off-trim/original-OUT keyframes,
separately from the real frame used for capture.

Track Transform keyframes are boxed blue **▼** markers at the top of their track row
(a default keyframe shows the default-keyframe icon), at their project frames like
Colour markers. Click or Enter selects the track, seeks and opens **Track → Transform**;
drag or ←/→ (Shift for ten) moves them one project frame, one Undo step per release.

### Opt in to shared video track animation

The stored **Keyframes** list at the end of **Colour → Track**
belongs to the selected **whole video track**, even an empty one, not to a clip.
It shows enabled-setting chips and one row per shared keyframe; Colour's keyframe line
counts and visits the same keyframes. **Animation help** beside its heading combines
animation and keyframe-timing guidance. **Clip** keeps source/clip settings and playhead
Speed controls; **Colour → Track** keeps Opacity and Colour controls and **Track → Transform** the pose.
All shared track keyframes use absolute project frames and affect every clip on that track.
Fifteen settings can be keyed independently:
Opacity (`opacity`), the twelve scalar colour controls, including
Temperature, Tint, Vibrance, Whites and Blacks, HDR (`hdr`) and Local contrast (`localContrast`). HSL/curves remain static and Speed is clip-only. At most 256
shared keyframes are allowed per video track.

- Each main setting has a **hollow ◇ / filled ◆ diamond**
  with adjacent per-setting **Previous/Next** buttons.
  Hollow means inactive but
  clickable. Click at the **real playhead** to capture/join that setting; click filled
  to disable only that keyed setting. Enabling the first setting creates the keyframe; removing
  the last enabled setting deletes it. Sliders never create implicit keyframes.
- With no Opacity or colour keyframes, edit the track values, even on an empty track.
  There is no per-clip colour setting.
  Moving clips uses destination track bases/keyframes/Opacity without changing either track.
  Once a channel is animated, its value is
  read-only where it is not enabled, shown dimmed with a lock cue: click the hollow diamond first.
  Removing its final keyed setting reveals its existing unkeyed value, not a
  new default or the removed keyframe's value.
- Each enabled setting has its own Easing at a keyframe, and every channel interpolates to its **own next
  keyframe with that setting enabled**, skipping unrelated settings; its endpoints hold outside
  that interval. A single keyframe therefore overrides that channel across the track.
- To return the track to its default look at a frame, press **Add default keyframe** (the amber
  diamond with a return arrow) in Colour's keyframe line. Every Colour setting and Opacity
  returns to its default there and holds until its next keyframe; earlier frames keep their
  values. Change its Easing to blend out of it instead of holding, or press the button again
  at that frame to remove it. Its timeline marker is filled amber.
- The per-channel native **Previous/Next** arrows beside main diamonds and on enabled setting chips in stored Colour keyframe rows visit only that
  channel's strictly earlier/later keyframes where it is nonnull, including zero-valued
  ones. They are disabled without a neighbour/project or during a document draft.
  Section-header arrows retain their unions above.
  Navigation keeps the chosen Properties tab and the activated button's focus; it
  does not save or create Undo history.

### Move and inspect shared keyframes

The timeline shows **one marker per stored shared keyframe**, not per clip/channel.
Click or Enter selects its video track, seeks and opens Colour → Track, without editing.
Whole-track keyframe navigation keeps the chosen Properties tab. Drag horizontally to
move **all enabled settings, values and easing together**; valid release is one Undo
step. With Snap on, pointer movement snaps within eight pixels at the captured zoom
to captured clip/music/transition boundaries and playhead; **Alt** bypasses it.
Focused marker **←/→** moves one project frame, **Shift+←/→** ten, without snapping
or also stepping the playhead/nudging a clip. The **Edit** disclosure
on each row of Colour's keyframe list provides exact time/value editing with Enter/blur to apply
and Escape to restore.

The shared list has no outer disclosure or per-track list expansion preference.
Nested keyframe details remain collapsible; drafts and input identity survive keyframe
reordering and Undo.

Stored keyed colour/opacity settings use the same sliders and individual colour
resets as the main controls, with one precise numeric field to the right of each
slider as the sole numeric value display (Opacity uses 0–100%, neutral 100%, in
both contexts; saved values remain 0–1). These controls edit only an existing keyed setting at that
stored keyframe; they never implicitly enable a setting. Each accepted value/reset is
one Undo step and leaves the keyframe's time, every Easing, other enabled settings and
saved track/clip settings unchanged. Invalid or out-of-bounds numeric drafts remain editable
with errors.

Occupied frames never merge or overwrite keyframes. A red collision
rejects the entire final move, not just one setting or an earlier
valid draft. Escape, pointer cancellation, lost capture or window blur restores the
document/preview/scroll; pointer previews never enter autosave or history.

Keyframes outside duration stay stored and list-editable. Keyframes after the last clip
keep their timeline markers at their own time, like keyframes before the first clip;
the timeline scrolls far enough to reach them, but keyframes alone do not extend
playback beyond project duration (the maximum video/music OUT). Main per-setting
arrows, stored-setting chip arrows, section navigation to track keyframes and
track/list/shared-marker navigation share the central inspection cursor and can
inspect successive stored
keyframes while preview clamps to the nearest available
project frame (black during a music-only region; none without video or music duration). Labels distinguish **stored time from actual
preview**: list controls edit the stored keyframe, but main setting values,
diamonds and capture still use the **real playhead**. Manual seek, playback and
track/project changes clear inspection; **Follow playhead** ends it explicitly.
A keyframe alone does not extend the sequence, and moving it never retimes a clip.
Trim, cut, move, split, duplicate and ripple **never copy or shift track keyframes**.

Current animation semantics: [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).
Grading equations: [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md#colour).
Retiming: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md).

## Add music and export

Source-video audio is not used. Import music like video: **Import** in the Media
panel, or **Import music** in **Audio → Music**, which opens the same dialog showing
only music. Wait for preparation,
then choose **Add music track** and pick the file, or drag it from **Media → Music**
onto the music lanes. Importing alone never places music. The trash on the file in
**Media → Music** removes that recording (and, after confirmation, its music
clips) from this project. No soundtrack is
supplied; use music you own or have permission to use and keep private paths private.

If music was moved, **Relink** its **Original missing** file in Media → Music to keep
its music clips and cache (see above). Importing the new location instead creates a
separate entry that prepares its own cache and leaves the old entry and projects
untouched. Reimporting the same unchanged path reuses its entry.

Use up to **eight independent music tracks**, each holding up to **eight clips**, including
several from the same recording. Click a music clip on the timeline, or choose its track in
**Music track** and the clip in **Clip**, to edit it; **Add music track** adds a track
from a ready music file, **+ Clip** adds a clip after the track's last one, and
**Recording** changes the selected clip's file. Dragging a ready file onto a music track
adds a clip there. The trash actions **Delete selected music clip** and **Delete selected
music track** remove only that clip or track; Undo restores it. Selection creates no
save/history entry, and editing/removing one clip or track leaves all others unchanged.
A music track has its own native **gain dB** slider with an exact numeric field, fade in
and out at its start and end, and **Ripple**, which plays its clips one after another
like a video track. Each clip has its own waveform placement/edge trims, source IN/OUT,
start/duration and **Loop selected source range**. Without looping, duration must fit its
source range; looping repeats only it. Between clips, **Transitions** choose a **Cut**, a
**Crossfade** (the clips overlap, one fading out while the other fades in), a **Fade through silence** or a **Fade through silence with pause** (a **Fade** length, then a silent **Pause** before the next clip starts), with its length; the boundary button on the timeline opens it.
Independent drafts never apply to another clip or track.
Each accepted edit or completed gesture is one Undo step; invalid/cancelled edits
are atomic and never silently clamp timing, save a draft or change other tracks.

Overlapping music sums linearly after each clip's gain/fades, with **one hard
clamp to −1–1 after the complete sum**, not per track. There is no loudness
normalisation, ducking, effect or video-speed retiming of music. Preview uses one
AudioContext/worklet/output clock and one bounded mixed PCM queue, not full-file
buffers or per-track clocks/queues. Selected-range loops continue without a
music restart; genuine video buffering or audio read/processor failures stay explicit.
If an older prepared recording lacks the current PCM cache, **Audio → Music →
Retry recording name** explicitly prepares it. No startup/library read starts that
job, and older caches/originals remain untouched. This cache needs about 11.52 MB
per minute; video-proxy/PCM cache formats are unchanged.

**Music can extend the project.** Duration is the maximum of every retimed video
clip OUT and every music clip start + duration. Video closing fades remain at their
clip OUTs, then the picture is black while music continues and fades at each
music clip's own end. Native export uses the composited path for this black tail and
pads/trims mixed AAC to full project duration, never freezing the last image.
Music-only preview is black; export requires at least one retained video clip.

Choose **Export** for a **1280×720 draft** or **3840×2160 final**, H.264 SDR BT.709
from originals, with optional 48 kHz AAC music. The quality cards show the selected
preset and one line shows free space on the export drive; the advisory planning
allowance and its meter are in **Storage details**. Actual
compression/disk use can differ: this is not a guarantee or fixed-GB bound.
Use **Storage details** for the output location and assumptions, **Refresh storage
check** after freeing space, or **Retry storage check** after a mount/check error.
A tight-space warning is advisory; below the minimum start reserve, export is
disabled. Low-space failure preserves originals, edits and completed exports.
Submission captures an immutable
snapshot: later edits cannot change that render. The **Output name** field defaults
to the project title plus quality (for example `Flight · 720p`) until edited; it
labels the job and names the downloaded `.mp4` (1–100 characters, no slashes or
control characters). It never chooses a folder or overwrites a file: each export
keeps its own output directory. Activity exposes progress, a rough
time remaining for a running export ("about 5 min left", shown once enough progress has
been observed, never a guarantee), cancellation and verified MP4/receipt links.
**Cancelling…** is pending until
confirmed; a failed status read keeps known jobs and never resubmits the export.
Successful outputs survive later failures/restarts; interrupted exports are not
resumed or published as finished. Long 4K/composited renders can need substantial
scratch disk and CPU time; short tests do not qualify long-flight throughput.
See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md) and
[Properties panel and resource limits](LAYERS_AND_KEYFRAMES.md#properties-panel-and-resource-limits).
The [multiple-music contract](design/MULTIPLE_MUSIC.md) specifies schema, mixing,
resources and pending acceptance; this guide does not claim those tests passed.

## Edit with an assistant (experimental)

An AI assistant in an MCP client such as VS Code can read a project, look at it through
stills and contact sheets, and edit it with the same commands as the editor. Connect the
client to `http://127.0.0.1:4318/mcp` with the token in `.pascap/mcp-token`
([setup](DEVELOPMENT.md#mcp-endpoint)). In VS Code chat, `/mcp.pascap.rough_cut` followed by
what you want starts the assistant on PasCap's step-by-step guide to a first cut. It never
imports, prepares, exports or deletes
anything. Before editing, the assistant starts a session on the project: PasCap keeps a
checkpoint of the project as it was, and only the assistant can save it until it finishes or
you take the project back. You can also start it yourself with **Hand off** in the header:
write what you want, optionally pick the music track, length, allowed camera movement and
number of clips, and check what the assistant can use (prepare or analyse missing
recordings there). Meanwhile a banner says **An assistant is editing this project** and
the editor follows its changes without letting you edit, moving the preview to what it just
changed; **Take over** ends the session and
gives the project back to you. When the session ends, the banner shows the assistant's notes,
and **Restore project before session** returns the project to how it was when the session
started (the assistant's version is kept as a checkpoint too); **Open as new project** opens
that earlier state as a separate project instead. Clips the
assistant adds stay inside the ranges you kept in Source preview.

## Workspace and keyboard

Use **Clip** for the selected clip's **Speed**, **Detail**, **Range** and **Placement**;
**Track** for everything the whole video track owns (Colour and Opacity, Transform, keyframes,
transitions and fades); and **Audio** for music. Each tab names its scope at the top.
Selecting a clip or a populated/empty video track preserves the chosen tab and updates
its track context safely. Switching tabs hides rather than unmounts content, retaining
drafts within the same editing context; changing the edited track/clip refreshes its
fields rather than applying a previous context's draft to the new selection.
Explicit boundary buttons open Track with that boundary expanded.

Viewer and Properties tabs share one native-button appearance and retain their
arrow/Home/End navigation.
Trash icons delete; × closes or dismisses. Icon-only actions keep accessible names
and tooltips. See the [editor control catalogue](design/EDITOR_CONTROLS.md#vocabulary) for
control conventions and vocabulary.

**Expand all / Collapse all** is an icon button on the Properties panel tab bar for the
visible tab: Clip's **Speed**, **Detail**, **Range** and **Placement**; Track's
**Colour**, **HSL ranges**, **Colour curves**, **Transform**, **Transitions** and **Fades**; Audio's **Music**. Other
tabs, nested disclosures and help remain unchanged.

The header directly exposes keyboard help. **Workspace options** holds Reset layout
and Diagnostics. Media and the Properties panel collapse to the side with the panel icon at
the right of their heading (**Collapse Media panel** / **Collapse Properties panel**),
leaving a slim labelled strip that expands them again.
Panels are bordered tiles separated by 6 px gutters, including below the header and above the Activity bar, that are also the resize dividers.
Drag panel dividers or use focused arrows; double-click/Home resets a divider and
Escape cancels its drag. PasCap is designed for browser windows of at least
1280 × 720; narrower windows use one side drawer at a time.
Layout/section preferences do not change rendering. Numbers/titles apply on
Enter/blur, Escape restores, and invalid text remains editable. Numeric values retain
full entered precision, independent of slider steps, without clamping or rounding.
Colour/Opacity/Transform, playback rates and gain use a native slider with one adjacent exact
numeric field in both main and stored controls, not read-only outputs or number-only
layouts. Dragging a Colour, Opacity, HSL or Transform slider (main or stored) previews the draft value in the image, coalesced to the display rate, without any document, history, autosave or Properties change, and without restarting music. Release commits one validated edit and one Undo step. Escape, pointer cancellation, lost capture, window blur or an invalid value restores the control and the preview. Other sliders (speed, gain) keep their release-only image update. Each keyboard slider
adjustment is an individual validated edit. **Clip → Range** uses the full-original
bar and exact timecode text fields described above. Other integer source/timeline
frames, durations and fades retain exact native numeric steppers and timecode
feedback, not arbitrary timing sliders. Source-review paired IN/OUT applies as
a pair on Enter or when focus leaves both fields; Escape restores unapplied drafts.

Clip shows the selected clip/video track first; section readouts and dots
indicate adjusted settings without expanding everything. Animated channels use
an amber curve/diamond: dashed between keyframes, filled when the setting is enabled
at the playhead. **Animation help** beside Colour's **Keyframes** heading explains scope,
capture and keyframe timing; there is no separate Keyframe timing help button.
All fifteen track settings retain their unkeyed values, explicit capture and stored-keyframe editing.
Search/filter clear actions,
mixed select-all and always-visible media Add simplify the library. The Media heading shows
the number of recordings (video icon) and, joined to it, their total duration (clock icon;
minutes keep counting past
an hour); it covers every recording in the project's bin, whatever the search or filter,
and is absent while the bin is empty.

Inline help is a small **? button**, not an expandable text section. Find it
beside the relevant title—**Speed**, **Range**, **Placement**,
**Colour**, **Transitions**, **Fades**
or **Placement & fades**—even when that section is collapsed. Help and expansion
are separate buttons; no scrolling to the end of a section is needed. Startup
details are next to **Preview needs attention**.

Each help is two short sentences plus a tip: what the setting does and what to try.
Exact behaviour lives in this guide, reached from the **Learn more** link that ends
every help except startup details.

Hover or focus to preview it; click, Enter or Space to keep it open while moving away.
You can move the pointer into the help to read it, or press Down arrow to focus
and scroll its text. Escape or a click elsewhere closes it; Escape closes help
before cancelling an input draft. Hovering help never applies a field or edits
the project. A deliberate click away from a number still applies a valid draft
once, as usual. Settings, each keyframe's nested **Edit**, music placement and
storage/render breakdowns remain their existing expandable controls, not help buttons.

| Context                                     | Shortcut                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Timeline play/seek                          | Space; ←/→ one frame; Shift+←/→ ten; Home/End; F to fit                               |
| Split / quick trim                          | S / Q / W                                                                             |
| Unwanted timeline range                     | Drag on the ruler; Delete cuts; Escape clears the range                               |
| Bookmarks                                   | M adds at the playhead; Shift+↑/↓ previous/next; focused: arrows move, Delete removes |
| Clip actions                                | Ctrl+D duplicate (or right-click the clip); Delete/Backspace remove                   |
| Several clips                               | Ctrl-click adds/removes a clip; drag one to move all; Delete and Alt+←/→ act on all   |
| Session history                             | Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y redo                                                   |
| Positioned clip / first Ripple anchor nudge | Alt+←/→ one frame; Alt+Shift+←/→ ten; later Ripple starts require Ripple off          |
| Focused trim handle                         | Arrows one source frame; Shift ten; left Home/right End restore                       |
| Focused track keyframe marker               | Arrows one project frame; Shift ten; Enter selects/seeks; Delete removes              |
| Focused source review                       | I/O marks the source range, not the timeline range                                    |
| Shortcut guide                              | ? outside form/modal/source controls                                                  |

Keyboard actions respect text and number fields, source controls, dialogs and a control
reached with Tab. After a click on a button, tab, checkbox or slider, Space still
plays or pauses. On the **Source preview** tab, Space plays or pauses the source preview
instead of the timeline. Click the preview timecode for an exact frame or **MM:SS:FF** at 30 fps
NDF; this display is not wall-clock duration at 30000/1001 fps. Undo/Redo is session
history, not a persistent project revision browser.

## Save and recover

Serial autosave writes committed edits locally with revision checks; valid pointer
release commits once, not every movement. Project switching waits for saving;
switching/export is blocked while autosave remains dirty or failed.

If **Save error** appears, keep the editor open: the unsaved document/history stays
in memory and automatic write retries stop. **Retry save** is offered only for
recoverable transport/server errors. On a revision conflict, **Review latest save**
offers keeping the draft, **Download unsaved project**, or explicitly discarding
local changes and reloading. It never silently overwrites or rebases another save.
Download before discarding; the JSON snapshot can be opened later with **Open project
file…** in Projects, as a new project. Unapplied input/pointer drafts are
not committed project edits.

`beforeunload` can warn about unsaved changes and dirty controls, but cannot protect
against forced browser/laptop shutdown. Wait for **Saved locally** or download the
unsaved snapshot; there is no crash-proof draft database. Do not run two services
against the same data directory. **Retry connecting**, **Retry preview** and Activity
**Refresh** recover reads without submitting hidden writes or duplicate jobs.
If deferred preview/Properties code fails to load, **Reload editor** saves pending
committed edits before reloading; a save error blocks it. **Download project**
keeps a strict snapshot available for recovery. Unapplied control drafts remain
separate from committed project edits.
Full recovery contract: [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).
