# Owner-approved row-only Colour and Opacity · schema 10

## Ownership and strict storage

Each video row requires complete seven-channel `VideoLayer.colour`, neutral on
creation, alongside its sole required `opacity`, initially 1. Clips have no colour
or correction field: both `clip.colour` and `clip.correction` are invalid.
The owner-approved scope is identical with or without animation: every clip on
the same row shares all colour treatment. Different treatments require different
rows, not a per-clip scope toggle or a separate shot feature. Future HSL, curves
and temperature controls must also be row-owned; #19/#68 are not implemented here.
The bounds and neutral values are the existing SDR ColourSettings contract.
No optional legacy field, additive parameter merge, migration or default-on-load exists.
Schema 10 rejects versions 1–9 without rewriting or deleting their documents.
Receipt format remains 1 with strict schema-10 snapshots; registry, proxies and
PCM formats are unchanged. Recreate incompatible projects deliberately.

The seven shared colour channels override **row colour**, independently, in
absolute project time. Skip unrelated participants, interpolate parameter values
using the left participant's easing, and hold endpoints. Removing the last key
reveals the unchanged row base.
Row Speed retains its distinct clip-speed override contract. Opacity ownership,
source-over composition, spatial coverage and black-fade coverage are unchanged.

For example, clips A and B on one row both use Exposure 0.5 without keys.
An Exposure curve applies the same evaluated value to both at any project frame,
including a dissolve. The first diamond captures the evaluated row value.

Trim, restore, split, cut and duplicate preserve source ranges, independent speed
and spatial anchors without copying colour. Row bases, Opacity and absolute points
remain untouched. Moving or inserting a clip immediately adopts destination row
Colour, keys and Opacity without changing either row's settings or points.

## Rendering

Let `grade` be the existing encoded BT.709 SDR transform. Each source is graded as

$$G_i=\mathrm{grade}(RGB_i, rowColour(t)).$$

There is one SDR grade, not a composed or double-grade transform. An exactly
neutral row grade returns its input unchanged. Grading precedes black fades,
dissolve group sums and row Opacity/coverage. Ungraded preview neutralizes row Colour,
preserving observed frames, retiming, geometry, Opacity, fades, stacking and music.
Appearance edits do not restart unchanged media or alter timing.
Texture, decoder and full-frame buffer counts stay unchanged. Exact neutral spatial
poses retain their existing opaque black letterbox path.

Static export generates a 65³ LUT from the row's Colour alone. Static
nonneutral row colour does not disqualify the cheap path. Row keys and spatial
edits still require layered export. Layered export generates its LUT from evaluated
row parameters alone, retaining two reused LUT arrays;
there is no extra full-frame buffer, decoder or per-frame FFmpeg invocation.
The native 22 bytes/pixel/four-buffer and serial child-process budgets remain unchanged.
LUT interpolation and H.264 quantisation remain measured approximations, not
bitwise shader equivalence. The two-excerpt diagnostic reference and measurement
helper also grade using the one static row Colour, without independent clip grades.

## Inspector and history

**Clip → Colour** has eight main widgets: seven row colour controls plus sole
Opacity. All use existing slider/exact-field/reset/diamond/channel-navigation
controls and work on an empty row. An animated channel without participation at
the real playhead remains read-only until explicitly captured. Sliders never key.
Individual resets target only the row base or current existing participant;
Reset keys targets only existing colour/Opacity participants. No reset overwrites
another point or the saved base beneath a keyed channel.

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
workflows validate this contract. Passing synthetic tests does not qualify
intended-GPU speed, long-flight throughput, real media or long-run A/V behaviour.
No release, issue closure or publication is implied by this document.
