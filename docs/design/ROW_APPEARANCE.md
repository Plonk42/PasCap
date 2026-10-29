# Video track Colour, Opacity and clip grades

Required Colour includes twelve graded scalar settings, including Temperature, Tint, Vibrance, Whites and Blacks,
the HDR look and Local contrast (applied before grading with the clip detail filters; see
[detail filters](DETAIL_FILTERS.md#hdr-look)),
eight static HSL bands and four master/RGB colour curves. HSL/curves share video track
ownership but add no nullable animation channels. Scalar keyframes override their own
bases only; advanced colour remains active. Exact gain math and complete SDR
order: [Temperature/Tint](TEMPERATURE_AND_TINT.md) and
[HSL/curves](HSL_AND_CURVES.md).

## Ownership and strict storage

Each video track requires complete `VideoLayer.colour`, neutral on creation,
alongside its sole required `opacity`, initially 1. Colour contains the twelve
graded scalar channels, `hdr`, `localContrast`, plus required HSL and curves. Saved
`clip.colour` and `clip.correction` are invalid; a clip's own Colour is its
[grade](#clip-grades). Track Colour, with or without animation, applies to every clip on
the track, after each clip's grade. Temperature and Tint
are required normalized −1…1 track fields, neutral 0, with independent animation.
Positive Temperature warms; positive Tint adds magenta. Nonzero settings
intentionally colour greys; normalized linear gains precede Exposure, preserving
neutral-white linear luminance before clipping only, not arbitrary/final images.
Other scalar bounds and neutral values retain the existing SDR contract.
No optional legacy field, additive parameter merge or default-on-load exists.
Projects saved with an older supported schema are upgraded on load; older schema versions
are rejected without rewriting or deleting their documents.
Receipt format remains 1 with strict current-schema snapshots; proxy and PCM formats are
unchanged, and the registries are version 2 (full-content checksums).

The twelve shared scalar colour channels, HDR and Local contrast override **video track colour**, independently, in
absolute project time. Skip keyframes without the relevant enabled setting, interpolate parameter values
using that setting's own Easing at the left keyframe, and hold endpoints. Removing the last keyframe for a setting
reveals the unchanged track base. HSL and curves remain static.
Speed is clip-only and never a track channel. Opacity ownership,
source-over composition, spatial coverage and black-fade coverage are unchanged.
Every keyframe requires all fifteen nullable fields, in control order: `opacity`,
`temperature`, `tint`, `exposure`, `brightness`, `contrast`, `hue`,
`saturation`, `vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`, `localContrast`. Missing fields are invalid, never defaulted.

For example, clips A and B on one video track both use Exposure 0.5 without keyframes.
An Exposure curve applies the same evaluated value to both at any project frame,
including a dissolve. The first diamond captures the evaluated track value.

Trim, restore, split, cut and duplicate preserve source ranges and independent speed
anchors without copying colour or Transform, which is track-owned like Colour. Track
bases, Opacity, Transform and absolute keyframes remain untouched. Moving or inserting
a clip immediately adopts destination video track Colour, Transform, keyframes and
Opacity without changing either track's settings or keyframes.

## Clip grades

Every clip requires `grade: { colour, keyframes }`
([#273](https://github.com/Plonk42/PasCap/issues/273), schema decisions in
[clip grades and adjustments](CLIP_GRADES_AND_ADJUSTMENTS.md#clip-grade-owner)):

- `colour` has the track Colour's fields, bounds and neutral values (twelve scalar settings,
  `hdr`, `localContrast`, HSL and curves), without Opacity or Transform. New clips are neutral;
  projects saved before clip grades open with a neutral grade on every clip, rendering as before.
- `keyframes` are at most **64** `{ frame, values, easing, reset }` at **original-source frames**
  of the recording (0 to its frame count), with the fourteen nullable Colour channels
  (`temperature` … `localContrast`, no `opacity`), one Easing per enabled setting and the default
  keyframe flag. Keys outside the trim are kept, like off-trim speed keys.
- The grade is evaluated at the clip's continuous source position (one frame lower when
  reversed, so a key applies fully as its image appears): slow motion eases between keys and a
  reversed clip plays its keys backwards. HSL and curves are static.
- Trims, moves (to another track too), Ripple, splits, cuts, duplicates, Reverse and Move to new
  track keep the grade with its footage; split, cut and duplicate copy it.
- Commands: `colour` (with `clipIds`, several clips at once), `colour-setting`, `hsl-band`,
  `colour-curve` and the `layer-key-*` keyframe commands take a `clipId` instead of `layerId`;
  their frames are then source frames. Opacity is refused on a clip.

## Rendering

Let `grade` be the encoded BT.709 SDR transform, including scalar, HSL and
master/RGB curve stages. Each source is graded by its clip's grade $c$, then its track's
Colour $r$, both evaluated at the source's frame:

$$G_i=\mathrm{grade}(\mathrm{grade}(RGB_i, c(s)), r(t)).$$

Each grade ends with its own clipping and encoding; settings are never summed into one grade.
The local tone settings (HDR, Local contrast, Shadows, Highlights) of both grades are summed,
within their ranges, for the one detail-kernel pass before grading, and Shadows/Highlights choose
tones after the summed Exposure. An exactly neutral grade is skipped: a clip with a neutral grade
on a neutral track returns its input unchanged. Grading precedes black fades,
dissolve group sums and track Opacity/coverage. The Original preview neutralizes clip grades, video track Colour and clip Detail (or, with a
modifier, only one of the two kinds of grade), preserving observed frames, retiming, geometry, Opacity, fades, stacking and music.
Appearance edits do not restart unchanged media or alter timing.
Texture, decoder and full-frame buffer counts stay unchanged. Exact neutral spatial
poses retain their existing opaque black letterbox path.

With neutral HSL and identity curves, static export generates one 65³ scalar LUT per clip,
composed from its grade followed by the track's Colour; nonneutral scalar colour with
Shadows/Highlights/HDR/Local contrast 0 retains this cheap path. Track or clip grade keyframes,
nonzero HDR or Local contrast, Transform edits/keyframes or nonneutral HSL/curves in either grade
require composited export, which composes each source's two scalar grades into one LUT (its cache
identity is the pair) or grades exactly in sequence. Scalar-only
composited grades use evaluated track parameters and at most two reused LUT arrays.
Advanced grades evaluate the complete scalar/HSL/curve transform exactly on the
fractional sampled RGB. Source/frame compilation determines neutral stages once,
without approximating curves or introducing a full-frame buffer, decoder or
per-frame FFmpeg invocation.
The native 22 bytes/pixel/four-buffer and serial child-process budgets remain unchanged.
Scalar LUT interpolation and H.264 quantisation remain measured approximations,
not bitwise shader equivalence. Sharp curves are tested after production-resolution
input scaling: grading and resampling do not commute. The two-clip diagnostic
reference and measurement helper accept static scalar video track Colour with neutral HSL
and identity curves and Shadows/Highlights/HDR/Local contrast 0, without independent clip grades.

## Properties and history

The Colour sections live in the **Colour** Properties tab (**Clip / Colour / Track / Audio**). Its
pinned header names what it edits: with a clip selected, its grade (**This clip only**) or, with
the **Clip / Track** switch (arrow keys move between them), its track's Colour; without a selected
clip, the track. The choice stays while other clips are selected; a timeline marker chooses its own target.
With several clips selected, the clip's grade is not editable: the tab says why and offers the
track. A clip grade shows the same sections without the Opacity group; only a clip grade has **Auto** and **Auto white balance** ([#285](https://github.com/Plonk42/PasCap/issues/285)); its diamonds key the source frame shown at the playhead (unavailable, with the reason,
when the playhead is off the clip), its keyframe list is **Clip keyframes** with source frames, and
its keyframes are amber ◆ markers inside the clip on the timeline. Its sliders show the grade the image uses, which eases between source frames in slow motion; only a setting keyed at the playhead's source frame shows that keyframe's own value, which it edits, while the image may already be slightly past it. **Copy grade** and **Paste grade**
in a clip's context menu copy a grade without keyframes and replace the right-clicked clip's grade
(or every selected clip's, when it is selected), removing its keyframes, in one Undo step. Holding
**Original** bypasses every grade and Detail; with **Shift** only clip grades and Detail, with
**Alt** only track Colour; its badge names the mode.

Control vocabulary follows the [editor control catalogue](EDITOR_CONTROLS.md#vocabulary).

**Colour → Track** has fifteen main widgets: twelve graded scalar video track colour controls,
HDR, Local contrast and sole Opacity. All use existing slider/exact-field/reset controls and work on an empty
track. They sit in four static groups, each a labelled fieldset with a small heading:
**Opacity**; **Colour** (Temperature, Tint, Hue, Saturation, Vibrance); **Light** (Exposure,
Brightness, Contrast, Highlights, Shadows, Whites, Blacks); **Effects** (HDR, Local contrast). This visible order differs from
the storage and keyframe channel order, which is unchanged. Each heading's Reset icon
(**Reset the Light group**, etc.) resets the group's editable settings in one Undo step, as
their own Reset icons would: an unkeyed setting's track value, a keyed setting's keyframe at
the playhead; read-only animated settings stay unchanged. It is dimmed at the defaults.
Main and stored Opacity sliders/exact fields use **0–100%**, neutral **100%**;
convert only at the UI boundary. Required
`VideoLayer.opacity` and `opacity` keyframe values remain **0–1**, without a schema change.
Main capture diamonds are always visible; each retains adjacent per-setting **Previous/Next** buttons because not every
setting is enabled at every shared keyframe. One keyframe-line Previous/Next pair (with the keyframe count) visits
the union of Opacity, twelve scalar colour, HDR and Local contrast keys.
Enabled setting chips in stored Colour keyframe rows retain their per-channel arrows.
All main and stored per-channel arrows visit strictly earlier/later keyframes
where that channel is nonnull (zero is enabled), using the shared central
stored-keyframe cursor, including off-duration inspection.
There is no Animate toggle or stored preference.
An animated channel without an enabled setting at the real playhead remains
read-only until explicitly captured. Capture never uses
an inspected stored time. Sliders never create keyframes. Track-keyframe selectors
visibly read **Easing**, retaining contextual accessible names; each enabled setting has its own Easing.
**Auto** in a clip grade's Colour keyframe line ([Auto adjust](AUTO_ADJUST.md)) analyses the selected clip and, on **Apply**, either replaces eleven of its grade's scalar values in one Colour edit, from the second around the playhead or the whole clip (or each clip of its track with its own correction, one edit per clip in one Undo step), leaving animated settings and every keyframe unchanged, or keys those eleven settings at the playhead's source frame from the frames around it: the correction stays with the clip like any clip grade. Track Colour has no Auto.
The static **HSL ranges** and **Colour curves** Track sections share video track ownership, with no new diamonds.
**Track → Transform** shares the same ownership, with its own project-frame keyframes;
see [track Transform](SPATIAL_TRANSFORMS.md).
Individual scalar resets target only the track base or current existing keyed setting;
Colour Reset on an animated track targets only existing keyed colour/Opacity settings, preserving HSL/curves.
No reset overwrites another keyframe or the saved base beneath a keyed channel.

There is no Clip correction disclosure, control, command or stored field. Collapse
and tab switches retain mounted drafts; changing editing context resets fields
without applying old drafts to another track. Selecting another clip on the same track
does not change Colour ownership or its evaluated value.

Pointer sliders keep local drafts and commit once on release, never on movement.
Escape, pointer cancellation, capture loss or blur restore without history/save.
Numeric precision, invalid editable drafts, keyboard/focus, one Undo per accepted
edit, atomic rejection and editor-only navigation retain their existing contract.

## Validation scope

Ownership/history/schema tests, CPU single grading and bounded LUT tests,
real GPU comparison, synthetic 720p/UHD native parity and memory-only Properties
workflows are required to validate this contract, including Temperature/Tint math
and editing. This guide claims no new test results. Passing synthetic tests does not qualify
intended-GPU speed, long-flight throughput, real media or long-run A/V behaviour.
No release, issue closure or publication is implied by this document.
