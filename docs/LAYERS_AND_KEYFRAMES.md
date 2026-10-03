# Layers, shared row points and source review · project v5

## Video layers

The document stores one to eight layers **bottom-to-top**. The sidebar shows the
visual top layer first. Video 1 is the primary layer: it cannot be removed or moved
above an overlay. Its insert/delete/reorder/trim commands retain ripple behavior,
and cut/fade-through-black/dissolve boundaries and sequence fades belong to it.

Other layers contain independently positioned excerpts. Their starts are absolute
non-negative project frames, not derived from the primary sequence. Gaps reveal
lower footage; clips on one overlay row cannot overlap. Place simultaneous footage
on different layers. Moving or speeding one overlay does not move its neighbours;
invalid overlap is rejected atomically. Left-edge handle/keyboard trims solve an
overlay's new start to retain its timeline OUT. If integer source/project-frame
quantisation cannot represent that OUT, the trim is explicitly rejected, not
silently shifted. Numeric IN/OUT/reset retain its start.

**+ Layer** creates/selects an overlay. Sidebar controls select and hide/show;
**Layer options** contains rename, static opacity, raise/lower and delete. Layer
names apply on Enter/blur, Escape restores, and a rename is one Undo step. Selecting
an empty row retains both its **Layer keyframes** context and the target for Media
**+**/double-click/batch insertion. A populated layer selects its first excerpt and
reveals its row without changing placement. Media drops target the row under the
pointer; overlay drops use the frame under it, while primary drops ripple-insert
at a boundary.
Drag existing excerpts between rows, or use Clip → Layer & opacity. Deleting a layer
and its clips is one undoable command. Existing moves preserve the grabbed offset
and show the actual final placement ghost, including duration at the destination
row/time; red invalid placements are not committed. Primary rows remain ripple-edited
even with snapping disabled. Overlay frame nudges and duplication retain the same
non-overlap validation and static source-ramp anchors; they never copy row points.

Visibility and layer opacity are renderable state, not preview-only switches.
Disabled layers do not decode/draw, but their placements still contribute to total
duration; an entirely hidden tail therefore exports black. Layer opacity multiplies
the complete layer group once. Each clip has an independent static opacity base;
a row's Clip opacity curve overrides it on **every** clip in that row. Black
transitions/fades darken the primary's RGB without removing its alpha coverage;
they do not dim an upper layer.

## Strict shared-point model

**A video row/layer owns the animation, not a clip.** All points use absolute integer
**project timeline frames**, with one point per frame per row. They affect every
clip on that row, including clips from different recordings and both participants
in a primary dissolve. They do not restart at a clip's IN, start or boundary.

Schema 5 retains `layers[].keyframes` as ordered `{ frame, interpolation, values }`
points, with **at most 256 points per row**. Frames are unique, strictly ascending,
non-negative and at most 2,147,483,647. Every `values` object requires **all ten
nullable fields** below: a number participates; `null` does not. Omitted/unknown
fields and all-null points are invalid, not repaired with defaults.

| Channel | Value | Base when this channel has no row keys |
| --- | --- | --- |
| `layerOpacity` | 0–1 | Layer's static `opacity`, after group composition |
| `clipOpacity` | 0–1 | Each clip's static `opacity`, before group composition |
| `speed` | 0.1×–8× | Each clip's static constant/ramp speed |
| `exposure` | −3 to +3 stops | Each clip's static colour value |
| `brightness` | −0.5 to +0.5 | Each clip's static colour value |
| `contrast` | 0–2 | Each clip's static colour value |
| `hue` | −180° to +180° | Each clip's static colour value |
| `saturation` | 0–2 | Each clip's static colour value |
| `highlights` | −1 to +1 | Each clip's static colour value |
| `shadows` | −1 to +1 | Each clip's static colour value |

Clip documents contain static colour/opacity and **constant or ramp** speed only.
There is no clip animation object, source-speed-key mode or per-property key array.
Trimming, restoring, moving, splitting and duplicating footage **never copy or
shift row points**. Split/duplicate create independent source/static bases, retaining
original-source ramp anchors. A moved clip uses its destination row's animation;
the old and new rows' points stay where they were. Primary ripple also leaves
points anchored in project time. Removing the last participant of a channel reveals
its existing static base; it does not replace that base with the deleted value.

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
channel everywhere. A channel with no participating points uses the bases above,
even if other channels on the row are animated.

For normalized interval progress $u$, the **left participating point** supplies:

| Easing | Progress |
| --- | --- |
| Hold | 0 until the next participating point's exact frame |
| Linear | $u$ |
| Ease in | $u^2$ |
| Ease out | $2u-u^2$ |
| Smooth | $3u^2-2u^3$ |

Colour interpolates **parameter values**, then grades the sampled source RGB.
It does not blend separately graded endpoint pictures; hue interpolates numerically
in degrees. Grade/opacity evaluation uses **project time**, so it can change on
consecutive output frames even when slow motion holds the same source frame.

A participating Speed channel overrides each clip's whole constant/ramp base.
Its analytic $ds = r(t)\,dt$ map uses absolute project time, rounds each clip's
duration once and never rescales point times/rates. Layout, preview and native
export use the same `PlacedClip.retiming`. See [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md)
for the separate static source-ramp contract, placement-dependent durations and
repeat/drop sampling without optical flow.

## Editing keys

The Clip tab contains **one Layer keyframes panel** for the selected layer,
including an empty row without a selected clip. It shows point count, Previous/Next
navigation and participant chips for the current or inspected stored point. Every
animatable setting always has its own diamond beside its control, immediately
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
All ten settings keep both buttons visible, disabled when the relevant neighbour
is absent, no project is open, or any document-preview draft is active. Native Tab order is
diamond → Previous → Next → any existing reset control. Navigation changes no
document, history or autosave state.

The duplicate Layer opacity diamond/buttons in the sidebar's **Layer options** use
the same context. They select their own row and open the Clip inspector, including
an empty row, without stealing focus from the activated navigation button.

Once a channel is animated anywhere on the row, its value control is read-only at
frames where that channel does not participate, including at points belonging only
to other settings. **Click its hollow diamond to capture a value before editing**.
Sliders/numbers never implicitly create keys. Unanimated channels edit the selected
clip's static base, or the layer base for Layer opacity. On an empty row, diamonds
can create animation; clip-base editing requires a selected clip.

Expand **Edit points**. Each shared row lists its participating setting dependencies
and has an inner **Time, easing & values** disclosure. Its Timeline frame field moves
**every participant and the point's existing easing together in one Undo step**;
Shared easing affects all of them, each toward its own next participating point.
Numeric values edit existing
participants only. The row delete action removes the whole point. Time/value fields
apply on Enter/blur, Escape restores, and frame collisions/invalid values/timing
are rejected atomically, never merged or overwritten. Reordering and Undo preserve
field identity/focus without adding persisted point IDs; list expansion is remembered
per project/layer. This remains one list, not a new list per channel or marker.

All stored points, including those outside current duration or on an empty row,
remain editable in this list. Setting buttons, row Previous/Next, marker navigation
and list time buttons share **one editor-only stored-point inspection cursor**.
Successive navigation advances from that stored time, so several off-duration
points can be inspected even when every seek clamps to the same last preview frame.
The point stays stored at its own time; an empty timeline has no frame to preview.

Labels distinguish stored time from the actual preview/playhead. List fields target
the stored point, while setting values, diamond state and diamond capture **always
use the real playhead**, never a fictional off-duration editing frame. Manual seeks
(even to the same clamped frame), playback, row/project changes and deletion of the
inspected point clear inspection. A still-valid single-point move and Undo retain
the cursor and list input identity. **Follow playhead** explicitly ends inspection;
the cursor is not a saved project field or an Undo operation.

Speed's base mode remains **Constant speed / Ramp up / Ramp down**, with no
Keyframes option or automatic endpoint keys. When Speed is keyed, its row-rate
control replaces base editing. Reset to 1× changes only the active Speed participant;
it never clears other points/participants or overwrites the saved clip base. Colour
resets likewise target only enabled colour values at the current point; individual
resets can edit unanimated clip-base channels.

## Timeline markers and ruler

There is **one marker per visible row point**, even across multiple clips or a
dissolve, not one marker per channel/clip. Its title names the row, project time
and participants; the panel exposes chips/dependencies. **Click or Enter** selects
the row and seeks without editing. Off-duration points stay in the list rather
than being duplicated inside clips. The shared Timeline frame field remains available.

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
point cursor follow the move; if it no longer has a visible marker, focus stays in
Timeline. Movement navigates to the point without also firing ordinary playhead-step
or clip-nudge shortcuts, or leaking other editor shortcuts.
Dragging can reach beyond duration, but retaining that point never extends the
sequence merely for its marker. No other row's points, clip/source/static bases or
music are copied or shifted; Speed's contextual duration recompilation is the
natural timing exception. There is no cross-row point move.

The thin strip above video rows is the **time ruler**: separators/ticks denote
TIME, and click/drag seeks the playhead. The separate **Cut / Fade / Dissolve**
buttons open primary-boundary transition controls. Neither ruler ticks nor those
transition buttons are keyframe markers.

## Group composition

Enabled layer groups are composited bottom-to-top over opaque black in encoded
BT.709 RGB, after each source has its evaluated grade. For group sources `i`, let
`wᵢ` be dissolve weight, `oᵢ` clip opacity, `bᵢ` black-fade brightness and `Gᵢ` graded
RGB. The primary dissolve is **one** group, not two source-over layers:

- Premultiplied group RGB: `C = sum(Gᵢ × bᵢ × oᵢ × wᵢ)`.
- Group coverage: `A = sum(oᵢ × wᵢ)`.
- With layer opacity `l`, source-over: `result = l × C + lower × (1 − l × A)`.

Preview, CPU numeric tests and native layered export share this sampling/composition
contract, unchanged by schemas 4 and 5. Each source's grade/clip opacity and the complete
group's layer opacity are evaluated at the same project frame. Full opacity/neutral
settings preserve the original single-track behavior. Native LUT interpolation and
final H.264/YUV quantisation are approximations, not bitwise shader equivalence;
prior evidence and current verification status are separated in
[DELIVERY_STATUS.md](DELIVERY_STATUS.md). See [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md)
for the unchanged equations.

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
pointer cancellation or lost capture discards them.

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

The inspector uses **Clip / Sequence / Audio** tabs. Source range, Layer & opacity,
Speed, Colour and the shared **Layer keyframes** panel belong to Clip;
Transition/Sequence fades belong to Sequence; Music belongs to Audio, with detailed
**Placement & fades**. Sections retain their expansion in local browser storage.
New defaults collapse detailed source, layer and speed controls, while Colour stays
open. Existing preferences are not reset. **Edit points** and inner disclosures keep
dependencies visible without opening every field. Collapse or switching tabs never
disables processing or changes the rendered document. Options menus and automatic
proxy admission remain unchanged.

Preview uses two reusable decoder/texture slots for one layer and up to nine for
eight layers (primary dissolve plus seven overlays), with unused slots available
for preloading. Source review adds at most one decoder while visible. No decoder or
texture is allocated per stored clip.

Any shared row point, including a speed-only or neutral-valued point, requires the
layered native path; the plain static chunk plan rejects it. That pipeline remains
sequential, with one original decoder, at most two intermediate readers and one
encoder. RGBA16 premultiplied accumulators preserve
coverage between layers; final H.264 is encoded once. Three reusable raw buffers
total 116,121,600 bytes at UHD; two 65³ float LUTs add 6,591,000 bytes, with native
codec/pipe/filter memory additional. Two clip files and at most two complete
timeline representations coexist. Scratch is duration-dependent, not fixed in GB.
Animated LUT generation/CPU passes can be slow. Prior short synthetic UHD evidence
does not qualify this update's native parity, long-flight throughput or intended-GPU
performance. The completed 886-test no-copy milestone is historical evidence;
full-suite reporting for marker movement/channel navigation remains pending in
[DELIVERY_STATUS.md](DELIVERY_STATUS.md).

Schema **v5 is strict**, including required unique `media.videoIds` / `media.audioIds`
arrays, at most 10,000 IDs each. Older v1/v2/v3/v4 project documents and export receipt snapshots
remain unchanged/incompatible; no migrations, compatibility fallback/default fields
or automatic successful-video deletion occur. Create a new project and deliberately
import its media; registered media and currently verified ready proxies remain reusable.
Confirmed project deletion removes only its saved document, preserving originals,
the shared registry/proxy cache and exports/receipts. The live v3 sample appearing
incompatible is expected, not a reason to rewrite it.

Workspace layout, field commits and recovery controls are specified in
[WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).

