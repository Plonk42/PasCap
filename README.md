# PasCap

[![CI](https://github.com/Plonk42/PasCap/actions/workflows/ci.yml/badge.svg)](https://github.com/Plonk42/PasCap/actions/workflows/ci.yml)

**A local, single-user video editor for Linux.** Review rushes, assemble an edit,
animate colour and speed, add music, and export a 720p draft or 4K final using
native FFmpeg. Footage stays on your machine and is **referenced in place, not
uploaded or copied**.

PasCap is in early development. Short correctness tests pass; target-GPU playback
and a complete 5–10 minute real-flight edit are still qualification gates, not
performance claims. The eventual package is a **local Docker/Podman application**;
container packaging is not available yet. GitHub Pages and cloud editing are not
deployment targets.

## Highlights

- Separate projects with local autosave, conflict recovery and an initially empty media bin.
- No-copy footage browsing, verified editing proxies, thumbnails and reusable source excerpts.
- Ripple-edited primary sequence and independently positioned overlays, up to eight video layers.
- Recoverable trims, split, duplication, marked-range cutting, snapping, Undo/Redo and source review.
- Independent clip colour/speed bases and **shared row-wide keyframes** for opacity, speed and seven colour settings.
- Draggable timeline keyframes and setting-specific Previous/Next navigation.
- Cuts, fade-through-black, cross-dissolves and opening/closing fades.
- One music track with waveform, gain, fades and explicit range looping.
- Native original-based H.264 SDR exports at **1280×720** or **3840×2160**, with progress, cancellation and verification receipts.

## Requirements

- **Linux**, Node.js **22.12+ or 24 LTS** and npm.
- Native **FFmpeg and ffprobe**. The tested development toolchain is **FFmpeg 8.0.1** with `libx264`, FFV1, AAC and the required colour/transition filters. Older distribution packages have not been certified.
- A current desktop browser with **WebGL2** and `requestVideoFrameCallback`. Automated browser tests use Google Chrome.
- Enough disk space for generated proxies and export scratch. Long lossless 4K intermediate files can be large; there is no fixed-GB scratch guarantee.

Video support is deliberately strict: **constant 30000/1001 fps**, landscape/unrotated,
**8-bit `yuv420p` SDR with explicit BT.709 tags** and unambiguous frame timing.
MP4/MOV/M4V extensions do not guarantee support. Unsupported, HDR, untagged or
variable-frame-rate footage is rejected rather than silently converted.

## Run locally

```sh
git clone https://github.com/Plonk42/PasCap.git
cd PasCap
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The local media service listens at
**127.0.0.1:4318**; the development UI proxies API requests to it.

For the built application, run `npm run build` followed by `npm start`, then open
**http://127.0.0.1:4318**. Do not run two service processes against the same data
directory, and do not expose the unauthenticated service to a network.

### First edit

1. Create a project from **Projects**.
2. Use **Import → Browse footage**, select originals and register them. Browsing alone starts no media work. Alternatively, explicitly register a whole folder by path.
3. Wait for proxy preparation in **Activity**. Review a recording, mark source IN/OUT, and add excerpts or drag prepared media onto a video row.
4. Trim, reorder, grade and animate the edit; add standalone music in **Audio**.
5. Choose **Export** and a draft/final preset. Export reads the original recordings, not the proxies.

Read the [user guide](docs/USER_GUIDE.md) for the full workflow and shortcuts.
Filesystem file drops and browser upload pickers are intentionally disabled:
no import flow duplicates your original footage.

### Storage and configuration

The ignored local data directory defaults to `.pascap/`. It stores project/registry
metadata, generated proxies/thumbnails, exports/receipts and scratch—not a backup
of your originals. Keep source recordings at their registered paths; explicit
relinking is a tracked next step. Deleting a project does not delete original
recordings, shared proxies or successful exports.

| Environment variable | Purpose |
| --- | --- |
| `PASCAP_MEDIA_ROOTS` | JSON array of approved absolute footage roots, e.g. `["/home/you/Videos","/mnt/footage"]`; defaults to the service user's Videos folder |
| `PASCAP_DATA_DIR` | Writable persistent data/cache directory, separate from footage |
| `PASCAP_PORT` | Local service port, default `4318` |
| `PASCAP_FFMPEG`, `PASCAP_FFPROBE` | Native executable paths if not on `PATH` |

Missing mounts and symlinks fail explicitly. In the eventual container package,
originals will be read-only bind mounts and application data will be a separate
persistent writable mount. See [deployment design](docs/DEPLOYMENT.md).

**Project format:** strict schema **v5**. Earlier project/receipt snapshots remain
on disk but are incompatible; there are no automatic migrations or default-filled
legacy fields. Unsaved in-memory changes are not guaranteed to survive forced
shutdown. See [workspace and recovery](docs/WORKSPACE_AND_RECOVERY.md).

## Development and CI

```sh
npm run check          # strict types, unit/service tests and production build
npm run test:media     # disposable synthetic FFmpeg integration tests
npm run test:browser   # build, isolated synthetic fixtures and Chrome tests
```

Install the test browser with `npx playwright install --with-deps chrome` when
needed. Tests never need the user's footage; sample preparation and measurement
scripts are opt-in and must not be run against someone else's media without consent.

[GitHub Actions](https://github.com/Plonk42/PasCap/actions) runs checks on Node 22
and 24, plus native-media and browser integration on the checksum-pinned FFmpeg
8.0.1 toolchain. CI is correctness evidence, **not target-GPU or long-render certification**.
The current local baseline is **781 unit/service + 151 browser + 50 native/media
tests**; see [delivery evidence](docs/DELIVERY_STATUS.md) rather than treating a
test count as a performance guarantee. The existing Vite bundle-size warning is
visible and tracked, not suppressed.

[Development guide](docs/DEVELOPMENT.md) · [CI implementation](.github/workflows/ci.yml)

## Roadmap and documentation

Next steps are tracked in [GitHub issues](https://github.com/Plonk42/PasCap/issues)
and [milestones](https://github.com/Plonk42/PasCap/milestones): baseline hardening,
real-workload qualification, and local Docker/Podman packaging. See
[the roadmap](docs/ROADMAP.md) for scope and dependencies.

- [User guide](docs/USER_GUIDE.md)
- [Documentation index](docs/README.md)
- [Timing and colour contract](docs/COLOUR_AND_TIMING.md)
- [Layers and keyframes](docs/LAYERS_AND_KEYFRAMES.md)
- [Speed, audio and export](docs/SPEED_AND_AUDIO.md)
- [Deployment target](docs/DEPLOYMENT.md)
- [Historical feasibility study](docs/FEASIBILITY_REPORT.md)

The original [implementation plan](EDITOR_IMPLEMENTATION_PLAN.md) and feature
inspection worksheets are retained as design history, not a promise to reproduce
CapCut's feature catalogue. No CapCut assets/source or Derusher implementation
is included. Titles, transforms, masks, HDR, optical flow and cloud collaboration
are not part of the current editor.

### Footage service API

The no-copy browsing/registration API is documented in
[deployment and source access](docs/DEPLOYMENT.md#no-copy-source-access-today).
It lists metadata and accepts selected original paths, never video upload bodies.

## License

No project license has been selected yet. Public availability does not grant an
open-source license; licensing is a maintainer decision tracked before release.
Third-party dependencies and native codecs retain their respective licenses.