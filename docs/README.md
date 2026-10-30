# Documentation

Next steps and dependencies: [ROADMAP.md](ROADMAP.md), backed by the actual GitHub
issues, outcome milestones and Project work selection rather than an automatically approved feature
catalogue. [GITHUB_WORKFLOW.md](GITHUB_WORKFLOW.md) defines delivery, CI, labels
and priorities.

## Start here

Vocabulary follows the [editor control catalogue](design/EDITOR_CONTROLS.md#vocabulary):
Recording means a file; Clip a video timeline instance; Track a video or music
track; Clip grade a clip's own Colour; Adjustment one grade for every video track over a range
of the film; Keyframe an animation value at a stored frame; Range the IN/OUT boundaries. Static colour
curves use control nodes, not animation keyframes. Internal identifiers, schema
fields, filenames and URLs retain their technical spelling.

| Read                             | Use it for                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [../README.md](../README.md)     | Project overview, quick local start and current scope                                                                                                             |
| [USER_GUIDE.md](USER_GUIDE.md)   | Projects, no-copy import, repeated clips, timeline editing, clip speed curves, clip grades and adjustments, track transforms/keyframes, music/export and recovery |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Linux toolchain, commands, synthetic tests, CI, architecture and contributor safety                                                                               |
| [DEPLOYMENT.md](DEPLOYMENT.md)   | Service-side source paths/API, storage, permissions, loopback network and the native FFmpeg toolchain                                                             |
| [LICENSING.md](LICENSING.md)     | Approved project MIT terms, exact production npm notices and separate native/binary distribution review gates                                                     |

## Processing and editing contracts

| Document                                                                       | Authority/scope                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md)                                   | SDR grading, fade/dissolve/rational-frame equations and preview/reference scope                                                                                                                        |
| [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md)                             | Uniform video tracks, fourteen-channel grade keyframes, track Transform with Opacity, per-track Ripple/transitions/fades, spatial coverage and music resource bounds                                   |
| [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md)                                       | Clip-only constant/source-frame keyframe speed, curve presets, precise editing, sliding timeline markers, shared retiming and music/export audio                                                       |
| [TIMELINE_EDITING.md](TIMELINE_EDITING.md)                                     | No-copy import, source ranges, per-track Ripple/independent placement, recoverable trims, marked cuts, history and snapping                                                                            |
| [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md)                         | Layout, field/keyboard contexts, project bins, serial saves/conflicts, Activity and failure recovery                                                                                                   |
| [UX_HARDENING.md](UX_HARDENING.md)                                             | Visual controls, deterministic raw-reader ownership, relink identity evidence, export-space assumptions/disk-full recovery and deferred loading                                                        |
| [design/MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md)                           | Strict identified music arrays, corrected project duration/black tails, final-only summed clipping, one bounded clock and serial native mixing                                                         |
| [design/ROW_APPEARANCE.md](design/ROW_APPEARANCE.md)                           | Clip grades and adjustments as the owners of Colour, Opacity as a Transform setting, the grading order, Colour tab targets, resets and Original modes                                                  |
| [design/TEMPERATURE_AND_TINT.md](design/TEMPERATURE_AND_TINT.md)               | Required normalized Temperature/Tint of clip grades and adjustments, exact pre-exposure linear gains, independent capture and Auto white balance                                                       |
| [design/AUTO_ADJUST.md](design/AUTO_ADJUST.md)                                 | Colour → Auto: the estimator fitted through the real grade, written to clip grades as values or a keyframe, its popover, intensity and limits                                                          |
| [design/HSL_AND_CURVES.md](design/HSL_AND_CURVES.md)                           | Required static HSL bands and master/RGB curves of clip grades and adjustments, SDR order, bounded GPU/native evaluation and exact editor gestures                                                     |
| [design/CLIP_GRADES_AND_ADJUSTMENTS.md](design/CLIP_GRADES_AND_ADJUSTMENTS.md) | Decision record (v1.3): clip grades and range-scoped adjustment items replacing track Colour, implemented; adjustments on the timeline and through MCP still to deliver                                |
| [design/SPATIAL_TRANSFORMS.md](design/SPATIAL_TRANSFORMS.md)                   | Required video track Transform base/per-setting project-frame keyframes with Opacity, crop/affine geometry, neutral letterboxing, per-pixel coverage and Transform controls                            |
| [design/DETAIL_FILTERS.md](design/DETAIL_FILTERS.md)                           | Required static clip Sharpen/Clarity/Denoise and keyable HDR/Local contrast/Shadows/Highlights of the grades, shared source-tap kernel before grading, preview/native parity gates and Detail controls |
| [design/WEBCODECS_PREVIEW.md](design/WEBCODECS_PREVIEW.md)                     | WebCodecs proxy decoding in workers: proxy index contract, credit-bounded exact frames, decoder lanes, buffering and source review                                                                     |
| [design/SOURCE_RELINK.md](design/SOURCE_RELINK.md)                             | Verified relinking of moved video/music originals: full-content checksums, version-2 registries, ID-keyed caches and the Relink flow                                                                   |
| [design/ASSISTANT_MCP.md](design/ASSISTANT_MCP.md)                             | **Assistant rough cut contract**: hand-off of a first-pass project to an LLM through the service's MCP endpoint, project selects, music analysis, native stills, sessions and the operation registry   |

Colour belongs to clip grades and adjustments ([#286](https://github.com/Plonk42/PasCap/issues/286)).
Every clip requires `grade: { colour, keyframes }`, keyed at source frames so it follows its
footage; the project requires `adjustments`, 0–1,024 ordered, non-overlapping items
`{ id, start, duration, colour, keyframes }` that grade every video track within their range,
after each clip's grade, with keyframes counted from their start. Both carry the same complete
Colour: twelve scalar settings, HDR, Local contrast and static HSL/curves. Fourteen nullable
keyframe fields are required, in control order: `temperature`, `tint`,
`exposure`, `brightness`, `contrast`, `hue`, `saturation`, `vibrance`, `highlights`, `shadows`,
`whites`, `blacks`, `hdr`, `localContrast`.
Video tracks have no Colour, Opacity or keyframes; saved `clip.colour`, `clip.correction` and
`clip.opacity` are rejected. Every video track requires `transform: { base, keyframes }`: a
complete nine-value base, the eight pose settings and **Opacity** (0–1, initially 1), and
0–256 per-setting project-frame keyframes with required easing
and a default-keyframe `reset` flag; saved `clip.spatial` is rejected. Transform evaluates at
absolute project time on every source of the track and is never copied or shifted by clip edits.
Opacity is composition coverage, not SDR RGB grading: its slider is in **Track → Transform**,
works on empty tracks and never creates implicit keyframes; **Placement** contains placement only.
Clip-only speed (constant or keyframed) curves use source frames; every clip also requires a
boolean `reverse`.
Temperature and Tint are required normalized bases (−2…2 and −1…1), neutral 0, with
independently enabled settings at keyframes. Positive Temperature warms; positive Tint
adds magenta. Normalized linear gains precede Exposure; nonzero values
intentionally colour greys, with neutral-white luminance preservation before
clipping only. Vibrance (−1…2, neutral 0) is a keyable chroma scale
after Saturation, weighted towards muted colours. Whites (−1…1, neutral 0) is a keyable tone stage that
moves the white point; Blacks (−1…1, neutral 0) is the keyable stage after
it that moves the black point. HSL/curves remain required static settings, not extra channels.
HDR (0–1, neutral 0) is a keyable SDR local tone-mapping look
applied in the clip detail kernel before grading; Local contrast
(−1…1, neutral 0) is the keyable local-detail boost split out of HDR, in the same kernel.
Projects require `music: MusicTrack[]`, 0–8 independent uniquely
identified music tracks (`[]` without music). Project duration is maximum video clip
OUT or music start + duration: music can extend it, with video closing fades at
clip OUT then black while music continues/fades at its own end. Clip speed,
grades and Opacity are unchanged by music. Version-1 export receipts require strict current-schema
snapshots and captured audio-source/instance-plan arrays. Projects and receipt snapshots saved
before the current schema, with track Colour, are rejected with the reason and left unchanged,
like their MP4s; nothing is defaulted or deleted. Proxy/current PCM formats remain unchanged; the registries
are version 2 (full-content checksums).
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
  completed CI or real-flight acceptance.
- Working through milestone issues sequentially does not authorize a release,
  milestone closure or real-media job; those still require explicit owner approval.
- [../EDITOR_IMPLEMENTATION_PLAN.md](../EDITOR_IMPLEMENTATION_PLAN.md) retains the
  original plan and chronology.
- [Historical track-parity design record](design/TRACK_PARITY.md) records the approved #25
  choices: uniform tracks, default-on continuous Ripple with pack-on-enable,
  track-local transitions/fades and concurrent-dissolve resources.
  Its two-opacity/persistence descriptions are historical, superseded by Opacity as a
  Transform setting and by clip grades and adjustments, above. Its video-only duration
  assumption is superseded by the multiple-music contract; acceptance evidence
  stays on the issue. Historical reports and recorded evidence remain unchanged.

- [HSL ranges and editable colour curves](design/HSL_AND_CURVES.md): strict required static settings of clip grades and adjustments, encoded SDR order, exact fields/keyboard and one-Undo gestures, unchanged scalar animation and resource bounds.
