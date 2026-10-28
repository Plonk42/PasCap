# Video track Temperature and Tint

Approved contract for [#68](https://github.com/Plonk42/PasCap/issues/68), with
[automatic white balance](#automatic-white-balance) from [#218](https://github.com/Plonk42/PasCap/issues/218).
These are normalized **SDR colour controls**, not Kelvin, HDR output or highlight
recovery. [Auto adjust](AUTO_ADJUST.md) sets them, as bases or keyframes, with the same estimate. This
guide specifies behaviour and required validation, not completed tests or hardware
qualification.

## Ownership, data and controls

Every video track requires finite `colour.temperature` in **−2…2** and `colour.tint` in **−1…1**;
new tracks start at **0**, neutral. Positive Temperature warms (red relative to
blue), negative cools; positive Tint adds magenta (red/blue relative to green),
negative adds green. Nonzero settings intentionally colour greys.

All static and animated Colour is video track-owned. Existing, new and moved clips use
their track's complete grade, including both dissolve sources. Empty tracks remain
editable; different treatments require different tracks. No clip Colour/correction
base, ownership toggle or copy to clips is introduced.

Shared video track keyframes require exactly **fifteen nullable channels**, in control order:
`opacity`, `temperature`, `tint`, `exposure`, `brightness`, `contrast`,
`hue`, `saturation`, `vibrance`, `highlights`, `shadows`, `whites`, `blacks`, `hdr`, `localContrast`. Temperature and Tint are keyed
independently at absolute project frames, interpolate parameter values using their own
Easing at the left keyframe and hold endpoints. Keyframes without that enabled setting are
skipped. No keyframes for a setting means the saved track base; removing its final keyframe reveals
that unchanged base. HSL bands and master/RGB curves remain **static**, not new
animation channels. Speed is clip-only, never a track channel.

**Colour → Track** shows Temperature and Tint first in its Colour group (the grade still
applies them before Exposure). Main and stored
keyed settings use native sliders (step 0.01) with coloured tracks (Temperature
blue → yellow, Tint green → magenta), adjacent exact numeric fields,
and reset to 0 by double-clicking the name. Main capture diamonds are always visible, with adjacent per-setting **Previous/Next** buttons because not every setting is enabled at every shared keyframe. Its single keyframe-line Previous/Next pair (with the keyframe count) visits the union of Opacity, all twelve scalar colour, HDR and Local contrast keys.
Enabled setting chips in stored Colour keyframe rows retain
their per-channel arrows. All main and stored per-channel arrows visit strictly
earlier/later keyframes where that channel is nonnull (zero is enabled), sharing
the central off-duration inspection cursor.
There is no Animate toggle or stored preference.
Main capture uses the real project playhead, never
an inspected stored time. Visible easing selectors read **Easing**, with contextual
accessible names and interpolation unchanged. No schema or data changes result.
Sliders never create keyframes; animated main values without an enabled setting at the real
playhead are read-only until diamond capture.
Pointer movement previews the draft in the image without a document change; valid release is one Undo step. Escape/cancellation/capture loss/blur restores control and preview.
Numeric Enter/blur preserves entered precision; invalid drafts stay editable,
never clamp or default. Resets affect only the targeted base or existing keyframe;
Colour Reset on an animated track preserves track bases and static HSL/curves.

## One grading formula

Let $T$ be Temperature and $I$ Tint. Define positive linear-RGB raw gains:

$$
q = \left(2^{T/2+I/4},\;2^{-I/4},\;2^{-T/2+I/4}\right),\qquad
N=0.2126q_R+0.7152q_G+0.0722q_B,\qquad g=q/N.
$$

After inverse BT.709 decoding, apply $L'=L\odot g$ component-wise, **before**
Exposure's $2^{\mathrm{exposure}}$ multiplier. Do not clip the gains or intermediate
linear RGB. The complete order is inverse BT.709 → Temperature/Tint gains →
Exposure → Contrast → Brightness → Whites/Blacks → Hue/Saturation/Vibrance → final
linear clipping and BT.709 encoding → static encoded HSL → master curve → RGB
curves → black-fade brightness → Opacity/spatial coverage and grouped source-over.
See [the grading equations](../COLOUR_AND_TIMING.md) for the remaining stages. Shadows,
Highlights, HDR and Local contrast are local stages on source pixels before this grade; see
[detail filters](DETAIL_FILTERS.md#local-shadows-and-highlights).

At $T=I=0$, all gains equal 1. Normalization preserves **neutral-white linear
BT.709 luminance before clipping only**: $0.2126g_R+0.7152g_G+0.0722g_B=1$.
It is not luminance preservation for arbitrary coloured pixels or the final
clipped/encoded image, and does not keep greys neutral. HSL's grey protection
applies to its incoming RGB, which Temperature/Tint may already have coloured.

CPU reference, compiled CPU grade, native LUT generation/exact grading,
diagnostic reference and GPU shaders must use **this same math and stage order**,
not separate gain approximations. Existing native LUT interpolation, RGBA16 and
H.264/YUV quantisation remain measured approximations, not different transforms.
Neutral HSL/identity curves retain scalar LUT paths; nonneutral advanced settings
require exact complete grading through composited export. The Original preview bypasses
Temperature/Tint and every other colour stage, never Opacity, geometry or fades.
These appearance-only controls add no decoder, full-frame buffer, LUT array or
native process; existing frame/pixel/resource and A/V gates remain unchanged.

## Automatic white balance

**Auto white balance**, a button under Tint in **Colour → Track**, estimates the light at
the playhead and keyframes Temperature and Tint there. It only chooses values: no
schema, grade stage, render, export or decoder changes. Its constants live in one
module, [white-balance.ts](../../src/shared/white-balance.ts), as starting values to tune on real flights.

**Frames.** The clip of the selected track shown at the real playhead (in a dissolve,
the selected clip when it is one of the two, else the one past its midpoint) supplies
**16 project frames**: the playhead and up to **30 frames (1 s) on each side**, never
across that clip's ends, the other fifteen shared between the two sides in proportion to
their room and evenly spaced (the same window as [Auto adjust](AUTO_ADJUST.md)'s Playhead source, so both estimate
the same Temperature and Tint there). Each maps to the source frame the clip shows there
through `PlacedClip.retiming` (speed and Reverse). A temporary one-decoder reader
decodes them from the verified proxy, never an original, separate from the timeline and
source review lanes; each frame is drawn into a canvas of at most 320 × 180 pixels
(the decoded frame as the compositor uploads it), read back and closed at once. The
reader is released when done, failed or cancelled.

**Per frame.** Letterbox rows/columns (no code above 16) are dropped. Pixels with a
channel at 250 or more, and their 3 × 3 neighbours, are clipped; linear luma below
0.002 is noise; both are ignored. Two estimates of the light $e$ in linear BT.709:

- Shades of Grey: $e_c=\big(\tfrac1n\sum c^6\big)^{1/6}$;
- 1st-order Grey-Edge: a 3 × 3 binomial blur, central-difference gradient magnitudes
  per channel, $e_c=\big(\tfrac1n\sum|\nabla c|^6\big)^{1/6}$, away from ignored pixels.
  Large uniform sky, sea or grass have almost no gradient, so they barely count.

The frame's light is their per-channel geometric mean, with confidence
$k=1-\min(1,\angle(e_{SoG},e_{GE})/8°)$. Fewer than 256 usable pixels or edge samples,
as on black, clipped or uniform frames, give no estimate. Gains proportional to $1/e$
are exactly Temperature/Tint gains (up to the luminance normalization):

$$T=\log_2(e_B/e_R),\qquad I=\log_2\!\big(e_G^2/(e_Re_B)\big).$$

**Pooling and damping.** The median of each frame's $T$, $I$ and $k$, so one frame facing
the sun or a passing subject does not decide; confidence halves when the robust spread
($1.4826\times$ median absolute deviation) of $T$ exceeds 0.25, a light change within
the window. With $\mathrm{soft}(x,m)=m\tanh(x/m)$, the captured values are
$T'=\mathrm{soft}(k\beta T,0.5)$, with $\beta=0.85$ for a cool cast ($T>0$) and $0.6$ for a
warm one, which viewers accept more readily (a sunset stays warm), and
$I'=\mathrm{soft}(0.8kI,0.3)$, rounded to thousandths. No frame with an estimate is an
explicit error.

**Capture.** The result is captured at the real playhead exactly like the two capture
diamonds: it creates the track keyframe there or joins the existing one, adopting the
Easing that keyframe's settings agree on (else Linear), and overwrites only these two
values when they are already enabled. Both are one transaction, one Undo step. Running
it at two frames makes Temperature and Tint follow the light between them by ordinary
keyframe interpolation; there is no automatic per-frame adaptation. It is unavailable,
with the reason, when no clip of the track is at the playhead, its recording has no
verified proxy, or the track holds 256 keyframes and none is at the playhead. Moving
the playhead, changing track, clip or project, Escape or **Cancel** stop it without an
edit. Analysis of the ungraded proxy makes the result absolute, not a change to the
current grade. [Auto adjust](AUTO_ADJUST.md) reuses this estimate over 1 s around the playhead, a whole clip or
all the track's clips for the track's Temperature and Tint bases, or over 1 s around the playhead for a keyframe of eleven settings.

## Strict preservation and validation

Projects are upgraded to the **current schema** on load from the oldest supported schema
onwards; current-schema snapshots in version-1 export receipts are accepted. Missing
Temperature/Tint bases or either nullable keyframe field, unknown fields and saved clip
Colour/correction are invalid. Reject documents and receipt snapshots **older than the
oldest supported schema** clearly; preserve their bytes and successful outputs, without
compatibility readers, injected defaults, fallback or automatic deletion.
Receipt/report/proxy/PCM format versions remain independent and unchanged (the
registries are version 2, with full-content checksums);
new reference/measurement metadata identifies the current schema, historical evidence does
not change.

Required disposable checks cover strict bounds/rejection/preservation, neutral
identity, both axis signs and combined gains, pre-clipping neutral-white
luminance, intentionally coloured greys, stage order and unchanged CPU/reference/
native/GPU error gates. Editing checks cover empty tracks, independent capture,
read-only gaps, final-keyframe removal, resets, invalid/cancelled drafts, Undo/Redo and
live desktop/compact screenshots. Automatic white balance checks cover the estimator on
synthetic images (neutral, casts, outlier frame, sky, sunset, letterbox and clipping), the
window, capture, Undo, cancellation and failure, and that the analysed pixels equal the
compositor input. No real-media jobs or new performance claims.
