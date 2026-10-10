# PasCap colour and timing contract · project v15

This specification is shared by the CPU reference, WebGL2 shader and native
scalar LUT or exact advanced-colour export. It is elementary SDR grading, not
highlight recovery. Originals remain untouched.

## Colour

The video track's required `colour` (or evaluated colour keyframes) grades sampled RGB once.
Every clip on that track shares this treatment, whether keyframes are used or not.
Clips have no colour/correction field. Exactly neutral Colour short-circuits.
Grading precedes black fades and coverage/group composition. Native scalar paths
use track-only LUTs and retain at most two reused LUT arrays; advanced grades are exact.
See [track appearance](design/ROW_APPEARANCE.md) for ownership, UI and strict storage.

- Input/output: full-range normalised nonlinear R′G′B′, BT.709 primaries and transfer.
  Limited-range BT.709 Y′CbCr footage is converted with the BT.709 matrix first.
  Native rendering explicitly selects its input/output matrix and range.
- HTML video supplies browser-converted RGB textures. The preview treats these
  samples as BT.709 code values, with the browser's default video colour conversion.
  Browser/driver transfer or range differences must be measured, not assumed away.
  WebGL draws to an ordinary SDR sRGB canvas; numeric code-value comparison is the
  acceptance test. Wide-gamut/HDR input is rejected.
- Inverse BT.709: `L = V / 4.5` below `4.5 β`, otherwise
  `L = ((V + α − 1) / α)^(1 / 0.45)`, where
  `α = 1.09929682680944`, `β = 0.018053968510807` (continuous join).
- Temperature $T$ and Tint $I$: normalized −1…1, neutral 0. Raw linear gains are
  $q=(2^{T/2+I/4},2^{-I/4},2^{-T/2+I/4})$; normalize with
  $N=0.2126q_R+0.7152q_G+0.0722q_B$ and apply $L'=L\odot(q/N)$ before Exposure,
  without clipping intermediate gains/RGB. Positive Temperature warms; positive
  Tint adds magenta. Nonzero settings intentionally colour greys. Normalization
  preserves neutral-white linear BT.709 luminance before clipping only, not
  arbitrary coloured pixels or final output. CPU/reference/native/GPU use this
  same math, not Kelvin/HDR/automatic white balance. See
  [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
- Exposure: multiply linear RGB by `2^exposure`.
- Contrast: `(RGB − 0.18) × contrast + 0.18` (linear middle-grey pivot).
- Brightness: add its linear offset equally to all channels.
- Compute `Y = clamp(dot(RGB, [0.2126, 0.7152, 0.0722]), 0, 1)`.
  Shadows weight `(1 − Y)^2`, highlights weight `Y^2`. Add
  `0.25 × (shadows × (1 − Y)^2 + highlights × Y^2)` to each channel.
- Recompute unclipped linear luminance. Define
  `Cb = (B − Y) / 1.8556`, `Cr = (R − Y) / 1.5748`.
  Rotate `(Cb, Cr)` by hue in radians, then multiply by saturation.
  Reconstruct `R = Y + 1.5748 Cr`, `B = Y + 1.8556 Cb`,
  `G = (Y − 0.2126 R − 0.0722 B) / 0.7152`.
- Clip final linear RGB to `[0, 1]`. Apply BT.709 OETF:
  `V = 4.5 L` below `β`, otherwise `V = α L^0.45 − (α − 1)`.
- Grade each decoder independently, then blend **encoded** RGB for dissolves.
  Black fades multiply already-graded encoded RGB. Thus tinted/lifted black cannot
  contaminate fade-to-black. No hidden sharpening, tone mapping or loudness change;
  clip **Sharpen/Clarity/Denoise** and track **HDR** run only when set, on source
  taps before this grade ([detail filters](design/DETAIL_FILTERS.md)).
- With neutral HSL/identity curves, static single-track export generates a 65³
  scalar cube for FFmpeg `lut3d` tetrahedral interpolation. Composited/animated export
  reuses at most two scalar-only in-memory 65³ Float32 LUTs from **evaluated parameters**.
  Nonneutral HSL/curves instead require composited export and exact complete CPU
  grading on fractional sampled RGB before premultiplied RGBA16 and final H.264;
  narrow valid knees never pass through a LUT, including the preceding scalar stage.
  No endpoint-LUT/image crossfade substitutes for parameter animation. Scaling to
  the fitted target image occurs before grading. Exact neutral spatial poses retain
  the old opaque black padding after grading. Nonneutral spatial poses inverse-map
  and resample source RGB before grading, with transparent coverage outside the
  transformed/cropped original; crop does not refit the image.
  Quantisation, interpolation and 4:2:0 encoding are
  documented differences, not claimed equivalence. Tests measure LUT error and
  GPU/CPU/native pixel error. Extreme slider settings may have larger LUT error.

## Opacity and animation

Shared video track opacity and colour keyframes use integer **project frames** and
override each keyed channel across every clip on that track. Clip-instance
custom speed and spatial keyframes instead use integer **original-source frames**; unkeyed track colour
uses `layer.colour`. Clip speed and spatial settings remain per clip; speed is never a track channel. **Opacity** is one track-owned
setting: `VideoLayer.opacity` is a required number in 0–1, initially 1 on a new
track. Without keyed Opacity settings, every source uses that track value; otherwise
the track's sole `opacity` channel overrides it, including both dissolve sources.
There is no saved `clip.opacity` or second opacity channel. The eleven required
nullable keyframe fields are `opacity`, `temperature`, `tint`, `exposure`, `brightness`, `contrast`,
`hue`, `saturation`, `highlights`, `shadows` and `hdr`.
Hold/linear/ease-in/ease-out/smooth interpolation belongs to the left keyframe
with that setting enabled; endpoints hold outside the
keyed interval. Colour evaluates all nine scalar parameter values before applying the
equations above; evaluated HDR feeds the detail kernel before grading instead. Trim/split never copy or shift track keyframes; they retain clip-speed
and spatial anchors, including those outside the clip range and at the registered
original's exclusive OUT. Spatial poses evaluate continuously through the placed
retiming map, not at the floored recorded-image frame; see
[spatial transforms](design/SPATIAL_TRANSFORMS.md).

The single **Opacity** slider is in **Track → Colour**, beside the colour sliders,
and starts at **100%**. It edits track `opacity` without keyframes and works on an empty
track. With keyframes, only an enabled setting at the real playhead is editable; the hollow
diamond explicitly captures a setting that is not enabled there. Sliders never create keyframes.
This shared UI placement does not make Opacity an RGB grading parameter: it
controls coverage during composition after the SDR colour math above.

For each enabled video track, source-over uses premultiplied encoded RGB/coverage.
Let $w_i$ be dissolve weight, $o_i$ evaluated Opacity, $b_i$ black-fade brightness
and $G_i$ graded RGB, with $m_i$ spatial coverage at the output pixel. Evaluate the
track's Opacity for each source at the same project frame. Group RGB and coverage are
$C = \sum_i G_i b_i o_i w_i m_i$ and $A = \sum_i o_i w_i m_i$.
Source-over is $\mathrm{result} = C + \mathrm{lower}(1 - A)$, with no additional track multiplier.
Every track's dissolve is one group, preventing unintended double attenuation;
independent pairs may dissolve simultaneously on several tracks. Black fades affect
that track's RGB, **not alpha**, preserving its available coverage of lower footage.
Nonneutral poses use $m_i=0$ outside the transformed/cropped source. Exact neutral
poses preserve $m_i=1$ over the canvas and ungraded black letterbox RGB.
Enabled video track groups blend bottom-to-top over opaque black, with no implicit linear-
light blend or extra tone map. See [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

### Editor-only ungraded comparison

Timeline preview comparison replaces **all evaluated colour settings** with the
shared `NEUTRAL_COLOUR` value for every enabled video track and both sources in each
dissolve, bypassing track colour bases and evaluated track colour keyframes alike. Future
colour controls added to `NEUTRAL_COLOUR` are automatically bypassed, without a
separate per-control comparison list. Stored grades and keyframes are unchanged.

Only grading is neutralized: exact observed source frames and `PlacedClip.retiming`,
spatial geometry/coverage, track Opacity, visibility, dissolve weights, black fades, stacking
and music retain their normal contract. Ungraded is still the composed preview,
not an original-resolution or isolated-selected-clip view; Source preview is unchanged.

The Timeline preview heading's native **Compare** button is accessible as **Show
ungraded preview**; active mode reads **Ungraded** with a matching canvas badge.
It works paused or playing via pointer or focused Enter/Space, with no global shortcut.
Toggling is editor-only: no seek, save/history entry, export, schema, proxy or original
change, or additional decoder. Same-project seeks, appearance updates and timing
reloads preserve the mode; changing project or reloading with a fresh preview engine
resets to normal graded preview. Export continues to use the saved grading contract.

## Timing

- Project placements, track keyframes and output durations use integer **project frames**;
  source bounds and clip-speed/spatial anchors use integer **original-source frames**.
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
  a black transition's centre. It is intentional, deterministic and testable.
- Incoming/outgoing transition and opening/closing regions must not overlap
  within a clip. Invalid durations/edits are rejected, never silently clamped.
- Splits deep-copy static settings/clip-speed/spatial anchors, preserve exterior boundaries
  and add a cut; shared track keyframes stay at their project frames. Pieces recompile
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
  output frames. Shared video track Colour grades each source once before blending.
- Ripple-off starts are independent absolute project frames; gaps reveal lower
  footage/black. Exact adjacent Cross-dissolve overlap is the only allowed
  same-track overlap; triple overlap is invalid. Total duration is the maximum
  retimed clip end across all tracks (including hidden-track tails) and every
  music track's start + duration, bounded to 2,147,483,647 frames without clamping.
  Music can extend the project. Empty/entirely hidden video regions and music-only
  tails are opaque black, never a frozen last image; music fades at its own end.
- UI timecode is 30 fps non-drop-frame, labelled NDF. Duration in seconds uses the
  rational rate, so timecode is not a wall-clock duration at 29.97 fps.

## Music sampling and mixing

Strict schema 15 requires a 0–8 `music` array of independent uniquely identified
music tracks, `[]` without music. Each has source IN/OUT, start/duration, gain, fades
and loop; source-video audio remains disabled. At 48 kHz, source/placement/duration/
fade positions round independently to integer samples using the rational frame
rate. Each music track's selected source repeats only with explicit Loop, contributes
silence outside placement, and receives its own `10^(gainDb/20)` linear fade
envelope before mixing. Sum all music tracks linearly and **hard-clamp [−1, 1] once
after all sources**, never per-source or during native pairwise accumulation.
No normalisation, ducking, effects or hidden gain compensation. Music is not
retimed/rippled with video tracks; clip speed and track Colour/Opacity are unchanged.

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
no ID or first track has special editing privileges. Preview reuses two decoder/texture
slots per track in a nonempty project, up to **16 for eight**, plus at most one
separate source-review decoder. Resources
are not allocated per stored clip; missing observed frames buffer explicitly.

Production export reads originals and uses exact shared retiming. The static fast
path requires neutral HSL/identity curves, HDR 0, one enabled video track with Opacity 1, no track keyframes, exactly neutral
spatial bases without spatial keyframes, zero origin
and no internal gaps, covering full project duration; supported track fades/dissolves retain bounded chunks.
Other valid timelines use generalized sequential RGBA16 group and source-over
passes without regrading, then one final H.264 encode,
with optional mixed 48 kHz AAC music in both paths. Music beyond video OUT requires
composited export to render black through project OUT. Music-only preview is black;
export requires at least one retained video clip. Resource and numeric limits are in
[Inspector and resource limits](LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits).

The diagnostic reference accepts **exactly two normal-speed (constant 1×) clips on one
enabled, zero-origin contiguous video track with Opacity 1 and static scalar track Colour**,
neutral HSL and identity curves, HDR 0, exactly neutral spatial
bases without spatial keyframes, without music, extra tracks or track keyframes,
and is limited to 3,600 project frames. It refuses unsupported
documents regardless of Ripple or track ID.
It requires a strict schema-15 project snapshot, including explicit project media
membership; its reference receipt format remains independently version 1. New
measurement reports must identify their v15 project snapshot without overwriting
historical reports; the report identifier is separate from the project schema.
Project identifiers such as `preview-lab`/`preview-lab-v6` are not schema versions
and are not renamed by this contract.
v1–v14 project documents and receipt snapshots are incompatible and preserved;
recreate projects deliberately, with no migration, compatibility defaults or
old-format/null fallback readers or automatic deletion. Strict v15 requires
complete video track `colour`, including Temperature/Tint/HDR bases and static HSL/curves,
all eleven nullable keyframe fields, constant or custom-curve clip speed, clip `spatial` base/per-setting keyframes and track `opacity`; saved `clip.colour`, `clip.correction`, `clip.opacity` and
old `clipOpacity`/`layerOpacity` keyframe fields are rejected, not defaulted.
Production export receipts also remain version 1, with strict v15 snapshots and
required `musicSources` captured-original/`settings.audio` identified-plan arrays;
older snapshots or invalid arrays are rejected without rewriting receipts/MP4s.
Registry/proxy/current PCM formats and source guards are unchanged.
Source ranges and every retained clip keyframe position are validated against registered
original frame counts, including hidden track references.

Video track colour also requires static eight-band HSL and master/red/green/blue curves.
The order is decoded linear Temperature/Tint gains before Exposure and the
remaining scalar SDR stages, encoded BT.709 HSL, master curve, individual RGB
curves, black-fade brightness and group coverage/source-over. HSL/curves add no
channels to the eleven nullable track fields. HSL protects greys in its incoming
RGB, not greys already coloured by Temperature/Tint. Compare/Ungraded bypasses
the entire colour transform, not geometry or coverage. Precise advanced bounds,
circular weighting, smooth monotone cubic curves and resource budgets are in
[HSL_AND_CURVES.md](design/HSL_AND_CURVES.md).
