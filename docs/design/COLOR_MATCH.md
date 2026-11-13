# Color → Match (shot matching and styles)

Current contract for [#315](https://github.com/Plonk42/PasCap/issues/315) and
[#314](https://github.com/Plonk42/PasCap/issues/314): **Match** grades clips so that a frame of
each looks like a **reference**, a timeline frame as its grade shows it, a recording frame as
shot, or a registered **style**, the look of the user's own finished edits. Like
[Auto](AUTO_ADJUST.md) it only chooses values of the eleven settings Auto sets in
[clip grades](CLIP_GRADES_AND_ADJUSTMENTS.md): no schema, render, export or decoder change.

Implementation authorities: [matching](../../src/shared/look-match.ts) (pure, every constant in
`LOOK_MATCH`), [editor helpers](../../src/web/color-match.ts), the
[section](../../src/web/ColorMatch.tsx), the [reference store](../../src/web/color-reference.ts),
[styles](../../src/shared/styles.ts) with their [registry](../../src/server/styles.ts) and
[dialog](../../src/web/StylesDialog.tsx), and the assistant's
[estimate](../../src/server/operations/estimate.ts).

## Editing

**Match** is the first section of the **Color** tab when one clip or several clips (and no
adjustment) are selected, above Color; adjustments have no Match. It is expanded by default
(preference `pascap-section-match`).

**The reference** is shown at the top of the section: the reference frame with its grade's
settings applied on the CPU (Shadows, Highlights, HDR, Local contrast and Detail left out, which
need the whole image), its recording's name and what it is (**Timeline frame, as graded**,
**Recording frame, as shot**, **Registered style**). It is set by:

- **Use playhead frame**: the clip the timeline shows on top at the playhead, at the source
  frame shown there;
- **Use as color reference** in a clip's context menu: that clip at the playhead when it is
  over the clip, else at its middle frame;
- **Use as reference** in Source preview's heading: the recording's frame shown, as shot
  (pressed while it is the reference);
- **Styles** (a menu beside Use playhead frame): each registered style, **Manage styles…**
  (the Styles dialog), a hint for recording frames and **Clear reference**.

The reference belongs to the project in this browser, never to the project file or history:
preference `pascap-color-reference-<project id>`, `{kind: 'clip', clipId, sourceFrame}`,
`{kind: 'recording', mediaId, sourceFrame}` or `{kind: 'style', styleId}`. A timeline reference
follows its clip's grade (it is measured as graded when matching) and its source frame, wherever
the clip moves; it is unavailable, with the reason in the section, once its clip is deleted, its
recording no longer prepared, or its style deleted.

**The clips matched** are the selected clips, each at one frame: the frame shown at the playhead
when the playhead is over the clip, else its middle frame (named under the reference, **This
clip at the playhead (00:12:05)**). A clip is never matched at the reference frame itself: with
one clip selected, Match explains it; among several, that clip is left out.

**Match** (**Match N clips** for several) decodes the reference frame and each clip's frame from
their verified proxies, one temporary reader at a time (the reference frame is kept for the
next matches), and fits each clip on its own (see below), showing **Analyzing n/N frames…** and
**Cancel**. Then the result is previewed through the live preview path (no document, history
or save change) with:

- a line naming how the clips were matched: **Same scene: matched to the reference picture**,
  **Different scene(s): … takes the reference's light and look**, or **Similar scene: partly …**,
  from the scene likeness below; a style says **Matched to the style's look, from Auto's
  balance**;
- **Intensity** (0–100%, initially 100%): each clip's eleven settings move that far from their
  values at the matched frame to the match, Contrast and Saturation geometrically;
- **Apply as** (one clip): **Grade values** replaces the grade's values of the eleven settings,
  leaving animated settings unchanged (listed as **Animated, not changed: …**); **Keyframe at
  playhead** keys the eleven at the matched source frame like their diamonds (unavailable off
  the clip, or with 64 keyframes and none there), initial once the grade animates any of them;
- **Apply** (**Apply to N clips**): one Undo step, one `color-patch` per clip or one
  `layer-key-set`; **Cancel** restores the preview.

The result scrolls into view, down to Apply, and the keyboard focus moves to Apply when it had
left with the Match button.

Selecting other clips, moving the playhead to other frames, a new reference or an edit of the
settings a match keeps (the grade's other settings) is a new match: it cancels the analysis or
preview. Each match's results stay in session memory, so returning to the same frames shows them
without decoding again.

## Matching a frame

The reference frame is measured as its grade shows it: the eleven settings and the grade's
other ones (Hue, HSL, curves), Shadows and Highlights on flat areas, each frame first averaged to
about 80 pixels wide. The measures are those of a [style's look](#registered-styles) (luma
levels at the 0.5, 5, 25, 50, 75, 95 and 99.5 percentiles and the log-average in encoded luma,
the 25th and 90th percentiles of linear saturation), plus the frame's mean color, log2 of red and
of blue over green on unclipped, lit pixels, before Saturation and Vibrance.

**Start.** Statistics of different scenes differ by what they show: matching a snowy ridge's
levels to a dark valley's would darken the snow by a stop. The match therefore starts from the
reference's eleven settings moved by the difference between the two frames' **Auto**
corrections in Exposure, Temperature and Tint. Auto brings any frame to the same balance,
taking a scene's key into account, so this start gives the clip the reference's light and look
whatever the frames show.

**Fit.** From that start, three passes fit, through PasCap's own grade with the clip's other
settings kept:

1. Temperature and Tint so that the output's mean color is the reference's (they shift log2
   red/green by $(T+I)/2$ and blue/green by $(I-T)/2$);
2. Exposure, Contrast, Blacks and Whites so that the output's luma levels and log-average are the
   reference's;
3. Saturation and Vibrance so that its muted and strong saturations are the reference's.

Tone and color are fitted through models of the grade (gray anchors at the frame's levels, and
32 pooled pixels graded again); each pass measures the graded frame and aims the models past their
difference from the real output, so a frame matched to itself keeps the reference's settings
exactly. Differences count through a Cauchy loss of width 1.5 units (units of 0.02 in luma and
saturation, 0.05 in Temperature and Tint): beyond that, larger differences count less and less.
A pull keeps each setting near its start (scales 0.5 stop of Exposure, 0.2 stop of Contrast and
Saturation, 0.3 for Blacks, Whites, Vibrance and Temperature, 0.2 for Tint), and no setting
moves farther from its start than its **reach**: ±0.5 stop of Exposure, ×/÷1.3 Contrast and
Saturation, ±0.5 Blacks and Whites, ±0.3 Vibrance and Temperature, ±0.15 Tint. Brightness,
Highlights and Shadows keep the start.

**Scene likeness.** The two frames' scenes are compared on a 16 × 9 grid of mean log luma over
their pictures (letterbox left out): the correlation of the grids, which exposure, contrast and
white balance barely change, is about 1 for frames of one shot a second apart and −0.3–0.3 for
different shots. The match follows the fit as far as the scenes are alike: from the start at a
similarity of 0.5 or less to the fit at 0.9 or more, linearly between (`likeness`), Contrast and
Saturation geometrically.

## Registered styles

A **style** is the look of the user's finished edits. Implementation: [styles](../../src/shared/styles.ts),
the [registry](../../src/server/styles.ts) and the [dialog](../../src/web/StylesDialog.tsx).

**Registering.** **Manage styles…** opens the **Styles** dialog: the registered styles, each
with its references (**2 videos, 1 still**) and **Delete** (then **Delete it**; the references
are untouched), and **New style**: a name and up to 8 references, videos (`.mp4`, `.mov`,
`.m4v`) or JPEG stills, chosen in the approved footage folders. **Register style** measures them:
the service reads 8 frames of each video, at the centers of equal slices, or the still, with
FFmpeg at the analysis size, in place (never copied or modified), and stores the look of all
those frames together, as they are, with the style in `styles.json` beside the video and music
registries. Only registering reads the references: moving or deleting them later leaves the
style as measured. The assistant lists styles with `list_styles` and matches to one with
`estimate` kind `match` and `style`; the Hand off dialog's **Look** names it in the session
brief.

**Matching a style.** A style is many frames of other scenes, so a clip is matched to it from
**Auto's own correction** of the clip's frame, within **Auto's bounds** (Exposure ±1.5,
Contrast 0.75–1.8, Blacks −1–0, Whites −0.5–1, Saturation 0.9–1.5, Vibrance 0–1, Temperature
±0.5, Tint ±0.3): the same fit, with the reach above, aims at the style's levels, log-average,
muted and strong saturations, and at the cast of its light (the light Auto white balance
estimates, undamped) instead of a mean color. On synthetic fixtures a style of brighter, softer,
less colorful footage takes a shot at least a quarter closer to its look than Auto's balance.

## Assistant

`estimate` kind `match` ([assistant operations](ASSISTANT_MCP.md#server-side-auto-adjust-white-balance-and-detail-measurement))
runs the same functions on FFmpeg-decoded proxy frames: one reference (`referenceClipId` and/or
`referenceFrame`, or `referenceMediaId` with `referenceSourceFrame`, or `style`), one frame per
target (`clipId` with `frame`, else the middle frame; each clip's middle frame with `clipIds` or
`layerId` and `applyAs: shots`), `intensity` towards the match (100 % by default), and the
`likeness` of each frame match.

## Evaluation

The previous match fitted all eleven settings to statistics with a negligible pull: on the
owner's "Sitre test" project (31 clips of one flight) it pushed most clips to their bounds
(Contrast 2, Blacks −1, Saturation 2…). Measured read-only on the proxies of the owner's "Sitre
test 2", as the mean absolute difference in 8-bit codes from the expected picture (flat-area
renders), with the previous match given the same single frames:

| Case                                                                                                 | Previous match | Match | Eleven neutral | Reference's settings copied |
| ---------------------------------------------------------------------------------------------------- | -------------- | ----- | -------------- | --------------------------- |
| 10 clips' frames under known camera changes, matched to the original frame, 0, 0.5 and 1.5 s earlier | 3.65           | 2.09  | 14.85          | 14.98                       |
| 30 clips matched to clip 1 (other scenes), against their own grades                                  | 26.25          | 6.01  | 9.76           | 4.98                        |
| 6 pairs of clips of alike scenes (similarity 0.6 or more), against their own grades                  | 10.02          | 2.85  | 8.61           | 1.32                        |

The known camera changes are Exposure ±0.6, Temperature ±0.35, Tint ±0.15, Contrast 0.75–1.2 and
Saturation 0.8–1.25; the expected picture is the original frame through the reference's grade.
"Sitre test 2" was graded as one look plus each clip's Auto Exposure, Temperature and Tint, so
against its grades copying the reference's settings is right by construction; the match stays
close to it without copying. Unit tests cover the same scene under such changes (within 0.03 of
the reference picture) and flat footage (within 0.035), a frame matched to itself (its settings
exactly), another scene (the start), the reach, determinism, scene likeness, Intensity and
styles.

## Limits

- One frame per clip: light that changes within a clip needs a match keyed at several frames.
- Scene likeness compares layouts: the same place framed differently, or different places laid
  out alike (sky above, ground below), can be taken for other or for the same scene; the line
  under the result says which, and Intensity lowers the match.
- Across scenes the match is only the reference's look plus Auto's difference of light: it is
  as good as Auto's balance of each frame.
- Hue, HSL, curves, HDR, Local contrast, Shadows and Highlights of the reference are part of
  what is measured but never set on the clip; Brightness, Highlights and Shadows keep the start.
- A style is aimed at as statistics of other scenes: lower Intensity, or register styles per
  kind of scene. PNG stills are not read: the qualified FFmpeg build decodes JPEG only.
- Each clip's fit takes about half a second on the editor's main thread.
