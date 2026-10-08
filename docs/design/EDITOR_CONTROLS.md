# Editor control catalogue

## Scope and decisions

Controls use native elements, the existing editor layout and strict project
schema 12, including complete row Colour, clip spatial settings and 0–8 independent music instances. No UI framework or icon dependency is introduced. Exact
timing fields stay numeric: replacing them with a duration-dependent slider would
conceal precision and encourage accidental changes.

### Current control inventory

| Area                               | Control                                                                                            | Contract                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Colour / Opacity                   | Native slider and exact field in main/stored editors                                               | One slider with an editable exact value in both contexts                                     |
| Speed                              | Constant, ramp, custom-point and layer rates                                                       | Bounded slider/exact-value pattern; retain presets and curve graph                           |
| Transform                          | Eight clip pose sliders/exact fields, one full-pose diamond, stored source-key selector/navigation | Explicit source-frame capture; retain off-trim keys and distinguish stored time from preview |
| Audio                              | Music track / Recording selects, Add music track, selected-instance trash and gain slider          | Independent identified instances; exact gain draft; import never implicitly places           |
| Source, placement, duration, fades | Integer timing needs exact entry and contextual validation                                         | Retain native numeric steppers and timecode feedback, not arbitrary slider limits            |
| Slider gestures                    | Transient local pointer draft                                                                      | One validated edit on release; cancellation restores; keyboard edits stay individual         |
| Keyframe / music deletion          | Trash action with accessible name                                                                  | Delete the identified point/instance; × only closes/dismisses                                |
| Inspector / viewer tabs            | Consistent native-button appearance                                                                | Retain existing keyboard navigation and mounted drafts                                       |
| Keyframes                          | Tab owns its title; toolbar owns navigation/help                                                   | Keep its accessible name; no repeated visible toolbar title                                  |
| Import actions                     | Folder/plus icons with explanatory text                                                            | Deliberate import; no implicit music placement                                               |
| Layer options / Timeline           | Visibility, Ripple, stacking and frequent clip actions already have native controls/icons          | Keep their locations; no invented lock action                                                |
| Help / disclosures / options       | Question-mark help and top-layer options are already consistent                                    | Keep those components and browser preferences                                                |

The icon module already supplies a broad SVG set; it does not need replacing.
The browser preference identifier for Placement remains unchanged deliberately.
Native nested details and title-row disclosures have different responsibilities;
neither needs replacing merely to make their implementation identical.

## Vocabulary

- **Layer**: a video composition/editing container. **Row** describes its timeline
  position, not another object or ownership mode. **Track** remains the ordinary
  audio term; guides may explain the equivalence for video.
- **Music track**: an independently identified music instance, not a recording or
  another audio clock. **Recording** identifies its registered source; several
  instances may reuse it. **Add music track** lists ready music files and creates
  a fresh instance; **Recording** only changes the selected instance; the trash
  action **Delete selected music track** removes only that placement.
- **Clip**: the timeline instance and its Inspector tab. **Excerpt**: a selected
  original-source range being reviewed/added. A recording is the complete original.
- **Keyframe**: a stored animation point. **Participant**: one setting enabled at
  that point. **Keys** is concise help prose, not a different editor/control.
- **Source IN / OUT**: original-frame boundaries; OUT is exclusive. **Timeline
  frame**: absolute project position. **Duration** and **fades** use output frames.
- **Opacity**, **Speed**, **Colour** and **Ripple** retain their established names.
  Opacity is row-owned coverage, not an additional grading operation.
- **Temperature / Tint** are row-owned normalized −1…1 scalar Colour controls,
  neutral 0: positive Temperature warms, positive Tint adds magenta. They precede
  Exposure, are independently keyable and work on empty rows, with the standard
  slider/exact-field/reset/diamond/navigation pattern. No Kelvin or AWB label.
- **Transform** is clip-owned crop, Scale, Translate X/Y and Rotation; its single
  diamond captures the full eight-value source-frame pose, not a row participant.

## Control patterns

- Bounded appearance values, playback rates and gain: native slider plus exact
  numeric draft. A pointer gesture is one edit; Escape, cancellation and lost
  capture restore it. Keyboard range adjustments remain native and precise entry
  applies on Enter/blur. Invalid numeric drafts remain editable with inline errors.
- Frames/durations/fades: native numeric stepper, explicit frame units and existing
  timecode feedback. No clamping, rounding or hidden timing repair.
- Easing/modes/recordings: native select; selected easing has its existing graph.
- Boolean settings: native checkbox. Shared row keyframe participation: diamond with
  `aria-pressed`, followed by Previous/Next. Double-clicking a setting's name resets
  only that setting; sections keep one Reset in their header (Colour, Speed,
  Transform) and HSL/curves name theirs **Reset red** / **Reset all**.
- Tabs: native buttons with one selected appearance and existing arrow/Home/End
  behavior. Disclosures keep mounted drafts; options use the existing Popover.
- Buttons: primary for the main confirmed action, secondary for supporting actions,
  icon-button for familiar compact actions, text-button for contextual alternatives.
  Icon-only actions always retain an accessible name and tooltip.
- Icons: plus adds, folder browses, trash deletes, × closes, reset restores a value,
  eye toggles visibility, arrows navigate/stack, play/pause controls playback.

## Placement

Keep Media for recording discovery/import; the centre's Timeline/Source preview
tabs for viewing; Clip for source/placement/speed/Transform/colour; Keyframes for shared
animation; Sequence for transitions/fades; Audio for music. Layer options owns
rename, Ripple, stacking and deletion. No tab relocation is justified by the audit.
Keep frequent split/trim/delete/cut actions directly in Timeline, not in another
toolbar. Detailed controls and diagnostics remain contextual/collapsible.

Transform is Clip's fourth section, collapsed by default and included
in Expand all/Collapse all. **Transform animation** heading help remains reachable
while collapsed. **Crop left/right/top/bottom / Scale / Translate X/Y / Rotation °**
pair native sliders with exact fields. Main values edit the base without keys,
or an existing full-pose key at the real displayed source frame; animated values
without that key stay read-only until diamond capture. Stored **Source frame /
To next point** and pose fields target the selected key; **Previous/Next**, the
selector and **Preview stored key** seek the closest mapped image, with separate
stored/actual source labels. Trash removes one full-pose key, revealing the saved
base after the last deletion; **Reset transform** clears all keys and restores
the neutral base. There is no graph/canvas gizmo or per-property diamond. Exact
invalid drafts and release-only sliders follow the common validation/cancellation
pattern. See [SPATIAL_TRANSFORMS.md](SPATIAL_TRANSFORMS.md).

Audio keeps **Music track / Recording / Add music track / Delete selected music
track** with native selects/buttons, contextual disabled reasons (no ready source,
eight-instance limit or active draft) and existing **Placement & fades** fields.
Imports populate the bin/prepare media without implicit placement. Selection is
editor-only; selected-instance edits/removal leave the others unchanged. Each
instance retains independent drafts; hiding/selecting cannot apply one to another.
One Undo step per accepted commit/gesture, atomic invalid/cancelled operations and
the common gain-slider/exact-number contract remain authoritative.

Music can extend duration: video closing fades remain at clip OUT, followed by
black while music continues/fades at its own OUT. Controls must not imply
video-only duration or a held final image. No mute/solo, normalisation, ducking,
effect or source-video-audio control is introduced. See
[MULTIPLE_MUSIC.md](MULTIPLE_MUSIC.md) for the strict processing/resource contract.
This catalogue specifies controls, not completed live-browser or test acceptance.
