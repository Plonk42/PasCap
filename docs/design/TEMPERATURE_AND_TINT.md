# Video track Temperature and Tint · strict project schema 14

Approved contract for [#68](https://github.com/Plonk42/PasCap/issues/68).
These are normalized **SDR colour controls**, not Kelvin, HDR, illuminant
estimation, automatic white balance or highlight recovery. This guide specifies
behaviour and required validation, not completed tests or hardware qualification.

## Ownership, data and controls

Every video track requires finite `colour.temperature` and `colour.tint` in **−1…1**;
new tracks start at **0**, neutral. Positive Temperature warms (red relative to
blue), negative cools; positive Tint adds magenta (red/blue relative to green),
negative adds green. Nonzero settings intentionally colour greys.

All static and animated Colour is video track-owned. Existing, new and moved clips use
their track's complete grade, including both dissolve sources. Empty tracks remain
editable; different treatments require different tracks. No clip Colour/correction
base, ownership toggle or copy to clips is introduced.

Shared video track keyframes require exactly **ten nullable channels**, in control order:
`opacity`, `temperature`, `tint`, `exposure`, `brightness`, `contrast`,
`hue`, `saturation`, `highlights`, `shadows`. Temperature and Tint are keyed
independently at absolute project frames, interpolate parameter values using the
left keyframe's shared easing for that setting and hold endpoints. Keyframes without that enabled setting are
skipped. No keyframes for a setting means the saved track base; removing its final keyframe reveals
that unchanged base. HSL bands and master/RGB curves remain **static**, not new
animation channels. Speed is clip-only, never a track channel.

**Track → Colour** places Temperature and Tint before Exposure. Main and stored
keyed settings use native sliders (step 0.01), adjacent exact numeric fields,
and reset to 0 by double-clicking the name. Main capture diamonds are always visible, with adjacent per-setting **Previous/Next** buttons because not every setting is enabled at every shared keyframe. Its single keyframe-line Previous/Next pair (with the keyframe count) visits the union of Opacity and all nine scalar colour keys.
Enabled setting chips in stored Keyframes rows retain
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
Exposure → Contrast → Brightness → Shadows/Highlights → Hue/Saturation → final
linear clipping and BT.709 encoding → static encoded HSL → master curve → RGB
curves → black-fade brightness → Opacity/spatial coverage and grouped source-over.
See [the grading equations](../COLOUR_AND_TIMING.md) for the remaining stages.

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
require exact complete grading through composited export. Compare/Ungraded bypasses
Temperature/Tint and every other colour stage, never Opacity, geometry or fades.
These appearance-only controls add no decoder, full-frame buffer, LUT array or
native process; existing frame/pixel/resource and A/V gates remain unchanged.

## Strict preservation and validation

Only **schema 14** projects and schema-14 snapshots in version-1 export receipts
are accepted. Missing Temperature/Tint bases or either nullable keyframe field,
unknown fields and saved clip Colour/correction are invalid. Reject **v1–v13**
documents and receipt snapshots clearly; preserve their bytes and successful
outputs. Recreate projects deliberately: no migrations, v13 acceptance,
compatibility readers, injected defaults, fallback or automatic deletion.
Receipt/report/registry/proxy/PCM format versions remain independent and unchanged;
new reference/measurement metadata identifies schema 14, historical evidence does
not change.

Required disposable checks cover strict bounds/rejection/preservation, neutral
identity, both axis signs and combined gains, pre-clipping neutral-white
luminance, intentionally coloured greys, stage order and unchanged CPU/reference/
native/GPU error gates. Editing checks cover empty tracks, independent capture,
read-only gaps, final-keyframe removal, resets, invalid/cancelled drafts, Undo/Redo and
live desktop/compact screenshots. No real-media jobs or new performance claims.
