# Clip grades, adjustments and Opacity

Colour belongs to **clip grades** and **adjustments**; video tracks have no Colour. Opacity is a
setting of the video track's Transform. Every grade has the complete Colour: twelve graded scalar
settings, including Temperature, Tint, Vibrance, Whites and Blacks, the HDR look and Local contrast
(applied before grading with the clip detail filters; see
[detail filters](DETAIL_FILTERS.md#hdr-look)), eight static HSL bands and four master/RGB colour
curves. HSL/curves add no keyframe channels. Scalar keyframes override their own values only;
advanced colour remains active. Exact gain math and complete SDR order:
[Temperature/Tint](TEMPERATURE_AND_TINT.md) and [HSL/curves](HSL_AND_CURVES.md). Decisions:
[clip grades and adjustments](CLIP_GRADES_AND_ADJUSTMENTS.md).

## Ownership and strict storage

Every clip requires `grade: { colour, keyframes }` and every project requires `adjustments`.
Both kinds of `colour` have the same fields, bounds and neutral values: the twelve scalar settings,
`hdr`, `localContrast`, `hsl` and `curves`, without Opacity or Transform. New clips and new
adjustments are neutral. Temperature (−2…2) and Tint (−1…1) are neutral at 0 and animate
independently. Positive Temperature warms; positive Tint adds magenta. Nonzero settings
intentionally colour greys; normalized linear gains precede Exposure, preserving neutral-white
linear luminance before clipping only, not arbitrary/final images.

A video track owns its Transform (with **Opacity**), Ripple, transitions and fades. It has no
`colour`, `opacity` or `keyframes` field, and saved `clip.colour` and `clip.correction` are
invalid. No optional legacy field, additive parameter merge or default-on-load exists. Projects
and export receipt snapshots saved before the current schema, with track Colour, are rejected
with the reason and left unchanged; there is no upgrade. Receipt format remains 1 with strict
current-schema snapshots; proxy and PCM formats are unchanged, and the registries are version 2
(full-content checksums).

Grade keyframes are `{ frame, values, easing, reset }` with fourteen nullable Colour channels, in
control order: `temperature`, `tint`, `exposure`, `brightness`, `contrast`, `hue`,
`saturation`, `vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`, `localContrast`.
Each enabled setting has its own Easing; `reset` marks a
[default keyframe](../LAYERS_AND_KEYFRAMES.md#default-keyframes). Missing fields are invalid,
never defaulted. Each setting skips keyframes without it, interpolates its values with its own
Easing at the left keyframe and holds its endpoints; removing its last keyframe reveals the
unchanged base. HSL and curves remain static. Speed is clip-only and never a grade setting.

## Clip grades

A clip grade is what one shot needs. It belongs to the clip
([#273](https://github.com/Plonk42/PasCap/issues/273), decisions in
[clip grades and adjustments](CLIP_GRADES_AND_ADJUSTMENTS.md#clip-grade-owner)):

- `keyframes` are at most **64**, at **original-source frames** of the recording (0 to its frame
  count). Keys outside the trim are kept, like off-trim speed keys.
- The grade is evaluated at the clip's continuous source position (one frame lower when
  reversed, so a key applies fully as its image appears): slow motion eases between keys and a
  reversed clip plays its keys backwards.
- Trims, moves (to another track too), Ripple, splits, cuts, duplicates, Reverse and Move to new
  track keep the grade with its footage; split, cut and duplicate copy it.
- Commands: `colour` (with `clipIds`, several clips at once), `colour-setting`, `hsl-band`,
  `colour-curve` and the `layer-key-*` keyframe commands take a `clipId`; their frames are then
  source frames.

## Adjustments

An adjustment is what happens at a moment of the film: one grade of **every video track** over
a project-time range. The project's `adjustments` hold at most **64** items
`{ id, start, duration, colour, keyframes }`, in timeline order and never overlapping. An item
grades `[start, start + duration)` with hard edges, after each clip's grade. A look for one track
only is a clip grade.

- Its keyframes (at most **64**) have the clip grade's shape, with frames counted from its start
  (0 is its first frame) and always lie within its range: to key later frames, make the item
  longer first. A move or trim that would leave a keyframe outside is refused with the reason.
- Items keep their project frames when clips are trimmed, moved, rippled, split or deleted: they
  never follow clips. They never extend the project duration.
- Commands: `adjustment-add` (`adjustmentId`, `start`, `duration` and optional `settings`, the
  scalar Colour settings it starts with; the others neutral),
  `adjustment-remove`, `adjustment-range` (new `start` and `duration`; with `keyframes: 'move'`
  the keyframes move with the item, with `'stay'`, a trim, they keep their project frames) and
  `adjustment-split` (at a project `frame` inside it, the second piece named `newAdjustmentId`;
  each piece keeps the keyframes within its range). The
  Colour and `layer-key-*` commands take an `adjustmentId`, with frames counted from its start.
  An overlap or a 65th item is refused with the reason. Each edit is one Undo step. The assistant
  has every one of them.

For example, clips A and B on two tracks under one adjustment with Exposure 0.5 both get that
Exposure after their own grades, including in a dissolve; an adjustment keyframe at its frame 30
moves with the item.

## Opacity

**Opacity** is the ninth Transform setting of a video track: `transform.base.opacity` in 0–1
(new tracks 1) and the nullable `opacity` setting of Transform keyframes, with its own Easing
([track Transform](SPATIAL_TRANSFORMS.md)). It is the coverage $o_i$ of every clip on the track,
both dissolve sources included, not part of any grade. A default Transform keyframe and **Reset
transform** return it to 1. The exact neutral pose, which keeps the opaque black letterbox, is
about geometry only: a track at 50% Opacity with untouched geometry keeps that path.

## Rendering

Let `grade` be the encoded BT.709 SDR transform, including scalar, HSL and
master/RGB curve stages. Each source is graded by its clip's grade $c$ at its source position $s$,
then by the adjustment $a$ covering the project frame $t$ (neutral without one):

$$G_i=\mathrm{grade}(\mathrm{grade}(RGB_i, c(s)), a(t)).$$

Each grade ends with its own clipping and encoding; settings are never summed into one grade.
The local tone settings (HDR, Local contrast, Shadows, Highlights) of both grades are summed,
within their ranges, for the one detail-kernel pass before grading, and Shadows/Highlights choose
tones after the summed Exposure. A dissolve's two sources share the adjustment at that frame. An
exactly neutral grade is skipped: a clip with a neutral grade and no adjustment returns its input
unchanged. Grading precedes black fades, dissolve group sums and Opacity/coverage. The Original
preview neutralizes clip grades, adjustments and clip Detail (or, with a modifier, only one of
the two kinds of grade), preserving observed frames, retiming, geometry, Opacity, fades, stacking
and music. Appearance edits do not restart unchanged media or alter timing. Texture, decoder and
full-frame buffer counts stay unchanged.

Static export requires no adjustments and every clip grade unkeyed, scalar-only and without
local tone, on one enabled track with Opacity 1, a neutral Transform without keyframes and
neutral Detail, contiguous from frame 0 and covering the project duration. Each clip then gets
one 65³ scalar LUT of its grade. Any adjustment, keyed or advanced clip grade, local tone,
Opacity other than 1 or Transform edit/keyframe requires composited export, which composes each
source's two scalar grades into one LUT (its cache identity is the pair) or grades exactly in
sequence. Scalar-only composited grades use evaluated parameters and at most two reused LUT
arrays. Advanced grades evaluate the complete scalar/HSL/curve transform exactly on the
fractional sampled RGB. Source/frame compilation determines neutral stages once,
without approximating curves or introducing a full-frame buffer, decoder or
per-frame FFmpeg invocation.
The native 22 bytes/pixel/four-buffer and serial child-process budgets remain unchanged.
Scalar LUT interpolation and H.264 quantisation remain measured approximations,
not bitwise shader equivalence. Sharp curves are tested after production-resolution
input scaling: grading and resampling do not commute. The two-clip diagnostic reference accepts
unkeyed scalar clip grades without HSL, curves or local tone, and rejects adjustments and
Transform or Opacity edits; the measurement helper needs the same static clip grades.

## Properties and history

The Colour sections live in the **Colour** Properties tab (**Clip / Colour / Track / Audio**). It
edits the grade of what is selected on the timeline, named in its pinned header:

- A selected **clip**: its grade. The header names its recording and its place (**Clip 2 of 3 ·
  Track 1 · this clip only**). A small colour wheel before a clip's name on the timeline marks a
  clip with its own grade (any setting off neutral, or keyframes).
- A selected **adjustment**: named by its range (**Adjustment 01:12:05 – 01:20:00**) with
  **Every track within this range** and a trash, **Delete adjustment**, which removes it and its
  keyframes. Adjustments are created on the adjustment track
  ([timeline](../TIMELINE_EDITING.md#adjustment-track)).
- Nothing selected: a hint to select a clip or an adjustment. Several clips or adjustments
  selected: the tab asks to select one; **Paste grade** sets the same grade on all of them.

Clicking a clip grade or adjustment keyframe marker on the timeline selects its owner. Both show
the same Colour, **HSL ranges** and **Colour curves** sections; only
a clip grade has **Auto** and **Auto white balance**
([#285](https://github.com/Plonk42/PasCap/issues/285)).

- A clip grade's diamonds key the source frame shown at the playhead (unavailable, with the
  reason, when the playhead is off the clip); its list is **Clip keyframes**, in source frames,
  and its keyframes are amber ◆ markers inside the clip on the timeline. Its sliders show the
  grade the image uses, which eases between source frames in slow motion; only a setting keyed at
  the playhead's source frame shows that keyframe's own value, which it edits, while the image
  may already be slightly past it.
- An adjustment's diamonds key its frame at the playhead (unavailable outside its range); its list
  is **Adjustment keyframes**,
  counted from its start (**Frame in adjustment**), and **Go to adjustment keyframe N** seeks the
  keyframe.

**Copy grade** and **Paste grade** in a clip's or an adjustment's context menu copy a grade without
keyframes and replace the right-clicked one's grade (or every selected clip's and adjustment's, when
it is selected), removing
its keyframes, in one Undo step. Holding **Original** bypasses every grade and Detail; with
**Shift** only clip grades and Detail, with **Alt** only adjustments; its badge names the mode.

Control vocabulary follows the [editor control catalogue](EDITOR_CONTROLS.md#vocabulary).

The Colour section has fourteen main widgets: the twelve graded scalar controls, HDR and Local
contrast, with existing slider/exact-field/reset controls. They sit in three static groups, each
a labelled fieldset with a small heading: **Colour** (Temperature, Tint, Hue, Saturation,
Vibrance); **Light** (Exposure, Brightness, Contrast, Highlights, Shadows, Whites, Blacks);
**Effects** (HDR, Local contrast). This visible order differs from the storage and keyframe
channel order, which is unchanged. Each heading's Reset icon (**Reset the Light group**, etc.)
resets the group's editable settings in one Undo step, as their own Reset icons would: an unkeyed
setting's value, a keyed setting's keyframe at the playhead; read-only animated settings stay
unchanged. It is dimmed at the defaults.
Main capture diamonds are always visible; each retains adjacent per-setting **Previous/Next**
buttons because not every setting is enabled at every keyframe. The keyframe line holds the
keyframe count, one Previous/Next pair over every keyframe of the grade, **Reset**, the default
keyframe toggle and, for a clip grade, **Auto**. Enabled setting chips in stored keyframe rows
retain their per-channel arrows. All per-channel arrows visit strictly earlier/later keyframes
where that channel is nonnull (zero is enabled): the main ones from the playhead, the chips' from
their own row. There is no stored-keyframe cursor and no Animate toggle or stored preference.
An animated channel without an enabled setting at the playhead remains read-only until
explicitly captured. Sliders never create keyframes. Keyframe selectors visibly read **Easing**,
retaining contextual accessible names; each enabled setting has its own Easing.
**Auto** in a clip grade's Colour keyframe line ([Auto adjust](AUTO_ADJUST.md)) analyses the selected clip and, on **Apply**, either replaces eleven of its grade's scalar values in one Colour edit, from the second around the playhead or the whole clip (or each clip of its track with its own correction, one edit per clip in one Undo step), leaving animated settings and every keyframe unchanged, or keys those eleven settings at the playhead's source frame from the frames around it: the correction stays with the clip like any clip grade. Adjustments have no Auto.
**HSL ranges** and **Colour curves** belong to the same grade, with no diamonds.
Opacity is not a Colour setting: it is in **Track → Transform** with the other Transform settings
and their own project-frame keyframes; see [track Transform](SPATIAL_TRANSFORMS.md).
Individual scalar resets target only the grade's base or the current existing keyed setting;
Colour Reset on an animated grade targets only the settings keyed at the playhead, preserving
HSL/curves. No reset overwrites another keyframe or the saved base beneath a keyed channel.

There is no Clip correction disclosure, control, command or stored field. Collapse
and tab switches retain mounted drafts; changing editing context resets fields
without applying old drafts to another clip or adjustment.

Pointer sliders keep local drafts and commit once on release, never on movement.
Escape, pointer cancellation, capture loss or blur restore without history/save.
Numeric precision, invalid editable drafts, keyboard/focus, one Undo per accepted
edit, atomic rejection and editor-only navigation retain their existing contract.

## Validation scope

Ownership/history/schema tests, CPU sequential grading and bounded LUT tests,
real GPU comparison, synthetic 720p/UHD native parity and memory-only Properties
workflows are required to validate this contract, including Temperature/Tint math
and editing. This guide claims no new test results. Passing synthetic tests does not qualify
intended-GPU speed, long-flight throughput, real media or long-run A/V behaviour.
No release, issue closure or publication is implied by this document.
