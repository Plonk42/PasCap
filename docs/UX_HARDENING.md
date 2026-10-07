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
- All **nine diamonds have adjacent Previous/Next SVG buttons**, followed by
  any reset. Explicit capture, real-playhead values, shared point movement,
  off-duration inspection, every participant and one-step Undo remain unchanged.
- **Clip → Colour** contains the single **Opacity** slider/diamond/navigation
  alongside the colour sliders, initially **100%**. Without Opacity keys it edits
  row `opacity`, including on an empty row; keyed `opacity` overrides that value
  on every clip and both dissolve sources. Sliders never create keys; animated
  values without a participant at the real playhead are read-only until explicitly
  captured with the diamond. Unkeyed colour settings remain per-clip; Opacity
  controls composition coverage, not SDR RGB grading. **Placement** contains
  placement only. There is no sidebar duplicate; Layer options contains only
  rename, Ripple, ordering and deletion, with visibility separate in the sidebar.
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

Schema 9 requires clip spatial base/full-pose source-frame keys and uses a
required 0–8 `music` array with unique required instance IDs and
uniform video tracks with required Ripple/transitions/fades and
numeric `VideoLayer.opacity` in 0–1 (1 on new tracks), plus nine nullable point
channels: `opacity`, `speed` and seven colour settings. Rows
follow saved bottom-to-top composition order. Layer options exposes default-on
Ripple: enabling closes gaps from the first current start in one Undo; while on,
later clips continuously sequence there. Turning it off keeps actual placements.
Later Ripple starts/nudges explain how to reorder or turn Ripple off; only the
first anchor can move while on. Other tracks, music and absolute row points stay
put. Every track can be reordered/deleted except the last remaining track; stack
endpoint restrictions have accessible reasons.

Track-local black fades preserve coverage; simultaneous track dissolves use the
premultiplied group math $C = \sum_i G_i b_i o_i w_i m_i$, $A = \sum_i o_i w_i m_i$ and
$\mathrm{result} = C + \mathrm{lower}(1 - A)$, without a layer multiplier.
Here $G_i$ is graded RGB, $b_i$ black-fade brightness, $o_i$ evaluated Opacity and
$w_i$ dissolve weight and $m_i$ spatial pixel coverage. Exact neutral poses
preserve opaque black letterboxing after grading; nonneutral uncovered pixels
reveal lower footage. Each source uses the same evaluated row Opacity at that
project frame, from the row value or its overriding curve.
v1–v8 project/receipt snapshots remain unchanged/incompatible
and require recreation, without migration, defaults or automatic deletion.
Row `opacity` is the required sole stored value, not obsolete; saved `clip.opacity`
and old `clipOpacity`/`layerOpacity` point channels are invalid.
Registry/proxy/current PCM formats do not change. Version-1 export receipts require
strict v9 snapshots and captured audio-source/instance-plan arrays, rejecting
invalid arrays/older snapshots without rewriting successful exports. No null
fallback or old-format reader is permitted. Source-copy prohibition,
row points, source choices, media preparation, Activity and both export
profiles retain their contracts. The editor targets desktop Linux; the 640 px
width floor is not a mobile-support claim.

**Clip → Transform** is the fifth top-level section, collapsed for new
preferences and included in Clip's bulk expansion. Native sliders/exact fields
and one full-pose source-frame diamond retain explicit capture, read-only keyed
main values without a key at the real displayed source frame, release-only
drafts and editable invalid numbers. Stored-key navigation distinguishes stored
source time from the closest actually mapped preview, including off-trim and
original exclusive-OUT anchors. This is clip-local, not another row channel.
See [the spatial contract](design/SPATIAL_TRANSFORMS.md); no fresh UI acceptance
or throughput result is implied.

**Audio → Music** uses native **Music track / Recording** selectors, **Add music
track** and selected-instance trash deletion. Ready/prepared recordings can be
reused by independent instances; import never implicitly places one. Selection
is editor-only; edits/removal leave other instances and bin membership intact.
Independent drafts never apply to another selection. Each valid commit/completed
gesture is one Undo step; invalid/cancelled operations remain atomic.
Project duration is maximum video OUT or music start + duration. Music can extend
it: closing video fades end at their clip OUT, followed by opaque black while
music continues/fades at its own OUT, never a frozen image. Music-only preview is
black; export requires a retained video clip. The
[multiple-music contract](design/MULTIPLE_MUSIC.md) records pending acceptance,
not a fresh UI or runtime validation result.

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
  **8 uncompressed bytes/pixel**; disabled-layer tails and music OUTs count in full
  project duration. Music beyond video OUT requires this path's black tail.
- Encoded chunks plus final MP4, each budgeted at **1 byte/pixel/frame**.
- **Maximum selected music PCM size**, **48 kHz stereo s16**, plus **two full-project
  Float64 stereo timelines**. Only one selected source and old/new accumulators
  coexist; not the sum of all original/selected files or every loop repetition.
  With $S$ project samples and $L_i$ selected source samples, audio planning is
  $4\max_i L_i + 2\times16S$ bytes when music exists, zero without music, before overhead.
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
fast path requires one enabled, unanimated, zero-origin contiguous track
with row Opacity 1, exactly neutral spatial bases and no spatial keys; spatial
edits/keys (even neutral keys) or unsupported placement/coverage use generalized
layered export, with unchanged raw-buffer/LUT/process budgets.

That static track must cover full project duration; music-only tails require
layered black, without stretching video closing fades or holding a last image.
Audio processes **one original at a time** into selected s16 PCM and serially
pairwise-sums with a **Float64 stereo accumulator**. At most **two intermediate
audio inputs**, **one native audio child per pass** and **three audio scratch files**
(selected PCM + old/new accumulators) coexist, deleting consumed inputs before the
next instance. Apply per-instance gain/fades, sum without normalisation or
intermediate clipping, then hard-clamp once before final AAC. There is no ducking,
effect or video audio. These audio allocations are additional to the unchanged
video bounds above and remain duration-dependent on disk.

Preview instances share one AudioContext/worklet/output clock and **four × 128 KiB**
mixed queue blocks total, serial source reads with **64 KiB** range scratch, one
**128 KiB conversion workspace** and one **128 KiB mixed-output workspace**. No
per-track queues/full-file buffers; exact one-frame A/V, source failure/underrun and
epoch cancellation remain strict. No new validation results are claimed here.

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
