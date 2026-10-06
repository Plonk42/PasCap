# UX and local hardening

Current presentation, source-safety, native ownership, storage and loading
contracts. Dated verification and measurements belong on the corresponding
[work issues](https://github.com/Plonk42/PasCap/issues), with
[GitHub Actions](https://github.com/Plonk42/PasCap/actions) for actual-commit CI.
This guide is not a delivery ledger or a fresh validation result.

## Presentation and track controls

- **Media / Inspector toggles and keyboard help** are directly in the header.
  Workspace options keeps infrequent layout reset and Diagnostics.
- The **selected excerpt or whole-row context comes first** in Inspector.
  Collapsed sections have relevant icons, compact duration/rate readouts and an
  adjusted-state dot; expanding preserves every control and existing preferences.
- Animation uses contextual help rather than a paragraph below every control. Static values use
  the normal treatment; animated values have a **curve icon and amber diamond**,
  dashed between keys and filled at a participating playhead point. **Animation
  help** explains the states once. Titles and screen-reader descriptions retain
  each setting's scope and capture instructions.
- All **ten diamonds have adjacent Previous/Next SVG buttons**, followed by
  any reset. Explicit capture, real-playhead values, shared point movement,
  off-duration inspection, every participant and one-step Undo remain unchanged.
- Timeline tools form **edit** and **marked-range removal** groups. Temporary
  IN/OUT state appears on the buttons and timeline selection rather than adding
  another toolbar row. Compact windows use labelled, focusable icon controls;
  shortcuts, accessible names and explanatory titles remain available.
- Media **Add** stays visible. Search and active filters have direct clear
  actions; partial selection uses the native mixed checkbox state. Readiness has
  an icon and accessible status, not only a colour dot.
- Export quality uses two **native radio cards**. Storage has a meter, explicit
  uncertainty, errors/recheck and disclosed location/assumptions. Snapshot and
  native processing details remain available in **Rendering details**.

Schema 6 uses uniform video tracks with required Ripple/transitions/fades. Rows
follow saved bottom-to-top composition order. Layer options exposes default-on
Ripple: enabling closes gaps from the first current start in one Undo; while on,
later clips continuously sequence there. Turning it off keeps actual placements.
Later Ripple starts/nudges explain how to reorder or turn Ripple off; only the
first anchor can move while on. Other tracks, music and absolute row points stay
put. Every track can be reordered/deleted except the last remaining track; stack
endpoint restrictions have accessible reasons.

Track-local black fades preserve coverage; simultaneous track dissolves use the
same group math. v1–v5 project/receipt snapshots remain unchanged/incompatible,
without migration; registry/proxy formats do not change. Source-copy prohibition,
row points, source choices, media preparation, music, Activity and both export
profiles retain their contracts. The editor targets desktop Linux; the 640 px
width floor is not a mobile-support claim.

## Issue #1: deterministic raw-reader ownership

Creating a readable async iterator does not start consuming it. Node's child-exit
`flushStdio()` can drain untouched stdout while another reader is awaited, even
with a successful exit. `RawFrameReader.create()` starts one initial iterator read
immediately. Its first bounded chunk or failure is retained; subsequent chunks
are requested only as frames consume it. Early errors are recorded without an
unhandled rejection. There is no duration-sized buffering or unbounded read-ahead.

The deterministic regression waits for the second child's **close before requesting
its first frame**. Preserve exact selected-frame/EOF/truncation checks, backpressure,
cancellation/reaping and two-reader/one-encoder pass limits. Retries, skipped cases
or EOF tolerances are not substitutes for bounded read ownership. Local checks and
actual-commit remote CI remain separate evidence.

## Issue #2: identity evidence before relinking

The current registry's **sampled-sha256-v1** digest hashes size, modification time,
device/inode, offsets and at most three 1 MiB byte samples (beginning/middle/end).
It does **not** hash the complete recording. `assertSourceIdentity(..., true)`
recomputes those same samples; the `deep` argument is not full-byte verification.

The identity limitations are:

| Operation                                                                  | Consequence                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Same-device/inode rename preserving modification time and bytes            | Fingerprint and derived media/cache identity remain identical; old registered path is still missing |
| Different device/inode, changed time or size                               | Fingerprint identity changes, even if every content byte is identical                               |
| Unsampled byte changed in an 8 MiB file, preserving size/time/device/inode | Full-file SHA-256 changes but the stored sampled fingerprint does not                               |

Video IDs derive from the sampled digest; proxy directories also use that digest.
Projects refer to media IDs, **not source paths on each clip**. Re-registering a
same-inode rename finds the existing asset and does not update its missing path.
Changing a candidate's filesystem fingerprint without separating stable cache
identity would also move the lookup away from its existing prepared proxy.

Therefore a full moved/remounted-source relink cannot honestly be labelled
full-content verified using this registry alone. A candidate's new full checksum
is not evidence of equality with a missing original whose full checksum was never
captured. Timing/colour metadata and matching filenames are not a substitute.

The implementation prerequisite is an explicit strong identity design:

1. Capture a full streamed checksum of a **known-good, readable original** before
   it is unavailable, with unchanged-before/after source checks.
2. Keep stable asset/proxy identity separate from the current location's
   device/inode evidence; preserve references, prepared files and completed receipts.
3. Document the required evidence storage/version and its strict incompatibility
   policy before implementation. No optional legacy default, migration, cache move
   or implicit user-footage hash job is permitted.
4. An explicit approved-location proposal must show old/new paths, verify all
   required evidence and require confirmation; commit atomically only if source,
   association and active-job state still match. Pre-commit failure keeps the old
   association; lost post-commit acknowledgement requires honest readback/recovery,
   not promised rollback or a blind retry.
5. If the original is already missing without strong baseline evidence, explain
   that limitation rather than accepting a name/sample-only association.

**Relinking is not implemented.** Missing-source guidance recommends reconnecting
the drive or restoring the original at its registered path. There is no relink
button, whole-filesystem search or hidden reassociation.
The [separate proposed relink contract](design/SOURCE_RELINK.md) specifies full
baseline evidence, immutable asset/cache identity, strict format implications and
confirmed atomic location changes. It requires explicit approval before implementation;
the current registry and usage behaviour are unchanged.

## Issue #3: export storage and recovery

`POST /api/exports/preflight` validates the submitted strict document and registered
metadata, then reads filesystem metadata only. It neither reads source bytes nor
probes, prepares, saves or admits a job. It uses the existing renders volume when
present, otherwise the data directory, rejecting symlinked locations. Outputs and
the job's work directory share that volume.

### Advisory planning allowance

The displayed allowance is duration/profile dependent:

- Up to the two largest enabled retimed clips at **4 uncompressed bytes/pixel**.
- For generalized layered export, up to **three** timeline representations at
  **8 uncompressed bytes/pixel**; disabled-layer tails still count in timeline duration.
- Encoded chunks plus final MP4, each budgeted at **1 byte/pixel/frame**.
- Selected active music PCM once, **48 kHz stereo s16**, not a whole original or
  every loop repetition.
- A **25% margin plus 16 MiB start reserve** for containers, LUTs, receipts and other
  overhead.

These are explicit planning assumptions, **not FFV1/H.264 upper bounds or actual
compressed-size predictions**. Frame content, compression, other filesystem users,
permissions and quotas can change actual needs. Space is not reserved.

Below the allowance is an advisory warning, not an invented hard codec limit.
Below the 16 MiB start reserve, submission and worker startup fail clearly before
native work. That reserve is **not enough for the complete render**. Submission
and worker start both re-read free space, since a queued job can start much later.
Permission/mount/check failures disable submission until an explicit recheck;
stale or cancelled profile reads cannot replace the current result.

### Disk-full recovery and applicable validation

Generalized layered export renders each track's premultiplied RGBA16 group, then
merges it over the lower accumulator without regrading. It retains up to two clip
files and three timeline representations, including a span collection as one.
Four reusable raw buffers use **22 bytes/pixel = 182,476,800 bytes at UHD**; the
two 65³ Float32 LUTs add **6,591,000 bytes**, excluding native/audio memory.
One original decoder, two intermediate readers, one encoder and three video children
per serial pass bound concurrency, not duration-dependent disk use. The static
fast path requires one enabled opaque, unanimated, zero-origin contiguous track
and opaque clips; unsupported placement/coverage uses generalized layered export.

Allocated-block sampling at progress callbacks is a measurement procedure, not a
fixed bound: directory metadata and peaks between samples need separate accounting.
Short, compressible fixtures cannot qualify noisy long 4K footage. Record measured
values against the actual commit on the work issue, not against an old allowance.

The explicit Linux storage regression creates a **private user/mount namespace** and
32 MiB tmpfs. It produces one verified short synthetic export, saves a disposable
project, then exhausts the volume with a noisy synthetic longer export. Actual
native **ENOSPC** fails clearly; no partial MP4/receipt is published. Cleanup
recovers all failed-job allocation while preserving the completed export/receipt,
saved project and original fingerprint.

The test requires `unshare`, `mount`, `umount` and enabled unprivileged user
namespaces; `npm run test:space` is a separate opt-in. No sudo, privileged host mount,
existing user directory or shared disk filling is used. Its CI-host portability is
not yet qualified. Filesystem/native ENOSPC and quota unit cases also verify
job-owned cleanup and preservation. Quota errors explain quota-specific recovery.

## Issue #4: deferred loading boundaries

The production build defers the preview decoder/compositor bootstrap, Inspector
and optional Diagnostics. Existing lazy dialogs/source review/footage browsing
remain. Per-frame rendering still belongs to the preview engine outside React;
loading a module performs no media preparation or hidden job.

Default-visible Inspector and preview still load their chunks after the shell;
code splitting redistributes work and adds requests, not a GPU-performance gain.
Measure entry, eager shared and deferred chunks separately for the actual build.
Do not raise or suppress a bundle-warning threshold to substitute for measurement.

Loading states keep the shell available. A failed preview or panel import cannot
discard its in-memory project. Browsers cache failed module imports, so recovery
offers **Reload editor**, guarded by saving pending edits first, plus a strict
project download. A save failure prevents reload and retains the draft. Runtime
preview failures still have their ordinary **Retry preview** action. Hidden
Inspector panels stay mounted, retaining section state and normal one-time
Enter/blur commits. Keyboard/focus/history contracts and the two-slots-per-track
preview bound remain; eight tracks have 16 slots plus one separate source reviewer.

## Remaining gates

The approved project MIT terms and separate distribution requirements are in
[LICENSING.md](LICENSING.md). Intended-GPU playback, consented long real-flight/A/V
qualification and Docker/Podman delivery retain their separate gates. This document
claims no fresh test results, CI pass, real-media run, release or container acceptance.
