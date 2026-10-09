# Video tracks, shared keyframes and source review · project v13

Required video track Colour includes nine scalar fields, including **Temperature** and
**Tint**, plus static **HSL ranges** and **Colour curves**. Temperature/Tint use
−1…1, neutral 0; positive values warm/add magenta respectively and intentionally
colour greys. Their normalized linear gains run before Exposure. See
[Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
Eight named HSL bands and four encoded curves stay active when scalar channels
are animated, without adding keyframe channels or clip fields. Band/all-HSL and
channel/all-curves resets preserve the nine scalar bases, track keyframes and Opacity;
Reset on an animated track preserves advanced settings. Unanimated Reset restores complete track
Colour and Opacity. See [the advanced-colour contract](design/HSL_AND_CURVES.md).

## Video tracks

The document stores one to eight uniform video tracks **bottom-to-top for
composition**. Timeline/sidebar tracks use that same array order: track 1 renders below
track 2, track 3 above track 2, and so on. Raise/Lower change composition priority, not
an editing role. The initial Video track 1 identity is conventional, not mandatory or
privileged. Every track can be reordered or deleted, except the last remaining
track; only actual top/bottom stack endpoints restrict Raise/Lower.

Every `VideoLayer` requires `ripple`, `transitions`, `openingFade`, `closingFade`
and numeric `opacity` in 0–1. New tracks start with **Ripple on**, empty transitions,
zero fades and **Opacity 1 (100%)**; missing fields are invalid, not default-filled.
In **Track options**, enabling Ripple packs clips in chronological order from the
first clip's current project-frame start, closing gaps in **one Undo step** and retaining valid
existing dissolves. While on, saved clip order continuously sequences from that
anchor: each next start is the preceding OUT minus any incoming dissolve duration.
Each clip keeps its own duration wherever it sits, and commands persist actual
integer starts. Structural edits preserve the track's pre-edit first start even
when its first clip changes. Turning Ripple off captures actual placements;
future edits keep other clips at their independent starts. Neither switch moves
music, other tracks or absolute track keyframes.

The Timeline start field and nudge controls work on any positioned clip, or the
**first anchor only** while Ripple is on. Later Ripple starts expose an accessible
reason: drag to reorder, or turn Ripple off for independent placement. Ripple is
not a future-edits-only policy that preserves gaps while enabled.

With Ripple off, gaps reveal lower footage/black. Edits do not move unrelated
clips; invalid overlap is rejected atomically. Left-edge handle/keyboard trims
move the start to retain timeline OUT; restoring IN stops where the start would
precede frame 0. With Ripple on, these trims keep the sequence start and recompile the
suffix. Right timeline trims and **Clip → Range** fields/bar/**Restore full recording**
keep the selected start in either mode; the inspector uses ordinary source-range
trim, not the timeline left handle's retained-OUT rule. Source-frame speed anchors
remain independent. See [the Range controls](TIMELINE_EDITING.md#clip-inspector-range).

A cross-dissolve explicitly places the right clip at the
left OUT minus its duration; changing/removing it adjusts that overlap. With Ripple
off, only the right clip moves; conflicts reject the whole edit. Exact adjacent
dissolve overlap is the only allowed same-track overlap; triple overlap is invalid.
Opening/closing fades belong to the track's first/last clips at actual placements,
fit with other transition regions and remain stored but dormant on an empty track.

Project duration is the maximum of all retimed clip OUTs (including hidden tracks)
and every music start + duration. Music can extend it. Closing fades end at their
last video clip OUTs, not at music/project OUT; no active video means opaque black
while music continues/fades at its own end, never a frozen last image. Music-only
preview is black; export still requires at least one retained video clip.

**+ Video track** creates/selects a track. Sidebar controls select and hide/show;
**Track options** contains only rename, Ripple, raise/lower and delete. Track
names apply on Enter/blur, Escape restores, and a rename is one Undo step. Selecting
an empty video track retains both its **Track** context (Colour, Opacity, keyframes) and the target for Media
**+**/double-click insertion. A populated track selects its first clip and
reveals its track without changing placement. Selecting a clip or populated/empty
track preserves the chosen Inspector tab and safely refreshes its editing context.
Media drops target the track under the pointer: Ripple-on drops choose a sequence
insertion slot; Ripple-off drops use
independent project-frame placement.
Scroll over either the headers or tracks to reach all eight video tracks and music; native
vertical scrollbars and keyboard focus reveal stay synchronized. Horizontal timeline
scroll is independent and scrolling never changes the project or playhead. The time
ruler stays pinned above the tracks, with horizontally aligned ticks and a visible
playhead handle (timecode only during drafts; the preview transport shows it otherwise);
click/drag seeking uses the same integer-frame geometry.
Dropping on the ruler never targets a track concealed underneath it.
Unavailable Raise/Lower/Delete actions have contextual accessible reasons for the
actual stack endpoint, last remaining track or active interaction state.
Drag existing clips between video tracks, or use Clip → Placement. Deleting a track
and its clips is one undoable command. Existing moves preserve the grabbed offset
and show the actual final placement ghost with the clip's own unchanged duration;
red invalid placements are not committed. Ripple-on tracks remain sequenced
even with snapping disabled. Start/nudge and duplication retain timing
validation and source-frame speed anchors; they never copy track keyframes.

Visibility and Opacity are renderable state, not preview-only switches.
Disabled video tracks do not decode/draw, but their placements still contribute to total
duration; an entirely hidden tail therefore exports black. **Opacity** is one
track-owned setting, stored only as required `VideoLayer.opacity`, not on a clip.
With no keyed Opacity settings, every source uses the track's saved value. The sole
track keyframe channel, `opacity`, overrides that value on **every** clip in the track,
including both dissolve sources. There is no saved `clip.opacity`, separate
group-opacity channel or additional track multiplier. Black
transitions/fades darken only their track's RGB without removing its alpha coverage;
they do not dim another track or reveal lower footage through a transparency fade.

## Strict shared-keyframe model

**A video track owns shared animation, not a clip.** Clip speed curves and
[spatial transforms](design/SPATIAL_TRANSFORMS.md) instead have their own
original-source keyframes. All shared track keyframes use absolute integer
**project timeline frames**, with one keyframe per frame per track. They affect every
clip on that track, including clips from different recordings and both sources
in that track's dissolve. They do not restart at a clip's IN, start or boundary.

Schema 13 requires `layers[].keyframes` as ordered `{ frame, interpolation, values }`
keyframes, with **at most 256 keyframes per track**. Frames are unique, strictly ascending,
non-negative and at most 2,147,483,647. Every keyframe's `values` object (`LayerKeyValues`)
requires **all ten nullable fields** below: a number enables that setting; `null` leaves it disabled. Omitted/unknown
fields and all-null keyframes are invalid, not repaired with defaults.

| Channel                     | Value          | Value when this channel has no track keyframes            |
| --------------------------- | -------------- | --------------------------------------------------------- |
| Opacity (`opacity`)         | 0–1            | The track's required `opacity`, initially 1 on new tracks |
| Temperature (`temperature`) | −1 to +1       | The track's saved colour value, initially 0               |
| Tint (`tint`)               | −1 to +1       | The track's saved colour value, initially 0               |
| Exposure (`exposure`)       | −3 to +3 stops | The track's saved colour value                            |
| Brightness (`brightness`)   | −0.5 to +0.5   | The track's saved colour value                            |
| Contrast (`contrast`)       | 0–2            | The track's saved colour value                            |
| Hue (`hue`)                 | −180° to +180° | The track's saved colour value                            |
| Saturation (`saturation`)   | 0–2            | The track's saved colour value                            |
| Highlights (`highlights`)   | −1 to +1       | The track's saved colour value                            |
| Shadows (`shadows`)         | −1 to +1       | The track's saved colour value                            |

The exact ten required value fields are `opacity`, `temperature`, `tint`, `exposure`,
`brightness`, `contrast`, `hue`, `saturation`, `highlights` and `shadows`; every
track channel is appearance-only and never changes timing.
Clip documents contain independent **constant or custom-keyframed**
speed and required `spatial: { base, keyframes }`, with no colour/correction or `opacity` field.
Shared track animation has no per-property track keyframe arrays. Clip speed and spatial
keyframes use original-source frames in their separate clip-owned settings; neither
changes track-channel ownership. Spatial keyframes enable each of the eight settings independently (nullable per setting), like track keyframes.
Trimming, restoring, moving, splitting and duplicating footage **never copy or
shift track keyframes or change track Colour/Opacity**. Split/duplicate create independent source
ranges, speed and deep-copied spatial settings, retaining original-source
clip-speed/spatial anchors, including off-trim and original exclusive-OUT keyframes.
A moved clip uses its destination track's saved Opacity or overriding curve and
animation; both tracks' values and keyframes stay where they were. Track Ripple also
leaves keyframes anchored in project time. Removing the last keyed setting of a channel
reveals its existing unkeyed value: track `opacity` for Opacity, track `colour` for colour.
There is no separate clip correction.

Keyframes beyond the current project duration remain stored and list-editable. They
are not constrained by any recording's length and are not discarded when footage
is shortened or removed. Retained keyframes still define channel curves; their absence
from the visible timeline is not a request to ignore them during evaluation.
Moving a keyframe beyond duration does **not** extend the sequence merely to display
it; track keyframes never change clip durations.

## Independent channel interpolation

Enabled settings are independent, including between the nine scalar colour parameters.
Each keyframe's easing is shared by its enabled settings, but **each channel interpolates
to its own next keyframe with that setting enabled**, skipping keyframes where that channel is null.
For example, Exposure at frames 10 and 30 interpolates across a Contrast-only keyframe
at frame 20; that middle keyframe does not interrupt Exposure's interval.

Before the first/after the last keyframe with that setting enabled, that channel holds its endpoint
value across the entire video track. A single keyed setting therefore overrides the
channel everywhere. A channel with no keyed settings uses the values above,
even if other channels on the track are animated.

For normalized interval progress $u$, the **left keyframe with that setting enabled** supplies:

| Easing   | Progress                                            |
| -------- | --------------------------------------------------- |
| Hold     | 0 until the next keyframe with that setting enabled |
| Linear   | $u$                                                 |
| Ease in  | $u^2$                                               |
| Ease out | $2u-u^2$                                            |
| Smooth   | $3u^2-2u^3$                                         |

Colour interpolates **parameter values**, then grades the sampled source RGB.
It does not blend separately graded endpoint pictures; hue interpolates numerically
in degrees. Grade and Opacity coverage use **project time**, so they can change on
consecutive output frames even when slow motion holds the same source frame.

Speed is not a track channel. Each clip's constant or custom-keyframed speed is
compiled into its own `PlacedClip.retiming`, used by layout, preview and native
export; see [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md) for its source-frame curves and
repeat/drop sampling without optical flow.

## Editing keyframes

Control names follow the [editor control vocabulary](design/EDITOR_CONTROLS.md#vocabulary).

The **Track → Keyframes** section (list accessible name **Track keyframes** plus
the track name) contains
**one directly visible whole-track keyframe list** for the selected video track, including an
empty track without a selected clip. It shows keyframe
count, whole-track Previous/Next navigation, **Animation help** and enabled-setting chips
for the current or inspected stored keyframe. The toolbar's Animation help includes
keyframe-timing guidance, with no separate Keyframe timing help button.
**Clip** keeps source/clip settings and Speed/Transform controls; **Track → Colour**
keeps track Colour/Opacity controls evaluated at the real playhead.

Colour, Speed and Transform always show their capture diamonds while the section is expanded, Colour and Transform with adjacent per-setting **Previous/Next** buttons; there is no Animate toggle and no stored preference. Each expanded section has one keyframe line with the **number of keyframes**, one **Previous/Next** pair over the same set and **Reset**. The line is hidden while the section is collapsed; the title row and its help stay reachable. Rendering, retained keyframes and read-only constraints never depend on what is shown. Track diamond states remain:

- **◇ Hollow**, `aria-pressed=false`: setting not enabled at this project frame.
  It is still clickable, **not HTML-disabled merely because it is inactive**.
- **◆ Filled**, `aria-pressed=true`: setting enabled at this frame. Clicking removes
  only that setting; other enabled settings and the keyframe's easing remain unchanged.
- The first enabled setting creates the track keyframe, capturing its displayed value.
  Enabling another setting at that frame joins the same keyframe. Removing the last
  enabled setting deletes the keyframe. Genuine invalid/draft interaction states can
  disable actions; hollow status itself cannot.

Each section's keyframe line has one native **Previous/Next** pair, beside the count of the keyframes it visits.
Colour visits the union of Opacity and nine scalar colour keyframes. Speed visits all
retained custom speed source keyframes of the selected clip, including off-trim
keyframes and the original exclusive OUT, previewing the nearest mapped image through
authoritative `PlacedClip.retiming`. Transform likewise visits all retained
source keyframes, including off-trim/original OUT. Speed and Transform
each use an independent clip-local stored-source cursor rather than the central
track cursor, advancing through successive stored keyframes even when their
nearest first/last preview image is the same. Stored source time remains distinct
from the actual displayed source frame; capture always uses the latter.

Per-channel native **Previous/Next** arrows remain beside each main Opacity and colour diamond, because not every setting is enabled at every shared keyframe.
Enabled setting chips in stored Keyframes rows retain their arrows too.
All these per-channel arrows visit **strictly earlier/later** keyframes where
`values[setting] !== null`; zero is an enabled value, and keyframes belonging only to
other channels are skipped. There is no wrap or revisit of the current keyframe.
The arrows are disabled when the relevant neighbour is absent, no project is open,
or any document-preview draft is active. Navigation preserves the
chosen Inspector tab and activated button's focus instead of forcing Clip, and
changes no document, history or autosave state.

**Track → Colour** contains the single **Opacity** native slider/exact
`NumberField` alongside the colour controls, with its diamond and adjacent
per-setting Previous/Next buttons.
Main and stored sliders/exact fields use **0–100%**, neutral **100%**.
Required track `opacity` and keyframe values stay **0–1**, with UI-only conversion and no schema change.
Without Opacity keyframes, either value control edits the selected track's `opacity`,
including on an empty track with no selected clip. Main and stored Opacity arrows visit
only keyframes with `opacity` enabled; the Colour header visits the colour/Opacity union.
**Clip → Placement** contains placement controls only. There is no duplicate
opacity control or navigation in Placement or the sidebar;
**Track options** is limited to rename, Ripple, ordering and deletion. Stored keyed Opacity
settings remain editable in the shared Keyframes list.
Unkeyed colour controls edit the selected track; sharing the Colour section
does not make Opacity per-clip or part of the SDR RGB grading transform. Opacity
controls composition coverage after grading.

Once a channel is animated anywhere on the video track, its main value control is
read-only at frames where that channel is not enabled, including at keyframes
belonging only to other settings. It is shown dimmed with a lock cue: **click its hollow diamond to capture a value before editing**.
Setting tooltips and screen-reader context say **Keyframe at playhead** for an
editable keyed setting, or **Animated · add a keyframe to edit** for a read-only
animated value. Track's Opacity and colour controls use the same
terms and explain which diamond adds a keyframe at the current timeline frame.
Sliders/numbers never implicitly create keyframes. Unanimated Opacity edits the track's
saved `opacity` and unanimated colour edits track `colour`.
On an empty track, Opacity and colour remain editable without keyframes and their
diamonds can create animation; Clip settings, including
Speed, need a selected clip.

In **Keyframes**, the shared list has no outer disclosure or per-track list expansion
preference. Its toolbar reads "N keyframes" and the section badge repeats the count;
the chips of a keyframe at the playhead follow an **At playhead:** caption. Each shared
keyframe entry lists its enabled settings and has an inner **Edit**
disclosure, open initially when the list has three or fewer keyframes. Its trash
deletes that keyframe; the toolbar has no second delete action.
Its Timeline frame field moves
**every enabled setting and the keyframe's existing easing together in one Undo step**;
the visibly labelled **Easing** affects all of them, each toward its own next
keyframe with that setting enabled. Its contextual accessible name remains
**Track keyframe easing N**, and interpolation is unchanged.
The native easing selector shows a compact graph of the selected progress shape:
time runs left to right and value progress bottom to top. Hold stays flat until
the exact next keyframe, then jumps. The graph adds no focus stop; its text description
is available with the selector. Native option hover does not preview an unselected shape.
The trash-icon delete action removes the whole keyframe; × only closes or dismisses.
Time/value fields apply on Enter/blur, Escape restores, and frame collisions/invalid
values/timing are rejected atomically,
never merged or overwritten. Reordering and Undo preserve drafts and field identity/focus
without adding persisted keyframe IDs; nested keyframe details remain collapsible.
This remains one list, not a new list per channel or marker.

Main and stored colour/Opacity controls share a native slider with one adjacent
exact `NumberField` as the value display, not a read-only output. Stored keyed settings
reuse the same bounds and double-click-the-name resets; Opacity numeric entry
uses **0–100%**, neutral **100%**, in both contexts. The channel table gives stored
bounds; only Opacity scales those values by 100 for the UI.

Dragging a Colour, Opacity or HSL slider (main or stored) previews the draft value in the image, coalesced to the display rate, without any document, history, autosave or Inspector change, and without restarting music. Release commits one validated edit and one Undo step. Escape, pointer cancellation, lost capture, window blur or an invalid value restores the control and the preview. Other sliders (Transform, speed, gain) keep their release-only image update. Each keyboard slider adjustment is an individual validated edit. The full value-control contract is in
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md#numbers-titles-and-animation).

Only existing non-null enabled settings get value editors. Each accepted value/reset
changes that keyed setting at its stored frame in **one Undo step**, without changing
keyframe time, shared easing, other enabled settings/keyframes, track `opacity` or clip settings,
and without requesting a seek. No slider, numeric edit or reset implicitly joins a channel.
Numeric drafts preserve entered precision; empty, nonfinite, out-of-bounds and
contextually invalid values remain editable with inline errors, never silently
clamped or rounded.

All stored keyframes, including those outside current duration or on an empty track,
remain editable in this list. Main per-setting arrows, stored-setting chip arrows,
section navigation to track keyframes, track Previous/Next, shared marker navigation and list time buttons
share **one editor-only stored-keyframe inspection cursor**.
Successive navigation advances from that stored time, so several off-duration
keyframes can be inspected even when every seek clamps to the same last preview frame.
The keyframe stays stored at its own time; without any video or music duration there
is no preview frame. A music-only region has a real project frame with a black picture.

Labels distinguish stored time from the actual preview/playhead. List fields target
their stored keyframe, while main setting values, diamond state and diamond capture
**always use the real playhead**, never a fictional off-duration editing frame. Manual seeks
(even to the same clamped frame), playback, track/project changes and deletion of the
inspected keyframe clear inspection. A still-valid single-keyframe move and Undo retain
the cursor and list input identity. **Follow playhead** explicitly ends inspection;
the cursor is not a saved project field or an Undo operation.

Speed is clip-only, in **Clip → Speed** (**Constant speed / Custom curve**, with
presets such as Ramp up); track keyframes never contain or override it. Colour
resets target only enabled colour values at the current keyframe; individual
resets can edit unanimated track-base channels. In Keyframes, each reset instead
targets its existing stored keyed setting, even when that keyframe is outside duration.

## Timeline markers and ruler

There is **one marker per stored track keyframe**, even across multiple clips or a
dissolve, not one marker per channel/clip. Its title names the video track, project time
and enabled settings; the panel exposes chips/dependencies. **Click or Enter** selects
the track, seeks and opens Track → Colour, without editing. Whole-track keyframe
navigation retains the chosen Inspector tab. Keyframes after the last clip keep their marker at
their own project time, like keyframes before the first clip. The scrollable timeline
widens to reach the last stored keyframe, but duration, playback and seeking still end
at the last project frame, determined by the maximum video/music OUT, not keyframes.
Selecting such a marker inspects that stored keyframe (preview
shows the nearest available frame), highlights it and changes nothing.
The shared Timeline frame field remains available.

**Drag the marker horizontally to move the whole keyframe:**

- Pointer capture snapshots the committed project, video track/keyframe, zoom, grabbed pointer
  position, horizontal scroll and stationary playhead. Movement uses that original
  geometry plus scroll travel, rounds the frame delta once and clamps the result
  to **0–2,147,483,647**; live retiming never becomes a new gesture origin.
- Each destination is validated against the captured project. The dragged marker
  shows its timecode above it (red when invalid). A valid draft updates
  geometry and paused preview, but does not alter the committed document, history
  or autosave. Release moves **all enabled settings with their values and easing intact**
  in one Undo step; an unchanged keyframe creates no history entry.
- Snap uses captured clip/music/transition boundaries and the captured playhead,
  within **eight pixels at the captured zoom**. Alt bypasses it. Horizontal edge
  autoscroll uses the same base geometry; neither track switching nor automatic track
  reveal relocates the gesture.
- Occupied frames produce a **red invalid ghost**, even when the other keyframe has
  unrelated channels. Keyframes are **never merged or overwritten**. Invalid release
  reports the reason and changes nothing; it cannot commit an earlier valid draft.
  Returning to a free valid frame permits committing that final destination.
- Escape, pointer cancellation, unexpected lost capture or window blur rolls back
  preview, document and horizontal scroll, with no draft save or history entry.

On a focused marker, **Left/Right** moves one project frame and **Shift+Left/Right**
moves ten, with the same atomic validation and no snapping. Focus and the inspected
keyframe cursor follow the move. Movement navigates to the keyframe without also firing
ordinary playhead-step or clip-nudge shortcuts, or leaking other editor shortcuts.
Dragging can reach beyond duration, but retaining that keyframe never extends the
sequence merely for its marker. No other track's keyframes/values, clip settings/source ranges or
music are copied or shifted, and no clip is retimed. There is no cross-track keyframe move.

### Clip source-keyframe lanes

Inside each clip rectangle, Transform keyframes use a boxed blue **▼** button lane and
custom speed keyframes a distinct salmon/dashed **◆** lane. Their positions use
authoritative clip retiming; off-trim
keyframes are omitted. An exclusive-OUT keyframe has a boundary marker that seeks
the final available frame.
Click, Enter or Space selects the clip, seeks the nearest mapped image and opens Clip → Transform (Clip → Speed for the ◆ lane); a click edits nothing. Both kinds also slide: drag one
horizontally, or press ←/→ (one original source frame, Shift ten), keeping its easing (and a Transform key's enabled settings). A drag previews without history/save; a valid release is one Undo step, while Escape, cancellation, blur or an occupied/invalid frame restores. Moving a speed keyframe retimes its clip, so its duration and Ripple suffix can change; overlap/fade/transition conflicts reject the release. Marker keyboard events are isolated from
timeline shortcuts. These source-keyframe markers are not the draggable shared
project-time track markers above. Speed and Transform stored navigation still
reaches all retained off-trim/original-OUT keyframes through independent clip-local
cursors; main capture always uses the real displayed project/source frame.

The thin strip above video tracks is the **time ruler**: separators/ticks denote
TIME, and click/drag seeks the playhead. The separate **Cut / Fade / Dissolve**
buttons explicitly open Track → Transitions for their own track's boundary.
Neither ruler ticks nor those transition buttons are keyframe markers.

## Group composition

Enabled video track groups are composited bottom-to-top over opaque black in encoded
BT.709 RGB, after each source has its evaluated grade. For group sources $i$, let
$w_i$ be dissolve weight, $o_i$ evaluated Opacity, $b_i$ black-fade brightness,
$m_i$ spatial source coverage at the pixel and $G_i$ graded
RGB. Each track's dissolve is **one** group, not two separately source-overed clips; several
tracks may dissolve simultaneously:

- Premultiplied group RGB: $C = \sum_i G_i b_i o_i w_i m_i$.
- Group coverage: $A = \sum_i o_i w_i m_i$.
- Source-over: $\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no additional track multiplier.

Preview, CPU numeric tests and native composited export share this sampling/composition
contract. Each source's grade and track Opacity are evaluated at the same project frame.
With no keyed Opacity settings, each source uses the track's required `opacity` value;
otherwise the sole `opacity` curve overrides it for every source, including both
dissolve sources. This is one evaluated setting per video track, applied inside the
group sums, not another multiplier after composing the group. Opacity is coverage,
not a parameter of SDR RGB grading; unkeyed colour is track-owned. Black fades
affect RGB only, not coverage. Nonneutral spatial poses have transparent coverage
outside the transformed/cropped original; crop never refits or moves its centre.
Exact neutral poses retain the old opaque black letterbox after grading ($m_i=1$
over the canvas), not transparent padding. Spatial geometry uses continuous
`PlacedClip.retiming.sourcePositionAt`, even on a held recorded image; grade and
Opacity remain project-time values. See [spatial transforms](design/SPATIAL_TRANSFORMS.md).
Full opacity/neutral settings preserve the original
single-track behavior. Native LUT interpolation and
final H.264/YUV quantisation are approximations, not bitwise shader equivalence.
See [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md) for grading/composition equations and
[GitHub Actions](https://github.com/Plonk42/PasCap/actions) for actual-commit CI;
synthetic checks do not establish intended-GPU or long-flight performance.

## Recording review and range selection

Hover over a **prepared** recording in Media. Its review button's width maps mouse X
to original frames 0 through `frameCount − 1`; a marker follows the mouse and the
source viewer, docked in the centre's **Source preview** tab, shows the observed paused
frame. Pin keeps that recording selected while hovering other recordings. It uses one muted decoder,
does not change timeline position, and suppresses stale imagery while loading/seeking.
The open project's bin contains explicitly imported recordings/music plus its timeline
references, not all global registrations. New projects have empty membership;
imports deliberately add to the selected bin and reuse the shared content-deduplicated
registry/cache. Removing clips does not discard imported recordings; **Remove from
project** deliberately removes a recording's membership together with its
clips/music tracks (confirmed when used), in one Undo step, without touching
originals or caches.
User library imports/additions automatically queue eligible proxies; ready/active
work is reused. Startup and hovering unprepared sources do not launch hidden
preparation jobs or play originals. Cancelled/failed preparation requires an explicit retry.

Set source IN/OUT with review handles, the numeric fields, or **I/O** while the
review controls are focused. OUT is exclusive: **O** selects through the visible
frame (`OUT = frame + 1`). The numeric pair applies on Enter or when focus leaves
both fields; Escape restores an unapplied draft.
At least one original frame is retained. Home/End on
a handle restores 0 or the full frame count; there are no separate Mark or Reset
buttons. Handle drafts commit only on release; Escape,
pointer cancellation, lost capture or window blur discards them and restores the
prior source frame. Below the image, a timeline-like **source range strip** maps the whole
original from frame 0 (left) to the exclusive OUT (right). It shows the five
already-prepared snapshots (frames 0, ¼, ½, ¾ and last), hatches the omitted head
and tail, and uses timeline-style IN/OUT trim handles with 24 px pointer targets;
clicking or dragging elsewhere on the strip scrubs. Missing snapshots show
**Snapshots unavailable** without changing the strip or starting preparation.

The round source **Play / Pause** button sits at the left of that strip. It
stays muted and uses the applied IN/OUT, not numeric drafts.
It starts at the current observed frame when inside the range and before its last
frame, otherwise IN; it stops and exact-seeks OUT − 1, without looping. A one-frame
range displays that frame without playing. Scrub/trim/mark/numeric range edits pause first.
Pending play and observed callbacks cannot restart after close, hidden viewer,
recording/project change or tab switch. Playback uses this same sole verified proxy
decoder, with explicit start/stall failures after five seconds and Retry; no source
audio/original playback, preparation, timeline/music seek or history/save is added.

Plus, double-click and drag/drop (including a dragged multi-selection) copy the latest choice
into a new independent clip. Without a choice they select the full
recording. Later range choices do **not** alter already inserted clips, original
files or full proxies. The viewer stays out of list flow so hovering cannot move
the recording card or disrupt a media drag. Timeline insertion/selection returns to Timeline preview;
the source remains available through its tab until closed or the project changes.

Choices are validated per-project browser-local editor state, separate from
autosave/undo/rendered documents. They survive reload in that browser, reset on a
new project, and do not follow a project copied to another browser. Close/hidden/
offscreen/unmount/project-switch releases the review decoder.

## Inspector and resource limits

The inspector uses **Clip / Track / Audio** tabs, split by ownership. **Clip**
holds the selected clip's **Speed**, **Transform**, **Range** and **Placement** (placement only) under a "Clip N of M · track" header; on an empty video track it shows only
"Select a clip on … to edit it." **Track** holds everything the whole video track owns
under an "Applies to all N clips on this track" header: Colour (including the sole
track Opacity control, HSL and curves), Keyframes (the shared keyframe list with
Animation help, enabled-setting chips and whole-track navigation), Transitions (every
boundary of the track, left to right, with the selected one expanded) and Fades.
Music belongs to Audio, with detailed **Placement & fades**.
Sections retain their expansion in local browser storage.
New defaults collapse **Speed**, **Transform**, **Range** and **Placement** controls, while Track
sections stay open. Existing section preferences are not reset. **Expand all / Collapse all**
affects only the visible tab's sections: Clip's **Speed**, **Transform**, **Range** and
**Placement**; Track's **Colour**, **Keyframes**, **Transitions** and **Fades**; Audio's
**Music**. Other tabs, nested keyframe disclosures and
help remain unchanged; the shared list has no expansion preference.
Hidden tab/section content stays mounted, retaining valid/invalid drafts within
the same editing context. Track/clip changes refresh that context safely rather than
applying its former drafts to another selection. Collapse or switching tabs never
disables processing or changes the rendered document. Options menus and automatic
proxy admission remain unchanged.

Preview uses two reusable decoder/texture slots per track, up to **16 for eight
tracks**, supporting independent simultaneous dissolves. Unused slots are available
for preloading. Source review adds at most one decoder while visible. No decoder or
texture is allocated per stored clip.

Up to **eight identified music tracks** share one AudioContext/AudioWorklet and
one output timestamp clock with the unchanged one-project-frame A/V bound.
Sources are read/accumulated serially into a single mixed stream: per-track
gain/fades, linear sum, **one final [−1, 1] clamp**. No normalisation, ducking,
effects or source-video audio. The aggregate queue remains **four × 128 KiB stereo
Float32 blocks (512 KiB)**, with shared bounded **64 KiB range/short-selection
scratch**, one **128 KiB conversion workspace** and one **128 KiB mixed-output
workspace**. Serial credit-controlled refill and one unacknowledged receipt remain
bounded independently of duration/count; one dedicated reader worker owns those
reads and refills off the editor thread. No per-track queue/clock, full-file
buffer or duration-sized silence allocation. Current PCM preparation stays serial
with the unchanged cache format, about 11.52 MB per minute. See
[MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md) for independent editing and pending acceptance.

Export reads one original at a time through the shared backpressured frame mapper.
The plain static single-track path retains at most two lossless clips, two
intermediate decoders and one reusable RGB frame (24.9 MB UHD), plus native memory.

The static fast path is eligible only with neutral HSL/identity colour curves and one enabled video track with Opacity 1,
no track keyframes, exactly neutral clip spatial bases and no spatial keyframes, a zero first
start and no internal gaps, covering the **full project duration**. Music beyond
video OUT requires composited export's trailing black spans,
not a held last image. Ripple itself is not
an eligibility requirement. Other valid timelines, including any (even
neutral) track keyframe or any spatial edit/keyframe (even neutral keyframes), use the generalized
composited path; static planning rejects them.
That pipeline remains sequential, with at most one original decoder, two intermediate readers and one
encoder, and at most three native video children per pass. Each enabled populated
track first renders a premultiplied RGBA16 group from at most two RGB sources;
subsequent source-over passes merge group and lower accumulator without regrading
or applying another opacity multiplier. Final H.264 is encoded once.
Four reusable raw buffers (two RGB8 and two RGBA16) use **22 bytes/pixel =
182,476,800 bytes at UHD**; two reusable **65³ Float32 LUTs** add
**6,591,000 bytes**, with native codec/pipe/filter memory and selected audio PCM
additional. Grades use evaluated parameters, not crossfaded endpoint LUTs; there
are no per-frame LUT files or per-frame native-process launches. Source mapping
uses the layout's captured `PlacedClip.retiming`; grade/opacity sampling uses
absolute project time, including repeated source images. Spatial geometry uses
continuous original-source position from that same map. Inverse mapping and
bilinear RGB resampling precede grading. Nonneutral HSL/curves use exact complete
CPU grading (nine scalar controls, HSL, master/RGB curves), not a LUT; neutral
advanced settings retain scalar LUT grading. Exact grading uses tiny RGB triples
and remains the costliest path, especially at UHD; no transformed image/mask buffer or
per-frame native process is added. The 22 bytes/pixel, two-LUT and process bounds
above remain unchanged.

CPU group composition and LUT generation split each frame/LUT into disjoint image-scanline/
blue-slice bands across **at most eight worker threads** (host cores − 1; in process
with fewer than three cores). Workers share the four raw buffers and two LUTs as
`SharedArrayBuffer` memory rather than copying them; they add no decoder, LUT, frame
buffer or native child. One frame or LUT is in flight at a time, every band settles
before its buffers are reused, and the pool is terminated when the export ends.
Results are byte-identical to in-process composition.

At most two retained lossless clip files and **three** timeline representations
coexist: lower accumulator, track group and output (or group spans and their joined
group). A span collection counts as one. Inputs are deleted after their serial pass.
The final mixed audio and MP4 remain through verification. Scratch grows
with those duration-dependent representations, not simultaneously decoded
originals: these are concurrency bounds, not a fixed memory/disk-in-GB promise.
Animated LUT generation/CPU passes can be slow, and long 4K/slow-motion edits may
need substantial disk. Interrupted jobs are not resumed; cancellation/failure
cleans only owned scratch and preserves originals, saved edits and prior successful
outputs. Intended-GPU preview, real-flight throughput and long-run A/V/resource
qualification remain separate work in
[#6](https://github.com/Plonk42/PasCap/issues/6),
[#7](https://github.com/Plonk42/PasCap/issues/7) and
[#8](https://github.com/Plonk42/PasCap/issues/8).

Audio native work is separate and serial: **one original at a time** to exact
selected **48 kHz stereo s16 PCM**, then pairwise floating addition with an old
**Float64 stereo accumulator** into the next full-project accumulator. Intermediate
values are never clipped or normalised; the final mixed AAC input clamps once.
At most **two intermediate audio inputs**, **one native audio child per pass** and
**three audio scratch files** (selected PCM + old/new accumulators) coexist;
consumed inputs are deleted before the next music track. Advisory audio disk planning
is **maximum selected PCM size + two full-project Float64 stereo timelines**,
not all sources or loop repetitions. It grows with duration and is additional to
the unchanged video raw-buffer/child/LUT bounds above. Cancellation/failure removes
only owned scratch, never originals, saved projects or successful outputs.

Schema **v13 is strict**, including complete required video track `colour` with Temperature/Tint and static HSL/curves, no clip colour/correction fields, and clip `spatial` base/eight-value
source-frame keyframes and required unique `media.videoIds` / `media.audioIds`
arrays, at most 10,000 IDs each, and all required per-track settings. Project-level
transitions/fades, saved `clip.opacity` and old `clipOpacity`/`layerOpacity` keyframe
channels are not accepted. `VideoLayer.opacity` is the required sole stored track
value, a number in 0–1; 1 is a new-track initial value, not a missing-field default.
Keyframes require exactly the ten nullable fields listed above, including `opacity`, `temperature` and `tint`.
The required `music` array contains 0–8 independent music tracks with unique required
IDs and complete source IN/OUT/start/duration/gain/fades/loop fields; `[]` without
music, never a null/singular value or default. Version-1 export receipts require
a strict v13 snapshot plus captured audio-source/instance-plan arrays.
Older v1–v12 project documents and export receipt snapshots remain unchanged/incompatible;
there are no migrations, compatibility fallback/default fields or automatic deletion
of projects, receipts or successful videos. Create a new project and deliberately
import its media; registered media and currently verified ready proxies remain reusable.
Registry/proxy/current PCM formats and source identity checks are unchanged.
Confirmed project deletion removes only its saved document, preserving originals,
the shared registry/proxy cache and exports/receipts. The live v3 sample appearing
incompatible is expected, not a reason to rewrite it.

Workspace layout, field commits and recovery controls are specified in
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).
