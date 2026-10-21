# Track → Colour → Auto (Auto adjust)

Current contract for Phase 1 of [#167](https://github.com/Plonk42/PasCap/issues/167):
an **Auto** action that analyses the clip at the playhead and writes a balanced
correction into eleven of the track's existing scalar Colour settings, either as the track's
values or as a keyframe at the playhead. It only chooses values: no schema, grade stage,
render, export or decoder changes, and it makes no CapCut parity claim. A clip-owned
correction (Phase 2) is not implemented; the issue holds its plan. This
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

Choosing Auto opens a nonmodal popover naming what it analyses, with two choices. **Source**
is what it analyses:

- **Playhead** (1 s around it): 16 frames within 30 project frames of the playhead, never
  across its clip's ends, mapped to source frames through `PlacedClip.retiming`;
- **Clip** (all of it): 16 frames spread over the **whole source range** of the clip at the
  playhead;
- **Track** (all its clips): 16 frames spread over every clip of the selected track, laid end
  to end in timeline order, so each clip counts in proportion to its duration on screen. It is
  unavailable, with the reason, until every clip of the track has a verified proxy.

**Apply as** is what it changes:

- **Track values** (whole track) replaces the track's values, from any source.
- **Keyframe** (at playhead) keys the eleven settings at the playhead. A keyframe takes the
  light at the playhead, so it needs the Playhead source: with Clip or Track it is unavailable
  (**needs Playhead**), and choosing either of them returns Apply as to Track values. It is also
  unavailable, with the reason, when the track holds 256 keyframes and none is at the playhead.

Auto opens on Clip and Track values while the track animates none of the eleven settings, on
Playhead and Keyframe once it animates any of them. Changing the source starts its own
analysis; changing Apply as reuses it. While it runs the popover shows **Analysing
n/16 frames…** and **Cancel**. Then:

- **Intensity**, a slider with an exact field (0–100%, initially 80%, Reset restores
  80%). 80% applies the correction as fitted; higher values exaggerate it, up to a quarter
  more at 100%. The correction at the chosen intensity is previewed in the image while the
  popover is open, the dragged value while dragging, through the live preview path:
  no document, history or save change.
- For Track values, a line per setting the track animates, such as **Exposure is animated:
  not changed**.
- **Apply** commits one Undo step and closes the popover. Hue, HDR, Local contrast, HSL,
  curves, Opacity, Transform and clips are untouched.
  - Track values: one `colour` edit, the scaled correction replacing the track's
    Temperature, Tint, Saturation, Vibrance, Exposure, Brightness, Contrast, Highlights,
    Shadows, Whites and Blacks, except animated ones; no keyframe changes. Apply is
    unavailable when all eleven settings are animated.
  - Keyframe: the eleven settings are captured at the playhead exactly like their
    diamonds, in one transaction: a new keyframe gets Linear Easing; an existing one is
    joined (each joining setting adopts the Easing the keyframe's settings agree on, else
    Linear) and its values of the eleven are overwritten. Track values and other keyframes
    are untouched.
- **Cancel**, Escape anywhere in the popover (a slider drag first cancels itself) or a
  click outside closes it and restores the preview, without an edit.

Errors (an unreadable proxy, frames too dark or too uniform) stay in the popover with
**Close**. Changing track, project or the clip at the playhead, or trimming that clip,
closes the popover and cancels a running analysis. Moving the playhead within the clip
does not; from the Playhead it starts the analysis around the new playhead.

Running Auto at several frames of a clip whose light changes keys a correction at each,
and ordinary keyframe interpolation follows the light between them. The keyframes stay at
their project frames, like every track keyframe: trimming, moving or rippling the clip
does not move them. With Linear Easing a correction also eases across a cut into the next
clip on the track; set **Hold** on the last keyframe of a shot, or key the next shot's first
frame, to keep shots apart.

The editor keeps each analysis in session memory, never saved or in history: one per
clip, one per clip and playhead and one per track's clips as analysed. Reopening Auto on the
same frames skips decoding and starts at the intensity last applied, so the user can
lower it later; **Apply** then replaces the eleven settings again, including manual edits to
them. The memory is dropped when a clip's source range or its proxy changes, on another
project and on reload. Track values serve the whole track: tracks holding shots that need
different corrections need one track each, or keyframes. The Track source finds one
compromise for all its clips, which may suit none of very different shots.

Intensity $p$ scales the fitted correction from neutral by $a=p/80\%$ (`balancedIntensity`):
Temperature, Tint, Vibrance, Exposure, Brightness, Highlights, Shadows, Whites and Blacks by $a$,
Contrast and Saturation as $A^a$, each kept within its setting's range and rounded to
thousandths. So 40% is half the correction and 100% is 1.25 times it. Temperature, Tint and
Exposure are log-gains, so half the correction is the geometric midpoint of the light change.

## Analysis

**Frames.** For the Clip source, the centres of up to **16** equal slices of the clip's
`[sourceIn, sourceOut)`; for the Track source, of the track's clips laid end to end in output
frames, each mapped to its source frame. For the Playhead, the playhead and up to 15 more project frames within
**30** (1 s) of it inside its clip, shared between the two sides in proportion to their room
and evenly spaced, exactly as Auto white balance's window (one shared constant), each mapped to the source frame shown there
(repeated source frames of slow motion are read once). They are
decoded from the verified proxy (never an original) on a temporary one-decoder reader, one
recording at a time for the Track source,
separate from the timeline and source review lanes. Each is drawn into a canvas of at
most 320 × 180 pixels, exactly the decoded frame the compositor uploads, read back and
closed at once; the reader is released when done, failed or cancelled. The editor then
estimates each frame's light, yielding between frames so Cancel stays responsive, and fits
the correction in a fraction of a second. Letterbox rows and columns are
dropped as in white balance; in the statistics below, pixels are weighted towards the
centre with $\omega=0.5+0.5\,e^{-r^2/(2\cdot0.35^2)}$ ($r=1$ at the corners), and pixels
whose linear luma is below 0.002 are left out as noise.

The assistant's `estimate` operation runs this estimator on the same frames, decoded by the
service with FFmpeg's exact BT.709 conversion instead of the browser's canvas readback; its
settings agree with the editor's within 0.07
([server-side estimates](ASSISTANT_MCP.md#server-side-auto-adjust-white-balance-and-detail-measurement)).

**White balance.** Temperature and Tint are exactly what
[Auto white balance](TEMPERATURE_AND_TINT.md#automatic-white-balance) estimates from these
frames: Shades of Grey and Grey-Edge per frame, median pooling, confidence and damping
(cool casts more than warm ones, soft limits 0.5 and 0.3). They are applied to every
analysed pixel before the tone and colour fits. With the Playhead source and Intensity 80%
they equal what Auto white balance captures at the same playhead (a unit test compares them);
the Clip and Track sources deliberately analyse more of the footage, so they can differ from it.
When no frame has a usable illuminant (black, clipped or uniform frames), white balance is
neutral (0 and 0) and the tone fit continues, where Auto white balance reports an error.
Intensity scales Temperature and Tint like the other settings, within their Colour bounds, not
within the soft limits: 100% exaggerates them to 1.25 times the fit.

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

**Saturation and Vibrance.** The Hasler–Süsstrunk colourfulness
$M=\sqrt{\sigma_{rg}^2+\sigma_{yb}^2}+0.3\sqrt{\mu_{rg}^2+\mu_{yb}^2}$ of about 20,000
pixels shared among the frames, after white balance and tone, on encoded 0–255 values,
median over frames, sets the chroma gain the scene asks for: $g=(65/M)^{0.75}$ within
0.9–1.5, or none when $M<5$ (monochrome). 65 is the paper's fairly colourful range; the
exponent and cap keep colourful footage nearly untouched and stop well short of a
saturation pump.

- A gain below 1, on very colourful footage, is Saturation $g$, lowering every colour alike.
- A gain above 1 is shared. Saturation takes half of it in log terms, $s=g^{0.5}$, raising
  every colour alike, as many like a slightly saturated look. Vibrance scales a pixel's chroma
  by $1+v(1-c)$, $c$ its linear $(\max-\min)/\max$ saturation, so strong colours gain little;
  with $c_{25}$ the 25th percentile of the pixels' saturation (median over frames),
  $v=(g/s-1)/(1-c_{25})$ up to 1 brings the scene's muted colours to the whole gain $g$.
- The strong colours, the 90th percentile $c_{90}$, may then rise to 0.7, or by 0.05 when
  already at or above it. When they would rise further, Saturation's share gives way first,
  found by bisection, each lower share leaving more of the gain to Vibrance; if Vibrance
  alone still pushes them too far, it is lowered too. Saturation and Vibrance keep the
  pixels' order of saturation, so each frame's 90th-percentile pixel stays the same one and
  only those pixels are graded again.

$M$ rewards variety of colour, so a uniform saturated sky measures dull; Saturation alone
then pushed it as far as the scene's muted colours (#225). The 90th percentile makes
the limit apply where strong colours fill a tenth of the frame or more, such as a sky,
not to a small red jacket. Intensity above 80% raises both settings for a bolder look.

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

Auto first raised colour with Saturation alone, which over-saturated skies in owner testing
([#225](https://github.com/Plonk42/PasCap/issues/225)). On synthetic fixtures, the mean
linear saturation of the region named, before and after Auto at 80%:

| Fixture                    | Before | Saturation alone       | Saturation and Vibrance, limited |
| -------------------------- | ------ | ---------------------- | -------------------------------- |
| Sky filling the frame      | 0.66   | 0.80 (Saturation 1.5)  | 0.73 (1 and 0.67)                |
| Snow under a sky, the sky  | 0.71   | 0.80 (Saturation 1.39) | 0.74 (1.05 and 0.33)             |
| Flat footage, whole frame  | 0.30   | 0.41 (Saturation 1.5)  | 0.39 (1.22 and 0.26)             |
| Hazy footage, whole frame  | 0.45   | 0.51 (Saturation 1.18) | 0.50 (1.09 and 0.11)             |
| Muted colours, whole frame | 0.15   | 0.22 (Saturation 1.5)  | 0.22 (1.22 and 0.24)             |

The sky filling the frame rises by 0.07 on average: its strongest tenth rises by at most
0.05, its paler lower part up to 0.7. Footage without strong colours gains about as much
colour as with Saturation alone. No owner recording was analysed for this change.

## Limits

- Track values are one correction per track, from one moment, one clip or a compromise over
  the track's clips. Keyframes adapt to light that
  changes within a clip only where Auto is run, and stay at their project frames when the
  clip is trimmed or moved; there is no per-clip correction or automatic per-frame adaptation.
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
- White balance damping and the colour gain's cap and exponent are partial on purpose:
  analysing a corrected image again can still suggest some warming or colour, for example
  on very flat footage whose gain reached its 1.5 cap. Footage with little colour, such as
  snow, gets that whole gain on its muted colours, which can strengthen a faint tint.
- The strong-colour limit does not know what a sky is: any strong colours filling a tenth
  of the frame take Saturation's share away from the whole picture, and a sky paler than
  0.7 saturation may rise to it.
- The scalar tone settings approximate, not reproduce, a camera's flat-to-Rec.709
  conversion; Auto never sets colour curves.
- The unit tests use synthetic fixtures only: neutral, flat, under- and overexposed, casts,
  hazy, snow, night, sunset, sky and sea, skies over snow or filling the frame, muted and
  monochrome colour, and an outlier frame. The constants were then set
  on the real flights above; neither qualifies other cameras, colour profiles or scenes.

## Validation

Unit tests cover the estimator's properties on synthetic images: neutral footage almost
unchanged except its darkest areas, which Shadows opens, and shadow areas already open left
alone; flat footage gets negative Blacks, output black and white points in their
bands, a midtone slope at least 1.3× the input's and more than 1.2× its saturation from
Saturation and Vibrance; exposure errors
beyond the dead zone corrected stop for stop; cast signs and damping; near idempotence
(analysing the output changes the image under 20% as much, and flat footage's global tone
settles in one pass while Shadows stops at its bound); determinism; one
outlier frame among 16; hazy, snow, night, sunset,
sky and sea; a sky filling the frame whose strongest tenth rises by at most 0.05 and a sky
over snow kept within 0.05 of its saturation, Saturation giving way first; muted colours
raised by both settings, very
colourful ones lowered by Saturation, monochrome ones untouched; intensity scaling, exaggeration within bounds and frame selection. Editor
tests cover the target and the keyframe window (reversed and retimed), the single Colour
edit, the keyframe capture (new, joined, 256-keyframe limit), the initial choice, animated
settings and session memory. A
browser test checks, on a generated flat proxy, that Apply at the initial 80% writes
exactly the estimator's result for the pixels the page decodes, as track values and as
keyframes at two frames, previews without editing,
Undo, intensity including 100%, reuse without decoding, animated settings, cancellation
and failures. The analysed pixels equal the compositor input, as checked for Auto white
balance.
