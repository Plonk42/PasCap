# Editor control catalogue

## Scope and decisions

Controls use native elements, the existing editor layout and the strict current project
schema, including complete track Colour and Transform, clip-only speed and reverse and 0–8 independent music tracks. No UI framework or icon dependency is introduced. Exact
timing entry is retained: Clip Range uses timecode text fields and a
full-original range bar; other frame/duration/fade fields retain numeric steppers.

### Current control inventory

| Area                          | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Contract                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Colour / Opacity              | Native slider and exact field in main/stored editors; Temperature, Tint, Saturation, Hue and Opacity have coloured tracks; main sliders grouped under Opacity, Colour, Light and Effects headings                                                                                                                                                                                                                                                                                                            | Opacity UI 0–100%, neutral 100%; stored track/keyframe values remain 0–1                                                                                                                         |
| Speed                         | Clip constant rate or 1–256 source-frame keyframes; Keyframe Speed circle; native **Reverse** checkbox                                                                                                                                                                                                                                                                                                                                                                                                       | Bounded slider/exact-value pattern; retain presets and curve graph                                                                                                                               |
| Transform                     | Eight track pose sliders/exact fields, each with its own blue triangle and Previous/Next, stored keyframe list, default keyframe toggle                                                                                                                                                                                                                                                                                                                                                                      | Works exactly like Colour: explicit per-setting project-frame capture; distinguish stored time from preview                                                                                      |
| Detail                        | Clip Sharpen, Clarity and Denoise sliders/exact fields with **Reset detail**                                                                                                                                                                                                                                                                                                                                                                                                                                 | Static, no keyframes; live image preview while dragging; one Undo per release                                                                                                                    |
| Audio                         | Music track / Recording selects, Add music track, selected-track trash and gain slider                                                                                                                                                                                                                                                                                                                                                                                                                       | Independent identified tracks; exact gain draft; import never implicitly places                                                                                                                  |
| Clip Range                    | One full-original hatched range bar with draggable IN/OUT; exact text fields below its ends                                                                                                                                                                                                                                                                                                                                                                                                                  | Display 30 fps NDF timecode; accept whole original frames or timecode                                                                                                                            |
| Camera motion                 | Collapsible **Camera motion** section below the range: header with chevron title, **Steadiest range** and **Use**; a row with the shared **Allowed movement** slider/exact field/Reset and the **Flight data** popover (or **Analyse camera motion** for older proxies); motion lanes aligned with the strip (image lane: jolts, movement, draggable dashed allowed movement; one lane per chosen flight data value; steady-range bands; hover reads values), drawn in the editor's neutral greys and accent | Measured during proxy preparation; Use applies the source range like any range choice                                                                                                            |
| Other frames, duration, fades | Integer timing needs exact entry and contextual validation                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Retain native numeric steppers and timecode feedback, not arbitrary slider limits                                                                                                                |
| Slider gestures               | Transient local pointer draft; Colour/Opacity/HSL/Transform also preview it in the image                                                                                                                                                                                                                                                                                                                                                                                                                     | One validated edit on release; cancellation restores control and preview; keyboard edits stay individual                                                                                         |
| Keyframe / music deletion     | Trash action with accessible name                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Delete the identified keyframe/track; × only closes/dismisses                                                                                                                                    |
| Inspector / viewer tabs       | Consistent native-button appearance                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Retain existing keyboard navigation and mounted drafts                                                                                                                                           |
| Keyframes                     | Colour and Transform each end with a stored keyframe list under a small **Keyframes** heading; keyframe lines own navigation; Animation help beside Colour's heading                                                                                                                                                                                                                                                                                                                                         | Keep accessible names Track keyframes / Transform keyframes; no separate count, navigation or section                                                                                            |
| Import actions                | **Import** (Media) and **Import music** (Audio) open one **Import media** dialog: Locations, breadcrumb, All/Video/Music filter, checkbox list and **Import N**                                                                                                                                                                                                                                                                                                                                              | Deliberate import; double-click imports one recording; no implicit music placement                                                                                                               |
| Track options / Timeline      | Visibility, Ripple, stacking and frequent clip actions already have native controls/icons                                                                                                                                                                                                                                                                                                                                                                                                                    | Keep their locations; Duplicate and **Move to new track** are in the clip context menu; zoom has slider, Fit and Zoom out/in buttons                                                             |
| Help / disclosures / options  | Question-mark help and top-layer options are already consistent                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keep those components and browser preferences                                                                                                                                                    |
| Timeline range / ruler        | Drag on the time ruler selects a project-frame range; a click seeks; the playhead handle scrubs                                                                                                                                                                                                                                                                                                                                                                                                              | **Cut range** needs a range and a selected clip it overlaps, else its tooltip names the reason; Play (ringed in the range colour) replays only the range; no timeline IN/OUT buttons or I/O keys |
| Bookmarks                     | Toolbar **Bookmark** (or **M**) adds at the playhead, becoming a trash **Delete bookmark at playhead** on one, between **Previous / Next bookmark** (Shift+↑/↓); lilac outlined ghost playheads                                                                                                                                                                                                                                                                                                              | Project-time snap points; markers slide like keyframes (`useKeyframeSlide`), Delete removes; duplicates rejected, never merged; never rendered                                                   |
| Original preview              | Preview heading **Original** button (**Show original preview**)                                                                                                                                                                                                                                                                                                                                                                                                                                              | Hold-to-show: pointer or Enter/Space held shows the image without Colour and Detail; release, blur or focus loss restores the grade; no global shortcut                                          |

The icon module already supplies a broad SVG set; it does not need replacing.
The browser preference identifier for Placement remains unchanged deliberately.
Native nested details and title-row disclosures have different responsibilities;
neither needs replacing merely to make their implementation identical.

## Vocabulary

This is the source of terminology for visible UI text, help, accessible names,
test selectors and current-behaviour guides. Internal identifiers, persisted fields
and technical paths stay unchanged; this glossary does not change the project schema.

- **Recording**: the complete original file, video or music. Use **video recording**
  or **music recording** when the distinction matters; never bare “video” for a file.
- **Clip**: an independently editable instance of a video recording on the timeline,
  and its Inspector tab. Several clips can use the same recording.
- **Track**: a horizontal timeline container. Use **video track** or **music track**
  to distinguish them; **Track options** and **+ Track** use the same noun.
  A music track is an independently identified placement of a music recording,
  not another audio clock. **Add music track** creates a placement; **Recording**
  changes its recording; **Delete selected music track** deletes only that placement.
- **Keyframe**: a stored animation value at a frame. Shared track keyframes contain
  **enabled settings**; track Transform keyframes are separate and also use project frames;
  clip speed keyframes use original-source frames.
  Use the full word in labels and help. Static colour curves instead have **control nodes**,
  not animation keyframes. Technical math, internal identifiers and persisted fields
  may retain precise terms such as anchor, participant and `interpolation`; do not
  use them as user-facing synonyms for keyframe, enabled setting or Easing.
- **Range**: the selected IN/OUT portion of a recording, whether reviewed or used by
  a clip. Qualify its context when necessary, without introducing another object name.
  Do not use rush, excerpt, row, layer, point or participant as object synonyms.
- **Bookmark**: a project-wide timeline frame marked as a snap point; not a keyframe,
  range or export chapter.
- **Source IN / OUT**: original-frame boundaries; OUT is exclusive. **Timeline
  frame**: absolute project position. **Duration** and **fades** use output frames.
- **Opacity**, **Speed**, **Colour** and **Ripple** retain their established names.
  Opacity is track-owned coverage, not an additional grading operation. Main and
  stored sliders/exact fields use 0–100%, neutral 100%; track/keyframe storage stays 0–1.
- **Reverse** is a clip's playback direction (Clip → Speed checkbox), never a negative
  speed. Edits name the result as displayed: **Trim start** of a reversed clip trims
  its source OUT.
- **Temperature / Tint** are track-owned normalized scalar Colour controls (Temperature −2…2, Tint −1…1),
  neutral 0: positive Temperature warms, positive Tint adds magenta. They precede
  Exposure, are independently animatable and work on empty tracks, with the standard
  slider/exact-field/reset pattern, capture diamonds,
  adjacent per-setting Previous/Next buttons, section navigation and stored-setting
  chip arrows. No Kelvin or AWB label.
- **Vibrance** is a track-owned −1…2 scalar Colour control, neutral 0, last in the **Colour**
  group after Saturation: it scales saturation more for muted colours than strong ones
  (greys and fully saturated colours stay unchanged); a plain slider track, no gradient.
- **Whites** is a track-owned −1…1 scalar Colour control, neutral 0, after Shadows in the **Light**
  group: it moves the white point (lower dims the brightest tones, higher pushes them to white).
- **Blacks** is a track-owned −1…1 scalar Colour control, neutral 0, last in the **Light**
  group: it moves the black point (lower crushes the darkest tones to black, higher lifts
  black for a faded, matte look).
- **HDR** is a track-owned 0–1 Colour control, neutral 0: an SDR local tone-mapping
  look, not HDR output. It is keyframable like the other Colour settings and runs
  on source taps before the grade, with the clip detail filters.
- **Local contrast** is a track-owned −1…1 Colour control, neutral 0, below HDR in the
  **Effects** group: the local-detail boost split out of HDR, without its tone compression
  (raised it separates each area from its surroundings, lowered it flattens them). It is
  keyframable like the other Colour settings and runs with HDR in the detail kernel.
- **Transform** is track-owned crop, Scale, Translate X/Y and Rotation, applied to every
  clip on the track like Colour; each setting has its own capture triangle, and its
  keyframes are separate from the shared Colour/Opacity keyframes
  ([#131](SPATIAL_TRANSFORMS.md#decision-131)).
- **Default keyframe**: a track keyframe that returns every Colour setting and Opacity (or,
  for a Transform default keyframe, every Transform setting) to its default from its frame,
  holding until each setting's next keyframe, without changing earlier frames. Toggle
  **Add default keyframe** in the Colour keyframe line, or **Add default Transform keyframe**
  in Transform's; filled marker and **Default** badge with the diamond-and-return-arrow icon.
- **Keyframe line**: the first row of an expanded Colour, Speed or Transform section: **N keyframes**, one
  **Previous/Next** pair over the same set and **Reset**. It is hidden while the section is collapsed.
  There is no Animate toggle or stored preference; capture diamonds and per-setting arrows are always visible
  (Speed, a single setting, relies on its keyframe-line pair).
- **Easing**: the visible label for track-keyframe, Transform and custom clip-speed
  selectors. Contextual accessible names remain, including
  **Track keyframe easing N**. Each enabled setting of a track or Transform keyframe has its
  own Easing: the keyframe's select sets them all and reads **Mixed** when they differ;
  **Per setting** reveals one compact select per setting (**<Setting> easing at track keyframe N**,
  **<Setting> easing at Transform keyframe N**), shown automatically while they differ.

## Control patterns

- Bounded appearance values, playback rates and gain: native slider plus exact
  numeric draft. A pointer gesture is one edit; Escape, cancellation and lost
  capture restore it. Keyboard range adjustments remain native and precise entry
  applies on Enter/blur, while the exact field's stepper and ↑/↓ commit each step at once. The stepper sits at the right of the unit. Invalid numeric drafts remain editable with inline errors.
- Clip Range: exact **Source IN / OUT** text fields display **MM:SS:FF**
  (30 fps NDF) and accept whole original frames or timecode on Enter/blur.
  Invalid drafts retain editable errors; Escape restores. One full-original bar
  hatches omitted footage, with fields below its ends and no duplicate duration,
  original-length, source-frame or recoverable head/tail labels. **Restore full
  recording** remains. Fields and bar use ordinary source-range trim: placement
  stays fixed and Ripple re-sequences the suffix normally, unlike the timeline
  left handle's retained-OUT rule. Drag previews the complete validated document;
  final valid release commits one Undo step. Invalid final release, Escape,
  cancellation, lost capture or blur restores; never commit an earlier valid draft.
  Handle arrows move one original frame (Shift ten); Home restores IN=0 and End
  restores OUT=original frame count. Source review's numeric IN/OUT apply as one
  validated pair on Enter or when focus leaves both fields (not between them), except that a
  native stepper/↑↓ step applies at once and shows that edge; Escape restores. See [TIMELINE_EDITING.md](../TIMELINE_EDITING.md).
- Other frames/durations/fades: native numeric stepper, explicit frame units and existing
  timecode feedback. No clamping, rounding or hidden timing repair.
- Easing/modes/recordings: native select; selected easing has its existing graph.
- Boolean settings: native checkbox. Main scalar Colour/Opacity controls expose a capture diamond with
  `aria-pressed` and adjacent per-setting **Previous/Next** buttons, since a shared
  keyframe need not enable every setting. Colour's keyframe-line Previous/Next pair visits the union of Opacity, twelve scalar, HDR and Local contrast keyframes.
  Clip **Speed ×** has one **Keyframe Speed** circle capturing or removing a keyframe at the
  actually displayed source frame, without extra per-setting arrows; in curve mode its rate is
  read-only without a keyframe there. Speed's pair visits all retained
  custom speed source keyframes of the selected clip, including off-trim keyframes
  and original exclusive OUT, previewing the nearest mapped image through
  authoritative retiming.
  Transform's pair visits all track Transform keyframes, including those after the
  duration, with its own track-local cursor; Speed keeps a clip-local
  stored-source cursor independent of central track inspection; successive stored
  keyframes remain reachable even when their first/last preview image is the same.
  Main capture always uses the real displayed project/source frame,
  never the inspected stored time. Enabled setting chips in stored Colour keyframe rows
  retain their per-channel native arrows. All main and stored per-channel arrows
  visit strictly earlier/later keyframes where that channel is nonnull (zero is
  enabled), sharing the central off-duration inspection cursor with section
  navigation to track keyframes and track/list navigation. A read-only animated main value is visibly locked without hover: dimmed slider and
  field plus a lock cue (**Add a keyframe ◇ to edit**) at the right of the setting's name. Interacting with it never creates a keyframe or edit.
  Every slider setting (Colour, Opacity, HSL, Transform, Detail, Speed rates, stored keyframe values, music gain) has a compact
  **Reset** icon button beside its name, labelled **Reset <setting>**: it restores only that setting's neutral value in one Undo step, is
  dimmed with an explanatory tooltip and `aria-disabled` at its default or when the value is read-only/locked, and adds no row or
  width. Double-clicking the name does the same; sections keep one Reset in their keyframe line (Colour, Speed, Transform) and HSL/curves name theirs
  **Reset red** / **Reset all**.
- Setting groups: **Track → Colour** shows its main sliders in four static fieldsets with small uppercase
  headings: **Opacity**; **Colour** (Temperature, Tint, Hue, Saturation, Vibrance); **Light** (Exposure, Brightness,
  Contrast, Highlights, Shadows, Whites, Blacks); **Effects** (HDR, Local contrast). Each heading has a Reset icon (**Reset the Light group**,
  etc.) that resets the group's editable settings in one Undo step, dimmed at the defaults. Headings add no
  tab stop besides that icon; the visible order differs from the unchanged storage/keyframe channel order.
- Setting rows (Colour, Opacity, Transform, Speed, Detail and stored keyframe values) use two compact lines:
  the name with its Reset icon (and any lock cue at the right), then the slider, exact field, capture diamond
  and per-setting Previous/Next on one line, shown as three equal buttons ‹ ◇ ›. Tab order stays diamond, Previous,
  Next, slider, field. Inside the exact field the unit follows the value and the native stepper sits at the right.
- Coloured slider tracks show a setting's direction: **Temperature** runs blue → yellow, **Tint** green → magenta
  (its positive side), **Saturation** grey → red, **Hue** around the full colour wheel and **Opacity** from a
  checkerboard to solid, in main and stored keyframe editors. **HSL ranges** sliders follow the selected range's
  own colour: Hue from 30° below to 30° above its centre, Saturation grey → that colour, Lightness dark → that
  colour → light. Other sliders keep the plain track. The gradient is presentational and dims with a locked or
  disabled slider.
- Colour swatches: **HSL range** and **Colour curve channel** are rows of coloured square buttons in a radio
  group (accessible name of the range/channel, tooltip such as **Cyan range**), not dropdowns. The selected
  swatch has a white ring; focus adds the usual outline; arrows, Home and End move the selection without
  reaching timeline shortcuts. HSL swatches use each range's centre hue, as its slider tracks do. Colour
  curves draw all four curves on one graph, only the selected channel with nodes and edits.
- Tabs: native buttons with one selected appearance and existing arrow/Home/End
  behavior. Disclosures keep mounted drafts; options use the existing Popover.
- Buttons: primary for the main confirmed action, secondary for supporting actions,
  icon-button for familiar compact actions, text-button for contextual alternatives.
  Icon-only actions always retain an accessible name and tooltip.
- Icons: plus adds, folder browses, trash deletes, × closes, reset restores a value,
  eye toggles visibility, arrows navigate/stack, play/pause controls playback.

## Placement

Keep Media for recording discovery/import; the centre's Timeline/Source preview
tabs for viewing; Clip for speed/Detail/source range/placement; Track for Colour,
Opacity, HSL ranges, Colour curves, Transform, transitions and fades (Colour and Transform each ending
with their stored keyframe list); Audio for music. Track options owns
rename, Ripple, stacking and deletion. No tab relocation is justified by the audit.
Keep frequent split/trim/delete/cut actions directly in Timeline, not in another
toolbar. Detailed controls and diagnostics remain contextual/collapsible.

Transform is a Track section (after Colour curves, before Transitions), collapsed by default and included
in Expand all/Collapse all. It works exactly like Colour, including on an empty track.
**Transform animation** heading help remains reachable
while collapsed. **Crop left/right/top/bottom / Scale / Translate X/Y / Rotation °**
pair native sliders with exact fields and live slider preview. Main values edit the base for an unkeyed setting,
or that setting's key at the playhead; a keyed setting without a key
there stays read-only until its own blue triangle (hollow ▽ / filled ▼, as on the timeline marker, never the Colour diamond) captures it.
Every setting has its own triangle and **Previous/Next** buttons like Colour, plus the single **Previous/Next** pair in the keyframe line,
which also holds **Reset transform** and **Add default Transform keyframe**. Below the settings, a
**Keyframes** list, the same shared list as Colour's, shows one row per Transform keyframe: a click anywhere
on a row (or its **Go to Transform keyframe N** timecode) seeks the nearest available frame and marks the row
current, its setting chips carry Previous/Next arrows, and each row's **Edit** (closed initially) holds
**Timeline frame / Easing** and its enabled-setting fields.
A row's trash removes that keyframe, revealing the saved
base of settings left unkeyed; **Reset transform** behaves like Colour's Reset (neutral base
without keyframes, else the enabled settings of the key at the playhead). There is no graph/canvas gizmo. Exact
invalid drafts and sliders follow the common validation/cancellation
pattern. See [SPATIAL_TRANSFORMS.md](SPATIAL_TRANSFORMS.md).

Inside each timeline clip rectangle, boxed salmon
**●** custom-speed buttons, below the label and above the Colour markers, show source keyframes at authoritative retimed output positions.
Off-trim keyframes are omitted; exclusive OUT has a boundary marker that seeks the
final available frame. Click, Enter or Space selects the clip, seeks its nearest
mapped image and opens Clip → Speed; a click edits nothing. Speed keys also slide by drag or ←/→ (one source frame, Shift ten): previewed, one Undo step on a valid release, restored by Escape or an occupied frame; moving a speed key retimes its clip.
Marker keyboard handling is isolated from timeline shortcuts.

Track Transform keyframes are boxed blue **▼** buttons overlapping the top edge of
their track row at project frames (a default keyframe is filled light blue with the
default-keyframe icon), mirroring the Colour markers at the bottom edge; the label of an
animated track's clips sits below them. Click or Enter selects the track, seeks and opens
Track → Transform; they slide by drag or ←/→ (one project frame, Shift ten) like Colour markers.

Audio keeps **Music track / Recording / Add music track / Import music / Delete selected
music track** with native selects/buttons, contextual disabled reasons (no ready source,
eight-track limit or active draft) and existing **Placement & fades** fields.
Imports populate the bin/prepare media without implicit placement. Selection is
editor-only; selected-track edits/removal leave the others unchanged. Each
track retains independent drafts; hiding/selecting cannot apply one to another.
One Undo step per accepted commit/gesture, atomic invalid/cancelled operations and
the common gain-slider/exact-number contract remain authoritative.

Music can extend duration: video closing fades remain at clip OUT, followed by
black while music continues/fades at its own OUT. Controls must not imply
video-only duration or a held final image. No mute/solo, normalisation, ducking,
effect or source-video-audio control is introduced. See
[MULTIPLE_MUSIC.md](MULTIPLE_MUSIC.md) for the strict processing/resource contract.
This catalogue specifies controls, not completed live-browser or test acceptance.
