# Layers, shared row points and source review · project v11

Required row Colour includes static **HSL ranges** and **Colour curves**, even when the seven scalar channels are animated. Eight named HSL bands and four encoded input/output curves are edited in nested Clip → Colour controls, including on empty rows. They do not add key channels or clip fields. Band/all-HSL and channel/all-curves resets preserve the seven scalar bases, row points and Opacity; Reset keys preserves all advanced settings. Unanimated Reset restores the complete row Colour and Opacity. See [the complete advanced-colour contract](design/HSL_AND_CURVES.md).

## Video layers

The document stores one to eight uniform video tracks **bottom-to-top for
composition**. Timeline/sidebar rows use that same array order: row 1 renders below
row 2, row 3 above row 2, and so on. Raise/Lower change composition priority, not
an editing role. The initial Video 1 identity is conventional, not mandatory or
privileged. Every track can be reordered or deleted, except the last remaining
track; only actual top/bottom stack endpoints restrict Raise/Lower.

Every `VideoLayer` requires `ripple`, `transitions`, `openingFade`, `closingFade`
and numeric `opacity` in 0–1. New tracks start with **Ripple on**, empty transitions,
zero fades and **Opacity 1 (100%)**; missing fields are invalid, not default-filled.
In **Layer options**, enabling Ripple packs clips in chronological order from the
first clip's current project-frame start, closing gaps in **one Undo step** and retaining valid
existing dissolves. While on, saved clip order continuously sequences from that
anchor: each next start is the preceding OUT minus any incoming dissolve duration.
Contextual row Speed is recompiled at each new start, and commands persist actual
integer starts. Structural edits preserve the track's pre-edit first start even
when its first instance changes. Turning Ripple off captures actual placements;
future edits keep other clips at their independent starts. Neither switch moves
music, other tracks or absolute row points.

The Timeline start field and nudge controls work on any positioned clip, or the
**first anchor only** while Ripple is on. Later Ripple starts expose an accessible
reason: drag to reorder, or turn Ripple off for independent placement. Ripple is
not a future-edits-only policy that preserves gaps while enabled.

With Ripple off, gaps reveal lower footage/black. Edits do not move unrelated
clips; invalid overlap is rejected atomically. Left-edge handle/keyboard trims
solve the new start to retain timeline OUT, rejecting unrepresentable integer-frame
results. With Ripple on, these trims keep the sequence start and recompile the
suffix. Right trims and numeric source IN/OUT/reset keep the selected start in
either mode. Source-frame speed anchors remain independent.

Each track has one transition per adjacent pair: Cut, Fade-through-black or
Cross-dissolve. Gapped pairs are Cut only. Non-cut edits require touching clips or
that pair's existing dissolve. A dissolve explicitly places the right clip at
left OUT minus its duration; changing/removing it adjusts that overlap. With Ripple
off, only the right clip moves; conflicts reject the whole edit. Exact adjacent
dissolve overlap is the only allowed same-track overlap; triple overlap is invalid.
Opening/closing fades belong to the track's first/last clips at actual placements,
fit with other transition regions and remain stored but dormant on an empty track.

Project duration is the maximum of all retimed clip OUTs (including hidden layers)
and every music start + duration. Music can extend it. Closing fades end at their
last video clip OUTs, not at music/project OUT; no active video means opaque black
while music continues/fades at its own end, never a frozen last image. Music-only
preview is black; export still requires at least one retained video clip.

**+ Layer** creates/selects a track. Sidebar controls select and hide/show;
**Layer options** contains only rename, Ripple, raise/lower and delete. Layer
names apply on Enter/blur, Escape restores, and a rename is one Undo step. Selecting
an empty row retains both its **Layer keyframes** context and the target for Media
**+**/double-click/batch insertion. A populated layer selects its first excerpt and
reveals its row without changing placement. Selecting a clip or populated/empty
row preserves the chosen Inspector tab and safely refreshes its editing context.
Media drops target the row under the pointer: Ripple-on drops choose a sequence
insertion slot; Ripple-off drops use
independent project-frame placement.
Scroll over either the headers or tracks to reach all eight rows and music; native
vertical scrollbars and keyboard focus reveal stay synchronized. Horizontal timeline
scroll is independent and scrolling never changes the project or playhead. The time
ruler stays pinned above the rows, with horizontally aligned ticks and a visible
playhead handle/timecode; click/drag seeking uses the same integer-frame geometry.
Dropping on the ruler never targets a row concealed underneath it.
Unavailable Raise/Lower/Delete actions have contextual accessible reasons for the
actual stack endpoint, last remaining track or active interaction state.
Drag existing excerpts between rows, or use Clip → Placement. Deleting a layer
and its clips is one undoable command. Existing moves preserve the grabbed offset
and show the actual final placement ghost, including duration at the destination
row/time; red invalid placements are not committed. Ripple-on rows remain sequenced
even with snapping disabled. Start/nudge and duplication retain contextual timing
validation and source-ramp/curve anchors; they never copy row points.

Visibility and Opacity are renderable state, not preview-only switches.
Disabled layers do not decode/draw, but their placements still contribute to total
duration; an entirely hidden tail therefore exports black. **Opacity** is one
row-owned setting, stored only as required `VideoLayer.opacity`, not on a clip.
With no Opacity participants, every source uses the row's saved value. The sole
row key channel, `opacity`, overrides that value on **every** clip in the row,
including both dissolve sources. There is no saved `clip.opacity`, separate
group-opacity channel or additional layer multiplier. Black
transitions/fades darken only their track's RGB without removing its alpha coverage;
they do not dim another track or reveal lower footage through a transparency fade.

## Strict shared-point model

**A video row/layer owns shared row animation, not a clip.** Clip speed curves and
[spatial transforms](design/SPATIAL_TRANSFORMS.md) instead have their own
original-source keys. All shared row points use absolute integer
**project timeline frames**, with one point per frame per row. They affect every
clip on that row, including clips from different recordings and both participants
in that track's dissolve. They do not restart at a clip's IN, start or boundary.

Schema 10 requires `layers[].keyframes` as ordered `{ frame, interpolation, values }`
points, with **at most 256 points per row**. Frames are unique, strictly ascending,
non-negative and at most 2,147,483,647. Every point's `values` object (`LayerKeyValues`)
requires **all nine nullable fields** below: a number participates; `null` does not. Omitted/unknown
fields and all-null points are invalid, not repaired with defaults.

| Channel                   | Value          | Value when this channel has no row keys                 |
| ------------------------- | -------------- | ------------------------------------------------------- |
| Opacity (`opacity`)       | 0–1            | The row's required `opacity`, initially 1 on new tracks |
| Speed (`speed`)           | 0.1×–8×        | Each clip's constant/ramp/custom-keyframed speed        |
| Exposure (`exposure`)     | −3 to +3 stops | The row's saved colour value                            |
| Brightness (`brightness`) | −0.5 to +0.5   | The row's saved colour value                            |
| Contrast (`contrast`)     | 0–2            | The row's saved colour value                            |
| Hue (`hue`)               | −180° to +180° | The row's saved colour value                            |
| Saturation (`saturation`) | 0–2            | The row's saved colour value                            |
| Highlights (`highlights`) | −1 to +1       | The row's saved colour value                            |
| Shadows (`shadows`)       | −1 to +1       | The row's saved colour value                            |

The exact nine required value fields are `opacity`, `speed`, `exposure`,
`brightness`, `contrast`, `hue`, `saturation`, `highlights` and `shadows`.
Clip documents contain independent **constant, ramp or custom-keyframed**
speed and required `spatial: { base, keyframes }`, with no `opacity` field.
Shared row animation has no per-property row key arrays. Clip speed and spatial
keys use original-source frames in their separate clip-owned settings; neither
changes row-channel ownership or precedence. Spatial keys capture complete
eight-value poses, not nullable per-setting participation.
Trimming, restoring, moving, splitting and duplicating footage **never copy or
shift row points or change row Opacity**. Split/duplicate create independent source
ranges, colour, speed and deep-copied spatial settings, retaining original-source
ramp/clip-speed/spatial anchors, including off-trim and original exclusive-OUT keys.
A moved clip uses its destination row's saved Opacity or overriding curve and
animation; both rows' values and points stay where they were. Track Ripple also
leaves points anchored in project time. Removing the last participant of a channel
reveals its existing unkeyed value: row `opacity` for Opacity, row `colour` for colour,
and clip speed for Speed. Correction is never overridden by row keys.

Points beyond the current project duration remain stored and list-editable. They
are not constrained by any recording's length and are not discarded when footage
is shortened or removed. Retained points still define channel curves; their absence
from the visible timeline is not a request to ignore them during evaluation.
Moving a point beyond duration does **not** extend the sequence merely to display
it; Speed participation can naturally change actual clip durations through retiming.

## Independent channel interpolation

Participation is independent, including between the seven colour parameters.
Each point's easing is shared by its participants, but **each channel interpolates
to its own next participating point**, skipping points where that channel is null.
For example, Exposure at frames 10 and 30 interpolates across a Contrast-only point
at frame 20; that middle point does not interrupt Exposure's interval.

Before the first/after the last participating point, that channel holds its endpoint
value across the entire row. A single participating point therefore overrides the
channel everywhere. A channel with no participating points uses the values above,
even if other channels on the row are animated.

For normalized interval progress $u$, the **left participating point** supplies:

| Easing   | Progress                                           |
| -------- | -------------------------------------------------- |
| Hold     | 0 until the next participating point's exact frame |
| Linear   | $u$                                                |
| Ease in  | $u^2$                                              |
| Ease out | $2u-u^2$                                           |
| Smooth   | $3u^2-2u^3$                                        |

Colour interpolates **parameter values**, then grades the sampled source RGB.
It does not blend separately graded endpoint pictures; hue interpolates numerically
in degrees. Grade and Opacity coverage use **project time**, so they can change on
consecutive output frames even when slow motion holds the same source frame.

A participating Speed channel overrides each clip's whole constant/ramp/custom base.
Its analytic $ds = r(t)\,dt$ map uses absolute project time, rounds each clip's
duration once and never rescales point times/rates. Layout, preview and native
export use the same `PlacedClip.retiming`. See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md)
for the separate static source-ramp contract, placement-dependent durations and
repeat/drop sampling without optical flow.

## Editing keys

The dedicated **Keyframes** tab (accessible name **Layer keyframes**) contains
**one directly visible whole-row point list** for the selected layer, including an
empty row without a selected clip. It shows point
count, whole-row Previous/Next navigation, **Animation help** and participant chips
for the current or inspected stored point. The toolbar's Animation help includes
point-timing guidance, with no separate Keyframe timing help button.
The toolbar does not repeat the visible Keyframes tab title.
**Clip** keeps source/clip settings, row Opacity and the setting controls/diamonds
evaluated at the real playhead. Every animatable
setting always has its own diamond beside its main control, immediately
followed by native SVG Previous/Next buttons:

- **◇ Hollow**, `aria-pressed=false`: not participating at this project frame.
  It is still clickable, **not HTML-disabled merely because it is inactive**.
- **◆ Filled**, `aria-pressed=true`: participating at this frame. Clicking removes
  only that setting; other participants and the point's easing remain unchanged.
- The first enabled setting creates the row point, capturing its displayed value.
  Enabling another setting at that frame joins the same point. Removing the last
  participant deletes the point. Genuine invalid/draft interaction states can
  disable actions; hollow status itself cannot.

The setting's Previous/Next buttons visit **strictly earlier/later** points where
`values[setting] !== null`; zero is a participant, and points belonging only to
other channels are skipped. There is no wrap or revisit of the current point.
All nine settings keep both buttons visible, disabled when the relevant neighbour
is absent, no project is open, or any document-preview draft is active. Native Tab order is
diamond → Previous → Next → any existing reset control. Navigation preserves the
chosen Inspector tab and activated button's focus instead of forcing Clip, and
changes no document, history or autosave state.

**Clip → Colour** contains the single **Opacity** native slider/exact
`NumberField`/diamond/Previous/Next controls alongside the colour controls.
Its numeric value is **0–1**, initially **1**; the main label may show **100%**.
Without Opacity keys, either value control edits the selected row's `opacity`,
including on an empty row with no selected clip. Opacity navigation visits only
`opacity` participants.
**Clip → Placement** contains placement controls only. There is no duplicate
opacity control or navigation in Placement or the sidebar;
**Layer options** is limited to rename, Ripple, ordering and deletion. Stored Opacity
participants remain editable in the shared Keyframes list.
Unkeyed colour controls edit the selected row; sharing the Colour section
does not make Opacity per-clip or part of the SDR RGB grading transform. Opacity
controls composition coverage after grading.

Once a channel is animated anywhere on the row, its main Clip value control is
read-only at frames where that channel does not participate, including at points
belonging only to other settings. **Click its hollow diamond to capture a value before editing**.
Setting tooltips and screen-reader context say **Keyframe at playhead** for an
editable participant, or **Animated · add a keyframe to edit** for a read-only
animated value. Clip's Opacity, colour and Row speed animation use the same
terms and explain which diamond adds a keyframe at the current timeline frame.
Sliders/numbers never implicitly create keys. Unanimated Opacity edits the row's
saved `opacity`; unanimated colour edits row `colour`, and speed edits the selected clip.
On an empty row, Opacity and colour remain editable without keys and diamonds can create
animation for any channel; unkeyed speed requires a selected clip.

In **Keyframes**, the shared list has no outer disclosure or per-row list expansion
preference. Each shared row lists its participating setting dependencies and has
an inner **Time, easing & values** disclosure.
Its Timeline frame field moves
**every participant and the point's existing easing together in one Undo step**;
Shared easing affects all of them, each toward its own next participating point.
The native easing selector shows a compact graph of the selected progress shape:
time runs left to right and value progress bottom to top. Hold stays flat until
the exact next point, then jumps. The graph adds no focus stop; its text description
is available with the selector. Native option hover does not preview an unselected shape.
The trash-icon delete action removes the whole point; × only closes or dismisses.
Time/value fields apply on Enter/blur, Escape restores, and frame collisions/invalid
values/timing are rejected atomically,
never merged or overwritten. Reordering and Undo preserve drafts and field identity/focus
without adding persisted point IDs; nested point details remain collapsible.
This remains one list, not a new list per channel or marker.

Main and stored colour/Opacity controls share a native slider with one adjacent
exact `NumberField` as the value display, not a read-only output. Stored participants
reuse the same bounds and individual colour-reset buttons; Opacity numeric entry
uses **0–1** in both contexts. The channel table's bounds apply to both controls.
Stored Speed uses the same **Layer rate ×** slider/exact field and Reset to 1× as
main row Speed, never a clip mode, preset or source-frame curve editor.

For main and stored value sliders, pointer movement changes only a transient local
control draft, not the document or preview. Release applies one validated edit and
updates the image. Escape, pointer cancellation, lost capture or window blur restores
the starting value without save/history; each keyboard slider adjustment is an
individual validated edit. The full value-control contract is in
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md#numbers-titles-and-animation).

Only existing non-null participants get value editors. Each accepted value/reset
changes that participant at its stored frame in **one Undo step**, without changing
point time, shared easing, other participants/points, row `opacity` or clip settings,
and without requesting a seek. No slider, numeric edit or reset implicitly joins a channel.
Numeric drafts preserve entered precision; empty, nonfinite, out-of-bounds and
contextually invalid values remain editable with inline errors, never silently
clamped or rounded. A Speed timing conflict rejects the edit without shortening
fades/transitions or discarding another participant.

All stored points, including those outside current duration or on an empty row,
remain editable in this list. Setting buttons, row Previous/Next, marker navigation
and list time buttons share **one editor-only stored-point inspection cursor**.
Successive navigation advances from that stored time, so several off-duration
points can be inspected even when every seek clamps to the same last preview frame.
The point stays stored at its own time; without any video or music duration there
is no preview frame. A music-only region has a real project frame with a black picture.

Labels distinguish stored time from the actual preview/playhead. List fields target
their stored point, while Clip's setting values, diamond state and diamond capture
**always use the real playhead**, never a fictional off-duration editing frame. Manual seeks
(even to the same clamped frame), playback, row/project changes and deletion of the
inspected point clear inspection. A still-valid single-point move and Undo retain
the cursor and list input identity. **Follow playhead** explicitly ends inspection;
the cursor is not a saved project field or an Undo operation.

Speed's clip modes include **Constant speed / Ramp up / Ramp down / Custom curve**.
Custom supplies 2–256 original-source points owned only by that clip. Clip curves
never automatically add row participants. When Speed is keyed on the row, its
row-rate control overrides clip speed. In Clip, Reset to 1× changes only the active
Speed participant; it never clears other points/participants or overwrites the
saved clip base. Colour
resets likewise target only enabled colour values at the current point; individual
resets can edit unanimated row-base channels. In Keyframes, each reset instead
targets its existing stored participant, even when that point is outside duration.

## Timeline markers and ruler

There is **one marker per stored row point**, even across multiple clips or a
dissolve, not one marker per channel/clip. Its title names the row, project time
and participants; the panel exposes chips/dependencies. **Click or Enter** selects
the row and seeks without editing or changing the Inspector tab. Whole-row point
navigation also retains that tab. Points after the last clip keep their marker at
their own project time, like points before the first clip. The scrollable timeline
widens to reach the last stored point, but duration, playback and seeking still end
at the last project frame, determined by the maximum video/music OUT, not points.
Selecting such a marker inspects that stored point (preview
shows the nearest available frame), highlights it and changes nothing.
The shared Timeline frame field remains available.

**Drag the marker horizontally to move the whole point:**

- Pointer capture snapshots the committed project, row/point, zoom, grabbed pointer
  position, horizontal scroll and stationary playhead. Movement uses that original
  geometry plus scroll travel, rounds the frame delta once and clamps the result
  to **0–2,147,483,647**; live retiming never becomes a new gesture origin.
- Each destination is validated against the captured project. A valid draft updates
  geometry and paused preview, but does not alter the committed document, history
  or autosave. Release moves **all participants with their values and easing intact**
  in one Undo step; an unchanged point creates no history entry.
- Snap uses captured clip/music/transition boundaries and the captured playhead,
  within **eight pixels at the captured zoom**. Alt bypasses it. Horizontal edge
  autoscroll uses the same base geometry; neither row switching nor automatic row
  reveal relocates the gesture.
- Occupied frames produce a **red invalid ghost**, even when the other point has
  unrelated channels. Points are **never merged or overwritten**. Invalid release
  reports the reason and changes nothing; it cannot commit an earlier valid draft.
  Returning to a free valid frame permits committing that final destination.
- A Speed participant may recompile contextual durations. Any resulting overlap,
  fade or transition conflict rejects the **entire point move**; transitions are
  not shortened and no participant is moved separately.
- Escape, pointer cancellation, unexpected lost capture or window blur rolls back
  preview, document and horizontal scroll, with no draft save or history entry.

On a focused marker, **Left/Right** moves one project frame and **Shift+Left/Right**
moves ten, with the same atomic validation and no snapping. Focus and the inspected
point cursor follow the move. Movement navigates to the point without also firing
ordinary playhead-step or clip-nudge shortcuts, or leaking other editor shortcuts.
Dragging can reach beyond duration, but retaining that point never extends the
sequence merely for its marker. No other row's points/values, clip settings/source ranges or
music are copied or shifted; Speed's contextual duration recompilation is the
natural timing exception. There is no cross-row point move.

The thin strip above video rows is the **time ruler**: separators/ticks denote
TIME, and click/drag seeks the playhead. The separate **Cut / Fade / Dissolve**
buttons explicitly open Sequence for their own track's boundary transition controls.
Neither ruler ticks nor those transition buttons are keyframe markers.

## Group composition

Enabled layer groups are composited bottom-to-top over opaque black in encoded
BT.709 RGB, after each source has its evaluated grade. For group sources $i$, let
$w_i$ be dissolve weight, $o_i$ evaluated Opacity, $b_i$ black-fade brightness,
$m_i$ spatial source coverage at the pixel and $G_i$ graded
RGB. Each track's dissolve is **one** group, not two source-over layers; several
tracks may dissolve simultaneously:

- Premultiplied group RGB: $C = \sum_i G_i b_i o_i w_i m_i$.
- Group coverage: $A = \sum_i o_i w_i m_i$.
- Source-over: $\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no additional layer multiplier.

Preview, CPU numeric tests and native layered export share this sampling/composition
contract. Each source's grade and row Opacity are evaluated at the same project frame.
With no Opacity participants, each source uses the row's required `opacity` value;
otherwise the sole `opacity` curve overrides it for every source, including both
dissolve participants. This is one evaluated setting per row, applied inside the
group sums, not another multiplier after composing the group. Opacity is coverage,
not a parameter of SDR RGB grading; unkeyed colour is row-owned. Black fades
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

## Source review and derushing

Hover over a **prepared** recording in Media. Its review button's width maps mouse X
to original frames 0 through `frameCount − 1`; a marker follows the mouse and the
source viewer, docked in the centre's **Source preview** tab, shows the observed paused
frame. Pin keeps that source selected while hovering other rows. It uses one muted decoder,
does not change timeline position, and suppresses stale imagery while loading/seeking.
The open project's bin contains explicitly imported videos/music plus its timeline
references, not all global registrations. New projects have empty membership;
imports deliberately add to the selected bin and reuse the shared content-deduplicated
registry/cache. Removing excerpts does not discard imported rushes.
User library imports/additions automatically queue eligible proxies; ready/active
work is reused. Startup and hovering unprepared sources do not launch hidden
preparation jobs or play originals. Cancelled/failed preparation requires an explicit retry.

Set source IN/OUT with review handles, numeric **Apply**, **Mark IN/OUT**, or **I/O**
while the review controls are focused. OUT is exclusive: Mark OUT selects through
the visible frame (`OUT = frame + 1`). At least one original frame is retained.
Reset restores 0/full frame count. Handle drafts commit only on release; Escape,
pointer cancellation, lost capture or window blur discards them and restores the
prior source frame. Labelled 30 × 28 px IN/OUT targets and omitted-footage hatching
distinguish trimming from the separate source scrubber.

Source **Play / Pause** stays muted and uses the applied IN/OUT, not numeric drafts.
It starts at the current observed frame when inside the range and before its last
frame, otherwise IN; it stops and exact-seeks OUT − 1, without looping. A one-frame
range displays that frame without playing. Scrub/trim/mark/Apply/Reset pause first.
Pending play and observed callbacks cannot restart after close, hidden viewer,
recording/project change or tab switch. Playback uses this same sole verified proxy
decoder, with explicit start/stall failures after five seconds and Retry; no source
audio/original playback, preparation, timeline/music seek or history/save is added.

Plus, double-click, drag/drop and selected-batch insertion copy the latest choice
into a new independent timeline instance. Without a choice they select the full
source. Later derushing choices do **not** alter already inserted excerpts, original
files or full proxies. The viewer stays out of list flow so hovering cannot move
the row or disrupt a media drag. Timeline insertion/selection returns to Timeline preview;
the source remains available through its tab until closed or the project changes.

Choices are validated per-project browser-local editor state, separate from
autosave/undo/rendered documents. They survive reload in that browser, reset on a
new project, and do not follow a project copied to another browser. Close/hidden/
offscreen/unmount/project-switch releases the review decoder.

## Inspector and resource limits

The inspector uses **Clip / Keyframes / Sequence / Audio** tabs; Keyframes retains
the accessible name **Layer keyframes**. Source range,
Placement (placement only), Speed, Transform, Colour (including the sole row Opacity control)
and playhead diamonds belong to Clip. The shared point list is directly visible in Keyframes,
with Animation help, participant chips
and whole-row point navigation. Keyframes and Sequence have no redundant
selected-track banner. The selected track's Transition/Sequence fades belong to
Sequence; Music belongs to Audio, with detailed **Placement & fades**.
Sections retain their expansion in local browser storage.
New defaults collapse detailed source, placement, speed and Transform controls, while Colour stays
open. Existing section preferences are not reset. **Expand all / Collapse all**
appears only in Clip and affects its five top-level sections: Source range,
Placement, Speed, Transform and Colour. Sequence, Audio, nested point disclosures and
help remain unchanged; the shared list has no expansion preference.
Hidden tab/section content stays mounted, retaining valid/invalid drafts within
the same editing context. Row/clip changes refresh that context safely rather than
applying its former drafts to another selection. Collapse or switching tabs never
disables processing or changes the rendered document. Options menus and automatic
proxy admission remain unchanged.

Preview uses two reusable decoder/texture slots per track, up to **16 for eight
tracks**, supporting independent simultaneous dissolves. Unused slots are available
for preloading. Source review adds at most one decoder while visible. No decoder or
texture is allocated per stored clip.

Up to **eight identified music instances** share one AudioContext/AudioWorklet and
one output timestamp clock with the unchanged one-project-frame A/V bound.
Sources are read/accumulated serially into a single mixed stream: per-instance
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
The plain static single-layer path retains at most two lossless clips, two
intermediate decoders and one reusable RGB frame (24.9 MB UHD), plus native memory.

The static fast path is eligible only with neutral HSL/identity colour curves and one enabled track with row Opacity 1,
no row points, exactly neutral clip spatial bases and no spatial keys, a zero first
start and no internal gaps, covering the **full project duration**. Music beyond
video OUT requires layered export's trailing black spans,
not a held last image. Ripple itself is not
an eligibility requirement. Other valid timelines, including any speed-only or
neutral row point or any spatial edit/key (even neutral keys), use the generalized
layered path; static planning rejects them.
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
CPU grading (seven scalar controls, HSL, master/RGB curves), not a LUT; neutral
advanced settings retain scalar LUT grading. Exact grading uses tiny RGB triples
and can substantially slow UHD export; no transformed image/mask buffer or
per-frame native process is added. The 22 bytes/pixel, two-LUT and process bounds
above remain unchanged.

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
consumed inputs are deleted before the next instance. Advisory audio disk planning
is **maximum selected PCM size + two full-project Float64 stereo timelines**,
not all sources or loop repetitions. It grows with duration and is additional to
the unchanged video raw-buffer/child/LUT bounds above. Cancellation/failure removes
only owned scratch, never originals, saved projects or successful outputs.

Schema **v11 is strict**, including required row `colour`, no clip colour/correction fields, and clip `spatial` base/eight-value full-pose
source-frame keys and required unique `media.videoIds` / `media.audioIds`
arrays, at most 10,000 IDs each, and all required per-track settings. Project-level
transitions/fades, saved `clip.opacity` and old `clipOpacity`/`layerOpacity` point
channels are not accepted. `VideoLayer.opacity` is the required sole stored row
value, a number in 0–1; 1 is a new-track initial value, not a missing-field default.
Points require exactly the nine nullable fields listed above, including `opacity`.
The required `music` array contains 0–8 independent instances with unique required
IDs and complete source IN/OUT/start/duration/gain/fades/loop fields; `[]` without
music, never a null/singular value or default. Version-1 export receipts require
a strict v11 snapshot plus captured audio-source/instance-plan arrays.
Older v1–v10 project documents and export receipt snapshots remain unchanged/incompatible;
there are no migrations, compatibility fallback/default fields or automatic deletion
of projects, receipts or successful videos. Create a new project and deliberately
import its media; registered media and currently verified ready proxies remain reusable.
Registry/proxy/current PCM formats and source identity checks are unchanged.
Confirmed project deletion removes only its saved document, preserving originals,
the shared registry/proxy cache and exports/receipts. The live v3 sample appearing
incompatible is expected, not a reason to rewrite it.

Workspace layout, field commits and recovery controls are specified in
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).
