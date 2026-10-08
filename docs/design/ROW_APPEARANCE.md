# Owner-approved row-only Colour and Opacity · schema 12

Required Colour includes nine scalar settings, including Temperature and Tint,
eight static HSL bands and four master/RGB colour curves. HSL/curves share row
ownership but add no nullable animation channels. Scalar keys override their own
bases only; advanced colour remains active. Exact gain math and complete SDR
order: [Temperature/Tint](TEMPERATURE_AND_TINT.md) and
[HSL/curves](HSL_AND_CURVES.md).

## Ownership and strict storage

Each video row requires complete `VideoLayer.colour`, neutral on creation,
alongside its sole required `opacity`, initially 1. Colour contains the nine
scalar channels plus required HSL and curves. Clips have no colour or correction
field: both `clip.colour` and `clip.correction` are invalid.
The owner-approved scope is identical with or without animation: every clip on
the same row shares all colour treatment. Different treatments require different
rows, not a per-clip scope toggle or a separate shot feature. Temperature and Tint
are required normalized −1…1 row fields, neutral 0, with independent animation.
Positive Temperature warms; positive Tint adds magenta. Nonzero settings
intentionally colour greys; normalized linear gains precede Exposure, preserving
neutral-white linear luminance before clipping only, not arbitrary/final images.
Other scalar bounds and neutral values retain the existing SDR contract.
No optional legacy field, additive parameter merge, migration or default-on-load exists.
Schema 12 rejects versions 1–11 without rewriting or deleting their documents.
Receipt format remains 1 with strict schema-12 snapshots; registry, proxies and
PCM formats are unchanged. Recreate incompatible projects deliberately.

The nine shared scalar colour channels override **row colour**, independently, in
absolute project time. Skip unrelated participants, interpolate parameter values
using the left participant's easing, and hold endpoints. Removing the last key
reveals the unchanged row base. HSL and curves remain static.
Row Speed retains its distinct clip-speed override contract. Opacity ownership,
source-over composition, spatial coverage and black-fade coverage are unchanged.
Every point requires all eleven nullable fields, in control order: `opacity`,
`speed`, `temperature`, `tint`, `exposure`, `brightness`, `contrast`, `hue`,
`saturation`, `highlights`, `shadows`. Missing fields are invalid, never defaulted.

For example, clips A and B on one row both use Exposure 0.5 without keys.
An Exposure curve applies the same evaluated value to both at any project frame,
including a dissolve. The first diamond captures the evaluated row value.

Trim, restore, split, cut and duplicate preserve source ranges, independent speed
and spatial anchors without copying colour. Row bases, Opacity and absolute points
remain untouched. Moving or inserting a clip immediately adopts destination row
Colour, keys and Opacity without changing either row's settings or points.

## Rendering

Let `grade` be the encoded BT.709 SDR transform, including scalar, HSL and
master/RGB curve stages. Each source is graded as

$$G_i=\mathrm{grade}(RGB_i, rowColour(t)).$$

There is one ordered SDR grade, not a composed or double-grade transform. An exactly
neutral row grade returns its input unchanged. Grading precedes black fades,
dissolve group sums and row Opacity/coverage. Ungraded preview neutralizes all row Colour,
preserving observed frames, retiming, geometry, Opacity, fades, stacking and music.
Appearance edits do not restart unchanged media or alter timing.
Texture, decoder and full-frame buffer counts stay unchanged. Exact neutral spatial
poses retain their existing opaque black letterbox path.

With neutral HSL and identity curves, static export generates a 65³ scalar LUT
from the row's Colour alone; nonneutral scalar colour retains this cheap path.
Row keys, spatial edits or nonneutral HSL/curves require layered export. Scalar-only
layered grades use evaluated row parameters and at most two reused LUT arrays.
Advanced grades evaluate the complete scalar/HSL/curve transform exactly on the
fractional sampled RGB. Source/frame compilation determines neutral stages once,
without approximating curves or introducing a full-frame buffer, decoder or
per-frame FFmpeg invocation.
The native 22 bytes/pixel/four-buffer and serial child-process budgets remain unchanged.
Scalar LUT interpolation and H.264 quantisation remain measured approximations,
not bitwise shader equivalence. Sharp curves are tested after production-resolution
input scaling: grading and resampling do not commute. The two-excerpt diagnostic
reference and measurement helper accept static scalar row Colour with neutral HSL
and identity curves, without independent clip grades.

## Inspector and history

**Track → Colour** has ten main widgets: nine scalar row colour controls plus sole
Opacity. All use existing slider/exact-field/reset/diamond/channel-navigation
controls and work on an empty row. An animated channel without participation at
the real playhead remains read-only until explicitly captured. Sliders never key.
The nested static HSL and curve editors share row ownership, with no new diamonds.
Individual scalar resets target only the row base or current existing participant;
Reset keys targets only existing colour/Opacity participants, preserving HSL/curves.
No reset overwrites another point or the saved base beneath a keyed channel.

There is no Clip correction disclosure, control, command or stored field. Collapse
and tab switches retain mounted drafts; changing editing context resets fields
without applying old drafts to another row. Selecting another clip on the same row
does not change Colour ownership or its evaluated value.

Pointer sliders keep local drafts and commit once on release, never on movement.
Escape, pointer cancellation, capture loss or blur restore without history/save.
Numeric precision, invalid editable drafts, keyboard/focus, one Undo per accepted
edit, atomic rejection and editor-only navigation retain their existing contract.

## Validation scope

Ownership/history/schema tests, CPU single grading and bounded LUT tests,
real GPU comparison, synthetic 720p/UHD native parity and memory-only inspector
workflows are required to validate this contract, including Temperature/Tint math
and editing. This guide claims no new test results. Passing synthetic tests does not qualify
intended-GPU speed, long-flight throughput, real media or long-run A/V behaviour.
No release, issue closure or publication is implied by this document.
