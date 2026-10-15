# Clip Sharpen, Clarity and Denoise, and track HDR · strict project schema 22

Current contract for [#123](https://github.com/Plonk42/PasCap/issues/123): three
static, clip-owned detail filters applied identically in preview and native export,
plus the keyframable track Colour **HDR** look that shares their kernel (see
[HDR look](#hdr-look)).
This describes the implementation contract, not hardware/long-run qualification,
release approval or milestone closure. Usage is in [the user guide](../USER_GUIDE.md).

Implementation authorities: [settings and kernel](../../src/shared/detail.ts),
[required clip data](../../src/shared/model.ts), [preview shader](../../src/preview/shaders.ts),
[native composition](../../src/server/layered-frame.ts) and
[Detail controls](../../src/web/DetailControls.tsx).

## Owner decisions

| Question                | Decision                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Settings                | All three: **Sharpen**, **Clarity** and **Denoise**                                                                       |
| Ownership and animation | Clip-owned and static; no keyframes and no track channels                                                                 |
| Pipeline position       | On source pixels **before** the Colour grade, around the inverse-mapped source point (so they follow the track Transform) |
| Original                | Holding **Show original preview** bypasses Colour **and** Detail; geometry, Opacity, fades and music remain               |
| Radius                  | A fraction of the image height, so the 720p preview predicts 720p and UHD exports                                         |
| Denoise kind            | Spatial, edge-preserving (bilateral); no temporal or neighbouring-frame access                                            |

## Required data

Every schema-22 clip requires `detail: { sharpen, clarity, denoise }`, strict, with no
unknown fields, coercion, persisted defaults or load-time repair.

| Field     | Bounds | Neutral (new clips) | Meaning                                                     |
| --------- | ------ | ------------------- | ----------------------------------------------------------- |
| `sharpen` | 0–1    | 0                   | Fine-edge unsharp mask                                      |
| `clarity` | −1–1   | 0                   | Midtone local contrast; negative values soften it           |
| `denoise` | 0–1    | 0                   | Edge-preserving smoothing strength (range-kernel bandwidth) |

Neutral values are creation values only, never defaults for missing saved data.
Split, marked cuts and duplicate copy the clip's detail into each retained piece;
trims, moves (including to another track) and Ripple leave it unchanged. Detail never
changes timing, placement, speed, track Colour/Opacity or music. Projects 1–21 and
their receipt snapshots are rejected and preserved, without migration; recreate them.

## Kernel

Coordinates are normalized original-image $(u, v)$, the same space as crop. One
**unit** is $1/720$ of the image height: $\Delta v = 1/720$ and
$\Delta u = \Delta v \cdot H/W$ using the registered original aspect. That is one
pixel of the 720p preview and draft export and three pixels of a UHD export, so the
look scales with the image rather than the output resolution. Every tap is a bilinear
sample clamped to the image content (never decode padding). Values are encoded
BT.709 RGB in 0–1 and luma is $Y = 0.2126R + 0.7152G + 0.0722B$.

For centre sample $c$ the stages run **Denoise → HDR → Clarity → Sharpen**:

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

The output is $\mathrm{clamp}(D' + \text{clarity term} + \text{sharpen term}, 0, 1)$ per
channel, where $D'$ is $D$ after [HDR](#hdr-look) ($D' = D$ at HDR 0). Clarity and
Sharpen measure $y = Y(D)$ before HDR, so they never re-amplify the tone change.
Luma detail is added equally to R, G and B, so it does not create colour
fringes. At most 33 taps per source pixel without HDR (57 with it); Sharpen alone
needs 9, Clarity alone 17, HDR alone 25.

**Exact neutral settings are a bypass**: all three zero and track HDR exactly zero skip
the kernel entirely, so neutral output is bit-identical to unfiltered rendering in
preview, static and composited export. Any nonzero value, however small, uses the kernel.

## HDR look

**HDR** is an SDR local tone-mapping look, not HDR output, Kelvin or automatic
exposure: it opens shadows and recovers highlights over large areas while boosting
local detail, preserving true black, mid-grey and white on flat areas.

- **Data**: required track `colour.hdr` in **0–1**, neutral 0 on new tracks, and the
  fourteenth nullable track keyframe channel `hdr`, after `blacks`. It is keyframed,
  interpolated, held and reset exactly like the other scalar Colour settings, at
  absolute project time; both dissolve sources and every clip on the track use the
  same evaluated value. Missing fields are invalid; schemas 1–21 are rejected and preserved.
- **Not a grade stage**: it is excluded from the per-pixel grade, its LUTs and LUT
  identity, so animating HDR reuses one scalar LUT. It runs in this kernel, on source
  taps after Denoise, with the evaluated amount $h$.
- **Base**: an edge-aware large-scale luma mean $B$ of the centre ($y = Y(D)$, weight 1)
  and 24 taps on rings of eight directions at radii 6, 16 (rotated 22.5°) and 32 units,
  with spatial weight $e^{-r^2/(2\cdot16^2)}$ and range weight
  $e^{-(Y(t)-y)^2/(2\cdot0.12^2)}$ on each tap's luma $Y(t)$. The range weight keeps
  a strong edge from pulling the base across it, avoiding halos.
- **Tone**: target luma $y' = B + h\,B(1-B)(1-2B) + (y-B)(1+h)$: the base keeps 0, ½
  and 1 while shadows rise and highlights fall (monotonic for $h \le 1$), and the local
  residual $y-B$ is boosted up to ×2.
- **Colour**: with $\Delta = y' - y$ and blend $b = \min(1, y/0.1)$, each channel becomes
  $D_i + \Delta + b\,(D_i\,y'/y - D_i - \Delta)$ (just $D_i + \Delta$ at $y = 0$): a
  hue-preserving luma ratio, fading to an additive change in deep shadows where the
  ratio would amplify noise.

Any nonzero HDR base or HDR keyframe requires composited export (keyframes already do).
In preview, HDR uses the detail program variants below (one extra `vec2` uniform for
both sources' amounts); no texture, buffer, decoder,
LUT or native process is added. The diagnostic two-clip reference and measurement
helper reject HDR. **Track → Colour** lists HDR last, in its Effects group, with the common slider/exact
field, capture diamond and Previous/Next arrows, live slider preview and one Undo
per release. The Original preview bypasses it with the rest of Colour.

## Pipeline order

Inverse track Transform mapping → **Detail and HDR** on source taps → track Colour grade (Temperature/Tint
… curves) → black fades → Opacity/spatial coverage and grouped source-over. Detail
is not graded twice, does not change coverage and leaves the exact-neutral opaque
letterbox path in place: with a neutral pose the filter runs at each fitted pixel
centre, whose centre tap equals the byte-indexed sample. The Original preview bypasses
Colour and Detail, never geometry, Opacity, fades, stacking or music.

## Preview, export and resources

The WebGL shader generates its tap tables from the same constants as the CPU kernel.
The kernel lives only in three separate detail variants of the fixed programs, compiled
when a loaded or edited project first contains nonneutral detail, nonzero track HDR or
HDR keyframes (including a live HDR slider draft), before any draw uses them; uniforms
are one `vec4` and one `vec2` per source plus the shared HDR `vec2`. Groups whose
sources are all neutral with HDR 0 (and the Original preview) keep the unchanged programs: software rasterizers can pay for
texture taps behind an untaken uniform branch. No texture, framebuffer, decoder or
pass is added; sources are still graded once.

Any nonneutral clip detail requires composited export; the static LUT fast path
cannot represent a neighbourhood filter. The native compositor evaluates the shared
kernel on the existing fitted RGB8 frame inside the existing worker bands, before
LUT or exact grading. No image, mask, LUT or full-frame buffer and no native process
is added: four raw buffers (22 bytes/pixel), two LUTs and the serial child limits are
unchanged. Up to 33 bilinear taps per source pixel make detail the costliest
composited path after exact HSL/curves, especially at UHD. The diagnostic two-clip
reference and the measurement helper reject nonneutral detail.

### GPU export worker

When a hardware GPU is available, export renders every track group frame whose CPU path
is per-pixel heavy with the **same WebGL programs as the preview**: nonneutral detail or
HDR, nonneutral HSL ranges or colour curves, or a nonneutral evaluated track Transform pose on
either source. It uses one headless Chrome page the service launches per
export ([service side](../../src/server/gpu-compositor.ts),
[page](../../src/gpu-worker/main.ts)). Neutral, scalar-colour and Opacity/fade-only
frames stay on the CPU compositor, which is exact there (neutral frames stay bit-identical),
at least as fast as the transport below, and remains the parity reference.

- **Launch**: `PASCAP_CHROME` or `google-chrome`/`chromium` from PATH, `--headless=new`,
  a temporary profile and no DevTools port, trying ANGLE `vulkan` (which selects a
  discrete GPU when present) then `gl` (the display's, often integrated, GPU) with the GPU
  blocklist ignored. The page reports its renderer; software renderers (SwiftShader,
  llvmpipe, lavapipe) are rejected because they are no faster than the CPU pool. A
  missing browser, rejected renderer, 30-second startup timeout or any later failure
  (page error, browser exit, 60-second frame timeout) falls back to the CPU compositor
  for the rest of the export, reported in Activity and in the receipt's layered report
  (`gpuRenderer`, `gpuFrames`, `gpuFallback`). `PASCAP_GPU_COMPOSITING=off` disables it.
- **Transport**: plain loopback HTTP on a per-launch port with a random token, Host check
  and one frame in flight. The page fetches each frame's fitted RGB8 content and the
  same evaluated per-source parameters as the CPU path, draws the group over transparent
  black into a 16-bit render target (`EXT_texture_norm16`, else RGBA32F) and posts the
  premultiplied RGBA16 result in four row bands, each uploaded while the next is read
  back; the service streams every band straight into its rows of the existing
  accumulator. Node gains no frame buffer; cancellation and failure stop the browser
  and delete its profile. Profiles name the owning service process, so the next export
  removes those left by a service that was killed (for example a `tsx watch` restart).
- **Budget**: one browser process (with its own GPU/renderer helpers) per export, two
  source textures, one target-size render target and readback array in the page.
- **Parity**: the shaders meet the GPU gates above against the CPU kernel; the native
  720p detail/HDR, spatial, HSL/curves and dissolve/fade/Opacity parity cases also run
  through the worker (SwiftShader, accepted only in tests) under the unchanged canonical
  and full-resolution coverage gates. Transformed coverage edges are computed in float32,
  as in the preview.
- **Why not every group**: complete `final4k` exports of 60 synthetic UHD frames (decode, group
  composition, x264 encode, verification) on a 16-thread host with the NVIDIA T1200 (Vulkan),
  three repetitions with a rotated mode order, median wall seconds (min–max). Every GPU run
  reported 60/60 worker frames on the T1200 and no fallback. "All on GPU" forces every group
  frame through the worker; it is a measurement mode, not a product setting.

  | Case              | CPU compositor      | As shipped (heavy groups on GPU) | All groups on GPU |
  | ----------------- | ------------------- | -------------------------------- | ----------------- |
  | neutral           | 33.5 (33.3–34.7)    | 33.2 (CPU)                       | 37.7 (37.4–37.9)  |
  | scalar colour     | 30.3 (30.1–30.5)    | 30.6 (CPU)                       | 35.9 (35.7–36.0)  |
  | Opacity and fades | 31.7 (31.7–31.8)    | 31.4 (CPU)                       | 35.8 (35.7–36.5)  |
  | HSL + curves      | 41.3 (40.3–43.1)    | 36.4 (35.7–37.4)                 | 35.9 (35.8–37.3)  |
  | spatial pose      | 37.1 (35.3–37.2)    | 35.4 (34.8–35.5)                 | 35.2 (34.9–36.0)  |
  | spatial dissolve  | 55.0 (54.1–55.5)    | 50.1 (49.4–50.9)                 | 50.4 (49.3–50.9)  |
  | detail + HDR      | 219.0 (216.9–223.7) | 39.1 (38.1–39.4)                 | 39.1 (38.7–39.8)  |

  Composition alone is 13 s on the CPU for neutral and scalar-colour frames versus about 20 s
  through the worker (loopback transport, about 170 ms per UHD frame), so cheap groups stay on
  the CPU. The gain for HSL/curves, spatial poses and dissolves is 2–5 s per 60 frames on this
  host; detail and HDR gain far more. Synthetic noise sources, one host and one GPU: with fewer
  CPU cores the worker's advantage should grow, but that is not measured here.

- **Measured** (synthetic UHD, HDR 0.27 + Sharpen 0.3, Intel UHD GT1 iGPU): group
  composition 2.77 s → 0.21 s per frame in isolation (0.33 s inside an export, mostly
  loopback transport); a 30-frame lossless layered render 98.5 s → 26.4 s, where the
  FFmpeg passes and ≈ 3 s of browser startup now dominate. A discrete NVIDIA T1200
  (Vulkan) composes the same frame in the same ≈ 0.21 s: loopback transport, not the
  GPU, bounds it; its browser starts in ≈ 1 s instead of ≈ 3 s. Owner 4K test project
  (1,509 frames, Intel): ≈ 13 min export, 0.28 s per composed frame. With span pipelining
  ([resources](../LAYERS_AND_KEYFRAMES.md#inspector-and-resource-limits)) and banded
  uploads, a 60-frame UHD render with a direct x264 medium encode went 44.7 s → 40.4 s,
  composition 0.37 s → 0.34 s per frame under encoder load; that synthetic noise
  makes x264 the floor.

## Editing

**Detail** is the second Clip section (after Speed, before Range and
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
  including HDR (agreement to $10^{-12}$), edge/noise behaviour, HDR black/grey/white
  preservation, detail boost, hue preservation and no halo at a strong edge, commands,
  export routing, one reused LUT while HDR animates and the
  native compositor at 720p and UHD (≤ 0.01/255 before RGBA16 rounding).
- GPU (SwiftShader in CI): every setting, track HDR and rotated/scaled combinations against the
  CPU kernel on a 720p synthetic texture at 1280×720 and 3840×2160, max < 2/255 and
  mean < 0.6/255 per channel; each case must change the fixture by more than 8/255.
  Measured locally: max 0.50, mean 0.20–0.21.
- Native FFmpeg: lossless 720p exports with detail on the neutral and transformed
  paths keep the existing canonical max < 2 and MAE < 1 gates.
- Synthetic fixtures only. These checks do not qualify intended-GPU speed, real
  footage, long flights or throughput.
