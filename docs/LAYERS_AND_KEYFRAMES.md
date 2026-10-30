# Video tracks, keyframes and source review

Color belongs to **clip grades** and **adjustments**, not to video tracks
([ownership](design/ROW_APPEARANCE.md)). Every grade has twelve graded scalar fields, including
**Temperature**, **Tint**, **Vibrance**, **Whites** and **Blacks**, the **HDR** look (0–1, applied
before grading with the clip [detail filters](design/DETAIL_FILTERS.md#hdr-look)) and **Local
contrast** (−1…1, the local-detail boost split out of HDR), plus static **HSL ranges** and
**Color curves**. Temperature/Tint use −2…2 and −1…1, neutral 0; positive values warm/add
magenta respectively and intentionally color grays. Their normalized linear gains run before
Exposure. See [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
Eight named HSL bands and four encoded curves stay active when scalar channels
are animated, without adding keyframe channels. Band/all-HSL and channel/all-curves resets
preserve the twelve scalar bases and keyframes; Reset on an animated grade preserves advanced
settings. Unanimated Reset restores the complete Color of the grade. See
[the advanced-color contract](design/HSL_AND_CURVES.md).

## Video tracks

The document stores one to eight uniform video tracks **bottom-to-top for
composition**. Timeline/sidebar tracks use that same array order: track 1 renders below
track 2, track 3 above track 2, and so on. Raise/Lower change composition priority, not
an editing role. The initial Track 1 identity is conventional, not mandatory or
privileged. Every track can be reordered or deleted, except the last remaining
track; only actual top/bottom stack endpoints restrict Raise/Lower.

Every `VideoLayer` requires `transform`, `ripple`, `transitions`, `openingFade` and
`closingFade`. New tracks start with **Ripple on**, empty transitions, zero fades and a neutral
Transform with **Opacity 1 (100%)**; missing fields are invalid, not default-filled.
In **Track options**, enabling Ripple packs clips in chronological order from the
first clip's current project-frame start, closing gaps in **one Undo step** and retaining valid
existing dissolves. While on, saved clip order continuously sequences from that
anchor: each next start is the preceding OUT minus any incoming dissolve duration.
Each clip keeps its own duration wherever it sits, and commands persist actual
integer starts. Structural edits preserve the track's pre-edit first start even
when its first clip changes. Turning Ripple off captures actual placements;
future edits keep other clips at their independent starts. Neither switch moves
music, other tracks, Transform keyframes or adjustments.

The Timeline start field works on any positioned clip, or the
**first anchor only** while Ripple is on. Later Ripple starts expose a tooltip
reason: drag to reorder, or turn Ripple off for independent placement. Ripple is
not a future-edits-only policy that preserves gaps while enabled.

With Ripple off, gaps reveal lower footage/black. Edits do not move unrelated
clips; invalid overlap is rejected atomically. Left-edge handle/keyboard trims
move the start to retain timeline OUT; restoring IN stops where the start would
precede frame 0. With Ripple on, these trims keep the sequence start and recompile the
suffix. Right timeline trims and **Clip → Range** fields/bar/**Restore full recording**
keep the selected start in either mode; the Properties panel uses ordinary source-range
trim, not the timeline left handle's retained-OUT rule. Source-frame speed anchors
remain independent. See [the Range controls](TIMELINE_EDITING.md#clip-range).

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

**+ Track** (**Add video track**), in the pinned **Video tracks · N / 8** heading
above the track headers, creates/selects a track. Each track header shares its lane's
exact row box; lanes are contiguous below the ruler, with music lanes directly after
the last video track. Sidebar controls select and hide/show;
**Track options** contains only rename, Ripple, raise/lower and delete. Track
names apply on Enter/blur, Escape restores, and a rename is one Undo step. Selecting
an empty video track retains both its **Track** context (Transform with Opacity, transitions,
fades) and the target for Media **+**/double-click insertion. A populated track selects its first clip and
reveals its track without changing placement. Selecting a clip or populated/empty
track preserves the chosen Properties tab and safely refreshes its editing context.
Media drops target the track under the pointer: Ripple-on drops choose a sequence
insertion slot; Ripple-off drops use
independent project-frame placement.
Scroll over either the headers or tracks to reach all eight video tracks and music; native
vertical scrollbars and keyboard focus reveal stay synchronized. Horizontal timeline
scroll is independent and scrolling never changes the project or playhead. The time
ruler stays pinned above the tracks, with horizontally aligned ticks and a visible
playhead handle (timecode only during drafts; the preview transport shows it otherwise);
click seeking, range dragging and handle scrubbing use the same integer-frame geometry.
Dropping on the ruler never targets a track concealed underneath it.
Unavailable Raise/Lower/Delete actions have contextual accessible reasons for the
actual stack endpoint, last remaining track or active interaction state.
Drag existing clips between video tracks, or use Clip → Placement. Deleting a track
and its clips is one undoable command. Existing moves preserve the grabbed offset
and show the actual final placement ghost with the clip's own unchanged duration;
red invalid placements are not committed. Ripple-on tracks remain sequenced
even with snapping disabled. Start/nudge and duplication retain timing
validation, source-frame speed anchors and the clip's grade; they never copy Transform
keyframes.

Visibility and Opacity are renderable state, not preview-only switches.
Disabled video tracks do not decode/draw, but their placements still contribute to total
duration; an entirely hidden tail therefore exports black. **Opacity** is a setting of the
track's [Transform](design/SPATIAL_TRANSFORMS.md), not of a clip or a grade: the base
`transform.base.opacity` in 0–1, or its curve once Transform keyframes enable `opacity`, applies
to **every** clip in the track, including both dissolve sources. There is no saved
`clip.opacity`, separate group-opacity channel or additional track multiplier. Black
transitions/fades darken only their track's RGB without removing its alpha coverage;
they do not dim another track or reveal lower footage through a transparency fade.

## Grade keyframes

**Color animation belongs to clip grades and adjustments; a video track has no Color
keyframes.** A clip grade's keyframes are at **original-source frames** of its recording, so they
stay on their images through trims, moves, Ripple, splits, Reverse and speed changes. An
adjustment's keyframes count from its start and move with it; it grades every video track within
its project-time range ([adjustments](design/ROW_APPEARANCE.md#adjustments)). Clip speed curves
have their own original-source keyframes; track [Transform](design/SPATIAL_TRANSFORMS.md),
Opacity included, has its own project-frame keyframe list.

Each grade requires `keyframes` as ordered `{ frame, values, easing, reset }` keyframes, with
**at most 64 keyframes per clip grade or adjustment**. Frames are unique and strictly ascending:
a clip grade's from 0 to its recording's frame count; an adjustment's counted from its start,
negative before it, while start + frame stays within 0–2,147,483,647. Every keyframe's `values`
object requires **all fourteen nullable fields** below: a number enables that setting; `null`
leaves it disabled. Its `easing` object has the same fourteen fields: each enabled setting has
its own Easing (`hold`, `linear`, `ease-in`, `ease-out` or `smooth`) and each disabled setting
`null`. Omitted/unknown fields, an `opacity` field, a mismatched Easing and all-null keyframes
are invalid, not repaired with defaults. The required boolean `reset` marks a **default
keyframe** (below); ordinary keyframes have `false`.

| Channel                          | Value          | Value when this channel has no keyframes |
| -------------------------------- | -------------- | ---------------------------------------- |
| Temperature (`temperature`)      | −2 to +2       | The grade's saved value, initially 0     |
| Tint (`tint`)                    | −1 to +1       | The grade's saved value, initially 0     |
| Exposure (`exposure`)            | −3 to +3 stops | The grade's saved value, initially 0     |
| Brightness (`brightness`)        | −0.5 to +0.5   | The grade's saved value, initially 0     |
| Contrast (`contrast`)            | 0–2            | The grade's saved value, initially 1     |
| Hue (`hue`)                      | −180° to +180° | The grade's saved value, initially 0     |
| Saturation (`saturation`)        | 0–2            | The grade's saved value, initially 1     |
| Vibrance (`vibrance`)            | −1 to +2       | The grade's saved value, initially 0     |
| Highlights (`highlights`)        | −1 to +1       | The grade's saved value, initially 0     |
| Shadows (`shadows`)              | −1 to +1       | The grade's saved value, initially 0     |
| Whites (`whites`)                | −1 to +1       | The grade's saved value, initially 0     |
| Blacks (`blacks`)                | −1 to +1       | The grade's saved value, initially 0     |
| HDR (`hdr`)                      | 0 to 1         | The grade's saved value, initially 0     |
| Local contrast (`localContrast`) | −1 to +1       | The grade's saved value, initially 0     |

The exact fourteen required value fields are `temperature`, `tint`, `exposure`, `brightness`,
`contrast`, `hue`, `saturation`, `vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`
and `localContrast`; every channel is appearance-only and never changes timing.
Clip documents contain independent **constant or custom-keyframed**
speed, a required boolean `reverse`, static `detail` (Sharpen, Clarity,
Denoise) and their `grade`, with no color/correction, `opacity` or `spatial` field.
Clip speed keyframes use original-source frames in their separate clip-owned settings. Track
`transform: { base, keyframes }` keyframes use project frames and enable each of the nine
settings, Opacity included, independently (nullable per setting), in their own list.
Trimming, restoring, moving, splitting and duplicating footage keep each clip's grade with its
footage (split, cut and duplicate copy it) and **never copy or shift Transform keyframes or
adjustments**. Split/duplicate create independent source ranges and speed, retaining
original-source clip-speed anchors, including off-trim and original exclusive-OUT keyframes.
A moved clip uses its destination track's Transform and Opacity; both tracks' values and
keyframes stay where they were. Track Ripple also leaves Transform keyframes and adjustments
anchored in project time. Removing the last keyed setting of a channel reveals the grade's
unkeyed value. There is no separate clip correction.

Keyframes outside a clip's trim or an adjustment's range remain stored and list-editable. They
are not discarded when footage is shortened or an adjustment trimmed, and still define their
channel's curve. A clip grade keyframe never changes the clip's duration, and an adjustment never
extends the project duration.

## Independent channel interpolation

Enabled settings are independent, including between the twelve scalar color parameters, HDR and Local contrast.
Each enabled setting has its own Easing at a keyframe, and **each channel interpolates
to its own next keyframe with that setting enabled**, skipping keyframes where that channel is null.
So Exposure can hold while Contrast eases in from the same keyframe.
For example, Exposure at frames 10 and 30 interpolates across a Contrast-only keyframe
at frame 20; that middle keyframe does not interrupt Exposure's interval.

Before the first/after the last keyframe with that setting enabled, that channel holds its endpoint
value across the whole clip grade or adjustment. A single keyed setting therefore overrides the
channel everywhere. A channel with no keyed settings uses the values above,
even if other channels of the grade are animated.

For normalized interval progress $u$, that setting's Easing at the **left keyframe with that setting enabled** supplies:

| Easing   | Progress                                            |
| -------- | --------------------------------------------------- |
| Hold     | 0 until the next keyframe with that setting enabled |
| Linear   | $u$                                                 |
| Ease in  | $u^2$                                               |
| Ease out | $2u-u^2$                                            |
| Smooth   | $3u^2-2u^3$                                         |

Color interpolates **parameter values**, then grades the sampled source RGB.
It does not blend separately graded endpoint pictures; hue interpolates numerically
in degrees. A clip grade is evaluated at the clip's continuous source position, so slow motion
eases between its keyframes; adjustments and Opacity coverage use **project time**. All of them
can change on consecutive output frames even when slow motion holds the same source frame.

Speed is not a grade or track channel. Each clip's constant or custom-keyframed speed is
compiled into its own `PlacedClip.retiming`, used by layout, preview and native
export; see [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md) for its source-frame curves and
repeat/drop sampling without optical flow.

### Default keyframes

A **default keyframe** returns a clip grade or adjustment to its default Color at one frame
without working out which settings changed. It is a stored keyframe with `reset: true`,
created with all fourteen settings enabled at their neutral creation values
(Temperature/Tint/Exposure/Brightness/Hue/Vibrance/Highlights/Shadows/Whites/Blacks/HDR/Local contrast 0, Contrast/Saturation 1)
and every Easing **Hold**. It evaluates like any keyframe with one difference: it never
reaches back. Before a default keyframe that is a setting's first keyframe, that setting
keeps the grade's unkeyed value instead of holding the keyframe's value. A setting keyed earlier
eases into the default with its own Easing at the previous keyframe, then holds the default until
its next keyframe. Static HSL/curves, track Transform, speed, Detail and music are unaffected.
Transform keyframes carry the same `reset` flag: **Add default Transform keyframe** in Track →
Transform's keyframe line returns the pose, Opacity included, to neutral the same way,
independently of Color.

For example, with saved Contrast 1.4 (unanimated), Exposure keyed to 1 at frame 10 and a
default keyframe at 50: Contrast is 1.4 before frame 50 and 1 from it; Exposure is 1 at
frame 10, 0.5 at 30 with Linear Easing, and 0 from 50.

The Color keyframe line has a toggle **Add default keyframe** (pressed: **Remove default
keyframe**) with its own amber icon, a diamond around a return arrow. It adds a default keyframe
to the grade the Color tab edits, at the playhead, or removes the one there, in one Undo step;
it is unavailable where an ordinary keyframe already exists (never merged or overwritten).
On the timeline a clip grade's default keyframe marker is filled amber with the same icon, and
its list entry carries a **Default** badge. Its values, per-setting Easing, time and enabled
settings stay editable like any keyframe's; it remains a default keyframe throughout.

Control names follow the [editor control vocabulary](design/EDITOR_CONTROLS.md#vocabulary).

The **Color** Properties tab edits the grade of the clip or adjustment selected on the timeline,
named in its pinned header
([Color tab](design/ROW_APPEARANCE.md#properties-and-history)). Its Color section ends, below
its grouped sliders, with **one directly visible keyframe list** for that grade under a small
**Keyframes** heading, with the **Animation help** question-mark button beside it (fieldset
accessible name **Clip keyframes** or **Adjustment keyframes** plus its name, list **Edit clip
keyframes** or **Edit adjustment keyframes**). Color's keyframe line provides its count and the
only section Previous/Next pair. Animation help includes keyframe-timing guidance, with no
separate Keyframe timing help button. **Clip** keeps source/clip settings and Speed controls;
**Color** keeps the grade's controls and **Track → Transform** the pose and Opacity, evaluated
at the playhead.

Color, Speed and Transform always show their capture diamonds while the section is expanded, Color and Transform with adjacent per-setting **Previous/Next** buttons; there is no Animate toggle and no stored preference. Each expanded section has one keyframe line with the **number of keyframes**, one **Previous/Next** pair over the same set and **Reset**. The line is hidden while the section is collapsed; the title row and its help stay reachable. Rendering, retained keyframes and read-only constraints never depend on what is shown. Color diamond states remain:

- **◇ Hollow**, `aria-pressed=false`: setting not enabled at this frame.
  It is still clickable, **not HTML-disabled merely because it is inactive**.
- **◆ Filled**, `aria-pressed=true`: setting enabled at this frame. Clicking removes
  only that setting and its Easing; other enabled settings and their Easing remain unchanged.
- The first enabled setting creates the keyframe, capturing its displayed value,
  with Linear Easing. Enabling another setting at that frame joins the same keyframe and
  takes the Easing its settings agree on (only those continuing to a later keyframe, else all),
  or Linear when they differ. Removing the last
  enabled setting deletes the keyframe. Genuine invalid/draft interaction states can
  disable actions; hollow status itself cannot.

Each section's keyframe line has one native **Previous/Next** pair, beside the count of the keyframes it visits.
Color visits the twelve scalar color, HDR and Local contrast keyframes of the clip grade or
adjustment it edits, exactly the rows of its stored list, with seek-hint tooltips. Speed visits all
retained custom speed source keyframes of the selected clip, including off-trim
keyframes and the original exclusive OUT, previewing the nearest mapped image through
authoritative `PlacedClip.retiming`. Transform visits all track Transform keyframes,
including those after the duration, with its own track-local cursor. Speed
uses an independent clip-local stored-source cursor, advancing through successive stored
keyframes even when their nearest first/last preview image is the same. Stored source time
remains distinct from the actual displayed source frame; capture always uses the latter.

Per-channel native **Previous/Next** arrows remain beside each main color diamond, because not every setting is enabled at every keyframe.
Enabled setting chips in stored Color keyframe rows retain their arrows too.
All these per-channel arrows visit **strictly earlier/later** keyframes where
`values[setting] !== null`; zero is an enabled value, and keyframes belonging only to
other channels are skipped. The main arrows start from the playhead, a chip's from its own
row. There is no wrap or revisit of the current keyframe.
The arrows are disabled when the relevant neighbor is absent, no project is open,
or any document-preview draft is active. Navigation preserves the
chosen Properties tab and activated button's focus instead of forcing Clip, and
changes no document, history or autosave state.

The main Color sliders sit under three static headings, each with a one-Undo group Reset:
**Color** (Temperature, Tint, Hue, Saturation, Vibrance); **Light** (Exposure, Brightness,
Contrast, Highlights, Shadows, Whites, Blacks); **Effects** (HDR, Local contrast). This visible
order differs from the unchanged channel order above
([Color tab](design/ROW_APPEARANCE.md#properties-and-history)).
Unkeyed controls edit the grade's saved values. **Opacity** is not in the Color tab: it is the
ninth setting of **Track → Transform**, with its own triangle and per-setting Previous/Next;
main and stored Opacity sliders/exact fields use **0–100%**, neutral **100%**, while
`transform.base.opacity` and Transform keyframe values stay **0–1**. **Clip → Placement**
contains placement controls only; **Track options** is limited to rename, Ripple, ordering and
deletion.

Once a channel is animated anywhere in the clip grade or adjustment, its main value control is
read-only at frames where that channel is not enabled, including at keyframes
belonging only to other settings. It is shown dimmed with a lock cue: **click its hollow diamond to capture a value before editing**.
Setting tooltips and screen-reader context say **Keyframe at playhead** for an
editable keyed setting, or **Animated · add a keyframe to edit** for a read-only
animated value, and explain which diamond adds a keyframe at the playhead.
Sliders/numbers never implicitly create keyframes; unanimated settings edit the grade's saved
`color`. A clip grade's diamonds key the source frame shown at the playhead and are unavailable,
with the reason, while the playhead is off the clip; an adjustment's key its frame at the playhead.

Color's **Keyframes** list has no outer disclosure, list expansion preference,
count or navigation of its own; the keyframe line above counts and visits its keyframes.
Color's and Transform's lists are one shared component, so they look and behave alike.
The entry of the keyframe at the playhead is marked current. Each keyframe entry has a timecode
button (**Go to clip keyframe N** or **Go to adjustment keyframe N**) stretched over the whole
entry, so a click anywhere outside its controls selects it, a **Default** badge where it applies
(and **Outside duration** on an adjustment keyframe after its end), a trash (**Delete clip
keyframe N** or **Delete adjustment keyframe N**), its enabled-setting chips and an inner
**Edit** disclosure, closed initially. Its **Source frame** (clip grade) or **Frame in
adjustment** field moves
**every enabled setting and its Easing together in one Undo step**.
The visibly labeled **Easing** select (accessible name **Clip keyframe easing N** or
**Adjustment keyframe easing N**) sets
every enabled setting's Easing in one Undo step, each toward its own next keyframe with
that setting enabled. It shows the Easing those settings share, counting only settings
keyed again later when any are, or **Mixed** when they differ. Beside it, **Per setting**
(shown only when two or more settings are listed and they agree) reveals one compact Easing
select per setting, **<Setting> easing at clip keyframe N**; while settings differ that list
stays visible. Each choice changes only that setting, in one Undo step. Choosing in the main
select makes them agree again and hides the list unless it was opened explicitly. The
list's visibility is editor-only, never stored.
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

Main and stored color controls share a native slider with one adjacent
exact `NumberField` as the value display, not a read-only output. Stored keyed settings
reuse the same bounds and double-click-the-name resets. The channel table gives stored
bounds.

Dragging a Color, Opacity, HSL or Transform slider (main or stored) previews the draft value in the image, coalesced to the display rate, without any document, history, autosave or Properties change, and without restarting music. Release commits one validated edit and one Undo step. Escape, pointer cancellation, lost capture, window blur or an invalid value restores the control and the preview. Other sliders (speed, gain) keep their release-only image update. Each keyboard slider adjustment is an individual validated edit. The full value-control contract is in
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md#numbers-titles-and-animation).

Only existing non-null enabled settings get value editors. Each accepted value/reset
changes that keyed setting at its stored frame in **one Undo step**, without changing
keyframe time, any Easing, other enabled settings/keyframes or saved values,
and without requesting a seek. No slider, numeric edit or reset implicitly joins a channel.
Numeric drafts preserve entered precision; empty, nonfinite, out-of-bounds and
contextually invalid values remain editable with inline errors, never silently
clamped or rounded.

All stored keyframes, including those on trimmed-off footage or outside an adjustment's range,
remain editable in this list. Color keeps no stored-keyframe cursor: seeking such a keyframe
previews the clip's nearest image, or the adjustment's nearest frame, and main setting values,
diamond state and capture always use the playhead. Navigation is not a saved project field or an
Undo operation.

Speed is clip-only, in **Clip → Speed** (**Constant speed / Custom curve**, with
presets such as Ramp up); grade keyframes never contain or override it. Color
resets target only enabled color values at the current keyframe; individual
resets can edit the grade's unanimated saved values. In the stored list, each reset instead
targets its existing stored keyed setting, even when that keyframe is outside the footage shown.

## Timeline markers and ruler

Track Transform keyframes are boxed blue **▼** markers at the top of their track row: **one
marker per stored Transform keyframe**, not one per setting or clip (a default keyframe is filled
light blue with the default-keyframe icon). Its title names the video track, project time
and enabled settings. **Click or Enter** selects the track, seeks and opens Track → Transform,
without editing; navigation retains the chosen Properties tab otherwise. Keyframes after the last
clip keep their marker at their own project time, like keyframes before the first clip. The
scrollable timeline widens to reach the last stored Transform keyframe or adjustment, but
duration, playback and seeking still end at the last project frame, determined by the maximum
video/music OUT. Clicking such a marker seeks the nearest available frame and changes nothing;
the Transform list's row inspects the stored keyframe itself.

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
- Snap uses captured clip/music/transition boundaries, bookmarks and the captured playhead,
  within **eight pixels at the captured zoom**. Alt bypasses it. Horizontal edge
  autoscroll uses the same base geometry; neither track switching nor automatic track
  reveal relocates the gesture.
- Occupied frames produce a **red invalid ghost**, even when the other keyframe has
  unrelated settings. Keyframes are **never merged or overwritten**. Invalid release
  reports the reason and changes nothing; it cannot commit an earlier valid draft.
  Returning to a free valid frame permits committing that final destination.
- Escape, pointer cancellation, unexpected lost capture or window blur rolls back
  preview, document and horizontal scroll, with no draft save or history entry.

On a focused marker, **Left/Right** moves one project frame and **Shift+Left/Right**
moves ten, with the same atomic validation and no snapping. Focus follows the move.
Movement navigates to the keyframe without also firing
ordinary playhead-step or clip-nudge shortcuts, or leaking other editor shortcuts.
**Delete** or **Backspace** on a focused marker removes that whole keyframe in one Undo step,
whether or not the track still has clips, even outside the duration.
Dragging can reach beyond duration, but retaining that keyframe never extends the
sequence merely for its marker. No other track's keyframes/values, clip settings/source ranges,
adjustments or music are copied or shifted, and no clip is retimed. There is no cross-track
keyframe move.

### Clip grade and speed keyframe markers

Inside each clip rectangle, a clip grade's keyframes are amber **◆** markers, one per keyframe on
the footage the clip shows (keyframes on trimmed-off footage stay in the Color list only); a
default keyframe is filled amber with the default-keyframe icon. They sit where the clip shows
their source frame and move with the clip. Click, Enter or Space selects the clip, seeks that
image and opens the **Color** tab on its **Clip** target; a click edits nothing. Drag one
horizontally, or press ←/→ (one original source frame, Shift ten, along the timeline), to move
the keyframe with all its settings to another source frame of the recording; a valid release is
one Undo step, while Escape, cancellation, blur or an occupied frame restores. Delete or Backspace
removes it. An adjustment's keyframes are amber markers inside it on the
[adjustment track](TIMELINE_EDITING.md#adjustment-track), sliding the same way within it.

Custom speed keyframes use a boxed salmon **●** lane. Their positions use
authoritative clip retiming; off-trim
keyframes are omitted. An exclusive-OUT keyframe has a boundary marker that seeks
the final available frame.
Click, Enter or Space selects the clip, seeks the nearest mapped image and opens Clip → Speed; a click edits nothing. They also slide: drag one
horizontally, or press ←/→ (one original source frame, Shift ten), keeping its easing. A drag previews without history/save; a valid release is one Undo step, while Escape, cancellation, blur or an occupied/invalid frame restores. Moving a speed keyframe retimes its clip, so its duration and Ripple suffix can change; overlap/fade/transition conflicts reject the release. Marker keyboard events are isolated from
timeline shortcuts. Speed stored navigation still
reaches all retained off-trim/original-OUT keyframes through its independent clip-local
cursor; main capture always uses the real displayed project/source frame.

The thin strip above video tracks is the **time ruler**: separators/ticks denote
TIME; a click seeks the playhead, a drag selects a range to cut and the playhead
handle scrubs. The separate **Cut / Fade / Dissolve**
buttons explicitly open Track → Transitions for their own track's boundary.
Neither ruler ticks nor those transition buttons are keyframe markers.

## Group composition

Enabled video track groups are composited bottom-to-top over opaque black in encoded
BT.709 RGB, after each source is graded by its clip grade, then by the adjustment at that
project frame. For group sources $i$, let
$w_i$ be dissolve weight, $o_i$ evaluated Opacity, $b_i$ black-fade brightness,
$m_i$ spatial source coverage at the pixel and $G_i$ graded
RGB. Each track's dissolve is **one** group, not two separately source-overed clips; several
tracks may dissolve simultaneously:

- Premultiplied group RGB: $C = \sum_i G_i b_i o_i w_i m_i$.
- Group coverage: $A = \sum_i o_i w_i m_i$.
- Source-over: $\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no additional track multiplier.

Preview, CPU numeric tests and native composited export share this sampling/composition
contract. Each source's adjustment and track Opacity are evaluated at the same project frame,
its clip grade at its source position. Opacity comes from the track's Transform, its base or
its `opacity` keyframe curve, for every source, including both dissolve sources, which also
share the adjustment at that frame. This is one evaluated setting per video track, applied
inside the group sums, not another multiplier after composing the group. Opacity is coverage,
not a parameter of SDR RGB grading. Black fades
affect RGB only, not coverage. Nonneutral spatial poses have transparent coverage
outside the transformed/cropped original; crop never refits or moves its center.
Exact neutral geometry retains the old opaque black letterbox after grading ($m_i=1$
over the canvas), not transparent padding, whatever the Opacity. The track Transform pose,
like an adjustment and Opacity, is a project-time value applied to every source of the track.
See [spatial transforms](design/SPATIAL_TRANSFORMS.md).
Full opacity/neutral settings preserve the original
single-track behavior. Native LUT interpolation and
final H.264/YUV quantization are approximations, not bitwise shader equivalence.
See [COLOR_AND_TIMING.md](COLOR_AND_TIMING.md) for grading/composition equations and
[GitHub Actions](https://github.com/Plonk42/PasCap/actions) for actual-commit CI;
synthetic checks do not establish intended-GPU or long-flight performance.

## Recording review and range selection

Hover over a **prepared** recording in Media. Its review button's width maps mouse X
to original frames 0 through `frameCount − 1`; a marker follows the mouse and the
source viewer, docked in the center's **Source preview** tab, shows that exact decoded
frame. Clicking a recording chooses it: hovering others previews them, and leaving
them returns to the chosen recording and frame. It uses one
WebCodecs proxy decoder in its own worker ([decoding](design/WEBCODECS_PREVIEW.md#source-review)),
does not change timeline position, and never shows a superseded frame.
The open project's bin contains explicitly imported recordings/music plus its timeline
references, not all global registrations. New projects have empty membership;
imports deliberately add to the selected bin and reuse the shared content-deduplicated
registry/cache. Removing clips does not discard imported recordings; **Remove from
project** deliberately removes a recording's membership together with its
clips/music tracks (confirmed when used), in one Undo step, without touching
originals or caches.
User library imports/additions automatically queue eligible proxies; ready/active
work is reused. Startup and hovering unprepared sources do not launch hidden
preparation jobs or play originals. Canceled/failed preparation requires an explicit retry.

Set source IN/OUT with review handles, the numeric fields, or **I/O** while the
review controls are focused. OUT is exclusive: **O** selects through the visible
frame (`OUT = frame + 1`). The numeric pair applies on Enter or when focus leaves
both fields; Escape restores an unapplied draft.
At least one original frame is retained. Home/End on
a handle restores 0 or the full frame count; the reset icon after OUT (**Reset source range**)
restores both, replacing any unapplied numeric draft. It is dimmed with its reason when the range
already covers the whole recording. There are no separate Mark buttons. Handle drafts commit only on release; Escape,
pointer cancellation, lost capture or window blur discards them and restores the
prior source frame. Below the image, a timeline-like **source range strip** maps the whole
original from frame 0 (left) to the exclusive OUT (right). It shows the five
already-prepared snapshots (frames 0, ¼, ½, ¾ and last), hatches the omitted head
and tail, and uses timeline-style IN/OUT trim handles with 24 px pointer targets;
clicking or dragging elsewhere on the strip scrubs. Missing snapshots show
**Snapshots unavailable** without changing the strip or starting preparation.

The round source **Play / Pause** button sits at the left of that strip. It
has no audio and uses the applied IN/OUT, not numeric drafts.
It starts at the current displayed frame when inside the range and before its last
frame, otherwise IN; it stops on OUT − 1, without looping. A one-frame
range displays that frame without playing. Scrub/trim/mark/numeric range edits pause first.
Pending play and late decoded frames cannot restart after close, hidden viewer,
recording/project change or tab switch. Playback uses this same sole verified proxy
decoder, with an explicit failure when a frame is missing for five seconds and Retry; no source
audio/original playback, preparation, timeline/music seek or history/save is added.

Plus, double-click and drag/drop (including a dragged multi-selection) copy the latest choice
into a new independent clip. Without a choice they select the full
recording. Later range choices do **not** alter already inserted clips, original
files or full proxies. The viewer stays out of list flow so hovering cannot move
the recording card or disrupt a media drag. Timeline insertion/selection returns to Timeline preview;
the source remains available through its tab until closed or the project changes.

The applied range is the recording's active kept range in the project's `selects`
([kept ranges](TIMELINE_EDITING.md#kept-ranges)): it autosaves and Undoes like any edit, travels with
the project file and never alters clips, keyframes or rendering. Close/hidden/
offscreen/unmount/project-switch releases the review decoder.

## Properties panel and resource limits

The Properties panel uses **Clip / Color / Track / Audio** tabs, split by ownership. **Clip**
holds the selected clip's **Speed**, **Detail**, **Range** and **Placement** (placement only) under a "Clip N of M · track" header; on an empty video track it shows only
"Select a clip on … to edit it." **Color** holds Color, HSL ranges and Color curves for the
selected clip's [grade](design/ROW_APPEARANCE.md#clip-grades) or the selected
[adjustment](design/ROW_APPEARANCE.md#adjustments), created on the adjustment track; with nothing
selected it shows a hint to select one. The Color section ends with that grade's keyframe
list, Animation help and enabled-setting chips.
**Track** holds what the whole video track owns under an "Applies to all N clips on
this track" header: Transform with Opacity (ending with its own keyframe list), Transitions (every
boundary of the track, left to right, with the selected one expanded) and Fades.
Music belongs to Audio, with detailed **Placement & fades**.
Sections retain their expansion in local browser storage.
New defaults collapse **Speed**, **Detail**, **Range**, **Placement**, **HSL ranges**,
**Color curves** and **Transform**, while **Color**, **Transitions**, **Fades** and **Music**
stay open. Existing section preferences are not reset. **Expand all / Collapse all**
affects only the visible tab's sections: Clip's **Speed**, **Detail**, **Range** and
**Placement**; Color's **Color**, **HSL ranges** and **Color curves**; Track's **Transform**, **Transitions** and **Fades**; Audio's
**Music**. Other tabs, nested keyframe disclosures and
help remain unchanged; the keyframe lists have no expansion preference.
Hidden tab/section content stays mounted, retaining valid/invalid drafts within
the same editing context. Track/clip/adjustment changes refresh that context safely rather than
applying its former drafts to another selection. Collapse or switching tabs never
disables processing or changes the rendered document. Options menus and automatic
proxy admission remain unchanged.

Preview uses two WebCodecs decoders and textures per track, up to **16 for eight
tracks**, supporting independent simultaneous dissolves. Free decoders prefill the
next clips. Each decoder holds at most six decoded frames. Source review adds one
decoder while visible. No decoder or texture is allocated per stored clip. See
[WebCodecs preview decoding](design/WEBCODECS_PREVIEW.md#requirements-and-resources).

Up to **eight identified music tracks** of up to eight clips each share one
AudioContext/AudioWorklet and one output timestamp clock with the unchanged
one-project-frame A/V bound. Every clip is a source, read/accumulated serially into a
single mixed stream: its track's gain, its own fades (track fades at the ends, transition
fades between clips), linear sum, **one final [−1, 1] clamp**. No normalization, ducking,
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
A [reversed clip](SPEED_AND_AUDIO.md#reverse) uses serial seeked decoder chunks whose
native `reverse` filter holds at most 256 MiB of output RGB frames; Node still holds one.
The plain static single-track path retains at most two lossless clips, two
intermediate decoders and one reusable RGB frame (24.9 MB UHD), plus native memory.

The static fast path is eligible only with **no adjustments**, every clip grade unkeyed,
scalar-only (neutral HSL/identity color curves) and with Shadows/Highlights/HDR/Local contrast 0,
and one enabled video track with an exactly neutral Transform base, Opacity 1 and no Transform
keyframes, neutral clip
[detail filters](design/DETAIL_FILTERS.md), a zero first
start and no internal gaps, covering the **full project duration**. Each clip then gets one LUT
of its grade. Music beyond
video OUT requires composited export's trailing black spans,
not a held last image. Ripple itself is not
an eligibility requirement. Other valid timelines, including any adjustment, any (even
neutral) clip grade keyframe, nonzero HDR or Local contrast, or any Transform or Opacity
edit/keyframe (even neutral keyframes), use the generalized
composited path; static planning rejects them.
That pipeline remains sequential, with at most one original decoder, two intermediate readers and one
encoder, and at most three native video children per pass. Each enabled populated
track first renders a premultiplied RGBA16 group from at most two RGB sources;
subsequent source-over passes merge group and lower accumulator without regrading
or applying another opacity multiplier. The last pass encodes H.264 directly from its
composited frames, never through a lossless copy of the finished timeline: the final
source-over as one stream, or a single track's spans as consecutive chunks joined
without re-encoding, like static export.
Four reusable raw buffers (two RGB8 and two RGBA16) use **22 bytes/pixel =
182,476,800 bytes at UHD**; two reusable **65³ Float32 LUTs** add
**6,591,000 bytes**, with native codec/pipe/filter memory and selected audio PCM
additional. Grades use evaluated parameters, not crossfaded endpoint LUTs; there
are no per-frame LUT files or per-frame native-process launches. Each source's two scalar grades
(its clip grade, then the adjustment at that frame) compose into one LUT whose cache identity is
the pair. Source mapping
uses the layout's captured `PlacedClip.retiming`; clip grades are sampled at the source position,
adjustments and Opacity at absolute project time, including repeated source images, as is the
track Transform pose. Inverse mapping and
bilinear RGB resampling precede grading. Nonneutral HSL/curves in either grade use exact complete
CPU grading (twelve scalar controls, HSL, master/RGB curves, both grades in sequence), not a LUT;
neutral advanced settings retain scalar LUT grading. Exact grading uses tiny RGB triples
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

Each track-group span pass overlaps its stages inside the same four buffers: a
single-source span reads its next retimed frame into the second RGB8 buffer while the
current one is composed, and the encoder consumes each composed group from alternating
RGBA16 buffers while the next is composed. A dissolve needs both RGB8 buffers, so it
reads after composing. The source-over pass stays serial; it has no spare buffer.

Group frames with a per-pixel-heavy CPU path (the detail/local tone kernel or nonneutral
HSL/curves in a source's clip grade or adjustment, or nonneutral geometry) are composited
instead by a GPU worker page
in one headless Chrome process per export when a hardware renderer starts, with the
same shaders as the preview; neutral, scalar-color and Opacity/fade-only frames stay on
the CPU. It streams RGBA16 results into the existing accumulator,
adding no Node frame buffer, decoder or FFmpeg child. Without a hardware GPU, or after
any GPU failure, the CPU compositor above is used. See
[the GPU export worker](design/DETAIL_FILTERS.md#gpu-export-worker).

At most two retained lossless clip files and **three** timeline representations
coexist: lower accumulator, track group and output (or group spans and their joined
group). A span collection counts as one, including the last pass's H.264 output.
Inputs are deleted after their serial pass.
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
values are never clipped or normalized; the final mixed AAC input clamps once.
At most **two intermediate audio inputs**, **one native audio child per pass** and
**three audio scratch files** (selected PCM + old/new accumulators) coexist;
consumed inputs are deleted before the next music track. Advisory audio disk planning
is **maximum selected PCM size + two full-project Float64 stereo timelines**,
not all sources or loop repetitions. It grows with duration and is additional to
the unchanged video raw-buffer/child/LUT bounds above. Cancellation/failure removes
only owned scratch, never originals, saved projects or successful outputs.

The current schema **is strict**, including a required clip `grade` (complete `color` with
Temperature/Tint/Vibrance/Whites/Blacks/HDR/Local contrast and static HSL/curves, and 0–64
source-frame keyframes), required project `adjustments` (0–1,024 ordered, non-overlapping items with
the same Color and keyframes counted from their start), no clip color/correction/spatial
fields, a required boolean clip `reverse`, and track `transform` base/nine-value
project-frame keyframes (Opacity included), required unique `media.videoIds` / `media.audioIds`
arrays, at most 10,000 IDs each, and all required per-track settings. Video tracks have no
`color`, `opacity` or `keyframes`; project-level transitions/fades and saved `clip.opacity` are
not accepted. Grade keyframes require exactly the fourteen nullable fields listed above,
including `temperature`, `tint`, `vibrance`, `whites`, `blacks`, `hdr` and `localContrast`.
The required `music` array contains 0–8 independent music tracks with unique required
track and clip IDs: each has gain, Ripple, opening/closing fades, 1–8 clips with complete
source IN/OUT/start/duration/loop fields and one transition per adjacent pair; `[]` without
music, never a null/singular value or default. Version-1 export receipts require
a strict current-schema snapshot plus captured audio-source/per-clip plan arrays.
Projects and export receipt snapshots saved before the current schema, with track Color or British spelling, are
rejected with the reason and left unchanged; there are no compatibility fallback/default fields
or automatic deletion of projects, receipts or successful videos. Recreate such a project and
deliberately import its media; registered media and currently verified ready proxies remain
reusable.
Proxy/current PCM formats and source identity checks are unchanged; the registries are
version 3 (videos) and 2 (music), with full-content checksums.
Confirmed project deletion removes only its saved document, preserving originals,
the shared registry/proxy cache and exports/receipts.

Workspace layout, field commits and recovery controls are specified in
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).
