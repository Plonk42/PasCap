# Video track HSL ranges and colour curves · strict project 13

All colour belongs to the video track, keyed or unkeyed. Clips have no colour or
correction fields. Nine scalar colour controls, including Temperature and Tint,
can be keyed independently in video track animation. HSL ranges and colour curves are
**static video track settings**, including on empty tracks; the ten nullable keyframe
channels are Opacity and those nine scalars. Animation does not suppress
or replace advanced static settings. Temperature/Tint use normalized −1…1,
neutral 0, and linear gains before Exposure; see
[their exact contract](TEMPERATURE_AND_TINT.md).

## Required data and SDR order

Required `layer.colour.hsl` contains eight named bands: red, orange, yellow, green,
cyan, blue, purple and magenta. Each requires hue −30…30 degrees, saturation
−1…1 (multiplier offset) and lightness −0.5…0.5. Centres are 0, 30, 60, 120, 180,
240, 270 and 300 degrees. Required `layer.colour.curves` contains master, red,
green and blue arrays, each 2…16 strict `{ x, y }` control nodes with finite coordinates
in 0…1. Inputs strictly ascend, with first x=0 and last x=1. Endpoint outputs are
editable; nonmonotonic outputs are valid. No control-node IDs or preset fields are saved.
Neutral factories create independent nested objects/arrays. They are only creators,
never repairs for missing saved fields. Projects 1…12 and their receipt snapshots
are incompatible and preserved; recreate deliberately. Receipt format remains 1;
registry, proxy and PCM formats are unchanged. No migration or automatic deletion.

The exact order is inverse BT.709 → normalized Temperature/Tint linear gains →
Exposure → Contrast → Brightness → Shadows/Highlights → Hue/Saturation → final
linear clipping/BT.709 encoding → encoded HSL → master curve → separate RGB curves →
black-fade brightness → grouped coverage and source-over. This is not HDR,
scene-linear HSL, automatic white balance, a speed curve or a per-clip correction.
Compare/Ungraded bypasses **all** colour stages, retaining
geometry, timing, visibility, Opacity, black fades and music.

## HSL mathematics

Derive hue, saturation and lightness once from incoming encoded RGB. Only the two
neighbouring circular band centres contribute. For interval progress u, right
weight is `u*u*(3-2*u)`, left weight its complement; the magenta→red interval
wraps through 360 degrees. Never reclassify a pixel after applying one band.
Multiply weighted offsets by `smoothstep(0, 0.1, max(R,G,B)-min(R,G,B))`.
Exact incoming greys, black and white therefore remain unchanged by HSL.
Temperature/Tint precede HSL and intentionally colour greys; HSL grey protection
does not undo those gains or promise a neutral final image. Wrap hue after
adding its weighted degree offset; multiply saturation by one plus its weighted
offset and add the lightness offset. Clamp resulting saturation/lightness to gamut,
not editor input. Convert the resulting HSL back to encoded RGB. All-neutral HSL
returns its input exactly, as do identity curves and an entirely neutral grade.

Curves use piecewise-linear interpolation, first master on each encoded component,
then that component's channel curve. Outputs need not ascend. Arbitrarily narrow
valid knees are evaluated analytically in native export, not approximated by a
65³ advanced-colour LUT. Nonneutral HSL or curves route even otherwise static
projects through composited export. Each such source evaluates the complete nine
scalar controls → HSL → master/RGB curves directly on the sampled fractional RGB,
before black fades and group composition. A scalar-only LUT followed by exact
curves is insufficient: a sharp curve can amplify that LUT's scalar error.
The exact CPU path retains full input precision without minimum control-node spacing,
rounding or restrictions on valid curve inputs. RGBA16 and final H.264/4:2:0
quantisation remain measured approximations under the unchanged error gates.

## Editing, resets and resource ownership

Track → Colour contains nine scalar sliders (Temperature/Tint before Exposure)
and sole Opacity control. Nested
HSL ranges and Colour curves contain native band/channel/control-node selectors, exact
numeric fields and a compact SVG curve graph. HSL uses native sliders and exact
fields, with no diamonds. Curve endpoint inputs are locked; outputs remain editable.
Add inserts a sampled control node; delete removes only an interior control node. Graph dragging
edits both coordinates from capture-relative geometry. Drafts never save or enter
history; release commits one complete validated video track colour command. Invalid final
positions reject, never commit an earlier valid draft. Escape, cancellation, lost
capture and window blur restore. Keyboard/exact fields remain usable at 270 px.

Band/all-HSL and channel/all-curves resets affect only their respective static
settings in one Undo step. Colour Reset on an animated track changes only current keyed
scalar/Opacity settings, never advanced settings or saved video track bases. Unanimated Reset
colour resets the entire video track colour and Opacity. Selection/collapse/tab changes
never apply a former track's draft to another track. Same-track clip selection retains
track ownership. Control vocabulary follows the [editor control catalogue](EDITOR_CONTROLS.md#vocabulary).

GPU uses bounded uniforms for two sources: eight HSL vec4 entries and four arrays
of at most sixteen vec2 control nodes per source, plus counts/neutral flags. No extra LUT
texture, decoder, full-frame buffer, per-track uniform multiplier or native child.
The compositor owns three fixed shader programs, compiled before playback: the
complete grouped advanced program, its exact single-source specialization and
the scalar-only fast path. They share geometry, grading equations, the existing
decoder textures and vertex array. Single-source specialization eliminates unused
source-1 grade work; dissolves retain the complete grouped shader. Neutral advanced
tracks use the scalar path. Curves use at most four binary subdivisions
to locate one of their fifteen intervals. Zero-coverage sources are not graded.
The engine reuses an intact surface only when exact decoded source identities and
every evaluated composition value are unchanged. It retains one bounded identity
token, not another image buffer. Project-time animation, new sources and Compare
force the appropriate redraw; any clear invalidates reuse. Readiness and the final
actual-output-clock A/V checks still run, including for held slow-motion images.
Diagnostic pixel capture always redraws: retaining the presented image does not
preserve WebGL's discarded-after-presentation drawing buffer. No preserved
framebuffer or additional texture is introduced.
Rendered-frame/FPS counters count real replacement draws, not duplicate submissions.
Native grading parses settings and selects exact versus LUT grading once per
source/frame. Exact grading allocates only tiny RGB triples, never another image,
large LUT or duration-sized array; 8-bit unresampled samples reuse a 256-entry
BT.709 decode table with bitwise-identical results. Frame composition and LUT
generation split disjoint image-scanline/slice bands across bounded worker threads over the
existing shared buffers ([resource contract](../LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits)).
Exact grading remains the costliest path, especially at UHD; synthetic
correctness does not qualify throughput.
Neutral HSL/identity curves retain the existing scalar-only static fast path and,
when compositing is otherwise required, the original scalar 65³ LUT approximation.
At most two reusable Float32 LUT arrays (6,591,000 bytes) remain available; an
all-advanced export need allocate none. The four raw buffers (22 bytes/pixel),
serial readers/encoder/children and scratch ownership budgets remain unchanged.
The full-appearance `generateCube` helper remains available for diagnostics, not
production export of nonneutral advanced settings.
