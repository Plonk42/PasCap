# Clip spatial transforms · strict project schema 11

Current contract for [#20](https://github.com/Plonk42/PasCap/issues/20): static and
keyframed crop, uniform scale, translation and rotation on each excerpt instance.
This describes the implementation contract, not test results, hardware/long-run
qualification, release approval or milestone closure. Usage is in
[the user guide](../USER_GUIDE.md); timing and resources are in
[speed and audio](../SPEED_AND_AUDIO.md) and
[layers and keyframes](../LAYERS_AND_KEYFRAMES.md).

Implementation authorities: [pose/schema/mapping](../../src/shared/spatial.ts),
[required clip/project data](../../src/shared/model.ts),
[sampling/retiming](../../src/shared/timeline.ts),
[atomic commands](../../src/shared/commands.ts),
[native composition](../../src/server/layered-frame.ts) and
[Transform controls](../../src/web/SpatialControls.tsx).

## Required data and ownership

Every schema-11 clip requires `spatial: { base, keyframes }`. Both objects and all
keys are strict: no unknown fields, optional legacy values, coercion, persisted
defaults or load-time repair. `base` is one complete eight-value pose;
`keyframes` is a required array of **0–256** complete poses. Each key requires
`{ frame, interpolation, values }`, with all eight numeric fields in `values`.
Frames are unique ascending integers in **0–2,147,483,647**, measured from the
original recording's frame zero, never the excerpt IN or its project start.
Registered-source validation additionally requires every key to be at or before
the original's exclusive OUT (`frameCount`), including keys outside the trim.

| Field                       | Bounds and meaning                                    | New-clip neutral value |
| --------------------------- | ----------------------------------------------------- | ---------------------- |
| `cropLeft` / `cropRight`    | Each in [0, 1), fractions of original width; sum < 1  | 0 / 0                  |
| `cropTop` / `cropBottom`    | Each in [0, 1), fractions of original height; sum < 1 | 0 / 0                  |
| `scale`                     | Uniform, aspect-preserving 0.1–8                      | 1                      |
| `translateX` / `translateY` | −2–2, fractions of full output width/height           | 0 / 0                  |
| `rotation`                  | −180°–180°, clockwise                                 | 0                      |

Neutral creation values are not defaults for missing saved data. Spatial keys
belong only to `clip.spatial`; they add no row channels or timeline row markers.
The nine nullable shared row channels, clip colour/speed ownership and final
[#67](https://github.com/Plonk42/PasCap/issues/67) sole row **Opacity** remain
unchanged. No saved `clip.opacity` or second opacity multiplier is introduced.

With no keys, `base` holds for the whole excerpt. With any keys, the full-pose
curve overrides all eight base values everywhere, including endpoint holds
before the first and after the last key. A single key therefore holds its whole
pose throughout. The left key's required `interpolation` is `hold`, `linear`,
`ease-in`, `ease-out` or `smooth`, shared by all eight values toward the next key.
Interpolation is numeric component-by-component, not an affine-matrix or image
crossfade. Rotation does **not** take a shortest arc: +170° to −170° travels
through 0°. Removing all keys reveals the unchanged saved base. **Reset transform**
is different: it deliberately clears all keys and restores the neutral base.

## Timing and retained anchors

The authoritative `PlacedClip.retiming` provides two distinct queries:
`sourceAt(localOutputFrame)` identifies the integer recorded image;
`sourcePositionAt(localOutputFrame)` supplies continuous original-source position
for spatial evaluation. Constant, ramp, custom clip speed and overriding row
Speed all use that same placed map. Geometry can move while slow motion holds
one recorded image; no optical-flow or intermediate recorded image is invented.
Row colour and Opacity still evaluate at absolute project time.

Spatial edits are appearance-only: they do not rewrite source IN/OUT, placement,
speed, duration, transitions/fades, music or row points. Trim/restoration, move,
Ripple, split, marked cuts and duplicate preserve original-source spatial anchors
without shifting, rescaling or discarding off-trim keys. Split/cut/duplicate
retain complete independently deep-copied bases, key arrays and key poses in
each retained instance. Keys at the original exclusive OUT remain boundary
anchors, not requests to decode an out-of-range image. Retained keys do not
extend clip/project duration. Originals and proxies are not cropped or rewritten.

## Geometry and coverage

Use top-left coordinates with positive X rightward and positive Y downward.
For original dimensions $W_s,H_s$ and output dimensions $W_o,H_o$, uniform
contain fit is $f=\min(W_o/W_s,H_o/H_s)$. Fitted dimensions $fW_s,fH_s$ are
**unrounded** geometry derived from the registered original aspect, not from an
even-rounded proxy/decode rectangle. Apply uniform scale and clockwise rotation
about the **original image centre**, then translate by
$(\mathrm{translateX}W_o,\mathrm{translateY}H_o)$.

Crop removes original edges without refitting, stretching, recentering or moving
the pivot. Inverse-map each output pixel centre $(x+0.5,y+0.5)$ into original
normalized $(u,v)$, then test the half-open source rectangle:

$$
\mathrm{cropLeft}\le u<1-\mathrm{cropRight},\qquad
\mathrm{cropTop}\le v<1-\mathrm{cropBottom}.
$$

Nonneutral poses have binary coverage $m_i=1$ inside that rectangle and $m_i=0$
outside it, including outside the transformed original image. Missing coverage
reveals lower layers, or black on the opaque project background; it is not opaque
black padding that hides lower footage. Rotation does not enlarge output dimensions.

**Exact neutral pose is a deliberate rendering exception.** All four crops and
translations/rotation must equal zero and scale must equal one, with no epsilon
test. Preserve the old fit/indexing path and its **opaque black letterboxing
after grading**: padding is not graded/lifted and its coverage remains one.
Even a tiny nonneutral edit uses transformed transparent coverage. An evaluated
neutral keyed pose also uses the neutral rendering path, but the existence of
keys still excludes static export. The inverse geometry's generic coverage test
does not itself make neutral letterbox pixels opaque; the renderer does.

For each source $i$ at an output pixel, let $G_i$ be graded sampled RGB, $b_i$
black-fade brightness, $o_i$ the sole evaluated row Opacity, $w_i$ dissolve weight
and $m_i$ the source coverage mask (one throughout the neutral canvas, with black
RGB padding). A dissolve remains **one premultiplied track group**:

$$
C=\sum_i G_i b_i o_i w_i m_i,\qquad A=\sum_i o_i w_i m_i,
\qquad \mathrm{result}=C+\mathrm{lower}(1-A).
$$

Both dissolve sources use the same row Opacity value/curve, but their own spatial
poses and masks. No second row/group opacity multiplier exists. Black fades
change RGB, not available coverage. Spatial RGB resampling precedes grading;
neither graded endpoint images nor endpoint LUTs are interpolated for animation.
Ungraded comparison bypasses colour only, preserving spatial geometry/coverage.

## Preview, native export and resource boundaries

WebGL2 consumes the shared inverse affine mapping and crop bounds with explicit
top-left/source-texture orientation conversion. Native layered composition uses
the same original-aspect mapping, bilinearly sampling the existing fitted RGB8
content and clamping sample taps to that content, not its black decode padding.
Fractional sampled RGB is graded through the reusable LUT before RGBA16 group
composition. Neutral native samples retain old byte indexing and opaque padding.
Native LUT interpolation, fitted decode resolution and final H.264/YUV
quantisation are approximations, not bitwise GPU/native equivalence.

Any nonneutral saved base or **any** spatial keys, even all-neutral keys, require
layered export. Static export additionally needs one enabled row with Opacity 1,
no row points, zero origin, no internal gaps and coverage of full project duration.
The two-normal-speed-excerpt diagnostic reference rejects spatial edits/keys;
use production Export. Its receipt/report formats are independent of project schema.

No transformed image or duration-sized pose/mask buffer is allocated. The native
budget remains four raw buffers (two RGB8 + two RGBA16), **22 bytes/pixel =
182,476,800 bytes UHD**, and two reusable 65³ Float32 LUTs, **6,591,000 bytes**.
Serial passes retain at most one original decoder, two intermediate readers,
one encoder and three native video children, two retained clip files and three
timeline representations. No per-frame FFmpeg process or LUT file is introduced.
Native/audio overhead and duration-dependent scratch remain additional;
these bounds are not throughput or fixed-disk-space promises. Preview retains
two decoder/texture slots per row (16 for eight), plus one source-review decoder.

## Clip → Transform controls

**Transform** adds a fifth top-level Clip section (after Speed, before Colour),
collapsed for new preferences. **Expand all / Collapse all** includes Source range,
Placement, Speed, Transform and Colour. Existing expansion preferences remain
respected; **Transform animation** heading help is reachable while collapsed.
An empty row shows **Select an excerpt to edit its Transform.**

The eight **Crop left / Crop right / Crop top / Crop bottom / Scale / Translate X /
Translate Y / Rotation °** controls each pair a native slider with an exact field.
Without keys they edit the clip base. With keys, main fields are read-only unless
a key exists at the **actually displayed integer source frame** at the real
project playhead. The single **Transform keyframe at displayed source frame**
diamond captures the complete continuously evaluated pose there, with Linear
easing for a new key; a filled diamond removes that whole key. Sliders/numbers
never create keys. Capture is unavailable outside the clip, during blocked/draft
states or at the 256-key limit (existing-key removal remains possible).

**Selected Transform keyframe**, **Previous/Next Transform keyframe** and
**Preview stored key** navigate the stored source-key list, including off-trim
keys and original exclusive OUT. Preview uses the closest actually mapped image
(first/last available output at trim boundaries), not a fictional source frame.
The UI distinguishes **Stored source frame** from **actual displayed source
frame**. This clip-local selection is separate from row off-duration inspection;
main fields and capture never use the stored selection as a fake playhead.

Stored **Source frame**, **To next point** and all eight pose fields target that
selected key. Easing is disabled on the last key, which has no next interval.
The trash action **Delete selected Transform keyframe** removes only it; deleting
the last key restores the saved base. **Reset transform** clears the whole spatial
animation and restores the neutral base in one Undo step.

Numeric drafts retain full entered precision, apply on Enter/blur and restore on
Escape. Empty/nonfinite/out-of-bounds values, crop sums ≥1, fractional/out-of-original
frames and occupied key frames retain editable inline errors; they never clamp,
merge or overwrite. Value/time/easing edits do not automatically seek. Valid
edits are one Undo step; key movement and Undo preserve selected field identity.
Slider movement drafts only the local control, not preview/document/history/save;
valid release commits once and updates the image. Escape, pointer cancellation,
lost capture or window blur restores the starting value; invalid release commits
nothing. Each keyboard slider adjustment is an individual validated edit. There
is no Transform graph-point drag, canvas gizmo or per-property diamond workflow.

## Preservation

Projects and version-1 export receipt snapshots must satisfy strict **schema 11**,
including required clip spatial data and the unchanged identified music arrays.
Incompatible v1–v10 projects/receipt snapshots and completed videos remain untouched.
Recreate projects deliberately; do not migrate, default-fill, rewrite or delete old
data automatically. Registry/proxy/PCM and receipt/report format versions do not
change. Historical measurements/planning retain their original schema references.

Advanced row HSL and master/RGB curves grade spatially sampled RGB before black fades and coverage, with no extra spatial field or key. Compare bypasses all colour but preserves spatial mapping. [Advanced colour contract](HSL_AND_CURVES.md).
