# Historical preview feasibility · 2026-10-02

## Decision

**Functional preview foundation established. Performance gate remains pending.**

The integrated VS Code browser uses the Intel GPU, not the intended discrete GPU.
The user explicitly deferred performance acceptance to a GPU-capable external
browser. Do not optimise against the embedded-browser limitation or switch the
decoding architecture based on those results alone.

This report records the original preview milestone. A subsequent usability step
adds a compact many-recording library, multi-clip preview using the same two
decoders, and reversible timeline trim/insert/reorder/history interactions; see
[TIMELINE_EDITING.md](TIMELINE_EDITING.md). A further v2 extension adds projects,
music, per-clip speed curves and bounded 720p/4K native export. Target-GPU and
full-flight validation remain pending. The colour measurements below remain
evidence for the unchanged grading contract, not a new multi-clip performance claim.

The **2026-10-03 v3 extension** additionally implements eight-layer composition,
clip/layer opacity, source-anchored speed/colour/opacity keys, source hover review/
pre-trims and collapsible inspector sections. Preview now uses a bounded pool up
to nine decoders rather than a fixed pair for multi-layer projects. Native export
adds sequential RGBA16 animated-layer passes. Those extensions have their own
numeric/browser evidence in Git history and semantics
in [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md). The original two-source
measurements below are preserved; they do not certify layered-GPU throughput.

The later schema-5 project-bin/deletion checkpoint is also historical, not the
current schema contract. Current uniform-track storage, timing and resource bounds
are in [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md); this report's two-source
measurements and later-extension descriptions do not certify the current build.
Current delivery and verification are recorded on
[GitHub work issues](https://github.com/Plonk42/PasCap/issues) and
[actual-commit CI](https://github.com/Plonk42/PasCap/actions).

## Environment and source facts

- Linux `7.0.0-34-generic`, Node `22.23.3`, FFmpeg `8.0.1`.
- Intel i7-11850H, 8 cores / 16 logical CPUs, approximately 45.46 GiB RAM.
- Available graphics: Intel UHD (Tiger Lake GT1) and NVIDIA T1200 Laptop GPU.
- Embedded renderer observed: `ANGLE (Intel, Mesa Intel(R) UHD Graphics (TGL GT1), OpenGL ES 3.2)`.
- Automated correctness measurements: Chrome `154.0.8037.57`, headless, using
  **SwiftShader**, not the discrete GPU. These are numerical/correctness evidence,
  not performance certification for the target GPU.
- Two read-only Taillefer sources were re-probed:
  - DJI_0468: 3840×2160 H.264/yuv420p, 569 video frames.
  - DJI_0469: 3840×2160 H.264/yuv420p, 313 video frames.
  - Both: exactly 30000/1001, limited-range SDR BT.709, no audio stream.
  - Video timing is taken from the video stream, not the longer DJI sidecar/container duration.

The service checks header agreement, every video packet's PTS/duration, unique
consecutive project-frame positions, and proxy frame count. It does not normalise
ambiguous timing or accept HDR/untagged colour.

## Proxy correspondence

1280×720 H.264, yuv420p, BT.709, no audio, 15-frame closed GOP, no B-frames.
Verification compares 160×90 area-downsampled full-range RGB at indexed frames.

| Recording                      | Beginning MAE / 255 | Middle MAE / 255 | End MAE / 255 |
| ------------------------------ | ------------------: | ---------------: | ------------: |
| DJI_0468, frames 0 / 284 / 568 |               0.942 |            1.202 |         1.444 |
| DJI_0469, frames 0 / 156 / 312 |               0.959 |            0.700 |         0.739 |

Preparation rejects sample MAE above **6/255**, or any frame-count/rate mismatch.
This sampled pixel check is not a per-frame optical identity proof; it accompanies
the full packet-grid and count checks. Originals were not modified.

## Colour and native reference

The published contract is implemented by a CPU function, a WebGL2 shader, and a
65³ CPU-generated LUT with native tetrahedral interpolation. Each decoder is graded
before encoded-RGB blending. Black fades are applied after grading.

### CPU versus shader

Tested neutral, each of seven controls separately, and a combined grade on 289
deterministic RGB inputs per setting:

- Neutral: numeric identity (within floating-point roundoff).
- Largest observed shader/reference error: **0.655/255**.
- Largest observed mean absolute error: **0.256/255**.
- Automated thresholds: MAE **<0.35/255**, maximum **<0.7/255**.

### CPU versus FFmpeg LUT

The opt-in synthetic test checks every control and a combined grade on uncompressed
RGB inputs, isolating the LUT from browser conversion and H.264:

- All tested settings pass MAE **<0.65/255**, maximum **<6/255**.
- Synthetic cut/black/dissolve renders pass exact frame counts and SDR metadata.
- Opening/closing endpoints and both central black-transition frames are black
  (mean **<1/255**), even after a grade that lifts black.
- Fade-curve frames and cross-dissolve midpoint pass shared-model/native MAE
  **<4/255**. The comparison includes resampling and 4:2:0 codec error.

These bounds apply to the tested patterns/settings, not every possible extreme
combination of slider limits. LUT interpolation near clipping boundaries, finite
precision and codec/chroma quantisation remain documented approximations.

### Real preview versus original-based render

A 330-frame two-clip dissolve reference was rendered from originals with independent
grades, not from proxies, and verified as 1280×720 H.264 SDR BT.709, with no audio.
The preview was captured via GPU readback, vertically corrected, and area-downsampled
to 160×90 RGB for comparison with the decoded native render:

| Timeline frame | Region                         | Preview/native MAE / 255 |
| -------------: | ------------------------------ | -----------------------: |
|              0 | Opening black endpoint         |                    0.000 |
|             60 | Clip A, combined grade         |                    2.783 |
|            165 | Dissolve midpoint, both grades |                    3.152 |
|            210 | Clip B                         |                    2.533 |
|            329 | Closing black endpoint         |                    0.000 |

This establishes preliminary code-value agreement on these samples. It is not
bitwise equivalence, monitor calibration, or certification of every browser's video
colour conversion. Repeat the reference comparison on the intended GPU/browser.

## Responsiveness and playback

Correctness-only automated run (SwiftShader; repeated playback explicitly skipped):

| Measurement                                        |                    Observed | Qualification                                                       |
| -------------------------------------------------- | --------------------------: | ------------------------------------------------------------------- |
| Warm seek, 16 samples before/inside/after dissolve | Median 37.7 ms; max 71.2 ms | Available frames only; exact observed source-frame identity         |
| Colour engine-update to next paint                 |                 6.2–11.4 ms | Excludes full input-event/React delay; not a hardware target result |

Embedded-browser playback observations showed roughly 28–30 fps steady regions,
with explicit buffering at decoder/boundary mismatches, dropped/late callbacks and
occasional clock error above one frame. These results are **not accepted/rejected
target-GPU measurements**, per the user's clarification. No relaxed acceptance
threshold has been adopted.

Target-GPU checks still required:

- Approximately 29.97 fps at 720p, including dissolves and boundary stalls.
- End-to-end slider-to-visible response under 100 ms.
- Median warm seek under 250 ms in the intended browser.
- Repeated-playback decoder synchronization and long-run memory behaviour.
- Long-run audio/video drift on the target browser. Music and an audio clock now
  exist and short looping/ramped browser tests pass, but this does not certify the
  one-frame A/V target over a complete flight.

Diagnostics expose rendered/observed/dropped/late frames, seek time, buffering,
clock error, renderer and Chromium heap size. Heap figures exclude total browser
process, decoder and driver memory; the texture estimate is not a memory leak proof.

## Reproduction and scope

See the commands in [../README.md](../README.md). Measurements and their immutable
reference receipt are stored locally in the ignored cache, not in source folders.
The default full measurement runs two passes for each transition type; the current
checked run used `--skip-playback --reference` to honour deferred GPU validation.

Tests additionally cover a 12-recording media browser, arbitrary excerpt insertion,
dragged/ripple/non-destructive trim restoration, one-step gesture undo, Escape
cancellation without saving drafts, reorder, split/delete and decoder reuse while
seeking across five excerpts. These extensions do not close the target-GPU
performance gate. Bounded native export tests additionally cover every curve in
both directions, independent grades, music placement/selected-range looping/
envelopes, cancellation cleanup, exact packet/frame counts and genuine short UHD
output. These are historical results; current acceptance evidence belongs on
[GitHub work issues](https://github.com/Plonk42/PasCap/issues).
