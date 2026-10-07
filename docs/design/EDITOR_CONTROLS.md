# Editor control catalogue

## Scope and decisions

The v0.4 consistency pass keeps native controls, the existing editor layout and
strict project schema. No UI framework or icon dependency is introduced. Exact
timing fields stay numeric: replacing them with a duration-dependent slider would
conceal precision and encourage accidental changes.

### Inventory before implementation

| Area                               | Finding                                                                                   | Selected change                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Colour / Opacity                   | Main sliders have read-only outputs; stored keys have exact fields                        | One slider with an editable exact value in both contexts                            |
| Speed                              | Constant, ramp and layer rates use separate number-only layouts                           | Reuse the bounded slider/exact-value pattern; retain presets and curve graph        |
| Audio                              | Gain is number-only                                                                       | Bounded gain slider plus the same precise numeric draft                             |
| Source, placement, duration, fades | Integer timing needs exact entry and contextual validation                                | Retain native numeric steppers and timecode feedback, not arbitrary slider limits   |
| Slider gestures                    | Each range input event currently publishes an edit                                        | Capture-relative local drafts; one validated edit on release, cancellation restores |
| Keyframe deletion                  | Some delete actions use ×, others a trash icon                                            | Trash for deletion; × only closes/dismisses                                         |
| Inspector / viewer tabs            | Different padding, borders and selected appearance                                        | One scoped tab appearance, retaining existing keyboard navigation                   |
| Keyframes                          | Visible toolbar title repeats its owning tab                                              | Keep its accessible name; omit the repeated visible title                           |
| Import actions                     | Some browse/import actions are text-only                                                  | Reuse folder/plus icons with text where the action needs clarification              |
| Layer options / Timeline           | Visibility, Ripple, stacking and frequent clip actions already have native controls/icons | Keep their locations; no invented lock action                                       |
| Help / disclosures / options       | Question-mark help and top-layer options are already consistent                           | Keep those components and browser preferences                                       |

The icon module already supplies a broad SVG set; it does not need replacing.
The browser preference identifier for Placement remains unchanged deliberately.
Native nested details and title-row disclosures have different responsibilities;
neither needs replacing merely to make their implementation identical.

## Vocabulary

- **Layer**: a video composition/editing container. **Row** describes its timeline
  position, not another object or ownership mode. **Track** remains the ordinary
  audio term; guides may explain the equivalence for video.
- **Clip**: the timeline instance and its Inspector tab. **Excerpt**: a selected
  original-source range being reviewed/added. A recording is the complete original.
- **Keyframe**: a stored animation point. **Participant**: one setting enabled at
  that point. **Keys** is concise help prose, not a different editor/control.
- **Source IN / OUT**: original-frame boundaries; OUT is exclusive. **Timeline
  frame**: absolute project position. **Duration** and **fades** use output frames.
- **Opacity**, **Speed**, **Colour** and **Ripple** retain their established names.
  Opacity is row-owned coverage, not an additional grading operation.

## Control patterns

- Bounded appearance values, playback rates and gain: native slider plus exact
  numeric draft. A pointer gesture is one edit; Escape, cancellation and lost
  capture restore it. Keyboard range adjustments remain native and precise entry
  applies on Enter/blur. Invalid numeric drafts remain editable with inline errors.
- Frames/durations/fades: native numeric stepper, explicit frame units and existing
  timecode feedback. No clamping, rounding or hidden timing repair.
- Easing/modes/recordings: native select; selected easing has its existing graph.
- Boolean settings: native checkbox. Keyframe participation: diamond with
  `aria-pressed`, followed by Previous/Next and the individual reset.
- Tabs: native buttons with one selected appearance and existing arrow/Home/End
  behavior. Disclosures keep mounted drafts; options use the existing Popover.
- Buttons: primary for the main confirmed action, secondary for supporting actions,
  icon-button for familiar compact actions, text-button for contextual alternatives.
  Icon-only actions always retain an accessible name and tooltip.
- Icons: plus adds, folder browses, trash deletes, × closes, reset restores a value,
  eye toggles visibility, arrows navigate/stack, play/pause controls playback.

## Placement

Keep Media for recording discovery/import; the centre's Timeline/Source preview
tabs for viewing; Clip for source/placement/speed/colour; Keyframes for shared
animation; Sequence for transitions/fades; Audio for music. Layer options owns
rename, Ripple, stacking and deletion. No tab relocation is justified by the audit.
Keep frequent split/trim/delete/cut actions directly in Timeline, not in another
toolbar. Detailed controls and diagnostics remain contextual/collapsible.
