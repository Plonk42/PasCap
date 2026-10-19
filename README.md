# PasCap

[![CI](https://github.com/Plonk42/PasCap/actions/workflows/ci.yml/badge.svg)](https://github.com/Plonk42/PasCap/actions/workflows/ci.yml)

**A local, single-user video editor for Linux.** Review recordings, assemble an edit,
animate colour, speed and track transforms, add music, and export a 720p draft or 4K final using
native FFmpeg. Footage stays on your machine and is **referenced in place, not
uploaded or copied**.

PasCap is in early development. Synthetic tests target correctness; target-GPU playback
and a complete 5–10 minute real-flight edit are still qualification gates, not
performance claims. The eventual package is a **local Docker/Podman application**;
container packaging is not available yet. GitHub Pages and cloud editing are not
deployment targets.

## Highlights

- Separate projects with local autosave, conflict recovery and an initially empty media bin.
- No-copy footage browsing, verified editing proxies, thumbnails and reusable recording ranges.
- Up to eight uniform video tracks, each with Ripple on by default; turn it off for independent placement.
- Recoverable trims, split, duplication, marked-range cutting, snapping, Undo/Redo and source review.
- Independent clip speed, video track-owned Colour/Opacity/Transform, and **shared track-wide keyframes** for Opacity, twelve scalar colour settings (including Temperature, Tint, Vibrance, Whites and Blacks), HDR and Local contrast.
- Clip-only constant speed or precise source-frame speed curves with presets such as Ramp up, a capture diamond, draggable keyframes and exact rate/easing inputs.
- Track-owned crop, uniform scale, translation and rotation, with per-setting project-frame keyframes.
- Draggable timeline keyframes and setting-specific Previous/Next navigation.
- Direct panel/help controls, compact visual animation states and grouped editing tools.
- Track-local cuts, fade-through-black (optionally with a black pause between clips), cross-dissolves and opening/closing fades.
- Up to eight independent music tracks with waveforms, gain, fades and explicit range looping; overlapping sources sum linearly with one final hard clamp.
- Native original-based H.264 SDR exports at **1280×720** or **3840×2160**, with progress, cancellation and verification receipts.
- Export-space preflight, disclosed planning assumptions and safe disk-full recovery.

## Requirements

- **Linux**, Node.js **22.12+ or 24 LTS** and npm.
- Native **FFmpeg and ffprobe**. The tested development toolchain is **FFmpeg 8.0.1** with `libx264`, FFV1, AAC and the required colour/transition filters. Older distribution packages have not been certified.
- A current desktop browser with **WebCodecs** (H.264 `VideoDecoder`), **WebGL2** and AudioWorklet. Automated browser tests use Google Chrome.
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
3. Wait for proxy preparation in **Activity**. Review a recording, mark source IN/OUT, and choose **Add clip** or drag prepared media onto a video track.
4. Trim, reorder, grade and animate the edit; once music is imported, use **Add music track** in **Audio** (or drag it from Media → Music onto the music lane) and **Music track** to place/select independent tracks.
5. Choose **Export** and a draft/final preset, review its storage check, then start. Export reads the original recordings, not the proxies.

Video tracks follow composition order: track 1 is below track 2 in the image, track 3 is above
track 2, and so on. No track has a special editing role. **Track options → Ripple**
packs a track from its first clip's current start in one Undo step when enabled;
while on, later clips remain continuously sequenced, retaining dissolve overlaps.
Turning it off keeps actual placements for independent edits. Music, other tracks
and absolute track keyframes do not move with it.

**Track → Colour** contains the single **Opacity** slider alongside the colour
sliders, initially **100%**. Without Opacity keyframes it edits the selected video track's
`opacity` value, including on an empty track; the track's `opacity` curve overrides
that value on every clip when animated, including both dissolve sources.
Sliders never create keyframes. An animated setting that is not enabled at the real
playhead is read-only until its hollow diamond captures a keyframe there.
Static and keyed Colour have the same video track ownership and grade each source once.
Different colour treatments require different tracks. See [track appearance](docs/design/ROW_APPEARANCE.md). Opacity controls composition coverage,
not the SDR RGB grade, with no additional track multiplier or sidebar duplicate.
**Temperature / Tint** use normalized **−2…2** and **−1…1** values, neutral **0**: positive
Temperature warms, positive Tint adds magenta. They are track-owned, independently
keyable and editable on empty tracks. Nonzero settings intentionally colour greys;
the shared linear-gain formula runs before Exposure, not as Kelvin/HDR output. **Auto white
balance**, under Tint, keyframes both from the light around the playhead. Static HSL/curves add no animation channels. See
[Temperature and Tint](docs/design/TEMPERATURE_AND_TINT.md).
**HDR** (0–1, neutral 0) is a keyable SDR local tone-mapping look applied with the
clip detail filters before grading; see [detail filters](docs/design/DETAIL_FILTERS.md#hdr-look).
**Local contrast** (−1…1, neutral 0) applies the local-detail boost split out of HDR, without its
tone compression; see [local contrast](docs/design/DETAIL_FILTERS.md#local-contrast).
**Clip → Placement** contains placement only.
Track options contains only rename, Ripple, ordering and deletion; visibility
remains a separate sidebar control.

**Track → Transform** edits the selected video track's crop, Scale, Translate X/Y and
Rotation, applied to every clip on the track, including on an empty track. Each
setting's triangle captures a keyframe at the real playhead; animated main values
require that setting's keyframe there. Clip edits never copy or shift Transform;
a clip moved to another track adopts that track's Transform. Cropping does not
refit the image; nonneutral uncovered pixels reveal lower video tracks. Exact neutral
poses retain opaque black letterboxing. See [track Transform](docs/design/SPATIAL_TRANSFORMS.md).

Project duration is the maximum of all retimed video clip ends and every music
track's start + duration. Music can continue beyond video: the final video
closing fade ends at its clip OUT, then the picture is black while music continues
and fades at its own end. Music-only preview is black; export still requires at
least one video clip. Imports never implicitly place music, and music track edits
or removal leave the other music tracks unchanged. There is no normalisation,
ducking, audio effect or source-video audio.

Read the [user guide](docs/USER_GUIDE.md) for the full workflow and shortcuts.
The [editor control vocabulary](docs/design/EDITOR_CONTROLS.md#vocabulary) defines
Recording (file), Clip (video timeline instance), Track (video or music), Keyframe
(animation), and Range (IN/OUT). Static colour curves use control nodes, not keyframes.
Filesystem file drops and browser upload pickers are intentionally disabled:
no import flow duplicates your original footage.

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

Missing mounts and symlinks fail explicitly. In the eventual container package,
originals will be read-only bind mounts and application data will be a separate
persistent writable mount. See [deployment design](docs/DEPLOYMENT.md).

**Project format:** strict current schema, with required complete video track `colour`, including `temperature`, `tint`, `vibrance`, `whites`, `blacks`, `hdr` and `localContrast`, no clip colour/correction/spatial field, a required boolean clip `reverse` (`false` on new clips), video track `transform` base and
0–256 per-setting project-frame keyframes, required `music` array (0–8
music tracks, unique required IDs; `[]` without music), required project `bookmarks` (unique ascending frames; `[]` on new projects), per-track Ripple,
transitions, fades and numeric `VideoLayer.opacity` (0–1; new tracks start at 1),
and exactly fifteen nullable keyframe channels: `opacity`, `temperature`,
`tint`, `exposure`, `brightness`, `contrast`, `hue`, `saturation`, `vibrance`, `highlights`,
`shadows`, `whites`, `blacks`, `hdr`, `localContrast`. HSL/curves remain static. Track `opacity` is required and valid; saved `clip.opacity` and old
`clipOpacity`/`layerOpacity` channels are rejected, not ignored or defaulted.
Projects saved with an older supported schema are upgraded when they open, and their
first save keeps the original file beside them; projects and receipt snapshots from
early development versions remain unchanged on disk but cannot be opened.
Export receipts remain version 1 with a strict current-schema snapshot and required captured
audio-source/instance-plan arrays. Proxy/current PCM cache formats and source
protections do not change; the video and music registries are version 2
(`videos.json`, `music.json`, with full-content checksums), so import recordings again.
There are no null fallbacks, default-filled legacy fields or automatic deletions.
**Projects → Save file** keeps your own copy of a project; **Open project file…**
opens one as a new project.
Unsaved in-memory changes are not guaranteed to survive forced
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
Record dated local results and acceptance evidence on the corresponding
[work issue](https://github.com/Plonk42/PasCap/issues), separately from CI for the
actual delivery commit. Preview/Properties/Diagnostics loading is deferred;
resource limits are documented in the [track contract](docs/LAYERS_AND_KEYFRAMES.md#properties-panel-and-resource-limits).

[Development guide](docs/DEVELOPMENT.md) · [CI implementation](.github/workflows/ci.yml)

## Roadmap and documentation

Next steps are tracked in [GitHub issues](https://github.com/Plonk42/PasCap/issues)
and [milestones](https://github.com/Plonk42/PasCap/milestones): baseline hardening,
real-workload qualification, and local Docker/Podman packaging. See
[the roadmap](docs/ROADMAP.md) for scope and dependencies.

- [User guide](docs/USER_GUIDE.md)
- [Documentation index](docs/README.md)
- [UX and local hardening](docs/UX_HARDENING.md)
- [Timing and colour contract](docs/COLOUR_AND_TIMING.md)
- [Tracks and keyframes](docs/LAYERS_AND_KEYFRAMES.md)
- [Speed, audio and export](docs/SPEED_AND_AUDIO.md)
- [Video track appearance contract](docs/design/ROW_APPEARANCE.md)
- [Temperature and Tint contract](docs/design/TEMPERATURE_AND_TINT.md)
- [Track Transform contract](docs/design/SPATIAL_TRANSFORMS.md)
- [Clip detail filters, HDR and Local contrast contract](docs/design/DETAIL_FILTERS.md)
- [Multiple music contract](docs/design/MULTIPLE_MUSIC.md) — required behaviour; implementation/validation acceptance remains pending, not a test or release claim.
- [Deployment target](docs/DEPLOYMENT.md)
- [Historical feasibility study](docs/FEASIBILITY_REPORT.md)

The original [implementation plan](EDITOR_IMPLEMENTATION_PLAN.md) and feature
inspection worksheets are retained as design history, not a promise to reproduce
CapCut's feature catalogue. No CapCut assets/source or Derusher implementation
is included. Titles, general-purpose masks, HDR, optical flow and cloud collaboration
are not part of the current editor.

### Footage service API

The no-copy browsing/registration API is documented in
[deployment and source access](docs/DEPLOYMENT.md#no-copy-source-access-today).
It lists metadata and accepts selected original paths, never video upload bodies.
`GET /api/media` and `GET /api/audio` also list `missing` originals, and
`POST /api/media/:id/relink` / `POST /api/audio/:id/relink` (`{ path }`, 202 `{ job }`)
queue a verified relink; `POST /api/relink-folder` (`{ directory }`) relinks every
missing recording found in a folder.

## License

PasCap's own source and documentation use the [MIT license](LICENSE), explicitly
chosen by the maintainer. Third-party dependencies, native codecs and user media
retain their own terms. Builds include exact production npm notices;
[licensing and distribution](docs/LICENSING.md) documents the inventory and the
separate GPL-enabled FFmpeg/libx264 source/notice and release-review requirements.
This license is not a container release or a grant of rights to recordings/music.
