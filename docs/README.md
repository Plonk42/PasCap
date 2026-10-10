# Documentation

Next steps and dependencies: [ROADMAP.md](ROADMAP.md), backed by the actual GitHub
issues, outcome milestones and Project work selection rather than an automatically approved feature
catalogue. [GITHUB_WORKFLOW.md](GITHUB_WORKFLOW.md) defines delivery, CI, labels
and priorities.

## Start here

Vocabulary follows the [editor control catalogue](design/EDITOR_CONTROLS.md#vocabulary):
Recording means a file; Clip a video timeline instance; Track a video or music
track; Keyframe an animation value at a stored frame; Range the IN/OUT boundaries. Static colour
curves use control nodes, not animation keyframes. Internal identifiers, schema
fields, filenames and URLs retain their technical spelling.

| Read                             | Use it for                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [../README.md](../README.md)     | Project overview, quick local start and current scope                                                                                |
| [USER_GUIDE.md](USER_GUIDE.md)   | Projects, no-copy import, repeated clips, timeline editing, clip speed curves/transforms, track keyframes, music/export and recovery |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Linux toolchain, commands, synthetic tests, CI, architecture and contributor safety                                                  |
| [DEPLOYMENT.md](DEPLOYMENT.md)   | Service-side source paths/API and security; planned local Docker/Podman packaging, **not a runnable container recipe**               |
| [LICENSING.md](LICENSING.md)     | Approved project MIT terms, exact production npm notices and separate native/binary distribution review gates                        |

## Processing and editing contracts

| Document                                                         | Authority/scope                                                                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md)                     | SDR grading, fade/dissolve/rational-frame equations and preview/reference scope                                                                                   |
| [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md)               | Uniform schema-15 video tracks, track Colour/Opacity/eleven-channel keyframes, per-track Ripple/transitions/fades, spatial coverage and music resource bounds     |
| [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md)                         | Clip-only constant/source-frame keyframe speed, curve presets, precise editing, sliding timeline markers, shared retiming and music/export audio                  |
| [TIMELINE_EDITING.md](TIMELINE_EDITING.md)                       | No-copy import, source ranges, per-track Ripple/independent placement, recoverable trims, marked cuts, history and snapping                                       |
| [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md)           | Layout, field/keyboard contexts, project bins, serial saves/conflicts, Activity and failure recovery                                                              |
| [UX_HARDENING.md](UX_HARDENING.md)                               | Visual controls, deterministic raw-reader ownership, relink identity prerequisite, export-space assumptions/disk-full recovery and deferred loading               |
| [design/MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md)             | Strict schema-15 identified music arrays, corrected project duration/black tails, final-only summed clipping, one bounded clock and serial native mixing          |
| [design/ROW_APPEARANCE.md](design/ROW_APPEARANCE.md)             | Required video track-only static/keyed Colour and Opacity, shared ownership, resets and destination-track adoption                                                |
| [design/TEMPERATURE_AND_TINT.md](design/TEMPERATURE_AND_TINT.md) | Required normalized track Temperature/Tint, exact pre-exposure linear gains, independent capture and strict schema-15 preservation                                |
| [design/HSL_AND_CURVES.md](design/HSL_AND_CURVES.md)             | Required static track HSL bands and master/RGB curves, SDR order, bounded GPU/native evaluation and exact editor gestures                                         |
| [design/SPATIAL_TRANSFORMS.md](design/SPATIAL_TRANSFORMS.md)     | Required clip base/per-setting source-frame keyframes, crop/affine geometry, neutral letterboxing, per-pixel coverage and Transform controls                      |
| [design/DETAIL_FILTERS.md](design/DETAIL_FILTERS.md)             | Required static clip Sharpen/Clarity/Denoise and keyable track HDR look, shared source-tap kernel before grading, preview/native parity gates and Detail controls |

Use the final approved [#67](https://github.com/Plonk42/PasCap/issues/67) contract:
one required numeric video track `opacity`, initially 1 (100%) on new tracks, with the sole
track keyframe channel `opacity` overriding that value on every clip. Its single slider
is in **Track → Colour**, works on empty tracks and never creates implicit keyframes;
**Placement** contains placement only. Opacity is composition coverage, not SDR
RGB grading; unkeyed colour settings are track-owned. Eleven nullable keyframe fields
are required, in control order: `opacity`, `temperature`, `tint`,
`exposure`, `brightness`, `contrast`, `hue`, `saturation`, `highlights`, `shadows`,
`hdr`.
Saved `clip.opacity`
and old `clipOpacity`/`layerOpacity` channels are rejected, not the valid track value.
Colour animation remains track-wide, while clip-only speed (constant or keyframed)
curves use source frames.
Schema 15 requires complete video track-owned Colour and Opacity with identical static/keyed scope,
and rejects saved `clip.colour` and `clip.correction`. It also requires clip `spatial: { base, keyframes }`: a complete
eight-value pose and 0–256 per-setting original-source keyframes with required easing.
Clip transforms preserve off-trim/exclusive-OUT anchors through edits and use
continuous placed retiming for geometry, without optical flow. They are separate
from track animation; the sole track Opacity contract is unchanged.
Temperature and Tint are required normalized −1…1 track bases, neutral 0, with
independently enabled settings at shared keyframes. Positive Temperature warms; positive Tint
adds magenta. Normalized linear gains precede Exposure; nonzero values
intentionally colour greys, with neutral-white luminance preservation before
clipping only. HSL/curves remain required static settings, not extra channels.
Required track HDR (0–1, neutral 0) is a keyable SDR local tone-mapping look
applied in the clip detail kernel before grading.
Schema 15 requires `music: MusicTrack[]`, 0–8 independent uniquely
identified music tracks (`[]` without music). Project duration is maximum video clip
OUT or music start + duration: music can extend it, with video closing fades at
clip OUT then black while music continues/fades at its own end. Clip speed,
track Colour and sole Opacity are unchanged. Version-1 export receipts require strict v15
snapshots and captured audio-source/instance-plan arrays; preserve incompatible
v1–v14 documents/receipts/MP4s, recreate deliberately, and never migrate/default
or use null/older readers. Registry/proxy/current PCM formats remain unchanged.
The #35 contract has pending implementation/validation acceptance; no passed
tests, release or milestone closure is claimed by this documentation update.
Guides describe current contracts. Explicitly historical reports/design records
and Git history retain earlier evidence, not current acceptance claims.

## Status and planning

- Dated local verification, acceptance evidence, blockers and next actions belong
  on the corresponding [GitHub work issue](https://github.com/Plonk42/PasCap/issues).
  [GitHub Actions](https://github.com/Plonk42/PasCap/actions) records actual-commit
  remote checks. Guides describe current contracts and validation procedures,
  not a second delivery-status ledger; deleted documentation remains in Git history.
- [FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md): **historical** two-source preview/
  colour evidence. It does not qualify current composited throughput or the intended GPU.
- Follow planned work in [GitHub issues](https://github.com/Plonk42/PasCap/issues)
  and [milestones](https://github.com/Plonk42/PasCap/milestones), with
  native dependencies and categorized/prioritized labels. Sprint membership uses
  native Project Iteration fields only for agreed timeboxes; continuous delivery
  uses a selected-work view instead, never an issue as a sprint container. The
  [workflow](GITHUB_WORKFLOW.md) sends routine changes straight to `main` with CI
  as a backstop. The private repository-linked
  [planning Project](https://github.com/users/Plonk42/projects/1) reuses those issues
  in delivery/milestone views; sign-in is required. Existing
  [#15](https://github.com/Plonk42/PasCap/issues/15) is a preserved legacy checkpoint,
  not a tracker template. Tracking is not proof of
  completed CI, containers or real-flight acceptance.
- Working through milestone issues sequentially does not authorize a release,
  milestone closure or real-media job; those still require explicit owner approval.
- [../EDITOR_IMPLEMENTATION_PLAN.md](../EDITOR_IMPLEMENTATION_PLAN.md) retains the
  original plan and chronology.
- [Source relink proposal](design/SOURCE_RELINK.md) is the separate #2 design record:
  required full-byte evidence, stable IDs/cache and confirmed location/format decisions,
  **not an implemented relink workflow or approved data migration**.
- [Historical track-parity design record](design/TRACK_PARITY.md) records the approved #25
  choices: uniform tracks, default-on continuous Ripple with pack-on-enable,
  track-local transitions/fades, schema 6 and concurrent-dissolve resources.
  Its two-opacity/persistence descriptions are historical, superseded by the strict
  v8 track-owned Opacity value and sole `opacity` channel above. Its video-only duration
  assumption is superseded by the multiple-music contract; acceptance evidence
  stays on the issue. Historical reports and recorded evidence remain unchanged.

- [HSL ranges and editable colour curves](design/HSL_AND_CURVES.md): strict required static video track settings, encoded SDR order, exact fields/keyboard and one-Undo gestures, unchanged scalar animation and resource bounds.
