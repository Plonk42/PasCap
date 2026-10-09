# Clip spatial transforms · strict project schema 12

Current contract for [#20](https://github.com/Plonk42/PasCap/issues/20) and
[#90](https://github.com/Plonk42/PasCap/issues/90): static and keyframed crop, uniform
scale, translation and rotation on each clip, each setting animating independently.
This describes the implementation contract, not test results, hardware/long-run
qualification, release approval or milestone closure. Usage is in
[the user guide](../USER_GUIDE.md); timing and resources are in
[speed and audio](../SPEED_AND_AUDIO.md) and
[tracks and keyframes](../LAYERS_AND_KEYFRAMES.md).

Implementation authorities: [pose/schema/mapping](../../src/shared/spatial.ts),
[required clip/project data](../../src/shared/model.ts),
[sampling/retiming](../../src/shared/timeline.ts),
[atomic commands](../../src/shared/commands.ts),
[native composition](../../src/server/layered-frame.ts) and
[Transform controls](../../src/web/SpatialControls.tsx).

## Required data and ownership

Every schema-12 clip requires `spatial: { base, keyframes }`. Both objects and all
keyframes are strict: no unknown fields, optional legacy values, coercion, persisted
defaults or load-time repair. `base` is one complete eight-value pose;
`keyframes` is a required array of **0–256** keys. Each key requires
`{ frame, interpolation, values }`: all eight fields are required in `values`, each a
number (the setting is keyed here) or `null` (it is not), with at least one number.
Frames are unique ascending integers in **0–2,147,483,647**, measured from the
original recording's frame zero, never the clip IN or its project start.
Registered-source validation additionally requires every keyframe to be at or before
the original's exclusive OUT (`frameCount`), including keyframes outside the trim.

| Field                       | Bounds and meaning                           | New-clip neutral value |
| --------------------------- | -------------------------------------------- | ---------------------- |
| `cropLeft` / `cropRight`    | Each in [0, 1), fractions of original width  | 0 / 0                  |
| `cropTop` / `cropBottom`    | Each in [0, 1), fractions of original height | 0 / 0                  |
| `scale`                     | Uniform, aspect-preserving 0.1–8             | 1                      |
| `translateX` / `translateY` | −2–2, fractions of full output width/height  | 0 / 0                  |
| `rotation`                  | −180°–180°, clockwise                        | 0                      |

Opposite crops may meet or cross (left + right ≥ 1, or top + bottom ≥ 1): that
covers nothing and the clip displays nothing there. It is never rejected or repaired.

Neutral creation values are not defaults for missing saved data. Spatial keyframes
belong only to `clip.spatial`; they add no video track channels or shared track markers.
Their separate source-keyframe lane is inside each timeline clip rectangle.
The eleven nullable shared video track channels (Opacity, Speed and nine scalar colour
fields), track-only Colour ownership, clip-owned speed and final
[#67](https://github.com/Plonk42/PasCap/issues/67) sole video track **Opacity** remain
unchanged. No saved `clip.opacity` or second opacity multiplier is introduced.

With no keys for a setting, its `base` value holds for the whole clip. Once any key
enables a setting, that setting's curve overrides its base everywhere, including
endpoint holds before its first and after its last key; a single key holds its value
throughout. Each setting interpolates between its own enabled keys, skipping keys that
leave it `null`, so a key for Scale never interrupts Rotation. The left key's required
`interpolation` (`hold`, `linear`, `ease-in`, `ease-out` or `smooth`) applies to each
of its enabled settings toward that setting's next key. Interpolation is numeric
setting-by-setting, not an affine-matrix or image
crossfade. Rotation does **not** take a shortest arc: +170° to −170° travels
through 0°. Removing a setting's last key reveals its unchanged saved base. **Reset
transform** is different: it deliberately clears all keyframes and restores the
neutral base.

## Timing and retained anchors

The authoritative `PlacedClip.retiming` provides two distinct queries:
`sourceAt(localOutputFrame)` identifies the integer recorded image;
`sourcePositionAt(localOutputFrame)` supplies continuous original-source position
for spatial evaluation. Constant, ramp, custom clip speed and overriding video track
Speed all use that same placed map. Geometry can move while slow motion holds
one recorded image; no optical-flow or intermediate recorded image is invented.
Video track colour and Opacity still evaluate at absolute project time.

Spatial edits are appearance-only: they do not rewrite source IN/OUT, placement,
speed, duration, transitions/fades, music or track keyframes. Trim/restoration, move,
Ripple, split, marked cuts and duplicate preserve original-source spatial anchors
without shifting, rescaling or discarding off-trim keyframes. Split/cut/duplicate
retain complete independently deep-copied bases, keyframe arrays and keyframe poses in
each retained clip. Keyframes at the original exclusive OUT remain boundary
anchors, not requests to decode an out-of-range image. Retained keyframes do not
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
reveals lower tracks, or black on the opaque project background; it is not opaque
black padding that hides lower footage. Rotation does not enlarge output dimensions.

**Exact neutral pose is a deliberate rendering exception.** All four crops and
translations/rotation must equal zero and scale must equal one, with no epsilon
test. Preserve the old fit/indexing path and its **opaque black letterboxing
after grading**: padding is not graded/lifted and its coverage remains one.
Even a tiny nonneutral edit uses transformed transparent coverage. An evaluated
neutral keyed pose also uses the neutral rendering path, but the existence of
keyframes still excludes static export. The inverse geometry's generic coverage test
does not itself make neutral letterbox pixels opaque; the renderer does.

For each source $i$ at an output pixel, let $G_i$ be graded sampled RGB, $b_i$
black-fade brightness, $o_i$ the sole evaluated video track Opacity, $w_i$ dissolve weight
and $m_i$ the source coverage mask (one throughout the neutral canvas, with black
RGB padding). A dissolve remains **one premultiplied track group**:

$$
C=\sum_i G_i b_i o_i w_i m_i,\qquad A=\sum_i o_i w_i m_i,
\qquad \mathrm{result}=C+\mathrm{lower}(1-A).
$$

Both dissolve sources use the same video track Opacity value/curve, but their own spatial
poses and masks. No second track/group opacity multiplier exists. Black fades
change RGB, not available coverage. Spatial RGB resampling precedes grading;
neither graded endpoint images nor endpoint LUTs are interpolated for animation.
Ungraded comparison bypasses colour only, preserving spatial geometry/coverage.

## Preview, native export and resource boundaries

WebGL2 consumes the shared inverse affine mapping and crop bounds with explicit
top-left/source-texture orientation conversion. Native composited export uses
the same original-aspect mapping, bilinearly sampling the existing fitted RGB8
content and clamping sample taps to that content, not its black decode padding.
Fractional sampled RGB is graded through the reusable LUT before RGBA16 group
composition. Neutral native samples retain old byte indexing and opaque padding.
Native LUT interpolation, fitted decode resolution and final H.264/YUV
quantisation are approximations, not bitwise GPU/native equivalence.

Any nonneutral saved base or **any** spatial keyframes, even all-neutral keyframes, require
composited export. Static export additionally needs one enabled video track with Opacity 1,
no track keyframes, zero origin, no internal gaps and coverage of full project duration.
The two-normal-speed-clip diagnostic reference rejects spatial edits/keyframes;
use production Export. Its receipt/report formats are independent of project schema.

No transformed image or duration-sized pose/mask buffer is allocated. The native
budget remains four raw buffers (two RGB8 + two RGBA16), **22 bytes/pixel =
182,476,800 bytes UHD**, and two reusable 65³ Float32 LUTs, **6,591,000 bytes**.
Serial passes retain at most one original decoder, two intermediate readers,
one encoder and three native video children, two retained clip files and three
timeline representations. No per-frame FFmpeg process or LUT file is introduced.
Native/audio overhead and duration-dependent scratch remain additional;
these bounds are not throughput or fixed-disk-space promises. Preview retains
two decoder/texture slots per video track (16 for eight), plus one source-review decoder.

## Clip → Transform controls

**Transform** is the second Clip section (after Speed, before Range and Placement), collapsed for
new preferences. **Expand all / Collapse all** includes **Speed**, **Transform**,
**Range** and **Placement**. Existing expansion preferences remain
respected; **Transform animation** heading help is reachable while collapsed.
An empty video track shows no Clip sections, only **Select a clip on … to edit it.**

There is no Animate toggle or stored preference. Each setting always exposes its own capture button, a blue triangle
(hollow ▽ inactive, filled ▼ active) like the timeline marker, never the Colour diamond, and
Previous/Next buttons, and the expanded section's keyframe line shows the keyframe count, one Previous/Next
pair and Reset; it is hidden while the section is collapsed.

The eight **Crop left / Crop right / Crop top / Crop bottom / Scale / Translate X /
Translate Y / Rotation °** controls each pair a native slider with an exact field,
following the Colour pattern. A setting with no keys edits the clip base. Once a setting
has keys, its main field is read-only unless that setting is keyed at the **actually
displayed integer source frame** at the real project playhead;
other settings stay editable. Each setting's diamond (**Keyframe Scale**, etc.) captures
that setting's continuously evaluated value at the displayed source frame, creating a
Linear-eased key or joining the existing key there; a filled diamond removes only that
setting (and the key once no setting remains). Sliders/numbers never create keyframes.
Capture is unavailable outside the clip, during blocked/draft states or at the
256-key limit (removal and joining an existing key remain possible). Double-clicking a
setting's name resets only that setting.

**Previous/Next** per setting (**Previous Scale keyframe**, etc.) visit strictly earlier/
later keys that enable that setting. **Selected Transform keyframe**, the header's
**Previous/Next Transform keyframe** and
**Preview stored keyframe** navigate all retained source keyframes, including off-trim
keyframes and original exclusive OUT. Preview uses the closest actually mapped image
(first/last available output at trim boundaries), not a fictional source frame.
The UI distinguishes **Stored source frame** from **actual displayed source
frame**. Its independent clip-local stored-source cursor advances through successive
keyframes even when their nearest preview image is the same. This selection is
separate from track off-duration inspection and Speed's clip-local cursor;
main fields and capture never use the stored selection as a fake playhead.

The stored section edits only the selected key: **Source frame**, **Easing** and the
fields of its enabled settings. Contextual accessible easing names remain unchanged.
Easing is disabled when none of its enabled settings continues to a later key.
The trash action **Delete selected Transform keyframe** removes the whole key; deleting
a setting's last key restores its saved base. **Reset transform** clears the whole spatial
animation and restores the neutral base in one Undo step.

Numeric drafts retain full entered precision, apply on Enter/blur and restore on
Escape. Empty/nonfinite/out-of-bounds values, fractional/out-of-original
frames and occupied keyframe times retain editable inline errors; they never clamp,
merge or overwrite. Value/time/easing edits do not automatically seek. Valid
edits are one Undo step; keyframe movement and Undo preserve selected field identity.
Slider movement drafts only the local control, not preview/document/history/save;
valid release commits once and updates the image. Escape, pointer cancellation,
lost capture or window blur restores the starting value; invalid release commits
nothing. Each keyboard slider adjustment is an individual validated edit. There
is no Transform canvas gizmo; timeline markers slide as described below.

### Timeline source-keyframe markers

Each clip rectangle shows Transform keys as boxed blue **▼** buttons overlapping its top edge, the same size as the amber Colour track markers (which overlap the bottom edge by the same amount), clear of the bottom shared project-time track markers and the salmon/dashed **◆** custom-speed lane (the clip label sits below them); the tab shape and the marker's accessible name and tooltip (which
list the enabled settings) distinguish it without relying on colour. One marker
represents one key, however many settings it enables.
Source keyframes use the clip's authoritative retiming to locate output positions;
off-trim keyframes are omitted. A keyframe at exclusive OUT is a boundary marker and seeks
the final available frame. Click, Enter or Space selects the clip, seeks the
nearest mapped image and opens Clip → Transform; a click edits nothing. A key slides to another original source frame by dragging (pointer travel in output frames mapped through the placed retiming; zero travel keeps its frame) or ←/→ (one source frame, Shift ten), keeping its easing and enabled settings. Drafts preview without history/save; a valid release is one `spatial` command and one Undo step, while Escape, cancellation, lost capture, blur, an occupied frame or an out-of-original frame restores. Marker keyboard
events do not also invoke timeline shortcuts. Speed markers indicate a track
Speed override, which retains the clip's source keyframes. Speed and Transform
stored navigation still reaches all retained off-trim/original-OUT keyframes
through independent clip-local source inspection;
main capture never substitutes that stored time for the real displayed source frame.

## Preservation

Projects and version-1 export receipt snapshots must satisfy strict **schema 12**,
including required clip spatial data and the unchanged identified music arrays.
Required video track Colour includes Temperature/Tint and static HSL/curves, with eleven
required nullable track keyframe fields. Incompatible v1–v11 projects/receipt snapshots
and completed videos remain untouched.
Recreate projects deliberately; do not migrate, default-fill, rewrite or delete old
data automatically. Registry/proxy/PCM and receipt/report format versions do not
change. Historical measurements/planning retain their original schema references.

Video track Temperature/Tint gains precede Exposure in the common grade of spatially
sampled RGB; static HSL and master/RGB curves follow scalar grading, before black
fades and coverage. No extra spatial field or keyframe is added. Compare bypasses all
Colour but preserves spatial mapping. See [Temperature/Tint](TEMPERATURE_AND_TINT.md)
and [advanced colour](HSL_AND_CURVES.md).
