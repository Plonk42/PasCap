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

Projects use **strict format v5**. Older project documents and export snapshots
stay on disk but are incompatible: there is no migration or automatic repair.
Create a new project and import its media deliberately. Finished videos remain
untouched. **Delete project** requires confirmation and deletes only the saved
project document, not originals, the shared registry/proxy cache or exports/receipts.

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

The primary **Ripple sequence** inserts, reorders, deletes and trims while keeping
later primary excerpts connected. Primary drops choose a legal boundary. Up to
**seven positioned overlays** give eight video layers total: their starts are
independent, and other overlays, music and row points do not follow primary ripple.
Excerpts cannot overlap on the same overlay row; use different rows for simultaneity.

Select an excerpt and drag an edge inward to shorten it or outward to restore
omitted footage up to the original bounds. The dashed extent shows available source.
Left-edge autoscroll can recover a long omitted beginning. **Clip → Source range →
Restore full recording** restores both endpoints; numeric IN/OUT offers exact edits.
An overlay's left handle changes its start to retain its timeline OUT; numeric source
edits keep its start. Invalid overlap, fade or frame-quantisation edits are rejected.
Originals and full proxies are never cut or regenerated by trimming.

- **Split / S** splits at the playhead and selects the new right piece.
- **Trim start / Q** removes the head before the displayed frame; **Trim end / W**
  removes the tail after it. Both keep that frame; handles can recover omitted footage.
- To remove a middle section, select an excerpt, seek the first unwanted frame and
  mark timeline **IN / I**, then the last unwanted frame and **OUT / O**.
  The hatched range is removed by **Cut range / Shift+Delete**, in **one Undo step**.
  Primary edits close the gap; overlay cuts retain the gap and fixed neighbours.
- **Clip actions → Duplicate / Ctrl+D** makes an independent instance. Timeline
  Delete removes an instance, not its original or project-bin membership.

Placement ghosts show the actual row/start, including destination speed timing.
Red invalid ghosts never commit. **Snap** uses nearby boundaries; **Alt** bypasses
magnets, but cannot turn the primary row into free placement. Trim and point drags
preview transiently, commit once on valid release, and cancel with Escape.
Boundary **Cut / Fade / Dissolve** and opening/closing fades belong to **Sequence**
and the primary row only. Details: [TIMELINE_EDITING.md](TIMELINE_EDITING.md).

## Colour, speed and shared row keyframes

Each excerpt has independent static colour, clip opacity and constant/ramp/custom speed
bases. **Colour** provides Exposure, Brightness, Contrast, Hue, Saturation, Highlights
and Shadows. Speed accepts **0.1×–8×**, including ramp-up/down curves. Slow motion
repeats frames and acceleration drops them; there is no optical-flow synthesis.
Speed changes output duration: primary clips ripple, overlays keep their starts,
and incompatible fades/transitions/overlaps reject the edit rather than being shrunk.

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

**Layer keyframes** belongs to the selected **whole video row**, even an empty one,
not to a clip. All points use absolute project frames and affect every clip on that
row. Ten settings participate independently: Layer opacity, Clip opacity, Speed and
the seven colour controls. At most 256 shared points are allowed per row.

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
  Navigation does not save or create Undo history.

### Move and inspect shared points

The timeline shows **one marker per visible shared point**, not per clip/channel.
Click or Enter selects its row and seeks without editing. Drag horizontally to
move **all participants, values and easing together**; valid release is one Undo
step. With Snap on, pointer movement snaps within eight pixels at the captured zoom
to captured clip/music/transition boundaries and playhead; **Alt** bypasses it.
Focused marker **←/→** moves one project frame, **Shift+←/→** ten, without snapping
or also stepping the playhead/nudging a clip. **Edit points → Time, easing & values**
provides exact time/value editing with Enter/blur to apply and Escape to restore.

Occupied frames never merge or overwrite points. A red collision or Speed-related
timing conflict rejects the entire final move, not just one setting or an earlier
valid draft. Escape, pointer cancellation, lost capture or window blur restores the
document/preview/scroll; pointer previews never enter autosave or history.

Points outside duration stay stored and list-editable. Setting/row/list navigation
can inspect successive stored points while preview clamps to the nearest available
frame (none on an empty timeline). Labels distinguish **stored time from actual
preview**: list fields edit the stored point, but setting values/diamonds/capture
still use the **real playhead**. Manual seek, playback and row/project changes clear
inspection; **Follow playhead** ends it explicitly. A point alone does not extend
the sequence; Speed participation can naturally recompile clip durations.
Trim, cut, move, split, duplicate and ripple **never copy or shift row points**.

Current animation semantics: [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).
Grading equations: [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md#colour).
Retiming: [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md).

## Add music and export

Source-video audio is not used. In **Audio → Music**, enter your own standalone
local file in **Music file path**, choose **Import audio**, wait for preparation,
then select the ready recording from this project's music bin. No soundtrack is
supplied; use music you own or have permission to use and keep private paths private.

One music track supports waveform placement/edge trims, numeric source IN/OUT,
start/duration, **gain dB**, linear fades and **Loop selected source range**.
Without looping, duration must fit that source range; looping repeats only it.
There is no hidden loudness normalisation or video-speed retiming of music.
Preview uses media-element Web Audio, not a full-file buffer. Buffering and loop
seeks may pause/re-anchor music/video; **gapless browser loops are not promised**.
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
[DELIVERY_STATUS.md](DELIVERY_STATUS.md#resource-contract).

## Workspace and keyboard

Use **Clip / Sequence / Audio** for excerpt settings, transitions and music.
The header directly exposes **Media / Inspector toggles and keyboard help**.
**Workspace options** keeps Reset layout and Diagnostics.
Drag panel dividers or use focused arrows; double-click/Home resets a divider and
Escape cancels its drag. Compact desktop windows use one side drawer at a time.
Layout/section preferences do not change rendering. Numbers/titles apply on
Enter/blur, Escape restores, and invalid text remains editable; sliders stay live.
Source-review paired IN/OUT deliberately requires **Apply**.

The selected excerpt/row appears first in Inspector; section readouts and dots
indicate adjusted settings without expanding everything. Animated channels use
an amber curve/diamond: dashed between keys, filled when the setting participates
at the playhead. **Animation help** explains scope and capture once; no static
or animated control was removed. Search/filter clear actions, mixed select-all
and always-visible media Add simplify the library.

| Context | Shortcut |
| --- | --- |
| Timeline play/seek | Space; ←/→ one frame; Shift+←/→ ten; Home/End; F to fit |
| Split / quick trim | S / Q / W |
| Unwanted timeline range | I / O; Shift+Delete cuts; Escape clears marks |
| Instance actions | Ctrl+D duplicate; Delete/Backspace remove |
| Session history | Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y redo |
| Selected overlay nudge | Alt+←/→ one frame; Alt+Shift+←/→ ten |
| Focused trim handle | Arrows one source frame; Shift ten; left Home/right End restore |
| Focused row marker | Arrows one project frame; Shift ten; Enter selects/seeks |
| Focused source review | I/O marks source range, not the timeline's unwanted range |
| Shortcut guide | ? outside form/modal/source controls |

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
Download before discarding; the v5 JSON snapshot is for manual recovery/examination,
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
