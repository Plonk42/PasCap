# PasCap color and timing contract

This specification is shared by the CPU reference, WebGL2 shader and native
scalar LUT or exact advanced-color export. It is elementary SDR grading, not
highlight recovery. Originals remain untouched.

## Color

Each source is graded by its clip's grade (`clip.grade`, keyframed at source frames), then by
the adjustment covering that project frame (`project.adjustments`, keyframed from its start):
each applies the complete grade below to the previous one's encoded output. Video tracks have
no Color, and a dissolve's two sources share the adjustment at that frame. An exactly neutral
grade short-circuits; a neutral clip grade without an adjustment returns its input unchanged.
Grading precedes black fades and coverage/group composition. Static export bakes each clip's
unkeyed scalar grade into its own LUT; composited paths compose each source's two scalar grades
into one of at most two reused LUT arrays, and advanced grades are exact.
See [clip grades and adjustments](design/ROW_APPEARANCE.md) for ownership, UI and strict storage.

- Input/output: full-range normalized nonlinear R′G′B′, BT.709 primaries and transfer.
  Limited-range BT.709 Y′CbCr footage is converted with the BT.709 matrix first.
  Native rendering explicitly selects its input/output matrix and range.
- HTML video supplies browser-converted RGB textures. The preview treats these
  samples as BT.709 code values, with the browser's default video color conversion.
  Browser/driver transfer or range differences must be measured, not assumed away.
  WebGL draws to an ordinary SDR sRGB canvas; numeric code-value comparison is the
  acceptance test. Wide-gamut/HDR input is rejected.
- Inverse BT.709: `L = V / 4.5` below `4.5 β`, otherwise
  `L = ((V + α − 1) / α)^(1 / 0.45)`, where
  `α = 1.09929682680944`, `β = 0.018053968510807` (continuous join).
- Temperature $T$ and Tint $I$: normalized −2…2 and −1…1, neutral 0. Raw linear gains are
  $q=(2^{T/2+I/4},2^{-I/4},2^{-T/2+I/4})$; normalize with
  $N=0.2126q_R+0.7152q_G+0.0722q_B$ and apply $L'=L\odot(q/N)$ before Exposure,
  without clipping intermediate gains/RGB. Positive Temperature warms; positive
  Tint adds magenta. Nonzero settings intentionally color grays. Normalization
  preserves neutral-white linear BT.709 luminance before clipping only, not
  arbitrary colored pixels or final output. CPU/reference/native/GPU use this
  same math, not Kelvin or HDR. **Auto white balance** only chooses a clip grade's Temperature/Tint
  keyframe values, and **Auto** ([Auto adjust](design/AUTO_ADJUST.md)) only chooses eleven of its
  scalar values or keyframe values by evaluating this grade; neither adds a stage. See
  [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
- Exposure: multiply linear RGB by `2^exposure`.
- Tone curves: compute `Y = clamp(dot(RGB, [0.2126, 0.7152, 0.0722]), 0, 1)` and
  encoded luminance `V = OETF(Y)`, then apply in order:
  - Contrast `c`: `V ← V + (c − 1) × V × (1 − V) × (2V − 1)`, an S-curve (c > 1) or
    flattening (c < 1) pivoting at encoded 0.5; its midtone slope is `(1 + c) / 2`.
  - Brightness `b`: `V ← V + 2b × V × (1 − V)`, moving mid gray by `b / 2`.
  - Shadows and Highlights are not part of this per-pixel grade: they are local
    exposure changes applied to source pixels before grading, from each area's
    edge-aware base brightness, with the clip grade's and adjustment's values summed
    and tones chosen after their summed Exposure. See
    [detail filters](design/DETAIL_FILTERS.md#local-shadows-and-highlights).
  - Whites `w`: `V ← V + 0.25w × V^4`, moving the white point: −1 dims pure white to 0.75,
    +1 pushes near-white tones to white; it barely touches tones below the upper range.
  - Blacks `k`: `V + 0.25k × (1 − V)^4`, moving the black point; it fades out towards white.
    Lowered (k < 0), `V ← max(0, V + 0.25k × (1 − V)^4)` joins the gain below, crushing
    near-black tones to black (at −1, everything below about encoded 0.14; mid gray moves
    by about 0.016) while keeping hue and saturation. Raised (k > 0), black cannot be
    scaled, so `V` is left for the gain and the luminance lift
    `EOTF(V + 0.25k × (1 − V)^4) − EOTF(V)` is added equally to every linear channel
    afterwards: a matte, faded look in which near-black tones turn grayer (black becomes
    encoded 0.25 at +1).

  Multiply every channel by `EOTF(V) / Y` (`(2 − c)(1 + 2b)` at `Y = 0`, or 0 when
  Blacks is lowered), then add any raised-Blacks lift. Each curve is monotonic over its
  whole range and keeps black (except raised Blacks) and white (except lowered Whites);
  as a gain the result keeps chroma ratios, so colors turn grayer only
  through the raised-Blacks lift and clip to black only through lowered Blacks.

- Recompute unclipped linear luminance. Define
  `Cb = (B − Y) / 1.8556`, `Cr = (R − Y) / 1.5748`.
  Rotate `(Cb, Cr)` by hue in radians, then multiply by
  `saturation × (1 + v × (1 − c))`. Vibrance `v` is −1…2, neutral 0; `c = (max − min) / max`
  of the linear RGB after the tone stages (0 for gray, 1 for a fully saturated color).
  Vibrance changes muted colors most and leaves fully saturated colors unchanged, so
  raising it does not push strong colors out of gamut; grays stay gray. There is no
  skin-tone protection. CPU reference, native LUT/exact grading and GPU shaders share
  this math; static Vibrance keeps the scalar LUT export path.
  Reconstruct `R = Y + 1.5748 Cr`, `B = Y + 1.8556 Cb`,
  `G = (Y − 0.2126 R − 0.0722 B) / 0.7152`.
- Clip final linear RGB to `[0, 1]`. Apply BT.709 OETF:
  `V = 4.5 L` below `β`, otherwise `V = α L^0.45 − (α − 1)`.
- Grade each decoder independently, then blend **encoded** RGB for dissolves.
  Black fades multiply already-graded encoded RGB. Thus tinted/lifted black cannot
  contaminate fade-to-black. No hidden sharpening, tone mapping or loudness change;
  clip **Sharpen/Clarity/Denoise** and the grades' **HDR** and **Local contrast** run only when set, on source
  taps before this grade ([detail filters](design/DETAIL_FILTERS.md)).
- With neutral HSL/identity curves, static single-track export generates a 65³
  scalar cube per clip for FFmpeg `lut3d` tetrahedral interpolation. Composited/animated export
  reuses at most two scalar-only in-memory 65³ Float32 LUTs from **evaluated parameters**,
  each composing a source's clip grade and adjustment.
  Nonneutral HSL/curves instead require composited export and exact complete CPU
  grading on fractional sampled RGB before premultiplied RGBA16 and final H.264;
  narrow valid knees never pass through a LUT, including the preceding scalar stage.
  No endpoint-LUT/image crossfade substitutes for parameter animation. Scaling to
  the fitted target image occurs before grading. Exact neutral track Transform geometry retains
  the old opaque black padding after grading. Nonneutral geometry inverse-maps
  and resample source RGB before grading, with transparent coverage outside the
  transformed/cropped original; crop does not refit the image.
  Quantization, interpolation and 4:2:0 encoding are
  documented differences, not claimed equivalence. Tests measure LUT error and
  GPU/CPU/native pixel error. Extreme slider settings may have larger LUT error.

## Opacity and animation

Clip grade keyframes and clip-instance custom speed keyframes use integer **original-source
frames**; adjustment keyframes count integer frames from the adjustment's start; track
Transform keyframes use integer **project frames** and override each keyed setting across every
clip on that track. Unkeyed grade settings use the grade's `color` and unkeyed Transform
settings `layer.transform.base`. Clip speed remains per clip and is never a grade setting.
**Opacity** is the ninth Transform setting: `transform.base.opacity` is a required number in
0–1, initially 1 on a new track, and nullable `opacity` in Transform keyframes overrides it
with its own Easing, including on both dissolve sources. There is no saved `clip.opacity` and
no Opacity in Color. The fourteen required nullable grade keyframe fields are `temperature`,
`tint`, `exposure`, `brightness`, `contrast`, `hue`, `saturation`, `vibrance`, `highlights`,
`shadows`, `whites`, `blacks`, `hdr` and `localContrast`.
Hold/linear/ease-in/ease-out/smooth interpolation is that setting's own Easing at the left keyframe
with that setting enabled; endpoints hold outside the
keyed interval. Each grade evaluates all twelve scalar parameter values before applying the
equations above; evaluated HDR and Local contrast feed the detail kernel before grading instead.
Trim/split keep each clip grade's keyframes on their source frames and never shift Transform
keyframes or adjustments; they retain clip-speed
anchors, including those outside the clip range and at the registered
original's exclusive OUT. Transform poses evaluate at absolute project time and apply to every
source on the track; see [track Transform](design/SPATIAL_TRANSFORMS.md).

The **Opacity** slider is in **Track → Transform**, after Rotation, and starts at **100%**.
It edits the Transform base without keyframes and works on an empty track. With keyframes, only
a setting keyed at the real playhead is editable; its hollow triangle explicitly captures it.
Sliders never create keyframes. Opacity is not an RGB grading parameter: it
controls coverage during composition after the SDR color math above.

For each enabled video track, source-over uses premultiplied encoded RGB/coverage.
Let $w_i$ be dissolve weight, $o_i$ evaluated Opacity, $b_i$ black-fade brightness
and $G_i$ graded RGB, with $m_i$ spatial coverage at the output pixel. Evaluate the
track's Transform, Opacity included, for each source at the same project frame; each source
keeps its own coverage mask. Group RGB and coverage are
$C = \sum_i G_i b_i o_i w_i m_i$ and $A = \sum_i o_i w_i m_i$.
Source-over is $\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no additional track multiplier.
Every track's dissolve is one group, preventing unintended double attenuation;
independent pairs may dissolve simultaneously on several tracks. Black fades affect
that track's RGB, **not alpha**, preserving its available coverage of lower footage.
Nonneutral geometry uses $m_i=0$ outside the transformed/cropped source. Exact neutral
geometry preserves $m_i=1$ over the canvas and ungraded black letterbox RGB, whatever the Opacity.
Enabled video track groups blend bottom-to-top over opaque black, with no implicit linear-
light blend or extra tone map. See [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

### Editor-only original preview

Holding the preview's **Original** button replaces **all evaluated color settings** with the
shared `NEUTRAL_COLOR` value for every enabled video track and both sources in each
dissolve, bypassing clip grades, adjustments and their keyframes alike, and bypasses clip
Detail. Holding **Shift** as it is pressed bypasses only clip grades and Detail, **Alt** only
adjustments. Future color controls added to `NEUTRAL_COLOR` are automatically bypassed,
without a separate per-control list. Stored grades and keyframes are unchanged.

Only grading is neutralized: exact observed source frames and `PlacedClip.retiming`,
spatial geometry/coverage, Opacity, visibility, dissolve weights, black fades, stacking
and music retain their normal contract. Original is still the composed preview,
not the untouched recording, an original-resolution or isolated-selected-clip view; Source preview is unchanged.

The native **Original** button is accessible as **Show original preview**; the image is original
with a canvas badge naming the mode only while the pointer or focused Enter/Space is held, and the graded
preview returns on release, focus loss or window blur. It works paused or playing, with no global shortcut.
Holding is editor-only: no seek, save/history entry, export, schema, proxy or original
change, or additional decoder. Same-project seeks, appearance updates and timing
reloads preserve the mode while it is held; changing project or reloading with a fresh preview engine
resets to normal graded preview. Export continues to use the saved grading contract.

## Timing

- Project placements, Transform keyframes, adjustments and output durations use integer **project frames**;
  source bounds, clip grade keyframes and clip-speed anchors use integer **original-source frames**.
  Rate: exactly `30000/1001`.
  Seconds exist only at media API / FFmpeg boundaries. Source OUT is exclusive.
- Cuts consume zero frames. With Ripple on, a track sequences from its first
  anchor: its OUT is that start plus each clip's own retimed duration minus dissolve
  overlaps, not raw source length at non-1× speed. Enabling closes gaps in one
  Undo while preserving the first current start; turning it off retains actual
  placements. While off, unrelated clips never move with duration edits.
- Dissolve duration `D` overlaps `D` retimed tail/head frames on its own track;
  video OUT uses the placed retiming map, not a global sum. Project duration is
  the maximum of all clip OUTs and every music start + duration. At overlapping
  frame `j` in `[0, D)`, right weight is `j / D`;
  left weight is `1 − j / D`. The next frame is solely the right clip.
  Both source frames are required even at a zero-weight endpoint.
  Non-cut edits require touching clips or an existing dissolve; a gapped pair is
  Cut only. A positioned dissolve edit explicitly changes the right start to
  left OUT minus D (or left OUT when removed), without moving other clips.
- Black transition duration `D ≥ 2`: left fade-out is `ceil(D/2)` frames,
  right fade-in is `floor(D/2)` frames. There is no overlap or duration change.
- Opening/closing fades are inside each track's first/last clip at actual
  placements, with no holds. They retain black-RGB/coverage-preserving math,
  never fade the entire composite, and stay stored but dormant on empty tracks.
  A closing fade ends at its last video clip OUT, not a later music/project OUT.
- An `N ≥ 2` fade uses endpoint-inclusive weights `j/(N−1)` or `1−j/(N−1)`.
  A one-frame fade is a black frame. This yields two adjoining black frames at
  a black transition's center. It is intentional, deterministic and testable.
- Incoming/outgoing transition and opening/closing regions must not overlap
  within a clip. Invalid durations/edits are rejected, never silently clamped.
- Splits deep-copy static settings, grades and clip-speed anchors, preserve exterior boundaries
  and add a cut; Transform keyframes and adjustments stay at their project frames. Pieces recompile
  and round independently. Ripple-on tracks re-sequence; off tracks retain
  unrelated placements. Reordering tracks changes composition, not clip timing.
  Reordering preserves only unchanged adjacent ID pairs; new pairs become cuts.
- Trimming selects a recoverable source IN/OUT range inside the complete registered
  recording. Originals/proxies are never cut. Handles may restore previously omitted
  frames up to zero/the original frame count, independently for each clip instance.
  A completed drag is one undoable command; pointer drafts are not saved.
- Constant or keyframed clip speed changes output duration/source mapping using the shared
  contract in [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md); a clip's duration never
  depends on its track or start. Transitions/fades stay in
  output frames. Each source is graded by its clip grade, then the adjustment at that frame,
  before blending.
- Ripple-off starts are independent absolute project frames; gaps reveal lower
  footage/black. Exact adjacent Cross-dissolve overlap is the only allowed
  same-track overlap; triple overlap is invalid. Total duration is the maximum
  retimed clip end across all tracks (including hidden-track tails) and every
  music track's start + duration, bounded to 2,147,483,647 frames without clamping.
  Music can extend the project. Empty/entirely hidden video regions and music-only
  tails are opaque black, never a frozen last image; music fades at its own end.
- UI timecode is 30 fps non-drop-frame, labeled NDF. Duration in seconds uses the
  rational rate, so timecode is not a wall-clock duration at 29.97 fps.

## Music sampling and mixing

Projects require a 0–8 `music` array of independent uniquely identified
music tracks, `[]` without music. Each has source IN/OUT, start/duration, gain, fades
and loop; source-video audio remains disabled. At 48 kHz, source/placement/duration/
fade positions round independently to integer samples using the rational frame
rate. Each music track's selected source repeats only with explicit Loop, contributes
silence outside placement, and receives its own `10^(gainDb/20)` linear fade
envelope before mixing. Sum all music tracks linearly and **hard-clamp [−1, 1] once
after all sources**, never per-source or during native pairwise accumulation.
No normalization, ducking, effects or hidden gain compensation. Music is not
retimed/rippled with video tracks; clip speed, grades, adjustments and Opacity are unchanged.

One AudioContext/worklet and output-timestamp epoch retain the exact one-frame
A/V bound through music-only black regions. Native audio uses serial selected
s16 PCM and Float64 accumulators, then one final clamp before AAC; output samples
cover full project duration, including music tails. See
[SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md) and
[MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md) for bounded-resource contracts and
pending acceptance, not completed-test claims.

## Preview and reference scope

The editor supports up to eight video tracks and arbitrary clips within schema
limits. Display and composition follow the same saved bottom-to-top track array;
no ID or first track has special editing privileges. Preview uses two WebCodecs
decoders/textures per track in a nonempty project, up to **16 for eight**, plus at
most one separate source-review decoder. Resources
are not allocated per stored clip; missing decoded frames buffer explicitly
([WebCodecs preview decoding](design/WEBCODECS_PREVIEW.md)).

Production export reads originals and uses exact shared retiming. The static fast
path requires no adjustments, every clip grade unkeyed, scalar-only and without
Shadows/Highlights/HDR/Local contrast, one enabled video track with an exactly neutral
Transform base, Opacity 1 and no Transform keyframes, zero origin
and no internal gaps, covering full project duration; supported track fades/dissolves retain bounded chunks.
Other valid timelines use generalized sequential RGBA16 group and source-over
passes without regrading, then one final H.264 encode,
with optional mixed 48 kHz AAC music in both paths. Music beyond video OUT requires
composited export to render black through project OUT. Music-only preview is black;
export requires at least one retained video clip. Resource and numeric limits are in
[Properties panel and resource limits](LAYERS_AND_KEYFRAMES.md#properties-panel-and-resource-limits).

The diagnostic reference accepts **exactly two normal-speed (constant 1×) clips on one
enabled, zero-origin contiguous video track with unkeyed scalar clip grades**,
without HSL, curves or Shadows/Highlights/HDR/Local contrast, an exactly neutral track Transform
base with Opacity 1 and without Transform keyframes, without adjustments, music or extra tracks,
and is limited to 3,600 project frames. It refuses unsupported
documents regardless of Ripple or track ID.
It requires a strict current-schema project snapshot, including explicit project media
membership; its reference receipt format remains independently version 1. New
measurement reports must identify their project snapshot's schema without overwriting
historical reports; the report identifier is separate from the project schema.
Project identifiers such as `preview-lab`/`preview-lab-v6` are not schema versions
and are not renamed by this contract.
Projects and receipt snapshots saved before the current schema, with track Color or British spelling, are
rejected with the reason and left unchanged, with no compatibility defaults, old-format/null
fallback readers or automatic deletion. The strict current schema requires
a complete `grade` on every clip (Color, including Temperature/Tint/Vibrance/Whites/Blacks/HDR/Local
contrast bases and static HSL/curves, and keyframes with all fourteen nullable fields), the
`adjustments` array, constant or custom-curve clip speed, boolean clip `reverse` and track
`transform` base/per-setting keyframes, Opacity included; video tracks carry no `color`,
`opacity` or `keyframes`, and saved `clip.color`, `clip.correction`, `clip.opacity` and
`clip.spatial` are rejected, not defaulted.
Production export receipts also remain version 1, with strict current-schema snapshots and
required `musicSources` captured-original/`settings.audio` identified-plan arrays;
older snapshots or invalid arrays are rejected without rewriting receipts/MP4s.
Proxy/current PCM formats and source guards are unchanged; the registries are
version 3 (videos) and 2 (music), with full-content checksums.
Source ranges and every retained clip speed keyframe position are validated against registered
original frame counts, including hidden track references.

Each grade, clip grade or adjustment, also requires static eight-band HSL and master/red/green/blue curves.
The order is decoded linear Temperature/Tint gains before Exposure and the
remaining scalar SDR stages, encoded BT.709 HSL, master curve, individual RGB
curves, then the adjustment's grade in the same order, black-fade brightness and group
coverage/source-over. HSL/curves add no channels to the fourteen nullable keyframe fields.
HSL protects grays in its incoming
RGB, not grays already colored by Temperature/Tint. The Original preview bypasses
the entire color transform, not geometry or coverage. Precise advanced bounds,
circular weighting, smooth monotone cubic curves and resource budgets are in
[HSL_AND_CURVES.md](design/HSL_AND_CURVES.md).
