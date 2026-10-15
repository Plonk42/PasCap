# UX and local hardening

Current presentation, source-safety, native ownership, storage and loading
contracts. Dated verification and measurements belong on the corresponding
[work issues](https://github.com/Plonk42/PasCap/issues), with
[GitHub Actions](https://github.com/Plonk42/PasCap/actions) for actual-commit CI.
This guide is not a delivery ledger or a fresh validation result.

## Presentation and track controls

- **Keyboard help** is directly in the header. Workspace options holds the
  Media/Clip panel toggles, layout reset and Diagnostics.
- The **selected clip or whole-track context comes first** in Inspector.
  Collapsed sections have relevant icons, compact duration/rate readouts and an
  adjusted-state dot; expanding preserves every control and existing preferences.
- Animation uses contextual help rather than a paragraph below every control. Static values use
  the normal treatment; main capture diamonds are always visible: hollow when the setting is not enabled at the real playhead,
  filled when enabled. **Animation help** explains the states once. Titles and screen-reader descriptions retain
  each setting's scope and capture instructions.
- Each main scalar Colour/Opacity diamond retains adjacent per-setting **Previous/Next** buttons
  because not every setting is enabled at every shared keyframe.
- Each expanded section's keyframe line shows the keyframe count, one **Previous/Next** pair and Reset.
  Colour visits Opacity/scalar colour keyframes; Speed visits
  all retained custom speed source keyframes of the selected clip (its single
  **Keyframe Speed** circle has no extra per-setting arrows). Speed stored
  navigation includes off-trim/original-exclusive-OUT keyframes, previewing the
  nearest mapped image with a clip-local stored-source cursor; Transform visits its
  stored track keyframes, including those after the duration, with a track-local
  cursor previewing the nearest available frame. Both are separate from central
  track inspection. Successive stored keyframes stay reachable even
  when they preview the same image. Enabled setting chips in stored
  Colour keyframe rows retain their per-channel arrows. All main and stored per-channel
  arrows visit strictly earlier/later keyframes where that channel is nonnull
  (zero is enabled), sharing the central off-duration inspection cursor.
  Main capture uses the real displayed frame; navigation never edits or saves.
  Timeline speed markers still
  omit off-trim keyframes, with exclusive OUT represented by a boundary marker.
- **Track → Colour** contains the single **Opacity** slider/diamond/navigation
  alongside the colour sliders, initially **100%**. Without Opacity keyframes it edits
  track `opacity`, including on an empty track; keyed `opacity` overrides that value
  on every clip and both dissolve sources. Sliders never create keyframes; animated
  values without an enabled setting at the real playhead are read-only until explicitly
  captured with the diamond. Unkeyed colour settings are track-owned; Opacity
  controls composition coverage, not SDR RGB grading. **Placement** contains
  placement only. There is no sidebar duplicate; Track options contains only
  rename, Ripple, ordering and deletion, with visibility separate in the sidebar.
- **Temperature / Tint** are video track-owned normalized −1…1 scalar Colour controls,
  neutral/reset 0, with the same exact field, release-only slider, explicit capture
  and channel-navigation pattern, including on empty tracks. Positive Temperature
  warms; positive Tint adds magenta. Nonzero values intentionally colour greys;
  normalized linear gains precede Exposure, preserving neutral-white luminance
  before clipping only. Static HSL/curves add no channels. See
  [Temperature and Tint](design/TEMPERATURE_AND_TINT.md).
- Timeline tools form **edit** and **marked-range removal** groups. Temporary
  IN/OUT state appears on the buttons and timeline selection rather than adding
  another toolbar. Compact windows use labelled, focusable icon controls;
  shortcuts, accessible names and explanatory titles remain available.
- Media **Add** stays visible. Search and active filters have direct clear
  actions; partial selection uses the native mixed checkbox state. Readiness has
  an icon and accessible status, not only a colour dot.
- Export quality uses two **native radio cards**. Storage has a meter, explicit
  uncertainty, errors/recheck and disclosed location/assumptions. Snapshot and
  native processing details remain available in **Rendering details**.

Schema 22 requires complete video track Colour with Temperature/Tint/Vibrance/Whites/Blacks/HDR and static HSL/curves,
video track Transform base/per-setting project-frame keyframes, a boolean clip `reverse` and uses a
required 0–8 `music` array with unique required music track IDs and
uniform video tracks with required Ripple/transitions/fades and
numeric `VideoLayer.opacity` in 0–1 (1 on new tracks), plus fourteen nullable keyframe
channels: `opacity`, twelve scalar colour settings and `hdr`. Video tracks
follow saved bottom-to-top composition order. Track options exposes default-on
Ripple: enabling closes gaps from the first current start in one Undo; while on,
later clips continuously sequence there. Turning it off keeps actual placements.
Later Ripple starts/nudges explain how to reorder or turn Ripple off; only the
first anchor can move while on. Other tracks, music and absolute track keyframes stay
put. Every track can be reordered/deleted except the last remaining track; stack
endpoint restrictions have accessible reasons.

Track-local black fades preserve coverage; simultaneous track dissolves use the
premultiplied group math $C = \sum_i G_i b_i o_i w_i m_i$, $A = \sum_i o_i w_i m_i$ and
$\mathrm{result} = C + \mathrm{lower}(1 - A)$, without a track multiplier.
Here $G_i$ is graded RGB, $b_i$ black-fade brightness, $o_i$ evaluated Opacity and
$w_i$ dissolve weight and $m_i$ spatial pixel coverage. Exact neutral poses
preserve opaque black letterboxing after grading; nonneutral uncovered pixels
reveal lower footage. Each source uses the same evaluated track Opacity at that
project frame, from the track value or its overriding curve.
v1–v21 project/receipt snapshots remain unchanged/incompatible
and require recreation, without migration, defaults or automatic deletion.
Track `opacity` is the required sole stored value, not obsolete; saved `clip.opacity`
and old `clipOpacity`/`layerOpacity` keyframe channels are invalid.
Proxy/current PCM formats do not change; the registries are version 2 (full-content
checksums). Version-1 export receipts require
strict v22 snapshots and captured audio-source/instance-plan arrays, rejecting
invalid arrays/older snapshots without rewriting successful exports. No null
fallback or old-format reader is permitted. Source-copy prohibition,
track keyframes, source choices, media preparation, Activity and both export
profiles retain their contracts. The editor targets desktop Linux; the 640 px
width floor is not a mobile-support claim.

**Track → Transform** follows Track's Colour curves section, collapsed for new
preferences and included in Track's bulk expansion; it works on empty tracks.
Native sliders/exact fields and per-setting project-frame triangles retain explicit
capture, read-only keyed main values without that setting's keyframe at the real
playhead, live slider preview with one Undo per release and editable invalid
numbers. Stored-keyframe navigation distinguishes stored project time from the
nearest available preview frame, including keyframes after the duration. Transform
is track-owned, like Colour, with its own keyframes rather than shared track channels.
See [the Transform contract](design/SPATIAL_TRANSFORMS.md); no fresh UI acceptance
or throughput result is implied.

**Audio → Music** uses native **Music track / Recording** selectors, an **Add music
track** list of ready files and selected-track trash deletion. Ready recordings can be
reused by independent music tracks; import never implicitly places one. Selection
is editor-only; edits/removal leave other music tracks and bin membership intact.
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

## Issue #2: identity evidence for relinking

Two kinds of evidence identify an original. The **sampled-sha256-v1** fingerprint
hashes size, modification time, device/inode, offsets and at most three 1 MiB byte
samples; it is checked on every read, proves the file **at this path** is the one
registered and changes when the file moves. It does not hash the complete recording.
The **sha256-full-v1** `content` checksum (digest and size) hashes every byte,
independent of path and filesystem.

A moved copy can only be verified against a checksum taken while the original was
readable, so the first preparation job (proxy for video, PCM for music) records
`content` while it already reads the original; until then it is `null`. Projects
refer to asset IDs, not source paths, and proxy/thumbnail/PCM caches are keyed by
those IDs, so a location change keeps them. The registries are version 2
(`videos.json`, `music.json`); version-1 files are neither read nor modified.

[Relinking](design/SOURCE_RELINK.md) is explicit: a recording whose original is
missing shows **Relink** in Media. A serial job checks the candidate's size and full
checksum, rejects any difference and only then updates name, path and fingerprint
atomically. Recordings without `content` cannot be relinked and must be imported
again. **Relink folder…** applies the same check to every missing recording found in a
chosen folder and its subfolders, in one job. Timing/colour metadata and matching filenames are never accepted as evidence;
there is no whole-filesystem search or hidden reassociation.

## Issue #3: export storage and recovery

`POST /api/exports/preflight` validates the submitted strict document and registered
metadata, then reads filesystem metadata only. It neither reads source bytes nor
probes, prepares, saves or admits a job. It uses the existing renders volume when
present, otherwise the data directory, rejecting symlinked locations. Outputs and
the job's work directory share that volume.

`POST /api/exports` accepts an optional `outputName` (trimmed, 1–100 characters, no
slashes or control characters). It becomes the job label, is stored as
`outputName` in new receipts and names the served MP4 through `Content-Disposition`
(it is never a filesystem path; the file stays `export.mp4` in its job directory).
Receipts written before this field existed still restore, with the default
project-title-plus-quality label.

### Advisory planning allowance

The displayed allowance is duration/profile dependent:

- Up to the two largest enabled retimed clips at **4 uncompressed bytes/pixel**.
- For generalized composited export, up to **three** timeline representations at
  **8 uncompressed bytes/pixel**; disabled-track tails and music OUTs count in full
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

Generalized composited export renders each track's premultiplied RGBA16 group, then
merges it over the lower accumulator without regrading. It retains up to two clip
files and three timeline representations, including a span collection as one.
Four reusable raw buffers use **22 bytes/pixel = 182,476,800 bytes at UHD**; the
two 65³ Float32 LUTs add **6,591,000 bytes**, excluding native/audio memory.
One original decoder, two intermediate readers, one encoder and three video children
per serial pass bound concurrency, not duration-dependent disk use. The static
fast path requires one enabled, unanimated, zero-origin contiguous track
with track Opacity 1 and HDR 0, an exactly neutral track Transform base and no Transform keyframes; Transform
edits/keyframes (even neutral keyframes) or unsupported placement/coverage use generalized
composited export, with unchanged raw-buffer/LUT/process budgets.

That static track must cover full project duration; music-only tails require
composited black, without stretching video closing fades or holding a last image.
Audio processes **one original at a time** into selected s16 PCM and serially
pairwise-sums with a **Float64 stereo accumulator**. At most **two intermediate
audio inputs**, **one native audio child per pass** and **three audio scratch files**
(selected PCM + old/new accumulators) coexist, deleting consumed inputs before the
next music track. Apply per-track gain/fades, sum without normalisation or
intermediate clipping, then hard-clamp once before final AAC. There is no ducking,
effect or video audio. These audio allocations are additional to the unchanged
video bounds above and remain duration-dependent on disk.

Preview music tracks share one AudioContext/worklet/output clock and **four × 128 KiB**
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
Enter/blur commits. Keyboard/focus/history contracts and the two-decoders-per-track
preview bound remain; eight tracks have 16 decoders plus one separate source-review decoder.

## Remaining gates

The approved project MIT terms and separate distribution requirements are in
[LICENSING.md](LICENSING.md). Intended-GPU playback, consented long real-flight/A/V
qualification and Docker/Podman delivery retain their separate gates. This document
claims no fresh test results, CI pass, real-media run, release or container acceptance.
