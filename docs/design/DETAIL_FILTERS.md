# Clip Sharpen, Clarity and Denoise · strict project schema 14

Current contract for [#123](https://github.com/Plonk42/PasCap/issues/123): three
static, clip-owned detail filters applied identically in preview and native export.
This describes the implementation contract, not hardware/long-run qualification,
release approval or milestone closure. Usage is in [the user guide](../USER_GUIDE.md).

Implementation authorities: [settings and kernel](../../src/shared/detail.ts),
[required clip data](../../src/shared/model.ts), [preview shader](../../src/preview/shaders.ts),
[native composition](../../src/server/layered-frame.ts) and
[Detail controls](../../src/web/DetailControls.tsx).

## Owner decisions

| Question                | Decision                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Settings                | All three: **Sharpen**, **Clarity** and **Denoise**                                                             |
| Ownership and animation | Clip-owned and static, like a Transform base; no keyframes and no track channels                                |
| Pipeline position       | On source pixels **before** the Colour grade, around the inverse-mapped source point (so they follow Transform) |
| Compare                 | **Show ungraded preview** bypasses Colour **and** Detail; geometry, Opacity, fades and music remain             |
| Radius                  | A fraction of the image height, so the 720p preview predicts 720p and UHD exports                               |
| Denoise kind            | Spatial, edge-preserving (bilateral); no temporal or neighbouring-frame access                                  |

## Required data

Every schema-14 clip requires `detail: { sharpen, clarity, denoise }`, strict, with no
unknown fields, coercion, persisted defaults or load-time repair.

| Field     | Bounds | Neutral (new clips) | Meaning                                                     |
| --------- | ------ | ------------------- | ----------------------------------------------------------- |
| `sharpen` | 0–1    | 0                   | Fine-edge unsharp mask                                      |
| `clarity` | −1–1   | 0                   | Midtone local contrast; negative values soften it           |
| `denoise` | 0–1    | 0                   | Edge-preserving smoothing strength (range-kernel bandwidth) |

Neutral values are creation values only, never defaults for missing saved data.
Split, marked cuts and duplicate copy the clip's detail into each retained piece;
trims, moves (including to another track) and Ripple leave it unchanged. Detail never
changes timing, placement, speed, track Colour/Opacity or music. Projects 1–13 and
their receipt snapshots are rejected and preserved, without migration; recreate them.

## Kernel

Coordinates are normalized original-image $(u, v)$, the same space as crop. One
**unit** is $1/720$ of the image height: $\Delta v = 1/720$ and
$\Delta u = \Delta v \cdot H/W$ using the registered original aspect. That is one
pixel of the 720p preview and draft export and three pixels of a UHD export, so the
look scales with the image rather than the output resolution. Every tap is a bilinear
sample clamped to the image content (never decode padding). Values are encoded
BT.709 RGB in 0–1 and luma is $Y = 0.2126R + 0.7152G + 0.0722B$.

For centre sample $c$ the stages run **Denoise → Clarity → Sharpen**:

1. **Fine ring** (only when Sharpen or Denoise is nonzero): the eight neighbours at
   unit offsets $(\pm1, 0), (0, \pm1), (\pm1, \pm1)$ with Gaussian spatial weights
   $s = e^{-d^2/2}$ (centre 1). Their weighted mean is $G$.
2. **Denoise** adds the eight neighbours at offsets $(\pm2, 0), (0, \pm2), (\pm2, \pm2)$
   with the same spatial Gaussian, and weights every tap (fine and wide) by
   $s \cdot \exp(-\overline{\Delta^2} / (2\sigma^2))$, where $\overline{\Delta^2}$ is the
   mean squared RGB difference to $c$ and $\sigma = 0.1 \cdot \mathrm{denoise}$.
   The normalized weighted mean is $D$; without Denoise $D = c$. The exponent factor
   is capped at $10^{30}$ so tiny strengths stay finite in float32.
3. **Clarity**: $L$ is the luma mean of $c$ and sixteen taps on two rings of eight
   directions at radii 5 and 10 units. With $y = Y(D)$ and midtone mask
   $m = \mathrm{clamp}(4y(1-y), 0, 1)$, it contributes $\mathrm{clarity} \cdot m \cdot (y - L)$.
4. **Sharpen** contributes $2 \cdot \mathrm{sharpen} \cdot (y - Y(G))$. Using the denoised
   centre against the raw Gaussian keeps sharpening from re-amplifying removed noise.

The output is $\mathrm{clamp}(D + \text{clarity term} + \text{sharpen term}, 0, 1)$ per
channel: luma detail is added equally to R, G and B, so it does not create colour
fringes. At most 33 taps per source pixel; Sharpen alone needs 9, Clarity alone 17.

**Exact neutral settings are a bypass**: all three zero skip the kernel entirely, so
neutral output is bit-identical to unfiltered rendering in preview, static and
composited export. Any nonzero value, however small, uses the kernel.

## Pipeline order

Inverse spatial mapping → **Detail** on source taps → track Colour (Temperature/Tint
… curves) → black fades → Opacity/spatial coverage and grouped source-over. Detail
is not graded twice, does not change coverage and leaves the exact-neutral opaque
letterbox path in place: with a neutral pose the filter runs at each fitted pixel
centre, whose centre tap equals the byte-indexed sample. Compare (Ungraded) bypasses
Colour and Detail, never geometry, Opacity, fades, stacking or music.

## Preview, export and resources

The WebGL shader generates its tap tables from the same constants as the CPU kernel,
in the existing three fixed programs; uniforms are one `vec4` and one `vec2` per
source. Neutral sources take a uniform branch with no extra taps. No texture,
framebuffer, decoder or pass is added; sources are still graded once.

Any nonneutral clip detail requires composited export; the static LUT fast path
cannot represent a neighbourhood filter. The native compositor evaluates the shared
kernel on the existing fitted RGB8 frame inside the existing worker bands, before
LUT or exact grading. No image, mask, LUT or full-frame buffer and no native process
is added: four raw buffers (22 bytes/pixel), two LUTs and the serial child limits are
unchanged. Up to 33 bilinear taps per source pixel make detail the costliest
composited path after exact HSL/curves, especially at UHD. The diagnostic two-clip
reference and the measurement helper reject nonneutral detail.

## Editing

**Detail** is the third Clip section (after Speed and Transform, before Range and
Placement), collapsed by default and included in **Expand all / Collapse all**.
**Sharpen**, **Clarity** and **Denoise** each pair a native slider with an exact field
(step 0.01). Dragging a slider previews the draft value live in the image, coalesced
to the display rate, without a document, history, save or music change; release
commits one validated edit and one Undo step. Escape, pointer cancellation, lost
capture or window blur restores the control and preview. Numeric entry keeps full
precision, applies on Enter/blur and restores on Escape; out-of-range drafts stay
editable with an inline error and never clamp. Double-clicking a setting's name resets
only that setting; **Reset detail** restores all three in one Undo step.

## Validation and parity gates

- Unit: strict schema, neutral bypass, an independent transcription of the kernel
  (agreement to $10^{-12}$), edge/noise behaviour, commands, export routing and the
  native compositor at 720p and UHD (≤ 0.01/255 before RGBA16 rounding).
- GPU (SwiftShader in CI): every setting and a rotated/scaled combination against the
  CPU kernel on a 720p synthetic texture at 1280×720 and 3840×2160, max < 2/255 and
  mean < 0.6/255 per channel; each case must change the fixture by more than 8/255.
  Measured locally: max 0.50, mean 0.20–0.21.
- Native FFmpeg: lossless 720p exports with detail on the neutral and transformed
  paths keep the existing canonical max < 2 and MAE < 1 gates.
- Synthetic fixtures only. These checks do not qualify intended-GPU speed, real
  footage, long flights or throughput.
