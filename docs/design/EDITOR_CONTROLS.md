# Editor control catalogue

## Scope and decisions

Controls use native elements, the existing editor layout and strict project
schema 13, including complete track Colour, clip-only speed, clip spatial settings and 0–8 independent music tracks. No UI framework or icon dependency is introduced. Exact
timing entry is retained: Clip Range uses timecode text fields and a
full-original range bar; other frame/duration/fade fields retain numeric steppers.

### Current control inventory

| Area                          | Control                                                                                                                             | Contract                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Colour / Opacity              | Native slider and exact field in main/stored editors                                                                                | Opacity UI 0–100%, neutral 100%; stored track/keyframe values remain 0–1                                                             |
| Speed                         | Clip constant rate or 1–256 source-frame keyframes; Keyframe Speed diamond                                                          | Bounded slider/exact-value pattern; retain presets and curve graph                                                                   |
| Transform                     | Eight clip pose sliders/exact fields, each with its own blue triangle and Previous/Next, stored source-keyframe selector/navigation | Explicit per-setting source-frame capture; retain off-trim keyframes and distinguish stored time from preview                        |
| Audio                         | Music track / Recording selects, Add music track, selected-track trash and gain slider                                              | Independent identified tracks; exact gain draft; import never implicitly places                                                      |
| Clip Range                    | One full-original hatched range bar with draggable IN/OUT; exact text fields below its ends                                         | Display 30 fps NDF timecode; accept whole original frames or timecode                                                                |
| Other frames, duration, fades | Integer timing needs exact entry and contextual validation                                                                          | Retain native numeric steppers and timecode feedback, not arbitrary slider limits                                                    |
| Slider gestures               | Transient local pointer draft; Colour/Opacity/HSL also preview it in the image                                                      | One validated edit on release; cancellation restores control and preview; keyboard edits stay individual                             |
| Keyframe / music deletion     | Trash action with accessible name                                                                                                   | Delete the identified keyframe/track; × only closes/dismisses                                                                        |
| Inspector / viewer tabs       | Consistent native-button appearance                                                                                                 | Retain existing keyboard navigation and mounted drafts                                                                               |
| Keyframes                     | Tab owns its title; toolbar owns navigation/help                                                                                    | Keep its accessible name; no repeated visible toolbar title                                                                          |
| Import actions                | Folder/plus icons with explanatory text                                                                                             | Deliberate import; no implicit music placement                                                                                       |
| Track options / Timeline      | Visibility, Ripple, stacking and frequent clip actions already have native controls/icons                                           | Keep their locations; Duplicate and **Move to new track** are in the clip context menu; zoom has slider, Fit and Zoom out/in buttons |
| Help / disclosures / options  | Question-mark help and top-layer options are already consistent                                                                     | Keep those components and browser preferences                                                                                        |

The icon module already supplies a broad SVG set; it does not need replacing.
The browser preference identifier for Placement remains unchanged deliberately.
Native nested details and title-row disclosures have different responsibilities;
neither needs replacing merely to make their implementation identical.

## Vocabulary

This is the source of terminology for visible UI text, help, accessible names,
test selectors and current-behaviour guides. Internal identifiers, persisted fields
and technical paths stay unchanged; this glossary does not change schema 13.

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
  **enabled settings**; clip speed and Transform keyframes use original-source frames.
  Use the full word in labels and help. Static colour curves instead have **control nodes**,
  not animation keyframes. Technical math, internal identifiers and persisted fields
  may retain precise terms such as anchor, participant and `interpolation`; do not
  use them as user-facing synonyms for keyframe, enabled setting or Easing.
- **Range**: the selected IN/OUT portion of a recording, whether reviewed or used by
  a clip. Qualify its context when necessary, without introducing another object name.
  Do not use rush, excerpt, row, layer, point or participant as object synonyms.
- **Source IN / OUT**: original-frame boundaries; OUT is exclusive. **Timeline
  frame**: absolute project position. **Duration** and **fades** use output frames.
- **Opacity**, **Speed**, **Colour** and **Ripple** retain their established names.
  Opacity is track-owned coverage, not an additional grading operation. Main and
  stored sliders/exact fields use 0–100%, neutral 100%; track/keyframe storage stays 0–1.
- **Temperature / Tint** are track-owned normalized −1…1 scalar Colour controls,
  neutral 0: positive Temperature warms, positive Tint adds magenta. They precede
  Exposure, are independently animatable and work on empty tracks, with the standard
  slider/exact-field/reset pattern, capture diamonds,
  adjacent per-setting Previous/Next buttons, section navigation and stored-setting
  chip arrows. No Kelvin or AWB label.
- **Transform** is clip-owned crop, Scale, Translate X/Y and Rotation; its single
  diamond captures the full eight-value source-frame pose, not an enabled track setting.
- **Keyframe line**: the first row of an expanded Colour, Speed or Transform section: **N keyframes**, one
  **Previous/Next** pair over the same set and **Reset**. It is hidden while the section is collapsed.
  There is no Animate toggle or stored preference; capture diamonds and per-setting arrows are always visible
  (Speed, a single setting, relies on its keyframe-line pair).
- **Easing**: the visible label for track-keyframe, Transform and custom clip-speed
  selectors. Contextual accessible names remain, including
  **Track keyframe easing N**; interpolation is unchanged.

## Control patterns

- Bounded appearance values, playback rates and gain: native slider plus exact
  numeric draft. A pointer gesture is one edit; Escape, cancellation and lost
  capture restore it. Keyboard range adjustments remain native and precise entry
  applies on Enter/blur. Invalid numeric drafts remain editable with inline errors.
- Clip Range: exact **Source IN / OUT** text fields display **HH:MM:SS:FF**
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
  validated pair on Enter or when focus leaves both fields (not between them);
  Escape restores. See [TIMELINE_EDITING.md](../TIMELINE_EDITING.md).
- Other frames/durations/fades: native numeric stepper, explicit frame units and existing
  timecode feedback. No clamping, rounding or hidden timing repair.
- Easing/modes/recordings: native select; selected easing has its existing graph.
- Boolean settings: native checkbox. Main scalar Colour/Opacity controls expose a capture diamond with
  `aria-pressed` and adjacent per-setting **Previous/Next** buttons, since a shared
  keyframe need not enable every setting. Colour's keyframe-line Previous/Next pair visits the union of Opacity and nine scalar keyframes.
  Clip **Speed ×** has one **Keyframe Speed** diamond capturing or removing a keyframe at the
  actually displayed source frame, without extra per-setting arrows; in curve mode its rate is
  read-only without a keyframe there. Speed's pair visits all retained
  custom speed source keyframes of the selected clip, including off-trim keyframes
  and original exclusive OUT, previewing the nearest mapped image through
  authoritative retiming.
  Transform's pair likewise visits all retained source keyframes,
  including off-trim/original OUT. Speed and Transform each keep a clip-local
  stored-source cursor independent of central track inspection; successive stored
  keyframes remain reachable even when their first/last preview image is the same.
  Main capture always uses the real displayed project/source frame,
  never the inspected stored time. Enabled setting chips in stored Keyframes rows
  retain their per-channel native arrows. All main and stored per-channel arrows
  visit strictly earlier/later keyframes where that channel is nonnull (zero is
  enabled), sharing the central off-duration inspection cursor with section
  navigation to track keyframes and track/list navigation. A read-only animated main value is visibly locked without hover: dimmed slider and
  field plus a lock cue (**Add a keyframe ◇ to edit**). Interacting with it never creates a keyframe or edit.
  Double-clicking a setting's name resets only that setting; sections keep one Reset in their keyframe line (Colour, Speed, Transform) and HSL/curves name theirs
  **Reset red** / **Reset all**.
- Tabs: native buttons with one selected appearance and existing arrow/Home/End
  behavior. Disclosures keep mounted drafts; options use the existing Popover.
- Buttons: primary for the main confirmed action, secondary for supporting actions,
  icon-button for familiar compact actions, text-button for contextual alternatives.
  Icon-only actions always retain an accessible name and tooltip.
- Icons: plus adds, folder browses, trash deletes, × closes, reset restores a value,
  eye toggles visibility, arrows navigate/stack, play/pause controls playback.

## Placement

Keep Media for recording discovery/import; the centre's Timeline/Source preview
tabs for viewing; Clip for speed/Transform/source range/placement; Track for Colour,
Opacity, shared Keyframes, transitions and fades; Audio for music. Track options owns
rename, Ripple, stacking and deletion. No tab relocation is justified by the audit.
Keep frequent split/trim/delete/cut actions directly in Timeline, not in another
toolbar. Detailed controls and diagnostics remain contextual/collapsible.

Transform is Clip's second section (after Speed, before Range and Placement), collapsed by default and included
in Expand all/Collapse all. **Transform animation** heading help remains reachable
while collapsed. **Crop left/right/top/bottom / Scale / Translate X/Y / Rotation °**
pair native sliders with exact fields. Main values edit the base for an unkeyed setting,
or that setting's key at the real displayed source frame; a keyed setting without a key
there stays read-only until its own blue triangle (hollow ▽ / filled ▼, as on the timeline marker, never the Colour diamond) captures it.
Every setting has its own triangle and **Previous/Next** buttons like Colour, plus the single **Previous/Next** pair in the keyframe line. Stored **Source frame / Easing**
and the selected key's enabled-setting fields target the selected
keyframe; the selector and **Preview stored keyframe** seek the closest mapped image, with separate
stored/actual source labels. Trash removes one keyframe, revealing the saved
base of settings left unkeyed; **Reset transform** clears all keyframes and restores
the neutral base. There is no graph/canvas gizmo. Exact
invalid drafts and release-only sliders follow the common validation/cancellation
pattern. See [SPATIAL_TRANSFORMS.md](SPATIAL_TRANSFORMS.md).

Inside each timeline clip rectangle, Transform keys are boxed blue **▼** buttons at the clip's top edge, the same size as the Colour markers that overlap the bottom edge by the same amount; the clip label sits below them and boxed salmon
**◆** custom-speed buttons, below the label and above the Colour markers, show source keyframes at authoritative retimed output positions.
Off-trim keyframes are omitted; exclusive OUT has a boundary marker that seeks the
final available frame. Click, Enter or Space selects the clip, seeks its nearest
mapped image and opens Clip → Transform (Clip → Speed for ◆); a click edits nothing. Transform and speed keys also slide by drag or ←/→ (one source frame, Shift ten): previewed, one Undo step on a valid release, restored by Escape or an occupied frame; moving a speed key retimes its clip.
Marker keyboard handling is isolated from timeline shortcuts. These are distinct
from draggable shared project-time track markers.

Audio keeps **Music track / Recording / Add music track / Delete selected music
track** with native selects/buttons, contextual disabled reasons (no ready source,
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
