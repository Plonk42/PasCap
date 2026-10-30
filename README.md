# PasCap

[![CI](https://github.com/Plonk42/PasCap/actions/workflows/ci.yml/badge.svg)](https://github.com/Plonk42/PasCap/actions/workflows/ci.yml)

**A local, single-user video editor for drone flights on Linux.** Review recordings,
keep the ranges worth using, assemble a multi-track edit, grade and animate it, cut it
to analyzed music and export a 720p draft or 4K final with native FFmpeg. An AI
assistant connected through MCP can build a first cut for you to finish. Footage stays
on your machine and is **referenced in place, never uploaded, copied or modified**.

PasCap is pre-release, but its owner edits real projects with it. Projects saved before clip
grades and adjustments replaced track Color cannot be opened and are left unchanged; a later
format change upgrades projects when they open. Synthetic tests in CI target
correctness; intended-GPU playback and a complete long-flight edit are still
qualification work, not performance claims. PasCap runs natively as a local service;
there is no container package, and GitHub Pages and cloud editing are not deployment
targets.

## Highlights

**Recordings**

- Projects with local autosave, conflict recovery and their own media bin; **Save file**
  and **Open project file…** keep and reopen copies.
- A no-copy **Import media** dialog over approved folders, with previews, and verified
  H.264 editing proxies prepared in the background (NVIDIA NVDEC decoding when available).
- Source preview with exact-frame scrubbing and playback, and several **kept ranges**
  per recording that the assistant also respects.
- Camera motion analysis (jolts, movement and DJI flight telemetry) suggests the **best
  steady range**, favoring orbits and reveals.
- Moved originals are **relinked** only after a full-content match; damaged recordings
  can be prepared with their unreadable frames shown black.

**Timeline**

- Up to eight video tracks, each with its own Ripple, transitions (cut, cross-dissolve,
  fade through black, optionally with a black pause) and opening/closing fades.
- Recoverable trims, split, range cuts on the ruler, duplicate, multi-clip selection and
  moves, bookmarks, Undo/Redo and snapping to boundaries, bookmarks and the music's beats.
- Clip speed: constant 0.1×–8× or a source-frame speed curve with presets such as
  Ramp up, and **Reverse**.

**Look**

- **Clip grades** and **adjustments**: each clip has its own Color, which follows it, and an
  adjustment grades every video track over a stretch of the film. Temperature, Tint, Exposure,
  Brightness, Contrast, Highlights, Shadows, Whites, Blacks, Hue, Saturation, Vibrance, an SDR
  **HDR** look and Local contrast, each keyframable on its own; static HSL ranges and color curves.
- **Auto white balance** keyframes a clip's Temperature and Tint from the light around the playhead;
  **Auto adjust** fits eleven Color settings from the second around the playhead, a whole
  clip or each clip of its track, into clip grades as values or a keyframe.
- Track **Transform** (crop, scale, translate, rotate and Opacity) with its own keyframes, and clip
  **Sharpen**, **Clarity** and **Denoise**.
- Hold **Original** to compare with the ungraded image; with Shift or Alt, without only the clip
  grades or only the adjustments.

**Music**

- Up to eight music tracks of up to eight clips each, joined by cuts, crossfades or fades
  through silence, with gain, fades and loops; one linear mix with a single final clamp.
- Analysis of tempo, beats, downbeats, hits, key, sections, swells and silences, drawn on
  each clip over a detailed waveform; **Snap to beats** places cuts on them.

**Export**

- Native H.264 SDR exports from the originals at **1280×720** or **3840×2160**, with AAC
  music, progress, time remaining, cancellation, verification receipts and a disk-space
  check that never risks originals or finished exports.
- Heavy grading is composited on a hardware GPU through headless Chrome when one is
  available, with the CPU compositor as fallback and parity reference.

**Assistant (experimental)**

- An MCP endpoint lets an assistant such as VS Code chat read a project, look at stills and
  contact sheets, follow the music and edit with the editor's own commands. It works in a
  session with a checkpoint, while the editor follows read-only; **Take over** and
  **Restore project before session** keep you in control. It never imports, prepares,
  exports or deletes anything.

## Requirements

- **Linux**, Node.js **22.12+ or 24 LTS** and npm.
- Native **FFmpeg and ffprobe**. The tested development toolchain is **FFmpeg 8.0.1** with `libx264`, FFV1, AAC and the required color/transition filters. Older distribution packages have not been certified; [local deployment](docs/DEPLOYMENT.md#native-toolchain) shows how to build the tested version.
- A current desktop browser with **WebCodecs** (H.264 `VideoDecoder`), **WebGL2** and AudioWorklet. Automated browser tests use Google Chrome.
- Optional: Google Chrome or Chromium and a hardware GPU speed up heavy exports; an NVIDIA GPU with CUDA speeds up proxy preparation.
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
2. Choose **Import** in the Media panel, check video and music recordings in the approved locations and choose **Import** (or double-click one). Browsing alone starts no media work. **Other location** imports a typed file or folder path.
3. Wait for proxy preparation in **Activity**. Review a recording in **Source preview**, mark the ranges to keep (or **Use best** for the suggested steady range) and choose **Add clip**, or drag prepared media onto a video track.
4. Trim, reorder, grade and animate the edit. Once music is imported, **Add music track** in **Audio** (or drag it from Media → Music onto the music lanes); after its analysis, **Snap to beats** in the timeline toolbar places cuts on the music.
5. Choose **Export** and a draft/final preset, review its storage check, then start. Export reads the original recordings, not the proxies.

The [user guide](docs/USER_GUIDE.md) covers the full workflow, keyboard shortcuts and
recovery. The [editor control vocabulary](docs/design/EDITOR_CONTROLS.md#vocabulary)
defines Recording (file), Clip (timeline instance of a recording), Track (video or
music), Clip grade (a clip's own Color), Adjustment (one grade for every video track over a
range of the film), Keyframe (animation value), Range (IN/OUT) and Kept range. A clip's grade
follows it through trims and moves; Transform and Opacity belong to the video track and apply
to every clip on it. Filesystem file drops and browser upload
pickers are intentionally disabled: no import flow duplicates your original footage.

### Edit with an assistant

Connect an MCP client to `http://127.0.0.1:4318/mcp` (or `http://127.0.0.1:5173/mcp`
under `npm run dev`) with the bearer token in `.pascap/mcp-token`; the
[development guide](docs/DEVELOPMENT.md#mcp-endpoint) has a VS Code `mcp.json` entry,
and **Hand off** in the editor header shows the same configuration. In VS Code chat,
`/mcp.pascap.rough_cut` followed by what you want starts the assistant on PasCap's
playbook for a first cut, or describe the brief in **Hand off** and start the session
from there. See the [user guide](docs/USER_GUIDE.md#edit-with-an-assistant-experimental)
and the [assistant design](docs/design/ASSISTANT_MCP.md).

### Storage and configuration

The ignored local data directory defaults to `.pascap/`. It stores project/registry
metadata, generated proxies/thumbnails, exports/receipts and scratch—not a backup
of your originals. Keep source recordings at their registered paths. If one moves, its
Media card shows **Original missing**; **Relink** points it at the moved copy, which
is accepted only if every byte matches, keeping clips, proxy and settings
([relinking](docs/design/SOURCE_RELINK.md)). Deleting a project does not delete original
recordings, shared proxies or successful exports.

| Environment variable              | Purpose                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PASCAP_MEDIA_ROOTS`              | JSON array of approved absolute footage roots, e.g. `["/home/you/Videos","/mnt/footage"]`; defaults to the service user's Videos folder |
| `PASCAP_DATA_DIR`                 | Writable persistent data/cache directory, separate from footage                                                                         |
| `PASCAP_PORT`                     | Local service port, default `4318`                                                                                                      |
| `PASCAP_FFMPEG`, `PASCAP_FFPROBE` | Native executable paths if not on `PATH`                                                                                                |
| `PASCAP_GPU_COMPOSITING`          | `auto` (default) composites heavy export frames on a hardware GPU when one starts; `off` always uses the CPU                            |
| `PASCAP_HW_DECODE`                | `auto` (default) decodes originals with NVDEC for proxy preparation when CUDA is available; `off` always uses the CPU                   |

The browser used for GPU export (`PASCAP_CHROME`) and the assistant's picture sizes,
session lease and checkpoint count (`PASCAP_ASSISTANT_*`) are described in the
[development guide](docs/DEVELOPMENT.md#configuration-and-storage).

Missing mounts and symlinks fail explicitly. See [local deployment](docs/DEPLOYMENT.md)
for storage, permissions, network and toolchain rules.

**Saved data:** projects follow a strict schema. Projects saved before the current schema, with
track Color or British spelling, cannot be opened: PasCap names the reason and leaves them unchanged on disk. A
later format change upgrades a project when it opens, and its first save keeps the original
file beside it. Nothing is default-filled or deleted automatically. The video and
music registries are version 3 (videos) and 2 (music), with full-content checksums; export receipts keep a
snapshot of the exported project. **Projects → Save file** keeps your own copy of a
project; **Open project file…** opens one as a new project. Unsaved in-memory changes
are not guaranteed to survive a forced shutdown. See
[workspace and recovery](docs/WORKSPACE_AND_RECOVERY.md) and the
[data compatibility rules](docs/GITHUB_WORKFLOW.md#data-compatibility).

## Development and CI

```sh
npm run check          # formatting, unit/service tests, strict types, production build and licenses
npm run test:media     # disposable synthetic FFmpeg integration tests
npm run test:browser   # build, isolated synthetic fixtures and Chrome tests
```

Install the test browser with `npx playwright install --with-deps chrome` when
needed. Tests never need the user's footage; sample preparation and measurement
scripts are opt-in and must not be run against someone else's media without consent.

[GitHub Actions](https://github.com/Plonk42/PasCap/actions) runs the checks on Node 22
(and 24 on `main`), the native-media suite on a checksum-pinned FFmpeg 8.0.1 build,
four Chrome browser shards and scoped Firefox music/playback regressions. CI is
correctness evidence, **not target-GPU or long-render certification**. Routine changes
go straight to `main`; risky ones use a short pull request
([GitHub workflow](docs/GITHUB_WORKFLOW.md)). New service capabilities are
[operations](docs/DEVELOPMENT.md#service-operations), served to the editor and, when
meant for it, to the assistant over MCP.

[Development guide](docs/DEVELOPMENT.md) · [CI implementation](.github/workflows/ci.yml)

## Roadmap and documentation

Next steps are tracked in [GitHub issues](https://github.com/Plonk42/PasCap/issues)
and [milestones](https://github.com/Plonk42/PasCap/milestones), including real-workload
qualification, feedback on the assistant and native toolchain setup. See
[the roadmap](docs/ROADMAP.md) and the [documentation index](docs/README.md).

- [User guide](docs/USER_GUIDE.md) and [workspace and recovery](docs/WORKSPACE_AND_RECOVERY.md)
- [Timeline editing and kept ranges](docs/TIMELINE_EDITING.md)
- [Tracks and keyframes](docs/LAYERS_AND_KEYFRAMES.md)
- [Speed, music analysis and audio](docs/SPEED_AND_AUDIO.md) · [multiple music tracks](docs/design/MULTIPLE_MUSIC.md)
- [Timing and color equations](docs/COLOR_AND_TIMING.md) · [clip grades and adjustments](docs/design/ROW_APPEARANCE.md) · [Temperature and Tint](docs/design/TEMPERATURE_AND_TINT.md) · [Auto adjust](docs/design/AUTO_ADJUST.md) · [HSL and curves](docs/design/HSL_AND_CURVES.md)
- [Track Transform](docs/design/SPATIAL_TRANSFORMS.md) · [detail filters, HDR and Local contrast](docs/design/DETAIL_FILTERS.md)
- [WebCodecs preview decoding](docs/design/WEBCODECS_PREVIEW.md) · [source relinking](docs/design/SOURCE_RELINK.md)
- [Assistant rough cut through MCP](docs/design/ASSISTANT_MCP.md)
- [UX and local hardening](docs/UX_HARDENING.md) · [local deployment](docs/DEPLOYMENT.md) · [historical feasibility study](docs/FEASIBILITY_REPORT.md)

The original [implementation plan](EDITOR_IMPLEMENTATION_PLAN.md) and feature
inspection worksheets are retained as design history, not a promise to reproduce
CapCut's feature catalog. No CapCut assets/source or Derusher implementation
is included. Titles, general-purpose masks, optical flow, HDR output or HDR footage
(the track HDR look is an SDR effect), source-video audio and cloud collaboration
are not part of the current editor.

### Footage service API

The no-copy browsing/registration API is documented in
[deployment and source access](docs/DEPLOYMENT.md#no-copy-source-access-today).
It lists metadata and accepts selected original paths, never video upload bodies.
`GET /api/media` and `GET /api/audio` also list `missing` originals, and
`POST /api/media/:id/relink` / `POST /api/audio/:id/relink` (`{ path }`, 202 `{ job }`)
queue a verified relink; `POST /api/relink-folder` (`{ directory }`) relinks every
missing recording found in a folder. Newer capabilities are operations at
`POST /api/ops/<name>`, listed in the
[operation catalog](docs/design/ASSISTANT_MCP.md#operation-catalog).

## License

PasCap's own source and documentation use the [MIT license](LICENSE), explicitly
chosen by the maintainer. Third-party dependencies, native codecs and user media
retain their own terms. Builds include exact production npm notices;
[licensing and distribution](docs/LICENSING.md) documents the inventory and the
separate GPL-enabled FFmpeg/libx264 source/notice and release-review requirements.
This license is not a release or a grant of rights to recordings/music.
