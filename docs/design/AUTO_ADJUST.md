# Track → Colour → Auto (Auto adjust)

Current contract for Phase 1 of [#167](https://github.com/Plonk42/PasCap/issues/167):
an **Auto** action that analyses the clip at the playhead and writes a balanced
correction into ten of the track's existing scalar Colour settings. It only chooses
values: no schema, grade stage, render, export or decoder changes, and it makes no
CapCut parity claim. Phase 2 (a per-clip `autoAdjust` field with a live intensity) is
not implemented; it waits for the owner's evaluation of Phase 1 on real flights. This
guide describes the implementation, not real-footage qualification; the constants are
starting values tuned on synthetic fixtures, then on real drone flights, kept in one module
for that evaluation.

Implementation authorities: [estimator](../../src/shared/auto-adjust.ts) (pure, every
constant in `AUTO_ADJUST`), [white balance](../../src/shared/white-balance.ts),
[frame sampler](../../src/preview/frame-sampler.ts), [editor helpers](../../src/web/auto-adjust.ts)
and [popover](../../src/web/AutoAdjust.tsx).

## Editing

**Auto** (accessible name **Auto adjust**, wand icon) ends the Colour keyframe line, after
**Reset** and the default keyframe toggle. When that line is narrower than 280 px, as with
the Properties panel at its 270 px minimum, Auto takes its own row at the right so the
keyframe count stays readable. It is unavailable, with the reason in its tooltip and
description, when Colour cannot be edited, no clip of the selected track is at the
playhead, or that clip's recording has no verified proxy. In a dissolve it analyses the
selected clip when it is one of the two, otherwise the one past the dissolve's midpoint,
like [Auto white balance](TEMPERATURE_AND_TINT.md#automatic-white-balance).

Choosing Auto opens a nonmodal popover naming the analysed recording. While it analyses
the clip's **whole source range** it shows **Analysing n/16 frames…** and **Cancel**. Then:

- **Intensity**, a slider with an exact field (0–100%, initially 80%, Reset restores
  80%). 80% applies the correction as fitted; higher values exaggerate it, up to a quarter
  more at 100%. The correction at the chosen intensity is previewed in the image while the
  popover is open, the dragged value while dragging, through the live preview path:
  no document, history or save change.
- A line per setting the track animates, such as **Exposure is animated: not changed**.
- **Apply** commits one `colour` edit, one Undo step: the scaled correction replaces the
  track's Temperature, Tint, Saturation, Exposure, Brightness, Contrast, Highlights,
  Shadows, Whites and Blacks, except animated ones. Hue, Vibrance, HDR, Local contrast,
  HSL, curves, Opacity, Transform, keyframes and clips are untouched; no keyframe is
  created. Apply is unavailable when all ten settings are animated.
- **Cancel**, Escape anywhere in the popover (a slider drag first cancels itself) or a
  click outside closes it and restores the preview, without an edit.

Errors (an unreadable proxy, frames too dark or too uniform) stay in the popover with
**Close**. Changing track, project or the clip at the playhead, or trimming that clip,
closes the popover and cancels a running analysis; moving the playhead within the clip
does not.

The editor keeps each clip's last analysis in session memory, never saved or in history.
Reopening Auto on the same clip skips decoding and starts at the intensity last applied,
so the user can lower it later; **Apply** then replaces the ten settings again, including
manual edits to them. The memory is dropped when the clip's source range or its proxy
changes, on another project and on reload. One correction serves the whole track, taken
from one clip: tracks holding shots that need different corrections need one track each.

Intensity $p$ scales the fitted correction from neutral by $a=p/80\%$ (`balancedIntensity`):
Temperature, Tint, Exposure, Brightness, Highlights, Shadows, Whites and Blacks by $a$,
Contrast and Saturation as $A^a$, each kept within its setting's range and rounded to
thousandths. So 40% is half the correction and 100% is 1.25 times it. Temperature, Tint and
Exposure are log-gains, so half the correction is the geometric midpoint of the light change.

## Analysis

**Frames.** The centres of up to **16** equal slices of the clip's `[sourceIn, sourceOut)`,
decoded from the verified proxy (never an original) on a temporary one-decoder reader,
separate from the timeline and source review lanes. Each is drawn into a canvas of at
most 320 × 180 pixels, exactly the decoded frame the compositor uploads, read back and
closed at once; the reader is released when done, failed or cancelled. The editor then
estimates each frame's light, yielding between frames so Cancel stays responsive, and fits
the correction in a fraction of a second. Letterbox rows and columns are
dropped as in white balance; in the statistics below, pixels are weighted towards the
centre with $\omega=0.5+0.5\,e^{-r^2/(2\cdot0.35^2)}$ ($r=1$ at the corners), and pixels
whose linear luma is below 0.002 are left out as noise.

**White balance.** Temperature and Tint are exactly what
[Auto white balance](TEMPERATURE_AND_TINT.md#automatic-white-balance) estimates from these
frames: Shades of Grey and Grey-Edge per frame, median pooling, confidence and damping
(cool casts more than warm ones, soft limits 0.5 and 0.3). They are applied to every
analysed pixel before the tone and Saturation fits.

**Statistics, per frame, then the median over frames.** Linear luma percentiles 0.5 and
99.5 (the black and white points) and 1 and 99; the log-average
$\bar Y=\exp(\overline{\ln(Y+10^{-4})})$; a colour typical of the 99th percentile of
each pixel's brightest channel (saturated colours clip first); and the **shadow areas**: the
10th percentile of the mean luma of square areas 1/22.5 of the frame high, about the reach
of the base [Shadows](DETAIL_FILTERS.md#local-shadows-and-highlights) uses. Taking each
statistic's median over the frames, rather than pooling all pixels, keeps one frame facing
the sun from deciding.

**Key.** Reinhard's automatic key,
$\text{key}=0.18\cdot4^{(2\log_2\bar Y-\ell_1-\ell_{99})/(\ell_{99}-\ell_1)}$ within
0.09–0.72, so high-key scenes such as snow keep a bright target and low-key scenes a dark
one. When the 99th percentile is clipped (0.95 linear or more), the key is at most 0.18:
clipping squeezes the top of the range, so overexposed footage is not taken for a high-key
scene. The target is the display value of the log-average, $\text{key}/(1+\text{key})$.

**Tone, fitted through the real grade.** Exposure, Blacks, Whites, Contrast, Brightness
and Highlights are fitted by evaluating PasCap's own grade on flat anchors: grey at the
black point, the log-average and the white point, plus the saturated colour. Shadows and
Highlights are [local](DETAIL_FILTERS.md#local-shadows-and-highlights): on a flat area the
base is the area itself, so each anchor gets its local tone gain, then `compilePixelGrade`.
The objective is the sum of:

- the key term, $4\,m^2$ where $m$ is how far the log-average's output is from the target,
  in stops, beyond a **half-stop dead zone**: well-exposed footage is left alone;
- the black and white bands, the distance of their outputs outside encoded 0.01–0.08 and
  0.92–0.98, in units of 0.02, squared. The black point may rise to 0.08 because Shadows
  lifts it with the shadow areas;
- $4\,s^2$, where $s$ is how many stops the saturated anchor is pushed past clipping;
- $0.02\,R$, the pull towards no correction, with
  $R=(e/1)^2+(k/0.6)^2+(w/0.6)^2+(\log_2(c/c_0)/0.8)^2+(b/0.1)^2+(h/0.4)^2+(s/0.4)^2$.

Flat footage lost midtone contrast as well as its black and white points, so Contrast is
pulled towards $c_0=\min(1.4,\ 1+0.2\,\max(0,\ 6.5-D-1))$ rather than 1, where $D$ is
the scene's black-to-white range in stops and 6.5 about the range between the bands'
middles. Measured in stops, $D$ does not change with exposure, so an underexposed shot is
not taken for a flat one.

**Shadows.** Once the other settings are fitted, Shadows is the smallest value, up to 0.5,
that brings the shadow areas' output to at most **1.5 stops below the log-average's
output**, both evaluated through the fitted tone (by bisection). Only Shadows opens them: it
changes only the areas below mid-grey and keeps their local contrast, where flattening
Contrast or raising Exposure would cost the rest of the picture. Measured on the output,
opened shadow areas are not opened again. 1.5 stops was set on real drone flights, where
it gives about the Shadows chosen there by hand.

The solve is projected coordinate descent with golden-section line searches: 16 sweeps,
each fitting Exposure, Blacks, Whites, Contrast, Brightness and Highlights in that order,
then Shadows, so the next sweep's Blacks keeps the black point Shadows lifts in its band.
The bounds are Exposure ±1.5, Blacks −1…0 (blacks are never lifted on purpose), Whites
−0.5…1, Contrast 0.75–1.8, Brightness ±0.15, Highlights −0.6…0.2 and Shadows 0–0.5. It is
deterministic: identical frames give bit-identical results.

**Low light.** When the white point is below 0.05 linear (night or very dark footage),
Exposure, Whites, Brightness, Shadows and Contrast − 1 are halved: lifting would mostly
amplify noise. Blacks is kept, since crushing the black point hides noise.

**Saturation.** The Hasler–Süsstrunk colourfulness
$M=\sqrt{\sigma_{rg}^2+\sigma_{yb}^2}+0.3\sqrt{\mu_{rg}^2+\mu_{yb}^2}$ of about 20,000
pixels shared among the frames, after white balance and tone, on encoded 0–255 values,
median over frames. Saturation is $(65/M)^{0.75}$ within 0.9–1.5, or 1 when $M<5$
(monochrome). 65 is the paper's fairly colourful range; the exponent and cap keep
colourful footage nearly untouched and stop well short of a saturation pump.

### Differences from the issue's proposal

The issue's starting estimator was tuned on synthetic fixtures, and could not meet its own
acceptance unchanged: its key term dominated the bands and moved well-exposed footage,
the stretch flat footage needs came only from Blacks and Whites (a midtone slope of about
1.25× the input's, below the required 1.3×), and one bright frame could move a pooled
histogram's white point. So:

- statistics are per frame with the median over frames, not one pooled histogram;
- the key term uses the display value $\text{key}/(1+\text{key})$, in stops, with a
  half-stop dead zone;
- the bands are measured in units of 0.02;
- Contrast is pulled towards the flat-footage $c_0$ above;
- Shadows and Highlights are evaluated as the local settings they now are;
- clipping is measured in stops past clipping, found by bisection;
- the solve runs 16 sweeps instead of 8;
- the low-light guard also halves Brightness and Shadows;
- colourfulness is the median of per-frame values.

That estimator still left real drone flights dull, with shadows darker than the original,
on 41 recordings (snowy mountains and a lake, the camera's normal colour profile, read from
their proxies). Their black points sit near 0.06–0.1 encoded: a black band ending at 0.04
made Blacks crush them and Exposure drop, and nothing measured the shadow areas, so Shadows
stayed near 0. Hence the black band up to 0.08, the Shadows stage, a stronger pull towards
$c_0$ (0.2 instead of 0.12 per stop) and a key up to 0.72 instead of 0.36 unless the
highlights clip, so that bright snow is not darkened. Compared recording by recording with
the look chosen by hand there (that estimator, then Shadows 0.4), the shadow areas' output
differs by 0.011 encoded on average, at most 0.03.

The issue also had Intensity start at 100%, the correction as fitted. Intensity now starts at
80% for that correction, so the range above it can exaggerate the look.

## Limits

- One correction per track, from one clip; no per-clip or temporal adaptation.
- Intensity above 80% exaggerates only what Auto corrects: footage it leaves nearly
  unchanged stays nearly unchanged at 100%.
- Overexposed footage is darkened conservatively: its clipped highlights cap the key, but
  the dead zone and the pull towards no correction leave about −0.2 stop for a stop of
  overexposure on the synthetic fixtures. Footage whose white point nearly clips is darkened
  slightly (up to about −0.2 stop) to bring it into the white band.
- Shadows stops at 0.5: very dark shadow areas stay darker than 1.5 stops below the
  log-average, and analysing the corrected picture again opens them further.
- Bright snow close-ups whose log-average sits above even the highest key are still
  slightly darkened, with Contrast down to about 0.75.
- White balance damping and the Saturation cap and exponent are partial on purpose:
  analysing a corrected image again can still suggest some warming or saturation, for
  example on very flat footage whose Saturation reached its 1.5 cap. Footage with little
  colour, such as snow, also reaches that cap, which can strengthen a faint tint.
- The scalar tone settings approximate, not reproduce, a camera's flat-to-Rec.709
  conversion; Auto never sets colour curves.
- The unit tests use synthetic fixtures only: neutral, flat, under- and overexposed, casts,
  hazy, snow, night, sunset, sky and sea, and an outlier frame. The constants were then set
  on the real flights above; neither qualifies other cameras, colour profiles or scenes.

## Validation

Unit tests cover the estimator's properties on synthetic images: neutral footage almost
unchanged except its darkest areas, which Shadows opens, and shadow areas already open left
alone; flat footage gets negative Blacks, output black and white points in their
bands, a midtone slope at least 1.3× the input's and Saturation above 1.2; exposure errors
beyond the dead zone corrected stop for stop; cast signs and damping; near idempotence
(analysing the output changes the image under 20% as much, and flat footage's global tone
settles in one pass while Saturation and Shadows stop at their bounds); determinism; one
outlier frame among 16; hazy, snow, night, sunset,
sky and sea; intensity scaling, exaggeration within bounds and frame selection. Editor
tests cover the target, the single Colour edit, animated settings and session memory. A
browser test checks, on a generated flat proxy, that Apply at the initial 80% writes
exactly the estimator's result for the pixels the page decodes, previews without editing,
Undo, intensity including 100%, reuse without decoding, animated settings, cancellation
and failures. The analysed pixels equal the compositor input, as checked for Auto white
balance.
