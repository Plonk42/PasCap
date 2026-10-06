# PasCap — implementation plan

## 1. Mission

Build **PasCap**, a **local, single-user video editor for Linux**, inspired by familiar timeline editors but with an original interface.

### Project identity

- Product name: **PasCap**, a French wordplay chosen by the user. Preserve this exact spelling and capitalisation.
- Use **PasCap** in the interface, documentation and application title.
- Use `pascap` for the package name and technical identifiers where lowercase is required.
- This names the new project; do not rename or overwrite the existing Derusher project.

The primary workflow is:

1. Import a folder of DJI landscape footage.
2. Review recordings and select excerpts.
3. Arrange excerpts on a visual timeline.
4. Adjust colour independently for each excerpt.
5. Add black fades or cross-dissolves.
6. Add licensed music.
7. Preview the edit interactively.
8. Export a 5–10 minute, 4K SDR video suitable for YouTube.

**Start from a clean project. Do not copy the existing Derusher implementation or CapCut assets/source code.**

## 2. Scope

### Required for the first complete version

- Separate projects for separate flights.
- Local media library with thumbnails, metadata and proxies.
- One contiguous primary video track, with independently positioned overlay tracks (up to eight video layers in total).
- Layer visibility, stack order and opacity.
- Clip opacity, speed and colour-adjustment keyframes; project-time layer-opacity keyframes.
- Mouse-following source preview and recoverable IN/OUT selection from the media library before insertion.
- One music track.
- Timeline zoom, horizontal scrolling and playhead.
- Clip selection, insertion, deletion and reordering.
- Trim handles and split at playhead.
- Snapping to clip boundaries.
- Undo/redo.
- Per-clip colour controls.
- Per-clip constant speed, slow motion, acceleration and curved speed ramps.
- Collapsible sections in the selected Clip inspector, with remembered expansion state.
- Opening/closing black fades.
- Cut, fade-through-black and cross-dissolve transitions.
- Live proxy preview of colour and transitions.
- Autosave with visible save/error status.
- Native FFmpeg export from originals.
- Export progress and cancellation.

### Explicitly excluded

- Titles, subtitles and templates.
- Other animated effects, apart from the approved opacity, speed and colour-adjustment keyframes.
- Stabilisation.
- HDR processing.
- AI aesthetic ranking or automatic “best moments”.
- Cloud uploads, accounts or collaboration.
- Mobile editing.
- Desktop packaging until the browser version is proven.

## 3. Technology stack

| Responsibility           | Technology                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Frontend                 | React + TypeScript                                                                                                   |
| Frontend tooling         | Vite                                                                                                                 |
| Backend                  | Node.js LTS + TypeScript                                                                                             |
| API                      | Fastify, bound to loopback                                                                                           |
| Shared validation        | Zod                                                                                                                  |
| Preview compositor       | WebGL2                                                                                                               |
| Preview decoding         | Bounded reusable HTML video pool: two for one layer, up to nine for eight layers; one separate source-review decoder |
| Audio playback           | Web Audio                                                                                                            |
| Media preparation/export | Native FFmpeg and ffprobe                                                                                            |
| Unit tests               | Vitest                                                                                                               |
| Browser tests            | Playwright                                                                                                           |

Use strict TypeScript. Pin dependencies through a lockfile.

**Do not initially use:** FFmpeg WASM, Electron, WebCodecs, a database, or a generic video-editor framework.

React must not manage the per-frame rendering loop. Keep the preview engine independent of React.

## 4. Architecture

Use four independently testable layers:

### A. Shared project and timeline model

Responsible for:

- Project schema and validation.
- Frame-based timing.
- Transition constraints.
- Timeline layout calculations.
- Editing commands.
- Undo/redo.

It must not depend on React, browser APIs or FFmpeg.

### B. Browser editor

Responsible for:

- Media library.
- Timeline interactions.
- Selected-clip inspector.
- Transport controls.
- Save state and job status.

Use HTML/CSS and pointer events for the initial timeline. Canvas is not required for timeline interaction.

### C. Preview engine

Responsible for:

- Mapping timeline positions to source positions.
- Proxy loading, seeking and playback.
- GPU colour processing.
- Transition compositing.
- Audio synchronisation.
- Buffering and diagnostics.

### D. Local media service

Responsible for:

- Registering source files.
- Probing media.
- Generating thumbnails and proxies.
- Saving project documents.
- Serving registered media with HTTP byte ranges.
- Compiling export jobs.
- Running and cancelling FFmpeg.

## 5. Project model and timing contract

### Frame-based timing

Store all video timing in **integer project frames**, not floating-point seconds.

Represent frame rate as a rational pair. The initial profile should be **30000/1001 fps**, matching the supplied DJI recordings.

For the first version, accept compatible constant-frame-rate footage at the project rate. Reject unsupported or ambiguous timing with a clear message rather than silently normalising it.

### Project document

Define and validate:

- Schema version.
- Project ID and title.
- Rational frame rate.
- SDR colour profile.
- Ordered video layers, bottom-to-top, with visibility, opacity and project-frame opacity keys.
- Clip instances with layer membership; ordered primary clips and positioned overlays.
- Transitions between adjacent primary clips.
- Opening and closing fade durations.
- Optional music track.
- Saved document revision.

A video clip contains:

- Unique clip-instance ID.
- Registered media ID.
- Layer ID and absolute overlay start frame; primary starts are derived by ripple layout.
- Source IN frame.
- Source OUT frame, exclusive.
- Complete colour-settings object.
- Complete constant/ramp/keyframed speed settings.
- Clip opacity and source-frame opacity/colour keys.
- Optional user note.

A transition contains:

- Left and right clip-instance IDs.
- Type: cut, fade-through-black or cross-dissolve.
- Integer duration in frames.

The music track contains:

- Registered audio ID.
- Source IN frame.
- Source OUT frame, exclusive.
- Timeline start frame.
- Timeline duration in frames.
- Gain in decibels.
- Fade-in and fade-out durations.
- Explicit looping flag.

Keep editor-only state—selection, zoom, inspector expansion, media review IN/OUT
choices and temporary drag values—separate from the renderable document.

### Transition semantics

Make these rules explicit and use them in both preview and export:

- Boundary transitions and opening/closing fades belong to the primary track.
  Overlay fades use opacity keys; opening/closing fades do not dim an upper layer.
- **Cut:** no overlap and zero transition duration.
- **Fade-through-black:** consumes the end of the left clip and start of the right clip; does not change sequence duration. Divide its duration deterministically between fade-out and fade-in.
- **Cross-dissolve:** overlaps the selected tail/head of adjacent clips by the transition duration, reducing sequence duration by that amount.
- **Opening/closing fades:** occur inside the first/last clip, with no extra black hold.

Reject edits whose transition regions overlap incompatibly or exceed available clip duration. Do not silently clamp transition durations.

Use a single shared timeline-layout function to calculate clip starts, transition regions and total duration.

### Editing behaviour

Specify command semantics:

- Primary insert/delete/reorder use ripple behaviour: that track remains contiguous.
- Overlays have independent non-negative starts and may leave gaps or extend beyond the primary track. Clips must not overlap on the same overlay row; use another layer for simultaneous footage.
- Trimming changes a selected source range. Primary trims ripple; an overlay left handle also changes its start so the right edge holds. Numeric source-range edits keep the overlay start.
- Splitting preserves colour/speed/opacity and original-source keys. A primary split creates a cut; overlay pieces are independently placed at the split.
- Reordering preserves transitions only where the same adjacent clip pair remains; new boundaries become cuts.
- Invalid edits are rejected without changing the committed document.
- Media pre-trims affect future insertions only. Existing timeline instances retain their own ranges.

Do not add legacy-data migrations or fallback fields unless explicitly requested.

## 6. Media preparation

### Source protection

- Never modify originals.
- Never generate files in source folders.
- Do not follow symlinks during folder discovery.
- Ignore photos and unrelated sidecars initially.
- Report unreadable recordings individually without aborting the entire import.

### Metadata

Record:

- File identity and fingerprint.
- Duration and frame rate.
- Dimensions and codec.
- Pixel format.
- Colour primaries, transfer and range.
- Audio presence.

Detect changed/missing sources. Do not silently associate an old clip with a different recording.

### Proxies

Generate editing proxies with:

- 1280×720 maximum display size, preserving aspect ratio.
- H.264, yuv420p.
- Matching project frame rate.
- Short, closed GOPs for seeking.
- Explicit SDR colour metadata.
- No unnecessary source audio for these drone projects.

Verify source/proxy frame correspondence at the beginning, middle and end before relying on proxies for editing.

Generate thumbnails indexed by source frame. Cache generated assets by source fingerprint and preparation profile.

Start with one heavy media job at a time and bounded FFmpeg threads.

## 7. Colour-processing contract

Required controls:

| Control    |  Initial range | Neutral |
| ---------- | -------------: | ------: |
| Exposure   | −3 to +3 stops |       0 |
| Brightness |   −0.5 to +0.5 |       0 |
| Contrast   |         0 to 2 |       1 |
| Hue        | −180° to +180° |       0 |
| Saturation |         0 to 2 |       1 |
| Highlights |       −1 to +1 |       0 |
| Shadows    |       −1 to +1 |       0 |

**Define the mathematics before implementing sliders.** Do not independently approximate FFmpeg filters in a shader and call them equivalent.

Create a written colour specification covering:

- Input/output colour space and range.
- Transfer-function handling.
- Processing order.
- Exposure multiplication.
- Contrast pivot.
- Brightness offset.
- Shadow/highlight weighting.
- Hue and saturation transform.
- Gamut clipping.

Use the same specification for:

1. A CPU reference implementation used in tests.
2. The WebGL shader.
3. The native export implementation.

If standard FFmpeg filters cannot reproduce the chosen mapping closely enough, use a generated per-clip 3D LUT for the export path and validate its approximation.

Treat this as elementary SDR grading. Do not claim recovery of clipped highlights or RAW-style exposure latitude.

## 8. Mandatory first milestone: preview feasibility prototype

**Do this before building the full editor.**

This original milestone is retained as the development sequence, not the current
editor scope. Its functional foundation is established; the separate position
slider was subsequently removed in favour of ruler/playhead scrubbing. Intended-
GPU and long-flight performance acceptance remain deferred by the user.

Create a small page containing:

- Two prepared proxy clips.
- A WebGL preview canvas.
- Play/pause and a timeline-position slider.
- All seven colour controls.
- Cut, black-fade and cross-dissolve modes.
- Preview diagnostics.

The prototype must:

1. Apply colour changes immediately to paused and playing frames.
2. Decode two clips during a dissolve.
3. Preload the next clip.
4. Seek correctly before, inside and after the transition.
5. Stop or buffer when a required frame is unavailable rather than silently drawing a stale frame.
6. Produce an FFmpeg-rendered reference for comparison.

### Measurements

Measure on the target machine:

- Preview frame rate.
- Slider-to-visible-change latency.
- Seek latency.
- Stalls at clip boundaries.
- Dropped/late decoded frames.
- Memory use over repeated playback.

Initial engineering targets:

- Approximately 29.97 fps at 720p.
- Colour response within 100 ms.
- Median warm seek below 250 ms.
- No accumulating audio/video drift greater than one project frame.

These are **acceptance targets, not promises**. Record hardware, browser, actual results and any relaxed thresholds.

### Decision gate

If HTML video elements cannot meet the required seeking/synchronisation behaviour:

- Keep the timeline model and GPU compositor.
- Evaluate WebCodecs plus a maintained MP4 demuxer.
- Do not conceal poor seeking behind a polished interface.

If live-preview/export colour agreement cannot be established, resolve that before adding the full editor.

## 9. Preview engine implementation

Expose a small engine API for:

- Loading a project.
- Seeking to a project frame.
- Playing/pausing.
- Updating colour settings.
- Updating appearance-only layer/opacity/colour-key settings without rebuilding unchanged timing/music.
- Reporting playback position.
- Reporting buffering/errors.
- Disposal.

Implementation requirements:

- Use `requestVideoFrameCallback` where appropriate to observe decoded frames.
- Use a render loop independent of React.
- Reuse video decoders rather than creating one per timeline clip.
- Cancel obsolete seeks when the user scrubs quickly.
- Handle WebGL context loss.
- Release textures, video resources and audio nodes on disposal.
- Pause playback while timing-changing edits are committed.
- Apply colour independently to both clips before blending a dissolve.
- Composite layer groups bottom-to-top with premultiplied source-over. Apply layer opacity once to the complete primary dissolve group, not independently to its two sources.
- Evaluate clip colour/opacity keys at the mapped original source frame; layer opacity keys at the project frame.
- Ensure fade-to-black produces black after grading, not a graded/tinted black.

Live preview is an editing aid. Final export remains the authoritative deliverable, with differences documented and tested.

## 10. Editor interface

Use an original three-area layout:

- **Left:** searchable media library.
- **Centre:** preview and transport.
- **Right:** selected-clip colour/trim inspector.
- **Bottom:** video timeline and music track.

Required interactions:

- Drag media into the timeline.
- Hover-scrub prepared recordings without moving the project playhead; set source IN/OUT with handles, numbers or I/O marks.
- Add/select/hide/reorder overlay layers, set opacity and move excerpts between rows.
- Click to select a clip.
- Drag trim handles.
- Drag to reorder.
- Click/drag the playhead.
- Zoom and horizontally scroll.
- Split at playhead.
- Delete selection.
- Choose and adjust a boundary transition.
- Reset colour settings.
- Add/update/remove keys, edit their source/project positions and interpolation, and navigate to existing keys.
- Collapse/expand Source range, Layer & opacity, Speed, Colour, Transition, Sequence fades and Music sections.
- Undo/redo.

Implement keyboard shortcuts for play/pause, split, delete and undo/redo. Ignore editing shortcuts while typing in an input.

During a drag:

- Keep changes transient.
- Update visible geometry and relevant preview.
- Commit one undoable command on pointer release.
- Cancel on Escape or pointer cancellation.
- Do not autosave on every pointer movement.

## 11. Music playback

Use one explicit music track initially.

- Import/register a local audio file.
- Show a waveform generated by the backend.
- Support placement, trimming, gain and fades.
- Make looping explicit, never automatic.
- Keep source-video audio disabled initially.

Use an audio clock when music is playing and schedule/synchronise video against it. Without music, use a monotonic playback clock.

For long audio, avoid unnecessarily decoding the entire file into a large in-memory buffer; select an appropriate media-element/Web Audio integration.

Apply the same gain/fade semantics during export. Avoid hidden export-only loudness changes that make preview misleading.

## 12. Persistence and API safety

- Bind the server to loopback.
- Validate Host and Origin.
- Validate all request bodies.
- Register media server-side; never expose an arbitrary-path download endpoint.
- Support HTTP byte ranges.
- Restrict static-file serving to application assets.
- Spawn FFmpeg with argument arrays, never shell interpolation.
- Write project documents atomically.
- Use document revisions to reject stale saves from another tab.
- Serialise saves and show saving/saved/error states.
- Keep undo history in the editor session initially.
- Warn about unsaved changes.

Exports must use an immutable snapshot of the project, so later editing does not change a running render.

## 13. Export implementation

Compile the shared timeline model into native FFmpeg processing.

Requirements:

- Read original footage, not proxies.
- Apply per-clip colour corrections.
- Include layer order/visibility/opacity and clip opacity/colour/speed animation, sampled from the same shared model as preview.
- Implement the exact transition timing contract.
- Include the music track with its explicit placement/gain/fades.
- Preserve the rational project frame rate.
- Produce:
  - 720p H.264 draft.
  - 3840×2160 H.264 SDR BT.709 final.
- Use yuv420p and MP4 fast-start.
- Encode music as AAC.
- Report progress from FFmpeg’s machine-readable progress output.
- Support cancellation and clean up incomplete output.
- Never overwrite a successful export without explicit permission.
- Save an export receipt with the project snapshot and processing settings.

Avoid a single unbounded filter graph containing dozens of simultaneously decoded originals. Use bounded segment/transition processing or another measured strategy.

Verify:

- Dimensions, frame rate and codec.
- Duration/frame count against the timeline model.
- Expected audio presence and duration.
- SDR metadata.
- Absence of obvious decoding errors.

## 14. Testing requirements

### Unit tests

- Rational frame conversions.
- Timeline layout and overlap duration.
- Trim/split/reorder/delete semantics.
- Transition bounds.
- Undo/redo.
- Colour ranges and processing equations.
- Layer placement/overlap/order, premultiplied group opacity, and key interpolation/trim/split preservation.
- Document validation and revisions.

### Browser tests

- Import/library display.
- Timeline insertion and dragging.
- Trim, split, reorder and undo.
- Colour changes on paused/playing preview.
- Seeking through transitions.
- Save/reload.
- Keyboard handling.
- Preview resource disposal.
- Layered playback, overlay trim/drag cancellation, cross-layer scrolling/drop coordinates, key editing and media hover/pre-trim isolation.

### Media integration tests

Use synthetic patterns and short real clips to test:

- Neutral colour identity.
- Each colour control separately and in combination.
- Black opening/closing fades.
- Fade-through-black.
- Cross-dissolve midpoint.
- Music placement and fades.
- Timeline/export frame-count agreement.
- GPU/CPU/export colour differences.
- Animated layer compositing, transparent gaps, hidden-layer tails, lossless alpha coverage, and original-based multi-layer UHD output.

Use measurable pixel comparisons with documented tolerances; do not rely only on screenshots.

Keep real-media tests opt-in. They must use disposable projects and must not alter a user’s saved edit.

## 15. Delivery milestones

Deliver in this order:

1. **Foundation:** repository, strict types, schema, timeline model, tests.
2. **Media service:** import, probing, proxies, thumbnails, safe serving.
3. **Preview prototype:** two clips, live colour and transitions, measured feasibility report.
4. **Timeline editor:** commands, trim/split/reorder, undo/redo.
5. **Inspector and persistence:** per-clip settings, autosave, revisions.
6. **Music:** waveform, placement, trimming, gain/fades, synchronisation.
7. **Export:** native rendering, progress/cancellation, verification.
8. **Hardening:** browser tests, performance, recovery, documentation.

At each milestone:

- Run relevant tests.
- State what works, what remains and known limitations.
- Do not label unfinished features as complete.
- Ask before launching a server or running long media jobs.
- Do not expand scope without agreement.

## 16. Available local test material

Use these only as read-only source inputs:

- Taillefer: owner-supplied local footage folder (personal absolute path omitted for public publication).
- Sitre: owner-supplied local footage folder (personal absolute path omitted for public publication).
- Reference edit: owner-supplied local video (personal absolute path omitted for public publication).

Previously observed source footage: 3840×2160, H.264, SDR BT.709, 30000/1001 fps. **Re-probe rather than assuming these facts.**

Use the reference for human comparison of pacing and presentation. Do not reuse its soundtrack without explicit permission.

**First action for the implementing LLM:** inspect the environment, propose the initial project structure and colour/timing contracts, then implement milestones 1–3. Do not begin with a large timeline UI before proving the live-preview foundation.

## 17. Approved scope extension · 2026-10-02

The user approved the remaining projects/snapping/music/export work and explicitly
added per-clip speed and curved ramps. Colour grading remains per clip, using the
existing shared CPU/GPU/native LUT contract.

- Constant speed: 0.1×–8×, including normal, slow-motion and acceleration presets.
- Ramp-up/ramp-down: independent start/end rates and linear, ease-in, ease-out or
  smooth curve profiles. Ramps are anchored to source-frame positions so trimming,
  restoration and splitting do not arbitrarily reset a curve.
- Slow motion repeats source frames; acceleration drops source frames. Optical-flow
  interpolation is not part of this extension.
- Effective excerpt duration and source-frame mapping must be compiled once using
  the same shared retiming contract in timeline layout, preview and native export.
- Speed changes ripple; transitions/fades are validated in output timeline frames.
- A new strict project version is used. Earlier prototype documents are preserved
  but not migrated or silently interpreted with default speed fields.
- Export uses bounded clip/transition processing, not one graph decoding every
  original. Music placement, gain/fades and explicit looping agree with preview.
- Discrete-GPU performance and a long real-flight render remain user validation
  steps; do not tune against the embedded browser's graphics limitation.

## 18. Approved layers, keyframes and derushing extension · 2026-10-03

The user explicitly approved multiple video layers, per-layer opacity, opacity/
speed/colour keys, collapsible Clip sections and source review/pre-trimming directly
from Media. These features are no longer exclusions.

- Strict schema v3: complete layer/clip animation fields are required. Earlier
  v1/v2 documents stay incompatible and unchanged; no migrations or fallback fields.
- At most eight video layers. The primary layer remains first/locked and ripple-
  edited; overlays use absolute starts and cannot overlap on one row.
- Clip opacity/colour/speed keys remain anchored to integer **original source
  frames**, including keys outside a selected excerpt. Layer opacity keys use
  integer **project frames**. Keys are unique/ordered, with hold, linear, ease-in,
  ease-out or smooth interpolation; the left key controls the following interval.
- Colour keys interpolate all seven grading parameters before grading. Speed keys
  use the existing shared integrated retiming map; optical flow remains excluded.
- Preview uses two reusable decoders for one layer and up to nine for eight layers,
  not one per clip. Source hover review uses one additional muted/paused decoder.
- Layered/animated native export uses sequential premultiplied RGBA16 passes and
  two reusable in-memory 65³ LUTs. It retains bounded decoder/process/RAM concurrency;
  scratch scales with duration, and long 4K throughput is not certified.
- Source review IN/OUT choices and inspector expansion are per-browser editor
  state, not migrations or new renderable project fields. Insertion copies the
  selected source range; originals/full proxies and existing excerpts are intact.
- The user's deferred discrete-GPU and long real-flight validation still stands.

## 19. Productization and UX pass · 2026-10-03

The user requested a complete productization/UX improvement pass, then approved
resuming it after a laptop shutdown. This is editor/UI hardening, not another
rendering feature or schema version.

- A readable resizable desktop workspace, panel visibility/reset, compact-window
  drawers and docked source review with pinning; dimensions remain editor-only.
- Consistent number/title drafts: Enter/blur commits, Escape restores, inline
  validation and stable key-list focus. Sliders remain live; paired source IN/OUT
  retains atomic Apply. Explicit speed/per-colour-control resets are undoable.
- Searchable project selection, pending actions, import results, clear immutable
  export/profile/resource summaries and persistent nonmodal Activity/history.
- Bounded/abortable local-service startup and reads, no hidden/retried write,
  accepted-job feedback retained through status errors, and confirmed cancellation.
- Explicit save retry/conflict recovery without overwrite/rebase: download draft,
  keep editing or confirmed discard/reload. No crash-proof draft store is claimed.
- Keyboard help, exact editable NDF timecode, contextual shortcuts, accessible
  dividers, modal focus restoration and skip navigation.
- Regression checks at laptop/compact desktop sizes, with disposable or memory-only
  projects. Existing native parity and source-safety tests remain mandatory.
- No schema/migration change, source-media modification, additional real footage
  preparation, long real render or intended-GPU performance certification.

The current user workflow is documented in
[docs/WORKSPACE_AND_RECOVERY.md](docs/WORKSPACE_AND_RECOVERY.md).

## 20. Approved automatic proxies, editing basics and declutter · 2026-10-03

The user requested automatic proxy creation when recordings are added to the
library, accurate timeline movement/snapping, less UI clutter and continued basic
editing/productization work. Automatic admission on user imports/additions
supersedes the earlier separate manual-preparation workflow, not source protection
or the deferred long-flight validation.

- User folder imports and single-source additions automatically queue eligible
  proxies through the existing one-heavy-job worker. Registration/probing remains
  read-only toward originals; encoding writes only to the private cache.
- Concurrent additions/preparation reuse pending work; ready/in-flight proxies are
  not encoded twice. Probe rejections and queue admission problems are reported
  separately, and an admission failure does not discard a registered recording.
- Startup/library reads/hover do not queue old unprepared sources. Failed/cancelled/
  interrupted preparation still requires explicit retry; uncertain writes are not
  automatically resubmitted. Manual preparation remains for old media and retries.
- Timeline moves retain the grabbed offset and a stable frame-zero origin. One
  integer-frame plan drives the target-row ghost and committed command, including
  primary ripple positions after removal and overlay leading/trailing-edge snaps.
  Moving-instance old edges are excluded; Alt bypasses magnets. Invalid overlap is
  visible and atomic. Primary sequencing remains contiguous/ripple, not free placement.
- Clip/Sequence/Audio inspector tabs, workspace/media/layer/clip options menus,
  selection-only batch actions and contextual animation/help/reset controls reduce
  default clutter. Existing expansion/layout preferences remain respected.
- Independent clip duplication, one-/ten-frame overlay nudges and editable layer
  names use the existing commands/history and complete source-key settings.
- Strict schema v3, timing/colour/composition contracts and render bounds are
  unchanged. No migration, new effect family, automatic old-library preparation,
  additional real-footage render or intended-GPU performance certification is added.

Current verification and remaining acceptance gates are in
[GitHub work issues](https://github.com/Plonk42/PasCap/issues); movement semantics are in
[docs/TIMELINE_EDITING.md](docs/TIMELINE_EDITING.md).

## 21. Approved row-wide shared keyframes and strict v4 · 2026-10-03

The user explicitly confirmed that shared keyframes belong to the **entire video
ROW/LAYER, not a clip**. This approved extension supersedes the source-key/v3
contracts in earlier sections. The previous milestones remain above as historical
development records; they are not rewritten or treated as the current format.

### Model and evaluation

- Strict **schema 4**: clips retain complete static colour/opacity and constant/ramp
  speed only. No clip animation object, source-speed-key mode or old per-property
  key arrays remain in the current schema.
- Each layer owns ordered `{ frame, interpolation, values }` points at absolute
  integer project frames: one point per frame, at most **256 per row**. All ten
  `values` fields are required and nullable: `layerOpacity`, `clipOpacity`, `speed`,
  `exposure`, `brightness`, `contrast`, `hue`, `saturation`, `highlights`, `shadows`.
  `null` means no participation at that point; all-null points and missing/unknown
  fields are rejected, not repaired.
- Every row point applies across all clips/recordings on that row. Its participants
  share one easing, but **each channel interpolates to its own next participating
  point**, skipping other-channel-only points. Hold/linear/ease-in/ease-out/smooth
  remain supported. Before first/after last participation the channel holds its
  endpoint; with no channel keys it uses each clip's static base, or the layer base
  for layer opacity. Seven colour parameters participate independently and are
  interpolated before grading, not as endpoint images.
- Row Speed overrides each clip's whole constant/ramp base. Consume source frames
  using analytic **$ds=r(t)\,dt$ at absolute project time**, polynomial integrals
  and their monotonic inverse. Round each duration once; **never rescale point
  times or rates**. Integer output times floor the continuous source map, repeating
  or dropping original frames without optical flow.
- Without row Speed participation, retain the existing static constant/source-ramp
  map, original-source ramp anchors and midpoint-integrated **$dt=ds/r(s)$** behavior.
  Removing the last channel participation reveals its unchanged saved base.
- Layout, preview and native original retiming/span validation consume the **same
  `PlacedClip.retiming`**. Grade/clip-opacity/layer-opacity animation is evaluated
  at project time even on held source frames. Primary dissolve grouping, layer-
  opacity equations and preview/native concurrency/raw-buffer/LUT/scratch bounds
  remain unchanged; every row point, even Speed-only, requires layered export.

### Editing and visible UX

- **Trim/move/split/duplicate never copy or shift row points.** Source ranges/static
  bases remain independent, including retained original-source ramp anchors. Moving
  to another row uses that row's override; both rows' points stay in place. Split
  pieces retime/round independently, so total duration may change.
- Row rates make duration contextual to destination layer/start. Primary layout
  ripples and recompiles downstream placements; overlays retain starts and reject
  same-row overlap. Fades/transitions remain output-frame constraints. Invalid
  rate/point-time/easing/placement edits reject atomically, not by clamping fades
  or moving neighbours. Ghost/drop/snapping calculate contextual durations and
  solve trailing ends. Left overlay trims retain timeline OUT; unrepresentable
  source/project-frame quantisation is explicitly rejected.
- One **Layer keyframes** panel follows the selected layer, including an empty row.
  Every animatable setting always exposes its diamond: **◇ hollow/inactive** and
  **◆ filled/active**, with `aria-pressed`. Inactive is **clickable, not HTML-disabled**.
  Toggling joins/leaves only that setting; first participation creates the point,
  last removal deletes it. Participant chips/dependency lists explain what is shared.
- Once a channel is animated, its control is read-only where it does not participate
  until its diamond explicitly captures a value. No slider-created implicit keys
  or automatic source-speed endpoints. Static-base editing is for unanimated
  channels; Speed modes remain Constant/Ramp up/Ramp down with no Keyframes option.
- **Edit points** is the shared list, with per-row dependencies and an inner
  **Time, easing & values** disclosure. Moving the shared Timeline frame moves all
  participants in one Undo step, with collisions and contextual timing validated.
  Numeric drafts use Enter/blur/Escape and preserve focus through reordering/Undo.
- All points, including those outside current duration, remain stored/list-editable.
  Navigation previews the closest available frame without moving stored time.
  Timeline markers are **one per visible row point**, with participants in their
  title/panel and no per-clip duplicates. Direct marker dragging was not requested
  and is not implemented; shared time-field editing is available.
- The thin strip above video rows is the **time ruler**: separators/ticks denote
  TIME and click/drag seeks. Separate Cut/Fade/Dissolve buttons edit primary
  transitions. Clip/Sequence/Audio tabs, options menus, source review, music and
  automatic proxy admission remain unchanged.

### Compatibility, fixtures and verification boundaries

- Earlier **v1/v2/v3 projects and receipt snapshots remain incompatible and
  preserved**, without migration, compatibility fallback/default fields or history
  rewrite. New projects are necessary; registered media/verified ready proxies can
  be reused. The live v3 sample showing incompatible is expected.
- The non-browser fixture uses **`preview-lab-v4`**; only the isolated disposable
  browser cache keeps **`preview-lab`**, also schema 4. Manual sample preparation
  targets only **`sample-taillefer-v4`**, reusing the already prepared first two
  Taillefer recordings. **Do not execute that script for this update.**
- Historical verification and build-chunk measurements remain in Git history;
  the scoped partial handoff is resolved. Current acceptance is recorded on
  [GitHub work issues](https://github.com/Plonk42/PasCap/issues).
  Prior v3 milestones remain historical, not the current total.
- Tests are disposable/synthetic or memory-only. This documentation scope runs no
  tests, starts no services and adds no real footage preparation/import/render.
  Intended-GPU and long-flight validation remain deferred by the user; no additional
  real-media work or soundtrack reuse has been approved.

Current contracts: [docs/LAYERS_AND_KEYFRAMES.md](docs/LAYERS_AND_KEYFRAMES.md),
[docs/SPEED_AND_AUDIO.md](docs/SPEED_AND_AUDIO.md),
[docs/TIMELINE_EDITING.md](docs/TIMELINE_EDITING.md) and
[docs/WORKSPACE_AND_RECOVERY.md](docs/WORKSPACE_AND_RECOVERY.md).
Verification handoff: [GitHub work issues](https://github.com/Plonk42/PasCap/issues).

## 22. Approved rush cutting and ripple assembly priority · 2026-10-03

The user made easy derushing the most important feature: cut one or several
excerpts from each rush, arrange them and shrink/expand without manually realigning
or reordering the rest of the sequence. This extension keeps strict schema 4,
original/proxy protection, shared project-time row points and native resource bounds.

- Source **Add excerpt** leaves the same rush pinned/open at its chosen frame/range,
  creating an independent instance with confirmed success feedback. Its sticky header
  keeps Add and the count reachable on short laptop screens. A size-stable native
  nonmodal popup lists original ranges/layers and Show selects/seeks/reveals an excerpt.
  Recording badges count reuse; changing a source choice never changes existing clips.
- Split, Trim start/end, Delete and timeline IN/OUT/Cut range remain directly visible
  in the existing responsive toolbar. Split selects the right retained piece after
  success. Quick trims preserve the displayed source frame; handles/Source range
  can recover omitted footage. No new mandatory edit-confirmation modal is introduced.
- Transient project-frame marks select an unwanted part of one instance, OUT exclusive.
  One validated source-range removal command retains left/right pieces where needed,
  removes prefixes/suffixes/whole excerpts correctly and produces one Undo step.
  Missing/reversed/no-original-frame marks and fade/overlap incompatibility are rejected
  atomically, not hidden by clamping transitions. Marks never become saved/render fields.
- The primary row closes gaps and recomputes later starts/durations after trims,
  cuts/deletes/reordering while preserving the other source ranges/static settings/order.
  Existing valid outer transitions remain; new piece boundaries are cuts. Positioned
  overlays, music and row points retain absolute project times rather than following
  ripple. Retained pieces keep static ramp anchors and retime/round normally.
- Active left trims alone reserve recoverable headspace and compensate scroll before
  paint, leaving the captured pointer/frame origin unchanged. Edge autoscroll restores
  a long omitted first head within the viewport. Release commits once/removes the
  temporary gutter; Escape/capture cancellation restores document/scroll. Ordinary
  selection/reorder does not shift the origin or reveal beneath an active drag.
- Source/form/modal/popover/divider shortcuts retain their contexts. S selects the
  right split; Q/W shrink the head/tail; timeline I/O and Shift+Delete mark/cut an
  unwanted part. Source I/O remains independent. Selection/timing/history/project
  changes clear only transient cut marks; no migration/optional local-data fields.
- Verification uses only disposable synthetic/media or memory-only projects,
  including real pointer gestures and every-frame native cut-output comparison.
  No real folder reimport, proxy preparation, render, sample generation or deferred
  intended-GPU/long-flight qualification is authorised by this UX request.

Workflow contract: [docs/TIMELINE_EDITING.md](docs/TIMELINE_EDITING.md) and
[docs/WORKSPACE_AND_RECOVERY.md](docs/WORKSPACE_AND_RECOVERY.md).
Historical verified results remain in Git history; current delivery evidence is
recorded on [GitHub work issues](https://github.com/Plonk42/PasCap/issues).

## 23. Approved precise clip speed curves · 2026-10-04

The user explicitly requested precise **clip-level speed keyframes**, with presets
and a custom editable curve inspired by the supplied visual reference. This adds
clip speed curves without undoing the prior whole-row animation decision: colour,
opacity and existing shared Speed points remain row-owned, and a row Speed channel
retains its established override precedence over each clip's independent base.

- Add a strict `speed` union mode with 2–256 unique ascending original-source
  frame/rate/easing points, 0.1×–8×. No optional legacy field, migration, hidden
  point insertion or schema-default conversion is approved.
- Preserve original source anchors through trims, splits, cuts and duplication;
  retained copies remain independently editable. Points outside the current trim
  stay accessible, but may not exceed the registered original's exclusive OUT.
- Provide original editable Flat/Accelerate/Decelerate/Slow centre/Fast centre
  templates, a logarithmic visual graph, exact frame/rate/easing inputs, Add/Delete,
  explicit preview and native keyboard point navigation/editing.
- Integrate each source-rate interval, including one-frame holds, into the shared
  authoritative retiming map. Only final duration rounds; source/frame/native
  ownership and repeat/drop semantics remain. No optical flow or copied app assets.
- Valid graph drafts preview without autosave/history; valid release creates one
  Undo. Escape, pointer cancellation/capture loss and window blur restore the edit.
  Collision/transition/fade/overlay conflicts reject atomically, without merge or
  transition shortening. Keep clear feedback when row Speed overrides the clip.
- Commit each completed logical step with verification and relevant documentation,
  as recorded in [repository instructions](.github/copilot-instructions.md).
- Verify using disposable synthetic and memory-only projects; the request does not
  authorise user-footage preparation/export or deferred hardware/long-flight jobs.

Contract: [docs/SPEED_AND_AUDIO.md](docs/SPEED_AND_AUDIO.md).
