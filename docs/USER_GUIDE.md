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
Removing an excerpt or music placement does not remove the imported media.

Projects use **strict format v6**, including every track's Ripple, transitions and
opening/closing fades. v1–v5 project documents and export snapshots
stay on disk but are incompatible: there is no migration or automatic repair.
Create a new project and import its media deliberately. Finished videos remain
untouched. **Delete project** requires confirmation and deletes only the saved
project document, not originals, the shared registry/proxy cache or exports/receipts.
Registry/proxy formats are unchanged.

Keep originals readable at their registered service-side paths. Moving a file,
changing a mount or disconnecting a drive can fail even with a ready proxy.
There is no automatic path guessing or relink workflow. Keep generated data outside
footage, and back up originals and saved project/export data separately.

## Import and prepare recordings

1. Choose **Import**. Its default is a service-side browser of approved roots,
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

## Review a source and add excerpts

Hover a ready recording to open **Source preview**; horizontal mouse position
scrubs its full source range without moving the timeline playhead. **Pin** keeps
that source selected while you hover other rows. Review is muted and uses a
separate decoder; it never silently plays or prepares an original.

Set source **IN/OUT** using handles, **Mark IN/OUT**, focused source **I/O**, or the
paired numeric fields followed by **Apply**. OUT is exclusive; Mark OUT includes
the displayed frame. **Reset** restores the full recording. These choices are
per-project, browser-local state, not portable project-document fields.

Choose **Add excerpt**, mark another range, then add again: each addition creates
an independent instance and keeps the source pinned at the same frame/range.
The sticky **excerpts from this rush** popup lists existing ranges; **Show** selects,
seeks and reveals one on the timeline. Reuse badges count excerpts, not copied files.
Media **+**, double-click, drag/drop and batch insertion also copy the applied range
(or the full recording without a choice). Later source choices never alter existing
excerpts. Plus/double-click/batch target the selected layer; a drop targets its row.

## Assemble, trim and cut

Use up to **eight uniform video tracks**. Each starts with **Ripple on**; find the
checkbox in **Layer options**. Enabling it packs clips and closes gaps in **one
Undo step**, preserving the first clip's current start and valid existing dissolves.
While on, insert/reorder/delete/trim/speed edits continuously sequence that track
from its first anchor. Turning it off keeps actual placements for independent
edits; it does not restore old gaps. Other tracks, music and row points stay fixed.
With Ripple off, edits never move unrelated clips and conflicts reject the edit.
Same-track overlap is allowed only for an exact adjacent cross-dissolve; use different
tracks for independent simultaneous footage.

Rows follow **bottom-to-top composition order**: row 1 renders below row 2, row 3
above row 2, and so on. There is no primary/overlay role or special first-track ID.
Raise/Lower change composition priority; any track can be reordered or deleted
except the last remaining track. Scroll over the tracks or layer headers to
reach all rows and music. The time ruler and its playhead handle/timecode remain
visible while scrolling; its ticks follow horizontal scroll, and clicking/dragging
it seeks without editing a row. Layer options explains unavailable actions at
stack endpoints or on the last remaining track.

Select an excerpt and drag an edge inward to shorten it or outward to restore
omitted footage up to the original bounds. The dashed extent shows available source.
Left-edge autoscroll can recover a long omitted beginning. **Clip → Source range →
Restore full recording** restores both endpoints; numeric IN/OUT offers exact edits.
With Ripple on, a left handle/keyboard trim keeps the sequence start; with it off,
it changes the start to retain timeline OUT. Numeric source edits keep the start
in either mode. Invalid overlap, fade or frame-quantisation edits are rejected.
Originals and full proxies are never cut or regenerated by trimming.

- **Split / S** splits at the playhead and selects the new right piece.
- **Trim start / Q** removes the head before the displayed frame; **Trim end / W**
  removes the tail after it. Both keep that frame; handles can recover omitted footage.
- To remove a middle section, select an excerpt, seek the first unwanted frame and
  mark timeline **IN / I**, then the last unwanted frame and **OUT / O**.
  The hatched range is removed by **Cut range / Shift+Delete**, in **one Undo step**.
  Ripple-on cuts close the gap on that track; off keeps the removed gap and fixed neighbours.
- **Clip actions → Duplicate / Ctrl+D** makes an independent instance. Timeline
  Delete removes an instance, not its original or project-bin membership.

Placement ghosts show the actual row/start, including destination speed timing.
Red invalid ghosts never commit. **Snap** uses nearby boundaries; **Alt** bypasses
magnets, but cannot turn a Ripple-on row into free placement. Trim and point drags
preview transiently, commit once on valid release, and cancel with Escape.
**Timeline start frame** and nudge controls work on independently positioned clips
or the **first Ripple anchor only**. Later Ripple clips expose an accessible reason:
drag to reorder, or turn Ripple off in Layer options to set an independent start.

Boundary **Cut / Fade / Dissolve** and **Sequence fades** belong to the selected
track in **Sequence**; clicking a boundary button explicitly opens that tab.
Gapped pairs are Cut only: explicitly close the gap or enable Ripple before adding
a fade/dissolve. A cross-dissolve explicitly adjusts the right clip to its overlap;
with Ripple off, no other clip moves and conflicts reject it.
Black fades darken only that row's RGB, preserving coverage rather than revealing
lower footage. Opening/closing fades use actual first/last placements and remain
stored but dormant on empty tracks. Details: [TIMELINE_EDITING.md](TIMELINE_EDITING.md).

## Colour, speed and shared row keyframes

Each excerpt has independent static colour, clip opacity and constant/ramp/custom speed
bases. **Colour** provides Exposure, Brightness, Contrast, Hue, Saturation, Highlights
and Shadows. Speed accepts **0.1×–8×**, including ramp-up/down curves. Slow motion
repeats frames and acceleration drops them; there is no optical-flow synthesis.
Speed changes output duration: Ripple-on tracks re-sequence, off keeps independent starts,
and incompatible fades/transitions/overlaps reject the edit rather than being shrunk.

### Compare graded and ungraded preview

The **Timeline preview** heading has a native **Compare** button, accessible as
**Show ungraded preview**. When active, it reads **Ungraded** and the canvas shows
an **Ungraded** badge. Click or use the focused button's Enter/Space to toggle while
paused or playing; there is no global shortcut. **Source preview** is unchanged.

Ungraded means the **composed timeline preview without grading**, not an
original-resolution view or an isolated selected clip. It neutralizes all evaluated
colour settings across enabled rows, including clip bases, row colour keys and both
dissolve participants. Exact observed source frames, retiming, clip and layer opacity,
visibility, black fades, stacking and music remain unchanged.

Comparison is editor-only: toggling never seeks, saves, enters Undo history, changes
exports, schema, proxies or originals, or adds decoders. Same-project seeks,
appearance edits and timing reloads retain the mode; changing project or reloading
the editor with a fresh preview engine resets to normal graded preview.

### Precise clip speed curves

Select the excerpt, open **Clip → Speed**, and choose **Custom curve**. Start from
**Flat / Accelerate / Decelerate / Slow centre / Fast centre**, then edit any point.
These points belong only to the selected clip, not to every clip in its video row.

- Drag horizontally for original source time and vertically for speed. The graph
  has a logarithmic 0.1×–8× axis; the vertical line is the displayed source frame.
- For precise edits, select a point and enter **Source frame**, **Speed ×** and
  **To next point** easing. Source frames are integers; numeric rates retain the
  decimal precision you enter. Enter/blur applies, Escape restores.
- Click the graph background or a point to seek, then **Add point** at an unkeyed
  displayed source frame. Point Previous/Next and the selector also reach off-trim
  keys. The original OUT anchor previews the last available image.
- Drag drafts preview live without saving. Valid release is one Undo; Escape,
  pointer cancellation/capture loss or window blur restores the prior edit.
  Red collisions or timing conflicts never merge, overwrite or shrink transitions.
- Focus a point: arrows move one source frame or 0.01×; Shift moves ten frames
  or 0.1×. Enter seeks; Delete removes it if at least two points remain.
- Keys retain original source positions through trims, splits and marked cuts;
  duplicated/split clips have independent curves. **Reset** returns only this clip
  to 1×. No generated slow-motion frames or optical flow are added.

Existing **Row speed animation** stays separate and overrides a clip curve when
the row has Speed keys. The override notice explains it; removing those Speed
participants reveals the clip curve unchanged. Row colour/opacity animation is
unaffected. Details: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md#precise-clip-curve-editor).

### Opt in to animation

The dedicated **Keyframes** Inspector tab (accessible name **Layer keyframes**)
belongs to the selected **whole video row**, even an empty one, not to a clip.
It contains the point count, participant chips, whole-row Previous/Next navigation
and a directly visible shared point list. The toolbar's **Animation help** combines
animation and point-timing guidance. **Clip** keeps source/static settings and the
diamonds and value controls that use the real playhead. All row points use absolute project
frames and affect every clip on that row. Ten settings participate independently:
Layer opacity, Clip opacity, Speed and the seven colour controls. At most 256
shared points are allowed per row.

- Every setting has a **hollow ◇ / filled ◆ diamond**. Hollow means inactive but
  clickable. Click at the **real playhead** to capture/join that setting; click filled
  to remove only its participation. First participation creates the point; removing
  the last participant deletes it. Sliders never create implicit keys.
- With no keys for a channel, its static base remains editable. Once animated, its
  value is read-only where it does not participate: click the hollow diamond first.
  Removing its final participation reveals the existing base, not a new default.
- Each point shares an easing, but every channel interpolates to its **own next
  participating point**, skipping unrelated settings; its endpoints hold outside
  that interval. A single point therefore overrides that channel across the row.
- The **Previous/Next buttons immediately after each diamond** visit only that
  channel's strictly earlier/later participants, including zero-valued ones. They
  remain visible but disabled without a neighbour/project or during a document draft.
  Navigation keeps the chosen Inspector tab and the activated button's focus; it
  does not save or create Undo history.

### Move and inspect shared points

The timeline shows **one marker per stored shared point**, not per clip/channel.
Click or Enter selects its row and seeks without editing or changing the chosen
Inspector tab. Whole-row point navigation also keeps that tab. Drag horizontally to
move **all participants, values and easing together**; valid release is one Undo
step. With Snap on, pointer movement snaps within eight pixels at the captured zoom
to captured clip/music/transition boundaries and playhead; **Alt** bypasses it.
Focused marker **←/→** moves one project frame, **Shift+←/→** ten, without snapping
or also stepping the playhead/nudging a clip. **Keyframes → Time, easing & values**
on each point provides exact time/value editing with Enter/blur to apply
and Escape to restore.

The shared list has no outer disclosure or per-row list expansion preference.
Nested point details remain collapsible; drafts and input identity survive point
reordering and Undo.

Stored colour/opacity participants use the same sliders and individual colour
resets as the main controls, with one precise numeric field to the right of each
slider (opacity uses the stored 0–1 scale). Stored
Speed uses the **Layer rate ×** field and Reset to 1×, not clip speed modes or a
source-frame curve. These controls edit only an existing participant at that
stored point; they never implicitly join a setting. Each accepted value/reset is
one Undo step and leaves the point's time, shared easing, other participants and
static bases unchanged. Invalid or out-of-bounds numeric drafts remain editable
with errors; timing conflicts reject the edit rather than shortening transitions.

Occupied frames never merge or overwrite points. A red collision or Speed-related
timing conflict rejects the entire final move, not just one setting or an earlier
valid draft. Escape, pointer cancellation, lost capture or window blur restores the
document/preview/scroll; pointer previews never enter autosave or history.

Points outside duration stay stored and list-editable. Points after the last clip
keep their timeline markers at their own time, like points before the first clip;
the timeline scrolls far enough to reach them, but playback still stops at the
last clip frame. Setting/row/list/marker navigation can inspect successive stored
points while preview clamps to the nearest available
frame (none on an empty timeline). Labels distinguish **stored time from actual
preview**: list controls edit the stored point, but Clip's setting values,
diamonds and capture still use the **real playhead**. Manual seek, playback and
row/project changes clear inspection; **Follow playhead** ends it explicitly.
A point alone does not extend the sequence; Speed participation can naturally
recompile clip durations.
Trim, cut, move, split, duplicate and ripple **never copy or shift row points**.

Current animation semantics: [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).
Grading equations: [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md#colour).
Retiming: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md).

## Add music and export

Source-video audio is not used. In **Audio → Music**, enter your own standalone
local file in **Music file path**, choose **Import audio**, wait for preparation,
then select the ready recording from this project's music bin. No soundtrack is
supplied; use music you own or have permission to use and keep private paths private.

If music was moved, import its new location normally and choose the new **Recording**
entry after preparation. This does not reconnect or replace the old entry; existing
projects and caches remain untouched. Reimporting the same unchanged path reuses its
entry, while a missing old location stays visibly unavailable.

One music track supports waveform placement/edge trims, numeric source IN/OUT,
start/duration, **gain dB**, linear fades and **Loop selected source range**.
Without looping, duration must fit that source range; looping repeats only it.
There is no hidden loudness normalisation or video-speed retiming of music.
Preview uses bounded PCM streaming through Web Audio, not a full-file buffer or
an approximate media-element clock. Selected-range loops continue without a music
restart; genuine video buffering or audio read/processor failures stay explicit.
If an older prepared recording lacks the current PCM cache, **Audio → Music →
Retry recording name** explicitly prepares it. No startup/library read starts that
job, and older caches/originals remain untouched. This cache needs about 11.52 MB
per minute; project and video-proxy formats are unchanged.
Native export loops the selected PCM range continuously and pads/trims AAC to video
duration. The complete video's duration is not extended to fit music.

Choose **Export** for a **1280×720 draft** or **3840×2160 final**, H.264 SDR BT.709
from originals, with optional 48 kHz AAC music. The quality cards and storage meter
show the selected preset, free space and an advisory planning allowance. Actual
compression/disk use can differ: this is not a guarantee or fixed-GB bound.
Use **Storage details** for the output location and assumptions, **Refresh storage
check** after freeing space, or **Retry storage check** after a mount/check error.
A tight-space warning is advisory; below the minimum start reserve, export is
disabled. Low-space failure preserves originals, edits and completed exports.
Submission captures an immutable
snapshot: later edits cannot change that render. Activity exposes progress,
cancellation and verified MP4/receipt links. **Cancelling…** is pending until
confirmed; a failed status read keeps known jobs and never resubmits the export.
Successful outputs survive later failures/restarts; interrupted exports are not
resumed or published as finished. Long 4K/layered renders can need substantial
scratch disk and CPU time; short tests do not qualify long-flight throughput.
See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md) and
[Inspector and resource limits](LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits).

## Workspace and keyboard

Use **Clip / Keyframes / Sequence / Audio** for source/static and playhead
settings, the whole-row point list, track transitions/fades and music, respectively.
Keyframes retains the accessible tab name **Layer keyframes**. Keyframes and
Sequence use the selected row without a redundant selected-track banner.
Selecting an excerpt or a populated/empty row preserves the chosen tab and updates
its row context safely. Switching tabs hides rather than unmounts content, retaining
drafts within the same editing context; changing the edited row/clip refreshes its
fields rather than applying a previous context's draft to the new selection.
Explicit boundary buttons still open Sequence.

**Expand all / Collapse all** appears only in Clip and controls its four top-level
sections: **Source range**, **Layer & opacity**, **Speed** and **Colour**. Sequence,
Audio, nested disclosures and help remain unchanged.

The header directly exposes **Media / Inspector toggles and keyboard help**.
**Workspace options** keeps Reset layout and Diagnostics.
Drag panel dividers or use focused arrows; double-click/Home resets a divider and
Escape cancels its drag. Compact desktop windows use one side drawer at a time.
Layout/section preferences do not change rendering. Numbers/titles apply on
Enter/blur, Escape restores, and invalid text remains editable; sliders stay live.
Source-review paired IN/OUT deliberately requires **Apply**.

Clip shows the selected excerpt/row first; section readouts and dots
indicate adjusted settings without expanding everything. Animated channels use
an amber curve/diamond: dashed between keys, filled when the setting participates
at the playhead. **Animation help** in the Keyframes toolbar explains scope,
capture and point timing; there is no separate Keyframe timing help button.
No static or animated control is removed. Search/filter clear actions,
mixed select-all and always-visible media Add simplify the library.

Inline help is a small **? button**, not an expandable text section. Find it
beside the relevant title—**Source range**, **Layer &
opacity**, **Speed**, **Colour**, **Transition**, **Sequence fades**
or **Placement & fades**—even when that section is collapsed. Help and expansion
are separate buttons; no scrolling to the end of a section is needed. Startup
details are next to **Preview needs attention**.

Hover or focus to preview it; click, Enter or Space to keep it open while moving away.
You can move the pointer into the help to read it, or press Down arrow to focus
and scroll its text. Escape or a click elsewhere closes it; Escape closes help
before cancelling an input draft. Hovering help never applies a field or edits
the project. A deliberate click away from a number still applies a valid draft
once, as usual. Settings, nested **Time, easing & values**, music placement and
storage/render breakdowns remain their existing expandable controls, not help buttons.

| Context                                     | Shortcut                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Timeline play/seek                          | Space; ←/→ one frame; Shift+←/→ ten; Home/End; F to fit                      |
| Split / quick trim                          | S / Q / W                                                                    |
| Unwanted timeline range                     | I / O; Shift+Delete cuts; Escape clears marks                                |
| Instance actions                            | Ctrl+D duplicate; Delete/Backspace remove                                    |
| Session history                             | Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y redo                                          |
| Positioned clip / first Ripple anchor nudge | Alt+←/→ one frame; Alt+Shift+←/→ ten; later Ripple starts require Ripple off |
| Focused trim handle                         | Arrows one source frame; Shift ten; left Home/right End restore              |
| Focused row marker                          | Arrows one project frame; Shift ten; Enter selects/seeks                     |
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
Download before discarding; the v6 JSON snapshot is for manual recovery/examination,
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
