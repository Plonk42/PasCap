# Explicit verified video-source relinking · proposed contract

Design prerequisite for [#2](https://github.com/Plonk42/PasCap/issues/2).
**Not implemented.** Storage/version and registration-flow decisions require
explicit maintainer approval before code or local-data changes. This record is
separate from current usage contracts; it does not authorize hashing owner footage,
migration, source copying, native jobs or a release.

## Verified current boundaries

- [Source identity](../../src/server/files.ts) stores `sampled-sha256-v1`: size,
  modification time, device/inode and at most three 1 MiB byte samples. `deep=true`
  repeats those samples, not a full-file hash. The
  [disposable regressions](../../tests/unit/service.test.ts) show an unsampled
  change in an 8 MiB file passing this check and a same-inode rename retaining
  the fingerprint while the registered path is missing.
- [Video registration/cache access](../../src/server/library.ts) derives the media
  ID from the first 32 digest characters and proxy/thumbnail directories from
  the complete sampled digest. Re-registering a same-inode rename reuses the
  existing asset without changing its path. Updating that digest naively would
  also change the prepared-cache lookup.
- [Registry v1 and MediaAsset](../../src/shared/media.ts) are strict. The video
  registry and [audio registry](../../src/server/audio.ts) are distinct files.
  [Project v5](../../src/shared/model.ts) clips/bins reference asset IDs, not paths;
  row points, source-frame curves and music timing are independent of location.
- [Export admission](../../src/server/export.ts) captures/freeze-copies source
  assets before queuing native work. Existing version-1 receipts contain the v5
  project snapshot **and original source paths/fingerprints/metadata**. They are
  historical export evidence, not a relink baseline; neither receipts nor finished
  videos may be rewritten by a location change.
- [SerialWriter and atomicWrite](../../src/server/storage.ts) serialize persistence
  and publish one complete file by rename, with file/directory synchronization.
  They are not source-read leases or job-admission locks. The
  [one-heavy-job queue](../../src/server/jobs.ts) has cancellation/progress but no
  current relink/identity job or asset-location reservation.
- Current [HTTP source/proxy/thumbnail access](../../src/server/app.ts) checks
  identity, rejects symlinks and serves registered paths. Candidate selection
  must preserve [approved-root/cache/loopback guards](../DEPLOYMENT.md), not
  expose an upload, arbitrary filesystem search or a browser-supplied fake path.

A candidate checksum cannot prove equality to a missing original whose complete
checksum was never recorded. Matching filenames, durations, thumbnails, proxies,
old sample digests or completed exports cannot repair that missing evidence.

## Recommended strict identity split

Introduce **video registry version 2**, with required evidence on every accepted
video asset. Keep the existing required fields, plus:

| Field | Proposed invariant |
| --- | --- |
| `content` | Required `{ algorithm: 'sha256-full-v1', digest, size }`; SHA-256 of **every original byte**, excluding paths/filesystem metadata; immutable |
| `cacheKey` | Required immutable complete 64-character digest, initialized from `content.digest`; independent of the current location fingerprint |
| `locationRevision` | Required non-negative integer, starting at zero and incrementing only by a confirmed relink |
| `id` | Immutable `media-` plus the first 32 content-digest characters for new registrations; compare the **full** digest before deduplication, rejecting a truncated-ID collision |
| `sourcePath` / `fingerprint` | Current explicitly confirmed service-side absolute path and its filesystem/sampled evidence; replace together, never use their new digest as the cache key |

Reject omitted/unknown fields, unsupported algorithms, invalid digests, duplicate
IDs, mismatched content/cache keys and invalid revisions. No optional/null legacy
evidence, fallback baseline or "verified" flag without its checksum is proposed.
Content identity and accepted timing/colour metadata cannot be changed by relinking.

An explicit repeat import may reuse an existing asset/proxy at its unchanged
verified location. Identical bytes at a different path must not update an existing
association merely because registration found the same ID; offer the **separate
confirmed relink** workflow. Different content is a separate recording, not a
warning that can be accepted as this asset.

### Format implications and adoption

The change needs approval because it makes **existing video registry v1 data
incompatible** and changes new-registration identity. Preserve that file, its
projects, generated assets and successful exports byte-for-byte. Do not initialize
an empty v2 registry over it, inject fields, hash its entries on startup, rewrite
IDs or move/delete its caches. Explain the unsupported format and use a compatible
build to access the preserved workspace, or deliberately select a **fresh data
directory** and import known-good originals into new projects.

This is a deliberate strict reset, **not recovery of existing missing v1 sources**.
If the owner needs those old associations preserved in an upgraded workspace,
that is a separate explicit migration/evidence-capture decision, not hidden code.
There is no way to manufacture their missing complete baseline after the fact.

No project-schema change is needed solely for a location change: v5 already stores
IDs rather than paths. Do not rewrite old v5 documents to substitute new IDs.
Receipt version 1 and its recorded paths remain unchanged; this design does not
add fields or reinterpret receipts as full-content proof. Audio relinking and
audio registry changes are **out of scope**; audio keeps its current contract.

## Full original evidence and resource ownership

1. A user explicitly selects/registers a readable, known-good original. Capture
   its complete checksum **before** that original becomes unavailable. First
   registration cannot be considered successful or added to a project bin until
   evidence and current timing/colour validation succeed.
2. Reject every symlink component and non-regular file. Open read-only with
   `O_NOFOLLOW`, bind the descriptor's identity to the checked path, and compare
   size/device/inode/mtime/ctime before and after hashing/probing, including a
   post-read path-to-descriptor comparison. An open descriptor does not prevent
   another process modifying or unlinking the file. These checks are race
   detection, not a claim of hostile-filesystem locking or a security sandbox.
3. Stream every byte through SHA-256 with **one reusable bounded buffer** (for
   example 1 MiB), exact byte accounting and no duration-sized allocation. Continue
   legitimate short reads; reject unexpected EOF, changed identity and read errors.
   Close the descriptor and terminate/reap owned probes on every failure/abort.
4. Schedule checksum/probe work through the **same one-heavy-operation owner** as
   preparation/export, with cancellation/progress. Never launch parallel hashes,
   a second heavy worker or hidden verification on startup, library reads, hover,
   preview seeking or opening Import. Fast current-location guards remain separate
   from an explicitly requested full read; they must not be labelled full-byte
   verification.
5. Full registration can exceed the existing HTTP write deadline. Recommend an
   explicit typed **verification job** and bounded admission/coalescing, with
   result/bin handoff tied to the originally selected project. Define that response
   and cancellation/partial-success UI before implementation; do not silently
   extend deadlines, retry uncertain writes or persist incomplete v2 assets.

Owner-media baseline/verification work remains explicitly consented. All engineering
proof uses disposable bytes or synthetic media; no hash of an existing owner cache
or recording is part of accepting this document.

## Select, verify, review, confirm

### Candidate verification — no association write

The owner explicitly picks one approved service-side location for one existing
v2 asset. Reuse bounded browsing and no-symlink/cache checks; show old/new paths
locally. Queue a cancellable candidate verification, keeping the old association,
project/history and ready proxy unchanged throughout.

Read the entire candidate and compare **full size/digest** with the immutable
baseline. Probe with the current strict timing/colour contract and compare accepted
metadata; failures distinguish unreadable/missing path, content mismatch, timing/
colour mismatch, changed-during-read and missing baseline. No mismatch override,
sample-only acceptance, source conversion, original write or automatic proxy encode.

A successful verification creates a bounded, expiring **server-owned proposal**
bound to asset ID, expected location revision, old path/fingerprint, exact candidate
path/current identity and baseline. The client cannot supply authoritative digests
or replace the baseline. Proposals are editor/service session state, not optional
registry fields; restart invalidates them. Leaving/cancelling this review commits
nothing. Display the exact preserved asset identity and old/new association before
a distinct **Confirm relink** action.

### Confirmation — stale and active-work guards

Confirmation must re-read/reverify the candidate, not trust an old dialog or stat
tuple. Reserve the location operation **before an asynchronous yield**, checking
the expected location revision and source association. Reject a stale proposal or
candidate changed after review. No blind confirmation retry.

Introduce an explicit service admission/read-lease boundary; a `SerialWriter`
alone is insufficient. The conservative first implementation refuses confirmation
while native work is queued/running, preparation admission is pending, or a source
read/validation lease is active. The same reservation must block new prepare,
reference, export and relevant source-validation/read admissions until commit or
abort. This includes exports already holding freeze-copied old locations and
streams already opened by another tab. Do not merely check `jobs.list()` and then
yield before registering the reservation. Release only owned reservations/handles.

Write a clone of the current complete registry: change only `sourcePath`, its
current `fingerprint` and `locationRevision`. Preserve `id`, `cacheKey`, `content`,
metadata and prepared assets; do not replace the live in-memory asset before
persistence commits. No clip/base/point/music/bin/history/autosave/receipt rewrite.
Tabs refresh asset availability and use ordinary preview recovery at the retained
project frame, without a fictional Undo step for registry maintenance.

### Atomic commit and interruption truth

Define the registry's **atomic rename as the commit point**. Before it, cancellation
or verification/persistence failure leaves the old association intact and removes
only owned temporary state. After it, a lost response or directory-sync failure can
make acknowledgement uncertain; it cannot honestly promise that the old location
still wins. Read back the validated registry and report committed/uncertain state,
never false rollback or cancelled success. Block further admissions if persistence
and in-memory state cannot be reconciled, with an explicit recovery action.

After service interruption, disk must contain a complete validated old or new
registry, never mixed fields. Do not replay/confirm session proposals on startup.
Power loss still depends on filesystem durability; no crash-proof promise is made.
Tests and issue acceptance must distinguish **pre-commit failure** from a lost
post-commit acknowledgement rather than weakening atomicity assertions.

## Disposable implementation acceptance matrix

These are required future checks, **not results claimed by this design record**:

- Complete known SHA-256 values, bounded memory/serial reads, legitimate short reads,
  unexpected EOF, every close/abort path, descriptor/path substitution and mutation.
  Retain the unsampled-byte regression: it must fail full-byte verification.
- Same-inode rename and same bytes with different filesystem identity/mtime,
  including moved/remounted-location simulation; reject same-name different bytes,
  unsupported timing/colour and missing complete baseline.
- Verification/review/cancel writes no association. Changed-after-review candidate,
  expired/restarted proposal, revision races and concurrent confirmations reject
  atomically; no source or baseline overwrite.
- Admission/queued/running native work, pending preparation, active source streams
  and multi-tab reads cannot race confirmed location publication. Keep exactly one
  heavy operation and all existing native child/buffer limits.
- Inject pre-rename write/sync failure, cancellation and interruption; assert old
  association/source/proxy/project/receipt bytes intact. Separately inject lost
  post-rename acknowledgement and verify honest readback/restart recovery, not
  an invented rollback. No automatic retry or interrupted-job resume.
- Save/reopen/restart, existing proxy reuse, preview source mapping and short native
  export preserve the same media ID, clip ranges/bases, shared points, speed curves,
  bins, music, frame/pixel/resource gates and prior successful outputs.
- Strict v1/invalid-v2 refusal preserves files and caches. No default-field injection,
  automatic migration, cache moves or ID remapping. Audio remains unchanged.
- Accessible explicit review/confirmation, progress/cancel, recoverable path/error
  drafts, stale/uncertain guidance and keyboard focus; no action from hover/drop.

## Decisions needed before implementation

1. Approve the mandatory full-baseline video registry v2, immutable ID/cache split
   and **preserved-but-incompatible v1/fresh-workspace adoption**. Do not infer a
   migration decision from this issue's milestone assignment.
2. Approve full-stream verification-job registration/bin handoff, candidate
   confirmation and the conservative admission/read-lease boundary, including
   truthful post-commit uncertainty semantics.

Follow progress and the concrete next action on [#2](https://github.com/Plonk42/PasCap/issues/2).
This document settles the proposed direction, not product implementation approval.
