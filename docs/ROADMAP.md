# Roadmap

GitHub [issues](https://github.com/Plonk42/PasCap/issues) and
[milestones](https://github.com/Plonk42/PasCap/milestones) are the execution backlog.
Each issue has scope, acceptance criteria and non-goals. These milestones have no
invented deadline; hardware/real-media work requires explicit owner consent.

## Current baseline

The local schema-5 editor implements no-copy footage import, projects, source
excerpts, layered timelines, colour/speed/opacity row points, music and verified
720p/4K export. The local correctness baseline is 982 tests; see
[delivery evidence](DELIVERY_STATUS.md). Repository publication and CI are not a
container release or a target-GPU/long-flight qualification claim.

## v0.1 — Local editor hardening

[Milestone](https://github.com/Plonk42/PasCap/milestone/1)

| Issue | Scope |
| --- | --- |
| [#1 — Deterministic raw-frame reader tests](https://github.com/Plonk42/PasCap/issues/1) | Diagnose the observed intermittent early EOF; preserve exact frame/resource checks and avoid retries that hide it |
| [#2 — Explicit verified source relinking](https://github.com/Plonk42/PasCap/issues/2) | Recover moved/remounted originals with confirmation and documented identity evidence; never guess from names |
| [#3 — Export disk preflight](https://github.com/Plonk42/PasCap/issues/3) | Explain scratch needs and handle low space without destroying original/successful data |
| [#4 — Entry bundle loading](https://github.com/Plonk42/PasCap/issues/4) | Measure and reduce initial JS without suppressing the warning or changing per-frame ownership |
| [#5 — License and redistribution notices](https://github.com/Plonk42/PasCap/issues/5) | Obtain a maintainer decision and inventory actual npm/native distribution obligations |

Done means a repeatable, documented local foundation—not more CapCut-style effects.
The initial publication includes README/user/developer guides, pinned CI and issue
forms. Those are delivered work, not duplicate open backlog tasks.

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