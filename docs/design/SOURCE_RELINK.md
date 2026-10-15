# Verified relinking of moved originals

Current contract for [#2](https://github.com/Plonk42/PasCap/issues/2): when a video or
music original is no longer at its registered path (folder moved or renamed, drive
mounted elsewhere, footage copied to a new disk), the user points PasCap at the moved
copy. PasCap accepts it only if every byte matches the original it registered, then
updates the path. The recording's ID, proxy, thumbnails, PCM cache, clips, music
tracks and every project stay as they are. Usage is in [the user guide](../USER_GUIDE.md).

Implementation authorities: [checksum and verification](../../src/server/files.ts),
[video registry](../../src/server/library.ts), [music registry](../../src/server/audio.ts),
[asset schemas](../../src/shared/media.ts), [Media panel](../../src/web/MediaLibrary.tsx)
and [relink dialog](../../src/web/ImportDialog.tsx).

## Identity

Two kinds of evidence identify an original:

| Evidence                                        | What it proves                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fingerprint` (`sampled-sha256-v1`)             | The file **at this path** is the one registered: size, modification time, device, inode and three 1 MiB samples. Cheap, checked on every read. It changes on a move. |
| `content` (`sha256-full-v1`: `digest` + `size`) | The **bytes**: SHA-256 of every byte, independent of path and filesystem. Immutable once recorded.                                                                   |

A moved copy can only be verified against a full checksum taken while the original
was still readable, so `content` is recorded by the **first preparation** of each
video (proxy) and music (PCM) recording, inside the same job, while the original is
already being read. Until then it is `null` and the recording cannot be relinked;
importing the moved file is then the only option.

## Registries and caches

Registry version 2 adds the required nullable `content` to every video and music
asset and is stored in `videos.json` and `music.json`. The earlier `library.json`
and `audio.json` (version 1) are **not read and not modified**; recordings are
imported again into new projects. Proxy, thumbnail and PCM caches live under
`assets/<media id>/` and `audio-assets/<audio id>/`, keyed by the immutable asset ID
rather than the location fingerprint, so a relink keeps them. Caches of version-1
registries stay on disk unused; delete them once nothing needs them.

Video IDs remain `media-` plus 32 characters of the first registration's sampled
digest. Re-registering a path whose fingerprint matches an asset returns that asset.
If a file's first identity matches an asset that has since been relinked elsewhere
(the old drive reconnected), registration is refused and names the relinked location.
Importing a moved copy as a new recording (instead of relinking) creates a separate
entry with its own caches.

Export receipts keep format 1: their captured music sources omit `content`.

## Missing originals

`GET /api/media` and `GET /api/audio` return `missing`: the IDs whose original is not
at its registered path or no longer matches its fingerprint (a metadata check, no
read). The Media panel marks those recordings and music files **Original missing**,
hides their add and prepare actions, and shows a **Relink** button (link icon) in
their place. Preview, preparation and export of a missing original still fail with
an explicit error naming relinking as one remedy.

## Relink flow

1. **Relink** opens the Import media dialog in relink mode: the title names the
   recording, the old path is shown, only one file of the recording's kind can be
   chosen, and the footer shows the chosen new location. **Other location** accepts
   a typed path anywhere on the machine (outside the PasCap cache), like a deliberate
   import.
2. **Relink** (or double-click) submits `POST /api/media/:id/relink` or
   `POST /api/audio/:id/relink` with `{ path }`. A recording without `content`, or one
   already preparing or relinking, is refused at once. Otherwise the service queues a
   **Recording relink** job and the dialog closes onto Activity.
3. The job runs on the one-heavy-job queue, so it never overlaps a preparation or an
   export. It fingerprints the candidate, rejects a different size, streams every byte
   through SHA-256 (one 1 MiB buffer, progress, cancellable) and rejects any
   difference, then confirms the file did not change while it was read.
4. On a match it replaces only `name`, `sourcePath` and `fingerprint` and writes the
   registry atomically. If the write fails, the in-memory asset is restored. On any
   mismatch or failure nothing changes and Activity shows why (for example
   "it is a different recording").

The check is byte equality, so an identical copy of the same recording is accepted
wherever it is, and a same-name file with other content never is. Relinking neither
reads the old location nor copies, converts or writes any original.

## Limits

- Recordings registered before their first preparation, and every version-1 registry
  entry, have no checksum and must be imported again.
- Relinking is one recording at a time; there is no folder-wide matching or automatic
  search.
- An export queued before a relink keeps its captured old path and fails its identity
  check; export again after relinking.
- The check reads the whole candidate: about a second per 600 MB from SSD, longer from
  USB disks or SD cards.
