# Track Transform · strict project schema 18

Current contract for [#131](https://github.com/Plonk42/PasCap/issues/131), which made
Transform (crop, uniform scale, translation and rotation) **track-owned, like Colour**,
replacing the clip-owned Transform of [#20](https://github.com/Plonk42/PasCap/issues/20)
and [#90](https://github.com/Plonk42/PasCap/issues/90). This describes the
implementation contract, not test results, hardware/long-run qualification, release
approval or milestone closure. Usage is in [the user guide](../USER_GUIDE.md); timing
and resources are in [speed and audio](../SPEED_AND_AUDIO.md) and
[tracks and keyframes](../LAYERS_AND_KEYFRAMES.md).

Implementation authorities: [pose/schema/mapping](../../src/shared/spatial.ts),
[required track/project data](../../src/shared/model.ts),
[sampling](../../src/shared/timeline.ts),
[atomic commands](../../src/shared/commands.ts),
[native composition](../../src/server/layered-frame.ts) and
[Transform controls](../../src/web/SpatialControls.tsx).

## Decision (#131)

The owner chose, on 2026-10-14:

| Question          | Decision                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Ownership         | **Replace** clip Transform: clips have no `spatial` field; every video track owns one Transform        |
| Keyframes         | **Separate** track Transform keyframes, in project frames, with their own markers and default keyframe |
| Behaviour         | Exactly like Colour: capture buttons, read-only gaps, default keyframe, Reset, live slider preview     |
| Application       | **Per source**, like Colour: each clip's recording is cropped, fitted and posed with the track's pose  |
| Different framing | Put the clip on its own track, as for a different grade                                                |

Rationale for per-source application: it keeps the existing per-source pipeline
(inverse mapping and coverage before grading, one premultiplied group per track) with
no extra resampling pass, buffer or native process; crop stays relative to each clip's
recording. A group-level picture-in-picture transform would need another RGBA16
resampling pass and was not chosen. Consequences: a pose no longer follows a clip
through trim, split, move or retiming; both dissolve sources share the evaluated pose;
moving a clip to another track adopts that track's Transform.

## Required data and ownership

Every schema-18 video track requires `transform: { base, keyframes }`; clips have no
`spatial` field, and a saved one is invalid. Both objects and all keyframes are strict:
no unknown fields, optional legacy values, coercion, persisted defaults or load-time
repair. `base` is one complete eight-value pose; `keyframes` is a required array of
**0–256** keys. Each key requires `{ frame, values, easing, reset }`: all eight fields are
required in `values`, each a number (the setting is keyed here) or `null` (it is not),
with at least one number. `easing` has the same eight fields: an Easing for each keyed
setting, `null` for the others. `reset` marks a [default keyframe](#default-keyframe).
Frames are unique ascending absolute **project** frames in **0–2,147,483,647**; they may
lie after the project duration and never extend it.

| Field                       | Bounds and meaning                           | New-track neutral value |
| --------------------------- | -------------------------------------------- | ----------------------- |
| `cropLeft` / `cropRight`    | Each in [0, 1], fractions of original width  | 0 / 0                   |
| `cropTop` / `cropBottom`    | Each in [0, 1], fractions of original height | 0 / 0                   |
| `scale`                     | Uniform, aspect-preserving 0.1–8             | 1                       |
| `translateX` / `translateY` | −2–2, fractions of full output width/height  | 0 / 0                   |
| `rotation`                  | −180°–180°, clockwise                        | 0                       |

Opposite crops may meet or cross (left + right ≥ 1, or top + bottom ≥ 1): that
covers nothing and the track displays nothing there. It is never rejected or repaired.

Neutral creation values are not defaults for missing saved data. Transform keyframes
are separate from the eleven shared Colour/Opacity track keyframe channels: they have
their own list in **Track → Transform** and their own timeline markers. Colour, Opacity,
clip-only speed and clip-only Detail are unchanged.

With no keys for a setting, its `base` value holds everywhere. Once any key enables a
setting, that setting's curve overrides its base, including endpoint holds before its
first and after its last key; a single key holds its value throughout. Each setting
interpolates between its own enabled keys, skipping keys that leave it `null`, using its
own Easing at the left key (`hold`, `linear`, `ease-in`, `ease-out` or `smooth`).
Interpolation is numeric setting-by-setting, not an affine-matrix or image crossfade.
Rotation does **not** take a shortest arc: +170° to −170° travels through 0°. Removing a
setting's last key reveals its unchanged saved base.

### Default keyframe

A default keyframe (`reset: true`) is created with all eight settings at their neutral
values and **Hold** Easing, exactly like Colour's. It never reaches back: before a
default keyframe that is a setting's first key, that setting keeps its base. A setting
keyed earlier eases into the default with its Easing at the previous key, then holds it.
Its values, Easing, time and enabled settings remain editable; it stays a default keyframe.

## Timing

Transform evaluates at **absolute project time**, like Colour and Opacity, on every clip
of the track and on both dissolve sources. Geometry can therefore move while slow motion
holds one recorded image; no optical-flow or intermediate image is invented. Clip speed,
trims, splits, cuts, duplicates and moves never touch track Transform keyframes, and
Transform edits never change source ranges, placement, speed, duration, transitions,
fades, music or Colour keyframes. Originals and proxies are not cropped or rewritten.

## Geometry and coverage

Use top-left coordinates with positive X rightward and positive Y downward.
For original dimensions $W_s,H_s$ and output dimensions $W_o,H_o$, uniform
contain fit is $f=\min(W_o/W_s,H_o/H_s)$. Fitted dimensions $fW_s,fH_s$ are
**unrounded** geometry derived from each source's registered original aspect, not
from an even-rounded proxy/decode rectangle. Apply uniform scale and clockwise rotation
about the **original image centre**, then translate by
$(\mathrm{translateX}W_o,\mathrm{translateY}H_o)$.

Crop removes original edges without refitting, stretching, recentering or moving
the pivot. Inverse-map each output pixel centre $(x+0.5,y+0.5)$ into original
normalized $(u,v)$, then test the half-open source rectangle:

$$
\mathrm{cropLeft}\le u<1-\mathrm{cropRight},\qquad
\mathrm{cropTop}\le v<1-\mathrm{cropBottom}.
$$

Nonneutral poses have binary coverage $m_i=1$ inside that rectangle and $m_i=0$
outside it, including outside the transformed original image. Missing coverage
reveals lower tracks, or black on the opaque project background; it is not opaque
black padding that hides lower footage. Rotation does not enlarge output dimensions.

**Exact neutral pose is a deliberate rendering exception.** All four crops and
translations/rotation must equal zero and scale must equal one, with no epsilon
test. Preserve the old fit/indexing path and its **opaque black letterboxing
after grading**: padding is not graded/lifted and its coverage remains one.
Even a tiny nonneutral edit uses transformed transparent coverage. An evaluated
neutral keyed pose also uses the neutral rendering path, but the existence of
keyframes still excludes static export.

For each source $i$ at an output pixel, let $G_i$ be graded sampled RGB, $b_i$
black-fade brightness, $o_i$ the sole evaluated video track Opacity, $w_i$ dissolve weight
and $m_i$ the source coverage mask (one throughout the neutral canvas, with black
RGB padding). A dissolve remains **one premultiplied track group**:

$$
C=\sum_i G_i b_i o_i w_i m_i,\qquad A=\sum_i o_i w_i m_i,
\qquad \mathrm{result}=C+\mathrm{lower}(1-A).
$$

Both dissolve sources use the same evaluated track pose and Opacity; their masks differ
only through their own recordings' aspect. No second track/group opacity multiplier
exists. Black fades change RGB, not coverage. Spatial RGB resampling precedes grading.
The Original preview bypasses Colour and clip Detail only, preserving geometry/coverage.

## Preview, native export and resource boundaries

WebGL2 consumes the shared inverse affine mapping and crop bounds with explicit
top-left/source-texture orientation conversion. Native composited export uses
the same original-aspect mapping, bilinearly sampling the existing fitted RGB8
content and clamping sample taps to that content, not its black decode padding.
Neutral native samples retain old byte indexing and opaque padding.
Native LUT interpolation, fitted decode resolution and final H.264/YUV
quantisation are approximations, not bitwise GPU/native equivalence.

Any nonneutral track Transform base or **any** Transform keyframe, even all-neutral or
after the duration, requires composited export. The two-normal-speed-clip diagnostic
reference rejects Transform edits/keyframes; use production Export.

No transformed image or duration-sized pose/mask buffer is allocated. The native
budget remains four raw buffers (two RGB8 + two RGBA16), **22 bytes/pixel =
182,476,800 bytes UHD**, and two reusable 65³ Float32 LUTs, **6,591,000 bytes**.
Serial passes retain at most one original decoder, two intermediate readers,
one encoder and three native video children. Preview retains two WebCodecs
decoders/textures per video track (16 for eight), plus one source-review decoder.

## Track → Transform controls

**Transform** is a Track section after **Colour curves** and before **Keyframes**,
collapsed for new preferences and included in Track's **Expand all / Collapse all**.
**Transform animation** heading help stays reachable while collapsed. It works on an
empty track, like Colour.

The expanded section's keyframe line shows the keyframe count, one **Previous/Next
Transform keyframe** pair over every stored key, **Reset transform** and **Add default
Transform keyframe** (pressed: **Remove default Transform keyframe**). Each of the eight
**Crop left / Crop right / Crop top / Crop bottom / Scale / Translate X / Translate Y /
Rotation °** settings pairs a native slider with an exact field, its own blue capture
button (hollow ▽ / filled ▼, **Keyframe Scale**, etc.) and per-setting **Previous/Next**.

- A setting with no keys edits the track base. Once keyed, its main field is read-only
  unless that setting is keyed at the real playhead; the capture button keys the
  evaluated value there with Linear Easing, joining an existing key (adopting the Easing
  its settings agree on, else Linear). A filled button removes only that setting.
  Sliders and numbers never create keyframes. Capture is unavailable at the 256-key
  limit unless joining an existing key.
- Dragging a main or stored slider previews the draft in the image without a document,
  history, save or music change; release commits one Undo step. Escape, cancellation,
  lost capture, blur or an invalid value restores control and preview.
- **Reset transform** works like Colour's Reset: with no keyframes it restores the
  neutral base; once animated it returns only the settings enabled at the keyframe at the
  playhead to neutral, keeping other keyframes, Easing and the base. Double-clicking a
  setting's name resets only that setting.
- **Add default Transform keyframe** adds a default keyframe at the playhead, or removes
  the one there, in one Undo step; it is unavailable where an ordinary keyframe exists.
- **Selected Transform keyframe**, **Preview stored keyframe** and the header and
  per-setting Previous/Next reach every stored key, including keys after the duration,
  previewing the nearest available frame. A section-local stored cursor keeps stepping
  through keys that preview the same last frame; it is cleared by a manual seek,
  playback or track inspection. Stored time stays distinct from the playhead
  (**Stored timeline frame N · playhead frame P**); capture always uses the playhead.
- The stored section edits the selected key: **Timeline frame**, **Easing** (sets every
  enabled setting, reads **Mixed** when they differ; **Per setting** reveals one select per
  continuing setting) and its enabled settings' values. A default keyframe shows a
  **Default** badge. **Delete selected Transform keyframe** removes the whole key.
- Numeric drafts keep full precision, apply on Enter/blur and restore on Escape; invalid
  values and occupied frames stay editable with inline errors, never clamped or merged.

### Timeline Transform markers

Each video track shows one boxed blue **▼** marker per stored Transform keyframe,
overlapping the top edge of its lane at the key's project frame (keys after the last
clip keep their markers there), as the amber Colour markers overlap the bottom edge. A
default keyframe is filled light blue with the default-keyframe icon. The accessible
name and tooltip list the enabled settings. Click, Enter or Space selects the track,
seeks the key (or the last frame for a key after the duration) and opens Track →
Transform. Markers slide through the shared `useKeyframeSlide`: drag (snapping to
boundaries, bookmarks and the playhead; Alt bypasses) or ←/→ (one frame, Shift ten);
drafts preview without history/save, a valid release is one Undo step, and Escape,
cancellation, blur or an occupied frame restores. Clips have no Transform lane; their
salmon **◆** custom-speed lane is unchanged.

## Preservation

Projects and version-1 export receipt snapshots must satisfy strict **schema 18**.
Incompatible v1–v17 projects/receipt snapshots and completed videos remain untouched.
Recreate projects deliberately; do not migrate, default-fill, rewrite or delete old
data automatically. Registry/proxy/PCM and receipt/report format versions do not change.
