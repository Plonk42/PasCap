# UX and local hardening · 2026-10-04

## Simpler presentation, unchanged editing contract

- **Media / Inspector toggles and keyboard help** are directly in the header.
  Workspace options keeps infrequent layout reset and Diagnostics.
- The **selected excerpt or whole-row context comes first** in Inspector.
  Collapsed sections have relevant icons, compact duration/rate readouts and an
  adjusted-state dot; expanding preserves every control and existing preferences.
- Animation no longer repeats a paragraph below every control. Static values use
  the normal treatment; animated values have a **curve icon and amber diamond**,
  dashed between keys and filled at a participating playhead point. **Animation
  help** explains the states once. Titles and screen-reader descriptions retain
  each setting's scope and capture instructions.
- All **ten diamonds still have adjacent Previous/Next SVG buttons**, followed by
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

No rendering feature, editing command, project membership, source-copy prohibition
or strict schema-5 field was removed or migrated. Existing clips, row points,
source choices, media preparation, music, Activity, receipts and both export
profiles remain supported. The editor still targets desktop Linux; the 640 px
width floor is not a mobile-support claim.

## Issue #1: deterministic raw-reader ownership

The previous two-reader/one-encoder test could report **right ended before its
exact selected frame count / SOURCE OUT**, despite the right child exiting zero.
Creating a readable async iterator does not start consuming it. Node's child
exit `flushStdio()` resumes untouched stdout; the second reader's bytes could be
drained while the first reader was awaited.

A new regression deliberately awaits the right child's **close before requesting
its first frame**. It failed with the original implementation and exact reported
EOF, then passed with `RawFrameReader.create()` starting one initial iterator read
immediately. The first bounded chunk or failure is retained; subsequent chunks
are requested only as frames consume it. Early errors are recorded without an
unhandled rejection. There is no duration-sized buffering or unbounded read-ahead.

Exact selected-frame/EOF/truncation checks, backpressure, cancellation/reaping and
the two-reader/one-encoder limits remain. The original regression is unchanged;
no retry, skip or EOF tolerance was added. Local Node 22.23.3 and 24.21.0 complete
unit suites and independent focused runs passed. A fresh GitHub-runner result is
still a separate acceptance step; local results are not remote CI evidence.

## Issue #2: identity evidence before relinking

The current registry's **sampled-sha256-v1** digest hashes size, modification time,
device/inode, offsets and at most three 1 MiB byte samples (beginning/middle/end).
It does **not** hash the complete recording. `assertSourceIdentity(..., true)`
recomputes those same samples; the `deep` argument is not full-byte verification.

Disposable regressions demonstrate both limits:

| Operation | Current evidence |
| --- | --- |
| Same-device/inode rename preserving modification time and bytes | Fingerprint and derived media/cache identity remain identical; old registered path is still missing |
| Different device/inode, changed time or size | Fingerprint identity changes, even if every content byte is identical |
| Unsampled byte changed in an 8 MiB file, preserving size/time/device/inode | Full-file SHA-256 changes but the stored sampled fingerprint does not |

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
   or user-footage hash job is introduced in this update.
4. An explicit approved-location proposal must show old/new paths, verify all
   required evidence and require confirmation; commit atomically only if source,
   association and active-job state still match. Failure keeps the old association.
5. If the original is already missing without strong baseline evidence, explain
   that limitation rather than accepting a name/sample-only association.

**Issue #2 remains pending.** Missing-source guidance now first recommends
reconnecting the drive or restoring the original at its registered path. No
misleading relink button, whole-filesystem search or hidden reassociation was added.

## Issue #3: export storage and recovery

`POST /api/exports/preflight` validates the submitted strict document and registered
metadata, then reads filesystem metadata only. It neither reads source bytes nor
probes, prepares, saves or admits a job. It uses the existing renders volume when
present, otherwise the data directory, rejecting symlinked locations. Outputs and
the job's work directory share that volume.

### Advisory planning allowance

The displayed allowance is duration/profile dependent:

- Up to the two largest enabled retimed clips at **4 uncompressed bytes/pixel**.
- For layered/animated export, two complete timeline representations at
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

### Actual observations and disk-full acceptance

Short disposable native checks sampled **allocated regular-file blocks** at progress
callbacks:

| 720p workload | Maximum observed allocation | Samples | Planning allowance |
| --- | ---: | ---: | ---: |
| Static, 168 frames / multiple retimed graded clips | 10,801,152 B | 210 | 684,937,216 B |
| Layered, 19 frames / three compositing passes | 1,150,976 B | 96 | 470,665,216 B |

Directory metadata and peaks between samples were **not measured**. These short,
highly compressible examples do not qualify noisy long 4K footage or justify
advertising a fixed disk bound.

A separate explicit Linux test creates a **private user/mount namespace** and
32 MiB tmpfs. It produces one real verified short export, saves a disposable
project, then exhausts the volume with a noisy synthetic longer export. Actual
native **ENOSPC** fails clearly; no partial MP4/receipt is published. Cleanup
recovers all failed-job allocation while preserving the completed export/receipt,
saved project and original fingerprint. A recorded run restored exactly
**32,329,728 B free** on a **33,554,432 B** volume.

The test requires `unshare`, `mount`, `umount` and enabled unprivileged user
namespaces; `npm run test:space` is a separate opt-in. No sudo, privileged host mount,
existing user directory or shared disk filling is used. Its CI-host portability is
not yet qualified. Filesystem/native ENOSPC and quota unit cases also verify
job-owned cleanup and preservation. Quota errors explain quota-specific recovery.

## Issue #4: measured loading boundaries

The production build now defers the preview decoder/compositor bootstrap, Inspector
and optional Diagnostics. Existing lazy dialogs/source review/footage browsing
remain. Per-frame rendering still belongs to the preview engine outside React;
loading a module performs no media preparation or hidden job.

| Measurement | Previous build | This update |
| --- | ---: | ---: |
| Entry JavaScript, minified | 535.03 kB | 370.62 kB |
| Entry gzip | 161.17 kB | 113.88 kB |
| Entry plus eager shared JS | 535.03 kB | approximately 481.29 kB |
| Eager shared JS gzip | included above | approximately 147.16 kB total |
| Default editor after deferred preview/Inspector JS | included above | approximately 544.42 kB / 168.21 kB gzip |

The entry reduction is **30.7%**, not a claim that the entire editor download or
GPU performance improved by 30.7%. Default-visible Inspector and preview still
load their chunks after the shell; code splitting redistributes work and adds
requests. Totals sum the production build's per-chunk reports; the new default
editor graph is slightly larger overall because of the added UI/recovery features.
The 500 kB warning is gone without raising or suppressing its threshold.

Loading states keep the shell available. A failed preview or panel import cannot
discard its in-memory project. Browsers cache failed module imports, so recovery
offers **Reload editor**, guarded by saving pending edits first, plus a strict
project download. A save failure prevents reload and retains the draft. Runtime
preview failures still have their ordinary **Retry preview** action. Hidden
Inspector panels stay mounted, retaining section state and normal one-time
Enter/blur commits; all keyboard/focus/history and two-decoder assertions remain.

## Remaining gates

This update does not choose the maintainer's license, claim new GitHub CI evidence,
perform an intended-GPU or long real-flight run, or ship a Docker/Podman image.
Issues #5–#11 retain their approvals/dependencies. No real user import,
preparation, long render, saved-project edit or original modification was used
for verification.