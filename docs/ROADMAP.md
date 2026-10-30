# Roadmap

GitHub [issues](https://github.com/Plonk42/PasCap/issues) and
[milestones](https://github.com/Plonk42/PasCap/milestones) are the execution system
of record, with native dependencies/sub-issues, labeled priority/progress and
iteration tracking. Each triaged issue has scope, acceptance, non-goals and an
explicit next action. Follow [the GitHub workflow](GITHUB_WORKFLOW.md); this page
indexes outcomes, not a competing mutable backlog. Milestones have no invented
deadline; hardware/real-media work requires explicit owner consent.

## Current baseline

The local current-schema contract covers no-copy footage import, projects, source
clips, multi-track timelines, clip grades and adjustments, Transform and Opacity track
keyframes, music and verified
720p/4K export, with clip-only constant speed or precise source-frame speed curves.
Video track-owned crop/scale/translation/rotation, Opacity and per-setting project-frame
animation are specified by [#131's current contract](design/SPATIAL_TRANSFORMS.md), without
claiming qualification or changing milestone status. Static clip Sharpen, Clarity
and Denoise and the keyable HDR look and Local contrast follow [#123's contract](design/DETAIL_FILTERS.md), likewise without a
qualification claim.
Milestone v1.3 ([#284](https://github.com/Plonk42/PasCap/issues/284)) moves Colour to
[clip grades and adjustments](design/ROW_APPEARANCE.md): every clip has its own grade, keyed at
source frames so it follows its footage, and up to 1,024 adjustments grade every video track over
a range of the film, after each clip's grade. Its
[decision record](design/CLIP_GRADES_AND_ADJUSTMENTS.md) lists what is implemented (#273,
#285 to #288, including adjustments on the timeline and through MCP) and what remains: the
UX evaluation (#289). Video tracks keep Transform, Ripple, transitions and fades;
**Opacity** is the ninth Transform setting (0–1, initially 1 on new tracks), keyed like the
others on every clip, including both dissolve sources, without an additional track
multiplier. Its slider lives in **Track → Transform** and works on empty tracks;
**Placement** contains placement only. With keyframes, a setting not enabled at the real
playhead is read-only until explicitly captured; sliders never create keyframes. Grade
keyframes have fourteen nullable channels:
twelve scalar colour settings (including `temperature`, `tint`,
`vibrance`, `whites` and `blacks`), `hdr` and `localContrast`. Saved `clip.opacity` is
rejected. [Temperature and Tint](design/TEMPERATURE_AND_TINT.md) use
normalized −2…2 and −1…1, neutral 0, with independent animation. Positive Temperature
warms; positive Tint adds magenta. The shared normalized linear-gain formula runs
before Exposure and intentionally colours greys; neutral-white luminance is
preserved before clipping only. Static
[HSL ranges and master/RGB curves](design/HSL_AND_CURVES.md)
follow scalar grading in each grade without adding animation channels. Projects and receipt
snapshots saved before the current schema, with track Colour, are rejected with the reason and
left unchanged, without defaults or automatic deletion;
proxy/current PCM formats remain unchanged; the registries are version 2 (full-content
checksums). Projects require a 0–8
music track array of clips joined by transitions (`[]` without music); version-1 export receipts
require strict current-schema snapshots and captured audio-source/instance-plan arrays.
Music can extend duration to maximum video/music OUT: closing video fades finish
at clip OUT, then black while music continues/fades at its own end. One mixed
output clock and final-only linear-sum clamp retain bounded resources; see
[#35's contract](design/MULTIPLE_MUSIC.md). Implementation/validation acceptance
is pending, not established by this documentation.
Every video track owns Ripple (default on), transitions and opening/closing fades.
Enabling Ripple packs from the current first start; while on, clips continuously
sequence there, and turning it off retains actual placements. Video tracks display stored
bottom-to-top composition order without primary/overlay roles. The UI provides a
pinned ruler, synchronized native track access, accessible action bounds and contextual
heading help. Properties tabs are **Clip / Colour / Track / Audio**, split by ownership:
**Colour** edits the grade of the selected clip or adjustment; its
[keyframe list](https://github.com/Plonk42/PasCap/issues/26) sits at the
end of the Colour section, under a small **Keyframes** heading with animation/timing help
beside it, followed by HSL ranges and Colour curves. Nested keyframe details retain drafts and input
identity; there is no outer list disclosure or list expansion preference.
Track holds Transform with Opacity (ending with its own keyframe list),
Transitions and Fades. Clip keeps
source/clip settings and playhead Speed controls; its Expand all/Collapse all
affects only the four Clip sections (**Speed**, **Detail**, **Range** and **Placement**),
leaving Track, Audio, nested disclosures and help
unchanged. Stored keyed settings reuse the main value
controls with precise numeric editing. Clip/track selection and keyframe navigation
preserve the chosen tab; explicit boundary buttons open Track. Current usage
and limits are documented in [the user guide](USER_GUIDE.md),
[track/resource contracts](LAYERS_AND_KEYFRAMES.md) and
[development/validation guide](DEVELOPMENT.md).
Dated acceptance evidence belongs to the corresponding work issues, with
[CI results](https://github.com/Plonk42/PasCap/actions) for the actual delivery
commit. Publication and CI are not a release or a target-GPU/long-flight
qualification claim.

## Work selection and next steps

Sequential work through milestone issues is not milestone closure or release
approval. Releases, milestone closure and real-media jobs still require explicit
owner approval; no issue status or acceptance is changed by this contract update.

Use concrete work issues and [ready next actions](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Aready%22)
for mutable progress. [#2](https://github.com/Plonk42/PasCap/issues/2) implements
[verified relinking](design/SOURCE_RELINK.md) of moved video and music originals with
version-2 registries; there is no path guessing or automatic migration.
#5 covers the approved MIT license, dependency notices and native distribution review.
GPU/flight work requires owner setup/consent. The private repository-linked
[planning Project](https://github.com/users/Plonk42/projects/1) presents the same
issues with aligned Status. Use its native Iteration field for explicitly agreed
timeboxes; without an agreed cadence, use the backlog/Status board and a bounded
selected-work view. Do not create sprint issues or use parent/sub-issue hierarchy
for sprint membership. Milestones remain deliverable outcomes.

[#15](https://github.com/Plonk42/PasCap/issues/15) is a legacy delivery checkpoint,
not the scheduling authority or a template for new sprint trackers. Its existing
history, labels and relationships remain preserved pending any explicitly approved
cleanup; no new Iteration dates or Project field/view changes are implied here.

## v0.1 — Local editor hardening

[Milestone](https://github.com/Plonk42/PasCap/milestone/1)

| Issue                                                                                    | Scope                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#1 — Deterministic raw-frame reader tests](https://github.com/Plonk42/PasCap/issues/1)  | Retain the locally verified exit-before-read fix; verify fresh Node 22/24 CI without hiding failures or weakening exact frame/resource checks                                                                                                                            |
| [#2 — Explicit verified source relinking](https://github.com/Plonk42/PasCap/issues/2)    | Implemented [verified relink](design/SOURCE_RELINK.md) of moved video and music originals: full-content checksum match, registry v2, IDs/caches/clips kept; never guess from names                                                                                       |
| [#3 — Export disk preflight](https://github.com/Plonk42/PasCap/issues/3)                 | Explain scratch needs and handle low space without destroying original/successful data                                                                                                                                                                                   |
| [#4 — Entry bundle loading](https://github.com/Plonk42/PasCap/issues/4)                  | Measure and reduce initial JS without suppressing the warning or changing per-frame ownership                                                                                                                                                                            |
| [#5 — License and redistribution notices](https://github.com/Plonk42/PasCap/issues/5)    | Approved MIT project terms, retained npm notices and the separate GPL-enabled native distribution contract                                                                                                                                                               |
| [#12 — GitHub workflow](https://github.com/Plonk42/PasCap/issues/12)                     | Keep instructions/forms, categorized priorities, next actions and iteration/dependency tracking aligned                                                                                                                                                                  |
| [#13 — Shared-keyframe movement/navigation](https://github.com/Plonk42/PasCap/issues/13) | Retrospective delivered-feature record; preserve whole-keyframe transactions, independent channel navigation and dated evidence                                                                                                                                          |
| [#14 — Precise clip speed](https://github.com/Plonk42/PasCap/issues/14)                  | Track approved source-frame curves and locally verified graph/numeric/native delivery separately from remote acceptance                                                                                                                                                  |
| [#16 — Compact contextual help](https://github.com/Plonk42/PasCap/issues/16)             | Heading-level hover/pinned question-mark buttons accessible even when collapsed, with independent expansion and preserved drafts/focus/editable panels                                                                                                                   |
| [#25 — Uniform video tracks](https://github.com/Plonk42/PasCap/issues/25)                | Uniform track parity: per-track continuous Ripple, transitions/fades, composition order and bounded simultaneous-dissolve preview/native export; [historical design record](design/TRACK_PARITY.md), with current usage in the [track contract](LAYERS_AND_KEYFRAMES.md) |

Done means a repeatable, documented local foundation—not more CapCut-style effects.
The initial publication includes README/user/developer guides, pinned CI and issue
forms. Those are delivered work, not duplicate open backlog tasks.

The local [UX-hardening update](UX_HARDENING.md) implements the #1 deterministic
raw-reader fix, #3 storage/recovery controls and genuine constrained-volume test,
and #4 measured loading boundaries, with simpler visual UI throughout. Delivery
and acceptance are recorded on those issues, not duplicated here. #2 adds
full-content checksums and an explicit [verified relink](design/SOURCE_RELINK.md).
[Licensing](LICENSING.md) defines the approved project terms and
remaining actual-artifact distribution/legal-review gates, not release approval.

Clip speed is clip-only: constant or editable source-frame curves with presets such as
Ramp up; [#14](https://github.com/Plonk42/PasCap/issues/14)
records its verification and delivery. It does not approve new optical-flow effects
or private-media/hardware qualification work.

## v0.2 — Real-workload qualification

[Milestone](https://github.com/Plonk42/PasCap/milestone/2)

| Issue                                                                               | Scope                                                                                                          |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [#6 — Intended-GPU preview](https://github.com/Plonk42/PasCap/issues/6)             | Record the actual renderer and test nominal playback, scrubbing, ramps/dissolves and track animation           |
| [#7 — Complete 5–10 minute flight edit](https://github.com/Plonk42/PasCap/issues/7) | Consented, licensed inputs; save/reopen, full preview, verified draft/final exports and interruption behaviour |
| [#8 — A/V and resource soak](https://github.com/Plonk42/PasCap/issues/8)            | Measure browser/GPU/native children/scratch and audible loop/buffering behaviour over realistic duration       |

The long-flight run uses intended-GPU findings and export-space safety from v0.1.
Synthetic/SwiftShader CI cannot close the hardware gate. Failures must produce
reproducible follow-ups, not relaxed frame/pixel/timing assertions.

## Deployment

PasCap runs natively ([local deployment](DEPLOYMENT.md)). The v0.3 Docker/Podman
milestone was dropped on 2026-10-28 and #9–#11 closed as not planned: without a
published image each user would build it, and footage access and GPU export/decoding
are simpler natively. [#290](https://github.com/Plonk42/PasCap/issues/290) checks
the native FFmpeg toolchain at startup and scripts its local install.

## Scope boundaries

- Original recordings are never uploaded, copied or automatically deleted.
- Strict local data remains explicit; projects saved before the current schema, with track
  Colour, are rejected and left unchanged, without fallback fields.
- The application is local/single-user, not GitHub Pages, LAN hosting or remote SaaS.
- No new rendering effect is scheduled from an inspection checklist alone.
- [The implementation plan](../EDITOR_IMPLEMENTATION_PLAN.md) is retained as design
  history, not an approved implementation backlog.
- Titles, general-purpose masks, optical flow, HDR output or HDR footage (the
  HDR look is an SDR effect), cloud/mobile/collaboration and native
  GPU encoding remain outside the current delivery milestones.

Proposals should explain a user problem, scope, observable acceptance and
dependencies. Do not attach private source files, licenses, credentials, complete
project snapshots or filesystem paths to public reports.
