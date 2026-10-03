# PasCap colour and timing contract · v3

This specification precedes the preview controls. It is shared by the CPU reference,
WebGL2 shader and generated native FFmpeg LUTs. It is elementary SDR grading, not
highlight recovery. Originals remain untouched.

## Colour

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
  contaminate fade-to-black. No hidden sharpening, tone mapping or loudness change.
- Static single-layer export generates a 65³ cube from the CPU transform for
  FFmpeg `lut3d` tetrahedral interpolation. Layered/animated export reuses at most
  two in-memory 65³ Float32 LUTs generated from the **evaluated grading parameters**;
  tetrahedral sampling feeds premultiplied RGBA16 composition before final H.264.
  No endpoint-LUT/image crossfade substitutes for parameter animation. Scaling to
  the fitted target image occurs before grading; padding is black after grading.
  Quantisation, interpolation and 4:2:0 encoding are
  documented differences, not claimed equivalence. Tests measure LUT error and
  GPU/CPU/native pixel error. Extreme slider settings may have larger LUT error.

## Opacity and animation

Clip opacity/colour/speed keys use integer **original-source frames**. Layer-opacity
keys use integer **project frames**. Hold/linear/ease-in/ease-out/smooth interpolation
belongs to the left key; endpoints hold outside the keyed interval. Colour evaluates
all seven parameter values before applying the equations above. Trim/split retain
keys, including those outside the excerpt but inside the registered original.

For each enabled layer, source-over uses premultiplied encoded RGB/coverage.
Let `w` be dissolve weight, `o` clip opacity, `b` black-fade brightness and `G` graded
RGB. Group RGB is `C = Σ(G × o × w × b)` and coverage is `A = Σ(o × w)`.
Layer opacity `l` is applied once: `result = l × C + lower × (1 − l × A)`.
The primary dissolve is one group, preventing unintended double attenuation;
overlay groups have one source at a time. Black fades affect RGB, **not alpha**.
Enabled layer groups blend bottom-to-top over opaque black, with no implicit linear-
light blend or extra tone map. See [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md).

## Timing

- All stored timing is integer **project frames**. Rate: exactly `30000/1001`.
  Seconds exist only at media API / FFmpeg boundaries. Source OUT is exclusive.
- Cuts consume zero frames. Primary ripple duration is the sum of retimed output
  durations minus primary dissolve overlaps, not source length at non-1× speed.
- Dissolve duration `D` consumes `D` tail/head frames, subtracting `D` from total
  duration. At overlapping frame `j` in `[0, D)`, right weight is `j / D`;
  left weight is `1 − j / D`. The next frame is solely the right clip.
  Both source frames are required even at a zero-weight endpoint.
- Black transition duration `D ≥ 2`: left fade-out is `ceil(D/2)` frames,
  right fade-in is `floor(D/2)` frames. There is no overlap or duration change.
- Opening/closing fades are inside the first/last primary clip, with no holds.
  Overlays remain unaffected; animate their opacity for separate fades.
- An `N ≥ 2` fade uses endpoint-inclusive weights `j/(N−1)` or `1−j/(N−1)`.
  A one-frame fade is a black frame. This yields two adjoining black frames at
  a black transition's centre. It is intentional, deterministic and testable.
- Incoming/outgoing transition and opening/closing regions must not overlap
  within a clip. Invalid durations/edits are rejected, never silently clamped.
- Primary splits copy settings/source keys, preserve exterior boundaries and add a cut.
  Overlay split pieces start consecutively and do not ripple other placements.
  Reordering preserves only unchanged adjacent ID pairs; new pairs become cuts.
- Trimming selects a recoverable source IN/OUT range inside the complete registered
  recording. Originals/proxies are never cut. Handles may restore previously omitted
  frames up to zero/the original frame count, independently for each clip instance.
  A completed drag is one undoable command; pointer drafts are not saved.
- Constant/ramp/keyframed speed changes output duration/source mapping using the shared
  contract in [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md). Transitions/fades stay in
  output frames. Grading remains independent per clip instance and before blending.
- Overlay starts are absolute project frames; gaps may reveal lower footage and
  tails may extend beyond the primary duration. No same-overlay-row overlap is
  allowed. Total duration is the maximum clip end, including hidden-layer tails;
  empty/entirely hidden regions are black.
- UI timecode is 30 fps non-drop-frame, labelled NDF. Duration in seconds uses the
  rational rate, so timecode is not a wall-clock duration at 29.97 fps.

## Preview and reference scope

The editor supports up to eight layers and arbitrary clip instances within schema
limits. Preview reuses two decoder/texture slots for one nonempty layer and up to
nine for eight layers, plus at most one separate source-review decoder. Resources
are not allocated per stored clip; missing observed frames buffer explicitly.

Production export reads originals and uses exact shared retiming. Plain static
single-layer edits retain bounded body/dissolve chunks. Layers/nontrivial opacity/
animated colour use sequential RGBA16 layer passes and one final H.264 encode,
with optional 48 kHz AAC music in both paths. Resource and numeric limits are in
[DELIVERY_STATUS.md](DELIVERY_STATUS.md).

The diagnostic reference accepts **exactly two normal-speed primary clips without
music, layers, nontrivial opacity or animation** and refuses unsupported documents.
It requires a strict schema-5 project snapshot, including explicit project media
membership; its reference receipt format remains independently version 1. New
measurement reports use `preview-v5` without overwriting historical reports.
Source ranges and every retained clip key position are validated against registered
original frame counts, including hidden layer references.