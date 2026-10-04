# Roadmap

GitHub [issues](https://github.com/Plonk42/PasCap/issues) and
[milestones](https://github.com/Plonk42/PasCap/milestones) are the execution system
of record, with native dependencies/sub-issues, labeled priority/progress and
iteration tracking. Each triaged issue has scope, acceptance, non-goals and an
explicit next action. Follow [the GitHub workflow](GITHUB_WORKFLOW.md); this page
indexes outcomes, not a competing mutable backlog. Milestones have no invented
deadline; hardware/real-media work requires explicit owner consent.

## Current baseline

The local schema-5 editor implements no-copy footage import, projects, source
excerpts, layered timelines, colour/speed/opacity row points, music and verified
720p/4K export, with precise clip-only speed curves as well as overriding row Speed.
The current **1,115-test** local correctness baseline is recorded in
[delivery evidence](DELIVERY_STATUS.md#current-clip-speed-verification). Repository
publication and CI are not a container release or a target-GPU/long-flight
qualification claim.

## Current iteration and next steps

[#15 — Editor delivery and GitHub workflow](https://github.com/Plonk42/PasCap/issues/15)
groups the existing hardening delivery (#1, #3, #4), workflow alignment (#12) and
feature records (#13, #14). Its checkpoints distinguish local commits/checks from
publication, actual-commit CI and maintainer acceptance; none of these issues is
closed automatically. The date identifies the batch, not a sprint deadline.

Use its linked issues and [ready next actions](https://github.com/Plonk42/PasCap/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Aready%22)
for mutable progress. #2 is ready for identity design, not unsafe relink implementation;
#5 needs a maintainer license decision. GPU/flight work requires owner setup/consent,
and containers remain a future milestone. Projects access is unavailable; the native
iteration issue/labels are usable now, without a fictitious board.

## v0.1 — Local editor hardening

[Milestone](https://github.com/Plonk42/PasCap/milestone/1)

| Issue | Scope |
| --- | --- |
| [#1 — Deterministic raw-frame reader tests](https://github.com/Plonk42/PasCap/issues/1) | Retain the locally verified exit-before-read fix; verify fresh Node 22/24 CI without hiding failures or weakening exact frame/resource checks |
| [#2 — Explicit verified source relinking](https://github.com/Plonk42/PasCap/issues/2) | Recover moved/remounted originals with confirmation and documented identity evidence; never guess from names |
| [#3 — Export disk preflight](https://github.com/Plonk42/PasCap/issues/3) | Explain scratch needs and handle low space without destroying original/successful data |
| [#4 — Entry bundle loading](https://github.com/Plonk42/PasCap/issues/4) | Measure and reduce initial JS without suppressing the warning or changing per-frame ownership |
| [#5 — License and redistribution notices](https://github.com/Plonk42/PasCap/issues/5) | Obtain a maintainer decision and inventory actual npm/native distribution obligations |
| [#12 — GitHub workflow](https://github.com/Plonk42/PasCap/issues/12) | Keep instructions/forms, categorized priorities, next actions and iteration/dependency tracking aligned |
| [#13 — Shared-point movement/navigation](https://github.com/Plonk42/PasCap/issues/13) | Retrospective delivered-feature record; preserve whole-point transactions, independent channel navigation and dated evidence |
| [#14 — Precise clip speed](https://github.com/Plonk42/PasCap/issues/14) | Track approved source-frame curves and locally verified graph/numeric/native delivery separately from remote acceptance |

Done means a repeatable, documented local foundation—not more CapCut-style effects.
The initial publication includes README/user/developer guides, pinned CI and issue
forms. Those are delivered work, not duplicate open backlog tasks.

The local [UX-hardening update](UX_HARDENING.md) implements the #1 deterministic
raw-reader fix, #3 storage/recovery controls and genuine constrained-volume test,
and #4 measured loading boundaries, with simpler visual UI throughout. This is
local evidence, not issue closure or new remote CI. #2 has a documented sampled-
versus-full identity prerequisite; no unsafe relink action was introduced. #5
still requires a maintainer decision.

The separately approved clip-speed extension adds presets and editable source-frame
curves without replacing row animation. It is committed in logical steps under
[repository instructions](../.github/copilot-instructions.md) and tracked in #14;
it does not approve new optical-flow effects or private-media/hardware qualification
work. `status:local-complete` records verified local delivery, not issue closure.

## v0.2 — Real-workload qualification

[Milestone](https://github.com/Plonk42/PasCap/milestone/2)

| Issue | Scope |
| --- | --- |
| [#6 — Intended-GPU preview](https://github.com/Plonk42/PasCap/issues/6) | Record the actual renderer and test nominal playback, scrubbing, ramps/dissolves and row animation |
| [#7 — Complete 5–10 minute flight edit](https://github.com/Plonk42/PasCap/issues/7) | Consented, licensed inputs; save/reopen, full preview, verified draft/final exports and interruption behaviour |
| [#8 — A/V and resource soak](https://github.com/Plonk42/PasCap/issues/8) | Measure browser/GPU/native children/scratch and audible loop/buffering behaviour over realistic duration |

The long-flight run uses intended-GPU findings and export-space safety from v0.1.
Synthetic/SwiftShader CI cannot close the hardware gate. Failures must produce
reproducible follow-ups, not relaxed frame/pixel/timing assertions.

## v0.3 — Docker and Podman delivery

[Milestone](https://github.com/Plonk42/PasCap/milestone/3)

| Issue | Scope |
| --- | --- |
| [#9 — Explicit container networking](https://github.com/Plonk42/PasCap/issues/9) | Internal bind configuration plus exact host-loopback Host/Origin/client protection |
| [#10 — Reproducible local OCI package](https://github.com/Plonk42/PasCap/issues/10) | Built UI/service/native toolchain, read-only source binds, persistent data, non-root/rootless startup and shutdown |
| [#11 — Both-runtime acceptance](https://github.com/Plonk42/PasCap/issues/11) | Read-only-mount, permissions, persistence, cancellation/reaping and native short-export parity on Docker and Podman |

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
- Titles, transforms, masks, optical flow, HDR, cloud/mobile/collaboration and native
  GPU encoding remain outside the current delivery milestones.

Proposals should explain a user problem, scope, observable acceptance and
dependencies. Do not attach private source files, licenses, credentials, complete
project snapshots or filesystem paths to public reports.
