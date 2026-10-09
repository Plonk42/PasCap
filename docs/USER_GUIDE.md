# User guide

PasCap is a local Linux video editor: the browser edits a project, and the local
service prepares previews and exports from original files. There is no account,
upload or cloud workflow. For setup, see [DEVELOPMENT.md](DEVELOPMENT.md#run-locally);
for source paths and future containers, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Start a project

Open **Projects**, create a named project, then import its recordings and music.
A new project has an **empty timeline and empty video/music bins**; it does not
inherit the shared media registry. Importing the same original into another project
deliberately adds it to that project's bin and reuses eligible verified proxies.
Removing a clip or music track does not remove the imported recording.

Projects use **strict format v12**, with complete required video track colour and clip spatial base/full-pose
source-frame keyframes and a required `music` array of 0–8 independent
music tracks and unique required IDs (`[]` without music), every video track's Ripple, transitions and
opening/closing fades and required numeric `opacity` in 0–1 (1 on new tracks),
with eleven nullable animation channels, in control order: `opacity`, `speed`,
`temperature`, `tint`, `exposure`, `brightness`, `contrast`, `hue`, `saturation`,
`highlights`, `shadows`. Video track Colour requires Temperature/Tint bases and static
HSL/curves; missing fields and saved clip colour/correction are invalid.
Track `opacity` is the sole saved Opacity value; saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` keyframe channels are invalid, not ignored or defaulted.
v1–v11 project documents and receipt snapshots
stay on disk but are incompatible: there is no migration, compatibility default,
null fallback, old-format reader, automatic repair or deletion. Export receipts
remain version 1 with a strict v12 snapshot and required audio-source/instance-plan arrays.
Create a new project and import its media deliberately. Finished videos remain
untouched. **Delete project** requires confirmation and deletes only the saved
project document, not originals, the shared registry/proxy cache or exports/receipts.
Registry/proxy/current PCM cache formats are unchanged.

Keep originals readable at their registered service-side paths. Moving a file,
changing a mount or disconnecting a drive can fail even with a ready proxy.
There is no automatic path guessing or relink workflow. Keep generated data outside
footage, and back up originals and saved project/export data separately.

## Import and prepare recordings

1. Choose **Import → Browse recordings**. Its default is a service-side browser of approved roots,
   not your browser's operating-system file picker. Open a folder, select recordings
   and explicitly confirm registration into the open project.
2. Browsing and selection alone start **no preparation**. Each listing reads one
   folder's metadata, not video bytes; it does not probe, register or write anything.
   Folders sort first. A 2,000-entry truncation warning means choose a narrower folder.
3. Registration references original paths without copying footage. Eligible editing
   proxies queue automatically; **Activity** shows queued/running jobs and progress.
   Only **Ready** recordings can be inserted or hover-reviewed. Preparation is serial;
   ready assets and queued/running work are reused rather than encoded twice.
4. Read the import summary: accepted registrations remain kept if another file is
   rejected or queue admission fails. Check Media/Activity before repeating an
   uncertain request. Failed, cancelled or interrupted preparation needs explicit
   **Prepare**; **Prepare selected** confirms a manual multi-recording batch.
5. To take a recording out of this project, use its trash button (or the trash on
   the selection header). If clips use it, PasCap asks first and removes them
   too; Undo restores everything. The original file and prepared media are kept.

The separate **absolute-folder-path form** recursively imports the whole chosen
folder and can queue substantial work. Use it deliberately, with a narrow folder.
It may target a folder outside approved browser roots, but does not add a root.
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

## Review a recording and add clips

Hover a ready recording to open **Source preview**; horizontal mouse position
scrubs its full source range without moving the timeline playhead. **Pin** keeps
that recording selected while you hover other recordings. Review opens paused and muted and
uses a separate decoder; it never plays or prepares an original implicitly.

Set source **IN/OUT** by dragging the handles, with focused source **I/O**, or with
the paired numeric fields followed by **Apply range**; **Cancel range** restores
unapplied drafts. OUT is exclusive; **O** includes
the displayed frame. Drag a handle back to an edge (or press **Home**/**End** on it)
to restore the full recording. These choices are per-project, browser-local state,
not portable project-document fields.

The source range strip under the image shows snapshots across the whole recording, like
a timeline clip. Its **IN / OUT** handles restore omitted footage as well as trim;
hatched parts are outside the selected range, and clicking elsewhere on the strip
scrubs. Dragging previews the boundary frame; release applies, while Escape/capture
loss/cancellation/window blur restores the prior choice. The round **Play / Pause**
button left of the strip reviews the applied range, muted, from the current frame or IN.
It stops at the last included frame (OUT − 1), without looping; a one-frame range
just displays that frame. Numeric drafts are not played or inserted before **Apply range**.
Scrubbing or changing the range pauses first. Closing, switching sources/projects
or leaving the Source tab cancels playback. Source playback does not move the
timeline or music and does not create Undo steps or saves. Failures expose Retry.

Choose **Add clip** (it shows the applied range length, for example **Add clip 3.00 s**),
mark another range, then add again: each addition creates an independent clip and
keeps the source pinned at the same frame/range. **Clip added · mark another range**
confirms a successful addition.
The sticky **Show N clips** button lists existing ranges; **Show** selects,
seeks and reveals one on the timeline. Reuse badges count clips, not copied files.
In Media, a hatched head/tail on a recording's thumbnail shows the omitted part of
its applied range, like a miniature timeline.
Media **+**, double-click and drag/drop (dragging a selected recording carries the
whole selection) also copy the applied range
(or the full recording without a choice). Later source choices never alter existing
clips. Plus/double-click target the selected video track; a drop targets the track under the pointer.

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
visible while scrolling; its ticks follow horizontal scroll, and clicking/dragging
it seeks without editing a track. Track options explains unavailable actions at
stack endpoints or on the last remaining track. It contains only rename, Ripple,
Raise/Lower and Delete; visibility stays in the sidebar and Opacity in **Track → Colour**.

Select a clip and drag a timeline edge inward to shorten it or outward to restore
omitted footage up to the original bounds. The dashed extent shows available source.
Left-edge autoscroll can recover a long omitted beginning. With Ripple on, a timeline
left handle/keyboard trim keeps the sequence start; with it off, it changes the
start to retain timeline OUT. Invalid overlap, fade or frame-quantisation edits are rejected.
Originals and full proxies are never cut or regenerated by trimming.

**Clip → Range** has one full-original bar with hatched omitted footage and
draggable **IN / OUT** handles. Exact **Source IN / OUT** text fields below its
ends show **HH:MM:SS:FF** (30 fps NDF); enter a whole original-frame number or
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
original exclusive OUT. Source review keeps its independent paired **Apply range / Cancel range** workflow.

- **Split / S** splits at the playhead and selects the new right piece.
- **Trim start / Q** removes the head before the displayed frame; **Trim end / W**
  removes the tail after it. Both keep that frame; handles can recover omitted footage.
- To remove a middle section, select a clip, seek the first unwanted frame and
  mark timeline **IN / I**, then the last unwanted frame and **OUT / O**.
  The hatched range is removed by **Cut range / Shift+Delete**, in **one Undo step**.
  Ripple-on cuts close the gap on that track; off keeps the removed gap and fixed neighbours.
- **Clip actions → Duplicate / Ctrl+D** makes an independent clip. Timeline
  Delete removes a clip, not its original or project-bin membership.

Placement ghosts show the actual video track/start, including destination speed timing.
Red invalid ghosts never commit. **Snap** uses nearby boundaries; **Alt** bypasses
magnets, but cannot turn a Ripple-on track into free placement. Trim and keyframe drags
preview transiently, commit once on valid release, and cancel with Escape.
**Timeline start frame** and nudge controls work on independently positioned clips
or the **first Ripple anchor only**. Later Ripple clips expose an accessible reason:
drag to reorder, or turn Ripple off in Track options to set an independent start.

Boundary **Cut / Fade / Dissolve** and **Fades** belong to the selected
track in **Track**; clicking a boundary button opens that tab with the boundary expanded.
Gapped pairs are Cut only: explicitly close the gap or enable Ripple before adding
a fade/dissolve. A cross-dissolve explicitly adjusts the right clip to its overlap;
with Ripple off, no other clip moves and conflicts reject it.
Black fades darken only that video track's RGB, preserving coverage rather than revealing
lower footage. Opening/closing fades use actual first/last placements and remain
stored but dormant on empty tracks. A closing fade ends at its last video clip's
OUT, not a later music OUT; after all video ends the picture is black, never a
frozen last image. Details: [TIMELINE_EDITING.md](TIMELINE_EDITING.md).

## Colour, speed and shared video track keyframes

Each clip has independent constant/ramp/custom speed and spatial settings.
All static and keyed Colour belongs to its video track, not the clip.
**Opacity** is one setting for the selected **whole video track**, not a clip.
Find its single native slider/exact numeric field/diamond/navigation in **Track → Colour**,
alongside Temperature, Tint, Exposure, Brightness, Contrast, Hue, Saturation,
Highlights and Shadows.
Main and stored sliders/exact fields use **0–100%**, neutral **100%**.
Saved track `opacity` and keyframe values remain **0–1**; this is UI conversion only, not a schema change.
Without Opacity keyframes, either value control edits the track's saved `opacity` and works even
on an empty track. With keyframes, the track's `opacity` curve overrides that value on every
clip, including both sources in a dissolve. Removing its final keyed setting reveals
the unchanged saved track value. There is no saved clip opacity, additional track
multiplier or duplicate sidebar control/navigation.
Static and keyed colour controls edit the same video track, including on empty tracks.
All clips on that track share the treatment; different looks require different tracks. Opacity shares their
UI treatment, but controls composition coverage, not the SDR RGB grade.
**Clip → Placement** contains placement only. Sliders never create implicit keyframes;
an animated setting that is not enabled at the real playhead is read-only until
its hollow diamond captures a keyframe there.
Speed accepts **0.1×–8×**. Constant, ramp endpoint, custom-keyframe and main/stored track
rates pair a native slider with an exact numeric field, retaining modes, presets
and the curve graph. Slow motion repeats frames and acceleration drops them;
there is no optical-flow synthesis.
Speed changes output duration: Ripple-on tracks re-sequence, off keeps independent starts,
and incompatible fades/transitions/overlaps reject the edit rather than being shrunk.

### Temperature and Tint

In **Track → Colour**, **Temperature** and **Tint** precede Exposure. Both use
normalized **−1…1**, neutral **0**, not Kelvin or automatic white balance.
Positive Temperature warms, negative cools; positive Tint adds magenta, negative
adds green. Nonzero settings intentionally colour greys. The common gain formula
runs in linear RGB before Exposure; it preserves neutral-white linear luminance
before clipping only, not final brightness or arbitrary coloured pixels.

Sliders, exact fields, double-click-the-name reset to 0, diamonds and Previous/Next use the
same main/stored control rules as other scalar Colour settings. Without keyframes,
edit the track base even on an empty track; every clip on that track adopts it. With
keyframes, capture explicitly at the real playhead before editing a setting that is not enabled there.
Removing the final keyed setting reveals the unchanged saved track base. Slider
movement stays local until release; valid edits make one Undo step, invalid or
cancelled edits apply nothing. Numeric entry retains its precision.

Nested **HSL ranges** and **Colour curves** also belong to the video track, but remain
static, with no animation diamonds. They follow scalar grading, so HSL's grey
protection does not undo Temperature/Tint colouring. Ungraded comparison bypasses
all these Colour stages, retaining Opacity and geometry. Exact processing:
[Temperature/Tint](design/TEMPERATURE_AND_TINT.md) and
[HSL/curves](design/HSL_AND_CURVES.md).

### Compare graded and ungraded preview

The **Timeline preview** heading has a native **Compare** button, accessible as
**Show ungraded preview**. When active, it reads **Ungraded** and the canvas shows
an **Ungraded** badge. Click or use the focused button's Enter/Space to toggle while
paused or playing; there is no global shortcut. **Source preview** is unchanged.

Ungraded means the **composed timeline preview without grading**, not an
original-resolution view or an isolated selected clip. It neutralizes all evaluated
colour settings across enabled video tracks, including track colour bases/keyframes and both
dissolve sources. Exact observed source frames, retiming, track Opacity,
spatial geometry/coverage, visibility, black fades, stacking and music remain unchanged.

Comparison is editor-only: toggling never seeks, saves, enters Undo history, changes
exports, schema, proxies or originals, or adds decoders. Same-project seeks,
appearance edits and timing reloads retain the mode; changing project or reloading
the editor with a fresh preview engine resets to normal graded preview.

### Precise clip speed curves

Select the clip, open **Clip → Speed**, and choose **Custom curve**. Start from
**Flat / Accelerate / Decelerate / Slow centre / Fast centre**, then edit any keyframe.
These keyframes belong only to the selected clip, not to every clip in its video track.

- Drag horizontally for original source time and vertically for speed. The graph
  has a logarithmic 0.1×–8× axis; the vertical line is the displayed source frame.
- For precise edits, select a keyframe and enter **Source frame**, **Speed ×** and
  **To next keyframe** easing. Source frames use exact integer fields; Speed × pairs
  a slider with a field retaining the decimal precision you enter. Enter/blur applies,
  Escape restores.
- Click the graph background or a keyframe to seek, then **Add keyframe** at an unkeyed
  displayed source frame. Keyframe Previous/Next and the selector also reach off-trim
  keyframes. The original OUT anchor previews the last available image.
- Graph-keyframe drag drafts preview live without saving, unlike value sliders.
  Valid release is one Undo; Escape, pointer cancellation/capture loss or window blur
  restores the prior edit.
  Red collisions or timing conflicts never merge, overwrite or shrink transitions.
- Focus a keyframe: arrows move one source frame or 0.01×; Shift moves ten frames
  or 0.1×. Enter seeks; Delete removes it if at least two keyframes remain.
- Keyframes retain original source positions through trims, splits and marked cuts;
  duplicated/split clips have independent curves. **Reset** returns only this clip
  to 1×. No generated slow-motion frames or optical flow are added.

Existing **Video track speed animation** stays separate and overrides a clip curve when
the track has Speed keyframes. The override notice explains it; removing those keyed Speed
settings reveals the clip curve unchanged. Track colour/opacity animation is
unaffected. Details: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md#precise-clip-curve-editor).

### Crop, scale, translate and rotate a clip

Select a clip and open **Clip → Transform** (collapsed initially). Its eight
controls are **Crop left / Crop right / Crop top / Crop bottom / Scale / Translate X /
Translate Y / Rotation °**, each with a native slider and exact number field.
Scale preserves aspect and accepts **0.1–8**. Translation accepts **−2–2** as
fractions of the whole output width/height, not source pixels. Rotation is
clockwise, **−180°–180°**, around the original image centre. Crop fractions each
stay below 1 and opposite crops must sum to less than 1; cropping never refits or
recentres the retained image. Uncovered pixels from nonneutral transforms reveal
lower tracks; exact neutral poses retain the old opaque black letterbox.

- Without keyframes, values edit this clip's saved base. Click the single **Transform
  keyframe at displayed source frame** diamond to capture all eight evaluated
  values at the real displayed integer source frame. With animation, main values
  are read-only at a source frame without a keyframe until explicitly captured; sliders
  never add keyframes. Capture requires the real playhead inside the selected clip.
- All eight values use **To next keyframe** easing together; one keyframe overrides the
  entire base, holding before the first/after the last keyframe. Rotation interpolates
  numerically, not by shortest arc: +170° to −170° passes through 0°.
- **Selected Transform keyframe**, **Previous/Next** and **Preview stored keyframe**
  reach keyframes outside the trim and at the original exclusive OUT. The stored
  source time is shown separately from the actual preview's source frame; preview
  uses the closest mapped image rather than an unavailable or invented frame.
  Stored **Source frame**, easing and pose fields edit that selected keyframe; time and
  value edits do not seek automatically. Easing is disabled on the last keyframe.
- Numeric Enter/blur applies exact values; Escape restores. Invalid crop sums,
  collisions, fractional/out-of-original frames and out-of-bounds values stay
  editable with errors, never silently clamp or overwrite. Slider movement is
  local only; valid release changes the image in one Undo. Escape, cancellation,
  capture loss or window blur cancels it without saving; keyboard adjustments
  are individual validated edits.
- The trash action removes only the selected full-pose keyframe. Removing the last
  keyframe reveals the unchanged base. **Reset transform** deliberately restores the
  neutral base and clears all spatial keyframes in one Undo.

Up to **256** full-pose keyframes belong to each clip, separately from the video
track's keyframes. Trims/restoration, moves and Ripple retain original-source anchors;
splits, cuts and duplicates retain independent deep copies, including off-trim
keyframes. Retiming drives geometry continuously even while a recorded image is held;
there is no optical flow. Transform edits do not change timing, track Opacity,
music, originals or proxies. Native Export supports these transforms through the
composited path; the diagnostic two-clip reference does not.
Details: [spatial transforms](design/SPATIAL_TRANSFORMS.md).

### Opt in to shared video track animation

The **Track → Keyframes** section
belongs to the selected **whole video track**, even an empty one, not to a clip.
It contains the keyframe count, enabled-setting chips, whole-track Previous/Next navigation
and a directly visible shared keyframe list. The toolbar's **Animation help** combines
animation and keyframe-timing guidance. **Clip** keeps source/clip settings and playhead
Speed/Transform controls; **Track → Colour** keeps Opacity and Colour controls.
All shared track keyframes use absolute project frames and affect every clip on that track.
Eleven settings can be keyed independently:
Opacity (`opacity`), Speed and the nine scalar colour controls, including
Temperature and Tint. HSL/curves remain static. At most 256
shared keyframes are allowed per video track.

- Every setting has a **hollow ◇ / filled ◆ diamond**. Hollow means inactive but
  clickable. Click at the **real playhead** to capture/join that setting; click filled
  to disable only that keyed setting. Enabling the first setting creates the keyframe; removing
  the last enabled setting deletes it. Sliders never create implicit keyframes.
- With no Opacity or colour keyframes, edit the track values, even on an empty track;
  unkeyed speed edits the selected clip. There is no per-clip colour setting.
  Moving clips uses destination track bases/keyframes/Opacity without changing either track.
  Once a channel is animated, its value is
  read-only where it is not enabled: click the hollow diamond first.
  Removing its final keyed setting reveals its existing unkeyed value, not a
  new default or the removed keyframe's value.
- Each keyframe shares an easing, but every channel interpolates to its **own next
  keyframe with that setting enabled**, skipping unrelated settings; its endpoints hold outside
  that interval. A single keyframe therefore overrides that channel across the track.
- The **Previous/Next buttons immediately after each diamond** visit only that
  channel's strictly earlier/later keyframes with that setting enabled, including zero-valued ones. They
  remain visible but disabled without a neighbour/project or during a document draft.
  Navigation keeps the chosen Inspector tab and the activated button's focus; it
  does not save or create Undo history.

### Move and inspect shared keyframes

The timeline shows **one marker per stored shared keyframe**, not per clip/channel.
Click or Enter selects its video track and seeks without editing or changing the chosen
Inspector tab. Whole-track keyframe navigation also keeps that tab. Drag horizontally to
move **all enabled settings, values and easing together**; valid release is one Undo
step. With Snap on, pointer movement snaps within eight pixels at the captured zoom
to captured clip/music/transition boundaries and playhead; **Alt** bypasses it.
Focused marker **←/→** moves one project frame, **Shift+←/→** ten, without snapping
or also stepping the playhead/nudging a clip. **Keyframes → Edit**
on each keyframe provides exact time/value editing with Enter/blur to apply
and Escape to restore.

The shared list has no outer disclosure or per-track list expansion preference.
Nested keyframe details remain collapsible; drafts and input identity survive keyframe
reordering and Undo.

Stored keyed colour/opacity settings use the same sliders and individual colour
resets as the main controls, with one precise numeric field to the right of each
slider as the sole numeric value display (Opacity uses 0–100%, neutral 100%, in
both contexts; saved values remain 0–1). Stored
Speed uses the **Track rate ×** slider/exact field (double-click **Speed** to reset to 1×), not clip speed modes or a
source-frame curve. These controls edit only an existing keyed setting at that
stored keyframe; they never implicitly enable a setting. Each accepted value/reset is
one Undo step and leaves the keyframe's time, shared easing, other enabled settings and
saved track/clip settings unchanged. Invalid or out-of-bounds numeric drafts remain editable
with errors; timing conflicts reject the edit rather than shortening transitions.

Occupied frames never merge or overwrite keyframes. A red collision or Speed-related
timing conflict rejects the entire final move, not just one setting or an earlier
valid draft. Escape, pointer cancellation, lost capture or window blur restores the
document/preview/scroll; pointer previews never enter autosave or history.

Keyframes outside duration stay stored and list-editable. Keyframes after the last clip
keep their timeline markers at their own time, like keyframes before the first clip;
the timeline scrolls far enough to reach them, but keyframes alone do not extend
playback beyond project duration (the maximum video/music OUT). Setting/track/list/marker navigation can inspect successive stored
keyframes while preview clamps to the nearest available
project frame (black during a music-only region; none without video or music duration). Labels distinguish **stored time from actual
preview**: list controls edit the stored keyframe, but main setting values,
diamonds and capture still use the **real playhead**. Manual seek, playback and
track/project changes clear inspection; **Follow playhead** ends it explicitly.
A keyframe alone does not extend the sequence; keyed Speed settings can naturally
recompile clip durations.
Trim, cut, move, split, duplicate and ripple **never copy or shift track keyframes**.

Current animation semantics: [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).
Grading equations: [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md#colour).
Retiming: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md).

## Add music and export

Source-video audio is not used. In **Audio → Music**, choose **Browse music recordings**
and confirm with **Import selected music**, or enter your own standalone local file
in **Music recording path** and choose **Import audio**. Wait for preparation,
then choose **Add music track** and pick the file, or drag it from **Media → Music**
onto the music lane. Importing alone never places music. The trash on the file in
**Media → Music** removes that recording (and, after confirmation, its music
tracks) from this project. No soundtrack is
supplied; use music you own or have permission to use and keep private paths private.

If music was moved, import its new location normally and add the new entry
after preparation. This does not reconnect or replace the old entry; existing
projects and caches remain untouched. Reimporting the same unchanged path reuses its
entry, while a missing old location stays visibly unavailable.

Use up to **eight independent music tracks**, including several from the same
recording. **Music track** selects the track to edit; **Add music track** adds
another from a ready music file, and **Recording** changes the selected music track's
file. Its trash action **Delete selected
music track** removes only that placement; Undo restores it. Selection creates no
save/history entry, and editing/removing one music track leaves all others unchanged.
Each music track has its own waveform placement/edge trims, source IN/OUT,
start/duration, native **gain dB** slider with an exact numeric field, linear fades
and **Loop selected source range**. Without looping, duration must fit its source
range; looping repeats only it. Independent drafts never apply to another music track.
Each accepted edit or completed gesture is one Undo step; invalid/cancelled edits
are atomic and never silently clamp timing, save a draft or change other tracks.

Overlapping music sums linearly after each music track's gain/fades, with **one hard
clamp to −1–1 after the complete sum**, not per track. There is no loudness
normalisation, ducking, effect or video-speed retiming of music. Preview uses one
AudioContext/worklet/output clock and one bounded mixed PCM queue, not full-file
buffers or per-track clocks/queues. Selected-range loops continue without a
music restart; genuine video buffering or audio read/processor failures stay explicit.
If an older prepared recording lacks the current PCM cache, **Audio → Music →
Retry recording name** explicitly prepares it. No startup/library read starts that
job, and older caches/originals remain untouched. This cache needs about 11.52 MB
per minute; registry/video-proxy/PCM cache formats are unchanged.

**Music can extend the project.** Duration is the maximum of every retimed video
clip OUT and every music start + duration. Video closing fades remain at their
clip OUTs, then the picture is black while music continues and fades at each
music track's own end. Native export uses the composited path for this black tail and
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
keeps its own output directory. Activity exposes progress,
cancellation and verified MP4/receipt links. **Cancelling…** is pending until
confirmed; a failed status read keeps known jobs and never resubmits the export.
Successful outputs survive later failures/restarts; interrupted exports are not
resumed or published as finished. Long 4K/composited renders can need substantial
scratch disk and CPU time; short tests do not qualify long-flight throughput.
See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md) and
[Inspector and resource limits](LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits).
The [multiple-music contract](design/MULTIPLE_MUSIC.md) specifies schema, mixing,
resources and pending acceptance; this guide does not claim those tests passed.

## Workspace and keyboard

Use **Clip** for the selected clip's **Range**, **Placement**, **Speed** and **Transform**;
**Track** for everything the whole video track owns (Colour and Opacity, keyframes,
transitions and fades); and **Audio** for music. Each tab names its scope at the top.
Selecting a clip or a populated/empty video track preserves the chosen tab and updates
its track context safely. Switching tabs hides rather than unmounts content, retaining
drafts within the same editing context; changing the edited track/clip refreshes its
fields rather than applying a previous context's draft to the new selection.
Explicit boundary buttons open Track with that boundary expanded.

Viewer and Inspector tabs share one native-button appearance and retain their
arrow/Home/End navigation.
Trash icons delete; × closes or dismisses. Icon-only actions keep accessible names
and tooltips. See the [editor control catalogue](design/EDITOR_CONTROLS.md#vocabulary) for
control conventions and vocabulary.

**Expand all / Collapse all** is an icon button on the Inspector tab bar, shown only
in Clip; it controls its four
sections: **Range**, **Placement**, **Speed** and **Transform**. Track,
Audio, nested disclosures and help remain unchanged.

The header directly exposes keyboard help. **Workspace options** holds the
**Media panel / Clip panel** toggles, Reset layout and Diagnostics.
Drag panel dividers or use focused arrows; double-click/Home resets a divider and
Escape cancels its drag. PasCap is designed for browser windows of at least
1280 × 720; narrower windows use one side drawer at a time.
Layout/section preferences do not change rendering. Numbers/titles apply on
Enter/blur, Escape restores, and invalid text remains editable. Numeric values retain
full entered precision, independent of slider steps, without clamping or rounding.
Colour/Opacity/Transform, playback rates and gain use a native slider with one adjacent exact
numeric field in both main and stored controls, not read-only outputs or number-only
layouts. Pointer sliding updates only the local control value; the image updates
on release after one validated edit. Escape, pointer cancellation, lost capture or
window blur restores the starting value without save/history. Each keyboard slider
adjustment is an individual validated edit. **Clip → Range** uses the full-original
bar and exact timecode text fields described above. Other integer source/timeline
frames, durations and fades retain exact native numeric steppers and timecode
feedback, not arbitrary timing sliders. Source-review paired IN/OUT deliberately
requires **Apply range**; **Cancel range** restores unapplied drafts.

Clip shows the selected clip/video track first; section readouts and dots
indicate adjusted settings without expanding everything. Animated channels use
an amber curve/diamond: dashed between keyframes, filled when the setting is enabled
at the playhead. **Animation help** in the Keyframes toolbar explains scope,
capture and keyframe timing; there is no separate Keyframe timing help button.
All eleven settings retain their unkeyed values, explicit capture and stored-keyframe editing.
Search/filter clear actions,
mixed select-all and always-visible media Add simplify the library.

Inline help is a small **? button**, not an expandable text section. Find it
beside the relevant title—**Range**, **Placement**,
**Speed**, **Colour**, **Transitions**, **Fades**
or **Placement & fades**—even when that section is collapsed. Help and expansion
are separate buttons; no scrolling to the end of a section is needed. Startup
details are next to **Preview needs attention**.

Hover or focus to preview it; click, Enter or Space to keep it open while moving away.
You can move the pointer into the help to read it, or press Down arrow to focus
and scroll its text. Escape or a click elsewhere closes it; Escape closes help
before cancelling an input draft. Hovering help never applies a field or edits
the project. A deliberate click away from a number still applies a valid draft
once, as usual. Settings, each keyframe's nested **Edit**, music placement and
storage/render breakdowns remain their existing expandable controls, not help buttons.

| Context                                     | Shortcut                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Timeline play/seek                          | Space; ←/→ one frame; Shift+←/→ ten; Home/End; F to fit                      |
| Split / quick trim                          | S / Q / W                                                                    |
| Unwanted timeline range                     | I / O; Shift+Delete cuts; Escape clears marks                                |
| Clip actions                                | Ctrl+D duplicate; Delete/Backspace remove                                    |
| Session history                             | Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y redo                                          |
| Positioned clip / first Ripple anchor nudge | Alt+←/→ one frame; Alt+Shift+←/→ ten; later Ripple starts require Ripple off |
| Focused trim handle                         | Arrows one source frame; Shift ten; left Home/right End restore              |
| Focused track keyframe marker               | Arrows one project frame; Shift ten; Enter selects/seeks                     |
| Focused source review                       | I/O marks source range, not the timeline's unwanted range                    |
| Shortcut guide                              | ? outside form/modal/source controls                                         |

Keyboard actions respect focused inputs, buttons, source controls, dialogs and
dividers. Click the preview timecode for an exact frame or **HH:MM:SS:FF** at 30 fps
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
Download before discarding; the v12 JSON snapshot is for manual recovery/examination,
not a supported JSON-import or migration flow. Unapplied input/pointer drafts are
not committed project edits.

`beforeunload` can warn about unsaved changes and dirty controls, but cannot protect
against forced browser/laptop shutdown. Wait for **Saved locally** or download the
unsaved snapshot; there is no crash-proof draft database. Do not run two services
against the same data directory. **Retry connecting**, **Retry preview** and Activity
**Refresh** recover reads without submitting hidden writes or duplicate jobs.
If deferred preview/Inspector code fails to load, **Reload editor** saves pending
committed edits before reloading; a save error blocks it. **Download project**
keeps a strict snapshot available for recovery. Unapplied control drafts remain
separate from committed project edits.
Full recovery contract: [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).
