# Roadmap

GitHub [issues](https://github.com/Plonk42/PasCap/issues) and
[milestones](https://github.com/Plonk42/PasCap/milestones) are the execution system
of record, with native dependencies/sub-issues, labeled priority/progress and
iteration tracking. Each triaged issue has scope, acceptance, non-goals and an
explicit next action. Follow [the GitHub workflow](GITHUB_WORKFLOW.md); this page
indexes outcomes, not a competing mutable backlog. Milestones have no invented
deadline; hardware/real-media work requires explicit owner consent.

## Current baseline

The local schema-15 contract covers no-copy footage import, projects, source
clips, multi-track timelines, colour/opacity track keyframes, music and verified
720p/4K export, with clip-only constant speed or precise source-frame speed curves.
Clip-owned crop/scale/translation/rotation and per-setting source-frame animation
are specified by [#20's current contract](design/SPATIAL_TRANSFORMS.md), without
claiming qualification or changing milestone status. Static clip Sharpen, Clarity
and Denoise and the keyable track HDR look follow [#123's contract](design/DETAIL_FILTERS.md), likewise without a
qualification claim.
The final approved [#67](https://github.com/Plonk42/PasCap/issues/67) contract has
one video track-owned **Opacity** setting: required numeric `VideoLayer.opacity` in 0–1,
initially 1 (100%) on new tracks. Its sole track channel, `opacity`, overrides that
value on every clip, including both dissolve sources, without an additional track
multiplier. The single slider/diamond/navigation lives in **Track → Colour** and
works on empty tracks; **Placement** contains placement only. Without Opacity keyframes,
the slider edits the track value; with keyframes, a setting not enabled at the real
playhead is read-only until explicitly captured. Sliders never create keyframes, and
unkeyed colour settings are track-owned. Shared keyframes have eleven nullable channels:
`opacity`, nine scalar colour settings (including `temperature` and
`tint`) and `hdr`. Saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` channels are rejected; track `opacity` is required and
valid. Track-owned [Temperature and Tint](design/TEMPERATURE_AND_TINT.md) use
normalized −1…1, neutral 0, with independent animation. Positive Temperature
warms; positive Tint adds magenta. The shared normalized linear-gain formula runs
before Exposure and intentionally colours greys; neutral-white luminance is
preserved before clipping only. Static track
[HSL ranges and master/RGB curves](design/HSL_AND_CURVES.md)
follow scalar grading without adding animation channels. v1–v14 projects
and receipt snapshots are preserved/incompatible and require recreation, without
migration, defaults, null/old-format readers or automatic deletion;
registry/proxy/current PCM formats remain unchanged. Schema 15 requires a 0–8
identified music track array (`[]` without music); version-1 export receipts
require strict v15 snapshots and captured audio-source/instance-plan arrays.
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
heading help. Inspector tabs are **Clip / Track / Audio**, split by ownership: the
[whole-track keyframe list](https://github.com/Plonk42/PasCap/issues/26) is the
**Track → Keyframes** section, directly shows the whole-track keyframe list and combines
animation/timing help in its toolbar. Nested keyframe details retain drafts and input
identity; there is no outer list disclosure or per-track list expansion preference.
Track also holds Colour, Transitions and Fades. Clip keeps
source/clip settings and playhead Speed/Transform controls; its Expand all/Collapse all
affects only the four Clip sections (**Speed**, **Transform**, **Range** and **Placement**),
leaving Track, Audio, nested disclosures and help
unchanged. Stored keyed settings reuse the main value
controls with precise numeric editing. Clip/track selection and keyframe navigation
preserve the chosen tab; explicit boundary buttons open Track. Current usage
and limits are documented in [the user guide](USER_GUIDE.md),
[track/resource contracts](LAYERS_AND_KEYFRAMES.md) and
[development/validation guide](DEVELOPMENT.md).
Dated acceptance evidence belongs to the corresponding work issues, with
[CI results](https://github.com/Plonk42/PasCap/actions) for the actual delivery
commit. Publication and CI are not a container release or a target-GPU/long-flight
qualification claim.

## Work selection and next steps

Sequential work through milestone issues is not milestone closure or release
approval. Releases, milestone closure and real-media jobs still require explicit
owner approval; no issue status or acceptance is changed by this contract update.

Use concrete work issues and [ready next actions](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Aready%22)
for mutable progress. The [#2 identity proposal](design/SOURCE_RELINK.md) requires
approval of its strict storage/registration and confirmed-location contract before
implementation; no unsafe relink or automatic migration is introduced.
#5 covers the approved MIT license, dependency notices and native distribution review.
GPU/flight work requires owner setup/consent,
and containers remain a future milestone. The private repository-linked
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

| Issue                                                                                    | Scope                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1 — Deterministic raw-frame reader tests](https://github.com/Plonk42/PasCap/issues/1)  | Retain the locally verified exit-before-read fix; verify fresh Node 22/24 CI without hiding failures or weakening exact frame/resource checks                                                                                                                                         |
| [#2 — Explicit verified source relinking](https://github.com/Plonk42/PasCap/issues/2)    | Approve the [strong identity/atomic relink design](design/SOURCE_RELINK.md), then implement confirmed moved/remounted-original recovery; never guess from names                                                                                                                       |
| [#3 — Export disk preflight](https://github.com/Plonk42/PasCap/issues/3)                 | Explain scratch needs and handle low space without destroying original/successful data                                                                                                                                                                                                |
| [#4 — Entry bundle loading](https://github.com/Plonk42/PasCap/issues/4)                  | Measure and reduce initial JS without suppressing the warning or changing per-frame ownership                                                                                                                                                                                         |
| [#5 — License and redistribution notices](https://github.com/Plonk42/PasCap/issues/5)    | Approved MIT project terms, retained npm notices and the separate GPL-enabled native distribution contract                                                                                                                                                                            |
| [#12 — GitHub workflow](https://github.com/Plonk42/PasCap/issues/12)                     | Keep instructions/forms, categorized priorities, next actions and iteration/dependency tracking aligned                                                                                                                                                                               |
| [#13 — Shared-keyframe movement/navigation](https://github.com/Plonk42/PasCap/issues/13) | Retrospective delivered-feature record; preserve whole-keyframe transactions, independent channel navigation and dated evidence                                                                                                                                                       |
| [#14 — Precise clip speed](https://github.com/Plonk42/PasCap/issues/14)                  | Track approved source-frame curves and locally verified graph/numeric/native delivery separately from remote acceptance                                                                                                                                                               |
| [#16 — Compact contextual help](https://github.com/Plonk42/PasCap/issues/16)             | Heading-level hover/pinned question-mark buttons accessible even when collapsed, with independent expansion and preserved drafts/focus/editable panels                                                                                                                                |
| [#25 — Uniform video tracks](https://github.com/Plonk42/PasCap/issues/25)                | Uniform track parity: per-track continuous Ripple, transitions/fades, composition order and bounded simultaneous-dissolve preview/native export; [historical schema-6 design record](design/TRACK_PARITY.md), with current v12 usage in the [track contract](LAYERS_AND_KEYFRAMES.md) |

Done means a repeatable, documented local foundation—not more CapCut-style effects.
The initial publication includes README/user/developer guides, pinned CI and issue
forms. Those are delivered work, not duplicate open backlog tasks.

The local [UX-hardening update](UX_HARDENING.md) implements the #1 deterministic
raw-reader fix, #3 storage/recovery controls and genuine constrained-volume test,
and #4 measured loading boundaries, with simpler visual UI throughout. Delivery
and acceptance are recorded on those issues, not duplicated here. #2 has a
documented sampled-versus-full identity prerequisite; no unsafe relink action was
introduced. [Licensing](LICENSING.md) defines the approved project terms and
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

## v0.3 — Docker and Podman delivery

[Milestone](https://github.com/Plonk42/PasCap/milestone/3)

| Issue                                                                               | Scope                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [#9 — Explicit container networking](https://github.com/Plonk42/PasCap/issues/9)    | Internal bind configuration plus exact host-loopback Host/Origin/client protection                                  |
| [#10 — Reproducible local OCI package](https://github.com/Plonk42/PasCap/issues/10) | Built UI/service/native toolchain, read-only source binds, persistent data, non-root/rootless startup and shutdown  |
| [#11 — Both-runtime acceptance](https://github.com/Plonk42/PasCap/issues/11)        | Read-only-mount, permissions, persistence, cancellation/reaping and native short-export parity on Docker and Podman |

Implementation follows [the deployment contract](DEPLOYMENT.md). Licensing and
network configuration precede distribution; both-runtime acceptance follows the
image recipe. Real-workload qualification is a release gate, not an excuse to
bundle private footage or promise GPU-native encoding.

## Scope boundaries

- Original recordings are never uploaded, copied or automatically deleted.
- Strict local data remains explicit; no unrequested migrations or fallback fields.
- The application is local/single-user, not GitHub Pages, LAN hosting or remote SaaS.
- No new rendering effect is scheduled from an inspection checklist alone.
- [The implementation plan](../EDITOR_IMPLEMENTATION_PLAN.md) is retained as design
  history, not an approved implementation backlog.
- Titles, general-purpose masks, optical flow, HDR output or HDR footage (the track
  HDR look is an SDR effect), cloud/mobile/collaboration and native
  GPU encoding remain outside the current delivery milestones.

Proposals should explain a user problem, scope, observable acceptance and
dependencies. Do not attach private source files, licenses, credentials, complete
project snapshots or filesystem paths to public reports.
