# Local deployment

## Target

PasCap runs **natively on Linux**: one local Node service, native FFmpeg/ffprobe and
the user's own browser, started with `npm run dev` or `npm run build && npm start`
([run locally](../README.md#run-locally)). It is not GitHub Pages/static hosting, a
LAN service or a remote SaaS, and its local HTTP guards are not multi-user
authentication. Validation is described in [DEVELOPMENT.md](DEVELOPMENT.md#validation)
and runs in [GitHub Actions](https://github.com/Plonk42/PasCap/actions).

There is no container package. A Docker/Podman image was planned, then dropped
(owner, 2026-10-28; [#10](https://github.com/Plonk42/PasCap/issues/10)): with no
published image every user would build it, PasCap needs direct access to the user's
footage, and its GPU export compositor and NVDEC proxy decoding would need GPU
passthrough into the container. The pinned toolchain a container would have provided
is covered by the [toolchain section](#native-toolchain) and
[#290](https://github.com/Plonk42/PasCap/issues/290).

## No-copy source access today

**Import** (Media panel) opens one service-side **Import media** browser for video and
music recordings. Choose an approved location, open a folder, select MP4/MOV/M4V and
music recordings and explicitly confirm the import.
Browsing and selection alone do not import or queue preparation. Paths belong to
the service's filesystem, not a browser file picker or a desktop drop payload.

`ServiceConfig.mediaRoots` is configured by `PASCAP_MEDIA_ROOTS`, a JSON array of
at most **32 unique absolute paths**. The default is only the service user's
`~/Videos`, not the browser user's home. Footage and music share these roots;
`[]` disables both browsers, not explicit manual path imports. Invalid configuration
is rejected, but missing/unreadable roots remain visible as unavailable rather
than failing startup. JSON paths must be absolute; a literal `~` is not expanded.

| Request                                                                    | Behaviour                                                                                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/footage/roots`                                                   | Root IDs, paths and availability/error information                                                                                                                                     |
| `GET /api/footage?rootId=root-0&directory=%2Fmedia%2Ffootage%2FFlight`     | Metadata for one folder inside the selected root; `directory` is an encoded absolute path, or omitted for the root itself                                                              |
| `GET /api/footage/preview?path=%2Fmedia%2Ffootage%2FFlight%2FDJI_0001.MP4` | A JPEG (at most 320 × 180) of the keyframe nearest the middle of one video inside approved roots, with an identity `ETag`; read-only, bounded and cached in the data directory         |
| `POST /api/media/register-paths`                                           | JSON `{"paths":["/media/footage/Flight/DJI_0001.MP4"]}` with 1–5,000 selected absolute video paths inside approved roots                                                               |
| `GET /api/audio/roots`                                                     | The same approved-root IDs, paths and availability/error information for music                                                                                                         |
| `GET /api/audio/browse?rootId=root-0&directory=%2Fmedia%2Ffootage%2FMusic` | Metadata-only one-folder audio candidates and subfolders, with the same containment, symlink, cache-exclusion and truncation guards                                                    |
| `POST /api/audio/register-selected`                                        | JSON `{"path":"/media/footage/Music/track.wav"}` for one explicitly confirmed audio candidate inside approved roots; existing standalone-audio probe/preparation remains authoritative |
| `POST /api/audio/register`                                                 | Deliberate typed audio-path import; browser roots do not restrict this action or expand automatically                                                                                  |
| `POST /api/media/register` / `POST /api/media/import`                      | Deliberate typed video-file path / recursive folder import, also outside browser roots                                                                                                 |
| `POST /api/media/:id/relink` / `POST /api/audio/:id/relink`                | JSON `{"path":"/media/footage/Moved/DJI_0001.MP4"}` for a recording that `GET /api/media` / `GET /api/audio` list in `missing`; returns 202 `{ job }` for a verified relink job        |
| `POST /api/relink-folder`                                                  | JSON `{"directory":"/media/footage/Moved"}`; returns 202 `{ job }` that relinks every missing recording whose exact bytes are found in that folder or its subfolders                   |

Use the root IDs returned by the service. Listings use directory/file metadata
only: no media-byte reads, probing, recursive discovery, registration, cache writes
or preparation. Previews are the one bounded exception: FFmpeg reads a video's
container index and the keyframe nearest its middle (never the whole file), two
at a time with sixteen waiting and a 20-second limit each, cancelled when the
browser disconnects; the JPEG goes to the data directory's `browse-previews/`, at
most 4,000 files. No original is sent to the browser. Listings put folders first and naturally sort names, retain at
most **2,000 entries**, and explicitly return `truncated`; choose a narrower folder
when it is true instead of assuming the listing is complete. The cache branch is excluded, path
containment is enforced and symlinks are rejected. Registration retains the
existing read-only fingerprint/probe checks, partial errors and one-heavy-worker
preparation queue; ready/in-flight preparation is reused.

The dialog lists one folder from both metadata listings (`/api/footage` and
`/api/audio/browse`) together. Its **Other location** field deliberately imports a
typed path, including outside browser roots: a music recording, a video recording, or a
folder through the existing recursive folder import, which can register/autoqueue
the whole folder and therefore start substantial work; submit it only explicitly.
It does **not** silently add a root. Approved roots constrain browsing and the
selected-path routes, not every deliberate typed import. Browsing/selection/Cancel
never POST; only explicit confirmation registers/prepares and adds the importing
project's membership. Failed/uncertain writes retain the selection and error
without automatic retry.
WAV/MP3/M4A/AAC/FLAC/OGG/OPUS/AIFF/AIF/WMA extensions are discovery candidates;
actual streams are checked on registration. Originals remain untouched/in place.
Manual video imports may be outside the approved browser roots, but the HTTP API
still refuses the cache and its generated-data descendants as original footage.

There is **no upload endpoint, browser file picker, optional copy mode or true
external desktop file/folder drag-and-drop import**. External drops prevent
navigation and show Import guidance without a POST. Internal ready-Media-to-Timeline
dragging remains supported. Imports reference originals; generated proxies/
thumbnails, project/registry metadata, exports/receipts and scratch are the only
new local data, not duplicate original footage. Projects use the strict current schema with
a complete required grade on every clip (Colour, including Temperature/Tint/Vibrance/Whites/Blacks/HDR/Local
contrast and static HSL/curves, and keyframes with fourteen nullable channels: twelve scalar
colour settings, including `temperature`, `tint`, `vibrance`, `whites` and `blacks`, `hdr` and
`localContrast`), the project's `adjustments`,
no clip colour/correction/opacity/spatial fields, a required boolean clip `reverse`, required video track `transform` base/per-setting project-frame keyframes,
Opacity (0–1, 1 on new tracks) included, and
required `music` array (0–8 independent music tracks, unique required IDs; `[]` without
music), and
required per-track Ripple, transitions and opening/closing fades; video tracks have no Colour,
Opacity or keyframes of their own. HSL/curves remain static. The Transform Opacity supplies
Opacity to each source in a dissolve group, without an additional track multiplier. Projects
and receipt snapshots saved before the current schema, with track Colour, are rejected with the
reason and left unchanged, without compatibility defaults,
null/old-format readers or automatic deletion.
Export receipts remain version 1 with strict current-schema snapshots and required captured
audio-source/instance-plan arrays; invalid arrays/older snapshots remain preserved
and rejected. Proxy/current PCM formats and source identity checks are unchanged; the
registries are version 2 (`videos.json`, `music.json`, with full-content checksums).

Music import populates the project bin/preparation queue, never implicit placement.
Up to eight independent music tracks can reference the same or different originals
without copying them. Project duration is the maximum video clip OUT or music
start + duration; music can extend it. Video closing fades end at their clip OUT,
then the picture is black while music continues/fades at its own end. Music-only
preview is black; native export still requires a video clip and uses composited
export for music tails. [MULTIPLE_MUSIC.md](design/MULTIPLE_MUSIC.md) specifies
the current contract and pending validation, not release acceptance.

## Storage layout

| Data                                                                                      | Location                                         | Access                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Original footage and music                                                                | Where the user keeps it, inside approved roots   | Read only by the service; never written          |
| Registries, project documents, generated proxies/thumbnails, exports/receipts and scratch | `PASCAP_DATA_DIR`, default `.pascap/` in the app | Read/write for the service user, outside footage |

Keep the data directory **outside footage**, never under an approved root, on a disk
with room for proxies and export scratch. Scratch grows with export duration; there
is no fixed-GB promise. Native audio retains at most selected stereo s16 PCM plus
old/new full-project Float64 stereo accumulators: **three audio scratch files**,
**two intermediate audio inputs**, **one audio child per serial pass**, and one
original decoded at a time. Audio disk planning is maximum selected PCM + two
full-project Float64 stereo timelines, additional to unchanged video
buffers/children/LUTs/scratch.

Saved `sourcePath` values are the service's absolute paths, so originals must stay
at those paths: moving a recording, unmounting a drive or changing a mount point
fails explicitly, even if a proxy exists. Filesystem fingerprints still apply: a
stable pathname does not bypass identity checks. There is no implicit path guessing
or migration; an explicit [verified relink](design/SOURCE_RELINK.md) accepts a moved
copy only when every byte matches the registered original.

Previously copied source files from the removed implementation are **not deleted
or migrated automatically**. Preserve registered paths and bytes for any still-used
source. This is a data-safety rule, not compatibility code or a reason to reintroduce
copy imports. Back up the data directory and the originals separately; proxies are
not a backup of the originals.

## Permissions

- Run the service as an ordinary user, never as root.
- That user needs read access to originals and traversal permission on every parent
  directory, and write access to the data directory. Permission failures are
  reported, not repaired: PasCap never `chmod`s, `chown`s or relabels footage or
  drives.

## Network

The entry point in [../src/server/main.ts](../src/server/main.ts) binds
**`127.0.0.1` only**, with exact trusted Host/Origin checks, cross-site rejection and
a required client header. Do not expose the unauthenticated service to the
LAN/Internet, for example through a reverse proxy or port forwarding. The MCP endpoint
(`/mcp`) keeps the same Host/Origin checks and replaces the client header with the
bearer token in `<data directory>/mcp-token`; keep that file private with the rest of
the data directory.

## Shutdown and native processing

The service handles SIGINT/SIGTERM: it closes its job queue, cancels native work and
cleans owned scratch. Interrupted jobs are not resumed, and a forced termination is
not a crash-proof unsaved-draft guarantee
([WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md)). Never run two service
processes against the same data directory.

Export encodes with **software `libx264`**; there is no NVENC. Heavy grading frames
are composited on a hardware GPU through headless Chrome when one starts
(`PASCAP_CHROME`, `PASCAP_GPU_COMPOSITING`), and proxy preparation decodes with NVDEC
when CUDA is available (`PASCAP_HW_DECODE`); both fall back to the CPU. The editor's
preview decodes and composites in the user's browser, whose own GPU and renderer
still need the intended-GPU validation tracked in v0.2.

## Native toolchain

Native processing is qualified on **FFmpeg/ffprobe 8.0.1** with `libx264`, FFV1,
AAC, `lut3d`/`xfade`, `setparams`, raw/lossless pixel formats and the `setts`
bitstream filter; [FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md) holds the historical
evidence. Distribution packages are usually older or configured differently, and a
build cannot be declared equivalent merely because it starts: proxy correspondence,
retiming, track composition, BT.709 tags, exact frame counts and music/export
verification depend on it.

To build the qualified version locally, run the
[CI setup script](../scripts/ci/setup-ffmpeg.sh) with a dedicated absolute prefix
(it needs `build-essential`, `pkg-config`, `nasm` and `libx264-dev`), then point the
service at it:

```sh
bash scripts/ci/setup-ffmpeg.sh "$HOME/.local/opt/ffmpeg-8.0.1"
PASCAP_FFMPEG="$HOME/.local/opt/ffmpeg-8.0.1/bin/ffmpeg" \
PASCAP_FFPROBE="$HOME/.local/opt/ffmpeg-8.0.1/bin/ffprobe" npm start
```

The script checks the source archive's SHA-256 and verifies the required encoders,
filters and bitstream filter. A startup toolchain check and a documented install
command are tracked in [#290](https://github.com/Plonk42/PasCap/issues/290).
Redistributing FFmpeg or other binaries follows [licensing](LICENSING.md); none is
shipped today.
