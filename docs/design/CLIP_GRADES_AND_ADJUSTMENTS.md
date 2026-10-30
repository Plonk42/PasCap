# Clip grades and adjustment items

Decision record for [#215](https://github.com/Plonk42/PasCap/issues/215), part of milestone
v1.3 ([#284](https://github.com/Plonk42/PasCap/issues/284)). **Status: decided; the clip grade
([#273](https://github.com/Plonk42/PasCap/issues/273)), Auto writing it
([#285](https://github.com/Plonk42/PasCap/issues/285)) and adjustment items replacing track
Colour ([#286](https://github.com/Plonk42/PasCap/issues/286)) and items on the timeline
([#287](https://github.com/Plonk42/PasCap/issues/287), with the Colour tab following the
selection) are implemented on the v1.3 branch, and so are items through MCP (#288); the UX evaluation (#289) is not.** The
current contracts are [clip grades and adjustments](ROW_APPEARANCE.md),
[spatial transforms](SPATIAL_TRANSFORMS.md) (with Opacity), [HSL and curves](HSL_AND_CURVES.md),
[Temperature and Tint](TEMPERATURE_AND_TINT.md), [detail filters](DETAIL_FILTERS.md) and
[Auto adjust](AUTO_ADJUST.md); this note keeps the decisions, including those still to deliver.

Decisions marked **(owner)** were made on 2026-10-23 or 2026-10-28; every question of #215 is
answered.

## Why

Before #286, all Colour belonged to the video track (#70). So a grade for one shot was stored as
track keyframes at project frames, and any trim, reorder, Ripple change or added dissolve left
those keyframes behind (#273). A different treatment needed another track (at most eight), and
a look over a stretch of the film had no object of its own.

The milestone splits the two jobs, as CapCut, Premiere and Resolve do:

- a **clip grade** is what a shot needs: it belongs to the clip and follows it;
- an **adjustment item** is what happens at a moment of the film: a grade over a project-time
  range.

Options considered (owner, 2026-10-23):

| Option                                                  | Outcome                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composite adjustment layer grading the picture under it | Not chosen: it differs under partial Opacity and dissolves, Detail/local tone and Transform would need another full-frame pass, and the native 22 bytes/pixel budget would grow |
| **Range-scoped items graded per source**                | **Chosen**: each source is still graded once per owner before composition, so dissolves, Transform resampling and native budgets keep their shape                               |
| Keep the track model and improve keyframe editing       | Not chosen: #273 stays unsolved                                                                                                                                                 |
| Pin individual track keyframes to clips                 | Rejected: mixing clip-pinned and fixed keyframes in one curve makes every clip move change the meaning of the keyframes around it                                               |
| A per-track "keyframes follow clips" mode               | Rejected: it cannot express a look spanning several clips                                                                                                                       |

## Delivery order and compatibility

1. [#273](https://github.com/Plonk42/PasCap/issues/273) clip grade (implemented). Track Colour
   still applied after it. Additive: the next schema gave every clip a neutral grade through an
   upgrade step and frozen fixture, so projects rendered as before.
2. [#285](https://github.com/Plonk42/PasCap/issues/285) Auto and Auto white balance write clip
   grades (implemented).
3. [#286](https://github.com/Plonk42/PasCap/issues/286) adjustment items replace track Colour
   (implemented).
4. [#287](https://github.com/Plonk42/PasCap/issues/287) items on the timeline and
   [#288](https://github.com/Plonk42/PasCap/issues/288) items through MCP (implemented);
   [#289](https://github.com/Plonk42/PasCap/issues/289) UX requirements and the closing
   evaluation.

**No migration for #286 (owner, 2026-10-28; implemented):** removing track Colour is a breaking
change, accepted because there are no real projects yet. Track Colour, track Opacity and the
shared track keyframes are removed. Projects and export receipt snapshots saved before it are
rejected with a clear reason ("It grades with track Colour, which PasCap replaced with clip
grades and adjustments; it cannot be upgraded and is left unchanged.") and left untouched, never
deleted: `OLDEST_PROJECT_SCHEMA_VERSION` is that schema. Proxy, PCM, registry and receipt format
versions are unchanged.

## Data

### Clip grade (owner)

Every clip requires `grade: { colour, keyframes }`.

- `colour` is the whole Colour section, with the same fields, bounds and neutral values as
  the track `colour` it replaces: the twelve scalar settings, `hdr`, `localContrast`, `hsl` and
  `curves`. No Opacity or Transform. New clips are neutral.
- `keyframes` are in **original-source frames**, like speed keyframes, so a key stays on its
  image through trims, splits, Reverse and speed changes. Each key is
  `{ frame, values, easing, reset }` with the fourteen nullable Colour channels (`temperature`
  … `localContrast`, without `opacity`), one Easing per enabled setting and the
  [default keyframe](../LAYERS_AND_KEYFRAMES.md#default-keyframes) flag. Frames are unique
  ascending integers in `[0, frameCount]` of the recording; keys outside the trim are kept,
  like off-trim speed keyframes. At most **64** keys per clip, the items' limit (owner).
- A clip's grade is evaluated at its continuous source position
  `PlacedClip.retiming.sourcePositionAt(frame − start)` (one frame lower on a reversed clip, so a
  key applies fully as its image appears), so slow motion interpolates between keys and a
  reversed clip plays its keys backwards. HSL and curves stay static.
- Trims, moves (including to another track), Ripple, splits, cuts, duplicates, Reverse and
  Move to new track keep the grade with its footage; split, cut and duplicate copy it.

### Adjustment items (owner)

The project requires `adjustments`, the single adjustment track: an array of at most **1,024**
items `{ id, start, duration, colour, keyframes }`, sorted by `start`, **never overlapping**.

- An item grades **every video track** within `[start, start + duration)`. There is no
  per-item track choice: a look for one track only is a clip grade.
- **Hard edges.** Fades or a Strength setting can come later if needed; a look is eased in
  with keyframes.
- `colour` has the clip grade's fields. `keyframes` (at most **64**) have the clip grade's
  shape, with frames **relative to the item's start**. Moving the item moves its animation. A
  left trim rebases the offsets so each key keeps its project frame. Keys always lie within the
  item's range (frames 0 to duration − 1): a move or trim that would leave one outside is refused,
  and the user makes the item longer to key later frames.
- Items stay at their project frames when clips are trimmed, moved, rippled, split or deleted:
  they never follow clips. They do not extend the project duration.
- Splitting an item gives both pieces the whole grade and every key, rebased.

### Tracks after #286 (owner, implemented)

A video track keeps `transform`, Ripple, transitions and fades. **Opacity becomes a Transform
setting**: the Transform base and each Transform keyframe gain `opacity` (0–1, neutral 1), with
its own nullable value and Easing like the other eight. Opacity and Transform both describe how
the track's layer sits over the ones below; neither grades the image. `layer.opacity` and the
shared track keyframes (`layer.keyframes`) are removed, so a track has one keyframe list.

- A default Transform keyframe and **Reset transform** also return Opacity to 1.
- "Exact neutral pose", which keeps the opaque black letterboxing, stays about geometry
  only: a track at 50% Opacity with untouched geometry keeps the letterbox path. Opacity stays
  coverage, $o_i$ in the equations below.
- Opacity alone is not per-pixel heavy work: it does not send a group to the GPU export worker.

## Rendering

### Order and equations (owner)

A source has at most two grades: its clip's, and the item covering the project frame, if any.
For a source pixel, with clip grade $c$ and item grade $a$ evaluated at that frame (neutral
when absent):

1. Inverse track Transform mapping, unchanged.
2. The detail kernel runs **once** on source taps. Clip Detail is unchanged. For the four local
   tone settings $t \in \{\text{hdr}, \text{localContrast}, \text{shadows}, \text{highlights}\}$
   the kernel uses $t = \mathrm{clamp}(t_c + t_a)$ to the setting's range. Shadows and
   Highlights choose tones after the summed Exposure $e_c + e_a$, which equals the exposure the
   two grades apply in sequence. No extra taps or pass.
3. The SDR grade runs **sequentially**: $G = \mathrm{grade}(\mathrm{grade}(D, c'), a')$, where
   $c'$ and $a'$ are the grades without their local tone settings and $\mathrm{grade}$ is the
   existing ordered encoded BT.709 grade (Temperature/Tint … curves), unchanged. Each grade
   ends with its own clipping and encoding. Settings are never summed into one grade:
   sums only approximate scalars and cannot combine HSL or curves.
4. Black fades, Opacity and coverage, then grouped source-over, unchanged:
   $C = \sum_i G_i b_i o_i w_i m_i$, $A = \sum_i o_i w_i m_i$,
   $\mathrm{result} = C + \mathrm{lower}(1 - A)$.

In a dissolve each source has its own clip grade and both share the item at that frame. A
transition slot (fade through black with pause) stays neutral black. An exactly neutral clip
grade without an item bypasses grading, bit-identically to a neutral track before. Between #273
and #286, the track's evaluated Colour took the item's place in these equations; with #286
implemented, the item does.

### Preview

`sampleTimeline` returns both evaluated grades per source. The compositor's grading programs
apply the second grade after the first, and the detail variants receive the summed local tone.
The scalar-only fast program stays for sources whose two grades are both scalar-only.

**GPU capacity (owner):** HSL and curves stay in uniforms. The two-source advanced program uses
roughly 180 fragment uniform vectors today (HSL 16, curve nodes 128, the rest about 35); two
grades per source need roughly 330, above WebGL2's guaranteed 224. Desktop GPUs report far more.
The compositor reads `MAX_FRAGMENT_UNIFORM_VECTORS` at start-up; a GPU without room fails with
an explicit preview error naming both numbers, to revisit only if it happens. Before #273,
check the CI renderers' value (Chrome's SwiftShader, whose value the `advanced-colour-gpu` spec
already attaches, and Firefox's llvmpipe). No texture, decoder or lane is added.

### Native export

- **Composited CPU path:** each source grades with a LUT composed from both scalar grades,
  generated by evaluating them in sequence at each lattice point, so the two reused 65³ LUT
  arrays and their identity cache stay; the identity is the pair of evaluated grades. A source
  with HSL or curves in either grade uses the exact path, evaluating both grades in sequence per
  pixel: up to twice today's exact cost, with no new buffer. The four raw buffers (22
  bytes/pixel), worker bands and serial child bounds are unchanged.
- **GPU export worker:** a group goes to the worker when either grade of a source has local
  tone, HSL or curves, besides the existing Detail and spatial conditions. Its page uses the
  preview's programs, so the capacity check above applies; a failure falls back to the CPU
  compositor as today.
- **Static fast path:** each clip already gets its own LUT. Before #286, it was the clip grade
  followed by the track Colour, composed into one LUT. Since #286 (implemented), it requires **no
  adjustment items** and every clip grade unkeyed, scalar-only and with zero local tone, besides
  the existing single-track conditions (Opacity 1 and neutral Transform without Transform
  keyframes, neutral Detail, contiguous from frame 0). Anything else uses composited export.

## Editor

Follows the requirements of #289: one settings panel, an unmistakable target.

- **Colour tab (owner).** Properties become **Clip / Colour / Track / Audio**. Colour holds
  the Colour section (groups, keyframe line, Auto, stored keyframes), **HSL ranges** and
  **Colour curves**, with today's controls and behaviour. Its pinned header names the target:
  the clip ("Clip 3 · DJI_0468"), or the item by its range ("Adjustment 01:12:05 – 01:20:00").
  Between #273 and #286 it served the selected clip or the selected track; #286 added a temporary
  **Clip / Adjustment** switch, which #287 replaced with the timeline selection.
- **Target rules (owner, implemented).** Nothing is edited implicitly. The tab edits the selected
  clip's grade or the selected item; with no clip or item selected, it shows nothing to edit and a
  hint to select one. Clips and items can be selected together (Ctrl/Cmd-click), so they can be
  dragged together; with several clips, or a clip and an item, editing is disabled with the reason.
  Items are created on the adjustment track (drawn, or with its **Add adjustment** over the ruler
  range or the selected clip).
- **Track tab (owner, implemented).** It keeps **Transform**, which now includes an **Opacity** setting (UI
  0–100%) with its triangle and per-setting Previous/Next like the other eight, then Transitions
  and Fades. The section keeps its name for now.
- **Timeline (owner).** The adjustment track is a lane **above the video tracks, under the
  ruler** (#287). Items have no name: they are shown and announced by their timecode range. A clip
  grade's keyframes are amber markers inside the clip rectangle, moving with it; an item's are
  amber markers inside the item. Both slide through `useKeyframeSlide`. Track keyframes are the
  blue Transform ▼ markers only (implemented, with the clip grade markers).
- **A clip's whole grade (owner).** When a clip is selected, the item also grading it at the
  playhead is highlighted on the timeline, in a style distinct from the selection; clicking it
  selects it. The panel adds no line for it.
- **Copy grade / Paste grade (owner)** act on the clip or item that is **right-clicked**, never
  on what is at the playhead, which can be several objects across tracks. Each paste is one Undo
  step.
  - **Copy grade** is available only on a clip or item **without keyframes**; otherwise it is
    unavailable with that reason. A right-click points at no particular frame, so a keyed grade
    has no single value to copy. Copying keyed grades may come later.
  - Paste replaces the right-clicked target's grade (all settings, HSL and curves) and removes
    the target's keyframes.
  - When the target belongs to the selection, the paste applies to every selected clip and
    item, still in one Undo step.
- **Original preview (owner, implemented).** Three modes: bypass clip grades, bypass items, or both. Holding
  a modifier while pressing the hold-to-show **Original** button chooses the mode directly, with
  no menu first. The button's tooltip and accessible description list the modifiers.
  The keys, for the pointer and for Enter/Space:
  - plain: bypass both;
  - **Shift**: bypass clip grades only;
  - **Alt**: bypass items only.

  Ctrl is avoided because Ctrl-click opens the context menu on macOS. Clip Detail is bypassed
  with clip grades. The **Original** badge names the mode in effect.

- **Item gestures** (#287): create from the selected ruler range or a clip's span, or by drawing;
  move, trim, split and delete with snapping, red refused placements and one Undo step per valid
  release.
- **Unchanged contracts:** controls fit the 270 px Properties minimum (the sections move as they
  are; the header ellipsizes); every accepted edit or completed gesture is one Undo step;
  Escape, cancellation, lost capture and blur restore.

## Auto (owner, implemented)

Auto and Auto white balance write **clip grades only** (#285): as clip values or a clip keyframe
at the playhead. There is no Auto on items. The Track source grades each clip of the track on its
own, and the track-level compromise grade is removed with track Colour.

## Assistant

- **Clip grades (owner, implemented):** one clip-grade edit command per clip and a batch form like
  `detail-clips` (the Colour commands take `clipIds`). `estimate` with `applyAs: 'shots'` writes each clip's grade values; the
  track-keyframe shots mode is removed.
- **Items (owner, #288, implemented),** balancing features, calls and tokens:
  - no new read: `describe_project` lists items compactly (id, range, non-neutral settings,
    keyframe count), and `describe_track` reports each clip's grade the same way plus the ids
    of the items overlapping it, so one read explains a clip's look;
  - edit commands `item-add` (a range with an optional grade), `item-set` (range or grade),
    `item-key-set`, `item-split` and `item-remove`. Implemented under the names the model and the
    editor use: `adjustment-add` with optional starting `settings`, `adjustment-range`, the
    Colour commands and `layer-key-set` with an `adjustmentId`, `adjustment-split` and
    `adjustment-remove`;
  - `estimate` writes clip grades only, like Auto. `still` and `timeline_sheet` render items.

## Guides changed at delivery

#70's track-only Colour ownership is superseded: Colour belongs to clips and items, while
Transform, now including Opacity, stays on the track (#67, #131). With #286 delivered, these
guides describe it: [clip grades and adjustments](ROW_APPEARANCE.md) (the former track
appearance contract), [spatial transforms](SPATIAL_TRANSFORMS.md) (Opacity setting),
[tracks and keyframes](../LAYERS_AND_KEYFRAMES.md), [HSL and curves](HSL_AND_CURVES.md),
[Temperature and Tint](TEMPERATURE_AND_TINT.md), [detail filters](DETAIL_FILTERS.md),
[Auto adjust](AUTO_ADJUST.md), [editor controls](EDITOR_CONTROLS.md),
[timeline editing](../TIMELINE_EDITING.md), [workspace](../WORKSPACE_AND_RECOVERY.md),
[speed and audio](../SPEED_AND_AUDIO.md), [colour and timing](../COLOUR_AND_TIMING.md),
[development](../DEVELOPMENT.md), [the assistant](ASSISTANT_MCP.md), the
[user guide](../USER_GUIDE.md) and the architecture notes in `.github/copilot-instructions.md`;
#287 and #288 updated them again for items on the timeline and through MCP.
[#176](https://github.com/Plonk42/PasCap/issues/176) (HSL keyframes) then applies to clip grades
and items.
