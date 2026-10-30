# Editor control catalog

## Scope and decisions

Controls use native elements, the existing editor layout and the strict current project
schema, including clip grades, adjustments, track Transform with Opacity, clip-only speed and reverse and 0–8 independent music tracks. No UI framework or icon dependency is introduced. Exact
timing entry is retained: Clip Range uses timecode text fields and a
full-original range bar; other frame/duration/fade fields retain numeric steppers.

### Current control inventory

| Area                          | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Contract                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color                         | Native slider and exact field in main/stored editors; Temperature, Tint, Saturation and Hue have colored tracks; main sliders grouped under Color, Light and Effects headings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The same sections edit a clip grade and an adjustment                                                                                                                                                                                                                                                                               |
| Speed                         | Clip constant rate or 1–256 source-frame keyframes; Keyframe Speed circle; native **Reverse** checkbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Bounded slider/exact-value pattern; retain presets and curve graph                                                                                                                                                                                                                                                                  |
| Transform                     | Nine track settings, the eight pose settings and Opacity (0–100%, checkerboard-to-solid track), each slider/exact field with its own blue triangle and Previous/Next; stored keyframe list, default keyframe toggle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Works like the Color section: explicit per-setting project-frame capture; distinguish stored time from preview; Opacity stored 0–1, neutral 1                                                                                                                                                                                       |
| Detail                        | Clip Sharpen, Clarity and Denoise sliders/exact fields with **Reset detail**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Static, no keyframes; live image preview while dragging; one Undo per release                                                                                                                                                                                                                                                       |
| Audio                         | Music track select with its trash, Add music track and Import music; the track's gain slider and **Ripple**; **Clip** select with its trash and **+ Clip**; the clip's Recording select; under Recording, one line with the tempo, meter, key, beat count and hit count, the analysis progress, or **Analyze music**, then the **Music structure** disclosure (sections, swells, silences and strong hits with timecode buttons that seek); on every music clip a waveform drawn every 10 ms at pixel resolution (an image named **Waveform for music track…**); on analyzed music clips beat ticks (downbeats taller), hit marks on the tone strip (band colors, strong ones taller), section bands, swell hairpins, hatched silences, a low/mid/high tone strip and a hover readout; **Placement & fades**; **Transitions** (Cut / Crossfade / Fade through silence / Fade through silence with pause, with its duration or Fade and Pause), also opened by the boundary buttons between music clips | Tracks of 1–8 clips, like video tracks; exact gain draft; import never implicitly places                                                                                                                                                                                                                                            |
| Clip Range                    | One full-original hatched range bar with draggable IN/OUT; exact text fields below its ends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Display 30 fps NDF timecode; accept whole original frames or timecode                                                                                                                                                                                                                                                               |
| Kept ranges                   | Source preview's applied range is the recording's active kept range (project `selects`); a **Kept ranges** popover beside the readout (**Whole recording** / **N kept ranges**) lists each range's timecodes and length (click to make it active, trash **Remove kept range N**) with **New range** and, set apart below, **Add N clips to timeline**; the other ranges are outlined blocks on the strip (click to make active), Shift-drag in a free stretch draws a new one; after the reset icon, a trash **Delete selected kept range** removes the active one                                                                                                                                                                                                                                                                                                                                                                                                                                     | One Undo step per change; handles stop one frame from neighbors; typed overlapping or touching ranges are an inline error; Reset returns to the whole recording                                                                                                                                                                     |
| Camera motion                 | Motion lanes stacked directly under the range strip, sharing its playhead and IN/OUT hatching (image lane: jolts, movement, draggable dashed allowed movement; one lane per chosen flight data value; steady-range bands; hover reads values), with amber jolts, a white movement line, a color per flight data value and accent bands; below the IN/OUT fields a collapsible **Camera motion** section: chevron title with help, **Best steady range** (what it shows, length, IN–OUT), **Use best** and **Use all N** (kept ranges, not clips), then the shared **Allowed movement** slider/exact field/Reset and the **Flight data** popover (or **Analyze camera motion** for older proxies)                                                                                                                                                                                                                                                                                                       | Measured during proxy preparation; Use applies the source range like any range choice                                                                                                                                                                                                                                               |
| Other frames, duration, fades | Integer timing needs exact entry and contextual validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Retain native numeric steppers and timecode feedback, not arbitrary slider limits                                                                                                                                                                                                                                                   |
| Slider gestures               | Transient local pointer draft; Color, HSL and Transform (Opacity included) also preview it in the image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | One validated edit on release; cancellation restores control and preview; keyboard edits stay individual                                                                                                                                                                                                                            |
| Keyframe / music deletion     | Trash action with accessible name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Delete the identified keyframe/track; × only closes/dismisses                                                                                                                                                                                                                                                                       |
| Color tab                     | Edits the timeline selection: pinned header naming the selected clip (**Clip 2 of 3 · Track 1 · this clip only**; graded clips show a small palette icon before their name on the timeline) or adjustment (**Adjustment 01:12:05 – 01:20:00**, **Every track within this range**, trash **Delete adjustment**); with nothing selected, a hint to select a clip or an adjustment; **Auto** and **Auto white balance** only for clip grades; several selected clips or adjustments ask to select one; clip grade keyframes are amber ◆ markers inside the clip; **Copy grade** / **Paste grade** in the clip and adjustment context menus                                                                                                                                                                                                                                                                                                                                                                | Clip grade keyframes use source frames, adjustment keyframes frames from its start; adjustments are created on the adjustment track; Copy needs a grade without keyframes; Paste replaces the right-clicked clip's or adjustment's grade (or the whole selection's, clips and adjustments) and removes its keyframes, one Undo step |
| Properties / viewer tabs      | Consistent native-button appearance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Retain existing keyboard navigation and mounted drafts                                                                                                                                                                                                                                                                              |
| Side panels                   | Panel icon at the right of the Media and Properties headings collapses the panel to a 28 px labeled strip; the whole strip expands it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Direct `aria-expanded` buttons, never hidden in Workspace options; focus moves to the counterpart button                                                                                                                                                                                                                            |
| Keyframes                     | Color and Transform each end with a stored keyframe list under a small **Keyframes** heading; keyframe lines own navigation; Animation help beside Color's heading                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Keep accessible names Clip keyframes / Adjustment keyframes / Transform keyframes; no separate count, navigation or section                                                                                                                                                                                                         |
| Media heading                 | **Media** with one two-part pill: a video icon with the recording count, then a clock icon with the total duration of all the project's video recordings (shared card duration format; whole bin, ignoring search/filter; absent when empty); each part has an explanatory tooltip. Narrower panels drop the Import label (icon with tooltip), then the pill icons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Display only; no music, selection or trimmed-range totals                                                                                                                                                                                                                                                                           |
| Import actions                | **Import** (Media) and **Import music** (Audio) open one **Import media** dialog: Locations, breadcrumb, All/Video/Music filter, checkbox list and **Import N**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Deliberate import; double-click imports one recording; no implicit music placement                                                                                                                                                                                                                                                  |
| Track options / Timeline      | Visibility, Ripple, stacking and frequent clip actions already have native controls/icons; Ctrl/Cmd-click and each track header's **Select all clips** icon select several clips, which drag, delete and nudge together                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep their locations; Duplicate and **Move to new track** are in the clip context menu; zoom has slider, Fit and Zoom out/in buttons                                                                                                                                                                                                |
| Help / disclosures / options  | Question-mark help and top-layer options are already consistent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Keep those components and browser preferences                                                                                                                                                                                                                                                                                       |
| Timeline range / ruler        | Drag on the time ruler selects a project-frame range; a click seeks; the playhead handle scrubs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | With a range, the trash turns orange and **Delete selected range** needs a selected clip it overlaps, else its tooltip names the reason; Play (ringed in the range color) replays only the range; no timeline IN/OUT buttons or I/O keys                                                                                            |
| Bookmarks                     | Toolbar **Bookmark** (or **M**) adds at the playhead, becoming a trash **Delete bookmark at playhead** on one, between **Previous / Next bookmark** (Shift+↑/↓); lilac outlined ghost playheads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Project-time snap points; markers slide like keyframes (`useKeyframeSlide`), Delete removes; duplicates rejected, never merged; never rendered                                                                                                                                                                                      |
| Beat snapping                 | Toolbar **Snap to beats** toggle (metronome icon, `aria-pressed`) beside **Snap**, with a **Beat snapping options** menu: **Off** / **Beats** / **Downbeats only** / **Hits** / **Beats and hits** (strong hits); ticks along the bottom of the ruler while active                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Browser preference; needs Snap on (else `aria-disabled` with the reason); follows each music clip's placement; writes nothing to the project                                                                                                                                                                                        |
| Original preview              | Preview heading **Original** button (**Show original preview**); **Shift** while pressing bypasses only clip grades and Detail, **Alt** only adjustments; the badge names the mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Hold-to-show: pointer or Enter/Space held shows the image without Color and Detail; release, blur or focus loss restores the grade; no global shortcut                                                                                                                                                                              |
| Assistant hand-off            | Header **Hand off** (**Hand off to an assistant**, sparkle icon) opens a dialog: brief fields and **What the assistant can use** with **Prepare N** / **Analyze N**, **Assistant connection** with **How to connect** and **Copy configuration**; during a session a banner with **Take over**; afterwards a summary with notes, **Edit log**, **Open as new project**, **Restore project before session** and ×                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Editor read-only while an assistant edits; refused edits name the reason; readiness never blocks the hand-off                                                                                                                                                                                                                       |

The icon module already supplies a broad SVG set; it does not need replacing.
The browser preference identifier for Placement remains unchanged deliberately.
Native nested details and title-row disclosures have different responsibilities;
neither needs replacing merely to make their implementation identical.

## Vocabulary

This is the source of terminology for visible UI text, help, accessible names,
test selectors and current-behavior guides. Internal identifiers, persisted fields
and technical paths stay unchanged; this glossary does not change the project schema.

Spelling is American English everywhere (#292): **Color**, analyze, canceled, center, gray,
in the UI, the code, saved fields and the guides.

- **Recording**: the complete original file, video or music. Use **video recording**
  or **music recording** when the distinction matters; never bare “video” for a file.
- **Clip**: an independently editable instance of a video recording on the timeline,
  and its Properties tab. Several clips can use the same recording. A **music clip** is a
  placement of a music recording on a music track.
- **Track**: a horizontal timeline container. Use **video track** or **music track**
  to distinguish them; **Track options** and **+ Track** use the same noun.
  A music track holds 1–8 music clips joined by transitions, with its own gain, fades and
  Ripple; it is not another audio clock. **Add music track** creates a track with one clip;
  **+ Clip** adds a clip; **Recording** changes the selected clip's recording; **Delete
  selected music clip** / **Delete selected music track** delete only that clip / track.
- **Clip grade**: a clip's own Color, edited on the Color tab's **Clip** target. It travels
  with the clip through trims, moves, splits and duplicates; its keyframes use the recording's
  source frames. Say clip grade, never clip color or correction.
- **Adjustment**: one grade for every video track over a range of the film, after each clip's
  grade, edited on the Color tab's **Adjustment** target. It is named by its timecode range,
  such as **Adjustment 01:12:05 – 01:20:00**, OUT exclusive; its keyframes count frames from its
  start. It is not a clip or a track and never follows clip edits. Adjustments sit on the
  **adjustment track** (header **Adjustments · N**, the number of adjustments), pinned under the time ruler, where a
  click selects one for the Color tab, dragging moves or trims it, dragging across an empty stretch
  draws a new one and its header's **Add adjustment** covers the ruler range or the selected clip.
- **Keyframe**: a stored animation value at a frame. Clip grade and adjustment keyframes contain
  **enabled settings**; track Transform keyframes are separate and use project frames;
  clip grade and clip speed keyframes use original-source frames.
  Use the full word in labels and help. Static color curves instead have **control nodes**,
  not animation keyframes. Technical math, internal identifiers and persisted fields
  may retain precise terms such as anchor, participant and `interpolation`; do not
  use them as user-facing synonyms for keyframe, enabled setting or Easing.
- **Range**: the selected IN/OUT portion of a recording, whether reviewed or used by
  a clip. Qualify its context when necessary, without introducing another object name.
  Do not use rush, excerpt, row, layer, point or participant as object synonyms.
- **Kept range**: a range of a video recording the user keeps for the project (the project's `selects`), shown in Source preview as its applied range; a recording keeps several. Not a clip, keyframe or bookmark; clips may still use other frames.
- **Bookmark**: a project-wide timeline frame marked as a snap point; not a keyframe,
  range or export chapter.
- **Source IN / OUT**: original-frame boundaries; OUT is exclusive. **Timeline
  frame**: absolute project position. **Duration** and **fades** use output frames.
- **Opacity**, **Speed**, **Color** and **Ripple** retain their established names.
  Opacity is the ninth Transform setting, coverage, not a grading operation. Main and
  stored sliders/exact fields use 0–100%, neutral 100%; Transform storage stays 0–1.
- **Reverse** is a clip's playback direction (Clip → Speed checkbox), never a negative
  speed. Edits name the result as displayed: **Trim start** of a reversed clip trims
  its source OUT.
- **Temperature / Tint** are normalized scalar Color settings of clip grades and adjustments (Temperature −2…2, Tint −1…1),
  neutral 0: positive Temperature warms, positive Tint adds magenta. They precede
  Exposure and are independently animatable, with the standard
  slider/exact-field/reset pattern, capture diamonds,
  adjacent per-setting Previous/Next buttons, section navigation and stored-setting
  chip arrows. No Kelvin label.
- **Auto white balance** is the secondary button under Tint in a **clip grade** (adjustments have none): it keyframes the grade's Temperature and Tint at the source frame shown at the playhead, from the light of a few frames around it, like their diamonds, in one Undo step. Unavailable with its reason (`aria-disabled` and tooltip) with the playhead off the clip or its recording unprepared;
  **Analyzing n/16…** with a **Cancel** icon (or Escape) appears only after 250 ms; failures stay inline.
  See [automatic white balance](TEMPERATURE_AND_TINT.md#automatic-white-balance).
- **Auto adjust** is the **Auto** text button (wand icon) ending the Color keyframe line of a **clip grade** (adjustments have none); on its own row at the right when the line is narrower than 280 px. It opens a popover with a **Source** choice, **Playhead** (1 s around it), **This clip** (all of it) or **Every clip on** the track (each analyzed on its own), and an **Apply as** choice, **Grade values** (whole clip, or each clip's grade) or **Keyframe** (at playhead; Playhead source only, **needs Playhead** or **this clip only** otherwise; initial with Playhead once the grade animates a setting Auto sets), that analyzes the selected clip, or each clip of its track (**Analyzing n/N frames…**, **Cancel**), then offers **Intensity** (0–100%, initially 80%, the correction as suggested; above it exaggerates), lists each animated setting the grade values leave unchanged (and, for every clip, how many clips keep some) and commits with **Apply** (**Apply to N clips** for every clip), one Undo step: one Color edit per analyzed clip's grade, or the eleven settings keyed at the playhead's source frame like their diamonds.
  The preview shows the result while the popover is open; Cancel, Escape or a click outside restore it.
  Unavailable with its reason like Auto white balance. See [Auto adjust](AUTO_ADJUST.md).
- **Vibrance** is a −1…2 scalar Color setting, neutral 0, last in the **Color**
  group after Saturation: it scales saturation more for muted colors than strong ones
  (grays and fully saturated colors stay unchanged); a plain slider track, no gradient.
- **Whites** is a −1…1 scalar Color setting, neutral 0, after Shadows in the **Light**
  group: it moves the white point (lower dims the brightest tones, higher pushes them to white).
- **Blacks** is a −1…1 scalar Color setting, neutral 0, last in the **Light**
  group: it moves the black point (lower crushes the darkest tones to black, higher lifts
  black for a faded, matte look).
- **HDR** is a 0–1 Color setting, neutral 0: an SDR local tone-mapping
  look, not HDR output. It is keyframable like the other Color settings and runs
  on source taps before the grades, with the clip detail filters.
- **Local contrast** is a −1…1 Color setting, neutral 0, below HDR in the
  **Effects** group: the local-detail boost split out of HDR, without its tone compression
  (raised it separates each area from its surroundings, lowered it flattens them). It is
  keyframable like the other Color settings and runs with HDR in the detail kernel.
- **Transform** is track-owned crop, Scale, Translate X/Y, Rotation and Opacity, applied to every
  clip on the track; each setting has its own capture triangle, and its
  keyframes are separate from Color keyframes
  ([#131](SPATIAL_TRANSFORMS.md#decision-131)).
- **Default keyframe**: a Color keyframe that returns every Color setting of its clip grade or
  adjustment (or, for a Transform default keyframe, every Transform setting, Opacity included) to
  its default from its frame,
  holding until each setting's next keyframe, without changing earlier frames. Toggle
  **Add default keyframe** in the Color keyframe line, or **Add default Transform keyframe**
  in Transform's; filled marker and **Default** badge with the diamond-and-return-arrow icon.
- **Keyframe line**: the first row of an expanded Color, Speed or Transform section: **N keyframes**, one
  **Previous/Next** pair over the same set and **Reset**; Color's also holds its default keyframe toggle and, for a clip grade, **Auto**. It is hidden while the section is collapsed.
  There is no Animate toggle or stored preference; capture diamonds and per-setting arrows are always visible
  (Speed, a single setting, relies on its keyframe-line pair).
- **Easing**: the visible label for clip grade, adjustment, Transform and custom clip-speed
  keyframe selectors. Contextual accessible names remain, including
  **Clip keyframe easing N**. Each enabled setting of a Color or Transform keyframe has its
  own Easing: the keyframe's select sets them all and reads **Mixed** when they differ;
  **Per setting** reveals one compact select per setting (**<Setting> easing at clip keyframe N**,
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
  native stepper/↑↓ step applies at once and shows that edge; Escape restores. A reset icon after OUT,
  **Reset source range**, restores IN = 0 and OUT = frame count (dimmed with its reason at the whole
  recording). See [TIMELINE_EDITING.md](../TIMELINE_EDITING.md).
- Other frames/durations/fades: native numeric stepper, explicit frame units and existing
  timecode feedback. No clamping, rounding or hidden timing repair.
- Easing/modes/recordings: native select; selected easing has its existing graph.
- Boolean settings: native checkbox. Main scalar Color controls expose a capture diamond with
  `aria-pressed` and adjacent per-setting **Previous/Next** buttons, since a
  keyframe need not enable every setting. Color's keyframe-line Previous/Next pair visits every keyframe of the clip grade or adjustment it edits.
  Clip **Speed ×** has one **Keyframe Speed** circle capturing or removing a keyframe at the
  actually displayed source frame, without extra per-setting arrows; in curve mode its rate is
  read-only without a keyframe there. Speed's pair visits all retained
  custom speed source keyframes of the selected clip, including off-trim keyframes
  and original exclusive OUT, previewing the nearest mapped image through
  authoritative retiming.
  Transform's pair visits all track Transform keyframes, including those after the
  duration, with its own track-local cursor; Speed keeps a clip-local
  stored-source cursor; successive stored
  keyframes remain reachable even when their first/last preview image is the same.
  Color keeps no such cursor.
  Main capture always uses the real displayed project/source frame,
  never the inspected stored time. Enabled setting chips in stored Color keyframe rows
  retain their per-channel native arrows. All main and stored per-channel arrows
  visit strictly earlier/later keyframes where that channel is nonnull (zero is
  enabled): main arrows from the playhead, chip arrows from their row. A read-only animated main value is visibly locked without hover: dimmed slider and
  field plus a lock cue (**Add a keyframe ◇ to edit**) at the right of the setting's name. Interacting with it never creates a keyframe or edit.
  Every slider setting (Color, HSL, Transform with Opacity, Detail, Speed rates, stored keyframe values, music gain) has a compact
  **Reset** icon button beside its name, labeled **Reset <setting>**: it restores only that setting's neutral value in one Undo step, is
  dimmed with an explanatory tooltip and `aria-disabled` at its default or when the value is read-only/locked, and adds no row or
  width. Double-clicking the name does the same; sections keep one Reset in their keyframe line (Color, Speed, Transform) and HSL/curves name theirs
  **Reset red** / **Reset all**.
- Setting groups: the **Color** section shows its main sliders in three static fieldsets with small uppercase
  headings: **Color** (Temperature, Tint, Hue, Saturation, Vibrance); **Light** (Exposure, Brightness,
  Contrast, Highlights, Shadows, Whites, Blacks); **Effects** (HDR, Local contrast). Each heading has a Reset icon (**Reset the Light group**,
  etc.) that resets the group's editable settings in one Undo step, dimmed at the defaults. Headings add no
  tab stop besides that icon; the visible order differs from the unchanged storage/keyframe channel order.
- Setting rows (Color, Transform, Speed, Detail and stored keyframe values) use two compact lines:
  the name with its Reset icon (and any lock cue at the right), then the slider, exact field, capture diamond
  and per-setting Previous/Next on one line, shown as three equal buttons ‹ ◇ ›. Tab order stays diamond, Previous,
  Next, slider, field. Inside the exact field the unit follows the value and the native stepper sits at the right.
- Colored slider tracks show a setting's direction: **Temperature** runs blue → yellow, **Tint** green → magenta
  (its positive side), **Saturation** gray → red, **Hue** around the full color wheel and Transform's **Opacity** from a
  checkerboard to solid, in main and stored keyframe editors. **HSL ranges** sliders follow the selected range's
  own color: Hue from 30° below to 30° above its center, Saturation gray → that color, Lightness dark → that
  color → light. Other sliders keep the plain track. The gradient is presentational and dims with a locked or
  disabled slider.
- Color swatches: **HSL range** and **Color curve channel** are rows of colored square buttons in a radio
  group (accessible name of the range/channel, tooltip such as **Cyan range**), not dropdowns. The selected
  swatch has a white ring; focus adds the usual outline; arrows, Home and End move the selection without
  reaching timeline shortcuts. HSL swatches use each range's center hue, as its slider tracks do. Color
  curves draw all four curves on one graph, only the selected channel with nodes and edits.
- Tabs: native buttons with one selected appearance and existing arrow/Home/End
  behavior. Disclosures keep mounted drafts; options use the existing Popover.
- Buttons: primary for the main confirmed action, secondary for supporting actions,
  icon-button for familiar compact actions, text-button for contextual alternatives.
  Icon-only actions always retain an accessible name and tooltip.
- Icons: plus adds, folder browses, trash deletes, × closes, reset restores a value,
  eye toggles visibility, arrows navigate/stack, play/pause controls playback.

## Placement

Keep Media for recording discovery/import; the center's Timeline/Source preview
tabs for viewing; Clip for speed/Detail/source range/placement; Color for the grade of the selected clip
or adjustment, with HSL ranges and Color curves (Color ending with its stored
keyframe list); Track for Transform with Opacity, transitions and fades (Transform ending with its stored keyframe
list); Audio for music. Track options owns
rename, Ripple, stacking and deletion. No tab relocation is justified by the audit.
Keep frequent split/trim/delete/cut actions directly in Timeline, not in another
toolbar. Detailed controls and diagnostics remain contextual/collapsible.

Transform is the first Track section, before Transitions, collapsed by default and included
in Expand all/Collapse all. It works like the Color section, including on an empty track.
**Transform animation** heading help remains reachable
while collapsed. **Crop left/right/top/bottom / Scale / Translate X/Y / Rotation ° / Opacity**
pair native sliders with exact fields and live slider preview; Opacity reads 0–100% (accessible
name **Transform Opacity**). Main values edit the base for an unkeyed setting,
or that setting's key at the playhead; a keyed setting without a key
there stays read-only until its own blue triangle (hollow ▽ / filled ▼, as on the timeline marker, never the Color diamond) captures it.
Every setting has its own triangle and **Previous/Next** buttons like Color, plus the single **Previous/Next** pair in the keyframe line,
which also holds **Reset transform** and **Add default Transform keyframe**. Below the settings, a
**Keyframes** list, the same shared list as Color's, shows one row per Transform keyframe: a click anywhere
on a row (or its **Go to Transform keyframe N** timecode) seeks the nearest available frame and marks the row
current, its setting chips carry Previous/Next arrows, and each row's **Edit** (closed initially) holds
**Timeline frame / Easing** and its enabled-setting fields.
A row's trash removes that keyframe, revealing the saved
base of settings left unkeyed; **Reset transform** behaves like Color's Reset (neutral base, Opacity 100%,
without keyframes, else the enabled settings of the key at the playhead). There is no graph/canvas gizmo. Exact
invalid drafts and sliders follow the common validation/cancellation
pattern. See [SPATIAL_TRANSFORMS.md](SPATIAL_TRANSFORMS.md).

Inside each timeline clip rectangle, one lane below the label holds boxed salmon
**●** custom-speed buttons at authoritative retimed output positions and boxed amber **◆**
clip grade buttons where the clip shows their source frame.
Off-trim keyframes are omitted; exclusive OUT has a boundary marker that seeks the
final available frame. Click, Enter or Space selects the clip, seeks its nearest
mapped image and opens Clip → Speed, or the Color tab's Clip target for a grade keyframe; a
click edits nothing. Both slide by drag or ←/→ (one source frame, Shift ten): previewed, one Undo step on a valid release, restored by Escape or an occupied frame; moving a speed key retimes its clip,
and Delete removes a focused grade key.
Marker keyboard handling is isolated from timeline shortcuts.

Track Transform keyframes are boxed blue **▼** buttons overlapping the top edge of
their track row at project frames (a default keyframe is filled light blue with the
default-keyframe icon); the label of an
animated track's clips sits below them. Click or Enter selects the track, seeks and opens
Track → Transform; they slide by drag or ←/→ (one project frame, Shift ten), and Delete removes
a focused one.

Audio keeps **Music track / Add music track / Import music / Delete selected music track**,
then the selected track's **Gain dB** and **Ripple**, its **Clip** selector with **Delete
selected music clip** and **+ Clip** (**Add music clip**), the clip's **Recording**, and
**Placement & fades** (the clip's range and placement, the track's fades), with native
selects/buttons and contextual disabled reasons (no ready source, eight-track or
eight-clip limit, a track's last clip or active draft). A track with several clips ends
with **Transitions**: one native **Cut / Crossfade / Fade through silence / Fade through silence with pause** select per boundary, with its duration, or its **Fade** and **Pause** frames (the pause is a dark dashed slot in the music lane, its boundary button reads **Pause**); the boundary button between music clips on the timeline
selects the clip before it and focuses that select.
Imports populate the bin/prepare media without implicit placement. Selection is
editor-only; selected-track and selected-clip edits/removal leave the others unchanged.
Each track and clip retains independent drafts; hiding/selecting cannot apply one to another.
One Undo step per accepted commit/gesture, atomic invalid/canceled operations and
the common gain-slider/exact-number contract remain authoritative.

Music can extend duration: video closing fades remain at clip OUT, followed by
black while music continues/fades at its own OUT. Controls must not imply
video-only duration or a held final image. No mute/solo, normalization, ducking,
effect or source-video-audio control is introduced. See
[MULTIPLE_MUSIC.md](MULTIPLE_MUSIC.md) for the strict processing/resource contract.
This catalog specifies controls, not completed live-browser or test acceptance.
