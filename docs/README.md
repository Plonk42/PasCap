# Documentation

Next steps and dependencies: [ROADMAP.md](ROADMAP.md), backed by the actual GitHub
issues, outcome milestones and Project work selection rather than an automatically approved feature
catalogue. [GITHUB_WORKFLOW.md](GITHUB_WORKFLOW.md) defines delivery, CI, labels
and priorities.

## Start here

| Read                             | Use it for                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [../README.md](../README.md)     | Project overview, quick local start and current scope                                                                                 |
| [USER_GUIDE.md](USER_GUIDE.md)   | Projects, no-copy import, repeated excerpts, timeline editing, clip speed curves/transforms, row keyframes, music/export and recovery |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Linux toolchain, commands, synthetic tests, CI, architecture and contributor safety                                                   |
| [DEPLOYMENT.md](DEPLOYMENT.md)   | Service-side source paths/API and security; planned local Docker/Podman packaging, **not a runnable container recipe**                |
| [LICENSING.md](LICENSING.md)     | Approved project MIT terms, exact production npm notices and separate native/binary distribution review gates                         |

## Processing and editing contracts

| Document                                                         | Authority/scope                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md)                     | SDR grading, fade/dissolve/rational-frame equations and preview/reference scope                                                                              |
| [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md)               | Uniform schema-12 video tracks, row Colour/Opacity/eleven-channel row points, per-track Ripple/transitions/fades, spatial coverage and music resource bounds |
| [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md)                         | Source-anchored constant/ramp/custom clip curves versus analytic project-time row Speed, precise curve editing, shared retiming and music/export audio       |
| [TIMELINE_EDITING.md](TIMELINE_EDITING.md)                       | No-copy import, source ranges, per-track Ripple/independent placement, recoverable trims, marked cuts, history and snapping                                  |
| [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md)           | Layout, field/keyboard contexts, project bins, serial saves/conflicts, Activity and failure recovery                                                         |
| [UX_HARDENING.md](UX_HARDENING.md)                               | Visual controls, deterministic raw-reader ownership, relink identity prerequisite, export-space assumptions/disk-full recovery and deferred loading          |
| [design/MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md)             | Strict schema-12 identified music arrays, corrected project duration/black tails, final-only summed clipping, one bounded clock and serial native mixing     |
| [design/ROW_APPEARANCE.md](design/ROW_APPEARANCE.md)             | Required row-only static/keyed Colour and Opacity, shared ownership, resets and destination-row adoption                                                     |
| [design/TEMPERATURE_AND_TINT.md](design/TEMPERATURE_AND_TINT.md) | Required normalized row Temperature/Tint, exact pre-exposure linear gains, independent capture and strict schema-12 preservation                             |
| [design/HSL_AND_CURVES.md](design/HSL_AND_CURVES.md)             | Required static row HSL bands and master/RGB curves, SDR order, bounded GPU/native evaluation and exact editor gestures                                      |
| [design/SPATIAL_TRANSFORMS.md](design/SPATIAL_TRANSFORMS.md)     | Required clip base/full-pose source-frame keys, crop/affine geometry, neutral letterboxing, per-pixel coverage and Transform controls                        |

Use the final approved [#67](https://github.com/Plonk42/PasCap/issues/67) contract:
one required numeric row `opacity`, initially 1 (100%) on new tracks, with the sole
row key channel `opacity` overriding that value on every clip. Its single slider
is in **Clip → Colour**, works on empty rows and never creates implicit keys;
**Placement** contains placement only. Opacity is composition coverage, not SDR
RGB grading; unkeyed colour settings are row-owned. Eleven nullable point fields
are required, in control order: `opacity`, `speed`, `temperature`, `tint`,
`exposure`, `brightness`, `contrast`, `hue`, `saturation`, `highlights`, `shadows`.
Saved `clip.opacity`
and old `clipOpacity`/`layerOpacity` channels are rejected, not the valid row value.
Colour animation remains row-wide, while the separately approved clip-only speed
curves use source frames.
Schema 12 requires complete row-owned Colour and Opacity with identical static/keyed scope,
and rejects saved `clip.colour` and `clip.correction`. It also requires clip `spatial: { base, keyframes }`: a complete
eight-value pose and 0–256 full-pose original-source keys with required easing.
Clip transforms preserve off-trim/exclusive-OUT anchors through edits and use
continuous placed retiming for geometry, without optical flow. They are separate
from row animation; the sole row Opacity contract is unchanged.
Temperature and Tint are required normalized −1…1 row bases, neutral 0, with
independent shared-row participation. Positive Temperature warms; positive Tint
adds magenta. Normalized linear gains precede Exposure; nonzero values
intentionally colour greys, with neutral-white luminance preservation before
clipping only. HSL/curves remain required static settings, not extra channels.
Schema 12 requires `music: MusicTrack[]`, 0–8 independent uniquely
identified instances (`[]` without music). Project duration is maximum video clip
OUT or music start + duration: music can extend it, with video closing fades at
clip OUT then black while music continues/fades at its own end. Clip speed,
row Colour and sole Opacity are unchanged. Version-1 export receipts require strict v12
snapshots and captured audio-source/instance-plan arrays; preserve incompatible
v1–v11 documents/receipts/MP4s, recreate deliberately, and never migrate/default
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
  colour evidence. It does not qualify current layered throughput or the intended GPU.
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
  v8 row-owned Opacity value and sole `opacity` channel above. Its video-only duration
  assumption is superseded by the multiple-music contract; acceptance evidence
  stays on the issue. Historical reports and recorded evidence remain unchanged.

- [HSL ranges and editable colour curves](design/HSL_AND_CURVES.md): strict required static row settings, encoded SDR order, exact fields/keyboard and one-Undo gestures, unchanged scalar animation and resource bounds.
