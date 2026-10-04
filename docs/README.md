# Documentation

Next steps and dependencies: [ROADMAP.md](ROADMAP.md), backed by the actual GitHub
issues, milestones and iterations rather than an automatically approved feature
catalogue. [GITHUB_WORKFLOW.md](GITHUB_WORKFLOW.md) defines planning, labels,
priorities, progress and delivery updates.

## Start here

| Read | Use it for |
| --- | --- |
| [../README.md](../README.md) | Project overview, quick local start and current scope |
| [USER_GUIDE.md](USER_GUIDE.md) | Projects, no-copy import, repeated excerpts, timeline editing, clip speed curves, row keyframes, music/export and recovery |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Linux toolchain, commands, synthetic tests, planned CI, architecture and contributor safety |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Service-side source paths/API and security; planned local Docker/Podman packaging, **not a runnable container recipe** |

## Processing and editing contracts

| Document | Authority/scope |
| --- | --- |
| [COLOUR_AND_TIMING.md](COLOUR_AND_TIMING.md) | SDR grading and fade/dissolve/rational-frame equations; historical v3 animation-storage notes are superseded by the current row-point contract below |
| [LAYERS_AND_KEYFRAMES.md](LAYERS_AND_KEYFRAMES.md) | Current whole-row project-time points, ten opt-in channels, interpolation, navigation, movement, composition and resource bounds |
| [SPEED_AND_AUDIO.md](SPEED_AND_AUDIO.md) | Source-anchored constant/ramp/custom clip curves versus analytic project-time row Speed, precise curve editing, shared retiming and music/export audio |
| [TIMELINE_EDITING.md](TIMELINE_EDITING.md) | No-copy import, source ranges, ripple/overlay placement, recoverable trims, marked cuts, history and snapping |
| [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md) | Layout, field/keyboard contexts, project bins, serial saves/conflicts, Activity and failure recovery |
| [UX_HARDENING.md](UX_HARDENING.md) | Simplified visual controls, deterministic raw-reader ownership, relink identity prerequisite, export-space assumptions/ENOSPC evidence and measured loading boundaries |

Use current row-point and retiming contracts: colour/opacity animation remains
row-wide, while the separately approved clip-only speed curves use source frames.
Older clip-local animation descriptions are historical. Detailed documents preserve
implementation history; their older pending-status passages are not newer evidence
than the dated final verification table linked below.

## Status and planning

- [Current help UI verification](DELIVERY_STATUS.md#current-help-popover-verification)
  records the question-mark hover/pin/dismiss update separately from the
  [recorded 1,115-test core baseline](DELIVERY_STATUS.md#current-clip-speed-verification),
  remote CI and hardware qualification. [DELIVERY_STATUS.md](DELIVERY_STATUS.md)
  also preserves prior milestones, native resource bounds and remaining acceptance gates.
- [FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md): **historical** two-source preview/
  colour evidence. It does not qualify current layered throughput or the intended GPU.
- Follow planned work in [GitHub issues](https://github.com/Plonk42/PasCap/issues)
  and [milestones](https://github.com/Plonk42/PasCap/milestones), with
  [the current iteration](https://github.com/Plonk42/PasCap/issues/15), native
  dependencies and categorized/prioritized labels. The
  [workflow](GITHUB_WORKFLOW.md) distinguishes local completion from actual-commit
  CI/review; Projects access is currently unavailable. Tracking is not proof of
  completed CI, containers or real-flight acceptance.
- [../EDITOR_IMPLEMENTATION_PLAN.md](../EDITOR_IMPLEMENTATION_PLAN.md) retains the
  original plan and chronology.
