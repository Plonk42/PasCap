# Local deployment and planned containers

## Status and target

The approved eventual package is **one local OCI application usable with Docker
and Podman**. It is not GitHub Pages/static-only hosting and not a remote SaaS:
PasCap needs a local Node service, native FFmpeg/ffprobe and access to registered
source paths. Its local HTTP guards are not multi-user authentication.

**Container packaging is not implemented yet.** No supplied image or supported
container build/run recipe exists. The layout and configuration examples below
record the intended design and future acceptance requirements, not a working
container deployment. The current native Linux workflow is in
[../README.md](../README.md#run-locally); current validation is tracked in
[DEVELOPMENT.md](DEVELOPMENT.md#validation) and
[GitHub Actions](https://github.com/Plonk42/PasCap/actions). Container acceptance
is tracked in [#9 — networking](https://github.com/Plonk42/PasCap/issues/9),
[#10 — OCI package](https://github.com/Plonk42/PasCap/issues/10) and
[#11 — both-runtime acceptance](https://github.com/Plonk42/PasCap/issues/11).

## No-copy source access today

**Import** defaults to the service-side footage browser. Choose an approved root,
open a folder, select MP4/MOV/M4V recordings and explicitly confirm registration.
Browsing and selection alone do not import or queue preparation. Paths belong to
the service's filesystem, not a browser file picker or a desktop drop payload.

`ServiceConfig.mediaRoots` is configured by `PASCAP_MEDIA_ROOTS`, a JSON array of
at most **32 unique absolute paths**. The default is only the service user's
`~/Videos`, not the browser user's home. `[]` disables browsing. Invalid configuration
is rejected, but missing/unreadable roots remain visible as unavailable rather
than failing startup. JSON paths must be absolute; a literal `~` is not expanded.

| Request | Behaviour |
| --- | --- |
| `GET /api/footage/roots` | Root IDs, paths and availability/error information |
| `GET /api/footage?rootId=root-0&directory=%2Fmedia%2Ffootage%2FFlight` | Metadata for one folder inside the selected root; `directory` is an encoded absolute path, or omitted for the root itself |
| `POST /api/media/register-paths` | JSON `{"paths":["/media/footage/Flight/DJI_0001.MP4"]}` with 1–5,000 selected absolute video paths inside approved roots |

Use the root IDs returned by the service. Browsing uses directory/file metadata
only: no media-byte reads, probing, recursive discovery, registration, cache writes
or preparation. Listings put folders first and naturally sort names, retain at
most **2,000 entries**, and explicitly return `truncated`; choose a narrower folder
when it is true instead of assuming the listing is complete. The cache branch is excluded, path
containment is enforced and symlinks are rejected. Registration retains the
existing read-only fingerprint/probe checks, partial errors and one-heavy-worker
preparation queue; ready/in-flight preparation is reused.

The separate absolute-folder-path form deliberately invokes the existing recursive
folder import, including folders outside browser roots. It can register/autoqueue
the whole folder and therefore start substantial work; submit it only explicitly.
It does **not** silently add a root. Approved roots constrain browsing and the
selected-path route, not every existing deliberate manual import action. Standalone
music still uses Audio.
Manual video imports may be outside the approved browser roots, but the HTTP API
still refuses the cache and its generated-data descendants as original footage.

There is **no upload endpoint, browser file picker, optional copy mode or true
external desktop file/folder drag-and-drop import**. External drops prevent
navigation and show Import guidance without a POST. Internal ready-Media-to-Timeline
dragging remains supported. Imports reference originals; generated proxies/
thumbnails, project/registry metadata, exports/receipts and scratch are the only
new local data, not duplicate original footage. Projects use strict schema 6 with
required per-track Ripple, transitions and opening/closing fades. v1–v5 projects
and receipt snapshots remain unchanged/incompatible, without migration;
registry/proxy formats and source identity checks are unchanged.

## Planned architecture and storage layout

The eventual container contains **one Node service, FFmpeg, ffprobe and the built
browser UI**. Node serves the UI/API and runs the existing native job queue. The
browser remains on the host, where video decoding, WebGL2 and GPU selection occur.
No source footage belongs in the image or build context, and startup must not
automatically register or prepare mounted footage.

| Data | Stable container path | Mount/access |
| --- | --- | --- |
| Original footage from a user-chosen host folder | `/media/footage` | Read-only source bind mount |
| Registries, project documents, generated proxies/thumbnails, exports/receipts and scratch | `/var/lib/pascap` | Separate read/write persistent host directory or volume |
| Built UI, Node application and native toolchain | Image-owned application location | No bundled originals or user data |

For this proposed layout, the **existing** configuration values would be
`PASCAP_MEDIA_ROOTS=["/media/footage"]` (the environment value is that JSON array)
and `PASCAP_DATA_DIR=/var/lib/pascap`. These are configuration examples, not container
launch commands. Additional source mounts require explicit stable container paths
and corresponding approved-root entries. Do not rely on the container user's
default Videos folder to discover host drives.

Keep writable cache/scratch **outside footage**, never under a source mount. Persist
the entire data directory rather than an ephemeral container layer: project JSON,
registries, verified proxies and successful export receipts must survive recreation.
Exports must remain accessible through the existing output/download routes and,
when using a host bind directory, directly on the host. A volume-based package
will need a documented way to retrieve outputs; it must not hide finished videos
in disposable storage. Scratch disk remains duration-dependent, not a fixed-GB promise.

Saved `sourcePath` values refer to the service/container path, so keep the mapping
stable across restarts and upgrades. Originals must remain accessible there; moving
a recording, changing mounts or disconnecting a drive fails explicitly, even if a
proxy exists. Filesystem fingerprints still apply: a stable pathname does not bypass
identity checks. There is no implicit path guessing, native-to-container path/
fingerprint rewrite or migration; an explicit relink workflow remains pending.

Previously copied source files from the removed implementation are **not deleted
or migrated automatically**. Preserve registered paths and bytes for any still-used
source. This is a data-safety rule, not compatibility code or a reason to reintroduce
copy imports. Back up persistent project/export data and originals separately;
proxies are not a backup of the originals.

## Non-root, rootless and host permissions

- Run the eventual application as a non-root user; support rootless Podman and
  compatible non-root Docker operation without privileged mode.
- The mapped UID/GID needs read access to originals and traversal permission on
  every parent directory. A read-only bind mount does not grant missing host access.
- The dedicated persistent data location must be writable by that mapped user;
  rootless user namespaces and existing host ownership need explicit validation.
  Permission failures should be reported, not repaired by taking ownership of drives.
- Do not automatically `chmod`, `chown` or relabel user-owned footage/drives.
  Operators must deliberately provision an appropriate data directory and source
  access without changing private originals behind their backs.

With Podman on SELinux hosts, `:z`/`:Z` relabel options change host labels, even for
a read-only source mount. Shared versus private labels can affect other applications
and access to private originals. Do not apply them automatically to users' drives;
any necessary label change must be explicitly understood/approved and scoped to
an appropriate dedicated location. Do not solve permissions by disabling SELinux
or broadening the application's privileges.

## Networking still to implement

The current entry point in [../src/server/main.ts](../src/server/main.ts) binds
**`127.0.0.1` only**. That is correct for native local use but is not a completed
container networking configuration. Eventual packaging needs an explicit way to
bind **`0.0.0.0` inside the container** so port publishing can reach Node; no current
environment switch for that bind address is claimed here.

Publish the application port on **host `127.0.0.1` only**. Do not use host networking
or expose the unauthenticated service to the LAN/Internet. Keep exact trusted
`allowedHosts` / `allowedOrigins`, cross-site rejection and the existing client
header requirement; do not replace them with `*`. If the published host port differs
from the internal port, the eventual configuration must explicitly allow the exact
loopback browser Host/Origin rather than weakening those guards.

## Shutdown, native processing and toolchain

The current service handles SIGINT/SIGTERM and closes its job queue. The eventual
container entry point must deliver **SIGTERM to Node**, allow graceful cancellation/
cleanup, wait for native children and reap them without orphaned FFmpeg processes.
An exec-style entry point or suitable init/signal forwarding must be validated in
both runtimes. Stop/recreate must preserve persistent data and successful outputs;
interrupted jobs are not resumed, and forced termination is not a crash-proof
unsaved-draft guarantee. See [WORKSPACE_AND_RECOVERY.md](WORKSPACE_AND_RECOVERY.md).

Native export currently uses CPU composition/LUT work and **software `libx264`
encoding**. Packaging does not promise NVENC, NVIDIA device mounts or faster renders.
The host browser's GPU is separate; containers do not establish target-GPU preview
performance. The actual browser renderer and long-flight acceptance still need
independent validation.

Historical native evidence used **FFmpeg 8.0.1**; see
[FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md). The future image must pin/document
its Node and FFmpeg/ffprobe toolchain, including the required `libx264`, FFV1,
`lut3d`/`xfade`, raw/lossless pixel formats and colour/timing behaviour. A distribution
package or a different FFmpeg build cannot be declared equivalent merely because
it starts: container parity tests are required for proxy correspondence, retiming,
layer composition, BT.709 tags, exact frame counts and music/export verification.

## Future container acceptance — not completed

Follow [licensing and distribution](LICENSING.md) for the approved project MIT
terms, exact npm notices and the separate GPL-enabled FFmpeg/libx264 source,
native dependency and artifact-review requirements. No built image/source bundle
or codec/patent clearance is implied by the project license or CI cache.

Before publishing packaging, validate **both Docker and Podman** with disposable
synthetic media and explicit read-only source bind mounts:

1. Build the application/image reproducibly and serve the built UI/API locally;
   verify the pinned native toolchain and existing correctness tests in each runtime.
2. Browse without media reads/probes/writes/jobs, exercise unavailable roots,
   permissions, symlinks, cache exclusion and truncation, then selectively register
   originals and prepare/export without changing source bytes or identity metadata.
   Preserve deliberate folder import and external-drop/no-POST behaviour.
3. Exercise non-root/rootless UID access, read-only mount enforcement and SELinux
   failure/reporting without automatic drive permission or label changes.
4. Verify host-loopback-only publishing and exact Host/Origin/client guards; no
   host-network or unauthenticated LAN exposure.
5. Stop during native work with SIGTERM, verify child reaping/owned-scratch cleanup,
   recreate with the same paths/data and retain projects, registry/proxy reuse,
   existing registered source bytes and accessible successful exports/receipts.
6. Run native proxy and short 720p/4K timing/colour/layer/music parity tests in both
   runtimes. Report actual results separately from historical native evidence;
   make no GPU or long-render performance claim from a container build or short test.

These future container gates are separate from the completed native no-copy tests
and the pending intended-GPU browser check/5–10 minute real-flight qualification.
