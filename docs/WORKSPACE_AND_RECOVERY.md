# Desktop workspace and recovery

The workspace uses **the strict current schema with complete required video track colour and Transform, clip-only speed and reverse, uniform video tracks, required per-track
Ripple/transitions/fades, 0–8 independently identified music tracks, project-specific
video/music bins and draggable shared project-time track keyframes**, with per-setting channel navigation. Layout preferences,
stored-keyframe inspection and recovery feedback remain editor-only. Source protection,
coverage-preserving black fades, grouped dissolves and native video budgets are
unchanged. Every video track has one required numeric `opacity` in 0–1, initially 1 (100%)
on new tracks; its sole `opacity` keyframe channel overrides the track value for every
source, including both dissolve sources. There is no saved `clip.opacity`
or additional track multiplier; current native bounds
are in [the resource contract](LAYERS_AND_KEYFRAMES.md#properties-panel-and-resource-limits).
The intended discrete-GPU and long real-flight checks remain deferred.

## Layout and navigation

Main **Track → Colour** edits twelve scalar video track colour values, HDR, Local contrast and sole Opacity, including
on empty tracks. Static and keyed Colour share this track ownership on every clip.
Different treatments require different tracks; there is no per-clip grade or scope
toggle. Sources are graded once; the Original preview neutralizes track Colour and clip Detail only.
See [track appearance](design/ROW_APPEARANCE.md) for reset, context and storage details.
**Temperature / Tint** precede Exposure, use normalized values (Temperature −2…2, Tint −1…1) and Reset to
0, and retain native sliders/exact fields in main and stored editors. Main
diamonds and adjacent per-setting Previous/Next buttons are always visible, alongside section-header navigation and existing stored enabled-setting chip arrows.
Positive Temperature warms; positive Tint adds magenta.
Nonzero settings intentionally colour greys; shared normalized linear gains run
before Exposure, preserving neutral-white linear luminance before clipping only.
They are not Kelvin or HDR output. **Auto white balance**, under Tint, keyframes both at the playhead from
the light of a few frames around it ([details](design/TEMPERATURE_AND_TINT.md#automatic-white-balance)).
**Auto**, in the Colour keyframe line, analyses the whole clip at the playhead or the second around the
playhead, for the track's values or (from the second around it) a keyframe there, and, from its popover's **Apply**, sets eleven Colour
settings in one Undo step, previewing first ([Auto adjust](design/AUTO_ADJUST.md)).
HSL/curves remain static. See
[Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
**HDR** (0–1, neutral 0) is a keyable SDR local tone-mapping look applied with the
clip detail filters before grading; see [detail filters](design/DETAIL_FILTERS.md#hdr-look).
**Local contrast** (−1…1, neutral 0) is the keyable local-detail boost split out of HDR, in the
same kernel; see [local contrast](design/DETAIL_FILTERS.md#local-contrast).

- Header: project picker/title, Undo/Redo, save state, keyboard help,
  **Workspace options** and Export. Workspace options holds layout reset and
  Diagnostics.
- Panels are bordered tiles separated by 6 px gutters, also below the header and above the
  Activity bar but not at the window sides; corners on the window edges are square, the others rounded 4 px.
  The gutters are the resize dividers; each divider grabs 2 px into its neighbours.
  Media and the Properties panel each have a panel icon at the right of their heading
  (**Collapse Media panel** / **Collapse Properties panel**, `aria-expanded`). A
  collapsed panel leaves a 28 px labelled strip on its side; the whole strip is the
  **Expand Media panel** / **Expand Properties panel** button. Focus moves between
  the two buttons.
- Left: independently scrolling Media list/grid with search, import and compact
  status. **Media options** holds filter/sort/view controls. A plain click reviews;
  checkboxes/Ctrl/Shift select. With two or more recordings selected, the
  **Select all** bar shows their count with Prepare/Clear; dragging
  a selected recording inserts the whole selection. A recording or music file whose
  original is not at its registered path shows **Original missing** with a **Relink**
  button in place of its add/prepare actions.
- Centre: docked **Timeline preview** / **Source preview** tabs, never an overlay
  covering other editor controls. Tab arrows and Home/End switch viewer contexts.
- Right: scrollable **Clip / Track / Audio** Properties tabs
  with readable inputs and independent collapsible sections, split by ownership.
  Clip ("Clip N of M · track") contains the selected clip's **Speed**,
  **Detail**, **Range** and **Placement**; an empty video track shows one line instead.
  Track ("Applies to all N clips on this track") contains Colour with the single
  track-owned Opacity control and, at its end, the whole-keyframe list (enabled-setting chips
  and Animation help), **HSL ranges**, **Colour curves**, **Transform** (ending with its own
  keyframe list), Transitions and Fades;
  Audio owns selected-track music controls (**Music track / Recording / Add music
  track / Delete selected music track**).
  Empty-track selection retains Track context and dormant fades. The chosen tab is
  a browser-local preference that survives reloads.
- Bottom: frame-scaled multi-track timeline, playhead timecode, highlighted active
  insertion track, one marker per stored track keyframe, dimmed hidden clips and Activity.
  The responsive toolbar starts with **Snap**, then the **Bookmark** group (Previous bookmark, add at the playhead or delete the one there, Next bookmark), then keeps Split, Trim start/end and Delete (which deletes the selected range while one is selected)
  directly visible; Duplicate is in the clip's right-click menu (Ctrl+D), and start
  nudging beside Clip → Placement's start field. Zoom keeps its slider and Fit,
  with Zoom out / Zoom in buttons beside them.
  Video tracks display the saved bottom-to-top composition array: track 1 renders below track 2,
  track 3 above track 2, and so on, with no primary/overlay role. The thin ruler remains
  pinned above scrolling video tracks with TIME ticks/separators, a playhead handle and
  lilac outlined ghost-playhead [bookmarks](TIMELINE_EDITING.md#bookmarks) in its lower half:
  a click seeks, a drag selects a range to cut and the handle scrubs;
  distinct Cut/Fade/Dissolve buttons open boundary transitions, not keyframes.
  While dragging a ruler range or the playhead, the preview shows each decoded frame as soon as it is
  ready (the newest pointer position wins, never aborting an undecoded seek); the Properties panel's
  playhead values catch up whenever the pointer rests, even before release, and exactly on release.

Viewer and Properties tabs use native buttons with consistent padding, borders and
selected appearance, retaining arrow/Home/End navigation. Colour's and Transform's keyframe
lists keep their accessible names under a small visible **Keyframes** heading.
The Properties tab bar stays pinned while its content scrolls; keyboard focus and
scroll-into-view reveal controls below that bar rather than beneath it.
Control vocabulary and button/icon conventions follow the
[editor control catalogue](design/EDITOR_CONTROLS.md#vocabulary). Trash deletes; × closes or
dismisses. Icon-only actions retain accessible names and tooltips.

Media/Properties widths and Timeline height can be resized by pointer or focused-divider
arrows (16 px; Shift uses 32 px). Double-click/Home resets a divider. Pointer move
changes only a transient UI size; release saves the layout preference. Escape,
pointer cancellation and lost capture restore the prior size. Dividers are disabled
during timeline trim/shared-keyframe/music drafts to preserve captured geometry.

**Workspace options → Reset layout** restores defaults. Until its divider is moved, the
Timeline is 220 px tall on viewports under 800 px high and 290 px otherwise.
Side-panel visibility and dimensions are
browser-local UI preferences, never document/history fields. Sizes are clamped to
viewport bounds. The supported minimum is a **1280 × 720** CSS viewport; 1440 × 900
is the default desktop size. At supported sizes the workspace does not overflow
horizontally, Keyframe controls remain reachable with the Properties panel at its 270 px
minimum, and the toolbar and music lanes retain usable pointer targets. Smaller
windows are best effort, not a support or validation target: below 980 px one side
drawer is visible at a time, and the CSS floor is 640 px. This is not a mobile editor.
Denied browser storage leaves layout/section controls usable for the session and
exposes an explanatory preference warning. These are UI contracts, not performance
certification.

Choosing a video track selects its first clip (if present), highlights that track and
reveals it vertically. Empty-track selection clears clip selection but retains the
insertion target **and its Track context/settings**. Selecting a
clip or a populated/empty track preserves the user's chosen Properties tab. Its fields
refresh for the new editing context without applying the previous track/clip's drafts
to that selection. Automatic track reveal never runs under an active
trim/shared-keyframe/native clip drag. Selected clips and source-list **Show**
requests are also revealed horizontally; showing the first
clip restores the normal frame-zero gutter. Selection never changes
source ranges, clip settings, track Opacity, track order or absolute project-frame keyframes.

The timeline and track headers both support native vertical scrolling, including
wheel/trackpad, scrollbars and keyboard focus reveal. They share the same vertical
position and track geometry; horizontal timeline scrolling does not move the headers.
All eight video tracks and up to eight music tracks remain reachable at compact timeline heights.
Scrolling alone does not seek, edit, create history or save.
The ruler stays visible at every vertical scroll position while its ticks follow
horizontal timeline scroll. Header focus and automatic reveal account for the
pinned heading/ruler. Clip/media drops target actual visible tracks, never the ruler
or a track hidden underneath it.
Track options explain unavailable stack actions: the top composition track cannot
be raised further, the bottom cannot be lowered further, and the last remaining
track cannot be deleted. Every other track can be reordered/deleted; the initial
ID is not a protected base. Actions remain undoable, and active drafts/unavailable
preview still block mutations.

**Track options → Ripple** is a native checkbox with contextual help; the track
header's Ripple toggle icon shows and switches the same setting. New tracks default on.
The header's **Select all clips** icon adds the track's clips to the clip selection, which
Ctrl/Cmd-click on clips also builds; Delete and Alt+arrows then act on every selected clip
([multi-clip moves](TIMELINE_EDITING.md#insertion-reordering-and-history)).
Track options contains only rename, Ripple,
raise/lower and delete; visibility remains a separate sidebar control.
**Track → Colour** contains the single **Opacity** native slider/exact
`NumberField` alongside the colour controls, with its diamond.
The Colour keyframe line's Previous/Next pair visits the union of Opacity,
twelve scalar, HDR and Local contrast keyframes. Per-channel Opacity
Previous/Next buttons remain beside the main diamond, alongside
the existing arrows on enabled setting chips in stored Colour keyframe rows.
Main and stored sliders/exact fields use **0–100%**, neutral **100%**.
Required track `opacity` and keyframe values remain **0–1**; UI conversion changes no schema.
Without Opacity keyframes, either value control edits track `opacity`, including on an empty
track with no selected clip.
With keyframes, that channel overrides the track value on every clip and both dissolve
sources; a setting not enabled at the real playhead is read-only until captured
with the diamond. Sliders never create implicit keyframes. Unkeyed colour remains
track-owned with or without keyframes. Opacity is composition coverage, not SDR RGB grading.
**Clip → Placement** contains placement only, without an Opacity or sidebar duplicate.
Enabling Ripple packs current clips from the first
current start, closing gaps in one Undo and retaining valid dissolves. While on,
later clips continuously follow the first anchor; commands persist actual starts.
Turning off captures actual placements for independent edits. **Timeline start
frame** works on positioned clips or the first Ripple anchor; later
Ripple starts are disabled with a tooltip explaining how to reorder or
turn Ripple off. Music, other tracks and absolute track keyframes never follow Ripple.

In **Track**, Transitions lists every boundary of the selected track and **Fades**
edits its opening/closing fades.
Gapped pairs are Cut only, with a reason to close the gap or enable Ripple before
adding a non-cut effect. A positioned dissolve edit explicitly adjusts its paired
right clip; other clips stay fixed and conflicts reject the whole edit. Black
opening/closing/transition fades darken only that track's RGB, preserving coverage.
Empty tracks retain dormant fades; adding footage validates them again.

Keyboard help is available via the **header help button** or `?`
outside form/modal/source controls. Space, S, Q/W, M (add bookmark), Shift+↑/↓ (previous/next bookmark), Shift+Delete, Escape,
Ctrl+D, Delete/Backspace, Undo/Redo,
arrows, Shift+arrows, Alt+arrows, Alt+Shift+arrows, Home/End and F
are mapped explicitly. Space plays or pauses after a pointer press on a control
(button, tab, checkbox, slider, select or divider), so focus left by a click never
swallows it; a control reached by keyboard keeps native Space activation, and text
or number fields always keep the typed space. Space drives the displayed preview: the
source preview's IN–OUT playback while **Source preview** is shown, the timeline
otherwise. Editing
shortcuts cannot mutate clips while using a modal, source control, input, options
popover, activity drawer or pane divider. Skip links expose the major editor regions.
On a focused track keyframe marker, Left/Right moves that keyframe one project frame and Shift
moves ten; Delete/Backspace removes it (one Undo step). Marker keyboard events remain in that context, retaining keyframe/Timeline
focus while navigating to the moved keyframe, without also firing ordinary playhead-step,
clip-nudge or other editor shortcuts.
Click or Enter on a marker selects its track, seeks and opens Track → Colour, without editing; whole-track keyframe navigation preserves the chosen Properties tab.
A focused bookmark moves the same way and Delete/Backspace removes it; click, Enter
or Space only seeks to it.

Options are nonmodal disclosures with normal Tab navigation, not custom ARIA menus.
They use the browser top layer to avoid clipping inside panels. Escape closes and
returns focus to the trigger; clicking outside closes without stealing focus from
the clicked control. Properties tab arrows/Home/End switch contexts without discarding
mounted content or its valid/invalid drafts within the same editing context.
Selecting a clip or track keeps the chosen tab; explicit Cut/Fade/Dissolve boundary
buttons open Track with that boundary expanded.
**Expand all / Collapse all** is an icon button on the Properties panel tab bar that changes
only the visible tab's sections, including temporarily absent ones: Clip's **Speed**,
**Detail**, **Range** and **Placement**; Track's **Colour**, **HSL ranges**, **Colour curves**, **Transform**,
**Transitions** and **Fades**; Audio's **Music**. It is hidden while Clip has no
selected clip or Track no selected track. A tab with any section open offers Collapse all; only an all-collapsed tab offers Expand all. Individual toggles
and the existing section preferences remain authoritative. Other tabs'
sections, each keyframe's nested **Edit**, other nested details and help are unchanged.
Bulk expansion is presentation-only and leaves mounted drafts, processing, history
and saves unchanged. If preference storage fails, choices still work for the session.
New preferences keep **Speed**, **Detail**, **Range**, **Placement**, **HSL ranges**, **Colour curves** and **Transform** collapsed and the other Track sections open;
existing expansion preferences remain respected. Help/reset details are contextual,
not repeated across the main workspace. Collapsing never disables processing.

All inline help uses a small **question-mark button**, including animation, source,
opacity, speed, Transform, colour, keyframe/transition/fade/audio timing and startup details.
Properties **Speed**, **Detail**, **Range**, **Placement**, **Colour**, **HSL ranges**, **Colour curves**, **Transform**, Transition and Sequence
fades put help beside their titles, reachable even when collapsed. Expansion and
help are independent native buttons in normal section → help → fields Tab order
(an open help's **Learn more** link comes right after its button);
help never opens or closes the settings. Hidden content remains mounted, retaining
its valid/invalid drafts and section preferences.
Each help body is at most two short sentences plus one tip, written as user guidance;
exact behaviour stays in [the user guide](USER_GUIDE.md), reached from a **Learn more**
link (opening in a new tab) on every help except startup details.
Shared-keyframe timing guidance is combined with **Animation help** beside Colour's
**Keyframes** heading; there is no separate Keyframe timing help button. Audio timing sits beside
**Placement & fades**, and startup details beside **Preview needs attention**.
These title-bar help targets remain available without expanding their settings;
collapsing content does not hide its heading help. Hiding the owning tab/pane
still dismisses help. **Animation help** sits inside the expanded Colour section, above
its stored keyframe list.
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
has the ordinary one-commit blur behavior. Editable section/keyframe/music/import controls,
storage/render breakdowns and real warning/error lists remain normal disclosures.

The preview timecode accepts nominal 30 fps NDF **MM:SS:FF** or an integer
timeline frame; it is not rounded wall-clock seconds. Every timecode in the editor
omits hours: minutes keep counting past one hour (61:00:29). Out-of-range/invalid input
stays editable with an error and never seeks. Escape returns to the current display.

### Preview original image

The **Timeline preview** heading's native **Original** button has the accessible
name **Show original preview**. The image is original (Colour and Detail bypassed,
with the **Original** badge) only while the button is held: pointer down until
release (the pointer is captured, so releasing outside the button counts), or
Enter/Space held on the focused button. Pointer release or cancel, key release,
losing button focus or window blur restore the graded preview. It works paused or
during active playback, including normal decoder buffering. Buffering is not a pause:
the requested mode is drawn once the required decoded frames arrive,
without restarting music. Errors and completion are not active-playback evidence;
regressions require a subsequent actual Playing draw in the requested mode with
the same music epoch and unchanged one-frame A/V/source bounds;
there is no global shortcut. **Source preview** is unaffected.

The original view is the composed preview without grading, not the untouched
recording, original-resolution footage or the selected clip in isolation. All evaluated colour settings are neutral
across enabled video tracks, including track colour bases/keyframes and both dissolve
sources, and every clip's Sharpen/Clarity/Denoise is bypassed. Exact decoded source frames and retiming, spatial geometry/coverage, track Opacity,
visibility, black fades, stacking and music are preserved.

This mode belongs only to the editor's preview engine: holding causes no seek,
save/history entry, export, schema, proxy or original change, or new decoder.
Same-project seeks, appearance updates and timing reloads keep it while held; changing project
or reloading the editor with a fresh engine restores normal graded preview.

## Numbers, titles and animation

Colour/Opacity/Transform values, playback rates and music gain share a bounded native slider
with an adjacent exact `NumberField` in main controls and stored-keyed-setting editors.
The field is the sole numeric value display, not a read-only output or number-only
layout. Opacity sliders/exact fields always use **0–100%**, neutral **100%**;
only UI values are scaled, with track `opacity` and keyframe storage unchanged at **0–1**.

Pointer sliding keeps a transient local control-value draft that updates the thumb and numeric value, not the document. Dragging a Colour, Opacity, HSL or Transform slider (main or stored) previews the draft value in the image, coalesced to the display rate, without any document, history, autosave or Properties change, and without restarting music. Release commits one validated edit and one Undo step. Escape, pointer cancellation, lost capture, window blur or an invalid value restores the control and the preview. Other sliders (speed, gain) update the image on release, after one validated document edit and one Undo step. An invalid release applies nothing; an unchanged value creates no history entry. Each native keyboard slider adjustment is an individual validated edit. Timeline/curve-keyframe gestures retain
their separate live-preview contracts.

Numeric fields keep a local text draft with full entered precision, independent of
the slider step. Enter or leaving the field applies one validated value; Escape
restores. Every field, slider and help button references one shared, hidden
description of its pattern rather than repeating those instructions per control.
Visible hints appear only where something is unavailable or overridden. Empty, nonfinite, fractional frame, range, duplicate keyframe and conflicting
timing inputs stay editable with inline errors.
Numbers are not coerced to zero/clamped/rounded to conceal an invalid edit. An
unchanged draft creates no undo step, and Enter then blur cannot submit it twice.

**Clip → Range** uses one full-original bar with hatched omitted footage
and draggable IN/OUT handles. Exact **Source IN / OUT** text fields below its ends
display **MM:SS:FF** (30 fps NDF) and accept whole original frames or timecode
on Enter/blur; invalid drafts remain editable with errors and Escape restores.
No duplicate section duration, original-length, source-frame or recoverable
head/tail labels accompany it; **Restore full recording** remains.
Fields and handles keep placement fixed and use ordinary source-range trim with
normal Ripple suffix sequencing, not the timeline left handle's retained-OUT rule.
Dragging previews the complete validated document without history/save; final
valid release is one Undo step. Invalid final release, Escape, cancellation, lost
capture or window blur restores, never commits an earlier valid draft. Handle
arrows move one original frame (Shift ten); Home on IN restores zero, End on OUT
restores the original exclusive OUT. Details: [Range](TIMELINE_EDITING.md#clip-range).

Other integer source/timeline frames, durations and fades retain exact native
`NumberField` steppers and timecode feedback, not arbitrary sliders. Source review
is independent: its numeric IN/OUT apply as one validated pair on Enter or when focus leaves both fields; Escape restores.

Project titles and track names follow the same draft/apply/cancel pattern; empty
names are invalid. Track rename lives in **Track options**, accepts 1–100 trimmed
characters, and commits as one undoable operation.
Mode/select controls and per-control colour resets apply directly;
animated channels without an enabled setting at the playhead are read-only until captured.

### Section keyframe controls

Colour, Speed and Transform always show their capture diamonds while the section is expanded, Colour and Transform with adjacent per-setting **Previous/Next** buttons; there is no Animate toggle and no stored preference. Each expanded section has one keyframe line with the **number of keyframes**, one **Previous/Next** pair over the same set and **Reset**. The line is hidden while the section is collapsed; the title row and its help stay reachable. Rendering, retained keyframes and read-only constraints never depend on what is shown.

Main scalar Colour/Opacity diamonds retain adjacent per-setting
**Previous/Next** buttons because not every setting is enabled at every shared
keyframe. The keyframe line holds one Previous/Next pair: Colour visits the Opacity/twelve-scalar/HDR/Local contrast union;
Speed visits all retained custom speed source keyframes of the selected clip,
including off-trim keyframes and original exclusive OUT, previewing the nearest
mapped image through authoritative retiming. Speed has a single setting, so its
diamond has no second per-setting arrows. Transform visits all track Transform
keyframes, including those after the duration, with its own track-local cursor.
Speed keeps a clip-local stored-source cursor independent of
track inspection, allowing successive keyframes to be visited even when their
nearest first/last preview image is the same. Main capture always uses the real
displayed project/source frame, never an inspected stored time.

All track, Transform and custom clip-speed selectors visibly read
**Easing**, retaining contextual accessible names such as **Track keyframe easing N**,
and unchanged interpolation.

### Clip speed

**Clip → Speed** is clip-owned: **Speed mode** (**Constant speed / Custom curve**),
constant 0.25×–4× presets and the **Speed ×** row. Its **Keyframe Speed** circle
captures or removes a Linear keyframe at the actually displayed source frame,
then preview follows the retimed keyframe; the rate is read-only in curve mode
without a keyframe there. Reset returns the clip to constant 1×. Curve presets
(including Ramp up/Ramp down) replace its keyframes. The native **Reverse** checkbox
plays the clip backwards with the same duration, in one Undo step. Details:
[speed and audio](SPEED_AND_AUDIO.md#editing-speed).

### Track Transform animation

**Track → Transform** is track-owned and works exactly like Colour, including on an empty
track, with its own project-frame keyframe list and timeline markers.
Its **Crop left / Crop right / Crop top / Crop bottom / Scale / Translate X /
Translate Y / Rotation °** sliders and exact fields edit the saved base without
keyframes. With keyframes, a keyed setting's main value requires that setting's keyframe at the
real playhead; otherwise it is read-only, while unkeyed settings still edit their base. Each setting has its own blue triangle (**Keyframe Scale**, etc.) and Previous/Next; a triangle explicitly
captures that setting's evaluated value; sliders never create keyframes.
**Add default Transform keyframe** adds or removes a default keyframe at the playhead.

At the end of the section, below the pose settings, a small **Keyframes** heading introduces
the Transform keyframe list (**Transform keyframes** plus the track name), shown only when
the track has Transform keyframes. It is the same shared list as Colour's. Each row has **Go to
Transform keyframe N** stretched over the row (a click anywhere outside its controls seeks the
nearest available frame), **Default** and **Outside duration** badges, a trash (**Delete
Transform keyframe N**), blue enabled-setting chips with per-setting Previous/Next arrows and an
**Edit** disclosure (closed initially) with **Timeline frame**, **Easing** and a slider/exact
field per enabled setting. Its **Easing** sets every enabled setting's Easing (**Mixed** when
they differ), with **Per setting** selects like a track keyframe's. The keyframe line's
**Previous/Next** pair, the rows and the chip arrows share a track-local cursor that advances
even when several previews coincide; the inspected row is marked current, and a key after the
duration gets the dashed **Stored keyframe** panel with **Follow playhead**.
List fields edit their stored keyframe, not the real-playhead pose.
Time/value edits do not seek automatically; navigation does not save.
This cursor is distinct from the shared Colour inspection cursor below.

Deleting the last keyframe reveals the unchanged base; **Reset transform** behaves like
Colour's Reset (neutral base without keyframes, else the enabled settings of the keyframe
at the playhead), in one Undo. Exact numeric
drafts and sliders follow the common apply/release/cancel rules above; collisions
and out-of-range values retain errors without clamping/merging.
Selecting another track refreshes context without applying the former draft.
There is no Transform canvas gizmo or graph drag. Exact neutral poses retain old
opaque black letterboxing; nonneutral uncovered pixels reveal lower tracks.
Full schema, geometry and animation details: [spatial transforms](design/SPATIAL_TRANSFORMS.md).

### Shared video track animation

The stored **Keyframes** list at the end of **Track → Colour** (fieldset accessible name
**Track keyframes** plus the track name) belongs to the selected **entire video track**, not
the selected clip. It remains available on an empty track and shows the enabled-setting chips
of the current or inspected keyframe; Colour's keyframe line counts and visits the same keyframes.
The question-mark **Animation help** beside its heading uses the common hover/pin/dismiss
contract above; explanatory text does not replace the shared keyframe editor.
**Clip** keeps source/clip settings and Speed controls; **Track → Colour**
keeps track Colour/Opacity playhead value/diamond controls and **Track → Transform** the pose.
All fifteen settings (Opacity, twelve scalar colour parameters, HDR and Local contrast)
expose a main diamond with adjacent per-setting **Previous/Next** buttons: **◇ hollow/inactive**
versus **◆ filled/active**, with `aria-pressed`. A hollow diamond remains clickable; inactivity
does not set HTML `disabled`. Actual invalid/draft states can disable actions.

Per-channel native **Previous/Next** arrows remain beside main diamonds and on enabled setting chips in stored Colour keyframe rows. They are
disabled without the corresponding neighbour, an opened project, or during any
document-preview draft. They visit strictly
earlier/later keyframes where that setting is not `null`, including zero, and skip
keyframes enabling only unrelated channels. Main and stored Opacity arrows visit keyframes with
`opacity` enabled; Colour's keyframe line visits the colour/Opacity union.
No opacity diamond/buttons are duplicated in the sidebar.
Navigation preserves the chosen Properties tab and the activated button's focus,
rather than forcing Clip;
it never saves or creates an Undo step.

Clicking joins/leaves **only that setting** at the current absolute project frame.
The first enabled setting creates the shared keyframe, the last removal deletes it, and
other enabled settings and their Easing are preserved; a joining setting takes the Easing
the keyframe's settings agree on, else Linear. A keyed channel's main slider/number
is read-only where that channel is absent, including keyframes belonging to other
channels, and is shown dimmed with a lock cue. Click its hollow diamond to capture the displayed value first; there are no slider-created
implicit keyframes. Without Opacity keyframes, the slider edits the track's saved `opacity`,
including on an empty track. Its `opacity` curve overrides that value across every
clip on the track, including both dissolve sources; removing the final keyed Opacity
setting reveals the unchanged track value. Unkeyed colour edits the track base,
including on empty tracks. Removing the final keyed colour setting reveals its unchanged
track base. Speed is clip-only and never a track setting.

The list has no outer disclosure or per-track list expansion preference. Each entry has a
timecode button (**Go to track keyframe N**) stretched over the entry, so a click anywhere
outside its controls selects it, **Default** and **Outside duration** badges where
they apply, a trash (**Delete track keyframe N**) and its enabled-setting chips;
its inner **Edit** disclosure (closed initially) provides
**Timeline frame**, **Easing** and values for the enabled settings.
A time edit moves all enabled settings
and their Easing together in **one Undo step**; colliding times/invalid
values are rejected without changing the committed document,
never merged or overwritten. Each enabled setting has its own Easing:
the **Easing** select sets them all (reading **Mixed** when they differ), and **Per setting**
reveals one select per setting; each change is one Undo step. Each channel
interpolates toward its own **next keyframe with that setting enabled**, with
endpoint holds and unkeyed values only for entirely unanimated channels: track
`opacity` for Opacity, track `colour` for colour. Keyframe
input identity/focus and drafts survive time reordering and Undo;
no persisted keyframe IDs are added.

Stored keyed colour/opacity settings reuse the main sliders and double-click-the-name
resets, with one exact `NumberField` to the right of each slider; Opacity uses
**0–100%**, neutral **100%**, while stored values remain **0–1**.
The local-draft/release-only slider contract above
applies to all stored keyed settings too. Each accepted value or reset targets only
that existing stored keyed setting in one Undo step;
keyframe time, every Easing, other enabled settings, track `opacity` and clip settings stay unchanged.
There is no implicit joining. Numeric drafts retain entered precision and apply
on Enter/blur; Escape restores. Empty, nonfinite or out-of-range
values retain inline errors without clamping.

Keyframes outside current duration remain stored/list-editable. A central editor-only
inspection cursor is shared by main per-setting arrows, stored-setting chip arrows,
section navigation to track keyframes, shared marker and list navigation, advancing through several
off-duration keyframes even when their previews clamp to the same last
available frame. Labels identify stored time separately from actual preview; a
timeline without video or music duration has no preview frame; music-only regions
preview black at their real project frame. List controls edit their stored keyframe,
but the main setting values, diamond state and capture **still use the real playhead**.
Manual seek (including the same clamped frame), playback, track/project changes and
deletion of the inspected keyframe clear inspection. A valid single-keyframe move/Undo
preserves the cursor and input identity; **Follow playhead** ends inspection explicitly.

One marker per stored track keyframe lists enabled settings in its title; keyframes after the
last clip keep their markers there without extending playback. **Horizontal
marker dragging** captures the project/track/keyframe, zoom, grabbed pointer position,
scroll and stationary playhead. Capture-relative travel is rounded once and bounded
to frames 0–2,147,483,647. Valid drafts preview live but never enter autosave/history;
valid release moves all enabled settings/values/easing in one Undo step. Snap uses
captured clip/music/transition boundaries and playhead within eight pixels; Alt
bypasses it. Horizontal autoscroll retains the captured geometry, with no track move
or automatic track reveal.

An occupied time shows a red
invalid ghost. Release reports the error without merging, overwriting
or committing an earlier valid draft. Escape, pointer cancellation,
unexpected capture loss or window blur restores preview/document/scroll without a
draft save. A keyframe may move beyond duration without extending the sequence merely
to display it; moving it never retimes a clip. Other keyframes, source ranges,
clip settings and music are not copied or shifted. The shared time field remains
an exact alternative, with the same atomic move validation.

Colour **Reset** on an animated track
changes only enabled colour values at the current keyframe; double-clicking a setting's
name resets only that setting, including unanimated track colour bases. Stored-keyframe resets in Colour's keyframe list target that
keyframe's existing enabled setting, not a different value at the playhead.
Trim/move/split/duplicate do not copy or shift track keyframes. The contract is in
[LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

### Clip speed-keyframe lanes and track Transform markers

Inside each timeline clip rectangle, a boxed salmon
**●** custom-speed lane shows source keyframes at authoritative retimed output
positions. Off-trim keyframes are omitted; exclusive
OUT has a boundary marker that seeks the final available frame. Click, Enter or Space selects the clip,
seeks its nearest mapped image and opens Clip → Speed; a click edits nothing. They also slide by drag or ←/→ (one original source frame, Shift ten), keeping easing: drafts preview only, a valid release is one Undo step, and Escape, cancellation, blur or an occupied frame restores. Moving a speed keyframe retimes its clip, so its duration and Ripple suffix can change; timing conflicts reject the release.
Marker keyboard events are isolated from timeline shortcuts. Speed stored-source
inspection remains separate, reaches all retained off-trim/original-OUT keyframes
and never supplies a fake frame for main capture.

Track Transform keyframes are boxed blue **▼** markers at the top of their track row,
at project frames; they select, seek, open Track → Transform and slide like Colour markers.

## Source review and import

**Import** (Media panel header, empty Media panel or empty preview) and **Audio →
Music → Import music** open one native **Import media** modal, a service-side browser
laid out like a desktop file dialog: approved **Locations** on the left (unavailable
ones disabled with their error), then Up, a clickable breadcrumb and Refresh, an
**All / Video / Music** filter (Import music opens on Music) and a filter field above
one folder's folders and recordings with type and size. Checkboxes select MP4/MOV/M4V
and music recordings, including Shift ranges and a header select-all; selection
survives folder and filter changes and clears when the location changes. The footer
summarises the selection beside **Cancel** and **Import N**; double-clicking a
recording imports just that one. The dialog reopens on the last folder (a browser
preference). Browsing/selection alone starts no work: one-folder metadata reads do
not probe, register, write next to originals or queue preparation. Each video row
shows a small preview of the keyframe nearest the recording's middle once it scrolls
into view, behind a fixed 16:9 placeholder; an undecodable file gets an explicit
crossed-eye placeholder with its reason. Previews are bounded, cancellable,
read-only and cached in the data directory
([details](TIMELINE_EDITING.md#importing-recordings-from-the-filesystem)). Folders are first with
natural-name sorting; the 2,000-entry limit per kind has explicit guidance to choose a
narrower folder. The cache branch is excluded and symlink/path checks remain enforced.

`PASCAP_MEDIA_ROOTS` accepts a JSON array of at most 32 unique absolute paths;
the default is the service user's `~/Videos`, and `[]` disables both footage and music browsing.
Missing/unreadable roots stay visible as unavailable, not a service-startup failure.
Selected-path requests accept at most 5,000 video paths inside approved roots.
Read-only fingerprint/probe checks and the existing queue report accepted/rejected
sources and queue errors; ready/in-flight preparation is reused.

**Import** registers the selected video recordings as one root-scoped batch, then each
music recording serially. Cancel/Escape and duplicate submissions are blocked while
registration and the project-bin update are processing. A complete import adds
membership to the importing project, without selecting music or changing placement,
and closes the modal, restoring focus to its trigger. Otherwise a report lists what
was not imported or queued, rejected or failed recordings stay selected and the actual
error stays visible, with guidance to check Activity/project state before repeating;
there is no automatic write retry. Late folder reads are aborted on navigation/dismissal.
**Other location** (below the locations) imports a typed path, including outside
browser roots: a music or video recording, or a folder as an explicit **recursive
whole-folder import** that can queue substantial work. It never silently extends root
configuration. No original is
copied: the strict current schema references registered originals in place, with only
generated proxies/thumbnails, metadata, exports/receipts and scratch written locally.

There is no upload endpoint, browser file picker, optional copy flow or true
external desktop file/folder drag-and-drop import. External drops prevent navigation
and show Import guidance **without a POST**; a browser drop is not a trusted original
filesystem path. Internal dragging of ready Media into Timeline is preserved.
No hidden write retry or original overwrite occurs; accepted registrations remain
kept if a later source or queue admission fails.

Hover X maps a prepared recording's review button across its complete source.
Source preview has its own one-decoder WebCodecs proxy worker drawing exact decoded
frames, with buffering/error/retry state and release on close/hidden/offscreen/project change.
It never moves the project playhead or prepares/plays an original implicitly.

A round native **Play / Pause** button sits at the left of the source range strip below
the image, the same transport bar as the range. Play uses the applied IN/OUT, not numeric
drafts, starting at the displayed frame if inside and before OUT − 1, otherwise IN.
It stops on OUT − 1, without looping or audio; a one-frame range only
displays that frame. Scrub/trim/mark/numeric range edits pause first. Pending play cannot
restart after cancellation, a source/project switch, close, hidden viewer or tab
switch; a frame missing for five seconds is an explicit failure with Retry.
The track shows the five prepared snapshots across the whole original (or an
explicit **Snapshots unavailable** state, never a preparation job), hatched omitted
footage and timeline-style IN/OUT handles with 24 px pointer targets; the rest of
the track scrubs. Drag feedback overlays the image. Escape, capture loss, pointer
cancellation and window blur restore a trim draft and its prior source frame.
This source-only playback adds no timeline/music seek, history/save, decoder,
original access or implicit preparation.

Click/focus chooses a prepared source. Hovering another recording card previews it;
leaving that card returns to the chosen source at its last frame (without a chosen
source, the last hovered frame stays). IN/OUT handles/numeric fields/I/O marks stay recoverable; Home/End
on a handle restores that edge, and **Reset source range** (the reset icon after OUT) restores the
whole recording. There are no Mark IN/OUT buttons and no
static selected/omitted-frame summary: the strip and exact fields show the range,
while inline text appears only for drag hints and invalid numeric drafts; Escape
restores unapplied numeric drafts.
Applied choices are per-project browser-local state; unavailable storage leaves
valid choices usable for the current session with a warning. All insertion paths
copy the latest applied range and create independent clip instances. Changing a
choice never alters existing clips. **Add clip** leaves the same source chosen
and open, at the same range/frame, with **Clip added · mark another range** feedback
only after a successful insertion.
The sticky source header keeps **Add clip** and a compact clip-count popup (beside the recording name) reachable
even when range fields need scrolling on a short screen. The native nonmodal list
does not resize the preview; Escape closes only the popup and outside-click **Add clip**
leaves focus on that action. The list shows original IN/OUT and track names;
**Show** selects/seeks/reveals a chosen clip. The recording's library badge counts
its independent clips. Failed **Add clip** retains source/range/frame without stale success.
Other insertion paths, explicit Show, timeline selection and edits return to Timeline;
Source remains available through its tab. Changing recordings leaves exactly one
range editor/decoder, without stale duplicate controls.

Dragging on the time ruler selects a project-frame range (OUT exclusive); with a
clip selected, the orange **Delete selected range** trash removes the part of that clip it covers in one Undo
step, retaining independent left/right clips where needed. Without a clip,
or with a range outside the clip, it is disabled with the reason; without a range, Delete removes the clip.
**Split** selects the new right piece; **Q/W** keep the displayed frame while
shrinking the head/tail. The range is temporary, kept across clip selection and
cleared by a ruler click, Escape, timing/history/project changes, never a project/autosave field.
Ripple-on edits close gaps/re-sequence later clips on that track from its first
anchor; off keeps other clips at independent starts. Left handle/keyboard trims
keep the sequence start while on, retain timeline OUT while off, and reject an
unrepresentable integer-frame OUT. **Clip → Range** fields/bar/**Restore full
recording** instead keep the start in either mode with ordinary source-range trim
and normal Ripple suffix sequencing. Music, other tracks and shared track keyframes keep their absolute project times. Invalid
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
arrays empty and never inherit all globally registered recordings/music. Deliberately
importing an already registered source into another project adds membership while
reusing eligible prepared assets, without changing originals.

**Remove from project** is a trash on each Media card and music file (shown on
hover, focus or selection) and on the selection header for selected recordings.
An unused recording leaves at once;
one still used by clips or music tracks opens a confirmation naming their
counts, and confirming removes membership and placements atomically. Either is
one Undo step. Removal releases a source review of that recording and keeps focus
in the Media list. Originals, registry entries,
proxies/thumbnails/PCM caches, other projects and exports are never touched.
The Audio tab has no project-level removal.

Reimport/concurrent additions reuse ready proxies or pending/active preparation;
they do not encode the same source twice. Registration remains kept when queue
admission fails. Failed/cancelled/interrupted jobs are not retried automatically;
the recording card's **Prepare** action is explicit. Single/batch preparation also remains for
older registered media, with confirmation for a manual multi-recording batch.
Startup, library reads and hovering never queue existing unprepared sources.
Rejected import items are not fabricated as successes, and uncertain write results
must be checked before submitting the import again.

Music reimport reuses an entry only for the same absolute path and unchanged source
identity. Deliberately importing a moved file or another hard-linked location
creates a new music entry and verifies the selected path, not a missing old one.
The new entry prepares its own PCM cache; the old entry, its project references and
caches remain unchanged. Add the new entry separately to place music. To keep the
existing entry, its music tracks and cache, use **Relink** instead.

### Independent music tracks

**Audio → Music → Music track** selects one of up to eight identified music tracks,
with its trash **Delete selected music track** beside it. **Recording** changes
the selected music track's ready source. **Add music track** is the only creation
path: it lists ready music files and creates an independent music track, including
reuse of the same original; dragging a ready file from Media → Music onto the
music lane does the same at the drop frame.
Import merely adds bin membership/preparation and never implicitly places music.
Selection is editor-only: no seek requirement, history entry or save. Editing,
changing Recording or removal leaves the other music tracks, video tracks, track keyframes and
bin membership untouched; Undo restores a removed music track, not deleted media.

Each music track has its own source IN/OUT, start/duration, gain, fades and selected-range
loop. Mounted controls retain independent drafts across tab/section hiding and
track selection; a former music track's draft cannot apply to a new selection.
Numeric Enter/blur and completed placement/trim/gain gestures commit once, with
one Undo step. Invalid edits remain editable/reject atomically, never clamp,
shorten another music track, merge or save a pointer draft. Escape, cancellation,
unexpected capture loss or window blur restores a gesture's starting state.

Project duration is **max(all retimed video OUTs, every music start + duration)**,
including hidden video placements. Music can extend it. A video track's closing fade
ends at its own last clip OUT; afterwards absent active video is opaque black,
never a frozen last image, while music continues and fades at its own OUT.
Music-only preview is naturally black; export still requires a retained video clip.
All music contributions sum after their per-track gain/fades and hard-clamp
to [−1, 1] once after all sources. No normalisation, ducking, effects or video audio.
See [MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md) for strict fields, bounds and pending acceptance.

## Projects, service connection and errors

Projects are searchable by title/ID with compatibility filtering and recent ordering.
Unsupported/invalid documents retain their reason and remain unchanged. The current
project is identified; per-action pending state prevents double submission. Errors
stay inside the dialog, preserve typed titles/quality choices and never close it
as a false success. Closing restores keyboard focus to the origin, including when
the dialog was loaded asynchronously while its trigger was disabled.

**Save file** on a project writes its saved document, after flushing the current
project's autosave, to `<title>.pascap.json`: through the browser's save dialog where
available (Chrome), else as a download; cancelling the dialog does nothing.
**Open project file…** reads such a file (at most 16 MiB) and creates a **new**
project from it with a fresh ID, upgrading an older supported schema; it never
overwrites an existing project. The service validates it like a save: its
recordings and music must be registered here with unchanged originals and valid
ranges, otherwise nothing is created and the error stays in the dialog.

**Delete project** requires explicit confirmation and removes only the selected
saved document. It never deletes original recordings, shared registry entries,
proxies/cache files, successful MP4s or receipts. This is not cache garbage
collection; another project's membership and immutable export snapshots are unaffected.

Only strict current-schema projects and project snapshots in version-1 export receipts are interpreted.
Every video track requires complete Colour, including `temperature`, `tint`, `vibrance`, `whites`, `blacks`, `hdr` and `localContrast` bases
and static HSL/curves; missing fields and clip colour/correction are invalid.
Every clip requires constant or 1–256-keyframe custom-curve speed and a boolean `reverse`; every video track
requires complete Transform base/per-setting project-frame keyframes with easing and
`reset`; saved `clip.spatial` or missing track Transform is invalid, not default-filled.
The required `music` array holds 0–8 music tracks with unique required `id` values and
complete per-track source/timing/gain/fades/loop fields; `[]` means no music,
never null, a singular object or a missing-field default. Receipts require
`musicSources` captured unique-original and `settings.audio` instance-plan arrays,
both `[]` without music. Invalid arrays and older snapshots are rejected explicitly;
their receipts and successful MP4s remain untouched.
Both `media` arrays are required, unique and limited to 10,000 IDs each; missing
membership is an invalid document, not an invitation to expose the global library.
Every video track requires `ripple`, `transitions`, `openingFade` and `closingFade`;
project-level transitions/fades and a mandatory first-track identity are absent.
Every video track also requires numeric `opacity` in 0–1. A new track starts at 1 (100%);
a missing saved value is invalid, not default-filled. Every keyframe requires exactly
fifteen nullable fields, in control order: `opacity`, `temperature`,
`tint`, `exposure`, `brightness`, `contrast`, `hue`, `saturation`, `vibrance`, `highlights`,
`shadows`, `whites`, `blacks`, `hdr`, `localContrast`. HSL/curves remain static. Track
`opacity` is the sole valid stored value; saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` channels are invalid, not ignored or defaulted.
Projects/receipt snapshots saved with an older supported schema are upgraded in memory
on load; the first save keeps the original file as `<id>.json.schema-N.bak`. Those
older than the oldest supported schema, or saved by a newer PasCap, are preserved,
incompatible and never rewritten with fallback/default local fields; there is no
automatic deletion of
projects, receipts or finished videos. Proxy/current PCM formats are unchanged; the
registries are version 2 (`videos.json`, `music.json`, with full-content checksums).
Registered recordings and currently
verified ready proxies are reusable.
The live sample appearing incompatible is expected. No sample preparation or
additional real-media import/render is needed to exercise this with disposable tests.

Startup validates the loopback service with at most five serial, abortable health
GETs and bounded backoff/deadlines (at most 32.5 s for health attempts). It does not
retry writes. An empty workspace presents Projects instead of silently creating a
project. Missing/incompatible URL targets do not open a different project without
explanation. A service failure exposes **Retry connecting**; a preview failure
exposes **Retry preview**, preserving the document and timeline position.

Playback presents only exact decoded source frames for the clock frame
([WebCodecs preview decoding](design/WEBCODECS_PREVIEW.md)). When a required frame
is late, the previous image stays on screen and the status shows buffering: without
music the clock waits, with music it continues and late frames are skipped. A frame
still missing after five seconds stops playback with an explicit decoder error;
failed music synchronization restarts music. A draw that outlasts a frame on a slow
renderer reports **Catching up with the clock** rather than Playing. Renderer throughput can still
interrupt playback; this is not gapless audio or intended-GPU/long-run qualification.

When exact decoded sources and every evaluated composition value are unchanged,
a held slow-motion image reuses the intact presented surface instead of repeating
the same GPU grade. Source, colour, spatial pose, opacity, fade, dissolve, canvas size,
Original or a cleared surface changes the identity and requires a new draw.
Diagnostic pixel capture always redraws first: WebGL may discard its non-preserved
drawing buffer after presenting the intact image. No extra image buffer or longer
audio queue is introduced. Crossing into an empty composition advances to black
or completion.

Music uses **one AudioContext/worklet/output clock** with an aggregate **four ×
128 KiB mixed Float32 blocks**, serial source reads, shared **64 KiB range scratch**,
one **128 KiB conversion workspace** and one **128 KiB mixed-output workspace**.
Those reads and refills run in one dedicated reader worker, not on the editor thread.
No per-track queue/clock, full-file or duration-sized silence buffer is added.
The actual rendered mixed origin/output timestamp
governs A/V playback; block-updated media-element time does not trigger false
restarts. Selected-range loops are filled continuously, while true empty-queue,
processor/read failures and the unchanged one-project-frame A/V bound remain
explicit. A missing active source is not silently omitted or replaced by successful
silence. Pause/seek/edit/cancellation invalidates the complete mix epoch and
outstanding reads before late work can restart.
Missing current PCM caches appear as **Prepare** actions on the files in Media → Music;
no read automatically prepares, rewrites or removes older AAC caches. Explicit
preparation creates the current versioned PCM cache without changing originals,
project documents, video-proxy formats or finished exports.

Read and response decoding have deadlines; incompatible/HTML responses are errors,
not defaults. If a write transport times out, its result may be uncertain: check
current project/job state before repeating it. Accepted job/create/export responses
are not reclassified as failures merely because a following status GET fails.

## Source availability and persistent storage

Originals must remain readable at their registered absolute service-side paths.
Moving recordings or disconnecting a drive causes explicit identity/missing-source
errors, even with a ready proxy. The editor does not guess another path, silently
reassociate a source or bypass fingerprints. Media marks such recordings **Original
missing**; **Relink** opens the Import media dialog for the moved copy, and a serial
Activity job accepts it only if every byte matches, keeping the ID, caches, clips and
music tracks ([relinking](design/SOURCE_RELINK.md)). When a whole folder moved,
**Relink folder…** above the Media list (or **Search this folder** in the dialog)
relinks every missing recording found in the chosen folder and its subfolders in one
job. Recordings never prepared cannot
be relinked and must be imported again.
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
saves. Only a valid committed keyframe move enters history/autosave; cancellation or
invalid release leaves the saved document and history unchanged.

For an HTTP 409 or incompatible save response, **Review latest save** explains:

1. **Keep editing this draft** — no saved document changes; the save error persists.
2. **Download unsaved project** — download a strict current-schema JSON snapshot with the current
   local changes/expected revision before replacing them.
3. **Discard local changes and reload** — explicitly replace local history/document
   with a newly read saved version. It performs no overwrite POST/PUT.

The snapshot can be opened later with **Open project file…**, as a new project.
Switching projects or exporting is blocked while autosave remains dirty.
Reload/discard never happens just because the service reports a conflict. Browser
navigation warns about committed unsaved changes and dirty UI fields/pointer drafts.
A forced browser or laptop shutdown can still lose in-memory unsaved changes:
download a copy or wait for **Saved locally** before closing. No crash-proof local
draft database or interrupted-render resume is claimed.

## Activity and exports

Activity is a nonmodal drawer, with running first, then queued jobs in the order they
will run (FIFO, with camera motion analyses after the others), then history by
completion date. It includes video/audio preparation, reference renders, exports,
failures and cancellations. Progress is numeric/bar-based; settled outcomes are
announced without reading every progress poll aloud. A **running export** also shows
a coarse **time remaining** line (for example "about 5 min left") below its bar, or
"Estimating time left…" until at least 15 s and 2 % of progress have been observed.
It extrapolates the average progress rate observed in this browser over the last two
minutes, so it adapts when a phase is faster or slower and lengthens during a plateau;
it is an estimate, not a guarantee. Queued, cancelling and settled jobs and
preparation jobs show none, and the line is plain text, not a live region. Escape closes
a focused drawer and returns focus to Activity, without pausing the editor or native job.

Export shows the project title, contextual duration and quality up front, then an
**Output name** field (default project title + quality, validated as 1–100
characters without slashes/control characters; Enter starts the export). Its
Rendering details hold the fixed snapshot with counts of clips/video tracks (enabled),
track keyframes and animated settings, and all independent music tracks. A keyframe
with several channels counts once, not as separate clip/channel keyframes. Both 720p/4K
use originals. The static fast path requires neutral HSL/identity colour curves and one enabled, unanimated,
zero-origin contiguous video track with Opacity 1 and Shadows/Highlights/HDR/Local contrast 0, an exactly neutral Transform base
and no Transform keyframes; any Transform edit/keyframe (even neutral keyframes), clip detail filter, nonzero HDR or Local contrast, track keyframe, leading start,
gap, unsupported coverage or music beyond video OUT uses generalized composited
export. Static video must cover full project duration; composited export fills music
tails with black rather than holding a last image. That path renders
premultiplied RGBA16 groups, with $C = \sum_i G_i b_i o_i w_i m_i$ and
$A = \sum_i o_i w_i m_i$, then source-overs as
$\mathrm{result} = C + \mathrm{lower}(1 - A)$ without regrading or a track multiplier.
Here $G_i$ is graded RGB, $b_i$ black-fade brightness, $o_i$ the track's evaluated
Opacity for each source, $w_i$ dissolve weight and $m_i$ per-pixel spatial coverage.
Nonneutral uncovered pixels reveal lower tracks; exact neutral poses retain
opaque black letterboxing after grading. Both dissolve sources use the
same track value or overriding `opacity` curve at that project frame, with no second
group multiplier. Black fades change $b_i$, not coverage.
Preview uses two decoders per track (16 maximum) plus one source-review decoder.
Native limits are four
raw buffers/22 bytes per pixel, two LUTs, three timeline representations and two
retained clip files, with serial one-original/two-intermediate/one-encoder passes
and at most three native video children. Audio separately decodes one original at
a time to selected s16 PCM, then sums serially through Float64 accumulators with
at most two intermediate audio inputs, one audio child per pass and three scratch
audio files (selected source + old/new accumulators). One final mixed input clamps
once before AAC. Audio planning is maximum selected PCM + two full-project Float64
stereo timelines, duration-dependent and additional to video. Exact byte bounds are in
[the resource contract](LAYERS_AND_KEYFRAMES.md#properties-panel-and-resource-limits). Export
shows one line of free space on its output/scratch volume; **Storage details** holds
the explicitly advisory planning
allowance, not a compressed-size guarantee or time estimate. Low space/mount
errors have recheck/recovery actions; genuine ENOSPC cleans only the failed job,
preserving originals, saved edits and completed outputs. Storage and Rendering
details remain disclosed. Accepted submission opens Activity and later editing
cannot change its snapshot. See [UX_HARDENING.md](UX_HARDENING.md) for storage
assumptions, measurement procedures and the private constrained-volume test.

Preview/Properties loading is deferred without changing per-frame ownership.
Module-load failures keep the editor available and offer **Reload editor**, which
first flushes pending committed edits, plus **Download project**. A save failure
prevents reload and retains the draft; browsers cache failed imports, so this is
not a misleading same-module Retry. Runtime preview errors still use Retry preview.

Cancellation is one request per job until confirmed. **Cancelling…** means accepted,
not finished; actual cancelled/failed/completed state controls output links. Queued
jobs are cancellable. Failed status reads preserve the last-known jobs and show a
read-only Refresh action. Polling is serial/cancellable; it never automatically
resubmits a job. The Activity status strip shows only the running count and latest
outcome; each finished render's Open/Download/Receipt links live with its job in the
Activity drawer (and the Export dialog's completed exports).

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
